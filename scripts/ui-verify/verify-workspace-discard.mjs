#!/usr/bin/env node
/**
 * 工作区丢弃 UI 验收：全部丢弃、纯暂存单文件还原、已暂存新文件删除。
 *
 * 跑的是 dist 产物 + 隔离 GIT_FLEET_HOME + headless Chrome，只动临时目录里的仓库；
 * 真实废纸篓只接收这些临时测试文件。
 *
 * 用法：
 *   npm run verify:ui:discard
 *   MOO_FLEET_DISCARD_UI_ROOT=/tmp/... CHROME=... node scripts/ui-verify/verify-workspace-discard.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_DISCARD_UI_ROOT ?? '/tmp/moo-fleet-discard-ui';
const PROJECTS = path.join(ROOT, 'projects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist/server/index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail ?? ''));
};

if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome：' + CHROME); process.exit(2); }
if (!fs.existsSync(SERVER_ENTRY)) { console.error('缺少 dist/server/index.js，请先 npm run build'); process.exit(2); }
// ROOT 会被整目录删除：只允许落在临时目录下，避免环境变量写错时误删真实目录。
const allowedRoots = [path.resolve(os.tmpdir()), path.resolve('/tmp'), path.resolve('/private/tmp')];
if (!allowedRoots.some((root) => path.resolve(ROOT).startsWith(root + path.sep))) {
  console.error('MOO_FLEET_DISCARD_UI_ROOT 必须位于临时目录下，拒绝清理：' + ROOT);
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
const repo = path.join(PROJECTS, 'discard-repo');
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git('config', 'user.name', 'Discard Probe');
git('config', 'user.email', 'discard@example.test');
git('config', 'commit.gpgsign', 'false');

// 混合现场：纯暂存 M、已暂存新文件 A、未跟踪 ??、工作区删除 D、未暂存 M。
for (const name of ['a.txt', 'deleted.txt']) fs.writeFileSync(path.join(repo, name), 'base\n');
git('add', '-A');
git('commit', '-qm', 'base');
fs.appendFileSync(path.join(repo, 'a.txt'), 'staged only\n');
git('add', 'a.txt');
fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'unstaged\n');
fs.writeFileSync(path.join(repo, 'new-staged.txt'), 'new staged\n');
git('add', 'new-staged.txt');
fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
fs.rmSync(path.join(repo, 'deleted.txt'));
const initialStatus = git('status', '--porcelain');
check('夹具包含 M / A / ?? / D 四种现场', /^(M |A |\?\?| D)/m.test(initialStatus) && initialStatus.trim().split('\n').length >= 5, { status: initialStatus });

const PORT = await freePort();
const server = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    GIT_FLEET_HOME: path.join(ROOT, 'fleet'),
    GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'),
    GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'),
    GIT_FLEET_PORT: String(PORT),
    GIT_FLEET_DEVICE_NAME: 'discard-probe',
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
server.stdout.on('data', (chunk) => log.push(String(chunk)));
server.stderr.on('data', (chunk) => log.push(String(chunk)));
let chrome = null;
const cleanup = () => {
  try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch { /* ignore */ }
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
};
process.on('exit', cleanup);

const base = 'http://127.0.0.1:' + PORT;
let healthy = false;
for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
  try { healthy = (await fetch(base + '/api/health')).ok; } catch { /* ignore */ }
  if (!healthy) await sleep(500);
}
if (!healthy) { console.error('后端没起来:\n' + log.join('')); process.exit(1); }

const token = (await (await fetch(base + '/api/session')).json()).token;
const headers = { 'content-type': 'application/json', 'x-git-fleet-token': token };
await fetch(base + '/api/repository-roots', { method: 'POST', headers, body: JSON.stringify({ path: PROJECTS }) });
const roots = await (await fetch(base + '/api/repository-roots', { headers })).json();
const rootId = Object.keys(roots)[0];
await fetch(base + '/api/repositories', { method: 'POST', headers, body: JSON.stringify({ rootId, relativePath: 'discard-repo' }) });
await fetch(base + '/api/repositories/refresh', { method: 'POST', headers });

const debugPort = await freePort();
const profile = path.join(ROOT, 'chrome');
fs.mkdirSync(profile, { recursive: true });
const chromeFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', ...chromeFlags, 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
let version = null;
for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
  try { version = await (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).json(); } catch { await sleep(500); }
}
if (!version) { console.error('Chrome 没起来'); process.exit(2); }
const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
const pageTarget = targets.find((entry) => entry.type === 'page');
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text));
  return result.value;
};
const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(300);
  }
  return false;
};
const openRepo = async () => {
  await waitFor(async () => (await evaluate("document.querySelectorAll('.repo-table tbody tr').length")) >= 1);
  await evaluate("(() => { const row = document.querySelector('.repo-table tbody tr'); row && row.click(); })()");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.repo-workspace-shell .workspace-file-row, .repo-workspace-shell .file-tree-directory').length")) > 0);
};
const confirmDialog = async () => evaluate("(() => { const modal = document.querySelector('.confirmation-modal'); if (!modal) return null; const button = modal.querySelector('.confirmation-confirm'); if (!button) return null; const text = (button.textContent || '').trim(); button.click(); return text; })()");
const waitForCleanWorktree = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (git('status', '--porcelain').trim() === '') return true;
    await sleep(250);
  }
  return false;
};
const screenshot = async (name) => {
  const shots = path.join(ROOT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: base });
