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

// 真实按下 → 移动 → 松开。拖动中的 mouseMoved 必须带 buttons:1，
// 否则页面收到的只是「指针路过」，不会产生按住拖拽的语义。
const dragPointer = async (from, to, steps = 8) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
};

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

console.log('== 阶段 1b：批量结果的落点 ==');
// 真机点一次批量 Fetch。这条链路以前会在右下角浮一张卡片：盖在内容上、自带倒计时、
// 关掉抽屉才看得见。现在结论只写在抽屉的批次卡里 —— 页面级不该再出现任何浮层。
await parkPointer();
const batchClicked = await ev(`(() => { const b = document.querySelector('.batch-action-button'); if (!b) return false; b.click(); return true; })()`);
let batchResultText = '';
for (let i = 0; i < 100 && batchClicked; i += 1) {
  await sleep(250);
  batchResultText = await ev(`(document.querySelector('.batch-result')?.textContent ?? '').trim()`);
  if (batchResultText) break;
}
await sleep(400);
await runGroup(
  '批量结果落点',
  `
  const card = document.querySelector('.batch-card');
  const result = document.querySelector('.batch-result');
  add('结论写在批次卡里', !!result && result.closest('.batch-card') === card, result ? (result.textContent || '').trim() : 'missing');
  // 浮层不是「变小了」，是「没有了」：这是这次重做唯一必须成立的一条。
  add('页面上没有浮层通知', !document.querySelector('.global-toast'), document.querySelector('.global-toast') ? '仍然存在' : 'none');
  // 只查 class 会漏掉改名的浮层，所以再按「fixed 定位 + aria-live」把整页扫一遍。
  const floating = [...document.querySelectorAll('[aria-live]')]
    .filter((el) => getComputedStyle(el).position === 'fixed');
  add('也没有 fixed 定位的提示元素', floating.length === 0, floating.map((el) => el.className).join(' / ') || '0 个');
  if (result) {
    const text = result.textContent.trim();
    add('一次干净的批量不念零值', !/(^|[^0-9])0 (跳过|失败)/.test(text), text);
    add('结论一句话读完', text.length <= 40, text.length + ' 字：' + text);
  }
`,
);
// 不自己消失：旧实现 4.2 秒后自行退场，这里等过那个点，确认它还在。
// 只比「还在」不比全等——完成语会在紧接着的一次 refetch 后补上「N 个有远端新提交」，
// 那是同一句话变得更完整，不是换了一条新提示。
await sleep(5000);
const batchResultAfter = await ev(`(document.querySelector('.batch-result')?.textContent ?? '').trim()`);
record('批量结果落点', [
  { n: '结论不会自己消失', ok: /完成/.test(batchResultAfter) && batchResultAfter.startsWith(batchResultText), d: batchResultAfter || '已消失' },
]);
// 关掉抽屉：旧实现里全局提示会在抽屉关掉的瞬间补弹一次，现在这条路径整个不存在。
await pressEsc();
await sleep(900);
await runGroup(
  '批量结果落点',
  `
  const strip = document.querySelector('.fleet-feedback');
  add('关掉抽屉后不补弹提示', !document.querySelector('.global-toast'), document.querySelector('.global-toast') ? '补弹了' : 'none');
  add('舰队页也没有挂上一条 FETCH 提示', !/FETCH/i.test(strip ? strip.textContent : ''), strip ? strip.textContent.trim() : 'no strip');
`,
);

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

