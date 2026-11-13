#!/usr/bin/env node
/**
 * 「批量拉取多个分支」专项真机验收。
 *
 * 为什么不并进 verify.mjs：那套断言用的是 docs 截图共用的夹具（6 个仓库、
 * 写死了一堆行数与分组），要测「多分支拉取」就得造「本地落后远端」的仓库，
 * 会同时改掉那份夹具的整批断言。这里自建夹具、自起实例（dist 打包产物），互不干扰。
 *
 * 断言分七段：
 *  1. 图标一致性：工作台「合并」与单仓抽屉「合并」用同一个 GitMerge 图形；
 *  2. Pull 右侧的 `⌄` 入口存在、可点、title 正确；
 *  3. 弹窗结构与逐仓明细（有 dev 的仓列两条、没 dev 的仓只列一条并说明原因）；
 *  4. 档位切换会重读快照（关掉 dev 后该仓只剩主分支）；
 *  5. 1024 视口无横向溢出、弹窗不超宽；
 *  6. 确认执行后磁盘上的本地 ref 真的追上远端，批次记录为 pull-branches 且成功；
 *  7. 控制台 0 条 error。
 *
 * 用法：
 *   npm run verify:ui:pull
 *
 * 环境变量：
 *   MOO_FLEET_PULL_ROOT         夹具与截图根目录（默认 /tmp/moo-fleet-pull-verify）
 *   MOO_FLEET_PULL_PORT         服务端端口（默认自动挑空闲端口）
 *   MOO_FLEET_UI_CHROME_FLAGS   追加给 Chrome 的参数（默认 --no-proxy-server
 *                               --no-sandbox --disable-gpu；本机 Chrome 起不了自己的
 *                               进程沙箱，不带会 SIGTRAP 退出）
 *   CHROME                      Chrome 可执行文件路径
 *
 * 退出码：全部通过为 0，有失败项为 1。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_PULL_ROOT ?? '/tmp/moo-fleet-pull-verify';
const PROJECTS = path.join(ROOT, 'projects');
const REMOTES = path.join(ROOT, 'remotes');
const SEEDS = path.join(ROOT, 'seeds');
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

// ---------- 夹具 ----------
// 下面会递归删掉 ROOT。先确认它确实是本脚本造的目录，避免环境变量指错时误删。
if (fs.existsSync(ROOT)) {
  const entries = fs.readdirSync(ROOT);
  const looksOurs = entries.length === 0
    || entries.includes('fleet')
    || entries.includes('projects')
    || entries.includes('remotes')
    || entries.includes('shots');
  if (!looksOurs) {
    console.error(`拒绝清空 ${ROOT}：里面不像本脚本的夹具目录（${entries.slice(0, 5).join(', ')}）。`);
    process.exit(2);
  }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(REMOTES, { recursive: true });
fs.mkdirSync(SEEDS, { recursive: true });

const gitAt = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/**
 * 造一个「本地落后远端」的仓库：
 * - bare 远端初始有 main（可选再加 dev）；
 * - 工作副本推上去后，用另一个 seed 克隆往远端各补一笔并推送；
 * - 工作副本再 fetch，于是本地各分支都落后 1，正是批量拉取要处理的状态。
 */
function makeRepo(name, { withDev }) {
  const remote = path.join(REMOTES, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  const work = path.join(PROJECTS, name);
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...args) => gitAt(work, ...args);
  g('config', 'user.name', 'Pull Probe');
  g('config', 'user.email', 'probe@pull-lab.example');
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

  const seed = path.join(SEEDS, name);
  execFileSync('git', ['clone', '-q', remote, seed]);
  const s = (...args) => gitAt(seed, ...args);
  s('config', 'user.name', 'Seed');
  s('config', 'user.email', 'seed@pull-lab.example');
  s('config', 'commit.gpgsign', 'false');
  s('checkout', '-q', 'main');
  fs.writeFileSync(path.join(seed, 'incoming-main.txt'), 'incoming\n');
  s('add', '-A');
  s('commit', '-q', '-m', 'incoming main');
  s('push', '-q', 'origin', 'main');
  if (withDev) {
    s('checkout', '-q', 'dev');
    fs.writeFileSync(path.join(seed, 'incoming-dev.txt'), 'dev incoming\n');
    s('add', '-A');
    s('commit', '-q', '-m', 'incoming dev');
    s('push', '-q', 'origin', 'dev');
  }
  g('fetch', '-q', 'origin');
  return { name, work, remote, withDev };
}

