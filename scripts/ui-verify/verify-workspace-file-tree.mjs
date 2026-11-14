#!/usr/bin/env node
/**
 * 「工作区文件默认按目录树（文件夹汇总）显示，保留平铺切换」验收。
 * 造一个含多级目录文件的仓 → 打开工作区抽屉 → 断言默认即树形（目录行存在、按钮显“树形”、aria-pressed=true）
 * → 点切平铺（目录行消失、按钮显“平铺”）→ 再切回树形。
 * 用法：node scripts/ui-verify/verify-workspace-file-tree.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_TREE_ROOT ?? '/tmp/moo-fleet-tree';
const PROJECTS = path.join(ROOT, 'projects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, extra) => results.push({ name, ok, ...(extra ? { extra } : {}) });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome'); process.exit(2); }
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });

// 造仓：多级目录 + 已跟踪文件改动 → 工作区有文件可展示
const repo = path.join(PROJECTS, 'tree-repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const g = (...a) => execFileSync('git', ['-C', repo, ...a]);
g('config', 'user.name', 'P'); g('config', 'user.email', 'p@e.test'); g('config', 'commit.gpgsign', 'false');
for (const p of ['src/client/app.ts', 'src/client/view.ts', 'src/server/api.ts', 'docs/readme.md', 'root.txt']) {
  const fp = path.join(repo, p); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, 'base\n');
}
g('add', '-A'); g('commit', '-qm', 'base');
// 改动多个目录文件（制造 dirty 工作区，含跨目录）
for (const p of ['src/client/app.ts', 'src/server/api.ts', 'docs/readme.md']) fs.appendFileSync(path.join(repo, p), 'change\n');

const PORT = Number(process.env.MOO_FLEET_TREE_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  cwd: REPO_ROOT,
  env: { ...process.env, GIT_FLEET_HOME: path.join(ROOT, 'fleet'), GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'), GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'), GIT_FLEET_PORT: String(PORT), GIT_FLEET_DEVICE_NAME: 'tree-probe', NODE_OPTIONS: '' },
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
// 显式接入仓库（扫描只返回候选；接入用 /api/repositories）
const roots = await (await fetch(`${base}/api/repository-roots`, { headers: H })).json();
// roots 是 Record<id,path>
const rootId = Object.keys(roots ?? {}).find((k) => roots[k] === PROJECTS) ?? Object.keys(roots ?? {})[0];
if (!rootId) { console.error('未取到 rootId, roots=', JSON.stringify(roots).slice(0,300)); process.exit(1); }
const addResp = await fetch(`${base}/api/repositories`, { method: 'POST', headers: H, body: JSON.stringify({ rootId, relativePath: 'tree-repo' }) });
if (addResp.status !== 201 && addResp.status !== 200) { console.error('接入仓库失败', addResp.status, await addResp.text()); process.exit(1); }
// 触发一次刷新，确保 dashboard 拉取到状态与改动文件
await fetch(`${base}/api/repositories/refresh`, { method: 'POST', headers: H });

const debugPort = await freePort();
const profileDir = path.join(ROOT, 'chrome-profile'); fs.mkdirSync(profileDir, { recursive: true });
const extra = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', ...extra, 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
let version = null;
for (let i = 0; i < 40 && !version; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(500); } }
if (!version) { console.error('Chrome 没起来'); process.exit(2); }
const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = list.find((e) => e.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text)); return result.value; };
const setViewport = (w, h = 950) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
const shotDir = path.join(ROOT, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
const shot = async (f) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, f), Buffer.from(data, 'base64')); };
const waitFor = async (fn, timeout = 15000, step = 300) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };

await send('Page.enable'); await send('Runtime.enable'); await setViewport(1440, 950); await send('Page.navigate', { url: base }); await sleep(3200);

// 等仓库出现并点开
await waitFor(async () => (await ev(`document.querySelectorAll('.repo-table tbody tr').length`)) >= 1, 15000);
await ev(`(() => { const r=document.querySelector('.repo-table tbody tr'); r&&r.click(); })()`);
// 等工作区抽屉里的文件列表出现
const listReady = await waitFor(async () => (await ev(`document.querySelectorAll('.repo-workspace-shell .workspace-file-row, .repo-workspace-shell .file-tree-directory').length`)) > 0, 15000);
record('工作区文件列表出现', listReady);

// 1) 默认应为树形：存在目录行
const dirRows = await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory').length`);
record('默认即树形（存在目录行）', dirRows > 0, { dirRows });

// 2) 切换按钮默认处于“树形”态
const toggleInfo = await ev(`(() => { const b=document.querySelector('.repo-workspace-shell .file-tree-toggle'); if(!b) return null; return { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') }; })()`);
record('切换按钮显示“树形”', !!toggleInfo && /树形/.test(toggleInfo.text), toggleInfo || undefined);
record('切换按钮 aria-pressed=true', !!toggleInfo && toggleInfo.pressed === 'true', toggleInfo || undefined);

// 3) 文件行应有缩进（depth>0 的 --tree-depth）
const hasIndentedFile = await ev(`(() => { const rows=[...document.querySelectorAll('.repo-workspace-shell .workspace-file-row, .repo-workspace-shell .file-tree-file')]; return rows.some(r=>{ const d=getComputedStyle(r).getPropertyValue('--tree-depth'); return d && parseInt(d,10) > 0; }); })()`);
record('树形下文件行有层级缩进', hasIndentedFile);
await shot('01-workspace-default-tree.png');

// 4) 切到平铺：目录行应消失
await ev(`(() => { const b=document.querySelector('.repo-workspace-shell .file-tree-toggle'); b&&b.click(); })()`);
await sleep(600);
const dirAfterFlat = await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory').length`);
const toggleAfterFlat = await ev(`(() => { const b=document.querySelector('.repo-workspace-shell .file-tree-toggle'); return b?{text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed')}:null; })()`);
record('切平铺后目录行消失', dirAfterFlat === 0, { dirAfterFlat });
record('切平铺后按钮显示“平铺”', !!toggleAfterFlat && /平铺/.test(toggleAfterFlat.text), toggleAfterFlat || undefined);
await shot('02-workspace-flat.png');

// 5) 再切回树形
await ev(`(() => { const b=document.querySelector('.repo-workspace-shell .file-tree-toggle'); b&&b.click(); })()`);
await sleep(600);
const dirBack = await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory').length`);
record('再切回树形目录行恢复', dirBack > 0, { dirBack });
await shot('03-workspace-back-tree.png');

// 输出
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  ' + JSON.stringify(r.extra) : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
console.log('截图：' + shotDir);
cleanup();
process.exit(failed.length ? 1 : 0);
