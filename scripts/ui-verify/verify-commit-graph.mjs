#!/usr/bin/env node
/**
 * 「提交图整页」验收：造含分叉/合并、多分支指向同一提交的仓 → 侧栏点「提交图」→
 * 断言整页视图出现、每行有泳道 SVG、合并提交空心点、分支标签名与 +N 折叠，并 1440/1024 截图。
 * 用法：node scripts/ui-verify/verify-commit-graph.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_GRAPH_ROOT ?? '/tmp/moo-fleet-graph';
const PROJECTS = path.join(ROOT, 'projects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, extra) => results.push({ name, ok, ...(extra ? { extra } : {}) });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome'); process.exit(2); }
// ROOT 会先被整目录删除：只允许落在系统临时目录下，避免环境变量写错时误删真实目录。
const allowedRoots = [path.resolve(os.tmpdir()), path.resolve('/tmp'), path.resolve('/private/tmp')];
if (!allowedRoots.some((root) => path.resolve(ROOT).startsWith(root + path.sep))) {
  console.error('MOO_FLEET_GRAPH_ROOT 必须位于临时目录（/tmp 或系统临时目录）下，拒绝清理：' + ROOT);
  process.exit(2);
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });

const repo = path.join(PROJECTS, 'graph-repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const g = (...a) => execFileSync('git', ['-C', repo, ...a]);
g('config', 'user.name', 'Moo Developer'); g('config', 'user.email', 'dev@example.test'); g('config', 'commit.gpgsign', 'false');
const commit = (msg, file = 'main.txt', body = msg) => { fs.writeFileSync(path.join(repo, file), body + '\n'); g('add', '-A'); g('commit', '-qm', msg); };
commit('init'); commit('base');
// 模拟 GitLens 那样：dev 上顺序合并一串 feature 分支，形成密集的多泳道树。
// 每个分支从**当时的 dev 顶端**分叉（真实习惯）；若都从 main 的初始提交分叉，所有泳道会一起挂到最底部，
// 图会被拉成十几列，不能反映真实仓库的形状。
g('branch', 'dev');
g('checkout', '-q', 'dev');
for (const name of ['fix-router', 'fix-bg', 'feat-contract', 'feat-crm', 'fix-workitem', 'feat-enterprise', 'feat-meeting', 'fix-menu', 'fix-process', 'fix-workplan', 'feat-scope', 'fix-wpwork']) {
  g('branch', name);
  g('checkout', '-q', name);
  commit('work on ' + name, name + '.txt');
  g('checkout', '-q', 'dev');
  g('merge', '--no-ff', '-q', '-m', "Merge branch '" + name + "' into dev", name);
}
g('checkout', '-q', 'main');
commit('main ahead', 'main-ahead.txt');
g('merge', '--no-ff', '-q', '-m', 'Merge dev into main', 'dev');
g('update-ref', 'refs/remotes/origin/dev', 'HEAD~1');
g('update-ref', 'refs/remotes/origin/main', 'HEAD');
g('branch', 'release', 'HEAD~2');
for (const name of ['hotfix-a', 'hotfix-b', 'hotfix-c', 'hotfix-d']) g('branch', name, 'HEAD');

const PORT = Number(process.env.MOO_FLEET_GRAPH_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  cwd: REPO_ROOT,
  env: { ...process.env, GIT_FLEET_HOME: path.join(ROOT, 'fleet'), GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'), GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'), GIT_FLEET_PORT: String(PORT), GIT_FLEET_DEVICE_NAME: 'graph-probe', NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = []; server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
let chrome = null;
const cleanup = () => { try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch { /* */ } try { server.kill('SIGTERM'); } catch { /* */ } };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

const base = 'http://127.0.0.1:' + PORT;
let healthy = false;
for (let i = 0; i < 60 && !healthy; i += 1) { try { healthy = (await fetch(base + '/api/health')).ok; } catch { /* */ } if (!healthy) await sleep(500); }
if (!healthy) { console.error('后端没起来:\n' + log.join('')); process.exit(1); }
const token = (await (await fetch(base + '/api/session')).json()).token;
const H = { 'content-type': 'application/json', 'x-git-fleet-token': token };
await fetch(base + '/api/repository-roots', { method: 'POST', headers: H, body: JSON.stringify({ path: PROJECTS }) });
const roots = await (await fetch(base + '/api/repository-roots', { headers: H })).json();
const rootId = Object.keys(roots ?? {}).find((k) => roots[k] === PROJECTS) ?? Object.keys(roots ?? {})[0];
if (!rootId) { console.error('未取到 rootId'); process.exit(1); }
await fetch(base + '/api/repositories', { method: 'POST', headers: H, body: JSON.stringify({ rootId, relativePath: 'graph-repo' }) });
await fetch(base + '/api/repositories/refresh', { method: 'POST', headers: H });

