#!/usr/bin/env node
/**
 * 「双线合并」专项真机验收。
 *
 * 为什么不并进 verify.mjs：那套断言用 docs 截图共用夹具、写死行数与分组；要测
 * 「把任务分支合回 dev + 主分支」得造带任务分支的本地仓库，会改掉那批断言。这里
 * 自建夹具、自起实例（dist 打包产物），互不干扰。
 *
 * 断言分七段：
 *  1. 工作台「合并」入口存在、可点、title 正确；
 *  2. 弹窗结构：标题、逐仓明细（目标线 + 源分支 + 每条线的快进/合并提交）、脏仓整仓跳过并说明；
 *  3. 交互：取消勾选后确认按钮禁用且计数归零，重新勾选恢复；
 *  4. 1024 视口无横向溢出、弹窗不超宽；
 *  5. 确认执行后磁盘上 dev / main 真的拿到了任务分支内容，且切回原任务分支；
 *  6. 批次记录为 merge-branches 且成功 1、脏仓不入队；
 *  7. 控制台 0 条 error。
 *
 * 用法：npm run verify:ui:merge
 * 环境变量：MOO_FLEET_MERGE_ROOT / MOO_FLEET_MERGE_PORT / MOO_FLEET_UI_CHROME_FLAGS / CHROME
 * 退出码：全部通过为 0，有失败项为 1。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_MERGE_ROOT ?? '/tmp/moo-fleet-merge-verify';
const PROJECTS = path.join(ROOT, 'projects');
const REMOTES = path.join(ROOT, 'remotes');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const record = (group, items) => {
  for (const item of items) results.push({ group, ...item });
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

if (!fs.existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}\n用 CHROME=/path/to/chrome 指定。`);
  process.exit(2);
}

if (fs.existsSync(ROOT)) {
  const entries = fs.readdirSync(ROOT);
  const looksOurs = entries.length === 0 || entries.includes('fleet') || entries.includes('projects') || entries.includes('remotes');
  if (!looksOurs) {
    console.error(`拒绝清空 ${ROOT}：里面不像本脚本的夹具目录（${entries.slice(0, 5).join(', ')}）。`);
    process.exit(2);
  }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(REMOTES, { recursive: true });

const gitAt = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * 造一个带任务分支的仓库：远端有 main（可选 dev），本地从 main 拉出 `feature` 并提交。
 * `dirty` 时在 feature 上留一笔未提交改动 —— 双线合并要求工作区干净，这类仓整仓跳过。
 */
function makeMergeRepo(name, { withDev, dirty }) {
  const remote = path.join(REMOTES, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  const work = path.join(PROJECTS, name);
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...args) => gitAt(work, ...args);
  g('config', 'user.name', 'Merge Probe');
  g('config', 'user.email', 'probe@merge-lab.example');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: 初始化');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  if (withDev) {
    g('branch', 'dev');
    g('push', '-q', '-u', 'origin', 'dev');
  }
  // 本地任务分支：从 main 拉出，加一个文件（尚未推送 —— 这正是「干完活合回双线」的现场）。
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  g('add', 'feature.txt');
  g('commit', '-q', '-m', 'feature work');
  if (dirty) fs.writeFileSync(path.join(work, 'feature.txt'), 'feature dirty\n');
  return { name, work, remote, withDev, dirty };
}

/**
 * 造一个「已同步、没有可合并内容但留着已合并任务分支」的仓库：
 * feature 已经快进合进 dev 与 main（三条指向同一提交），当前仍停在 feature。
 * 这种仓在双线合并里没有源分支，只有「可清理的已合并分支」。
 */
function makeMergeSyncedRepo(name) {
  const remote = path.join(REMOTES, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  const work = path.join(PROJECTS, name);
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...args) => gitAt(work, ...args);
  g('config', 'user.name', 'Merge Probe');
  g('config', 'user.email', 'probe@merge-lab.example');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: 初始化');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  g('branch', 'dev');
  g('push', '-q', '-u', 'origin', 'dev');
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  g('add', 'feature.txt');
  g('commit', '-q', '-m', 'feature work');
  // feature 快进合进 main 与 dev，再切回 feature：已是「无内容可合并、但可清理」。
  g('checkout', '-q', 'main');
  g('merge', '--ff-only', '-q', 'feature');
  g('checkout', '-q', 'dev');
  g('merge', '--ff-only', '-q', 'feature');
  g('checkout', '-q', 'feature');
  return { name, work, remote, withDev: true, dirty: false };
}

