/**
 * 原生外壳分支的真机验证。
 *
 * 在真实 Chrome 里伪造 `window.webkit.messageHandlers.appearance`
 * （外壳一定会注入它，`hasNativeShell()` 就认这个），于是前端走「服务端落盘 /
 * 服务端系统对话框」这条路——正是 macOS app 里的实际行为。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.MOO_FLEET_E2E_BASE ?? '/tmp/moo-fleet-transfer-e2e';
const URL = 'http://127.0.0.1:8802';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find((entry) => entry.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('DOM.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 800));
  return result.value;
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${BASE}/${name}.png`, Buffer.from(data, 'base64'));
  console.log(`shot ${BASE}/${name}.png`);
}

const fail = [];
function check(label, condition, detail = '') {
  if (!condition) fail.push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// 伪造原生外壳标记：必须在页面脚本执行之前注入。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.webkit = { messageHandlers: { appearance: { postMessage: () => {} } } };`,
});
await send('Page.navigate', { url: URL });
await sleep(3000);

const shellSeen = await evaluate('typeof window.webkit?.messageHandlers?.appearance?.postMessage');
check('页面认出了原生外壳', shellSeen === 'function', shellSeen);

await evaluate(`document.querySelector('button.profile-chip').click()`);
await sleep(600);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('.manage-nav button, nav button')]
    .find((node) => (node.textContent || '').trim() === '配置迁移');
  button.click();
})()`);
await sleep(600);

const inputGone = await evaluate(`!document.querySelector('input.transfer-file-input')`);
check('原生外壳下不渲染隐藏 file input', inputGone === true);

const exportHint = await evaluate(`document.body.innerText.includes('文件会写进这台电脑的下载目录')`);
check('导出卡片说明了落盘位置', exportHint === true);

// 导出：应真的写出文件
const before = fs.readdirSync(`${BASE}/dst-downloads`);
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('导出配置文件')).click()`);
await sleep(2500);
const notice = await evaluate(`document.querySelector('.transfer-notice[data-tone]')?.textContent?.trim() ?? ''`);
await shot('ui-04-native-export');
const after = fs.readdirSync(`${BASE}/dst-downloads`);
check(
  '提示里带上了绝对路径',
  /已导出 \d+ 个仓库配置到 /.test(notice) && notice.includes(`${BASE}/dst-downloads/`),
  notice,
);
check('文件真的落盘了', after.length === before.length + 1, after.join(', '));
const writtenFile = after.find((name) => !before.includes(name));
if (writtenFile) {
  const mode = (fs.statSync(`${BASE}/dst-downloads/${writtenFile}`).mode & 0o777).toString(8);
  check('落盘文件权限 0600', mode === '600', mode);
  const parsed = JSON.parse(fs.readFileSync(`${BASE}/dst-downloads/${writtenFile}`, 'utf8'));
  check('落盘内容含 Key 与外观', Boolean(parsed.ai?.apiKey) && Boolean(parsed.appearance?.theme));
}

// 选择配置文件：会真的弹出系统对话框。确认按钮进入等待态，再模拟「用户取消」。
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('选择配置文件')).click()`);
await sleep(1800);
const pickingState = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('等待选择') || b.textContent.includes('选择配置文件'));
  return JSON.stringify({ label: button.textContent.trim(), disabled: button.disabled });
})()`);
const picking = JSON.parse(pickingState);
check('对话框打开期间按钮显示等待态', picking.label.includes('等待选择'), picking.label);
check('对话框打开期间按钮被禁用', picking.disabled === true);
await shot('ui-05-native-picking');

// 杀掉对话框进程 = 用户取消。匹配脚本正文而不是提示语：提示语在 AppleScript 里
// 是变量（`prompt promptText`），argv 里那份才带中文。
try {
  execFileSync('pkill', ['-f', 'choose file with prompt promptText']);
} catch {
  // 没匹配到也无所谓，下面用等待兜底
}
await sleep(2000);
const afterCancel = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('选择配置文件'));
  const noticeEl = document.querySelector('.transfer-notice[data-tone="error"]');
  return JSON.stringify({ label: button?.textContent?.trim() ?? '', error: noticeEl?.textContent?.trim() ?? '' });
})()`);
const cancelled = JSON.parse(afterCancel);
check('取消后按钮恢复可点', cancelled.label.includes('选择配置文件') && !cancelled.label.includes('等待'), cancelled.label);
check('取消不是错误：不弹红字', cancelled.error === '', cancelled.error);

console.log(fail.length ? `\n${fail.length} 项失败` : '\n全部通过');
ws.close();
process.exit(fail.length ? 1 : 0);
