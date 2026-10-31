#!/usr/bin/env node
/**
 * 真机交互性能探针：连 CDP 驱动一个真实 Chrome，跑真实交互，把「点了之后多久
 * 才有反应」量出来。
 *
 * 与 ui-verify 的区别：那边断言「算出来的样式对不对」，这边只量时间——首屏、
 * 切换工作区、开抽屉、打字、筛选、轮询。数据落 JSON，方便前后对比。
 *
 * 用法（一般由 scripts/perf/run.sh 调用）：
 *   node scripts/perf/probe.mjs --base http://127.0.0.1:8899 --out /tmp/moo-fleet-perf/out
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const base = argOf('--base', 'http://127.0.0.1:8899');
const outDir = argOf('--out', '/tmp/moo-fleet-perf/out');
const chromePath = argOf('--chrome', process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const label = argOf('--label', 'current');
const idleSeconds = Number.parseInt(argOf('--idle', '20'), 10);
const extraFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean);

fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const debugPort = await freePort();
const profileDir = path.join(outDir, 'chrome-profile');
fs.rmSync(profileDir, { recursive: true, force: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1600,1000',
  '--no-proxy-server',
  ...extraFlags,
  'about:blank',
], { stdio: 'ignore', detached: true });
chrome.unref();

const stopChrome = () => {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ } }
};
process.on('exit', stopChrome);
process.on('SIGINT', () => process.exit(130));

let version = null;
for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
  try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(500); }
}
if (!version) {
  console.error('Chrome 调试端口没起来。受限环境加 MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu"。');
  process.exit(2);
}

const findPage = async () => {
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  return list.find((entry) => entry.type === 'page');
};
let target = await findPage();
if (!target) {
  await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
  target = await findPage();
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
};
ws.onclose = () => {
  for (const [, { reject }] of pending) reject(new Error('CDP 连接断开'));
  pending.clear();
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const ev = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text));
  return result.value;
};

const INSTRUMENT = `
(() => {
  const p = (window.__perf = { longtasks: [], events: [], fcp: 0, lcp: 0, marks: {} });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) p.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const t = e.target;
        p.events.push({
          name: e.name,
          start: Math.round(e.startTime),
          proc: Math.round(e.processingStart),
          dur: Math.round(e.duration),
          target: (t && (typeof t.className === 'string' ? t.className : t.tagName)) || '',
        });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') p.fcp = Math.round(e.startTime);
    }).observe({ type: 'paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) p.lcp = Math.round(e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
})();
`;

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Performance.enable');
await send('Profiler.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

const metrics = async () => {
  const { metrics: list } = await send('Performance.getMetrics');
  const out = {};
  for (const item of list) out[item.name] = item.value;
  return out;
};

const METRIC_KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes', 'Documents'];
const delta = (before, after) => {
  const out = {};
  for (const key of METRIC_KEYS) {
    const value = (after[key] ?? 0) - (before[key] ?? 0);
    out[key] = key.includes('Duration') ? +(value * 1000).toFixed(1) : value;
  }
  return out;
};

const settle = () => ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))))');

const waitFor = async (expression, timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await ev(expression)) return Date.now() - started;
    await sleep(80);
  }
  return null;
};

const pointOf = async (selector, index = 0) => {
  const raw = await ev(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  return raw ? JSON.parse(raw) : null;
};

const mouseClick = async (selector, index = 0) => {
  const point = await pointOf(selector, index);
  if (!point) throw new Error(`找不到可点击的 ${selector}[${index}]`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
};

const clickText = async (text, selector = 'button, a, label') => {
  const index = await ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].findIndex((n) => n.textContent.trim().includes(${JSON.stringify(text)}))`);
  if (index < 0) throw new Error(`找不到含「${text}」的 ${selector}`);
  await mouseClick(selector, index);
};

const parkPointer = () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, button: 'none' });

const results = [];
const record = (entry) => {
  results.push(entry);
  const shown = entry.latency === null || entry.latency === undefined ? entry.wall : entry.latency;
  const parts = [`${entry.name.padEnd(22)} ${String(Math.round(shown)).padStart(6)}ms`];
  if (entry.delta) parts.push(`脚本 ${Math.round(entry.delta.ScriptDuration)}ms · 样式 ${Math.round(entry.delta.RecalcStyleDuration)}ms · 布局 ${Math.round(entry.delta.LayoutDuration)}ms`);
  if (entry.longTasks?.count) parts.push(`长任务 ${entry.longTasks.count} 个 / 最长 ${entry.longTasks.max}ms`);
  if (entry.note) parts.push(entry.note);
  console.log(parts.join(' · '));
};

/**
 * 在页面里用 rAF 轮询目标条件，返回「从开始等到条件成立」的毫秒数。
 *
 * 为什么不在 Node 侧轮询：CDP 一来一回本身就要几毫秒，轮询间隔又只能取 80ms 这种
 * 粗粒度，测出来的「50ms」其实是测量地板。放到页面里按帧等，分辨率就是一帧。
 */