const repos = [
  makeMergeRepo('merge-alpha', { withDev: true, dirty: false }),
  makeMergeRepo('merge-dirty', { withDev: true, dirty: true }),
  makeMergeSyncedRepo('merge-synced'),
];
const alpha = repos[0];
const synced = repos[2];

console.log('== 夹具 ==');
for (const repo of repos) {
  console.log(`  ${repo.name}: 当前 ${gitAt(repo.work, 'rev-parse', '--abbrev-ref', 'HEAD')}${repo.dirty ? '（工作区不干净）' : ''}`);
}

// ---------- 服务端 ----------
const PORT = Number(process.env.MOO_FLEET_MERGE_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    GIT_FLEET_HOME: path.join(ROOT, 'fleet'),
    GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'),
    GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'),
    GIT_FLEET_PORT: String(PORT),
    GIT_FLEET_DEVICE_NAME: 'merge-probe',
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

let chrome = null;
const cleanup = () => {
  try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  try { server.kill('SIGTERM'); } catch { /* 已退出 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const base = `http://127.0.0.1:${PORT}`;
let healthy = false;
for (let i = 0; i < 60 && !healthy; i += 1) {
  try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* 还没起来 */ }
  if (!healthy) await sleep(500);
}
if (!healthy) {
  console.error('后端没起来：\n' + serverLog.join(''));
  process.exit(1);
}
console.log(`== 实例已就绪：${base}`);

// ---------- 播种 ----------
const token = (await (await fetch(`${base}/api/session`)).json()).token;
const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-git-fleet-token': token },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
};
const { rootId } = await post('/api/repository-roots', { path: PROJECTS });
const ids = {};
for (const repo of repos) {
  const created = await post('/api/repositories', { rootId, relativePath: repo.name, name: repo.name, group: '探针', tags: [] });
  ids[repo.name] = created.id;
}

// ---------- Chrome + CDP ----------
const debugPort = await freePort();
const profileDir = path.join(ROOT, 'chrome-profile');
fs.mkdirSync(profileDir, { recursive: true });
const extraFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu')
  .split(/\s+/).filter(Boolean);
chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1',
  ...extraFlags, 'about:blank',
], { stdio: 'ignore', detached: true });
chrome.unref();