const repos = [
  makeRepo('pull-alpha', { withDev: true }),
  makeRepo('pull-beta', { withDev: false }),
];
const alpha = repos[0];
const beta = repos[1];
const remoteRef = (repo, branch) => gitAt(repo.remote, 'rev-parse', `refs/heads/${branch}`);
const localRef = (repo, branch) => gitAt(repo.work, 'rev-parse', branch);

console.log('== 夹具 ==');
for (const repo of repos) {
  console.log(`  ${repo.name}: main 本地 ${localRef(repo, 'main').slice(0, 8)} / 远端 ${remoteRef(repo, 'main').slice(0, 8)}`
    + (repo.withDev ? `；dev 本地 ${localRef(repo, 'dev').slice(0, 8)} / 远端 ${remoteRef(repo, 'dev').slice(0, 8)}` : '；无 dev'));
}

// ---------- 服务端 ----------
const PORT = Number(process.env.MOO_FLEET_PULL_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    GIT_FLEET_HOME: path.join(ROOT, 'fleet'),
    GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'),
    GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'),
    GIT_FLEET_PORT: String(PORT),
    GIT_FLEET_DEVICE_NAME: 'pull-probe',
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
  try {
    healthy = (await fetch(`${base}/api/health`)).ok;
  } catch { /* 还没起来 */ }
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
for (const repo of repos) {
  await post('/api/repositories', { rootId, relativePath: repo.name, name: repo.name, group: '探针', tags: [] });
}

// ---------- Chrome + CDP ----------
const debugPort = await freePort();
const profileDir = path.join(ROOT, 'chrome-profile');
fs.mkdirSync(profileDir, { recursive: true });
const extraFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu')
  .split(/\s+/)
  .filter(Boolean);
chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  ...extraFlags,
  'about:blank',
], { stdio: 'ignore', detached: true });
chrome.unref();

let version = null;
for (let i = 0; i < 40 && !version; i += 1) {
  try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); }
  catch { await sleep(500); }
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
const pressEscape = async () => {
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
};
const shotDir = path.join(ROOT, 'shots');
fs.mkdirSync(shotDir, { recursive: true });
const shot = async (file) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, file), Buffer.from(data, 'base64'));
};
/** 轮询直到 predicate 为真或超时（用于等待异步重读 / 批次落盘）。 */
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

// ---------- 阶段 1：图标一致性 ----------
console.log('\n== 阶段 1：合并图标一致性 ==');
const workbenchMergeSvg = await ev(`(() => {
  const b = [...document.querySelectorAll('.batch-actions button')].find((x) => x.textContent.trim().startsWith('合并'));
  return b ? (b.querySelector('svg')?.innerHTML ?? '') : '';
})()`);
const openedRepo = await ev(`(() => {
  const row = [...document.querySelectorAll('.repo-table tbody tr')]
    .find((r) => r.querySelector('.repo-name')?.textContent.trim() === 'pull-alpha');
  if (!row) return false;
  row.querySelector('.repo-name').click();
  return true;
})()`);
await sleep(2600);
const drawerMergeSvg = await ev(`(() => {
  const b = document.querySelector('[role="dialog"] .git-action-merge-lines svg');
  return b ? b.innerHTML : '';
})()`);
await pressEscape();
await sleep(900);
const drawerClosed = await ev(`document.querySelector('[role="dialog"]') === null`);
record('合并图标', [
  { n: '工作台「合并」有图标', ok: workbenchMergeSvg.length > 0, d: `${workbenchMergeSvg.length} 字节` },
  { n: '单仓抽屉「合并」有图标', ok: drawerMergeSvg.length > 0, d: `${drawerMergeSvg.length} 字节` },
  { n: '两处用同一个 GitMerge 图形（路径完全一致）', ok: workbenchMergeSvg.length > 0 && workbenchMergeSvg === drawerMergeSvg, d: workbenchMergeSvg === drawerMergeSvg ? '一致' : '不一致' },
  { n: '抽屉已关闭可回到工作台', ok: openedRepo && drawerClosed, d: `打开 ${openedRepo} / 关闭 ${drawerClosed}` },
]);