await sleep(3200);
await openRepo();
await screenshot('01-workspace-before-discard.png');

// ① 全部丢弃：含已暂存、未暂存、未跟踪与已删除文件。
const allButton = await evaluate("(() => { const button = document.querySelector('.workspace-group-discard-all'); return button ? (button.textContent || '').trim() : null; })()");
check('标题栏存在「全部丢弃」批量入口', /全部丢弃/.test(allButton || ''), allButton);
await evaluate("document.querySelector('.workspace-group-discard-all')?.click()");
await waitFor(async () => (await evaluate("!!document.querySelector('.confirmation-modal')")));
const allConfirmLabel = await confirmDialog();
check('全部丢弃确认按钮为「丢弃全部」', /丢弃全部/.test(allConfirmLabel || ''), allConfirmLabel);
const allClean = await waitForCleanWorktree();
check('全部丢弃后 git 工作区干净', allClean, { status: git('status', '--porcelain') });
check('已跟踪文件回到 HEAD 且删除文件被恢复', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'base\n' && fs.existsSync(path.join(repo, 'deleted.txt')), { a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), deleted: fs.existsSync(path.join(repo, 'deleted.txt')) });
check('未提交新文件已离开工作区', !fs.existsSync(path.join(repo, 'new-staged.txt')) && !fs.existsSync(path.join(repo, 'untracked.txt')) && !fs.existsSync(path.join(repo, 'unstaged.txt')), {});
await waitFor(async () => (await evaluate("document.querySelectorAll('.workspace-file-row').length")) === 0);
check('全部丢弃后界面不再列出变化文件', (await evaluate("document.querySelectorAll('.workspace-file-row').length")) === 0, {});

// ② 纯暂存单文件：行内「还原到上次提交」必须先备份再回 HEAD。
fs.appendFileSync(path.join(repo, 'a.txt'), 'staged only two\n');
git('add', 'a.txt');
await evaluate('window.location.reload()');
await sleep(3200);
await openRepo();
const rowRestore = await evaluate("(() => { const row = [...document.querySelectorAll('.workspace-file-row')].find((entry) => entry.dataset.path === 'a.txt'); const button = row && row.querySelector('.file-discard'); return button ? { title: button.getAttribute('title'), className: button.className } : null; })()");
check('纯暂存文件行内显示「还原到上次提交」', /还原到上次提交/.test(rowRestore?.title || ''), rowRestore);
await evaluate("(() => { const row = [...document.querySelectorAll('.workspace-file-row')].find((entry) => entry.dataset.path === 'a.txt'); row && row.querySelector('.file-discard')?.click(); })()");
await waitFor(async () => (await evaluate("!!document.querySelector('.confirmation-modal')")));
const restoreConfirmLabel = await confirmDialog();
check('单文件还原确认框可点', /还原到上次提交/.test(restoreConfirmLabel || ''), restoreConfirmLabel);
check('单文件还原后 git 干净且内容回 HEAD', (await waitForCleanWorktree()) && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'base\n', { status: git('status', '--porcelain'), a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') });

// ③ 已暂存新文件（A）：行内入口必须是「移到废纸篓」，不能走 restore 静默删除。
fs.writeFileSync(path.join(repo, 'new-staged-two.txt'), 'new staged two\n');
git('add', 'new-staged-two.txt');
await evaluate('window.location.reload()');
await sleep(3200);
await openRepo();
const rowNew = await evaluate("(() => { const row = [...document.querySelectorAll('.workspace-file-row')].find((entry) => entry.dataset.path === 'new-staged-two.txt'); const button = row && row.querySelector('.file-discard'); return button ? { title: button.getAttribute('title'), className: button.className } : null; })()");
check('已暂存新文件行内是「移到废纸篓」', /移到废纸篓/.test(rowNew?.title || '') && /trash/.test(rowNew?.className || ''), rowNew);
await evaluate("(() => { const row = [...document.querySelectorAll('.workspace-file-row')].find((entry) => entry.dataset.path === 'new-staged-two.txt'); row && row.querySelector('.file-discard')?.click(); })()");
await waitFor(async () => (await evaluate("!!document.querySelector('.confirmation-modal')")));
const newConfirmLabel = await confirmDialog();
check('新文件确认按钮为「移到废纸篓」', /移到废纸篓/.test(newConfirmLabel || ''), newConfirmLabel);
check('新文件删除后 git 干净且文件不存在', (await waitForCleanWorktree()) && !fs.existsSync(path.join(repo, 'new-staged-two.txt')), { status: git('status', '--porcelain'), exists: fs.existsSync(path.join(repo, 'new-staged-two.txt')) });
await screenshot('02-workspace-after-discard.png');

const failed = results.filter((result) => !result.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
console.log('截图：' + path.join(ROOT, 'shots'));
cleanup();
process.exit(failed.length ? 1 : 0);
