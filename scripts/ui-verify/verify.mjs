#!/usr/bin/env node
/**
 * 真机 UI 断言：起一个 headless Chrome，连 CDP，对正在运行的应用做真实交互，
 * 再把关键的计算样式、几何尺寸、aria 状态逐项断言出来。
 *
 * 为什么不用 jsdom / 单测：单测证明不了「CSS 到底算成什么样」。这轮改的都是
 * 视觉层，能出错的恰恰是层叠覆盖、grid 里 replaced element 的宽度、:hover 的
 * 命中、以及某套主题下边框消失这类只有在真实排版里才暴露的问题。
 *
 * 用法（一般通过 scripts/ui-verify/verify.sh 调用，它负责造夹具和起实例）：
 *   node scripts/ui-verify/verify.mjs --base http://127.0.0.1:8787
 *
 * 参数：
 *   --base <url>      被测应用地址（默认 http://127.0.0.1:8787）
 *   --shots <dir>     截图与 result.json 输出目录（默认系统临时目录）
 *   --chrome <path>   Chrome 可执行文件（也可用环境变量 CHROME）
 *   --keep-chrome     结束后不关闭 Chrome，方便手工接着看
 *
 * 环境变量：
 *   MOO_FLEET_UI_CHROME_FLAGS  追加给 Chrome 的参数，受限环境需要
 *                              "--no-sandbox --disable-gpu"
 *
 * 退出码：全部通过为 0，有任何一项失败为 1。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const baseUrl = argOf('--base', process.env.MOO_FLEET_UI_BASE ?? 'http://127.0.0.1:8787');
const shotsDir = argOf('--shots', path.join(os.tmpdir(), 'moo-fleet-ui-verify'));
const chromePath = argOf('--chrome', process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const keepChrome = argv.includes('--keep-chrome');
const extraFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean);

if (!fs.existsSync(chromePath)) {
  console.error(`找不到 Chrome：${chromePath}\n用 CHROME=/path/to/chrome 或 --chrome 指定。`);
  process.exit(2);
}
fs.mkdirSync(shotsDir, { recursive: true });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const debugPort = await freePort();
const profileDir = path.join(shotsDir, 'chrome-profile');
fs.rmSync(profileDir, { recursive: true, force: true });

// detached 是为了收尾时能整组杀：Chrome 会派生出 GPU / renderer 等子进程，
// 只杀父进程常留下一堆 helper 常驻。
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    ...extraFlags,
    'about:blank',
  ],
  { stdio: 'ignore', detached: true },
);
chrome.unref();

const stopChrome = () => {
  try {
    process.kill(-chrome.pid, 'SIGKILL');
  } catch {
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
};
process.on('exit', () => {
  if (!keepChrome) stopChrome();
});
process.on('SIGINT', () => process.exit(130));

let version = null;
for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
  try {
    version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  } catch {
    await sleep(500);
  }
}
if (!version) {
  console.error('Chrome 调试端口没起来。受限环境可加 MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu"。');
  process.exit(2);
}
console.log(`Chrome: ${version['Browser']} · debug port ${debugPort}`);

const findPage = async () => {
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  return list.find((entry) => entry.type === 'page');
};
let target = await findPage();
if (!target) {
  await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
  target = await findPage();
}
if (!target) {
  console.error('没有可用的 page target');
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const consoleErrors = [];
const pageExceptions = [];

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageExceptions.push(String(details?.exception?.description ?? details?.text).slice(0, 300));
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const ev = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text));
  return result.value;
};

const setViewport = (width, height = 950) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });

const shot = async (file) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotsDir, file), Buffer.from(data, 'base64'));
};

const clickText = (text) =>
  ev(`(() => {
  const el = [...document.querySelectorAll("button, a, label")].find((n) => n.textContent.trim().includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`);

// macOS 上 CDP 键盘事件必须带 nativeVirtualKeyCode，否则页面收不到（Escape 就关不掉弹窗）。
const pressKey = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const pressEsc = () => pressKey('Escape', 'Escape', 27);

// 点导航项后轮询 aria-current，不要靠固定 sleep 猜 Vue 什么时候渲染完。
const clickNavByText = async (text) => {
  const index = await ev(`[...document.querySelectorAll('.manage-nav-item')].findIndex((b) => b.textContent.trim().includes(${JSON.stringify(text)}))`);
  if (index < 0) return false;
  const point = await ev(`(() => {
    const el = document.querySelectorAll('.manage-nav-item')[${index}];
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  const { x, y } = JSON.parse(point);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const current = await ev(`document.querySelector('.manage-nav-item[aria-current="page"]')?.textContent.trim() ?? ''`);
    if (current.includes(text)) return true;
    await sleep(150);
  }
  return false;
};

const hover = async (selector) => {
  const point = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  if (!point) throw new Error(`hover 找不到 ${selector}`);
  const { x, y } = JSON.parse(point);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(320);
};

// 指针停在行上，下一段断言「常态」就会测到 hover 态。断言前先把它移开。
const parkPointer = () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, button: 'none' });

const results = [];
const record = (group, items) => {
  for (const item of items) results.push({ group, ...item });
};

const runGroup = async (group, script) => {
  const raw = await ev(`(() => { const out = []; const add = (n, ok, d = '') => out.push({ n, ok: !!ok, d: String(d) });
${script}
return JSON.stringify(out); })()`);
  record(group, JSON.parse(raw));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

console.log('== 阶段 1：工作台 ==');
await setViewport(1440, 950);
await send('Page.navigate', { url: baseUrl });
await sleep(3200);
await shot('01-workbench.png');

await runGroup(
  '工作台',
  `
  const zero = [...document.querySelectorAll('.summary-block strong')];
  add('摘要块 5 个', zero.length === 5, zero.length);
  add('零值标了 data-zero', zero.filter((n) => n.dataset.zero !== undefined).length >= 1, zero.map((n) => n.textContent + ':' + n.dataset.zero).join(','));
  const zeroEls = zero.filter((n) => n.dataset.zero === 'true');
  const zeroColors = new Set(zeroEls.map((n) => getComputedStyle(n).color));
  add('零值数字收敛到同一档灰', zeroEls.length === 0 || zeroColors.size === 1, zeroEls.map((n) => n.textContent + '=' + getComputedStyle(n).color).join(','));
  const nonzero = zero.filter((n) => n.dataset.zero === 'false');
  const distinct = nonzero.filter((n) => !zeroColors.has(getComputedStyle(n).color));
  add('非零数字有语义色（区别于零值灰）', nonzero.length === 0 || distinct.length === nonzero.length, nonzero.map((n) => n.textContent + '=' + getComputedStyle(n).color).join(' | '));
  const thead = document.querySelector('.repo-table thead');
  add('表头无投影', thead && getComputedStyle(thead).boxShadow === 'none', thead ? getComputedStyle(thead).boxShadow : 'no thead');
  const pill = document.querySelector('.status-pill');
  if (pill) {
    const bg = getComputedStyle(pill).backgroundColor;
    add('状态胶囊有淡底', bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', bg);
    add('状态胶囊圆角 radius-sm', parseFloat(getComputedStyle(pill).borderRadius) >= 4, getComputedStyle(pill).borderRadius);
  } else add('状态胶囊存在', false, '页面无 .status-pill');
  const tags = [...document.querySelectorAll('.repo-subline > span')];
  if (tags.length) {
    const solid = tags.filter((t) => { const bg = getComputedStyle(t).backgroundColor; return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'; });
    add('分组标签为淡填充', solid.length === tags.length, solid.length + '/' + tags.length + ' bg=' + getComputedStyle(tags[0]).backgroundColor);
  } else add('分组标签存在', false, '无分组标签元素');
  const rows = document.querySelectorAll('.repo-table tbody tr');
  add('表格 6 行', rows.length === 6, rows.length);
  add('页面无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
`,
);

if (await ev(`!!document.querySelector('.repo-table tbody tr')`)) {
  await parkPointer();
  const before = await ev(`getComputedStyle(document.querySelector('.repo-table tbody tr')).backgroundColor`);
  await hover('.repo-table tbody tr');
  const after = await ev(`getComputedStyle(document.querySelector('.repo-table tbody tr')).backgroundColor`);
  record('工作台', [{ n: '行悬停背景变化', ok: before !== after, d: `${before} -> ${after}` }]);
  await shot('02-workbench-hover.png');
}

console.log('== 阶段 2：设置弹窗 ==');
await ev(`(() => { const chip = document.querySelector('.profile-chip'); if (chip) chip.click(); return !!chip; })()`);
await sleep(1500);
await shot('03-settings-profile.png');

await runGroup(
  '设置-头部与导航',
  `
  const modal = document.querySelector('.setup-modal.manage-modal');
  add('设置弹窗打开', !!modal, modal ? 'yes' : 'no');
  const kicker = document.querySelector('.manage-header-kicker');
  add('SETTINGS kicker', kicker && kicker.textContent.trim() === 'SETTINGS', kicker ? kicker.textContent : 'missing');
  const sub = document.querySelector('.manage-header-sub');
  add('副标题含 config/', sub && sub.textContent.includes('config/'), sub ? sub.textContent.trim().slice(0, 60) : 'missing');
  const label = document.querySelector('.manage-nav-label');
  add('左栏分区小标题', label && label.textContent.trim() === '分区', label ? label.textContent : 'missing');
  const foot = document.querySelector('.manage-nav-foot');
  add('左栏版本落款', foot && /v\\d+\\.\\d+\\.\\d+/.test(foot.textContent), foot ? foot.textContent.trim() : 'missing');
  const icons = document.querySelectorAll('.manage-nav-icon');
  add('导航图标槽 5 个', icons.length === 5, icons.length);
  const cur = document.querySelector('.manage-nav-item[aria-current="page"]');
  add('当前分区有 aria-current', !!cur, cur ? cur.textContent.trim() : 'none');
  const close = document.querySelector('.manage-close');
  add('关闭键是 32px 方钮', close && Math.round(close.getBoundingClientRect().width) === 32, close ? Math.round(close.getBoundingClientRect().width) : 'missing');
  add('弹窗不超出视口', modal.getBoundingClientRect().bottom <= window.innerHeight + 1 && modal.getBoundingClientRect().right <= window.innerWidth + 1, JSON.stringify(modal.getBoundingClientRect().toJSON()));
`,
);

await runGroup(
  '设置-个人信息',
  `
  const panels = document.querySelectorAll('.manage-section .manage-panel');
  add('个人信息 2 张面板卡', panels.length === 2, panels.length);
  const fields = document.querySelectorAll('.manage-section .form-field');
  add('3 个字段', fields.length === 3, fields.length);
  const input = document.querySelector('.manage-section input[data-dialog-initial], .manage-section .form-field input');
  add('显示名称输入框存在', !!input, input ? input.value : 'none');
  const labels = [...document.querySelectorAll('.manage-section .form-field > span')];
  add('字段标签字重 500', labels.every((l) => getComputedStyle(l).fontWeight === '500'), labels.map((l) => getComputedStyle(l).fontWeight).join(','));
  add('字段标签字号 caption 档', labels.length > 0 && parseFloat(getComputedStyle(labels[0]).fontSize) <= 13.5, labels.length ? getComputedStyle(labels[0]).fontSize : '-');
`,
);

for (const [text, file] of [
  ['界面显示', '04-settings-appearance.png'],
  ['AI 服务', '05-settings-ai.png'],
  ['远端', '06-settings-remote.png'],
  ['仓库接入', '07-settings-repositories.png'],
]) {
  const ok = await clickNavByText(text);
  await sleep(400);
  await shot(file);
  const info = await ev(`(() => {
    const cur = document.querySelector('.manage-nav-item[aria-current="page"]');
    const panels = document.querySelectorAll('.manage-section .manage-panel');
    const warn = document.body.scrollWidth > document.body.clientWidth + 1;
    return JSON.stringify({ cur: cur ? cur.textContent.trim() : null, panels: panels.length, warn });
  })()`);
  record('设置-分区切换', [{ n: `切到「${text}」`, ok: ok && JSON.parse(info).cur && JSON.parse(info).cur.includes(text), d: info }]);
}

await clickNavByText('界面显示');
await sleep(600);
await shot('08-settings-appearance.png');

await runGroup(
  '设置-界面显示',
  `
  const themes = [...document.querySelectorAll('.theme-option')];
  add('主题条目 5 个', themes.length === 5, themes.length);
  const sw = document.querySelector('.theme-swatch');
  const r = sw.getBoundingClientRect();
  add('色板 58x26', Math.round(r.width) === 58 && Math.round(r.height) === 26, Math.round(r.width) + 'x' + Math.round(r.height));
  const radio = document.querySelector('.theme-option input');
  add('radio 自绘 appearance none', getComputedStyle(radio).appearance === 'none', getComputedStyle(radio).appearance);
  const checked = document.querySelector('.theme-option:has(input:checked)') || document.querySelector('.theme-option input:checked')?.closest('.theme-option');
  add('选中态边框非默认', checked && getComputedStyle(checked).borderColor !== 'rgba(0, 0, 0, 0)', checked ? getComputedStyle(checked).borderColor : 'none');
  const pairs = document.querySelectorAll('.manage-field-pair .form-field');
  add('字体字号 4 个字段', pairs.length === 4, pairs.length);
  const sample = document.querySelector('.appearance-sample');
  add('预览块存在', !!sample, sample ? sample.textContent.trim().slice(0, 20) : 'missing');
  add('预览块 span 独立成行', sample && getComputedStyle(sample.querySelector('span')).display === 'block', sample ? getComputedStyle(sample.querySelector('span')).display : '-');
  const panelTops = [...document.querySelectorAll('.manage-section .manage-panel')].map((p) => p.getBoundingClientRect().top);
  add('两张面板不重叠', panelTops.every((t, i) => i === 0 || t > panelTops[i - 1]), panelTops.map(Math.round).join(','));
`,
);

// 主题切换：切走再切回，顺便把配置还原，避免污染下一次运行。
const themeBefore = await ev(`document.documentElement.dataset.theme || 'fleet-blue'`);
await ev(`(() => { const radios = [...document.querySelectorAll('.theme-option input')]; const t = radios.find((r) => r.value !== document.documentElement.dataset.theme); if (!t) return null; t.click(); return t.value; })()`);
await sleep(900);
const themeAfter = await ev(`document.documentElement.dataset.theme`);
await shot('09-settings-theme-switched.png');
record('设置-主题切换', [{ n: '点击切换主题即时生效', ok: themeBefore !== themeAfter, d: `${themeBefore} -> ${themeAfter}` }]);
await ev(`(() => { const r = [...document.querySelectorAll('.theme-option input')].find((x) => x.value === ${JSON.stringify(themeBefore)}); if (r) r.click(); return !!r; })()`);
await sleep(700);
const themeBack = await ev(`document.documentElement.dataset.theme`);
record('设置-主题切换', [{ n: '切回原主题', ok: themeBack === themeBefore, d: `${themeBack}` }]);

await clickNavByText('AI 服务');
await sleep(600);
await runGroup(
  '设置-AI',
  `
  const wrap = document.querySelector('.secret-input-control');
  const input = wrap && wrap.querySelector('input');
  add('密钥框宽度 > 400', input && input.getBoundingClientRect().width > 400, input ? Math.round(input.getBoundingClientRect().width) : 'missing');
  // 对齐按实测各段相加，不能写死按钮宽：按钮是网格项，实际宽度未必等于声明值。
  const sum = input ? Math.round(input.getBoundingClientRect().width + [...wrap.querySelectorAll('button')].reduce((a, b) => a + b.getBoundingClientRect().width, 0) + 2 * parseFloat(getComputedStyle(wrap).columnGap)) : 0;
  add('密钥框填满容器无溢出', wrap && Math.abs(sum - wrap.getBoundingClientRect().width) < 2 && wrap.scrollWidth <= wrap.clientWidth + 1, sum + ' vs ' + Math.round(wrap.getBoundingClientRect().width) + ' scroll ' + (wrap ? wrap.scrollWidth : '-'));
  const status = document.querySelector('.manage-state-pill');
  add('Key 状态徽标存在', !!status, status ? status.textContent.trim() + '/' + status.dataset.state : 'missing');
  const hint = document.querySelector('.manage-hint');
  add('面板外说明行', !!hint, hint ? hint.textContent.trim().slice(0, 30) : 'missing');
`,
);

await pressEsc();
let modalClosed = false;
for (let attempt = 0; attempt < 15; attempt += 1) {
  if (!(await ev(`!!document.querySelector('.setup-modal.manage-modal')`))) {
    modalClosed = true;
    break;
  }
  await sleep(150);
}
record('设置-键盘', [{ n: 'Esc 关闭弹窗', ok: modalClosed, d: modalClosed ? '已关闭' : '仍在' }]);

await ev(`document.querySelector('.profile-chip')?.click()`);
await sleep(1200);
await ev(`document.querySelector('.manage-nav-item[aria-current="page"]')?.focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
await sleep(700);
const navAfterArrow = await ev(`(() => { const a = document.activeElement; return a ? (a.className + '|' + a.textContent.trim()) : 'none'; })()`);
record('设置-键盘', [{ n: '↓ 在分区导航内移动焦点', ok: navAfterArrow.includes('manage-nav-item'), d: navAfterArrow }]);
await shot('10-settings-arrow-nav.png');

await pressEsc();
await sleep(800);

console.log('== 阶段 3：空结果 ==');
await ev(`(() => { const i = document.querySelector('.search-field input, input[type="search"]'); if (!i) return null; i.focus(); i.value = 'zzz-no-match'; i.dispatchEvent(new Event('input', { bubbles: true })); return i.className || 'ok'; })()`);
await sleep(1400);
await runGroup(
  '工作台-空结果',
  `
  const nr = document.querySelector('.no-results');
  add('出现空结果提示', !!nr, nr ? 'yes' : 'no');
  if (nr) {
    add('提示区高度 ≥ 380', nr.getBoundingClientRect().height >= 379, Math.round(nr.getBoundingClientRect().height));
    const thead = document.querySelector('.repo-table thead');
    add('列头已隐藏', !thead || getComputedStyle(thead).display === 'none', thead ? getComputedStyle(thead).display : 'no thead');
    const wrapR = nr.closest('.table-wrap')?.getBoundingClientRect();
    add('提示在面板内垂直居中', wrapR ? Math.abs((nr.getBoundingClientRect().top + nr.getBoundingClientRect().height / 2) - (wrapR.top + wrapR.height / 2)) < 40 : false, wrapR ? Math.round((nr.getBoundingClientRect().top + nr.getBoundingClientRect().height / 2)) + ' vs wrap center ' + Math.round(wrapR.top + wrapR.height / 2) : '-');
  }
`,
);
await shot('11-empty-results.png');
await ev(`(() => { const i = document.querySelector('.search-field input, input[type="search"]'); if (!i) return false; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(1200);

console.log('== 阶段 4：AI 会话页 ==');
const navToSessions = await clickText('AI 会话');
await sleep(2000);
await parkPointer();
await sleep(400);
await shot('12-sessions.png');
await runGroup(
  '会话页',
  `
  add('切到 AI 会话页', ${navToSessions}, ${JSON.stringify(navToSessions)});
  const cells = [...document.querySelectorAll('.session-overview > div, .session-overview > button')];
  add('概览 4 格', cells.length === 4, cells.length);
  const strongs = cells.map((c) => c.querySelector('strong')).filter(Boolean);
  add('概览数字 4 个', strongs.length === 4, strongs.map((s) => s.textContent.trim()).join('/'));
  const dash = strongs.find((s) => s.textContent.trim() === '—');
  add('同步未运行时显示 —', !!dash, dash ? getComputedStyle(dash).color : 'none');
  const states = [...document.querySelectorAll('.backup-state')];
  if (states.length) {
    add('备份胶囊有淡底', getComputedStyle(states[0]).backgroundColor !== 'rgba(0, 0, 0, 0)', getComputedStyle(states[0]).backgroundColor);
    add('胶囊圆角 radius-xs', parseFloat(getComputedStyle(states[0]).borderRadius) >= 3, getComputedStyle(states[0]).borderRadius);
  } else add('备份胶囊存在', false, '无 .backup-state');
  const action = document.querySelector('.session-row-actions button');
  add('删除按钮常态 opacity .55', action && Math.abs(parseFloat(getComputedStyle(action).opacity) - 0.55) < 0.06, action ? getComputedStyle(action).opacity : 'missing');
  add('会话页无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
`,
);

if (await ev(`!!document.querySelector('.session-row')`)) {
  await parkPointer();
  const before = await ev(`(() => { const s = getComputedStyle(document.querySelector('.session-row')); return s.backgroundColor + '|' + s.boxShadow; })()`);
  await hover('.session-row');
  const after = await ev(`(() => { const s = getComputedStyle(document.querySelector('.session-row')); return s.backgroundColor + '|' + s.boxShadow; })()`);
  record('会话页', [{ n: '行悬停有背景与左竖线', ok: before !== after && after.includes('rgb'), d: `${before} -> ${after}` }]);
  await shot('13-sessions-hover.png');
}

// 打开详情：.session-row 是 article，点击处理挂在内部的 .session-row-main 按钮上。
await ev(`document.querySelector('.session-row-main')?.click()`);
await sleep(1800);
await shot('14-session-detail.png');
await runGroup(
  '会话详情',
  `
  const strip = document.querySelector('.detail-summary-strip');
  add('详情抽屉打开', !!strip, strip ? 'yes' : 'no');
  const num = strip && strip.querySelector('strong');
  const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize);
  add('统计数字大于正文（> 根字号）', num && parseFloat(getComputedStyle(num).fontSize) > rootFont, num ? getComputedStyle(num).fontSize + ' vs root ' + rootFont + 'px' : 'missing');
  add('统计数字 tabular-nums', num && getComputedStyle(num).fontVariantNumeric.includes('tabular'), num ? getComputedStyle(num).fontVariantNumeric : '-');
  const user = document.querySelector('.conversation-stream article[data-role="user"]');
  if (user) {
    const s = getComputedStyle(user);
    add('用户消息有淡青底', s.backgroundColor !== 'rgba(0, 0, 0, 0)', s.backgroundColor);
    add('用户消息有左侧色条', s.boxShadow !== 'none', s.boxShadow.slice(0, 60));
  } else add('用户消息条存在', false, '无 user 角色');
`,
);

console.log('== 阶段 5：数据分析页 ==');
// 抽屉是覆盖层，先收掉再切工作区，否则截图上会盖着一层。
await pressEsc();
await sleep(700);
const navToAnalytics = await clickText('数据分析');
await sleep(2400);
await parkPointer();
await sleep(400);
await shot('15-analytics.png');
await runGroup(
  '数据分析页',
  `
  add('切到数据分析页', ${navToAnalytics}, ${JSON.stringify(navToAnalytics)});

  // 主体区块的标题曾经是唯一一个光秃秃没有图标的 h2——下面四个 h3 都有，
  // 只有它没有，成了页面上唯一一处「层级最高却最素」的地方。这条断言就是防它复发。
  const h2 = document.querySelector('.heatmap-header h2');
  add('主体标题存在', !!h2, h2 ? h2.textContent.trim() : 'missing');
  const h2Icon = h2 && h2.querySelector('svg');
  add('主体标题带图标', !!h2Icon, h2Icon ? h2Icon.getAttribute('class') || 'svg' : 'missing');
  if (h2Icon && h2) {
    const box = h2Icon.getBoundingClientRect();
    add('图标边长 18px', Math.round(box.width) === 18, Math.round(box.width) + 'x' + Math.round(box.height));
    add('图标没有塌成 0 宽', box.width > 8, Math.round(box.width) + 'px');
    // 图标用 heatmap 色阶而不是继承文字色，两者必须不同才算「上了色」。
    const iconColor = getComputedStyle(h2Icon).color;
    const textColor = getComputedStyle(h2).color;
    add('图标用热度色而非文字色', iconColor !== textColor, iconColor + ' vs 文字 ' + textColor);
    const h2Style = getComputedStyle(h2);
    add('标题按 flex 居中排图标', h2Style.display === 'flex' && h2Style.alignItems === 'center', h2Style.display + '/' + h2Style.alignItems);
    add('图标与文字间距 8px', parseFloat(h2Style.columnGap || h2Style.gap) === 8, h2Style.columnGap || h2Style.gap);
  }

  // 四个区块标题的图标是既有约定，一起盯着，免得以后又少一个。
  // 注意后两个排行标题直接挂在 .heatmap-ranking 下，不在 .heatmap-card-header 里。
  const cardTitles = [...document.querySelectorAll('.commit-heatmap h3')];
  add('区块标题 4 个', cardTitles.length === 4, cardTitles.map((t) => t.textContent.trim()).join('/'));
  const missingIcon = cardTitles.filter((t) => !t.querySelector('svg')).map((t) => t.textContent.trim());
  add('区块标题都有图标', missingIcon.length === 0, missingIcon.join(',') || '0 缺失');
  const notCentered = cardTitles.filter((t) => {
    const s = getComputedStyle(t);
    return s.display !== 'flex' || s.alignItems !== 'center';
  }).map((t) => t.textContent.trim());
  add('区块标题图标都居中', notCentered.length === 0, notCentered.join(',') || '4 个都 flex/center');

  const cells = document.querySelectorAll('.heatmap-cell');
  add('热力图画出格子', cells.length > 300, cells.length);
  const elapsed = [...cells].filter((c) => c.dataset.count === '0' || Number(c.dataset.count) >= 0);
  add('格子都带提交数', elapsed.length === cells.length, elapsed.length + '/' + cells.length);

  // 零值弱化：四五个数字并排时，0 和 100 用同一个最亮色等于没有重点。
  // 工作台早就用 data-zero 定了这个口径，分析页要一致。
  const statNums = [...document.querySelectorAll('.stat-card strong')];
  add('统计卡数字 4 个', statNums.length === 4, statNums.map((n) => n.textContent.trim()).join('/'));
  const zeroNums = statNums.filter((n) => n.textContent.trim() === '0');
  add('卡上的零值标了 data-zero', zeroNums.every((n) => n.dataset.zero === 'true'), zeroNums.length + ' 个零值');

  const hourStats = [...document.querySelectorAll('.hours-stats dd')];
  add('时段统计 4 项', hourStats.length === 4, hourStats.map((d) => d.textContent.trim()).join('/'));
  const zeroHour = hourStats.filter((d) => /^0(%|$)/.test(d.textContent.trim()));
  add('时段零值标了 data-zero', zeroHour.every((d) => d.dataset.zero === 'true'), zeroHour.length + ' 个零值');
  const nonZeroHour = hourStats.filter((d) => !/^0(%|$)/.test(d.textContent.trim()) && d.dataset.zero !== 'true');
  if (zeroHour.length && nonZeroHour.length) {
    const zeroColor = getComputedStyle(zeroHour[0]).color;
    const liveColor = getComputedStyle(nonZeroHour[0]).color;
    add('零值收敛到灰、非零值不灰', zeroColor !== liveColor, '零值 ' + zeroColor + ' vs 非零 ' + liveColor);
  } else {
    add('零值与非零值同时存在（才能比色）', false, '零值 ' + zeroHour.length + ' / 非零 ' + nonZeroHour.length);
  }

  add('分析页无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
`,
);

// 五套主题逐个切 documentElement.dataset.theme 读色值：比回设置面板点 radio 稳
// （不用跨页面），也不会把主题偏好写进用户的配置。切完还原成原主题。
await runGroup(
  '数据分析页',
  `
  const iconEl = document.querySelector('.heatmap-header h2 svg');
  const h2El = document.querySelector('.heatmap-header h2');
  if (!iconEl || !h2El) {
    add('五套主题图标都上了色', false, '找不到图标');
  } else {
    const html = document.documentElement;
    const original = html.dataset.theme;
    const clashes = [];
    const seen = [];
    for (const t of ['fleet-blue', 'mooeen', 'dark-modern', 'monokai', 'dark-high-contrast']) {
      html.dataset.theme = t;
      const iconColor = getComputedStyle(iconEl).color;
      const textColor = getComputedStyle(h2El).color;
      seen.push(t + '=' + iconColor);
      if (iconColor === textColor) clashes.push(t);
    }
    html.dataset.theme = original;
    add('五套主题图标都上了色', clashes.length === 0, clashes.length ? '与文字撞色：' + clashes.join(',') : seen.length + ' 套均不同');
  }
`,
);

// 整页只有一套栅格。原来上排是 3:2、下排是 1:1，两排的分栏边界差出半列，
// 下排那张卡会往左探出一截——页面被横切成两套栏，越往下越像没对齐。
// 这类问题肉眼一眼能看出，但没有任何断言盯着，只能靠人每次自己去数。
await runGroup(
  '数据分析页-栅格',
  `
  const box = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
  const topCards = [...document.querySelectorAll('.heatmap-insights > .heatmap-card')].map((c) => c.getBoundingClientRect());
  const bottomCards = [...document.querySelectorAll('.heatmap-columns > .heatmap-ranking')].map((c) => c.getBoundingClientRect());
  add('上排两张卡', topCards.length === 2, topCards.length);
  add('下排两张卡', bottomCards.length === 2, bottomCards.length);

  if (topCards.length === 2 && bottomCards.length === 2) {
    const [topL, topR] = topCards;
    const [botL, botR] = bottomCards;
    const topGap = (topL.right + topR.left) / 2;
    const bottomGap = (botL.right + botR.left) / 2;
    const drift = Math.abs(topGap - bottomGap);
    add('两排分栏边界同一条竖线', drift <= 1, '上 ' + topGap.toFixed(1) + ' vs 下 ' + bottomGap.toFixed(1) + '（差 ' + drift.toFixed(1) + 'px）');
    add('两排左边缘对齐', Math.abs(topL.left - botL.left) <= 1, topL.left.toFixed(1) + ' vs ' + botL.left.toFixed(1));
    add('两排右边缘对齐', Math.abs(topR.right - botR.right) <= 1, topR.right.toFixed(1) + ' vs ' + botR.right.toFixed(1));

    const topGapWidth = topR.left - topL.right;
    const bottomGapWidth = botR.left - botL.right;
    add('两排卡片间距一致', Math.abs(topGapWidth - bottomGapWidth) <= 1, topGapWidth.toFixed(1) + ' vs ' + bottomGapWidth.toFixed(1));

    // 列宽比例也一致，否则边界对齐了卡宽还是不一样的。
    const topLeftRatio = topL.width / (topL.width + topR.width);
    const bottomLeftRatio = botL.width / (botL.width + botR.width);
    add('两排左右卡宽比例一致', Math.abs(topLeftRatio - bottomLeftRatio) < 0.01, topLeftRatio.toFixed(3) + ' vs ' + bottomLeftRatio.toFixed(3));

    // 内边距也要一致：卡片对齐了、标题却没对齐，看起来还是歪的。
    const topH3 = box('.heatmap-card-header h3');
    const bottomH3 = box('.heatmap-ranking > h3');
    if (topH3 && bottomH3) {
      add('两排标题左边缘对齐', Math.abs(topH3.left - bottomH3.left) <= 1, topH3.left.toFixed(1) + ' vs ' + bottomH3.left.toFixed(1));
    } else {
      add('两排标题左边缘对齐', false, '找不到标题');
    }

    // 统计卡那排是 4 列，间距原来比两排小 4px，横向看过去不齐。
    const statCards = [...document.querySelectorAll('.heatmap-stats > .stat-card')].map((c) => c.getBoundingClientRect());
    if (statCards.length === 4) {
      const statGap = statCards[1].left - statCards[0].right;
      add('统计卡间距与两排一致', Math.abs(statGap - topGapWidth) <= 1, statGap.toFixed(1) + ' vs ' + topGapWidth.toFixed(1));
      add('统计卡首尾与两排同宽', Math.abs(statCards[0].left - topL.left) <= 1 && Math.abs(statCards[3].right - topR.right) <= 1, statCards[0].left.toFixed(1) + '..' + statCards[3].right.toFixed(1));
      const statWidths = statCards.map((r) => Math.round(r.width));
      add('四张统计卡等高', new Set(statCards.map((r) => Math.round(r.height))).size === 1, statCards.map((r) => Math.round(r.height)).join('/'));
      add('四张统计卡等宽', new Set(statWidths).size === 1, statWidths.join('/'));
    }
  }
`,
);

// 「上下对齐」不能只在自己挑的那一档成立——用户窗口落在哪个宽度上都得成立。
// 这里横扫一遍常见宽度（含 1302：真机上分析页就开在这个宽度），要求边界差 ≤ 0.5px。
for (const width of [1281, 1302, 1440, 1600, 1920]) {
  await setViewport(width, 900);
  await sleep(900);
  if (width === 1302) {
    await parkPointer();
    await sleep(250);
    await shot('18-analytics-1302.png');
  }
  await runGroup(
    '数据分析页-栅格 ' + width,
    `
    const top = [...document.querySelectorAll('.heatmap-insights > .heatmap-card')].map((c) => c.getBoundingClientRect());
    const bottom = [...document.querySelectorAll('.heatmap-columns > .heatmap-ranking')].map((c) => c.getBoundingClientRect());
    add('${width} 两排都是两列', top.length === 2 && bottom.length === 2, top.length + '/' + bottom.length);
    if (top.length === 2 && bottom.length === 2) {
      const topEdge = (top[0].right + top[1].left) / 2;
      const bottomEdge = (bottom[0].right + bottom[1].left) / 2;
      add('${width} 分栏边界严格同线', Math.abs(topEdge - bottomEdge) <= 0.5, '上 ' + topEdge.toFixed(1) + ' vs 下 ' + bottomEdge.toFixed(1) + '（差 ' + Math.abs(topEdge - bottomEdge).toFixed(1) + 'px）');
      add('${width} 左边缘严格对齐', Math.abs(top[0].left - bottom[0].left) <= 0.5, top[0].left.toFixed(1) + ' vs ' + bottom[0].left.toFixed(1));
      add('${width} 右边缘严格对齐', Math.abs(top[1].right - bottom[1].right) <= 0.5, top[1].right.toFixed(1) + ' vs ' + bottom[1].right.toFixed(1));
    }
`,
  );
}

console.log('== 阶段 5b：分析页 1024 ==');
await setViewport(1024, 900);
await sleep(1200);
await parkPointer();
await sleep(300);
await shot('16-analytics-1024.png');
await runGroup(
  '数据分析页 1024',
  `
  const box = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
  add('无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);

  // 7×24 矩阵在 1024 下撑不开，上排会转成单列——这是有意的，但它必须真的转了，
  // 否则矩阵会被压成一排几像素的点。
  const insights = document.querySelector('.heatmap-insights');
  const columns = insights ? getComputedStyle(insights).gridTemplateColumns.split(' ').filter(Boolean) : [];
  add('1024 下上排转单列', columns.length === 1, columns.join(' | ') || 'missing');
  const insightCards = [...document.querySelectorAll('.heatmap-insights > .heatmap-card')].map((c) => Math.round(c.getBoundingClientRect().width));
  add('上排两张卡都占满整行', insightCards.length === 2 && new Set(insightCards).size === 1, insightCards.join('/'));

  const cell = document.querySelector('.hours-cell');
  add('时段格子没被压扁', !!cell && cell.getBoundingClientRect().width >= 8, cell ? Math.round(cell.getBoundingClientRect().width) + 'px' : 'missing');

  // 下排两张排行卡在 1024 下仍并排，宽度按 3:2 分，边界必须还在同一条线上。
  const ranks = [...document.querySelectorAll('.heatmap-columns > .heatmap-ranking')].map((c) => c.getBoundingClientRect());
  add('1024 下排行仍并排', ranks.length === 2 && ranks[0].top === ranks[1].top, ranks.length === 2 ? 'top ' + Math.round(ranks[0].top) + '/' + Math.round(ranks[1].top) : 'missing');
  if (ranks.length === 2) {
    add('1024 下排行卡不重叠', ranks[0].right <= ranks[1].left, Math.round(ranks[0].right) + ' <= ' + Math.round(ranks[1].left));
    // 上排转单列之后没有分界线要对齐，下排就该均分：3:2 会把右侧挤到 400 上下，
    // 名称列固定 152px 之后条形只剩 110px，几条绿条几乎一样长就没法比了。
    add('1024 下排行两卡等宽', Math.abs(ranks[0].width - ranks[1].width) <= 1, Math.round(ranks[0].width) + ' vs ' + Math.round(ranks[1].width));
    const left = document.querySelector('.heatmap-insights > .heatmap-card');
    add('1024 下排行与上方卡片左边缘对齐', left && Math.abs(left.getBoundingClientRect().left - ranks[0].left) <= 1, left ? Math.round(left.getBoundingClientRect().left) + ' vs ' + Math.round(ranks[0].left) : 'missing');
  }
`,
);
// 下排在这一档会被折到首屏之外，单独滚到底截一张，否则「窄屏下排行长什么样」从来没有证据。
await ev(`window.scrollTo(0, document.body.scrollHeight)`);
await sleep(500);
await shot('17-analytics-1024-ranking.png');
await ev(`window.scrollTo(0, 0)`);
await sleep(300);
await setViewport(1440, 900);
await sleep(600);

console.log('== 阶段 6：窄视口 ==');
await pressEsc();
await sleep(700);
record('会话详情', [{ n: 'Esc 关闭详情抽屉', ok: !(await ev(`!!document.querySelector('.local-session-drawer')`)), d: await ev(`document.querySelectorAll('.local-session-drawer').length + ' drawer'`) }]);
await setViewport(700, 900);
await sleep(1200);
await ev(`document.querySelector('.profile-chip')?.click()`);
await sleep(1400);
await clickNavByText('界面显示');
await sleep(900);
await shot('15-narrow-700-appearance.png');
await runGroup(
  '窄视口 700',
  `
  const nav = document.querySelector('.manage-nav');
  add('导航转横向', nav && getComputedStyle(nav).flexDirection === 'row', nav ? getComputedStyle(nav).flexDirection : '-');
  const label = document.querySelector('.manage-nav-label');
  add('横向时隐藏分区小标题', !label || getComputedStyle(label).display === 'none', label ? getComputedStyle(label).display : 'missing');
  const pair = document.querySelector('.manage-field-pair');
  add('字体四宫格转单列', pair && getComputedStyle(pair).gridTemplateColumns.split(' ').length === 1, pair ? getComputedStyle(pair).gridTemplateColumns : '-');
  add('无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
  const modal = document.querySelector('.setup-modal.manage-modal');
  add('弹窗在视口内', modal && modal.getBoundingClientRect().right <= window.innerWidth + 1, modal ? Math.round(modal.getBoundingClientRect().right) + ' <= ' + window.innerWidth : '-');
`,
);
await clickNavByText('远端');
await sleep(900);
await shot('16-narrow-700-remote.png');
await runGroup(
  '窄视口 700-远端',
  `
  const input = document.querySelector('.secret-input-control input, .remote-credential-form input');
  add('令牌框不溢出', !input || input.getBoundingClientRect().width > 120, input ? Math.round(input.getBoundingClientRect().width) : 'none');
  const rows = [...document.querySelectorAll('.remote-repository, .remote-credential-row')];
  const overflow = rows.filter((r) => r.scrollWidth > r.clientWidth + 1);
  add('远端行无横向溢出', overflow.length === 0, overflow.length + '/' + rows.length);
  add('页面无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
`,
);

record('运行时', [
  { n: '无 console.error', ok: consoleErrors.length === 0, d: consoleErrors.slice(0, 3).join(' | ') || '0 条' },
  { n: '无未捕获异常', ok: pageExceptions.length === 0, d: pageExceptions.slice(0, 3).join(' | ') || '0 条' },
]);

const failed = results.filter((r) => !r.ok);
console.log('\n===== 结果 =====');
let lastGroup = '';
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`\n[${r.group}]`);
    lastGroup = r.group;
  }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  — ' + r.d : ''}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
fs.writeFileSync(path.join(shotsDir, 'result.json'), JSON.stringify({ results, consoleErrors, pageExceptions }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