const raceTo = (condition, timeout) => ev(`new Promise((resolve) => {
  const t0 = performance.now();
  const limit = t0 + ${timeout};
  const tick = () => {
    let ok = false;
    try { ok = ${condition}; } catch { ok = false; }
    if (ok) return resolve(Math.round(performance.now() - t0));
    if (performance.now() > limit) return resolve(-1);
    requestAnimationFrame(tick);
  };
  tick();
})`);

/** 量一段交互：墙钟、主线程各项耗时、期间的长任务与 event timing。 */
async function measure(name, action, { done, timeout = 8000, note = '' } = {}) {
  await settle();
  const before = await metrics();
  const pageStart = await ev('performance.now()');
  const started = Date.now();
  // 计时器先起、再派发点击：起点只比真实派发早一次 CDP 往返（约 1ms）
  const waiting = done ? raceTo(done, timeout) : null;
  await action();
  const latency = waiting ? await waiting : null;
  await settle();
  const wall = Date.now() - started;
  const after = await metrics();
  const pageEnd = await ev('performance.now()');
  const perf = await ev(`(() => {
    const p = window.__perf;
    const longtasks = p.longtasks.filter((e) => e.start + e.dur >= ${pageStart} && e.start <= ${pageEnd});
    const events = p.events.filter((e) => e.start >= ${pageStart} && e.start <= ${pageEnd});
    return JSON.stringify({ longtasks, events });
  })()`);
  const { longtasks, events } = JSON.parse(perf);
  const entry = {
    name,
    // latency 是「从点击到目标出现的第一个绘制帧」，-1 表示超时没等到
    latency,
    wall,
    reached: latency === null ? null : latency >= 0,
    delta: delta(before, after),
    longTasks: {
      count: longtasks.length,
      max: longtasks.reduce((max, item) => Math.max(max, item.dur), 0),
      total: longtasks.reduce((sum, item) => sum + item.dur, 0),
    },
    events: events.slice(0, 12),
    note: latency === -1 && done ? '目标未出现' : note,
  };
  record(entry);
  return entry;
}

