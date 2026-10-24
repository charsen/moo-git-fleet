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

/**
 * CDP 连接断开时，所有在飞的命令都必须立刻失败。
 *
 * 不这么做的话，浏览器崩掉（受限环境里 Chrome 初始化不了自己的进程沙箱，
 * GPU 进程连崩几次就 FATAL 自杀）之后，`send()` 返回的 Promise 永远不 settle：
 * Node 发现事件循环空了，只报一句 `unsettled top-level await` 然后 exit 13。
 * 排查时看到的是「脚本卡在 Page.enable」，真正的死因（浏览器崩了）一句都没有。
 */
let chromeExit = null;
chrome.on('exit', (code, signal) => {
  chromeExit = { code, signal };
});

const failPending = (reason) => {
  for (const [id, { reject }] of pending) {
    pending.delete(id);
    reject(new Error(reason));
  }
};

ws.onclose = () => {
  failPending(
    chromeExit
      ? `Chrome 已退出（code=${chromeExit.code} signal=${chromeExit.signal}），CDP 连接随之断开。`
        + '受限环境（容器 / CI 沙箱）里 Chrome 起不了自己的进程沙箱，日志里会看到 '
        + '`sandbox initialization failed: Operation not permitted` 与 GPU 连续崩溃；'
        + '用 MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu" 重跑。'
      : 'CDP 连接被关闭，浏览器可能已崩溃。受限环境请设置 '
        + 'MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu"。',
  );
};

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
  add('区块标题 6 个', cardTitles.length === 6, cardTitles.map((t) => t.textContent.trim()).join('/'));
  const missingIcon = cardTitles.filter((t) => !t.querySelector('svg')).map((t) => t.textContent.trim());
  add('区块标题都有图标', missingIcon.length === 0, missingIcon.join(',') || '0 缺失');
  const notCentered = cardTitles.filter((t) => {
    const s = getComputedStyle(t);
    return s.display !== 'flex' || s.alignItems !== 'center';
  }).map((t) => t.textContent.trim());
  add('区块标题图标都居中', notCentered.length === 0, notCentered.join(',') || '4 个都 flex/center');

  // 排行标题按「度量」命名，不写「贡献」——这两张卡排的是提交数 / 增删行，
  // 用「贡献」会让人以为背后有加权评分。
  const titleTexts = cardTitles.map((t) => t.textContent.trim());
  add('排行标题按度量命名', titleTexts.includes('仓库排行') && titleTexts.includes('作者排行'), titleTexts.join('/'));

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
  // 「深夜」和「工作日 / 周末」是两套切法，会重叠。不写清楚，四个数字看着像三段分布。
  const hoursNote = document.querySelector('.hours-note');
  add(
    '时段卡写明占比重叠',
    !!hoursNote && hoursNote.textContent.indexOf('重叠') >= 0,
    hoursNote ? hoursNote.textContent.trim().slice(0, 40) : 'missing',
  );

  // 分桶是 ≤7 / ≤30 / ≤90 / >90。最后一档写成「90 天以上」会和上一档重叠在 90 这一天。
  const bucketLabels = [...document.querySelectorAll('.freshness-label')].map((l) => l.textContent.trim());
  add('活跃度最后一档是 91 天以上', bucketLabels[bucketLabels.length - 1] === '91 天以上', bucketLabels.join('/'));
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

// 时间段：整页唯一的口径开关。默认近一年，用户可以自己调。
// 它决定的不只是热力图列数，还有四张统计卡、非上班时间、代码量、时段分布与两个排行——
// 以前这几块各写各的范围（热力图 52 周、非上班时间与提交时段是全部历史），
// 同一屏并排放着两种窗口。
console.log('== 阶段 5b：数据分析页-时间段 ==');
await runGroup(
  '数据分析页-时间段',
  `
  const allButtons = [...document.querySelectorAll('.range-switch button')];
  const buttons = allButtons.filter((b) => b.dataset.weeks);
  add('时间段有 4 个预设', buttons.length === 4, buttons.map((b) => b.textContent.trim()).join('/'));
  add('预设之外还有自定义入口', allButtons.some((b) => b.dataset.range === 'custom'), allButtons.length + ' 个按钮');
  add('每个预设都带周数标记', buttons.length > 0 && buttons.every((b) => /^[0-9]+$/.test(b.dataset.weeks || '')), buttons.map((b) => b.dataset.weeks).join('/'));
  const active = document.querySelector('.range-switch button.active');
  add('默认选中近一年', !!active && active.dataset.weeks === '52', active ? active.textContent.trim() + '/' + active.dataset.weeks : 'none');
  const pressed = allButtons.filter((b) => b.getAttribute('aria-pressed') === 'true');
  add('aria-pressed 只有一个为真', pressed.length === 1 && pressed[0] === active, pressed.length);

  // 整页三个口径都收在同一个工具栏：时间段、排行度量、仓库范围。
  // 少一个就会回到「同一屏并排放着两种统计范围」的老问题。
  const toolbar = document.querySelector('.range-toolbar');
  const inToolbar = ['.range-switch', '.metric-switch', '.analytics-repository-scope']
    .map((selector) => (toolbar ? !!toolbar.querySelector(selector) : false));
  add('工具栏含时间段/度量/仓库范围', inToolbar.every(Boolean), inToolbar.map((ok) => (ok ? '1' : '0')).join(''));
  add('页面上只有一组度量开关', document.querySelectorAll('.metric-switch').length === 1, document.querySelectorAll('.metric-switch').length);

  // 数据来源必须写明：这一页只读本地仓库副本，「刷新」也只是就地重算，
  // 不提示的话用户会以为「同事昨天推的提交」丢在了产品里。
  const localNote = document.querySelector('[data-local-note]');
  const localNoteText = localNote ? localNote.textContent.replace(/\\s+/g, '') : '';
  add('写明分析基于本地数据', /本地/.test(localNoteText) && /Fetch/i.test(localNoteText), localNoteText.slice(0, 40));
  add('来源说明不写具体截止时间', !/截至|最后更新|\\d{4}-\\d{2}-\\d{2}/.test(localNoteText), localNoteText.slice(0, 40));
  add('来源说明单独成行、不塞进工具栏', !!localNote && !localNote.closest('.range-toolbar'), localNote && localNote.closest('.range-toolbar') ? 'inside' : 'outside');
  add('来源说明可见且不换行', !!localNote && localNote.offsetHeight > 0 && localNote.offsetHeight < 30, localNote ? localNote.offsetHeight + 'px' : 'none');

  const cols = new Set([...document.querySelectorAll('.heatmap-cell')].map((c) => c.getAttribute('x'))).size;
  add('默认画出 52 列', cols === 52, cols);

  const dates = (document.querySelector('.range-dates') || {}).textContent || '';
  add('写明具体起止日期', /^\\d{4}-\\d{2}-\\d{2} ~ \\d{4}-\\d{2}-\\d{2}$/.test(dates.trim()), dates.trim());

  const subtitle = (document.querySelector('.heatmap-subtitle') || {}).textContent || '';
  add('副标题写明所选时间段', subtitle.trim().indexOf('近一年') === 0, subtitle.trim());

  const statLabel = (document.querySelector('.stat-card span') || {}).textContent || '';
  add('统计卡标签跟着时间段', statLabel.trim() === '近一年提交', statLabel.trim());

  // 记下切换前的状态，切回来时要能对上（同一份数据、同一个范围）
  window.__rangeSnapshot = { dates: dates.trim(), commits: (document.querySelector('.stat-card strong') || {}).textContent || '' };
`,
);

