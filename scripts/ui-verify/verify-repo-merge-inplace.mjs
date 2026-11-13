#!/usr/bin/env node
/**
 * 单仓抽屉「合并」后的落点验收：执行后**留在仓库抽屉**，不跳回主界面、不自动弹出操作记录
 * （那是工作台批量才需要的）。用小夹具自起实例 + headless Chrome。
 *
 * 用法：npm run verify:ui:merge-inplace
 * 退出码：全过 0，有失败 1。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_INPLACE_ROOT ?? '/tmp/moo-fleet-repo-merge-inplace';
const PROJECTS = path.join(ROOT, 'projects');
const REMOTES = path.join(ROOT, 'remotes');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (group, items) => { for (const item of items) results.push({ group, ...item }); };
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

if (!fs.existsSync(CHROME)) { console.error(`找不到 Chrome：${CHROME}`); process.exit(2); }
if (fs.existsSync(ROOT)) {
  const entries = fs.readdirSync(ROOT);
  if (!(entries.length === 0 || entries.includes('fleet') || entries.includes('projects') || entries.includes('remotes'))) {
    console.error(`拒绝清空 ${ROOT}`); process.exit(2);
  }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(REMOTES, { recursive: true });
const gitAt = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo(name) {
  const remote = path.join(REMOTES, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  const work = path.join(PROJECTS, name);
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...a) => gitAt(work, ...a);
  g('config', 'user.name', 'Probe'); g('config', 'user.email', 'probe@example.test'); g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(work, 'README.md'), '# repo\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('remote', 'add', 'origin', remote); g('push', '-q', '-u', 'origin', 'main');
  g('branch', 'dev'); g('push', '-q', '-u', 'origin', 'dev');
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  g('add', 'feature.txt'); g('commit', '-q', '-m', 'feature work');
  return { name, work };
}
const repo = makeRepo('repo-merge');

const PORT = Number(process.env.MOO_FLEET_INPLACE_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  cwd: REPO_ROOT,
  env: { ...process.env, GIT_FLEET_HOME: path.join(ROOT, 'fleet'), GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'), GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'), GIT_FLEET_PORT: String(PORT), GIT_FLEET_DEVICE_NAME: 'inplace-probe', NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = []; server.stdout.on('data', (d) => serverLog.push(String(d))); server.stderr.on('data', (d) => serverLog.push(String(d)));
let chrome = null;
const cleanup = () => { try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch { /* 已退出 */ } try { server.kill('SIGTERM'); } catch { /* 已退出 */ } };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

const base = `http://127.0.0.1:${PORT}`;
let healthy = false;
for (let i = 0; i < 60 && !healthy; i += 1) { try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* 还没起来 */ } if (!healthy) await sleep(500); }
if (!healthy) { console.error('后端没起来:\n' + serverLog.join('')); process.exit(1); }

const token = (await (await fetch(`${base}/api/session`)).json()).token;
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-git-fleet-token': token }, body: JSON.stringify(body ?? {}) }); const t = await r.text(); if (!r.ok) throw new Error(`POST ${p} ${r.status} ${t}`); return t ? JSON.parse(t) : {}; };
const { rootId } = await post('/api/repository-roots', { path: PROJECTS });
await post('/api/repositories', { rootId, relativePath: repo.name, name: repo.name, group: '探针', tags: [] });

const debugPort = await freePort();
const profileDir = path.join(ROOT, 'chrome-profile'); fs.mkdirSync(profileDir, { recursive: true });
const extraFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', ...extraFlags, 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
let version = null;
for (let i = 0; i < 40 && !version; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(500); } }
if (!version) { console.error('Chrome 没起来'); process.exit(2); }
const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = list.find((e) => e.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); return; } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push('err'); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text)); return result.value; };
const setViewport = (w, h = 950) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
const shotDir = path.join(ROOT, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
const shot = async (f) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, f), Buffer.from(data, 'base64')); };
const waitFor = async (fn, timeout = 20000, step = 300) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };

await send('Page.enable'); await send('Runtime.enable'); await setViewport(1440, 950); await send('Page.navigate', { url: base }); await sleep(3500);

// 打开仓库抽屉
const opened = await ev(`(() => { const row=[...document.querySelectorAll('.repo-table tbody tr')].find((r)=>r.querySelector('.repo-name')?.textContent.trim()==='repo-merge'); if(!row) return false; row.querySelector('.repo-name').click(); return true; })()`);
await sleep(2500);
const drawerOpen = await ev(`!!document.querySelector('.repo-workspace-shell')`);
// 点抽屉里的「合并」
await ev(`document.querySelector('.repo-workspace-shell .git-action-merge-lines')?.click()`);
const dialogOpened = await waitFor(async () => await ev(`!!document.querySelector('#batch-merge-title')`), 8000);
await sleep(800);
// 确认执行
await ev(`document.querySelector('.confirmation-confirm')?.click()`);
const dialogClosed = await waitFor(async () => await ev(`document.querySelector('#batch-merge-title') === null`), 8000);
// 等合并落盘
const merged = await waitFor(async () => {
  try { return gitAt(repo.work, 'show', 'dev:feature.txt') === 'feature' && gitAt(repo.work, 'show', 'main:feature.txt') === 'feature'; } catch { return false; }
}, 25000, 400);
await sleep(800);
const afterShell = await ev(`!!document.querySelector('.repo-workspace-shell')`);
const afterHistory = await ev(`!!document.querySelector('.history-drawer')`);
const afterTitle = await ev(`document.querySelector('#batch-merge-title') === null`);
await shot('01-after-merge-in-drawer.png');
record('单仓合并落点', [
  { n: '打开仓库抽屉', ok: opened && drawerOpen, d: `opened=${opened} shell=${drawerOpen}` },
  { n: '点抽屉「合并」弹出合并窗口', ok: dialogOpened, d: String(dialogOpened) },
  { n: '确认后合并窗口关闭', ok: dialogClosed, d: String(dialogClosed) },
  { n: 'dev/main 都已合入 feature', ok: merged, d: `merged=${merged}` },
  { n: '执行后仍留在仓库抽屉（未被踢回主界面）', ok: afterShell && afterTitle, d: `shell=${afterShell} mergeDialogGone=${afterTitle}` },
  { n: '没有自动打开「操作记录」抽屉', ok: afterHistory === false, d: `history=${afterHistory}` },
]);
record('运行时', [{ n: '控制台 0 条 error', ok: consoleErrors.length === 0, d: String(consoleErrors.length) }]);

const failed = results.filter((r) => !r.ok);
console.log('\n================ 结果 ================');
let g = '';
for (const r of results) { if (r.group !== g) { g = r.group; console.log(`\n[${g}]`); } console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.n}${r.d ? `  — ${r.d}` : ''}`); }
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
console.log(`截图在 ${shotDir}`);
cleanup();
process.exit(failed.length ? 1 : 0);