let version = null;
for (let i = 0; i < 40 && !version; i += 1) {
  try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(500); }
}
if (!version) {
  console.error('Chrome 调试端口没起来。受限环境用 MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu" 重跑。');
  process.exit(2);
}
const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = list.find((e) => e.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200));
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
const shotDir = path.join(ROOT, 'shots');
fs.mkdirSync(shotDir, { recursive: true });
const shot = async (file) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, file), Buffer.from(data, 'base64'));
};
const waitFor = async (fn, timeoutMs = 8000, step = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await setViewport(1440, 950);
await send('Page.navigate', { url: base });
await sleep(3500);

// ---------- 阶段 1：入口 ----------
console.log('\n== 阶段 1：合并入口 ==');
const mergeBtn = await ev(`(() => {
  const b = [...document.querySelectorAll('.batch-actions button')].find((x) => x.textContent.trim().startsWith('合并'));
  return b ? { text: b.textContent.replace(/\\s+/g, ' ').trim(), title: b.title, disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') } : null;
})()`);
record('双线合并-入口', [
  { n: '工作台存在「合并」按钮', ok: mergeBtn !== null, d: mergeBtn ? mergeBtn.text : 'absent' },
  { n: '入口可点（范围里有可合并仓库）', ok: mergeBtn !== null && mergeBtn.disabled === false, d: mergeBtn ? `disabled=${mergeBtn.disabled} aria-disabled=${mergeBtn.ariaDisabled}` : 'absent' },
  { n: 'title 说明做法（合回双线、只做本地）', ok: mergeBtn !== null && mergeBtn.title.includes('合回两条线'), d: mergeBtn ? mergeBtn.title : 'absent' },
]);
if (mergeBtn !== null) {
  await ev(`(() => { const b = [...document.querySelectorAll('.batch-actions button')].find((x) => x.textContent.trim().startsWith('合并')); if (b) b.click(); })()`);
}
await sleep(1600);

// ---------- 阶段 2：弹窗结构与逐仓明细 ----------
console.log('== 阶段 2：弹窗结构与逐仓明细 ==');
const dialogTitle = await ev(`document.querySelector('#batch-merge-title')?.textContent.trim() ?? ''`);
const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.batch-push-list li')].map((li) => ({
  name: li.querySelector('strong')?.textContent.trim() ?? '',
  targets: (li.querySelector('.batch-push-targets')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  sources: [...li.querySelectorAll('.batch-merge-source')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
  small: (li.querySelector('small')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  blocked: li.getAttribute('data-blocked'),
  checkboxDisabled: li.querySelector('input')?.disabled === true,
})))`));
const alphaRow = rows.find((r) => r.name === 'merge-alpha');
const dirtyRow = rows.find((r) => r.name === 'merge-dirty');
const syncedRow = rows.find((r) => r.name === 'merge-synced');
const confirmLabel = await ev(`(document.querySelector('.confirmation-confirm')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
const footerLeft = await ev(`(document.querySelector('.confirmation-footer > span')?.textContent ?? '').trim()`);
const cleanupBox = await ev(`(() => {
  const b = document.querySelector('.batch-merge-cleanup input');
  return b ? { checked: b.checked === true, disabled: b.disabled === true, label: (document.querySelector('.batch-merge-cleanup')?.textContent ?? '').replace(/\\s+/g, ' ').trim() } : null;
})()`);
await shot('01-merge-dialog-1440.png');
record('双线合并-弹窗', [
  { n: '标题是「双线合并」', ok: dialogTitle === '双线合并', d: dialogTitle || 'none' },
  { n: '列出 3 个仓库', ok: rows.length === 3, d: `行数 ${rows.length}` },
  { n: '可合并的排在最前（源分支 → 纯清理 → 被挡）', ok: rows[0]?.name === 'merge-alpha' && rows.findIndex((r) => r.name === 'merge-synced') < rows.findIndex((r) => r.name === 'merge-dirty'), d: rows.map((r) => r.name).join(' → ') },
  { n: '干净仓标出目标线与合并规模（dev + main · 1 源分支 · 2 条合并）', ok: !!alphaRow && alphaRow.targets.includes('dev + main') && alphaRow.targets.includes('2 条合并') && alphaRow.targets.includes('1 个源分支'), d: alphaRow ? alphaRow.targets : 'missing' },
  { n: '干净仓逐条列出每条线的形态（快进 + 提交数）', ok: !!alphaRow && alphaRow.sources.length === 1 && alphaRow.sources[0].includes('feature → dev 快进') && alphaRow.sources[0].includes('main 快进'), d: alphaRow ? alphaRow.sources.join(' | ') : 'missing' },
  { n: '脏仓整仓禁用并说明原因', ok: !!dirtyRow && dirtyRow.blocked === 'true' && dirtyRow.checkboxDisabled && dirtyRow.small.includes('工作区有未提交改动'), d: dirtyRow ? `${dirtyRow.blocked} / ${dirtyRow.small}` : 'missing' },
  { n: '已同步仓（无可合并内容）默认灰掉并提示可勾选清理', ok: !!syncedRow && syncedRow.blocked === 'true' && syncedRow.small.includes('勾选') && syncedRow.small.includes('清理'), d: syncedRow ? `${syncedRow.blocked} / ${syncedRow.small}` : 'missing' },
  { n: '确认按钮写明「1 个仓库 · 2 条合并」', ok: confirmLabel.includes('1 个仓库') && confirmLabel.includes('2 条合并'), d: confirmLabel || 'none' },
  { n: '底部说明「只合并本地分支 · 冲突即停 · 不推送」', ok: footerLeft.includes('只合并本地分支') && footerLeft.includes('冲突即停') && footerLeft.includes('不推送'), d: footerLeft || 'none' },
  { n: '有「合并后删除已合并任务分支」选项且默认不勾', ok: !!cleanupBox && cleanupBox.checked === false, d: cleanupBox ? cleanupBox.label : 'absent' },
]);

// ---------- 阶段 3：勾选交互 ----------
console.log('== 阶段 3：勾选交互 ==');
await ev(`(() => {
  const li = [...document.querySelectorAll('.batch-push-list li')].find((x) => x.querySelector('strong')?.textContent.trim() === 'merge-alpha');
  const box = li?.querySelector('input'); if (box && !box.disabled) box.click();
})()`);
await sleep(700);
const afterUncheck = await ev(`(() => ({
  label: (document.querySelector('.confirmation-confirm')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  disabled: document.querySelector('.confirmation-confirm')?.disabled === true,
}))()`);
await ev(`(() => {
  const li = [...document.querySelectorAll('.batch-push-list li')].find((x) => x.querySelector('strong')?.textContent.trim() === 'merge-alpha');
  const box = li?.querySelector('input'); if (box && !box.disabled) box.click();
})()`);
await sleep(700);
const afterRecheck = await ev(`(() => ({
  label: (document.querySelector('.confirmation-confirm')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  disabled: document.querySelector('.confirmation-confirm')?.disabled === true,
}))()`);
// 勾上「合并后删除已合并任务分支」，本轮执行会顺带清理 feature。
await ev(`(() => { const b = document.querySelector('.batch-merge-cleanup input'); if (b && !b.disabled) b.click(); })()`);
await sleep(500);
const cleanupChecked = await ev(`document.querySelector('.batch-merge-cleanup input')?.checked === true`);
const afterCleanup = await ev(`(() => {
  const li = [...document.querySelectorAll('.batch-push-list li')].find((x) => x.querySelector('strong')?.textContent.trim() === 'merge-synced');
  return {
    label: (document.querySelector('.confirmation-confirm')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    syncedBlocked: li?.getAttribute('data-blocked') ?? 'absent',
    syncedDisabled: li?.querySelector('input')?.disabled === true,
    syncedTargets: (li?.querySelector('.batch-push-targets')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  };
})()`);
record('双线合并-勾选交互', [
  { n: '取消勾选后确认按钮禁用、计数归零', ok: afterUncheck.disabled && afterUncheck.label.includes('0 个仓库'), d: `${afterUncheck.label} / disabled=${afterUncheck.disabled}` },
  { n: '重新勾选后按钮恢复「1 个仓库 · 2 条合并」', ok: !afterRecheck.disabled && afterRecheck.label.includes('1 个仓库') && afterRecheck.label.includes('2 条合并'), d: `${afterRecheck.label} / disabled=${afterRecheck.disabled}` },
  { n: '「合并后删除已合并分支」可勾选', ok: cleanupChecked, d: String(cleanupChecked) },
  { n: '勾选后已同步仓变为可选、并标出可清理分支', ok: afterCleanup.syncedBlocked === 'false' && afterCleanup.syncedDisabled === false && afterCleanup.syncedTargets.includes('可清理 1 条已合并分支'), d: `${afterCleanup.syncedBlocked} / ${afterCleanup.syncedTargets}` },
  { n: '确认按钮同时报出清理规模', ok: afterCleanup.label.includes('清理') && afterCleanup.label.includes('条已合并分支'), d: afterCleanup.label || 'none' },
]);

// ---------- 阶段 4：1024 视口 ----------
console.log('== 阶段 4：1024 视口布局 ==');
await setViewport(1024, 900);
await sleep(1400);
const layout = JSON.parse(await ev(`JSON.stringify({
  scroll: document.documentElement.scrollWidth,
  client: document.documentElement.clientWidth,
  dialogRight: Math.round((document.querySelector('.confirmation-modal')?.getBoundingClientRect().right ?? 0)),
  vw: window.innerWidth,
})`));
await shot('02-merge-dialog-1024.png');
record('双线合并-1024', [
  { n: '1024 下无横向溢出', ok: layout.scroll <= layout.client + 1, d: `${layout.scroll} vs ${layout.client}` },
  { n: '弹窗不超出视口宽度', ok: layout.dialogRight > 0 && layout.dialogRight <= layout.vw + 1, d: `右边缘 ${layout.dialogRight} / 视口 ${layout.vw}` },
]);
await setViewport(1440, 950);
await sleep(1000);

// ---------- 阶段 5/6：执行并核对磁盘与批次 ----------
console.log('== 阶段 5：执行合并并核对磁盘 ==');
const beforeDev = gitAt(alpha.work, 'rev-parse', 'dev');
const beforeMain = gitAt(alpha.work, 'rev-parse', 'main');
await ev(`(() => { const b = document.querySelector('.confirmation-confirm'); if (b) b.click(); })()`);
const dialogGone = await waitFor(async () => await ev(`document.querySelector('#batch-merge-title') === null`), 8000);
const merged = await waitFor(async () => {
  const devHas = (() => { try { return gitAt(alpha.work, 'show', 'dev:feature.txt') === 'feature'; } catch { return false; } })();
  const mainHas = (() => { try { return gitAt(alpha.work, 'show', 'main:feature.txt') === 'feature'; } catch { return false; } })();
  return devHas && mainHas;
}, 25000, 400);
const headBranch = gitAt(alpha.work, 'rev-parse', '--abbrev-ref', 'HEAD');
const featureLeft = gitAt(alpha.work, 'branch', '--list', 'feature').trim();
const syncedFeatureLeft = gitAt(synced.work, 'branch', '--list', 'feature').trim();
const syncedHead = gitAt(synced.work, 'rev-parse', '--abbrev-ref', 'HEAD');
await shot('03-after-merge.png');
const ops = await (await fetch(`${base}/api/operations`, { headers: { 'x-git-fleet-token': token } })).json();
const mergeBatch = (ops.batches ?? []).find((b) => b.type === 'merge-branches');
record('双线合并-执行', [
  { n: '确认后弹窗关闭', ok: dialogGone, d: String(dialogGone) },
  { n: 'dev 拿到任务分支内容', ok: (() => { try { return gitAt(alpha.work, 'show', 'dev:feature.txt') === 'feature'; } catch { return false; } })(), d: 'dev:feature.txt' },
  { n: 'main 拿到任务分支内容', ok: (() => { try { return gitAt(alpha.work, 'show', 'main:feature.txt') === 'feature'; } catch { return false; } })(), d: 'main:feature.txt' },
  { n: 'dev / main 都真的前移了', ok: merged && gitAt(alpha.work, 'rev-parse', 'dev') !== beforeDev && gitAt(alpha.work, 'rev-parse', 'main') !== beforeMain, d: `mixed=${merged}` },
  { n: '待合并仓的 feature 已被删除并切到 main', ok: featureLeft === '' && headBranch === 'main', d: `feature=${featureLeft || '已删除'} HEAD=${headBranch}` },
  { n: '已同步仓（无可合并内容）也被清理并切到 main', ok: syncedFeatureLeft === '' && syncedHead === 'main', d: `feature=${syncedFeatureLeft || '已删除'} HEAD=${syncedHead}` },
  { n: '批次记录 merge-branches 成功 2、脏仓未入队', ok: !!mergeBatch && mergeBatch.type === 'merge-branches' && mergeBatch.success === 2 && mergeBatch.failed === 0 && mergeBatch.total === 2, d: mergeBatch ? `type=${mergeBatch.type} total=${mergeBatch.total} success=${mergeBatch.success} failed=${mergeBatch.failed}` : 'absent' },
]);

record('运行时', [
  { n: '控制台 0 条 error', ok: consoleErrors.length === 0, d: consoleErrors.join(' | ') || 'clean' },
]);

// ---------- 报告 ----------
const failed = results.filter((r) => !r.ok);
console.log('\n================ 结果 ================');
let group = '';
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`\n[${group}]`); }
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.n}${r.d ? `  — ${r.d}` : ''}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
console.log(`截图在 ${shotDir}`);
cleanup();
process.exit(failed.length ? 1 : 0);