const switchedRange = await ev(`(() => {
  const button = document.querySelector('.range-switch button[data-weeks="26"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
let rangeSettled = false;
for (let i = 0; i < 60; i += 1) {
  rangeSettled = await ev(`(() => {
    const subtitle = document.querySelector('.heatmap-subtitle');
    return !!subtitle && subtitle.textContent.indexOf('近 6 个月') === 0;
  })()`);
  if (rangeSettled) break;
  await sleep(300);
}
await sleep(500);
await shot('15b-analytics-range-6m.png');
// 先取一份接口数据，用来核对「界面上的数」和「服务端按 weeks 算出来的数」是不是同一个。
// 夹具只有二十来条提交、全落在近半年内，所以不能靠「切范围后数字必须变」来验——
// 那在真实仓库上成立，在夹具上会误报。真正的判据是两边相等。
const rangeApi = JSON.parse(
  await ev(`(async () => {
    const ok = await (await fetch('/api/analytics/heatmap?weeks=26')).json();
    const bad = await (await fetch('/api/analytics/heatmap?weeks=oops')).json();
    return JSON.stringify({
      ok: { weeks: ok.range.weeks, label: ok.range.label, start: ok.range.start, end: ok.range.end, days: Object.keys(ok.daily).length, commits: ok.summary.totalCommits },
      bad: { weeks: bad.range.weeks, label: bad.range.label },
    });
  })()`),
);
await runGroup(
  '数据分析页-时间段切换',
  `
  const api = ${JSON.stringify(rangeApi)};
  add('切到近 6 个月', ${switchedRange}, ${JSON.stringify(switchedRange)});
  add('副标题跟着换', ${rangeSettled}, ${JSON.stringify(rangeSettled)});
  const cols = new Set([...document.querySelectorAll('.heatmap-cell')].map((c) => c.getAttribute('x'))).size;
  add('格子变成 26 列', cols === 26, cols);
  const dates = ((document.querySelector('.range-dates') || {}).textContent || '').trim();
  add('起止日期跟着换', dates !== window.__rangeSnapshot.dates, window.__rangeSnapshot.dates + ' -> ' + dates);
  add('起止日期与接口一致', dates === api.ok.start + ' ~ ' + api.ok.end, dates + ' vs ' + api.ok.start);
  const statLabel = ((document.querySelector('.stat-card span') || {}).textContent || '').trim();
  add('统计卡标签跟着换', statLabel === '近 6 个月提交', statLabel);
  // 界面上的提交数必须等于接口在这个窗口里算出来的数，说明两边是同一份数据
  const commits = ((document.querySelector('.stat-card strong') || {}).textContent || '').trim();
  add('提交数与接口一致', commits.split(',').join('') === String(api.ok.commits), commits + ' vs ' + api.ok.commits);
  const hints = [...document.querySelectorAll('.heatmap-card-hint')].map((h) => h.textContent.trim());
  add('各卡卡头同步范围', hints.length >= 3 && hints.slice(0, 3).every((h) => h.indexOf('近 6 个月') === 0), hints.join(' | '));
  const rankingHints = [...document.querySelectorAll('.ranking-hint')].map((h) => h.textContent.trim());
  add('排行说明同步范围', rankingHints.length === 2 && rankingHints.every((h) => h.indexOf('近 6 个月') === 0), rankingHints.join(' | '));
  // 换范围不能把布局撑坏：长窗口曾经把整页顶出横向滚动条
  add('换范围后无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
`,
);

// 接口层单独验一次：界面上的 26 列必须真的是服务端按 weeks 算出来的，
// 而不是前端自己裁剪——否则数字和格子会对不上。非法值要回落，不能报错。
await runGroup(
  '数据分析页-时间段接口',
  `
  const api = ${JSON.stringify(rangeApi)};
  add('接口按 weeks 计算窗口', api.ok.weeks === 26 && api.ok.label === '近 6 个月', JSON.stringify(api.ok));
  add('接口回传的起止日期合法', /^\\d{4}-\\d{2}-\\d{2}$/.test(api.ok.start) && api.ok.start < api.ok.end, api.ok.start + ' ~ ' + api.ok.end);
  add('接口只回窗口内的日期', api.ok.days > 0 && api.ok.days <= 26 * 7, api.ok.days + ' 天');
  add('非法 weeks 回落到近一年', api.bad.weeks === 52 && api.bad.label === '近一年', JSON.stringify(api.bad));
`,
);

// 切回近一年，后面的窄屏截图与断言按默认范围来
const restoredRange = await ev(`(() => {
  const button = document.querySelector('.range-switch button[data-weeks="52"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
for (let i = 0; i < 60; i += 1) {
  const done = await ev(`(() => {
    const subtitle = document.querySelector('.heatmap-subtitle');
    return !!subtitle && subtitle.textContent.indexOf('近一年') === 0;
  })()`);
  if (done) break;
  await sleep(300);
}
await runGroup(
  '数据分析页-时间段还原',
  `
  add('切回近一年', ${restoredRange}, ${JSON.stringify(restoredRange)});
  const cols = new Set([...document.querySelectorAll('.heatmap-cell')].map((c) => c.getAttribute('x'))).size;
  add('格子回到 52 列', cols === 52, cols);
  const dates = ((document.querySelector('.range-dates') || {}).textContent || '').trim();
  add('起止日期回到原值', dates === window.__rangeSnapshot.dates, window.__rangeSnapshot.dates + ' vs ' + dates);
  const commits = ((document.querySelector('.stat-card strong') || {}).textContent || '').trim();
  add('提交数回到原值', commits === window.__rangeSnapshot.commits, window.__rangeSnapshot.commits + ' vs ' + commits);
`,
);

// 自定义时间段：预设只覆盖四个固定跨度，查某个迭代、某次上线前后只能填日期。
// 这里验的不是「面板能打开」，而是填进去之后整页（标签 / 日期 / 格子 / 数字 / 接口）
// 都换成了那个区间，而且和预设入口不会互相串。
const dayShift = (iso, days) => {
  const [year, month, date] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date) + days * 86_400_000).toISOString().slice(0, 10);
};
const weekdayIndex = (iso) => {
  const [year, month, date] = iso.split('-').map(Number);
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7; // 周一 = 0
};
const expectedColumns = (start, end) => {
  const firstMonday = dayShift(start, -weekdayIndex(start));
  const lastSunday = dayShift(end, 6 - weekdayIndex(end));
  const [fy, fm, fd] = firstMonday.split('-').map(Number);
  const [ly, lm, ld] = lastSunday.split('-').map(Number);
  return Math.ceil((Date.UTC(ly, lm - 1, ld) - Date.UTC(fy, fm - 1, fd)) / 86_400_000 / 7);
};

const openedCustom = await ev(`(() => {
  const button = document.querySelector('.range-custom-trigger');
  if (!button) return false;
  button.click();
  return true;
})()`);
await sleep(200);
const prefilled = JSON.parse(await ev(`JSON.stringify({
  open: !!document.querySelector('.range-custom'),
  start: (document.querySelector('[data-range-start]') || {}).value || '',
  end: (document.querySelector('[data-range-end]') || {}).value || '',
  dates: (document.querySelector('.range-dates') || {}).textContent.trim(),
})`));
// 取窗口**末尾**的 45 天（含今天）：夹具的提交时间就是「现在」，窗口尾部才有数；
// 45 天又不是任何一个预设（13/26/52/104 周）——否则「是不是真的换了范围」看不出来。
const [snapshotStart, snapshotEnd] = prefilled.dates.split(' ~ ');
const prefillOk = prefilled.open && prefilled.start === snapshotStart && prefilled.end === snapshotEnd;
const customEnd = snapshotEnd;
const customStart = dayShift(customEnd, -44);
const appliedCustom = JSON.parse(await ev(`(async () => {
  const set = (selector, value) => {
    const input = document.querySelector(selector);
    if (!input) return false;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const startOk = set('[data-range-start]', ${JSON.stringify(customStart)});
  const endOk = set('[data-range-end]', ${JSON.stringify(customEnd)});
  // 等校验跑完再点：「应用」的可用状态是响应式算出来的
  await new Promise((resolve) => setTimeout(resolve, 200));
  const apply = document.querySelector('.range-custom-apply');
  if (!startOk || !endOk || !apply || apply.disabled) return JSON.stringify({ ok: false, startOk, endOk, disabled: apply ? apply.disabled : 'missing' });
  apply.click();
  return JSON.stringify({ ok: true });
})()`));
for (let i = 0; i < 60; i += 1) {
  const settled = await ev(`(() => {
    const dates = (document.querySelector('.range-dates') || {}).textContent.trim();
    return dates === ${JSON.stringify(`${customStart} ~ ${customEnd}`)};
  })()`);
  if (settled) break;
  await sleep(300);
}
await sleep(400);
// 再查一段「本次没有任何提交」的历史区间：夹具的提交全在现在，
// 所以只要服务端真的按 start/end 裁，这段必须是 0；若它把整窗都算进来，就会是 22。
const historicStart = dayShift(customStart, -60);
const historicEnd = dayShift(customStart, -1);
const historicApi = JSON.parse(await ev(`(async () => {
  const response = await fetch('/api/analytics/heatmap?start=${historicStart}&end=${historicEnd}');
  const data = await response.json();
  return JSON.stringify({ start: data.range.start, end: data.range.end, commits: data.summary.totalCommits, days: Object.keys(data.daily).length });
})()`));
const customApi = JSON.parse(await ev(`(async () => {
  const response = await fetch('/api/analytics/heatmap?start=${customStart}&end=${customEnd}');
  const data = await response.json();
  const keys = Object.keys(data.daily);
  return JSON.stringify({
    kind: data.range.kind,
    weeks: data.range.weeks,
    start: data.range.start,
    end: data.range.end,
    label: data.range.label,
    commits: data.summary.totalCommits,
    days: keys.length,
    outside: keys.filter((d) => d < '${customStart}' || d > '${customEnd}').slice(0, 3),
  });
})()`));
await shot('15c-analytics-custom-range.png');
await runGroup(
  '数据分析页-自定义时间段',
  `
  add('自定义面板可以打开', ${openedCustom && prefilled.open}, ${JSON.stringify(`${openedCustom} / open=${prefilled.open}`)});
  // 展开时预填「当前正在看的范围」，微调日期比重填两个框省事
  add('预填当前起止日期', ${prefillOk}, ${JSON.stringify(`${prefilled.start} ~ ${prefilled.end}`)});
  add('填写两个日期后可以应用', ${appliedCustom.ok}, JSON.stringify(${JSON.stringify(appliedCustom)}));
  add('面板应用后收起', !document.querySelector('.range-custom'), document.querySelector('.range-custom') ? 'still open' : 'closed');

  const dates = (document.querySelector('.range-dates') || {}).textContent.trim();
  add('起止日期换成自选区间', dates === ${JSON.stringify(`${customStart} ~ ${customEnd}`)}, dates);

  const customButton = document.querySelector('.range-custom-trigger');
  add('自定义按钮选中', !!customButton && customButton.getAttribute('aria-pressed') === 'true', customButton ? customButton.getAttribute('aria-pressed') : 'missing');
  const presetActives = [...document.querySelectorAll('.range-switch button[data-weeks]')].filter((b) => b.classList.contains('active'));
  add('四个预设都不再高亮', presetActives.length === 0, presetActives.map((b) => b.textContent.trim()).join(',') || '0');

  // 卡头写的是「自定义 45 天」：预设之外的范围没有现成名字，就把天数说出来
  const statLabel = ((document.querySelector('.stat-card span') || {}).textContent || '').trim();
  add('统计卡标签写明天数', statLabel === '自定义 45 天提交', statLabel);

  const cols = new Set([...document.querySelectorAll('.heatmap-cell')].map((c) => c.getAttribute('x'))).size;
  // 行要对应星期，所以网格向外扩到整周；列数是「周跨度」，不是天数/7 向上取整的另一种算法
  add('格子列数按周跨度', cols === ${expectedColumns(customStart, customEnd)}, cols + ' vs 期望 ${expectedColumns(customStart, customEnd)}');

  const api = ${JSON.stringify(customApi)};
  add('接口按 start/end 计算', api.kind === 'custom' && api.weeks === null, api.kind + '/' + api.weeks);
  add('接口回传同一区间', api.start === ${JSON.stringify(customStart)} && api.end === ${JSON.stringify(customEnd)}, api.start + ' ~ ' + api.end);
  add('接口标签与界面一致', api.label === ${JSON.stringify(`自定义 45 天`)}, api.label);
  const commits = ((document.querySelector('.stat-card strong') || {}).textContent || '').trim();
  add('提交数与接口一致', commits.split(',').join('') === String(api.commits), commits + ' vs ' + api.commits);
  // 自选区间必须真的裁到天内：daily 里出现区间外的日期，说明服务端还在按整周算
  add('接口只回自选区间内的日期', api.outside.length === 0, api.outside.join(',') || api.days + ' 天全在区间内');
  const snapshotCommits = Number(String(window.__rangeSnapshot.commits).split(',').join(''));
  add('自选区间不超过近一年', api.commits <= snapshotCommits, api.commits + ' <= ' + snapshotCommits);

  // 夹具的提交都在「今天」，所以光看数字相等证不了裁剪生效。
  // 换一段同样长度、但不含今天的历史区间：必须一天都没有。
  const historic = ${JSON.stringify(historicApi)};
  add('历史区间回传自己的起止', historic.start === ${JSON.stringify(historicStart)} && historic.end === ${JSON.stringify(historicEnd)}, historic.start + ' ~ ' + historic.end);
  add('历史区间内一天都没有', historic.commits === 0 && historic.days === 0, historic.commits + ' 次 / ' + historic.days + ' 天');
  add('换范围后无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth);
`,
);

// 非法输入要被拦在点击之前：服务端会回落，但界面得先说清楚，别让用户以为生效了
await ev(`(() => {
  const trigger = document.querySelector('.range-custom-trigger');
  if (trigger) trigger.click();
  return true;
})()`);
await sleep(200);
const invalidState = JSON.parse(await ev(`(async () => {
  const set = (selector, value) => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // 结束早于开始：应用按钮必须禁用，并说明原因
  set('[data-range-start]', '2026-10-20');
  set('[data-range-end]', '2026-10-01');
  // v-model 的校验是响应式的，等一轮渲染再读，否则读到的是改之前的状态
  await new Promise((resolve) => setTimeout(resolve, 200));
  const apply = document.querySelector('.range-custom-apply');
  const hint = (document.querySelector('.range-custom-hint') || {}).textContent.trim();
  return JSON.stringify({ disabled: apply.disabled, hint });
})()`));
await runGroup(
  '数据分析页-自定义时间段校验',
  `
  const state = ${JSON.stringify(invalidState)};
  add('起止颠倒时禁用应用', state.disabled === true, String(state.disabled));
  add('并说明哪里不对', state.hint.indexOf('结束日期') === 0, state.hint);
`,
);
await ev(`(() => {
  const cancel = [...document.querySelectorAll('.range-custom button')].find((b) => b.textContent.trim() === '取消');
  if (cancel) cancel.click();
  return true;
})()`);
await sleep(200);

// 收回预设入口：不能因为切过自定义就一直停在自定义上
const backToPreset = await ev(`(() => {
  const button = document.querySelector('.range-switch button[data-weeks="52"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
for (let i = 0; i < 60; i += 1) {
  const done = await ev(`(() => {
    const dates = (document.querySelector('.range-dates') || {}).textContent.trim();
    return dates === window.__rangeSnapshot.dates;
  })()`);
  if (done) break;
  await sleep(300);
}
await runGroup(
  '数据分析页-自定义后回到预设',
  `
  add('点回近一年', ${backToPreset}, ${JSON.stringify(backToPreset)});
  const customButton = document.querySelector('.range-custom-trigger');
  add('自定义按钮取消选中', !!customButton && customButton.getAttribute('aria-pressed') === 'false', customButton ? customButton.getAttribute('aria-pressed') : 'missing');
  const active = document.querySelector('.range-switch button.active');
  add('近一年重新高亮', !!active && active.dataset.weeks === '52', active ? active.dataset.weeks : 'none');
  const cols = new Set([...document.querySelectorAll('.heatmap-cell')].map((c) => c.getAttribute('x'))).size;
  add('格子回到 52 列', cols === 52, cols);
  const statLabel = ((document.querySelector('.stat-card span') || {}).textContent || '').trim();
  add('标签回到近一年', statLabel === '近一年提交', statLabel);
`,
);

// 提交数说明不了投入多久。这一屏以前只有占比（工作日 76%、深夜 10%），
// 看不出「到底投了多少小时、折合几天」，而这正是唯一能被拿去对账的数字。
await runGroup(
  '数据分析页-非上班时间',
  `
  // 副标题写着所选时间段，里面的数字就必须是同一个窗口内的。
  // 它曾经取全历史的 totalCommits，和紧挨着的提交卡片差出两成。
  const subtitle = document.querySelector('.heatmap-subtitle');
  const subText = subtitle ? subtitle.textContent.replace(/\\s+/g, ' ').trim() : '';
  const statFirst = document.querySelector('.stat-card strong');
  const statText = statFirst ? statFirst.textContent.trim() : '';
  add('副标题与提交卡片同口径', !!statText && subText.includes(statText), subText + ' | 卡片 ' + statText);
  add('副标题不再混全历史累计', !subText.includes('累计'), subText);

  const card = document.querySelector('.overtime-card');
  add('非上班时间卡存在', !!card, card ? 'ok' : 'missing');
  if (card) {
    const h3 = card.querySelector('h3');
    add('卡片标题为非上班时间', !!h3 && h3.textContent.includes('非上班时间'), h3 ? h3.textContent.trim() : 'missing');
    add('卡片标题带图标', !!(h3 && h3.querySelector('svg')), h3 && h3.querySelector('svg') ? 'svg' : 'missing');

    const hint = card.querySelector('.heatmap-card-hint');
    const hintText = hint ? hint.textContent.trim() : '';
    add('卡头写明正常工时', hintText.includes('08:30') && hintText.includes('18:00'), hintText);
    // 这张卡的时间范围必须写出来，而且要跟页面顶部选的时间段一致。
    // 它曾经是「全部历史」，而上面四张卡是近 52 周——六位数的累计时长会被
    // 读成「近一年的加班」，和副标题那处混口径是同一类错误。
    const rangeLabel = document.querySelector('.range-switch button.active')?.textContent.trim() ?? '';
    add('卡头写明所选时间段', !!rangeLabel && hintText.includes(rangeLabel), rangeLabel + ' | ' + hintText);

    const figure = card.querySelector('.overtime-figure strong');
    const figureText = figure ? figure.textContent.trim() : '';
    const hours = parseFloat(figureText.replace(/,/g, ''));
    // 不断言 > 0：夹具的提交时间是造夹具那一刻，白天跑就是 0 小时。
    // 数值对不对由 heatmap.test.ts 里的具体分钟数把关，这里只管「渲染出来且格式对」。
    add('非上班小时数已渲染', Number.isFinite(hours) && hours >= 0, figureText || 'missing');
    add('小时数是一位小数', /^[\\d,]+\\.\\d$/.test(figureText), figureText);
    add('大数字用等宽数字', !!figure && getComputedStyle(figure).fontVariantNumeric.indexOf('tabular-nums') >= 0, figure ? getComputedStyle(figure).fontVariantNumeric : '-');
    if (hours === 0) {
      add('零值收敛到灰', figure.dataset.zero === 'true' && getComputedStyle(figure).color === getComputedStyle(card.querySelector('.heatmap-card-hint')).color, figure.dataset.zero + '/' + getComputedStyle(figure).color);
    }

    const meta = card.querySelector('.overtime-figure p');
    const metaText = meta ? meta.textContent.replace(/\\s+/g, ' ').trim() : '';
    add('有折合工作日', /折合 \\d+\\.\\d 个 \\d+ 小时工作日/.test(metaText), metaText);
    add('有涉及天数', /涉及 \\d+ 天/.test(metaText), metaText);
    // 「模型总工时」是内部叫法，界面上得写成人能读懂的「推算投入」
    add('有推算投入', /推算投入 [\\d,]+\\.\\d 小时/.test(metaText), metaText);

    const segs = [...card.querySelectorAll('.overtime-bar span')];
    add('构成条分四段', segs.length === 4, segs.length);
    const shares = segs.map((s) => parseFloat(s.style.width) || 0);
    const shareSum = shares.reduce((a, b) => a + b, 0);
    // 要么整条全空（底色由 .overtime-bar 自己给），要么正好铺满——别在条尾留缝。
    // 这里不拿大数字判「空」：小时数只保留一位小数，2 分钟会显示成 0.0 但条上还有宽度。
    const shareOk = shareSum === 0 || Math.abs(shareSum - 100) <= 0.5;
    add('构成条铺满或全空', shareOk, shares.map((v) => v.toFixed(1)).join('+') + '=' + shareSum.toFixed(1));

    const legends = [...card.querySelectorAll('.overtime-legend li')];
    add('图例四条', legends.length === 4, legends.map((l) => l.textContent.trim()).join('/'));
    const legendHours = legends.map((l) => {
      const value = l.querySelector('b');
      return value ? parseFloat(value.textContent.replace(/,/g, '')) : 0;
    });
    const legendSum = legendHours.reduce((a, b) => a + b, 0);
    // 构成条必须能加回大数字，否则就是两根各说各话的柱子
    add('四段之和等于大数字', Math.abs(legendSum - hours) <= 1, legendSum.toFixed(1) + ' vs ' + hours.toFixed(1));

    const note = card.querySelector('.overtime-note');
    const noteText = note ? note.textContent.replace(/\\s+/g, '') : '';
    add('注脚写明推算口径', noteText.includes('90分钟') && noteText.includes('30分钟准备'), note ? note.textContent.trim().slice(0, 56) : 'missing');
    // 节假日与调休是明确的非目标（见 HANDOFF §14.6）。这句免责不是装饰：
    // 少了它就没人知道白天提交在节假日里是怎么算的，容易被当成考勤数字使用。
    add('注脚声明不含节假日与调休', noteText.includes('不含法定节假日与调休'), note ? note.textContent.trim().slice(-30) : 'missing');

    // 构成条要正好填满内容宽度：多 1px 会顶破圆角，少 1px 会在尾巴上留缝
    // 卡片的 rect 含 1px 边框，不减掉的话「正好」永远差 1px，容差就形同虚设
    const cardBox = card.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    const contentRight = cardBox.right - parseFloat(cardStyle.paddingRight) - parseFloat(cardStyle.borderRightWidth);
    const barBox = card.querySelector('.overtime-bar').getBoundingClientRect();
    add('构成条正好填满内容宽度', Math.abs(barBox.right - contentRight) <= 0.5, barBox.right.toFixed(1) + ' vs ' + contentRight.toFixed(1));
  }

  // 读不到目录和「还没提交」是两件事，坏路径必须单独出声；而且要说出原因，
  // 「读不到」读者无法判断是自己配错了路径还是权限问题
  const warn = document.querySelector('.freshness-warning');
  add('读不到的仓库单列', warn === null || /个仓库读取失败/.test(warn.textContent), warn ? warn.textContent.replace(/\\s+/g, ' ').trim().slice(0, 48) : '无失败仓库');
  add('失败原因写在行内', warn === null || /目录不可访问|不是 Git 仓库/.test(warn.textContent), warn ? warn.textContent.replace(/\\s+/g, ' ').trim().slice(-22) : '-');
`,
);


// 提交数只说明「提交了几次」。同一个数字既可能是 271 次批量提交，也可能是一次改了一个错别字，
// 所以这一屏还得给出「写了多少行」——而且要让人看得出哪些是生成文件被剔除掉的。
await runGroup(
  '数据分析页-代码量',
  `
  const card = document.querySelector('.volume-card');
  add('代码量卡存在', !!card, card ? 'ok' : 'missing');
  if (card) {
    const h3 = card.querySelector('h3');
    add('卡片标题为代码量', !!h3 && h3.textContent.includes('代码量'), h3 ? h3.textContent.trim() : 'missing');
    add('代码量标题带图标', !!(h3 && h3.querySelector('svg')), h3 && h3.querySelector('svg') ? 'svg' : 'missing');

    const hint = card.querySelector('.heatmap-card-hint');
    const hintText = hint ? hint.textContent.trim() : '';
    add('卡头写明所选时间段', !!document.querySelector('.range-switch button.active') && hintText.includes(document.querySelector('.range-switch button.active').textContent.trim()), hintText);
    // 这个数是剔掉生成文件之后的。不写在卡头，157 万行会被当成原始 diff 规模。
    add('卡头写明已剔除生成文件', hintText.includes('剔除'), hintText);

    // 「157.2 万」这种显示要能还原成行数：万 / 亿 各差 4 / 8 个数量级
    const parseLines = (text) => {
      const clean = String(text).split(',').join('').split(' ').join('');
      const unit = clean.indexOf('亿') >= 0 ? 1e8 : clean.indexOf('万') >= 0 ? 1e4 : 1;
      return parseFloat(clean) * unit;
    };

    const figure = card.querySelector('.volume-figure strong');
    const figureText = figure ? figure.textContent.trim() : '';
    const total = parseLines(figureText);
    // 不断言 > 0：具体行数由 code-volume.test.ts 把关，这里只管渲染与自洽
    add('代码量已渲染', Number.isFinite(total) && total >= 0, figureText || 'missing');
    add('大数字用等宽数字', !!figure && getComputedStyle(figure).fontVariantNumeric.indexOf('tabular-nums') >= 0, figure ? getComputedStyle(figure).fontVariantNumeric : '-');
    if (total === 0) add('零值收敛到灰', figure.dataset.zero === 'true', figure.dataset.zero);

    const meta = card.querySelector('.volume-figure p');
    const metaText = meta ? meta.textContent.trim() : '';
    add('副标题有增删拆分', metaText.indexOf('+') >= 0 && metaText.indexOf('\u2212') >= 0, metaText);
    add('副标题有文件次', metaText.indexOf('文件次') >= 0, metaText);

    const bar = card.querySelector('.volume-bar');
    const barStyle = getComputedStyle(bar);
    const rectangles = [...bar.querySelectorAll('rect')];
    add('构成条使用 SVG', bar.tagName.toLowerCase() === 'svg', bar.tagName);
    add('构成条不使用渐变', barStyle.backgroundImage === 'none', barStyle.backgroundImage);
    add('构成条共用圆角裁切', barStyle.overflow === 'hidden' && barStyle.borderRadius === '5px', barStyle.overflow + '/' + barStyle.borderRadius);
    add('交界使用清晰像素边缘', bar.getAttribute('shape-rendering') === 'crispEdges', bar.getAttribute('shape-rendering'));
    if (total === 0) {
      add('空条不绘制增删色块', rectangles.length === 0, rectangles.length);
      add('空条保留底色语义', bar.dataset.empty === 'true', String(bar.dataset.empty));
    } else {
      const deletions = bar.querySelector('rect[data-part="deletions"]');
      const additions = bar.querySelector('rect[data-part="additions"]');
      add('红色轨道与绿色覆盖层存在', rectangles.length === 2 && !!deletions && !!additions, rectangles.length);
      if (deletions && additions) {
        const redBox = deletions.getBoundingClientRect();
        const greenBox = additions.getBoundingClientRect();
        const trackBox = bar.getBoundingClientRect();
        add('增删上下边缘一致', greenBox.top === redBox.top && greenBox.bottom === redBox.bottom, greenBox.top + '/' + greenBox.bottom + ' vs ' + redBox.top + '/' + redBox.bottom);
        add('增删高度等于轨道高度', greenBox.height === trackBox.height && redBox.height === trackBox.height, greenBox.height + '/' + redBox.height + '/' + trackBox.height);
        add('红色铺满轨道', deletions.getAttribute('width') === '100%', deletions.getAttribute('width'));
        const cut = parseFloat(additions.getAttribute('width'));
        add('新增比例落在有效范围', cut >= 0 && cut <= 100, cut);
        add('新增和删除颜色不同', getComputedStyle(additions).fill !== getComputedStyle(deletions).fill, getComputedStyle(additions).fill + ' vs ' + getComputedStyle(deletions).fill);
        const chip = card.querySelector('.volume-legend i[data-part="deletions"]');
        add('删除图例色块与条同色', !!chip && getComputedStyle(chip).backgroundColor === getComputedStyle(deletions).fill, chip ? getComputedStyle(chip).backgroundColor : 'missing');
      }
    }

    const legendValues = [...card.querySelectorAll('.volume-legend li b')];
    add('图例两条', legendValues.length === 2, legendValues.length);
    const legendTotal = legendValues.reduce((sum, b) => sum + parseLines(b.textContent), 0);
    // 万 位显示只留一位小数，因此容差取「1% 或 2000 行」中的较大者
    const tolerance = Math.max(2000, total * 0.01);
    add('两段之和等于大数字', Math.abs(legendTotal - total) <= tolerance, Math.round(legendTotal) + ' vs ' + Math.round(total));

    const legend = card.querySelector('.volume-legend');
    const legendText = legend ? legend.textContent.split(String.fromCharCode(10)).join(' ') : '';
    // 要么报了剔除数，要么明确说没有生成文件；「无需剔除」是判断句，不是事实句，已经改掉
    add('图例交代剔除数量', legendText.indexOf('剔除') >= 0 || legendText.indexOf('无生成文件') >= 0, legendText.trim().slice(0, 48));

    const note = card.querySelector('.volume-note');
    const noteText = note ? note.textContent.split(' ').join('') : '';
    add('注脚写明剔除口径', noteText.indexOf('锁文件') >= 0 && noteText.indexOf('二进制') >= 0, noteText.slice(0, 52));
    // 「文件次」是个生造的单位，必须在注脚里定义一次，否则没人知道它按什么计
    add('注脚定义文件次', noteText.indexOf('文件次按提交计次') >= 0, noteText.slice(-24));

    // 构成条要正好填满内容宽度：多 1px 顶破圆角，少 1px 尾巴留缝
    // 卡片的 rect 含 1px 边框，不减掉的话「正好」永远差 1px，容差就形同虚设
    const cardBox = card.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    const contentRight = cardBox.right - parseFloat(cardStyle.paddingRight) - parseFloat(cardStyle.borderRightWidth);
    const barBox = card.querySelector('.volume-bar').getBoundingClientRect();
    add('代码量条正好填满内容宽度', Math.abs(barBox.right - contentRight) <= 0.5, barBox.right.toFixed(1) + ' vs ' + contentRight.toFixed(1));
  }
`,
);

// 排行度量切换：切到「增删行」后，两张排行卡必须一起换、说明文字跟着换、值列不能换行。
const commitModeValues = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.heatmap-ranking .ranking-value')].map((v) => v.textContent.trim()))`));
// 排行度量切换：现在是页面级唯一开关，切到「增删行」后两张卡必须一起换、
// 说明文字跟着换、值列不能换行，而且**不该重新请求**——它只是换个方式排同一批提交。
const apiCallsBefore = await ev(`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/analytics')).length`);
const switched = await ev(`(() => {
  const button = document.querySelector('.metric-switch button[data-metric="volume"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
await sleep(600);
await runGroup(
  '数据分析页-排行切换',
  `
  add('切到代码量', ${switched}, ${JSON.stringify(switched)});
  const switches = [...document.querySelectorAll('.metric-switch')];
  // 以前两张卡各带一个开关，看着能分别设置，实际绑同一个状态——现在只留一组。
  add('页面上只有一组度量开关', switches.length === 1, switches.length);
  add('度量开关在页面工具栏里', switches.length === 1 && !!switches[0].closest('.range-toolbar'), switches.length && switches[0].closest('.range-toolbar') ? 'toolbar' : 'elsewhere');
  add('两张卡不再各自带开关', document.querySelectorAll('.heatmap-ranking .ranking-switch').length === 0, document.querySelectorAll('.heatmap-ranking .ranking-switch').length);
  add('切换有两个选项', switches.length === 1 && switches[0].querySelectorAll('button').length === 2, switches.map((s) => s.querySelectorAll('button').length).join('/'));
  const actives = switches.map((s) => { const b = s.querySelector('button.active'); return b ? b.dataset.metric : 'none'; });
  add('切换后选中增删行', actives.length === 1 && actives[0] === 'volume', actives.join('/'));
  const pressed = switches.map((s) => [...s.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.metric).join(','));
  add('aria-pressed 只有一个为真', pressed.length === 1 && pressed[0] === 'volume', pressed.join('/'));
  // 只有一组开关就不可能出现「仓库按代码量、作者按提交数」并排——顺手把它盯住
  const cardMetrics = [...document.querySelectorAll('.heatmap-ranking')].map((card) => card.querySelector('.ranking-item')?.dataset?.metric ?? 'none');
  add('两张卡同时换成增删行', cardMetrics.length === 2 && cardMetrics.every((m) => m === 'volume'), cardMetrics.join('/'));
  add('切度量不重新请求', performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/analytics')).length === ${apiCallsBefore}, '切换前 ${apiCallsBefore} 次');

  const hints = [...document.querySelectorAll('.ranking-hint')].map((h) => h.textContent.trim());
  const rangeText = document.querySelector('.range-switch button.active')?.textContent.trim() ?? '';
  add('度量说明写明所选时间段', hints.length === 2 && !!rangeText && hints.every((h) => h.includes(rangeText)), hints.join(' | '));

  const values = [...document.querySelectorAll('.heatmap-ranking .ranking-value')];
  const texts = values.map((v) => v.textContent.trim());
  // 夹具仓库只有几十行，套不进「万」，所以不要求单位，只要求数字真的换了
  const before = ${JSON.stringify(commitModeValues)};
  const changed = texts.slice(0, before.length).some((t, i) => t !== before[i]);
  add('值列换成行数', changed, '提交数 ' + before.slice(0, 3).join(',') + ' → 行数 ' + texts.slice(0, 3).join(','));
  const overflowing = values.filter((v) => v.scrollWidth > v.clientWidth + 1);
  add('值列没有溢出截断', overflowing.length === 0, overflowing.length + ' 个溢出（列宽 72px）');
  const rowHeights = [...document.querySelectorAll('.heatmap-ranking .ranking-item')].map((row) => Math.round(row.getBoundingClientRect().height));
  add('排行行高没有被值列顶开', new Set(rowHeights).size === 1, rowHeights.slice(0, 5).join('/'));
`,
);

// 切回去，不留一个「代码量」状态给后面的窄屏截图
const switchedBack = await ev(`(() => {
  const button = document.querySelector('.metric-switch button[data-metric="commits"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
await sleep(400);
await runGroup(
  '数据分析页-排行切换还原',
  `
  add('切回提交数', ${switchedBack}, ${JSON.stringify(switchedBack)});
  const actives = [...document.querySelectorAll('.metric-switch')].map((s) => { const b = s.querySelector('button.active'); return b ? b.dataset.metric : 'none'; });
  add('回到提交数', actives.length === 1 && actives[0] === 'commits', actives.join('/'));
  const cardMetrics = [...document.querySelectorAll('.heatmap-ranking')].map((card) => card.querySelector('.ranking-item')?.dataset?.metric ?? 'none');
  add('两张卡都回到提交数', cardMetrics.length === 2 && cardMetrics.every((m) => m === 'commits'), cardMetrics.join('/'));
  const texts = [...document.querySelectorAll('.heatmap-ranking .ranking-value')].map((v) => v.textContent.trim());
  const allNumeric = texts.length > 0 && texts.every((t) => !Number.isNaN(Number(t.split(',').join(''))));
  add('值列是提交数', allNumeric, texts.slice(0, 4).join(','));
  const hints = [...document.querySelectorAll('.ranking-hint')].map((h) => h.textContent.trim());
  const rangeText = document.querySelector('.range-switch button.active')?.textContent.trim() ?? '';
  add('度量说明仍写明所选时间段', !!rangeText && hints.every((h) => h.includes(rangeText)), hints.join(' | '));
  // 提交数排的是非合并提交，这一点以前只在代码里，界面上从未说过
  add('度量说明写明排除合并提交', hints.every((h) => h.includes('非合并')), hints.join(' | '));
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
    const bottomH3 = box('.ranking-header h3');
    if (topH3 && bottomH3) {
      add('两排标题左边缘对齐', Math.abs(topH3.left - bottomH3.left) <= 1, topH3.left.toFixed(1) + ' vs ' + bottomH3.left.toFixed(1));
    } else {
      add('两排标题左边缘对齐', false, '找不到标题');
    }

    // 中间那排（非上班时间 + 代码量）也得落在同一条竖线上：
    // 它夹在两排之间，边界差一点上下就各说各话。
    const investCards = [...document.querySelectorAll('.heatmap-investment > .heatmap-card')].map((c) => c.getBoundingClientRect());
    add('投入排两张卡', investCards.length === 2, investCards.length);
    if (investCards.length === 2) {
      const [investL, investR] = investCards;
      const investGap = (investL.right + investR.left) / 2;
      add('投入排分栏与上下同线', Math.abs(investGap - topGap) <= 1, investGap.toFixed(1) + ' vs 上 ' + topGap.toFixed(1));
      add('投入排左边缘对齐', Math.abs(investL.left - topL.left) <= 1, investL.left.toFixed(1) + ' vs ' + topL.left.toFixed(1));
      add('投入排右边缘对齐', Math.abs(investR.right - topR.right) <= 1, investR.right.toFixed(1) + ' vs ' + topR.right.toFixed(1));
      // 投入排在「提交时段 / 仓库活跃度」上面，所以量它到下一排顶部的距离
      add('投入排与上下同高间距', Math.abs(topL.top - (investL.top + investL.height) - topGapWidth) <= 2, (topL.top - (investL.top + investL.height)).toFixed(1) + ' vs ' + topGapWidth.toFixed(1));
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
      const invest = [...document.querySelectorAll('.heatmap-investment > .heatmap-card')].map((c) => c.getBoundingClientRect());
      if (invest.length === 2) {
        const investEdge = (invest[0].right + invest[1].left) / 2;
        add('${width} 投入排边界同线', Math.abs(investEdge - topEdge) <= 0.5, '投入 ' + investEdge.toFixed(1) + ' vs 上 ' + topEdge.toFixed(1));
      } else add('${width} 投入排边界同线', false, invest.length + ' 张卡');
    }
`,
  );
}

console.log('== 阶段 5d：换周期后的体量 ==');
/**
 * 换时间段不该改变卡片的体量。
 *
 * 这一组盯的是「点一下按钮整页抖一下」：早先短窗口把格子放大到 26px，近 3 个月
 * 的卡片长到 265px 高，切回近两年只剩 102px，下面的统计卡被迫上下位移；同时
 * 图例留在卡片最右边，短窗口时离图一千多像素，两个元素看不出关系。
 *
 * 固定在 1440 量：这是默认窗口，也是「铺满」与「还没铺满」的分界附近；
 * 1920 上近一年本来就会把格子放到 26px 去填满，卡片更高是预期的。
 */
await setViewport(1440, 900);
await sleep(900);
const resizeBodies = [];
for (const [weeks, label] of [[13, '近 3 个月'], [26, '近 6 个月'], [52, '近一年'], [104, '近两年']]) {
  await ev(`(() => { const b = document.querySelector('.range-switch button[data-weeks="${weeks}"]'); if (b) b.click(); return !!b; })()`);
  for (let i = 0; i < 60; i += 1) {
    const settled = await ev(`(() => { const s = document.querySelector('.heatmap-subtitle'); return !!s && s.textContent.indexOf(${JSON.stringify(label)}) === 0; })()`);
    if (settled) break;
    await sleep(200);
  }
  await sleep(400);
  resizeBodies.push(await ev(`(() => {
    const card = document.querySelector('.heatmap-section');
    const svg = document.querySelector('.heatmap-svg');
    const vp = document.querySelector('.heatmap-viewport');
    const cell = document.querySelector('.heatmap-cell');
    const legend = document.querySelector('.heatmap-legend');
    if (!card || !svg || !cell) return null;
    const cr = card.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const lastLegend = legend && legend.lastElementChild ? legend.lastElementChild.getBoundingClientRect() : null;
    return {
      weeks: ${weeks},
      cardH: Math.round(cr.height),
      svgW: Math.round(sr.width),
      cellPx: +cell.getBoundingClientRect().width.toFixed(1),
      legendRight: lastLegend ? +lastLegend.right.toFixed(1) : null,
      svgRight: +sr.right.toFixed(1),
      scrolls: vp ? vp.scrollWidth > vp.clientWidth + 1 : false,
    };
  })()`));
}
await runGroup(
  '数据分析页-换周期体量',
  `
  const bodies = ${JSON.stringify(resizeBodies)};
  add('四个预设都量到了', bodies.length === 4 && bodies.every(Boolean), bodies.map((b) => (b ? b.cardH : 'x')).join('/'));
  const by = {};
  for (const b of bodies) if (b) by[b.weeks] = b;
  if (by[13] && by[26] && by[52] && by[104]) {
    // 近两年为了塞下 104 列必须把格子压到 10px，高度必然更矮，不参与这条比较。
    const heights = [by[13].cardH, by[26].cardH, by[52].cardH];
    add('短窗口到近一年卡片高度不抖', Math.max(...heights) - Math.min(...heights) <= 24, heights.join('/'));
    add('短窗口格子没放大到 20px 以上', by[13].cellPx <= 19 && by[26].cellPx <= 19, by[13].cellPx + '/' + by[26].cellPx);
    add('近一年铺满卡片宽度', by[52].svgW >= 1300, by[52].svgW);
    add('近两年格子仍分得清色阶', by[104].cellPx >= 9, by[104].cellPx);
    const gaps = bodies.filter((b) => b && !b.scrolls).map((b) => +(b.legendRight - b.svgRight).toFixed(1));
    add('图例贴着图的右端', gaps.length > 0 && gaps.every((g) => Math.abs(g) <= 3), gaps.join('/'));
  }
`,
);
// 后面的键盘阶段按「近一年」写断言，回到 52 周
await ev(`(() => { const b = document.querySelector('.range-switch button[data-weeks="52"]'); if (b) b.click(); return !!b; })()`);
for (let i = 0; i < 60; i += 1) {
  const settled = await ev(`(() => { const s = document.querySelector('.heatmap-subtitle'); return !!s && s.textContent.indexOf('近一年') === 0; })()`);
  if (settled) break;
  await sleep(200);
}
await sleep(400);

console.log('== 阶段 5c：热力图键盘可达性 ==');
await setViewport(1440, 950);
await sleep(900);
await parkPointer();
await sleep(200);

// 735 个格子逐个进 Tab 序列比只能用鼠标更糟，所以只有整张图一个 Tab 站点。
const focusTarget = await ev(`(() => {
  const svg = document.querySelector('.heatmap-svg');
  if (!svg) return 'no-svg';
  svg.focus();
  return document.activeElement === svg ? 'svg' : (document.activeElement?.tagName ?? 'none');
})()`);
await sleep(350);
await runGroup(
  '热力图键盘',
  `
  add('整张图是一个 Tab 站点', ${JSON.stringify(focusTarget)} === 'svg', ${JSON.stringify(focusTarget)});
  const cells = [...document.querySelectorAll('.heatmap-cell')];
  const tabbable = cells.filter((c) => c.hasAttribute('tabindex'));
  add('格子本身不进 Tab 序列', tabbable.length === 0, tabbable.length + '/' + cells.length);
  const marked = [...document.querySelectorAll('.heatmap-cell.is-keyboard-focused')];
  add('聚焦后高亮恰好一格', marked.length === 1, marked.length + ' 格');
  add('高亮格用 2px 焦点描边', marked.length === 1 && getComputedStyle(marked[0]).strokeWidth === '2px', marked.length ? getComputedStyle(marked[0]).strokeWidth + ' / ' + getComputedStyle(marked[0]).stroke : '-');
  const tip = document.querySelector('.heatmap-tooltip');
  add('聚焦时显示当天提示', !!tip && /\\d{4}-\\d{2}-\\d{2}/.test(tip.textContent), tip ? tip.textContent.trim().slice(0, 26) : 'missing');
  const svg = document.querySelector('.heatmap-svg');
  add('整图写明可用方向键', (svg?.getAttribute('aria-label') ?? '').includes('方向键'), svg?.getAttribute('aria-label')?.slice(0, 36) ?? '-');
  add('读屏播报区存在', !!document.querySelector('.heatmap-svg + .sr-only, section .sr-only[aria-live]'), document.querySelector('.sr-only[aria-live]')?.textContent?.trim().slice(0, 26) ?? 'missing');
`,
);

const dateAtCursor = () =>
  ev(`document.querySelector('.heatmap-cell.is-keyboard-focused')?.dataset.date ?? ''`);
const dayGap = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

const cursorStart = await dateAtCursor();
await pressKey('ArrowLeft', 'ArrowLeft', 37);
await sleep(280);
const afterLeft = await dateAtCursor();
await pressKey('ArrowUp', 'ArrowUp', 38);
await sleep(280);
const afterUp = await dateAtCursor();
await pressKey('Home', 'Home', 36);
await sleep(280);
const afterHome = await dateAtCursor();
const scrollBefore = await ev('window.scrollY');
await pressKey('ArrowLeft', 'ArrowLeft', 37);
await sleep(280);
const afterEdge = await dateAtCursor();
const scrollAfter = await ev('window.scrollY');

record('热力图键盘', [
  { n: '左方向键退一周同一天', ok: dayGap(afterLeft, cursorStart) === 7, d: `${cursorStart} -> ${afterLeft}` },
  { n: '上方向键退一天', ok: dayGap(afterUp, afterLeft) === 1, d: `${afterLeft} -> ${afterUp}` },
  { n: 'Home 跳到第一周', ok: afterHome !== '' && afterHome < cursorStart, d: `${afterUp} -> ${afterHome}` },
  { n: '首列再按左不动且页面不滚', ok: afterEdge === afterHome && scrollAfter === scrollBefore, d: `${afterEdge}，scrollY ${scrollBefore} -> ${scrollAfter}` },
]);

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

  // 1024 下「投入」排同样要各占一行：并排时每张只剩 480，代码量卡里
  // 「+107.6 万 / −49.6 万 · 28,479 文件次」会折成三行，和左边的大数字错开。
  const investInset = [...document.querySelectorAll('.heatmap-investment > .heatmap-card')].map((c) => Math.round(c.getBoundingClientRect().width));
  add('1024 下投入排转单列', investInset.length === 2 && new Set(investInset).size === 1, investInset.join('/'));

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