const debugPort = await freePort();
const profileDir = path.join(ROOT, 'chrome-profile'); fs.mkdirSync(profileDir, { recursive: true });
const extra = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profileDir, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', ...extra, 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
let version = null;
for (let i = 0; i < 40 && !version; i += 1) { try { version = await (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).json(); } catch { await sleep(500); } }
if (!version) { console.error('Chrome 没起来'); process.exit(2); }
const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
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
await waitFor(async () => (await ev("document.querySelectorAll('.repo-table tbody tr').length")) >= 1, 15000);
await ev("(() => { const r=document.querySelector('.repo-table tbody tr'); r&&r.click(); })()");
const navReady = await waitFor(async () => (await ev("[...document.querySelectorAll('.workspace-nav button')].some(b=>b.textContent.includes('提交图'))")), 15000);
record('侧栏出现「提交图」入口', navReady);
await ev("(() => { const b=[...document.querySelectorAll('.workspace-nav button')].find(x=>x.textContent.includes('提交图')); b&&b.click(); })()");
const viewReady = await waitFor(async () => (await ev("document.querySelectorAll('.workspace-graph').length")) >= 1, 15000);
record('提交图整页视图出现', viewReady);
const rowsReady = await waitFor(async () => (await ev("document.querySelectorAll('.graph-row').length")) >= 4, 15000);
record('渲染出多行提交', rowsReady, { rows: await ev("document.querySelectorAll('.graph-row').length") });
// 整页宽：图区应明显宽于一个侧栏列（>600px），并与工作区右侧等宽。
const widthInfo = await ev("(() => { const g=document.querySelector('.workspace-graph'); return g ? { w: g.getBoundingClientRect().width, h: g.getBoundingClientRect().height } : null; })()");
record('提交图为整页宽（>600px）', !!widthInfo && widthInfo.w > 600, widthInfo || undefined);
// 整图一张连续 SVG：覆盖层 path 数应远多于行数（含穿过线与曲线），且圆点数=行数。
const graphInfo = await ev("(() => { const rows=document.querySelectorAll('.graph-row').length; const overlay=document.querySelector('.graph-overlay'); const paths=overlay?overlay.querySelectorAll('path').length:0; const circles=overlay?overlay.querySelectorAll('circle').length:0; return { rows, paths, circles }; })()");
record('存在整图连续 SVG 覆盖层', graphInfo.rows > 0 && graphInfo.paths > 0, graphInfo);
record('连线 path 数多于行数（有穿过线）', graphInfo.paths > graphInfo.rows, graphInfo);
record('每个提交有一个圆节点', graphInfo.circles === graphInfo.rows, graphInfo);
const mergeDots = await ev("document.querySelectorAll('.graph-overlay circle.graph-node-merge').length");
record('合并提交节点存在（放大空心）', mergeDots > 0, { mergeDots });
// 连续性检查：整图 SVH 高度应等于 行数 * 行高，避免行间接缝。
const overlayH = await ev("(() => { const o=document.querySelector('.graph-overlay'); return o?o.getBoundingClientRect().height:0; })()");
const rowH = await ev("(() => { const r=document.querySelector('.graph-row'); return r?r.getBoundingClientRect().height:0; })()");
record('覆盖层高度=行数×行高（无接缝）', overlayH > 0 && rowH > 0 && Math.abs(overlayH - graphInfo.rows * rowH) < 2, { overlayH, rowH, rows: graphInfo.rows });
// 几何连续性：每条 path 的终点要么是最后一行下沿，要么下一段必须从同一位置（x,y）开始；
// 这是「合并提交处留一截悬空线头」的回归断言，只靠肉眼很容易漏。
const geometry = await ev("(() => { const paths=[...document.querySelectorAll('.graph-overlay path')]; const segs=paths.map(p=>{const n=(p.getAttribute('d')||'').match(/-?[0-9.]+/g).map(Number); return {x0:n[0],y0:n[1],x1:n[n.length-2],y1:n[n.length-1]};}); const rowH=48; const rows=document.querySelectorAll('.graph-row').length; const starts=new Set(segs.map(s=>s.x0+','+s.y0)); const dangling=segs.filter(s=>s.y1>0 && s.y1%rowH===0 && s.y1<rows*rowH && !starts.has(s.x1+','+s.y1)); const offLane=segs.filter(s=>((s.x0-9)%18)!==0 || ((s.x1-9)%18)!==0); return {paths:segs.length,dangling:dangling.length,offLane:offLane.length,sample:dangling.slice(0,3)}; })()");
// 密集模式下列宽会被压缩，18px 的列位假设不成立；只校验悬空端点。
const denseOverlay = await ev("!!document.querySelector('.graph-overlay--dense')");
record('连线无悬空端点（每条下线都接到下一行）', geometry.dangling === 0 && (denseOverlay || geometry.offLane === 0), { ...geometry, denseOverlay });
const strokeWidths = await ev("(() => { const paths=[...document.querySelectorAll('.graph-overlay path')]; const primary=paths.find(p=>p.classList.contains('graph-lane-primary')); const normal=paths.find(p=>!p.classList.contains('graph-lane-primary')); return { primary: primary?parseFloat(getComputedStyle(primary).strokeWidth):0, normal: normal?parseFloat(getComputedStyle(normal).strokeWidth):0 }; })()");
record('主干泳道线宽大于普通泳道（CSS 优先级回归）', strokeWidths.primary > strokeWidths.normal, strokeWidths);
const refs = await ev("[...document.querySelectorAll('.graph-ref-branch')].map(b=>b.textContent.trim())");
record('分支标签显示具体分支名', /dev|main|feat|release/.test(refs.join(' ')), { sample: refs.slice(0, 12) });
const folded = await ev("[...document.querySelectorAll('.graph-ref-branch')].map(b=>b.textContent.trim()).filter(t=>/^\\+\\d+$/.test(t))");
record('多分支时出现 +N 折叠', folded.length > 0, { folded });
// —— 键盘浏览：方向键只移动焦点，不能顺手打开提交（Enter/空格才是打开） —— //
const arrowMove = await ev("(() => { const rows=[...document.querySelectorAll('.graph-row')]; rows[0].focus(); const startFocused = document.activeElement===rows[0]; rows[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); const graph=document.querySelector('.workspace-graph'); const visible = graph ? getComputedStyle(graph).display !== 'none' : false; return { startFocused, moved: document.activeElement===rows[1], visible }; })()");
record('↓ 只移动焦点、不直接打开提交', arrowMove.startFocused && arrowMove.moved && arrowMove.visible, arrowMove);
await ev("(() => { const rows=[...document.querySelectorAll('.graph-row')]; rows[0]?.focus(); })()");

