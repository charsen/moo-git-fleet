#!/usr/bin/env node
/**
 * 「点 01 里的扫描目录 → 直接扫描，且 02 不再有选目录/扫描按钮」验收。
 * 用法：npm run verify:ui:scan-root
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_SCAN_ROOT ?? '/tmp/moo-fleet-scan-root';
const PROJECTS = path.join(ROOT, 'projects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (group, items) => { for (const it of items) results.push({ group, ...it }); };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome'); process.exit(2); }
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
for (const name of ['alpha-repo', 'beta-repo']) {
  const dir = path.join(PROJECTS, name); fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'P']); execFileSync('git', ['-C', dir, 'config', 'user.email', 'p@e.test']); execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']); execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
}

const PORT = Number(process.env.MOO_FLEET_SCAN_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], { cwd: REPO_ROOT, env: { ...process.env, GIT_FLEET_HOME: path.join(ROOT, 'fleet'), GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'), GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'), GIT_FLEET_PORT: String(PORT), GIT_FLEET_DEVICE_NAME: 'scan-probe', NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = []; server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
let chrome = null;
const cleanup = () => { try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch { /* */ } try { server.kill('SIGTERM'); } catch { /* */ } };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));
const base = `http://127.0.0.1:${PORT}`;
let healthy = false;
for (let i = 0; i < 60 && !healthy; i += 1) { try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* */ } if (!healthy) await sleep(500); }
if (!healthy) { console.error('后端没起来:\n' + log.join('')); process.exit(1); }
const token = (await (await fetch(`${base}/api/session`)).json()).token;
await fetch(`${base}/api/repository-roots`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-git-fleet-token': token }, body: JSON.stringify({ path: PROJECTS }) });

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
let seq = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); return; } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push('err'); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(String(exceptionDetails.exception?.description ?? exceptionDetails.text)); return result.value; };
const setViewport = (w, h = 950) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
const shotDir = path.join(ROOT, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
const shot = async (f) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, f), Buffer.from(data, 'base64')); };
const waitFor = async (fn, timeout = 15000, step = 300) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };

await send('Page.enable'); await send('Runtime.enable'); await setViewport(1440, 950); await send('Page.navigate', { url: base }); await sleep(3200);

const opened = await ev(`(() => { document.querySelector('.profile-chip')?.click(); return true; })()`);
await sleep(1200);
const navClicked = await ev(`(() => { const b=[...document.querySelectorAll('.manage-nav-item')].find((x)=>x.textContent.includes('仓库接入')); if(!b) return false; b.click(); return true; })()`);
await sleep(1200);
const rootRows = await ev(`document.querySelectorAll('.root-row').length`);
const scanToolbar = await ev(`!!document.querySelector('.scan-toolbar')`);
const scanRootSelect = await ev(`!!document.querySelector('.scan-root-select')`);
// 点第一行目录 → 应直接扫描
await ev(`(() => { const r=document.querySelector('.root-row'); if(r) r.click(); })()`);
const candidates = await waitFor(async () => (await ev(`document.querySelectorAll('.candidate-row').length`)) >= 2, 15000, 400);
const candCount = await ev(`document.querySelectorAll('.candidate-row').length`);
await shot('01-scan-root-click.png');
record('扫描根目录', [
  { n: '打开设置并进入「仓库接入」', ok: opened && navClicked && rootRows > 0, d: `nav=${navClicked} roots=${rootRows}` },
  { n: '02 不再有「选目录 + 扫描」工具条', ok: scanToolbar === false && scanRootSelect === false, d: `toolbar=${scanToolbar} select=${scanRootSelect}` },
  { n: '点目录行即扫描并列出候选仓库', ok: candidates && candCount >= 2, d: `候选 ${candCount}` },
]);
record('运行时', [{ n: '控制台 0 error', ok: consoleErrors.length === 0, d: String(consoleErrors.length) }]);
const failed = results.filter((r) => !r.ok);
console.log('\n==== 结果 ====');
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.n}${r.d ? ` — ${r.d}` : ''}`);
console.log(`\n合计 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`);
cleanup();
process.exit(failed.length ? 1 : 0);