console.log('== 阶段 2b：状态行的落点 ==');
// 反馈只有一种形态：落在触发它的那块面板里的一条贴边细行。
// 保存个人配置会产生一条消息，正好能看它先在弹窗里、关掉弹窗后换成舰队页那一条。
// 改一个字段让保存可点，验完再改回去——验证过程的显示名不该留在夹具里。
await ev(`document.querySelector('.profile-chip')?.click()`);
await sleep(1200);
await ev(`(() => { const n = [...document.querySelectorAll('.manage-nav-item')].find((b) => b.textContent.includes('个人信息')); if (n) n.click(); return !!n; })()`);
await sleep(600);
const originalDisplayName = await ev(`(document.querySelector('.manage-section input[data-dialog-initial]')?.value ?? '')`);
const verifyDisplayName = originalDisplayName ? `${originalDisplayName} verify` : 'Moo Verify';
await ev(`(() => {
  const el = document.querySelector('.manage-section input[data-dialog-initial]');
  if (!el) return false;
  el.value = ${JSON.stringify(verifyDisplayName)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
const profileSaved = await ev(`(() => {
  const b = [...document.querySelectorAll('.setup-footer-buttons button')].find((n) => n.textContent.includes('保存个人配置'));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
let setupStripText = '';
for (let i = 0; i < 40 && profileSaved; i += 1) {
  await sleep(200);
  setupStripText = await ev(`(document.querySelector('.setup-feedback')?.textContent ?? '').trim()`);
  if (setupStripText) break;
}
await sleep(300);
await shot('03b-settings-feedback.png');
await runGroup(
  '状态行-设置弹窗',
  `
  const modal = document.querySelector('.setup-modal.manage-modal');
  const strip = document.querySelector('.surface-feedback.setup-feedback');
  const footer = document.querySelector('.setup-footer');
  const expected = ${JSON.stringify(setupStripText)};
  add('保存后弹窗内出现一条状态行', !!strip, strip ? strip.textContent.trim() : 'missing');
  add('这条状态行说的就是刚才那次保存', expected.includes('个人配置已保存'), expected || '无文案');
  if (strip && modal) {
    const r = strip.getBoundingClientRect();
    const cs = getComputedStyle(strip);
    add('状态行占满弹窗宽度', Math.abs(r.width - modal.getBoundingClientRect().width) <= 2, Math.round(r.width) + ' vs ' + Math.round(modal.getBoundingClientRect().width));
    // 卡片与行为的区别就在这三点：圆角、阴影、留白。有一条没掉，它就还是浮层。
    add('不是卡片：无圆角无阴影', parseFloat(cs.borderTopLeftRadius) === 0 && cs.boxShadow === 'none', 'radius ' + cs.borderTopLeftRadius + ' / shadow ' + cs.boxShadow);
    add('不是卡片：无渐变底色', cs.backgroundImage === 'none', cs.backgroundImage.slice(0, 40));
    add('高度只有一条（≤ 40）', r.height <= 40, Math.round(r.height) + 'px');
    add('落在页脚之上，不盖住按钮', footer ? r.bottom <= footer.getBoundingClientRect().top + 1 : false, footer ? Math.round(r.bottom) + ' vs footer ' + Math.round(footer.getBoundingClientRect().top) : 'no footer');
    add('成功用 polite 播报', strip.getAttribute('role') === 'status' && strip.getAttribute('aria-live') === 'polite', strip.getAttribute('role') + '/' + strip.getAttribute('aria-live'));
    add('正文不整行染绿', cs.color !== getComputedStyle(strip.querySelector('svg')).color, cs.color + ' / icon ' + getComputedStyle(strip.querySelector('svg')).color);
  }
`,
);

// 把显示名改回去：验证只借用这个字段，不留下痕迹。
await ev(`(() => {
  const el = document.querySelector('.manage-section input[data-dialog-initial]');
  if (!el) return false;
  el.value = ${JSON.stringify(originalDisplayName)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await ev(`(() => {
  const b = [...document.querySelectorAll('.setup-footer-buttons button')].find((n) => n.textContent.includes('保存个人配置'));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
await sleep(900);

// 关掉弹窗时会把这条反馈清掉：它已经在本页原位展示过，再换到舰队页说一遍等于说两次。
await pressEsc();
await sleep(900);
await runGroup(
  '状态行-设置弹窗',
  `
  const strip = document.querySelector('.surface-feedback.setup-feedback');
  add('关掉弹窗后不把同一句话搬到舰队页', !document.querySelector('.surface-feedback.fleet-feedback'), strip ? '弹窗里还有' : '已随弹窗一起清掉');
`,
);

// 舰队页那条状态行：用一次被安全条件挡下的批量 Push 触发。
// 它不需要改任何数据，产生的是 warning 级消息，正好也验一遍警告的语气与图标。
console.log('== 阶段 2c：舰队页状态行 ==');
await ev(`(async () => {
  const head = document.querySelector('.repo-table thead input[type="checkbox"]');
  if (head && head.checked) head.click();
  const input = document.querySelector('.search-field input');
  if (input) {
    input.value = 'acme-web';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
await sleep(1200);
const pushBlocked = await ev(`(() => {
  const b = [...document.querySelectorAll('.batch-action-button')].find((n) => n.textContent.includes('Push'));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
await sleep(700);
await shot('03c-fleet-feedback.png');
await runGroup(
  '状态行-舰队页',
  `
  const panel = document.querySelector('.fleet-panel');
  const toolbar = document.querySelector('.fleet-toolbar');
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  add('被挡下的批量给出一条状态行', !!strip, strip ? strip.textContent.trim() : 'missing');
  if (strip && panel) {
    const r = strip.getBoundingClientRect();
    const cs = getComputedStyle(strip);
    const pr = panel.getBoundingClientRect();
    add('状态行在舰队面板之内', !!strip.closest('.fleet-panel'), strip.closest('.fleet-panel') ? 'yes' : 'no');
    add('紧接工具栏，就在操作按钮下面', toolbar ? strip.previousElementSibling === toolbar : false, toolbar ? (strip.previousElementSibling ? strip.previousElementSibling.className : 'none') : 'no toolbar');
    add('占满面板宽度，不是角落小卡', Math.abs(r.width - (pr.width - 2)) <= 2, Math.round(r.width) + ' vs ' + Math.round(pr.width - 2));
    add('不是卡片：无圆角无阴影', parseFloat(cs.borderTopLeftRadius) === 0 && cs.boxShadow === 'none', 'radius ' + cs.borderTopLeftRadius + ' / shadow ' + cs.boxShadow);
    add('不是浮层：没有脱离文档流', cs.position === 'static' || cs.position === 'relative', cs.position);
    add('高度只有一条（≤ 40）', r.height <= 40, Math.round(r.height) + 'px');
    add('有可点的关闭按钮', !!strip.querySelector('button'));
    add('警告走 warning 语气', strip.classList.contains('warning'), strip.className);
    add('图标已表达的点不再用字符重复', !strip.textContent.trim().startsWith('⚠'), strip.textContent.trim().slice(0, 18));
    add('页面级浮层仍然不存在', !document.querySelector('.global-toast'));
  }
`,
);
// 不自己消失：计时消失是「当场必须读到」的压力来源，这次重做把它整条删掉了。
await sleep(5000);
await runGroup(
  '状态行-舰队页',
  `
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  add('消息不会自己消失', !!strip, strip ? '仍在' : '已消失');
`,
);
// 关闭是同步改状态、异步刷视图，所以要分两次量：点完先让 Vue 跑一拍再看。
const fleetDismissClicked = await ev(`(() => {
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  if (!strip) return false;
  strip.querySelector('button').click();
  return true;
})()`);
await sleep(400);
await runGroup(
  '状态行-舰队页',
  `
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  add('点关闭后立刻消失', ${JSON.stringify(fleetDismissClicked)} && !strip, strip ? strip.textContent.trim() : '已关闭');
`,
);
await sleep(300);
// 把筛选清掉，后面的阶段从干净状态开始。
await ev(`(() => {
  const input = document.querySelector('.search-field input');
  if (!input) return false;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(900);
record('状态行-舰队页', [{ n: '批量按钮确实可点（不是被禁用挡掉）', ok: pushBlocked, d: pushBlocked ? '已点击' : '按钮不存在或禁用' }]);

console.log('== 阶段 2d：消息归属 ==');
// 再触发一次被挡下的批量 Push，让舰队页手上握着一条 warning。
await ev(`(async () => {
  const head = document.querySelector('.repo-table thead input[type="checkbox"]');
  if (head && head.checked) head.click();
  const input = document.querySelector('.search-field input');
  if (input) {
    input.value = 'acme-web';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
await sleep(1200);
await ev(`(() => {
  const b = [...document.querySelectorAll('.batch-action-button')].find((n) => n.textContent.includes('Push'));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
await sleep(800);
const ownedText = await ev(`(document.querySelector('.surface-feedback.fleet-feedback')?.textContent ?? '').trim()`);

// 切走：这条消息属于舰队页，换页签不该把它带到会话页去。
await clickText('AI 会话');
await sleep(1000);
await runGroup(
  '消息归属',
  `
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  add('切到别的页签时不渲染舰队页的消息', !strip, strip ? strip.textContent.trim() : 'none');
`,
);
// 切回：它属于这块面板，回来就该还在。旧实现里 switchWorkspace 会 dismissFeedback() 把它清掉，
// 于是用户切一下页签回来就再也看不到刚才那句话——这是「没有归属」的代价。
await clickText('仓库舰队');
await sleep(1200);
await runGroup(
  '消息归属',
  `
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  const text = strip ? strip.textContent.trim() : '';
  add('切回来还在，不需要重新触发一次', ${JSON.stringify(ownedText)} !== '' && text === ${JSON.stringify(ownedText)}, text || '已丢失');
  add('页签上没有多余的未读点', !document.querySelector('.workspace-switcher .unread-dot'), document.querySelectorAll('.workspace-switcher .unread-dot').length + ' 个');
  // 已经看过的消息不该在入口上留点：那个点只代表「还没看过」，不是「这里曾经出过事」。
  add('仓库行上也没有多余的未读点', !document.querySelector('.repo-table .unread-dot'), document.querySelectorAll('.repo-table .unread-dot').length + ' 个');
`,
);
// 把筛选清掉，后面的阶段从干净状态开始。
await ev(`(() => {
  const input = document.querySelector('.search-field input');
  if (!input) return false;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(900);

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
const navToAnalytics = await (async () => {
  // 骨架屏：冷启动全量扫描要十几秒，这期间该看到与真实排版同高低的占位，而不是一片空白。
  // 用 MutationObserver 抓——loading 只存在几帧，轮询不可靠；回调里立刻量一遍
  // getBoundingClientRect（会强制同步布局），拿到的才是骨架自己的尺寸。
  await ev(`(() => {
    window.__skeletonSeen = false;
    window.__skeletonBox = null;
    new MutationObserver(() => {
      const el = document.querySelector('.heatmap-skeleton');
      if (!el || window.__skeletonSeen) return;
      window.__skeletonSeen = true;
      const r = el.getBoundingClientRect();
      const grid = el.querySelector('.skeleton-grid');
      window.__skeletonBox = {
        w: Math.round(r.width),
        h: Math.round(r.height),
        gridH: grid ? Math.round(grid.getBoundingClientRect().height) : 0,
        stats: el.querySelectorAll('.stat-card').length,
      };
    }).observe(document.body, { childList: true, subtree: true });
    return true;
  })()`);
  return clickText('数据分析');
})();
await sleep(2400);
for (let i = 0; i < 40; i += 1) {
  if (await ev(`!!document.querySelector('.heatmap-subtitle')`)) break;
  await sleep(200);
}
await parkPointer();
await sleep(400);
await shot('15-analytics.png');
const skeletonInfo = await ev(`JSON.stringify({ seen: window.__skeletonSeen, box: window.__skeletonBox, gone: !document.querySelector('.heatmap-skeleton') })`);
await runGroup(
  '数据分析页',
  `
  add('切到数据分析页', ${navToAnalytics}, ${JSON.stringify(navToAnalytics)});

  // 加载态：原来只有居中一句转圈，图上该在的位置全是空白。骨架要真的有版面，
  // 而且加载完必须撤掉（留着就成了「永远在加载」的假象）。
  const sk = ${skeletonInfo};
  add('加载时出现骨架屏', sk.seen, sk.seen ? 'yes' : 'no');
  if (sk.seen) {
    add('骨架画出网格与四张统计卡', sk.box.gridH >= 150 && sk.box.stats === 4, (sk.box.gridH || 0) + 'px / ' + (sk.box.stats || 0) + ' 卡');
    add('骨架撑起真实版面高度', sk.box.h >= 250, (sk.box.h || 0) + 'px');
    add('数据到了骨架撤掉', sk.gone, sk.gone ? 'gone' : 'still there');
  }

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

  // 页顶只留真正整页生效的两个口径：时间段、仓库范围。
  // 排行度量只管下面两张卡，摆在页顶时按一下视野里什么都不变，读者会判它没用。
  const toolbar = document.querySelector('.range-toolbar');
  const inToolbar = ['.range-switch', '.analytics-repository-scope']
    .map((selector) => (toolbar ? !!toolbar.querySelector(selector) : false));
  add('工具栏含时间段/仓库范围', inToolbar.every(Boolean), inToolbar.map((ok) => (ok ? '1' : '0')).join(''));
  const rankingToolbar = document.querySelector('.ranking-toolbar');
  const columns = document.querySelector('.heatmap-columns');
  add('度量开关不在页顶工具栏', !!toolbar && !toolbar.querySelector('.metric-switch'), toolbar && toolbar.querySelector('.metric-switch') ? 'inside' : 'outside');
  add('度量开关紧挨两张排行卡', !!rankingToolbar && !!columns && rankingToolbar.nextElementSibling === columns, rankingToolbar && columns ? (rankingToolbar.nextElementSibling === columns ? 'adjacent' : 'apart') : 'missing');
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

  // 卡片底色：整页所有卡片必须是同一档「只比画布亮一点」的面，且比控件/浮层暗。
  // 2026-10-24 之前卡片直接借 --color-surface-raised，dark-modern 下 #2b2b2b 压在
  // #181818 上，整页是一块块亮灰；这条把「卡片 < 浮层」钉在真实渲染上，
  // 谁把卡片底色改回浮层色，这里直接报数。
  const channels = (value) => value.replace(/[^0-9.,]/g, '').split(',').slice(0, 3).map(Number);
  const brightness = (value) => { const [r, g, b] = channels(value); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const cardSections = [...document.querySelectorAll('.heatmap-section, .stat-card, .heatmap-card')];
  const cardColors = [...new Set(cardSections.map((el) => getComputedStyle(el).backgroundColor))];
  add('整页卡片同一种底色', cardSections.length >= 6 && cardColors.length === 1, cardSections.length + ' 块/' + cardColors.length + ' 色');
  const cardLift = brightness(cardColors[0]) - brightness(getComputedStyle(document.body).backgroundColor);
  add('卡片只比画布亮一档', cardLift >= 4 && cardLift <= 16, cardLift.toFixed(1));
  const activeMetric = document.querySelector('.metric-switch button.active');
  const raisedLift = activeMetric ? brightness(getComputedStyle(activeMetric).backgroundColor) - brightness(cardColors[0]) : -1;
  add('卡片比选中态控件暗一档', raisedLift > 0, raisedLift.toFixed(1));

  // 分段控件的选中态：2026-10-25 之前只靠 raised 压 track 的色阶差，五套主题实测
  // 是 1.06–1.32，选中和没按看起来一个样。现在底色抬到 surface-hover、再压一道
  // 1px 内描边。这里同时量两件事，少任何一件都会让「选中」重新变得看不出来：
  // 底色要拉得开，轮廓要真的画出来（有的主题外边线会在渲染时消失）。
  const segThemes = ['fleet-blue', 'mooeen', 'dark-modern', 'monokai', 'dark-high-contrast'];
  const segOriginal = document.documentElement.dataset.theme;
  const segRows = [];
  for (const segTheme of segThemes) {
    document.documentElement.dataset.theme = segTheme;
    const slot = document.querySelector('.metric-switch');
    const segActive = slot && slot.querySelector('button.active');
    if (!slot || !segActive) { segRows.push({ theme: segTheme, lift: -1, outline: false }); continue; }
    const segStyle = getComputedStyle(segActive);
    segRows.push({
      theme: segTheme,
      lift: brightness(segStyle.backgroundColor) - brightness(getComputedStyle(slot).backgroundColor),
      outline: /inset/.test(segStyle.boxShadow),
    });
  }
  document.documentElement.dataset.theme = segOriginal;
  const segWeak = segRows.filter((row) => !(row.lift >= 9));
  add('五套主题选中态都比槽底亮够', segWeak.length === 0, segRows.map((row) => row.theme + ':' + row.lift.toFixed(0)).join(' '));
  const segFlat = segRows.filter((row) => !row.outline);
  add('五套主题选中态都有内描边', segFlat.length === 0, segFlat.length ? '缺：' + segFlat.map((row) => row.theme).join(',') : segRows.length + '/5');

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
  const halfYearBars = document.querySelectorAll('.heatmap-bar').length;
  const halfYearCells = document.querySelectorAll('.heatmap-cell').length;
  // 26 周 = 182 天，但窗口末尾是本周周日：未来那几天不画，条数只能按「起点到今天」算。
  // 写死 180~186 的话，周一 176、周二 177，只有周五之后才过——那不是产品在变，是断言在算命。
  const now = new Date();
  const todayIso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const halfDrawnEnd = todayIso < api.ok.end ? todayIso : api.ok.end;
  const halfDays = Math.round((Date.parse(halfDrawnEnd) - Date.parse(api.ok.start)) / 86400000) + 1;
  const halfLastDate = (() => {
    const slots = [...document.querySelectorAll('.heatmap-bar-hit')];
    return slots.length ? slots[slots.length - 1].dataset.date : '';
  })();
  add('近 6 个月画成日柱', halfYearBars === halfDays && halfYearCells === 0,
    halfYearBars + ' 根 / 应为 ' + halfDays + ' 天，' + halfYearCells + ' 格');
  add('半年日柱也画到今天为止', halfLastDate === halfDrawnEnd, halfLastDate + ' / 应为 ' + halfDrawnEnd);
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

// 仓库范围是多选 + 搜索：「全选」选的是全部选项，搜索只筛列表。筛剩下几条时如果不写
// 总数，用户会以为只选了看得见的那几个。这段直接打开下拉、输入一个不命中的词再看按钮。
console.log('== 阶段 5c：仓库范围多选与搜索 ==');
const scopeMenu = JSON.parse(
  await ev(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const trigger = document.querySelector('.analytics-repository-scope .select-menu-trigger');
  if (!trigger) return JSON.stringify({ error: '找不到仓库范围下拉' });
  trigger.click();
  await wait(200);
  const bulk = document.querySelector('.select-menu-bulk');
  const search = document.querySelector('.select-menu-search input');
  if (!bulk || !search) return JSON.stringify({ error: '下拉里没有多选行或搜索框' });
  const label = () => (bulk.querySelector('button')?.textContent ?? '').trim();
  const counter = bulk.querySelector('span')?.textContent ?? '';
  // 「已选 0 / 54」→ 54；用 split 而不是正则，少一层字符串转义。
  const total = Number((counter.split('/').pop() ?? '').trim());
  const unfiltered = label();
  search.value = 'zzz-not-a-repository';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  const filtered = label();
  const visible = document.querySelectorAll('.select-menu-option').length;
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  const restored = label();
  trigger.click();
  await wait(150);
  // 用 aria-expanded 判开合：离场动画期间 .select-menu-options 还在 DOM 里。
  return JSON.stringify({ unfiltered, filtered, restored, visible, total, closed: trigger.getAttribute('aria-expanded') === 'false' });
})()`),
);
await runGroup(
  '仓库范围多选',
  `
  const menu = ${JSON.stringify(scopeMenu)};
  add('仓库范围下拉可打开', !menu.error && menu.total > 1, menu.error || ('选项 ' + menu.total + ' 个'));
  add('未筛选时按钮就是「全选」', menu.unfiltered === '全选', menu.unfiltered);
  add('筛选后按钮写明全量总数', menu.filtered === '全选（共 ' + menu.total + ' 项）', (menu.filtered || '') + ' / 总数 ' + menu.total);
  add('筛到 0 条时数字仍是全量', menu.visible === 0 && (menu.filtered || '').indexOf('共 ' + menu.total + ' 项') > 0, '可见 ' + menu.visible);
  add('清掉搜索后按钮回到「全选」', menu.restored === '全选', menu.restored);
  add('再点一次收起面板', menu.closed, menu.closed ? 'closed' : 'open');
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

/** 本地时区的今天。别用 `toISOString()`：东八区晚上会截出明天。 */
const localTodayIso = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
// 取「今天往前 45 天」（含今天）：窗口末尾必须是已经发生的日子。之前沿用 26 周窗口的
// 结束日（本周周日，在未来），图只画到今天，45 天里那几天未来日期没有柱子，
// 「45 天就是 45 根」自然对不上——注释一直写着「含今天」，代码却在用未来日期。
const customEnd = localTodayIso();
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

  // 45 天落在短窗口里，画的是日柱而不是 7 行周网格：一天一根，45 天就是 45 根。
  // 窗口终点取的是今天（不是本周周日），所以这 45 天全部已经发生，根数必须正好是 45。
  // 这一步同时也守着「短窗口的画法切换」，参数改回网格就会在这里露出来。
  const customBars = document.querySelectorAll('.heatmap-bar').length;
  const customCells = document.querySelectorAll('.heatmap-cell').length;
  add('45 天画成按天的柱子', customBars === 45 && customCells === 0, customBars + ' 根 / ' + customCells + ' 格');

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
  add('度量开关在两张排行卡上方', switches.length === 1 && !!switches[0].closest('.ranking-toolbar'), switches.length && switches[0].closest('.ranking-toolbar') ? 'ranking-toolbar' : 'elsewhere');
  // 开关与被它重排的第一行必须在同一屏内：这就是这次挪位置的唯一理由
  const gapToCards = switches.length === 1 && document.querySelector('.heatmap-ranking')
    ? Math.round(document.querySelector('.heatmap-ranking').getBoundingClientRect().top - switches[0].getBoundingClientRect().bottom)
    : null;
  add('开关距第一张排行卡不到 60px', gapToCards !== null && gapToCards >= 0 && gapToCards < 60, gapToCards + 'px');
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
    const bar = document.querySelector('.heatmap-bar');
    const legend = document.querySelector('.heatmap-legend');
    if (!card || !svg) return null;
    const cr = card.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const lastLegend = legend && legend.lastElementChild ? legend.lastElementChild.getBoundingClientRect() : null;
    return {
      weeks: ${weeks},
      mode: cell ? 'grid' : 'bars',
      cardH: Math.round(cr.height),
      svgW: Math.round(sr.width),
      svgH: Math.round(sr.height),
      cellPx: cell ? +cell.getBoundingClientRect().width.toFixed(1) : null,
      barPx: bar ? +bar.getBoundingClientRect().width.toFixed(1) : null,
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
    // 短窗口换画法：7 行网格在 13 周里只有 14 列，硬画就是一条对角线。
    add('近 3 个月画的是日柱', by[13].mode === 'bars', by[13].mode);
    // 半年（26 周）原来留在网格里，26 列只占卡片一半、右边空 645pt，图例停在卡片中间；
    // 铺满就得多放大格子，卡片高度从 187 涨到 271，和相邻的近 3 个月（176）差 95pt。
    // 改画日柱后两件事一起解决：柱子按天分槽天然铺满，高度是常量。
    add('近 6 个月也画成日柱', by[26].mode === 'bars', by[26].mode);
    add('一年以上仍是热力图', by[52].mode === 'grid' && by[104].mode === 'grid',
      [by[52].mode, by[104].mode].join('/'));
    // 近两年为了塞下 104 列必须把格子压到 10px，高度必然更矮，不参与这条比较。
    const heights = [by[13].cardH, by[26].cardH, by[52].cardH];
    add('短窗口到近一年卡片高度不抖', Math.max(...heights) - Math.min(...heights) <= 24, heights.join('/'));
    // 183 天 / 1302pt 时柱宽约 4.4px，再细就成一条线了
    add('半年视图的柱子还看得见', by[26].barPx >= 4, by[26].barPx + 'px');
    add('近一年铺满卡片宽度', by[52].svgW >= 1300, by[52].svgW);
    add('近两年格子仍分得清色阶', by[104].cellPx >= 9, by[104].cellPx);
    const gaps = bodies.filter((b) => b && !b.scrolls).map((b) => +(b.legendRight - b.svgRight).toFixed(1));
    add('图例贴着图的右端', gaps.length > 0 && gaps.every((g) => Math.abs(g) <= 3), gaps.join('/'));
  }
`,
);

console.log('== 阶段 5e：短窗口的日柱 ==');
/**
 * 短窗口（≤ 13 周）不画 7 行网格，改画一天一根柱子。
 *
 * 这一组盯的是「换画法之后图还是不是可读的」：柱子要铺满整幅（早先 45 天只有
 * 7 列、占卡片两成，右边空着一千多像素）、空白天要有短桩把基线连起来、
 * 最高柱要顶到绘图区顶部（否则柱高不可信）、刻度别挤成一团。
 */
await ev(`(() => { const b = document.querySelector('.range-switch button[data-weeks="13"]'); if (b) b.click(); return !!b; })()`);
for (let i = 0; i < 60; i += 1) {
  const settled = await ev(`(() => { const s = document.querySelector('.heatmap-subtitle'); return !!s && s.textContent.indexOf('近 3 个月') === 0; })()`);
  if (settled) break;
  await sleep(200);
}
await sleep(450);
await parkPointer();
await sleep(250);

const barsInfo = await ev(`(() => {
  const svg = document.querySelector('.heatmap-svg');
  const bars = [...document.querySelectorAll('.heatmap-bar')];
  const slots = [...document.querySelectorAll('.heatmap-bar-hit')];
  if (!svg || bars.length === 0 || slots.length === 0) return { error: 'no-bars' };
  const sr = svg.getBoundingClientRect();
  const heights = bars.map((b) => +b.getBoundingClientRect().height.toFixed(1));
  const widths = [...new Set(bars.map((b) => +b.getBoundingClientRect().width.toFixed(1)))];
  const firstSlot = slots[0].getBoundingClientRect();
  const lastSlot = slots[slots.length - 1].getBoundingClientRect();
  const counts = bars.map((b) => Number(b.dataset.count));
  const tickLabels = [...svg.querySelectorAll('text')].filter((t) => /^\\d+\\/\\d+$/.test(t.textContent.trim()));
  // 图表只画「已经发生」的日子（见 isHeatmapDayDrawn），所以窗口末尾那几天
  // 未来日期不会出现在柱子里。这不写进断言的话，条数就只能靠猜：
  // 周一跑是 85、周二 86、周日才是 91——同一个正确实现，一周里能变七次。
  const today = new Date();
  const todayIso = today.getFullYear() + '-'
    + String(today.getMonth() + 1).padStart(2, '0') + '-'
    + String(today.getDate()).padStart(2, '0');
  return {
    bars: bars.length,
    slots: slots.length,
    firstDate: slots[0].dataset.date,
    lastDate: slots[slots.length - 1].dataset.date,
    todayIso,
    rangeText: ((document.querySelector('.range-dates') || {}).textContent || '').trim(),
    cells: document.querySelectorAll('.heatmap-cell').length,
    span: +(lastSlot.right - firstSlot.left).toFixed(1),
    svgWidth: +sr.width.toFixed(1),
    widths,
    stubs: heights.filter((h) => h <= 2.5).length,
    tallest: Math.max(...heights),
    tallestCount: Math.max(...counts),
    viewBoxW: svg.viewBox.baseVal.width,
    ticks: tickLabels.length,
    tickLabels: tickLabels.map((t) => t.textContent.trim()).join(' '),
    title: (document.querySelector('.heatmap-header h2') || {}).textContent,
    peakLabel: (document.querySelector('.heatmap-bar-peak-label') || {}).textContent,
  };
})()`);

await hover('.heatmap-bar-hit');
const barTip = await ev(`(() => { const t = document.querySelector('.heatmap-tooltip'); return t ? t.textContent.trim() : ''; })()`);
await parkPointer();
await sleep(200);

await ev(`document.querySelector('.heatmap-svg')?.focus()`);
await sleep(300);
const barFocusStart = await ev(`document.querySelector('.heatmap-bar-hit.is-keyboard-focused')?.dataset.date ?? ''`);
await pressKey('ArrowLeft', 'ArrowLeft', 37);
await sleep(250);
const barFocusLeft = await ev(`document.querySelector('.heatmap-bar-hit.is-keyboard-focused')?.dataset.date ?? ''`);
await pressKey('End', 'End', 35);
await sleep(250);
const barFocusEnd = await ev(`document.querySelector('.heatmap-bar-hit.is-keyboard-focused')?.dataset.date ?? ''`);
const barScrollBefore = await ev('window.scrollY');
await ev(`document.querySelector('.heatmap-svg')?.focus()`);
await pressKey('Home', 'Home', 36);
await sleep(250);
const barFocusHome = await ev(`document.querySelector('.heatmap-bar-hit.is-keyboard-focused')?.dataset.date ?? ''`);
await pressKey('ArrowLeft', 'ArrowLeft', 37);
await sleep(250);
const barFocusEdge = await ev(`document.querySelector('.heatmap-bar-hit.is-keyboard-focused')?.dataset.date ?? ''`);
const barScrollAfter = await ev('window.scrollY');
const barFocusedCount = await ev(`document.querySelectorAll('.heatmap-bar-hit.is-keyboard-focused').length`);

// 提示是 position: fixed，钉在视口坐标上而不是图上。图被滚走之后它不会跟着走，
// 所以离开/滚动时必须主动收起——否则就是「鼠标早不在了，那条数字还挂在屏上」。
await hover('.heatmap-bar-hit');
await sleep(150);
const tipOnHover = await ev(`!!document.querySelector('.heatmap-tooltip')`);
// 图自己的横向视口滚一下（触控板横扫）：指针没动、指针底下的槽位却换了，
// mouseleave 不会发，只有 scroll 监听能把提示收走。合成事件是为了不依赖这张图
// 在当前窗口宽度下能不能真的横滚。
await ev(`document.querySelector('.heatmap-viewport')?.dispatchEvent(new Event('scroll'))`);
await sleep(250);
const tipAfterInnerScroll = await ev(`!!document.querySelector('.heatmap-tooltip')`);
// 指针停在原地时浏览器不会再发 mouseenter（元素没变，只是位置变了），
// 先把指针挪开再回来，测的才是「滚动后还能重新悬停」而不是事件补发。
await parkPointer();
await sleep(150);
await hover('.heatmap-bar-hit');
await sleep(150);
const tipOnHoverAgain = await ev(`!!document.querySelector('.heatmap-tooltip')`);
await parkPointer();
await sleep(300);
const tipAfterLeave = await ev(`!!document.querySelector('.heatmap-tooltip')`);
// 前面已经 focus 过一次，直接再 focus 不会触发事件；先 blur 才能真的拿到 focus。
await ev(`(() => { const svg = document.querySelector('.heatmap-svg'); if (!svg) return false; svg.blur(); return true; })()`);
await sleep(120);
await ev(`document.querySelector('.heatmap-svg')?.focus()`);
await sleep(150);
const tipOnFocus = await ev(`!!document.querySelector('.heatmap-tooltip')`);
await ev(`document.querySelector('.heatmap-svg')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))`);
await sleep(250);
const tipAfterChartLeave = await ev(`!!document.querySelector('.heatmap-tooltip')`);

await runGroup(
  '数据分析页-短窗口日柱',
  `
  const info = ${JSON.stringify(barsInfo)};
  add('量到了柱子', !info.error, info.error || info.bars + ' 根');
  if (!info.error) {
    // 「一天一根」的全部意思：槽位数 = 柱子数 = 窗口内已经过去的天数。
    // 这里不能写死 88~92——窗口末尾是本周周日，未来那几天不画（isHeatmapDayDrawn），
    // 于是同一条正确实现在周一跑出 85、周二 86、周日才 91。按日期算才是判据。
    const [rangeStart, rangeEnd] = info.rangeText.split(' ~ ');
    const drawnEnd = info.todayIso < rangeEnd ? info.todayIso : rangeEnd;
    const daySpan = Math.round((Date.parse(drawnEnd) - Date.parse(rangeStart)) / 86400000) + 1;
    add('一天一根：柱子数 = 槽位数 = 窗口内已过去的天数',
      info.bars === info.slots && info.bars === daySpan,
      info.bars + ' 根 / ' + info.slots + ' 槽 / 应为 ' + daySpan + ' 天（' + rangeStart + ' ~ ' + drawnEnd + '）');
    // 条数对得上但两端各少一天也会过，所以首尾单独钉：起点是窗口起点，终点是今天。
    add('柱子从窗口起点画到今天', info.firstDate === rangeStart && info.lastDate === drawnEnd,
      info.firstDate + ' ~ ' + info.lastDate + ' / 应为 ' + rangeStart + ' ~ ' + drawnEnd);
    add('不再画 7 行网格', info.cells === 0, info.cells + ' 个格子');
    // 早先 45 天只有 7 列、占卡片不到两成；柱子必须铺满整幅
    add('柱子铺满绘图区', info.span >= info.svgWidth - 2, info.span + ' vs ' + info.svgWidth);
    // 柱状图按实测宽度 1 : 1 排版。viewBox 比渲染宽度大就说明还在等比缩放，字会被压扁
    add('按实测宽度 1 : 1 排版', Math.abs(info.viewBoxW - info.svgWidth) <= 1.5, 'viewBox ' + info.viewBoxW + ' / 渲染 ' + info.svgWidth);
    add('柱宽收在上限内（7 天也不摊成色板）', info.widths.every((w) => w <= 60.5), info.widths.join('/'));
    add('空白天留了短桩', info.stubs > 0, info.stubs + ' 天无提交');
    add('最高柱顶到绘图区顶部', Math.abs(info.tallest - 132) <= 1.5, info.tallest + 'px / 峰值 ' + info.tallestCount + ' 次');
    add('日期刻度 5–7 个', info.ticks >= 5 && info.ticks <= 7, info.tickLabels);
    add('标题跟着画法改叫提交趋势', (info.title || '').includes('提交趋势'), info.title);
    add('峰值参考线带数字', /峰值\\s*\\d+/.test(info.peakLabel || ''), info.peakLabel);
  }
  add('悬停柱子出当天提示', /\\d{4}-\\d{2}-\\d{2}/.test(${JSON.stringify(barTip)}), ${JSON.stringify(barTip)}.slice(0, 26));
  // 提示不跟着图走：图一滚，指针底下换了一天，提示必须收起而不是钉在原地
  add('悬停时提示在', ${tipOnHover} === true, ${tipOnHover});
  add('图内滚动后提示收起', ${tipAfterInnerScroll} === false, ${tipAfterInnerScroll});
  add('重新悬停仍能出提示', ${tipOnHoverAgain} === true, ${tipOnHoverAgain});
  add('指针移出图后提示收起', ${tipAfterLeave} === false, ${tipAfterLeave});
  add('键盘聚焦时提示回来', ${tipOnFocus} === true, ${tipOnFocus});
  add('离开图表本身也收起', ${tipAfterChartLeave} === false, ${tipAfterChartLeave});
  add('聚焦后有且只有一列高亮', ${barFocusedCount} === 1, ${barFocusedCount});
  add('左方向键退一天', ${JSON.stringify(barFocusStart)} !== '' && Math.round((Date.parse(${JSON.stringify(barFocusStart)}) - Date.parse(${JSON.stringify(barFocusLeft)})) / 86400000) === 1, ${JSON.stringify(barFocusStart)} + ' -> ' + ${JSON.stringify(barFocusLeft)});
  add('End 跳到窗口最后一天', ${JSON.stringify(barFocusEnd)} > ${JSON.stringify(barFocusLeft)}, ${JSON.stringify(barFocusEnd)});
  add('Home 跳到窗口第一天', ${JSON.stringify(barFocusHome)} < ${JSON.stringify(barFocusEnd)}, ${JSON.stringify(barFocusHome)});
  add('第一天再按左不动且页面不滚', ${JSON.stringify(barFocusEdge)} === ${JSON.stringify(barFocusHome)} && ${barScrollAfter} === ${barScrollBefore}, ${JSON.stringify(barFocusEdge)} + '，scrollY ' + ${barScrollBefore} + ' -> ' + ${barScrollAfter});
`,
);

// 窗口缩到 1024 要重新量宽度：柱状图是 1 : 1 排版的，宽度没跟上就会缩成一张被压扁的图
await setViewport(1024, 900);
await sleep(900);
const barsAt1024 = await ev(`(() => {
  const svg = document.querySelector('.heatmap-svg');
  const bars = [...document.querySelectorAll('.heatmap-bar')];
  const slots = [...document.querySelectorAll('.heatmap-bar-hit')];
  if (!svg || bars.length === 0 || slots.length === 0) return null;
  const sr = svg.getBoundingClientRect();
  const first = slots[0].getBoundingClientRect();
  const last = slots[slots.length - 1].getBoundingClientRect();
  return {
    svgWidth: +sr.width.toFixed(1),
    viewBoxW: svg.viewBox.baseVal.width,
    span: +(last.right - first.left).toFixed(1),
    height: +sr.height.toFixed(1),
  };
})()`);
await runGroup(
  '数据分析页-短窗口日柱 1024',
  `
  const narrow = ${JSON.stringify(barsAt1024)};
  add('1024 下仍量到柱子', !!narrow, narrow ? narrow.svgWidth + 'px' : 'missing');
  if (narrow) {
    add('1024 下重新量了宽度', Math.abs(narrow.svgWidth - narrow.viewBoxW) <= 1.5, 'viewBox ' + narrow.viewBoxW + ' / 渲染 ' + narrow.svgWidth);
    add('1024 下柱子仍铺满', narrow.span >= narrow.svgWidth - 2, narrow.span + ' vs ' + narrow.svgWidth);
    add('1024 下高度不变', Math.abs(narrow.height - 176) <= 1, narrow.height + 'px');
  }
`,
);
await setViewport(1440, 950);
await sleep(700);
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
// 星期几要按**光标所在那天**算，不能按「今天」算：断言里的锚点是箭头走完之后的日期。
// 0 = 周日 … 1 = 周一。上下键是「同列内换行」，到边界停住是刻意的（跨列那一跳
// 视觉距离最远，见 heatmap-grid.test.ts 的用例注释），所以周一按「上」本来就不动。
const weekdayOf = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).getUTCDay() : -1);
const weekdayName = (iso) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekdayOf(iso)] ?? '未知';

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
  {
    // 周一按「上」停在原地是设计（同列内换行，不绕到上一列周日）：原来这条写死
    // 「必定退一天」，于是每逢周一必红、其余六天全绿——是断言在按星期几算命，不是缺陷。
    n: weekdayOf(afterLeft) === 1 ? '周一按上停在原地（同列内换行，不绕列）' : '上方向键退一天',
    ok: weekdayOf(afterLeft) === 1 ? dayGap(afterUp, afterLeft) === 0 : dayGap(afterUp, afterLeft) === 1,
    d: `${afterLeft}（${weekdayName(afterLeft)}） -> ${afterUp}`,
  },
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

// 按块暂存的入口曾经对未跟踪文件也渲染出来：它的 diff 是前端按文件内容合成的纯新增，
// 而后端按块操作走 `git diff -- <path>`，未跟踪文件不在其中，点下去必然 409。这里用同一
// 个仓库里的两类文件把边界钉住——未跟踪不给按钮，已跟踪必须有。
console.log('== 阶段 5.5：仓库工作区的按块暂存入口 ==');
await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '仓库舰队');
  if (btn) btn.click();
  return !!btn;
})()`);
await sleep(1800);
const repoOpened = await ev(`(() => {
  const row = [...document.querySelectorAll('.repo-table tbody tr')]
    .find((r) => r.querySelector('.repo-name')?.textContent.trim() === 'northwind-api');
  if (!row) return false;
  row.querySelector('.repo-name').click();
  return true;
})()`);
await sleep(2400);

const pickWorkspaceFile = (label) =>
  ev(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] .workspace-file-select')]
      .find((n) => n.getAttribute('aria-label') === '查看差异 ' + ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);

const untrackedPicked = await pickWorkspaceFile('NOTES.md');
await sleep(1500);
record('仓库工作区-按块暂存', [
  {
    n: '能选中未跟踪文件',
    ok: repoOpened && untrackedPicked,
    d: `仓库打开 ${repoOpened} / 选中 NOTES.md ${untrackedPicked}`,
  },
  {
    n: '未跟踪文件带 U 标记',
    ok: await ev(`!!document.querySelector('[role="dialog"] .workspace-file-select[aria-label="查看差异 NOTES.md"] b.untracked')`),
    d: await ev(`document.querySelector('[role="dialog"] .workspace-file-select[aria-label="查看差异 NOTES.md"] b')?.textContent ?? 'none'`),
  },
  {
    n: '未跟踪文件不给按块暂存入口',
    ok: !(await ev(`!!document.querySelector('[role="dialog"] .diff-hunk-action')`)),
    d: `按钮数 ${await ev(`document.querySelectorAll('[role="dialog"] .diff-hunk-action').length`)}`,
  },
]);

const trackedPicked = await pickWorkspaceFile('src/handler.ts');
await sleep(1500);
const trackedHunk = await ev(`document.querySelector('[role="dialog"] .diff-hunk-action')?.textContent.trim() ?? 'none'`);
record('仓库工作区-按块暂存', [
  {
    n: '已跟踪文件仍有按块暂存入口',
    ok: trackedPicked && trackedHunk === '暂存此块',
    d: `选中 handler.ts ${trackedPicked} / 按钮「${trackedHunk}」`,
  },
]);
// 抽屉里真点一次按块暂存：它会在这块面板里留下一条消息，正好验「消息属于这个仓库」。
// 夹具每次验证都会重建，暂存一个块不影响后续阶段。
const hunkStashClicked = await ev(`(() => {
  const b = document.querySelector('[role="dialog"] .diff-hunk-action');
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(1800);
const workspaceNoticeText = await ev(`(document.querySelector('[role="dialog"] .workspace-feedback')?.textContent ?? '').trim()`);
await shot('14-workspace-hunks.png');
await runGroup(
  '消息归属-抽屉',
  `
  const strip = document.querySelector('[role="dialog"] .workspace-feedback');
  const text = strip ? strip.textContent.trim() : '';
  add('抽屉里的操作给出一条消息', ${JSON.stringify(hunkStashClicked)} && !!strip, text || 'missing');
  add('这条消息说的就是刚才那次暂存', text.indexOf('已暂存') >= 0, text || 'none');
  add('文案不再重复抽屉标题上的仓库名', text !== '' && text.indexOf('northwind-api') < 0, text || 'none');
  add('成功用 success 档', !!strip && strip.classList.contains('success'), strip ? strip.className : 'none');
  add('有可点的关闭按钮', !!strip && !!strip.querySelector('button[aria-label="关闭提示"]'));
`,
);
await ev(`document.querySelector('[role="dialog"] .workspace-back-button')?.click()`);
await sleep(1200);
await pressEsc();
await sleep(800);
await runGroup(
  '消息归属-抽屉',
  `
  const strip = document.querySelector('.surface-feedback.fleet-feedback');
  const text = strip ? strip.textContent.trim() : '';
  add('关掉抽屉后那条消息没有搬到舰队页', text !== ${JSON.stringify(workspaceNoticeText)} || text === '', text || 'none');
`,
);

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

// ---- 遮罩点击关闭：在弹窗里按下、拖到遮罩上松开，不能算「点了外部」 ----
// 旧实现用 @click.self，而 click 的 target 是「按下点与松开点的最近公共祖先」。
// 弹窗是遮罩的子节点，公共祖先正是遮罩，于是按住鼠标往外一拖再松手就会关掉弹窗，
// 未保存的编辑一起丢。用户在有输入框的弹窗里选字时几乎必中。
await setViewport(1440, 950);
await clickNavByText('仓库舰队');
await sleep(1200);
const drawerOpened = await ev(`(() => { const row = document.querySelector('.repo-table tbody tr'); if (!row) return false; row.click(); return true; })()`);
await sleep(1000);
const editorClicked = await clickText('编辑配置');
await sleep(900);
const editorRect = JSON.parse(await ev(`(() => {
  const modal = document.querySelector('.repository-config-modal');
  if (!modal) return 'null';
  const r = modal.getBoundingClientRect();
  return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
})()`) ?? 'null');
const grabPoint = editorRect ? { x: editorRect.left + 40, y: editorRect.top + Math.round(editorRect.height / 2) } : { x: 700, y: 480 };
await dragPointer(grabPoint, { x: 12, y: grabPoint.y });
await sleep(500);
const survivedDragOut = await ev(`!!document.querySelector('.repository-config-modal')`);
await shot('17-config-modal-after-drag-out.png');

// 真的点遮罩仍然要能关：拖拽之后不能留下残余状态把下一次点击吃掉。
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 12, y: 12, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 12, y: 12, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 12, y: 12, button: 'left', clickCount: 1 });
await sleep(700);
const closedByRealBackdropClick = !(await ev(`!!document.querySelector('.repository-config-modal')`));

record('遮罩点击关闭', [
  { n: '能打开仓库配置弹窗', ok: Boolean(editorRect) && Boolean(drawerOpened) && Boolean(editorClicked), d: editorRect ? `${editorRect.width}x${editorRect.height}` : '未打开' },
  { n: '在弹窗内按下、拖到遮罩上松开不会关闭', ok: survivedDragOut, d: survivedDragOut ? '仍在（正确）' : '被误关（回归）' },
  { n: '真正点击遮罩仍然关闭', ok: closedByRealBackdropClick, d: closedByRealBackdropClick ? '已关闭' : '没关（指令失效）' },
]);

// ---- 仓库行拖选文字：选中不该被当成「点了这一行」 ----
// 真实浏览器里「按下 → 拖动选字 → 松开」最后会派发一次 click（按下点与松开点是同一个元素），
// 于是选个路径复制就会把抽屉顶出来。CDP 的合成鼠标事件造不出原生文字选区，
// 所以这里直接把选区设好，再派发浏览器届时会派发的那一次 click，验证护栏的判定。
// 上一组留下的抽屉必须先关掉，否则「抽屉开着」这条判据永远是假阳性。
// Esc 与关闭按钮都试一遍，并用轮询代替固定 sleep——抽屉带过渡动画。
const drawerPresent = () => ev(`!!document.querySelector('.repo-workspace-shell')`);
const waitDrawerClosed = async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (!(await drawerPresent())) return true;
    await sleep(120);
  }
  return !(await drawerPresent());
};
await pressEsc();
let drawerClosePath = 'Esc';
let escDiag = null;
if (!(await waitDrawerClosed())) {
  escDiag = await ev(`(() => {
    const a = document.activeElement;
    const name = (n) => (n ? n.tagName.toLowerCase() + '.' + String(n.className ?? '').trim().split(/\\s+/).slice(0, 2).join('.') : 'null');
    return JSON.stringify({
      active: name(a),
      activeLabel: a ? (a.getAttribute('aria-label') ?? a.textContent?.trim().slice(0, 20) ?? '') : '',
      layers: [...document.querySelectorAll('[data-focus-layer]')].map(name),
      updatePanel: !!document.querySelector('.update-panel'),
      drawers: document.querySelectorAll('.repo-workspace-shell').length,
    });
  })()`);
  console.log(`ESC-DIAG ${escDiag}`);
  await ev(`document.querySelector('button[aria-label="关闭侧边抽屉"]')?.click() ?? null`);
  drawerClosePath = '关闭按钮';
  await waitDrawerClosed();
}
const drawerClosedBeforeSelection = !(await drawerPresent());
const rowDiag = JSON.parse(await ev(`(() => JSON.stringify({
  rows: document.querySelectorAll('.repo-table tbody tr').length,
  cell: !!document.querySelector('.repo-table tbody tr .repository-cell'),
  drawer: !!document.querySelector('.repo-workspace-shell'),
  overlay: document.querySelectorAll('[data-focus-layer]').length,
}))()`) ?? 'null');

const selectedChars = Number(await ev(`(() => {
  const cell = document.querySelector('.repo-table tbody tr .repository-cell');
  if (!cell) return 0;
  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return (selection.toString() ?? '').trim().length;
})()`));
await sleep(200);
await ev(`(() => {
  const cell = document.querySelector('.repo-table tbody tr .repository-cell');
  if (!cell) return false;
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
})()`);
await sleep(900);
const drawerAfterSelectedClick = await drawerPresent();
await shot('18-row-text-selection.png');

// 选区清掉之后，同一次点击必须照常打开抽屉——护栏不能把正常点击也吞掉。
await ev(`(() => { const s = window.getSelection(); s && s.removeAllRanges(); return true; })()`);
await sleep(300);
await ev(`(() => {
  const cell = document.querySelector('.repo-table tbody tr .repository-cell');
  if (!cell) return false;
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
})()`);
await sleep(900);
const drawerAfterPlainClick = await drawerPresent();

record('仓库行拖选文字', [
  { n: '基线：抽屉已关闭', ok: drawerClosedBeforeSelection, d: drawerClosedBeforeSelection ? `已关闭（${drawerClosePath}）` : `仍开着 · 行 ${rowDiag?.rows ?? '?'} · 单元格 ${rowDiag?.cell ? '在' : '缺'} · 焦点层 ${rowDiag?.overlay ?? '?'}` },
  { n: '有选区时的点击不打开抽屉', ok: selectedChars > 0 && !drawerAfterSelectedClick, d: selectedChars > 0 ? (drawerAfterSelectedClick ? '抽屉被顶开（回归）' : `选中 ${selectedChars} 字，未打开（正确）`) : `选区为空（断言空跑）· 行 ${rowDiag?.rows ?? '?'} · 单元格 ${rowDiag?.cell ? '在' : '缺'}` },
  { n: '清掉选区后点击照常打开', ok: drawerAfterPlainClick, d: drawerAfterPlainClick ? '已打开' : '没打开（护栏误伤正常点击）' },
]);

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