const collectPageTimings = async () => {
  const raw = await ev(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/api/'))
      .map((entry) => ({ url: entry.name.replace(location.origin, ''), start: Math.round(entry.startTime), dur: Math.round(entry.duration), transfer: entry.transferSize }));
    const scripts = performance.getEntriesByType('resource')
      .filter((entry) => /\\.js$/.test(entry.name))
      .map((entry) => ({ url: entry.name.split('/').pop(), transfer: entry.transferSize, dur: Math.round(entry.duration), start: Math.round(entry.startTime) }));
    const p = window.__perf;
    return JSON.stringify({
      nav: nav ? { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), ttfb: Math.round(nav.responseStart) } : null,
      fcp: p.fcp, lcp: p.lcp,
      resources, scripts,
      longTasks: p.longtasks,
      heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
      nodes: document.getElementsByTagName('*').length,
    });
  })()`);
  return JSON.parse(raw);
};

console.log(`Chrome ${version.Browser} · ${base} · label=${label}`);

// ── 1. 冷启动 ──────────────────────────────────────────────────────────────
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCache');
await ev('window.__perf && (window.__perf.longtasks = [], window.__perf.events = [])');
const coldStart = Date.now();
await send('Page.navigate', { url: base });
await waitFor("document.readyState === 'complete' && document.querySelectorAll('.repo-table tbody tr').length > 0", 20000);
await settle();
const coldWall = Date.now() - coldStart;
await sleep(800);
const cold = await collectPageTimings();
cold.wall = coldWall;
console.log(`\n== 冷启动 ==\n墙钟 ${coldWall}ms · TTFB ${cold.nav?.ttfb}ms · FCP ${cold.fcp}ms · LCP ${cold.lcp}ms · DCL ${cold.nav?.dcl}ms · load ${cold.nav?.load}ms`);
console.log(`主线程长任务 ${cold.longTasks.length} 个 / 最长 ${cold.longTasks.reduce((m, t) => Math.max(m, t.dur), 0)}ms / 合计 ${cold.longTasks.reduce((s, t) => s + t.dur, 0)}ms · DOM ${cold.nodes} 节点 · 堆 ${(cold.heap / 1048576).toFixed(1)}MB`);
console.log(`首屏 API ${cold.resources.length} 个：`);
for (const item of [...cold.resources].sort((a, b) => b.dur - a.dur).slice(0, 8)) {
  console.log(`  ${String(item.dur).padStart(5)}ms  ${item.url}`);
}

// ── 2. 暖启动 ──────────────────────────────────────────────────────────────
await send('Network.setCacheDisabled', { cacheDisabled: false });
await ev('window.__perf.longtasks = []; window.__perf.events = []');
const warmStart = Date.now();
await send('Page.reload');
await waitFor("document.readyState === 'complete' && document.querySelectorAll('.repo-table tbody tr').length > 0", 20000);
await settle();
await sleep(500);
const warm = await collectPageTimings();
warm.wall = Date.now() - warmStart;
console.log(`\n== 暖启动（缓存命中）==\n墙钟 ${warm.wall}ms · FCP ${warm.fcp}ms · LCP ${warm.lcp}ms · DCL ${warm.nav?.dcl}ms`);
console.log(`主线程长任务 ${warm.longTasks.length} 个 / 最长 ${warm.longTasks.reduce((m, t) => Math.max(m, t.dur), 0)}ms`);

// ── 3. 空转（15 秒轮询的成本）───────────────────────────────────────────────
await ev('window.__perf.longtasks = []; window.__perf.events = []');
const idleBefore = await metrics();
const idlePageStart = await ev('performance.now()');
await sleep(idleSeconds * 1000);
const idleAfter = await metrics();
const idlePageEnd = await ev('performance.now()');
const idleTasks = JSON.parse(await ev(`JSON.stringify(window.__perf.longtasks.filter((e) => e.start + e.dur >= ${idlePageStart}))`));
const idleApi = JSON.parse(await ev(`JSON.stringify(performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/') && e.startTime >= ${idlePageStart}).map((e) => ({ url: e.name.replace(location.origin, ''), dur: Math.round(e.duration) })))`));
const idleDelta = delta(idleBefore, idleAfter);
console.log(`\n== 空转 ${idleSeconds}s（后台轮询）==\n脚本 ${Math.round(idleDelta.ScriptDuration)}ms · 样式 ${Math.round(idleDelta.RecalcStyleDuration)}ms · 布局 ${Math.round(idleDelta.LayoutDuration)}ms · 重算样式 ${idleDelta.RecalcStyleCount} 次 · 长任务 ${idleTasks.length} 个 · API ${idleApi.length} 次`);
for (const item of idleApi) console.log(`  ${String(item.dur).padStart(5)}ms  ${item.url}`);

// ── 4. 交互 ────────────────────────────────────────────────────────────────
console.log('\n== 交互 ==');
const rows = await ev("document.querySelectorAll('.repo-table tbody tr').length");
console.log(`仓库行 ${rows} 行`);

await measure('切换工作区 → AI 会话', () => mouseClick('.workspace-switcher button', 1), {
  done: "!!document.querySelector('#session-list, .session-row, .sessions-workspace')",
});
await measure('切换工作区 → 数据分析', () => mouseClick('.workspace-switcher button', 2), {
  done: "!!document.querySelector('.analytics-workspace')",
  note: '含热力图请求',
});
await measure('切换工作区 → 仓库', () => mouseClick('.workspace-switcher button', 0), {
  done: "!!document.querySelector('.repo-table')",
});

/**
 * 「关掉」的判据取**开始响应**那一帧，不是元素从 DOM 消失那一帧。
 * 过渡名不统一（`fade` / `drawer` / `confirm`），带类名的也不一定是元素自己（设置弹窗的
 * 淡出类挂在外层遮罩上），所以认「自己或祖先上出现 `-leave-active`」这个共同点。
 * Vue 要等过渡结束才移除元素（160ms），
 * 拿「消失」当判据测出来的 210ms 其实是动画时长，会被误读成交互卡顿。
 * 首帧响应 = 应用真正开始反应的延迟；淡出多久是另一件事。
 */
const closingDown = (selector) =>
  `(() => { const el = document.querySelector('${selector}'); return !el || !!el.closest('[class*="-leave-active"]'); })()`;

await measure('打开仓库抽屉', () => mouseClick('.repo-table tbody tr', 0), {
  done: "!!document.querySelector('.drawer-backdrop') && !document.querySelector('.drawer-backdrop [aria-busy=\"true\"]')",
  note: '含文件/分支/标签/备份四个清单',
});
await sleep(600);
await measure('关闭抽屉（Esc）', async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}, { done: closingDown('.drawer-backdrop'), note: '另有 160ms 淡出动画' });
// 判据只看「开始响应」，遮罩还要淡出 160ms 才从 DOM 移除；不等它，
// 下一次点击会落在正在消失的遮罩上，测出来的是「点了没反应」。
await sleep(260);

