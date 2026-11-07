/**
 * 配置迁移的**真机 UI 驱动**：连 8802 上真实运行的实例，用浏览器真实点击走完整流程。
 *
 * 与 drive.mjs 的分工：那个打 API，这个打界面——只有界面才能暴露
 * 「按钮点不到」「结果看不见」「勾选状态不对」这类问题。
 */
import fs from 'node:fs';

const BASE = process.env.MOO_FLEET_E2E_BASE ?? '/tmp/moo-fleet-transfer-e2e';
const URL = 'http://127.0.0.1:8802';
const WIDTH = 1440;
const HEIGHT = 1000;

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
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 2,
  mobile: false,
});

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 800));
  return result.value;
}

async function shot(name) {
  const file = `${BASE}/${name}.png`;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`shot ${file}`);
}

const fail = [];
function check(label, condition, detail = '') {
  if (!condition) fail.push(`${label} ${detail}`);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// 页面文本的便捷读取
const bodyText = () => evaluate('document.body.innerText');

await send('Page.navigate', { url: URL });
await sleep(3000);

// 打开设置 → 配置迁移
await evaluate(`(() => {
  const chip = document.querySelector('button.profile-chip');
  if (!chip) throw new Error('找不到个人配置按钮');
  chip.click();
  return true;
})()`);
await sleep(600);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('.manage-nav button, nav button')]
    .find((node) => (node.textContent || '').trim() === '配置迁移');
  if (!button) throw new Error('找不到配置迁移分区');
  button.click();
  return true;
})()`);
await sleep(600);

const paneVisible = await evaluate(`!!document.querySelector('input.transfer-file-input')`);
check('配置迁移分区已打开', paneVisible);

// 注入导出文件（等价于用户点「选择配置文件…」并选中）
const { root } = await send('DOM.getDocument', { depth: 1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input.transfer-file-input' });
await send('DOM.setFileInputFiles', { nodeId, files: [`${BASE}/export.json`] });
await sleep(1800);

let text = await bodyText();
check('文件名已显示', text.includes('export.json'));
check('仓库数量已显示', text.includes('7 个仓库'));
check('预览汇总出现', text.includes('将克隆 2') && text.includes('只需登记 1'));
check('设置卡出现', text.includes('同时应用界面与 AI 设置'));
await shot('ui-01-preview');

// 逐个检查候选行的徽标
const rows = await evaluate(`JSON.stringify([...document.querySelectorAll('.transfer-row')].map((row) => ({
  status: row.dataset.status,
  name: row.querySelector('.transfer-row-name strong')?.textContent?.trim(),
  badge: row.querySelector('.transfer-badge')?.textContent?.trim(),
  checked: row.querySelector('input[type=checkbox]')?.checked,
  disabled: row.querySelector('input[type=checkbox]')?.disabled,
})))`);
const parsed = JSON.parse(rows);
console.log(JSON.stringify(parsed, null, 2));
check('预览共 7 行', parsed.length === 7);
check('api-service 默认勾选', parsed.find((row) => row.name === 'api-service')?.checked === true);
check('冲突行不可勾选', parsed.find((row) => row.name === 'web-console')?.disabled === true);
check('无法重建行不可勾选', parsed.find((row) => row.name === 'orphan-tool')?.disabled === true);

// 动作条：确认「导入选中 3 个」且按钮可见（在视口内）
const footer = await evaluate(`(() => {
  const button = document.querySelector('.transfer-footer .primary-button');
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return JSON.stringify({
    label: button.textContent.trim(),
    disabled: button.disabled,
    visible: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0,
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    innerHeight: window.innerHeight,
  });
})()`);
console.log('footer', footer);
const footerInfo = JSON.parse(footer);
check('主按钮文案正确', footerInfo.label === '导入选中 3 个', footerInfo.label);
check('主按钮可点', footerInfo.disabled === false);
check('主按钮在视口内', footerInfo.visible, `top=${footerInfo.top} bottom=${footerInfo.bottom} vh=${footerInfo.innerHeight}`);

// 清空 → 按钮应变灰且文案变「应用设置」
await evaluate(`[...document.querySelectorAll('.transfer-link-button')].find((b) => b.textContent.trim() === '清空').click()`);
await sleep(300);
const afterClear = await evaluate(`(() => {
  const button = document.querySelector('.transfer-footer .primary-button');
  return JSON.stringify({ label: button.textContent.trim(), disabled: button.disabled });
})()`);
check('清空后只剩设置可应用', JSON.parse(afterClear).label === '应用设置', afterClear);
check('清空后未勾选仓库时按钮仍可用', JSON.parse(afterClear).disabled === false);

// 全选 → 恢复 3 个
await evaluate(`[...document.querySelectorAll('.transfer-link-button')].find((b) => b.textContent.trim() === '全选').click()`);
await sleep(300);
const afterAll = await evaluate(`document.querySelector('.transfer-footer .primary-button').textContent.trim()`);
check('全选后回到 3 个', afterAll === '导入选中 3 个', afterAll);

// 只取消设置勾选：按钮应显示「导入选中 3 个」且不再带设置
await evaluate(`(() => {
  const checkbox = document.querySelector('.transfer-settings-check input');
  checkbox.click();
  return true;
})()`);
await sleep(300);
const afterUnset = await evaluate(`document.querySelector('.transfer-progress').textContent.trim()`);
check('取消设置后进度提示不再带设置', !afterUnset.includes('带设置'), afterUnset);
await evaluate(`document.querySelector('.transfer-settings-check input').click()`);
await sleep(300);

// 真正导入
await evaluate(`document.querySelector('.transfer-footer .primary-button').click()`);
await sleep(9000);

text = await bodyText();
await shot('ui-02-imported');
check('出现成功提示', /仓库已加入工作台|已加入，/.test(text), text.match(/[^\n]*已加入[^\n]*/)?.[0] ?? '');
const results = await evaluate(`JSON.stringify([...document.querySelectorAll('.transfer-results li')].map((li) => ({
  status: li.dataset.status,
  text: li.textContent.replace(/\\s+/g, ' ').trim(),
})))`);
console.log('results', results);
const parsedResults = JSON.parse(results);
check('结果条包含设置一项', parsedResults.some((item) => item.text.includes('界面与 AI 设置')));
check('结果条包含克隆成功', parsedResults.some((item) => item.status === 'cloned'));
// 冲突项根本没被勾选，所以不该出现在结果里——出现了说明选择状态算错了。
check('未选中的冲突项不出现在结果里', parsedResults.every((item) => item.status !== 'failed'));

check('落盘 api-service', fs.existsSync(`${BASE}/dst-root/api-service/.git/config`));
check('落盘 brand-new', fs.existsSync(`${BASE}/dst-root/brand-new/.git/config`));
const profileYaml = fs.readFileSync(`${BASE}/dst-home/config/profile.yaml`, 'utf8');
check('主题已写入磁盘', profileYaml.includes('theme: monokai'));
check('Key 已替换', fs.readFileSync(`${BASE}/dst-home/deepseek_token`, 'utf8').trim() === 'sk-source-machine-key-0001');

// 导入完成后设置卡应收起（已应用过，不该再留一个「应用设置」按钮）
await sleep(500);
const settingsCard = await evaluate(`!!document.querySelector('.transfer-settings')`);
check('导入后设置卡自动收起', settingsCard === false);

const afterImportText = await bodyText();
// fresh-repo 本来就登记着，加上新导入的 3 个（api-service / legacy-core / brand-new）。
check('二次预览显示已在工作台', afterImportText.includes('已在工作台 4'), afterImportText.match(/已在工作台 \d+/)?.[0] ?? '');

console.log(fail.length ? `\n${fail.length} 项失败` : '\n全部通过');
ws.close();
process.exit(fail.length ? 1 : 0);
