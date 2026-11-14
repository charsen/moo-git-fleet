#!/usr/bin/env node
/**
 * 「工作区文件默认树形」升级的补充边界验收：
 *  A) 兼容老用户：localStorage 已存 fileListView='flat' 时仍按平铺（不被强制改树形）。
 *  B) 根目录单文件仓：工作区能正常渲染，无目录行、不报错。
 * 用法：node scripts/ui-verify/verify-workspace-file-tree-compat.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_TREE_COMPAT_ROOT ?? '/tmp/moo-fleet-tree-compat';
const PROJECTS = path.join(ROOT, 'projects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KEY = 'moo-fleet:view-preferences:v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, extra) => results.push({ name, ok, ...(extra ? { extra } : {}) });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome'); process.exit(2); }

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
function makeRepo(name, files) {
  const dir = path.join(PROJECTS, name); fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a]);
  g('config', 'user.name', 'P'); g('config', 'user.email', 'p@e.test'); g('config', 'commit.gpgsign', 'false');
  for (const p of files) { const fp = path.join(dir, p); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, 'base\n'); }
  g('add', '-A'); g('commit', '-qm', 'base');
  for (const p of files) fs.appendFileSync(path.join(dir, p), 'change\n'); // 弄脏
  return dir;
}
makeRepo('flat-pref-repo', ['src/a/x.ts', 'src/b/y.ts']);
makeRepo('root-files-repo', ['only.txt', 'another.md']);

const PORT = Number(process.env.MOO_FLEET_TREE_COMPAT_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  cwd: REPO_ROOT,
  env: { ...process.env, GIT_FLEET_HOME: path.join(ROOT, 'fleet'), GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'), GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'), GIT_FLEET_PORT: String(PORT), GIT_FLEET_DEVICE_NAME: 'tree-compat', NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = []; server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
let chrome = null;
const cleanup = () => { try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch { /* */ } try { server.kill('SIGTERM'); } catch { /* */ } };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

const base = `http://127.0.0.1:${PORT}`;
let healthy = false;
for (let i = 0; i < 60 && !healthy; i += 1) { try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* */ } if (!healthy) await sleep(500); }
if (!healthy) { console.error('后端没起来:\n' + log.join('')); process.exit(1); }
const token = (await (await fetch(`${base}/api/session`)).json()).token;
const H = { 'content-type': 'application/json', 'x-git-fleet-token': token };
await fetch(`${base}/api/repository-roots`, { method: 'POST', headers: H, body: JSON.stringify({ path: PROJECTS }) });
const roots = await (await fetch(`${base}/api/repository-roots`, { headers: H })).json();
const rootId = Object.keys(roots ?? {}).find((k) => roots[k] === PROJECTS) ?? Object.keys(roots ?? {})[0];
for (const rel of ['flat-pref-repo', 'root-files-repo']) {
  const r = await fetch(`${base}/api/repositories`, { method: 'POST', headers: H, body: JSON.stringify({ rootId, relativePath: rel }) });
  if (![200, 201].includes(r.status)) { console.error('接入失败', rel, r.status, await r.text()); process.exit(1); }
}
await fetch(`${base}/api/repositories/refresh`, { method: 'POST', headers: H });

const debugPort = await freePort();
const profileDir = path.join(ROOT, 'chrome-profile'); fs.mkdirSync(profileDir, { recursive: true });
const extra = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', ...extra, 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
let version = null;
for (let i = 0; i < 40 && !version; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(500); } }
const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = list.find((e) => e.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text)); return result.value; };
const setViewport = (w, h = 950) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
const shotDir = path.join(ROOT, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
const shot = async (f) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, f), Buffer.from(data, 'base64')); };
const waitFor = async (fn, timeout = 15000, step = 300) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };

await send('Page.enable'); await send('Runtime.enable'); await setViewport(1440, 950);

// —— A) 预置 localStorage: flat 偏好，然后打开应用 ——
await send('Page.navigate', { url: base }); await sleep(1500);
await ev(`localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({ repositorySort:'activity', repositoryFilter:'all', repositoryGroup:null, batchScope:'visible', fileListView:'flat' }))`);
await send('Page.navigate', { url: base }); await sleep(3200);

const openRepo = async (name) => {
  await waitFor(async () => (await ev(`[...document.querySelectorAll('.repo-table tbody tr')].some(r=>r.textContent.includes(${JSON.stringify(name)}))`)), 15000);
  await ev(`(() => { const r=[...document.querySelectorAll('.repo-table tbody tr')].find(x=>x.textContent.includes(${JSON.stringify(name)})); r&&r.click(); })()`);
  await waitFor(async () => (await ev(`document.querySelectorAll('.repo-workspace-shell .workspace-file-row, .repo-workspace-shell .file-tree-directory').length`)) > 0, 15000);
};

// A: flat-pref-repo 应仍为平铺（无目录行，按钮显“平铺”）
await openRepo('flat-pref-repo');
const aDir = await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory').length`);
const aToggle = await ev(`(() => { const b=document.querySelector('.repo-workspace-shell .file-tree-toggle'); return b?{text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed')}:null; })()`);
record('A 老用户 flat 偏好被尊重（无目录行）', aDir === 0, { aDir });
record('A 按钮显示“平铺”aria-pressed=false', !!aToggle && /平铺/.test(aToggle.text) && aToggle.pressed === 'false', aToggle || undefined);
await shot('A-flat-pref-honored.png');
// 关闭抽屉（Esc）
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(800);

// —— B) root-files-repo（根目录单层文件）应正常渲染、无目录行、无异常 ——
await openRepo('root-files-repo');
const bRows = await ev(`document.querySelectorAll('.repo-workspace-shell .workspace-file-row').length`);
const bDir = await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory').length`);
record('B 根目录单层文件正常渲染（有文件行）', bRows >= 2, { bRows });
record('B 无子目录时不出现目录行', bDir === 0, { bDir });
await shot('B-root-files-tree.png');

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  ' + JSON.stringify(r.extra) : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
console.log('截图：' + shotDir);
cleanup();
process.exit(failed.length ? 1 : 0);