// 搜索：逐字符输入，看每次按键到下一次绘制的间隔
const searchPoint = await pointOf('.search-field input');
if (searchPoint) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: searchPoint.x, y: searchPoint.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: searchPoint.x, y: searchPoint.y, button: 'left', clickCount: 1 });
  const perChar = [];
  for (const char of 'perf-repo') {
    const started = Date.now();
    await send('Input.insertText', { text: char });
    await settle();
    perChar.push(Date.now() - started);
  }
  const sorted = [...perChar].sort((a, b) => a - b);
  record({
    name: '搜索逐字符输入 9 次',
    wall: perChar.reduce((sum, value) => sum + value, 0),
    delta: null,
    longTasks: { count: 0, max: 0, total: 0 },
    note: `每次 ${perChar.join('/')}ms · 中位 ${sorted[Math.floor(sorted.length / 2)]}ms`,
  });
  await ev(`(() => { const input = document.querySelector('.search-field input'); if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await settle();
}

const rowsBeforeFilter = await ev("document.querySelectorAll('.repo-table tbody tr').length");
await measure('筛选：只看有改动', () => clickText('待处理', '.summary-block'), {
  done: `document.querySelectorAll('.repo-table tbody tr').length !== ${rowsBeforeFilter}`,
});
await sleep(200);
await measure('筛选：恢复全部', () => mouseClick('.summary-block', 0), {
  done: `document.querySelectorAll('.repo-table tbody tr').length === ${rowsBeforeFilter}`,
});

await measure('打开操作记录抽屉', () => mouseClick('.topbar-history'), {
  done: "!!document.querySelector('.drawer-backdrop')",
});
await measure('关闭操作记录（Esc）', async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}, { done: closingDown('.drawer-backdrop'), note: '另有 160ms 淡出动画' });
// 判据只看「开始响应」，遮罩还要淡出 160ms 才从 DOM 移除；不等它，
// 下一次点击会落在正在消失的遮罩上，测出来的是「点了没反应」。
await sleep(260);

await measure('打开设置弹窗', () => mouseClick('.profile-chip'), {
  done: "!!document.querySelector('.manage-modal')",
});
for (let index = 0; index < 6; index += 1) {
  const exists = await ev(`document.querySelectorAll('.manage-nav-item')[${index}]?.textContent.trim() ?? ''`);
  if (!exists) break;
  const current = await ev(`document.querySelectorAll('.manage-nav-item')[${index}]?.getAttribute('aria-current') === 'page'`);
  if (current) continue;
  await measure(`设置分区 → ${exists.replace(/\d+$/, '')}`, () => mouseClick('.manage-nav-item', index), {
    done: `document.querySelectorAll('.manage-nav-item')[${index}]?.getAttribute('aria-current') === 'page'`,
  });
}
await measure('关闭设置弹窗（Esc）', async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}, { done: closingDown('.manage-modal'), note: '另有 160ms 淡出动画' });
await sleep(260);

// 刷新按钮点下去会先灰再恢复，只看 aria-busy 会在点击前的第一帧就成立。
// 用「/api/dashboard 请求数增加」当判据，测到的才是这次全量扫描的往返。
const dashboardCalls = await ev("performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/dashboard')).length");
await measure('手动刷新全部仓库', () => mouseClick('.topbar-refresh'), {
  done: `performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/dashboard')).length > ${dashboardCalls} && document.querySelector('.topbar-refresh')?.getAttribute('aria-busy') === 'false'`,
  timeout: 20000,
  note: '一次全量扫描',
});
await sleep(1200);