// ---------- 阶段 2：Pull 右侧入口 ----------
console.log('== 阶段 2：Pull 右侧 `⌄` 入口 ==');
const chevron = await ev(`(() => {
  const b = document.querySelector('button[title^="批量拉取多个分支"]');
  return b ? { title: b.title, disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') } : null;
})()`);
record('批量拉取-入口', [
  { n: 'Pull 右侧存在「批量拉取多个分支」入口', ok: chevron !== null, d: chevron ? chevron.title : 'absent' },
  { n: '入口可点（未被忙态锁死）', ok: chevron !== null && chevron.disabled === false, d: chevron ? `disabled=${chevron.disabled}` : 'absent' },
  { n: 'title 说明可拉取范围', ok: chevron !== null && chevron.title.includes('批量拉取多个分支'), d: chevron ? chevron.title : 'absent' },
]);
if (chevron !== null) await ev(`document.querySelector('button[title^="批量拉取多个分支"]').click()`);
await sleep(1600);

// ---------- 阶段 3：弹窗结构 ----------
console.log('== 阶段 3：弹窗结构与逐仓明细 ==');
const dialogTitle = await ev(`document.querySelector('#batch-pull-title')?.textContent.trim() ?? ''`);
const modePills = await ev(`document.querySelectorAll('.batch-push-mode').length`);
const activeModes = await ev(`document.querySelectorAll('.batch-push-mode[data-active="true"]').length`);
const rowsJson = await ev(`JSON.stringify([...document.querySelectorAll('.batch-push-list li')].map((li) => ({
  name: li.querySelector('strong')?.textContent.trim() ?? '',
  targets: li.querySelector('.batch-push-targets')?.textContent.trim() ?? '',
  small: li.querySelector('small')?.textContent.trim() ?? '',
  blocked: li.getAttribute('data-blocked'),
})))`);
const rows = JSON.parse(rowsJson);
const alphaRow = rows.find((r) => r.name === 'pull-alpha');
const betaRow = rows.find((r) => r.name === 'pull-beta');
const confirmLabel = await ev(`(document.querySelector('.confirmation-confirm')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
await shot('01-pull-dialog-1440.png');
record('批量拉取-弹窗', [
  { n: '标题是「批量拉取多个分支」', ok: dialogTitle === '批量拉取多个分支', d: dialogTitle || 'none' },
  { n: '三档胶囊齐全且默认全开', ok: modePills === 3 && activeModes === 3, d: `胶囊 ${modePills} / 选中 ${activeModes}` },
  { n: '列出 2 个仓库', ok: rows.length === 2, d: `行数 ${rows.length}` },
  { n: '有 dev 的仓列出 dev + main 两条落后', ok: !!alphaRow && alphaRow.targets.includes('dev') && alphaRow.targets.includes('main'), d: alphaRow ? alphaRow.targets : 'missing' },
  { n: '没 dev 的仓只列 main，并说明 dev 缺席', ok: !!betaRow && betaRow.targets.includes('main') && !betaRow.targets.includes('dev') && betaRow.small.includes('跳过') && betaRow.small.includes('dev'), d: betaRow ? `${betaRow.targets} | ${betaRow.small}` : 'missing' },
  { n: '确认按钮写明规模「2 个仓库 · 3 条分支」', ok: confirmLabel.includes('2 个仓库') && confirmLabel.includes('3 条分支'), d: confirmLabel || 'none' },
]);

// ---------- 阶段 4：档位切换重读快照 ----------
console.log('== 阶段 4：关掉 dev 档会重读快照 ==');
await ev(`(() => { const b = [...document.querySelectorAll('.batch-push-mode')].find((x) => x.textContent.trim() === 'dev'); if (b) b.click(); })()`);
const toggled = await waitFor(async () => {
  const body = await ev(`JSON.stringify([...document.querySelectorAll('.batch-push-list li')].map((li) => ({
    name: li.querySelector('strong')?.textContent.trim() ?? '',
    targets: li.querySelector('.batch-push-targets')?.textContent.trim() ?? '',
  })))`);
  const list = JSON.parse(body);
  const a = list.find((r) => r.name === 'pull-alpha');
  return !!a && a.targets.includes('main') && !a.targets.includes('dev');
}, 10000);
const activeAfterToggle = await ev(`document.querySelectorAll('.batch-push-mode[data-active="true"]').length`);
record('批量拉取-档位切换', [
  { n: '关掉 dev 后该仓不再列 dev 分支', ok: toggled, d: toggled ? '已重读' : '未重读或仍含 dev' },
  { n: '选中态降到 2 档', ok: activeAfterToggle === 2, d: `选中 ${activeAfterToggle}` },
]);
// 还原三档，确认按钮回到 3 条分支
await ev(`(() => { const b = [...document.querySelectorAll('.batch-push-mode')].find((x) => x.textContent.trim() === 'dev'); if (b) b.click(); })()`);
const restored = await waitFor(async () => await ev(`(document.querySelector('.confirmation-confirm')?.textContent ?? '').includes('3 条分支')`), 10000);

// ---------- 阶段 5：1024 视口 ----------
console.log('== 阶段 5：1024 视口布局 ==');
await setViewport(1024, 900);
await sleep(1400);
const layout = JSON.parse(await ev(`JSON.stringify({
  scroll: document.documentElement.scrollWidth,
  client: document.documentElement.clientWidth,
  dialogRight: Math.round((document.querySelector('.confirmation-modal')?.getBoundingClientRect().right ?? 0)),
  vw: window.innerWidth,
})`));
await shot('02-pull-dialog-1024.png');
record('批量拉取-1024', [
  { n: '还原三档后确认按钮回到「3 条分支」', ok: restored, d: restored ? 'ok' : '未恢复' },
  { n: '1024 下无横向溢出', ok: layout.scroll <= layout.client + 1, d: `${layout.scroll} vs ${layout.client}` },
  { n: '弹窗不超出视口宽度', ok: layout.dialogRight > 0 && layout.dialogRight <= layout.vw + 1, d: `右边缘 ${layout.dialogRight} / 视口 ${layout.vw}` },
]);
await setViewport(1440, 950);
await sleep(1000);

// ---------- 阶段 6：执行并核对磁盘 ----------
console.log('== 阶段 6：执行拉取并核对本地 ref ==');
const before = {
  alphaMain: localRef(alpha, 'main'), alphaDev: localRef(alpha, 'dev'), betaMain: localRef(beta, 'main'),
};
await ev(`(() => { const b = document.querySelector('.confirmation-confirm'); if (b) b.click(); })()`);
const dialogGone = await waitFor(async () => await ev(`document.querySelector('#batch-pull-title') === null`), 8000);
const advanced = await waitFor(async () => {
  return localRef(alpha, 'main') === remoteRef(alpha, 'main')
    && localRef(alpha, 'dev') === remoteRef(alpha, 'dev')
    && localRef(beta, 'main') === remoteRef(beta, 'main');
}, 25000, 400);
await shot('03-after-pull.png');
const ops = await (await fetch(`${base}/api/operations`, { headers: { 'x-git-fleet-token': token } })).json();
const pullBatch = (ops.batches ?? []).find((b) => b.type === 'pull-branches');
record('批量拉取-执行', [
  { n: '确认后弹窗关闭', ok: dialogGone, d: String(dialogGone) },
  { n: 'alpha 的 dev 追上远端', ok: localRef(alpha, 'dev') === remoteRef(alpha, 'dev'), d: `${localRef(alpha, 'dev').slice(0, 8)} vs ${remoteRef(alpha, 'dev').slice(0, 8)}` },
  { n: 'alpha 的 main 追上远端', ok: localRef(alpha, 'main') === remoteRef(alpha, 'main'), d: `${localRef(alpha, 'main').slice(0, 8)} vs ${remoteRef(alpha, 'main').slice(0, 8)}` },
  { n: 'beta 的 main 追上远端', ok: localRef(beta, 'main') === remoteRef(beta, 'main'), d: `${localRef(beta, 'main').slice(0, 8)} vs ${remoteRef(beta, 'main').slice(0, 8)}` },
  { n: '三条 ref 全部前移（非原本就一致）', ok: advanced && localRef(alpha, 'main') !== before.alphaMain && localRef(alpha, 'dev') !== before.alphaDev && localRef(beta, 'main') !== before.betaMain, d: `advanced=${advanced}` },
  { n: '批次记录为 pull-branches 且成功 2', ok: !!pullBatch && pullBatch.type === 'pull-branches' && pullBatch.success === 2 && pullBatch.failed === 0, d: pullBatch ? `type=${pullBatch.type} success=${pullBatch.success} failed=${pullBatch.failed} state=${pullBatch.state}` : 'absent' },
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