// —— 搜索：输入关键词必须真的走服务端缩列表，清空后恢复 —— //
// 测量前先等列表收敛（页脚出现「全部记录」）：首屏 20 行只是分页瞬态，无限滚动会
// 继续补齐到全史；拿瞬态值当基线会出现「清空后 28 ≠ 搜索前 20」的假失败。
const waitForSettled = async () => {
  for (let i = 0; i < 20; i++) {
    const footer = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
    if (footer.includes('全部记录')) break;
    await sleep(250);
  }
};
await waitForSettled();
const beforeSearchRows = await ev("document.querySelectorAll('.graph-row').length");
await ev("(() => { const i=document.querySelector('.workspace-graph-search input'); i.value='fix-wpwork'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
await sleep(1500);
const searchedRows = await ev("document.querySelectorAll('.graph-row').length");
const searchedFooter = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
record('搜索关键词缩小提交列表', searchedRows > 0 && searchedRows < beforeSearchRows, { beforeSearchRows, searchedRows, searchedFooter });
await ev("(() => { const i=document.querySelector('.workspace-graph-search input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
await waitForSettled();
await sleep(300);
const restoredRows = await ev("document.querySelectorAll('.graph-row').length");
record('清空搜索恢复完整列表', restoredRows === beforeSearchRows, { restoredRows, beforeSearchRows });

// —— 搜索字段切换：作者 / 标题 —— //
await ev("(() => { const t=document.querySelector('.workspace-graph-field .select-menu-trigger'); t&&t.click(); })()");
await sleep(300);
await ev("(() => { const o=[...document.querySelectorAll('.select-menu-option')].find(o=>o.textContent.trim().startsWith('作者')); o&&o.click(); })()");
await sleep(500);
await ev("(() => { const i=document.querySelector('.workspace-graph-search input'); i.value='Moo Developer'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
await sleep(1800);
const authorRows = await ev("document.querySelectorAll('.graph-row').length");
const authorFooter = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
record('切到作者字段搜索仍能命中', authorRows > 0 && authorFooter.includes('匹配'), { authorRows, authorFooter });
await ev("(() => { const i=document.querySelector('.workspace-graph-search input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
await sleep(1500);
await ev("(() => { const t=document.querySelector('.workspace-graph-field .select-menu-trigger'); t&&t.click(); })()");
await sleep(300);
await ev("(() => { const o=[...document.querySelectorAll('.select-menu-option')].find(o=>o.textContent.trim().startsWith('标题')); o&&o.click(); })()");
await sleep(1200);
const backTitleFooter = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
record('切回标题字段并恢复列表', backTitleFooter.includes('已加载') && !backTitleFooter.includes('匹配'), { backTitleFooter });

// —— 排序切换：默认拓扑序（合并成组），可切时间序再切回 —— //
const sortPresent = await ev("document.querySelectorAll('.workspace-graph-sort .select-menu-trigger').length");
record('提交图有排序切换', sortPresent > 0);
const defaultFooter = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
record('默认按拓扑序', defaultFooter.includes('拓扑序'), { defaultFooter });
await ev("(() => { const t=document.querySelector('.workspace-graph-sort .select-menu-trigger'); t&&t.click(); })()");
await sleep(300);
const dateOption = await waitFor(async () => (await ev("[...document.querySelectorAll('.select-menu-option')].some(o=>o.textContent.includes('时间序'))")), 5000);
record('排序菜单列出时间序', dateOption);
await ev("(() => { const o=[...document.querySelectorAll('.select-menu-option')].find(o=>o.textContent.includes('时间序')); o&&o.click(); })()");
await sleep(1600);
const dateRows = await ev("document.querySelectorAll('.graph-row').length");
const dateFooter = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
record('切到时间序后列表仍正常', dateRows > 0 && dateFooter.includes('时间序'), { dateRows, dateFooter });
await ev("(() => { const t=document.querySelector('.workspace-graph-sort .select-menu-trigger'); t&&t.click(); })()");
await sleep(300);
await ev("(() => { const o=[...document.querySelectorAll('.select-menu-option')].find(o=>o.textContent.includes('拓扑序')); o&&o.click(); })()");
await sleep(1600);
const topoFooter2 = await ev("document.querySelector('.workspace-graph-footer')?.textContent ?? ''");
record('切回拓扑序', topoFooter2.includes('拓扑序'), { topoFooter2 });

// —— 分支切换：提交图应能切换看不同分支的树，且不 checkout —— //
const selectorPresent = await ev("document.querySelectorAll('.workspace-graph-ref .select-menu-trigger').length");
record('提交图有分支切换选择器', selectorPresent > 0);
const allRows = await ev("document.querySelectorAll('.graph-row').length");
await ev("(() => { const t=document.querySelector('.workspace-graph-ref .select-menu-trigger'); t&&t.click(); })()");
await sleep(300);
const devOption = await waitFor(async () => (await ev("[...document.querySelectorAll('.select-menu-option')].some(o=>o.textContent.trim().startsWith('dev'))")), 5000);
record('选择器列出 dev 分支', devOption);
await ev("(() => { const o=[...document.querySelectorAll('.select-menu-option')].find(o=>o.textContent.trim().startsWith('dev')); o&&o.click(); })()");
await sleep(1200);
const devRows = await ev("document.querySelectorAll('.graph-row').length");
record('切到 dev 后提交数变化（分支视图≠全部分支）', devRows > 0 && devRows !== allRows, { allRows, devRows });
const footerHasDev = await ev("(() => { const f=document.querySelector('.workspace-graph-footer'); return f?f.textContent.includes('dev'):false; })()");
record('页脚显示当前分支 dev', footerHasDev);
await ev("(() => { const t=document.querySelector('.workspace-graph-ref .select-menu-trigger'); t&&t.click(); })()");
await sleep(300);
await ev("(() => { const o=[...document.querySelectorAll('.select-menu-option')].find(o=>o.textContent.trim().startsWith('全部分支')); o&&o.click(); })()");
await sleep(1200);
const backRows = await ev("document.querySelectorAll('.graph-row').length");
record('切回全部分支恢复原提交数', backRows === allRows, { backRows, allRows });

// ⌘K 应聚焦当前视图的搜索框；提交图的占位文案承诺了它，不能落到「工作区」的文件搜索。
await ev("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 4, windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 40 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 4, windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 40 });
await sleep(200);
const cmdKFocused = await ev("document.activeElement && document.activeElement.closest ? (document.activeElement.closest('.workspace-graph-search') ? 'graph-search' : (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName)) : 'none'");
record('⌘K 聚焦提交图搜索框', cmdKFocused === 'graph-search', { focused: cmdKFocused });

// 点击一行应跳到提交历史查看该提交
await ev("(() => { const r=document.querySelector('.graph-row'); r&&r.click(); })()");
const openedHistory = await waitFor(async () => (await ev("document.querySelectorAll('.workspace-commit-preview .workspace-commit-meta').length")) > 0 || (await ev("document.querySelectorAll('.workspace-commit').length")) > 0, 8000);
record('点击提交可打开该提交历史', openedHistory);
// 回到提交图再截图
await ev("(() => { const b=[...document.querySelectorAll('.workspace-nav button')].find(x=>x.textContent.includes('提交图')); b&&b.click(); })()");
await waitFor(async () => (await ev("document.querySelectorAll('.graph-row').length")) >= 4, 8000);
await shot('01-graph-page-1440.png');
await setViewport(1024, 900); await sleep(600); await shot('02-graph-page-1024.png');
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.extra ? '  ' + JSON.stringify(r.extra) : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
console.log('截图：' + shotDir);
cleanup();
process.exit(failed.length ? 1 : 0);