await measure('滚动仓库列表到底部', () => ev(`(() => { const el = document.querySelector('.table-wrap') || document.scrollingElement; el.scrollTop = el.scrollHeight; })()`), {
  note: '',
});
await measure('滚动回顶部', () => ev(`(() => { const el = document.querySelector('.table-wrap') || document.scrollingElement; el.scrollTop = 0; })()`));

// ── 5. CPU profile：连续切换工作区 ──────────────────────────────────────────
await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
for (let round = 0; round < 3; round += 1) {
  await mouseClick('.workspace-switcher button', 2);
  await waitFor("!!document.querySelector('.analytics-workspace')", 5000);
  await mouseClick('.workspace-switcher button', 0);
  await waitFor("!!document.querySelector('.repo-table')", 5000);
}
const { profile } = await send('Profiler.stop');
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const selfTime = new Map();
let totalMicros = 0;
profile.samples.forEach((id, index) => {
  const micros = profile.timeDeltas[index] ?? 0;
  totalMicros += micros;
  const node = byId.get(id);
  if (!node) return;
  const frame = node.callFrame;
  const file = frame.url ? frame.url.split('/').pop() : '(native)';
  const key = `${frame.functionName || '(anonymous)'} · ${file}:${frame.lineNumber + 1}`;
  selfTime.set(key, (selfTime.get(key) ?? 0) + micros);
});
const hot = [...selfTime.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 18)
  .map(([fn, micros]) => ({ fn, ms: +(micros / 1000).toFixed(1), pct: +((micros / totalMicros) * 100).toFixed(1) }));
console.log('\n== 连续切换工作区 3 轮 · 主线程热点 ==');
for (const item of hot) console.log(`  ${String(item.ms).padStart(7)}ms ${String(item.pct).padStart(5)}%  ${item.fn}`);

// ── 6. 后端直测（不经浏览器）─────────────────────────────────────────────────
const session = await (await fetch(`${base}/api/session`)).json();
const apiTimings = [];
for (const route of ['/api/dashboard', '/api/dashboard', '/api/operations', '/api/profile']) {
  const started = Date.now();
  const response = await fetch(`${base}${route}`, { headers: { 'x-git-fleet-token': session.token } });
  const body = await response.text();
  let scanMs = null;
  try {
    const parsed = JSON.parse(body);
    scanMs = parsed?.scan?.durationMs ?? null;
  } catch { /* 非 JSON 不看 */ }
  apiTimings.push({ route, ms: Date.now() - started, bytes: body.length, scanMs });
}
console.log('\n== 后端直测 ==');
for (const item of apiTimings) {
  console.log(`  ${String(item.ms).padStart(5)}ms  ${item.route}  ${(item.bytes / 1024).toFixed(0)}KB${item.scanMs !== null ? `  (扫描 ${item.scanMs}ms)` : ''}`);
}

const report = { label, base, chrome: version.Browser, rows, cold, warm, idle: { seconds: idleSeconds, delta: idleDelta, tasks: idleTasks, api: idleApi }, interactions: results, hot, apiTimings };
fs.writeFileSync(path.join(outDir, `perf-${label}.json`), JSON.stringify(report, null, 2));
console.log(`\n报告：${path.join(outDir, `perf-${label}.json`)}`);
stopChrome();
process.exit(0);
