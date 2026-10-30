#!/usr/bin/env node
/**
 * 「勾选的新文件批量删除」专项真机验收。
 *
 * 为什么不并进 verify.mjs：那套断言用的是 docs 截图共用的夹具（6 个仓库、
 * northwind-api 只有 1 个未跟踪文件），要测「批量删除 3 个」就得往那份夹具里
 * 加文件，而加文件会同时改掉仓库总数、工作区改动计数和一整批写死的断言。
 * 这里自建夹具、自起实例，互不干扰。
 *
 * 断言分六段：基线（未勾选）→ 勾选后入口出现且行内入口消失 → 两档视口的标题栏
 * 布局 → 混入已跟踪文件整批不给入口（成对反例）→ 确认弹窗与取消 → 真删后磁盘 /
 * 索引 / 系统废纸篓三处对账。
 *
 * 用法：
 *   npm run verify:ui:batch
 *
 * 环境变量：
 *   MOO_FLEET_BATCH_ROOT          夹具与截图根目录（默认 /tmp/moo-fleet-batch-verify）
 *   MOO_FLEET_BATCH_PORT          服务端端口（默认自动挑空闲端口）
 *   MOO_FLEET_UI_CHROME_FLAGS     追加给 Chrome 的参数（默认 --no-proxy-server
 *                                 --no-sandbox --disable-gpu；本机 Chrome 起不了
 *                                 自己的进程沙箱，不带这两个会 SIGTRAP 退出）
 *   CHROME                        Chrome 可执行文件路径
 *
 * 退出码：全部通过为 0，有失败项为 1。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_BATCH_ROOT ?? '/tmp/moo-fleet-batch-verify';
const PROJECTS = path.join(ROOT, 'projects');
const LAB = path.join(PROJECTS, 'batch-lab');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UNTRACKED = ['probe-alpha.md', 'probe-beta.md', 'probe-gamma.md'];
const TRACKED = 'src/tracked.ts';

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
// 下面这行会递归删掉 ROOT。先确认它确实是本脚本造的目录，避免
// MOO_FLEET_BATCH_ROOT 指错地方时把别人的东西清掉。
if (fs.existsSync(ROOT)) {
  const entries = fs.readdirSync(ROOT);
  const looksOurs = entries.length === 0
    || entries.includes('fleet')
    || entries.includes('projects')
    || entries.includes('shots');
  if (!looksOurs) {
    console.error(`拒绝清空 ${ROOT}：里面不像本脚本的夹具目录（${entries.slice(0, 5).join(', ')}）。`);
    process.exit(2);
  }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'fleet', 'config'), { recursive: true });
fs.mkdirSync(path.join(LAB, 'src'), { recursive: true });

const git = (...args) => execFileSync('git', ['-C', LAB, ...args], { encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', '-b', 'main', LAB], { stdio: 'ignore' });
git('config', 'user.name', 'Batch Probe');
git('config', 'user.email', 'probe@batch-lab.example');
git('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(LAB, 'src/tracked.ts'), 'export const value = 1;\n');
fs.writeFileSync(path.join(LAB, 'README.md'), '# batch-lab\n');
git('add', '-A');
git('commit', '-q', '-m', 'chore: 初始化');
// 一个已跟踪文件的本地修改（混选反例用）
fs.writeFileSync(path.join(LAB, TRACKED), 'export const value = 2;\n');
// 三个从未提交过的新文件
for (const name of UNTRACKED) fs.writeFileSync(path.join(LAB, name), `# ${name}\n`);

console.log('== 夹具 ==');
console.log(git('status', '--porcelain').split('\n').map((l) => `   ${l}`).join('\n'));

// ---------- 服务端 ----------
const PORT = Number(process.env.MOO_FLEET_BATCH_PORT ?? (await freePort()));
const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/server/index.js')], {
  // 静态根按 process.cwd() 解析（resolveClientRoot），不设 cwd 就找不到 dist/client，
  // 页面只剩 {"message":"Route GET / not found"}。
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    GIT_FLEET_HOME: path.join(ROOT, 'fleet'),
    GIT_FLEET_CLAUDE_HOME: path.join(ROOT, 'claude'),
    GIT_FLEET_CODEX_HOME: path.join(ROOT, 'codex'),
    GIT_FLEET_PORT: String(PORT),
    GIT_FLEET_DEVICE_NAME: 'batch-probe',
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
await post('/api/repositories', { rootId, relativePath: 'batch-lab', group: '探针', tags: [] });

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
  console.error('Chrome 调试端口没起来。受限环境或本机沙箱受限时，'
    + '用 MOO_FLEET_UI_CHROME_FLAGS="--no-sandbox --disable-gpu" 重跑。');
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

await send('Page.enable');
await send('Runtime.enable');
await setViewport(1440, 950);
await send('Page.navigate', { url: base });
await sleep(3200);

// ---------- 打开工作区 ----------
const opened = await ev(`(() => {
  const row = [...document.querySelectorAll('.repo-table tbody tr')]
    .find((r) => r.querySelector('.repo-name')?.textContent.trim() === 'batch-lab');
  if (!row) return false;
  row.querySelector('.repo-name').click();
  return true;
})()`);
await sleep(2600);

const rowCount = () => ev(`document.querySelectorAll('[role="dialog"] .workspace-file-row').length`);
const deleteBtn = () => ev(`(() => {
  const b = document.querySelector('[role="dialog"] .workspace-group-delete');
  return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
})()`);
const trashButtons = () => ev(`document.querySelectorAll('[role="dialog"] .file-discard.trash').length`);
const isChecked = (p) => ev(`!!document.querySelector('[role="dialog"] .workspace-file-row[data-path=${JSON.stringify(p)}].checked')`);

// 勾选 = git add，是串行队列；勾一个就等它落定，否则下一次点击会被 stageBlocked 挡掉。
const check = async (p) => {
  const clicked = await ev(`(() => {
    const box = document.querySelector('[role="dialog"] .workspace-file-row[data-path=${JSON.stringify(p)}] input[type="checkbox"]');
    if (!box || box.disabled) return false;
    box.click();
    return true;
  })()`);
  for (let i = 0; i < 30; i += 1) {
    if (await isChecked(p)) return clicked;
    await sleep(200);
  }
  return false;
};
const uncheck = async (p) => {
  // 刷新期间 checkbox 是 disabled，直接 click 会被静默吞掉；等到能点再点。
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await ev(`(() => {
      const box = document.querySelector('[role="dialog"] .workspace-file-row[data-path=${JSON.stringify(p)}] input[type="checkbox"]');
      if (!box) return 'missing';
      if (box.disabled) return 'disabled';
      box.click();
      return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(200);
  }
  for (let i = 0; i < 30; i += 1) {
    if (!(await isChecked(p))) return true;
    await sleep(200);
  }
  return false;
};
const headingLayout = () => ev(`(() => {
  const head = document.querySelector('[role="dialog"] .workspace-group-heading:has(.workspace-group-delete)');
  if (!head) return null;
  const buttons = [...head.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { t: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
  });
  const hr = head.getBoundingClientRect();
  return JSON.stringify({
    buttons,
    headRight: Math.round(hr.right),
    gap: buttons.length === 2 ? buttons[1].left - buttons[0].right : null,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  });
})()`);

console.log('\n== 阶段 1：基线（未勾选）==');
const baselineRows = await rowCount();
const baselineBtn = await deleteBtn();
const baselineTrash = await trashButtons();
await shot('01-baseline.png');
record('批量删除-基线', [
  { n: '工作区打开且列出 4 个文件', ok: opened && baselineRows === 4, d: `打开 ${opened} / 行数 ${baselineRows}` },
  { n: '未勾选时没有「删除 N 个」入口', ok: baselineBtn === null, d: baselineBtn ? baselineBtn.text : 'absent' },
  { n: '3 个未跟踪文件各有行内废纸篓入口', ok: baselineTrash === 3, d: `trash 按钮 ${baselineTrash}` },
]);

console.log('== 阶段 2：勾选 3 个新文件 ==');
const checked = [];
for (const name of UNTRACKED) checked.push(await check(name));
await sleep(1200);
const afterCheckBtn = await deleteBtn();
const afterCheckTrash = await trashButtons();
const checkedRows = await ev(`document.querySelectorAll('[role="dialog"] .workspace-file-row.checked').length`);
await shot('02-checked.png');
record('批量删除-勾选', [
  { n: '3 个新文件都勾上了', ok: checked.every(Boolean) && checkedRows === 3, d: `点击 ${checked.join(',')} / checked 行 ${checkedRows}` },
  { n: '标题栏出现「删除 3 个」', ok: afterCheckBtn?.text === '删除 3 个', d: afterCheckBtn ? afterCheckBtn.text : 'absent' },
  { n: '入口可点（未被忙态锁死）', ok: afterCheckBtn !== null && afterCheckBtn.disabled === false, d: afterCheckBtn ? `disabled=${afterCheckBtn.disabled}` : 'absent' },
  { n: '勾选后行内废纸篓入口全部消失', ok: afterCheckTrash === 0, d: `trash 按钮 ${afterCheckTrash}（判据要从 untracked 扩到 A）` },
]);

console.log('== 阶段 3：两档视口下的标题栏布局 ==');
const layout1440 = JSON.parse(await headingLayout());
await setViewport(1024, 900);
await sleep(1400);
const layout1024 = JSON.parse(await headingLayout());
await shot('03-1024-heading.png');
await setViewport(1440, 950);
await sleep(1200);
record('批量删除-标题栏布局', [
  {
    n: '1440 下「取消勾选」与「删除 3 个」都在，且不重叠',
    ok: layout1440?.buttons.length === 2
      && layout1440.buttons[0].right <= layout1440.buttons[1].left
      && layout1440.buttons[0].top === layout1440.buttons[1].top,
    d: JSON.stringify(layout1440?.buttons ?? null),
  },
  {
    n: '1440 下这一排贴住标题栏右边缘',
    ok: layout1440 !== null && layout1440.headRight - layout1440.buttons[1].right < 20,
    d: layout1440 ? `间距 ${layout1440.headRight - layout1440.buttons[1].right}px` : 'missing',
  },
  {
    n: '1024 下两个按钮仍并排不重叠',
    ok: layout1024?.buttons.length === 2
      && layout1024.buttons[0].right <= layout1024.buttons[1].left
      && layout1024.buttons[0].top === layout1024.buttons[1].top,
    d: JSON.stringify(layout1024?.buttons ?? null),
  },
  {
    n: '1024 下两个按钮之间的空隙是常规间距（没被 margin-left:auto 扯开）',
    ok: layout1024 !== null && layout1024.gap !== null && layout1024.gap >= 0 && layout1024.gap <= 40,
    d: layout1024 ? `间距 ${layout1024.gap}px` : 'missing',
  },
  { n: '1024 下无横向溢出', ok: layout1024 !== null && layout1024.scroll <= layout1024.client + 1, d: layout1024 ? `${layout1024.scroll} vs ${layout1024.client}` : 'missing' },
]);

console.log('== 阶段 4：混入已跟踪文件（成对反例）==');
await check(TRACKED);
await sleep(1400);
const mixedBtn = await deleteBtn();
const mixedChecked = await ev(`JSON.stringify([...document.querySelectorAll('[role="dialog"] .workspace-file-row.checked')].map((r) => r.dataset.path))`);
const trackUncheckOk = await uncheck(TRACKED);
await sleep(1400);
const restoredBtn = await deleteBtn();
const restoredChecked = await ev(`JSON.stringify([...document.querySelectorAll('[role="dialog"] .workspace-file-row.checked')].map((r) => r.dataset.path))`);
await shot('04-mixed.png');
record('批量删除-混选', [
  { n: '混入已跟踪文件后整批不给入口', ok: mixedBtn === null, d: `${mixedBtn ? mixedBtn.text : 'absent'} / 勾选 ${mixedChecked}` },
  { n: '取消勾选后入口回到「删除 3 个」', ok: restoredBtn?.text === '删除 3 个', d: `${restoredBtn ? restoredBtn.text : 'absent'} / 勾选 ${restoredChecked} / 取消成功 ${trackUncheckOk}` },
]);

console.log('== 阶段 5：确认弹窗与取消 ==');
const openedDialog = await ev(`(() => {
  const b = document.querySelector('[role="dialog"] .workspace-group-delete');
  if (!b) return false;
  b.click();
  return true;
})()`);
if (!openedDialog) {
  record('批量删除-确认弹窗', [{ n: '能点开确认弹窗', ok: false, d: '找不到「删除 N 个」按钮' }]);
  record('批量删除-取消', [{ n: '取消后文件一个都没少', ok: false, d: '未进入弹窗' }]);
  record('批量删除-真删', [{ n: '真删', ok: false, d: '未进入弹窗' }]);
} else {
  await sleep(900);
  const dialogTitle = await ev(`document.querySelector('#confirmation-title')?.textContent.trim() ?? ''`);
  const confirmLabel = await ev(`document.querySelector('.confirmation-confirm')?.textContent.trim() ?? ''`);
  const dialogTone = await ev(`document.querySelector('.confirmation-modal')?.getAttribute('data-tone') ?? ''`);
  const detailCount = await ev(`document.querySelectorAll('#confirmation-details li').length`);
  await shot('05-confirm.png');
  record('批量删除-确认弹窗', [
    { n: '弹窗标题是「删除未提交文件」', ok: dialogTitle === '删除未提交文件', d: dialogTitle || 'none' },
    { n: '确认按钮写明数量「移到废纸篓（3）」', ok: confirmLabel === '移到废纸篓（3）', d: confirmLabel || 'none' },
    { n: '危险语气（data-tone=danger）', ok: dialogTone === 'danger', d: dialogTone || 'none' },
    { n: '列出了废纸篓可恢复与作用范围', ok: detailCount >= 3, d: `${detailCount} 条说明` },
  ]);
  await ev(`document.querySelector('.confirmation-footer .secondary-button').click()`);
  await sleep(1000);
  const afterCancelRows = await rowCount();
  const afterCancelBtn = await deleteBtn();
  const diskAfterCancel = UNTRACKED.filter((n) => fs.existsSync(path.join(LAB, n)));
  record('批量删除-取消', [
    { n: '取消后文件一个都没少', ok: afterCancelRows === 4 && diskAfterCancel.length === 3, d: `行 ${afterCancelRows} / 磁盘 ${diskAfterCancel.length}` },
    { n: '取消后入口仍在（勾选没被清掉）', ok: afterCancelBtn?.text === '删除 3 个', d: afterCancelBtn ? afterCancelBtn.text : 'absent' },
  ]);

  console.log('== 阶段 6：真删并对账 ==');
  const reopened = await ev(`(() => {
    const b = document.querySelector('[role="dialog"] .workspace-group-delete');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(800);
  const confirmed = await ev(`(() => {
    const b = document.querySelector('.confirmation-confirm');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  let message = '';
  if (reopened && confirmed) {
    for (let i = 0; i < 40; i += 1) {
      message = await ev(`(document.querySelector('[role="dialog"] .workspace-feedback')?.textContent ?? '').trim()`);
      if (message.includes('已删除')) break;
      await sleep(300);
    }
  }
  await sleep(1400);
  await shot('06-deleted.png');

  const finalRows = await rowCount();
  const diskLeft = UNTRACKED.filter((n) => fs.existsSync(path.join(LAB, n)));
  const trashFound = UNTRACKED.filter((n) => fs.existsSync(path.join(os.homedir(), '.Trash', n)));
  const porcelain = git('status', '--porcelain').split('\n').filter(Boolean);
  const indexHas = execFileSync('git', ['-C', LAB, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter((l) => UNTRACKED.includes(l));

  record('批量删除-真删', [
    { n: '给出成功消息「已删除 3 个未提交文件」', ok: message.includes('已删除 3 个未提交文件'), d: message || 'none' },
    { n: '列表只剩已跟踪文件', ok: finalRows === 1, d: `行数 ${finalRows}` },
    { n: '磁盘上 3 个文件已不在', ok: diskLeft.length === 0, d: diskLeft.join(',') || '全部移除' },
    { n: '索引里不再有这 3 个文件', ok: indexHas.length === 0, d: indexHas.join(',') || '索引干净' },
    { n: '工作区只剩那个已跟踪修改', ok: porcelain.length === 1 && porcelain[0].includes('src/tracked.ts'), d: porcelain.join(' | ') || 'clean' },
    { n: '3 个文件进了系统废纸篓', ok: trashFound.length === 3, d: `${trashFound.length} 个：${trashFound.join(',') || '无'}` },
  ]);
}

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

// 探针自己造的垃圾自己收：废纸篓里那 3 个测试文件删掉，别留在用户废纸篓。
for (const name of UNTRACKED) {
  try { fs.rmSync(path.join(os.homedir(), '.Trash', name), { force: true }); } catch { /* 读不到就算了 */ }
}
cleanup();
process.exit(failed.length ? 1 : 0);
