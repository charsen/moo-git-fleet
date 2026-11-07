/**
 * 旧格式导出文件的真机兼容：没有 aiCommitPolicy / capabilities 的载荷能不能导入。
 *
 * 为什么单测之外还要这一层：schema 的默认值在单测里是「喂一个对象给 parse」，
 * 而真实链路是 客户端 JSON → 路由 → zod → 落 YAML → 再读回。中间任何一环把
 * 默认值丢掉（比如 store 写入时按 schema 重解析、或 YAML dump 丢掉空字段），
 * 单测都看不见。
 *
 * 两种形态都要覆盖：
 *  a) 字段整段缺失 —— 早于这两个字段的导出文件
 *  b) 只写了部分能力开关 —— 手改过的文件
 * 期望：缺的补 `redacted-patch` + 全 true，写了的照原样。
 *
 * 前置：run.sh 会先 seed 一次，所以这里假设目标机是干净状态。
 */
import fs from 'node:fs';

const SRC = 'http://127.0.0.1:8801';
const DST = 'http://127.0.0.1:8802';
const BASE = process.env.MOO_FLEET_E2E_BASE ?? '/tmp/moo-fleet-transfer-e2e';

const fail = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) fail.push(label);
}

async function tokenOf(base) {
  return (await (await fetch(`${base}/api/session`)).json()).token;
}

function client(base, token) {
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-git-fleet-token': token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  };
}

const src = client(SRC, await tokenOf(SRC));
const dst = client(DST, await tokenOf(DST));

const exported = await src('GET', '/api/config/export');
check('源机导出 200', exported.status === 200, `status=${exported.status}`);

const payload = structuredClone(exported.body);
for (const entry of payload.repositories) {
  if (entry.name === 'brand-new') {
    delete entry.aiCommitPolicy;
    delete entry.capabilities;
  }
  if (entry.name === 'api-service') {
    delete entry.aiCommitPolicy;
    entry.capabilities = { push: false, commit: false };
  }
}

const preview = await dst('POST', '/api/config/import/preview', { payload, rootId: 'www' });
check('旧格式载荷预览 200', preview.status === 200, `status=${preview.status} · ${JSON.stringify(preview.body).slice(0, 120)}`);
const byName = new Map(preview.body.candidates.map((candidate) => [candidate.name, candidate]));
check('旧格式 brand-new 仍判 clone', byName.get('brand-new')?.status === 'clone', byName.get('brand-new')?.status);
check('旧格式 api-service 仍判 clone', byName.get('api-service')?.status === 'clone', byName.get('api-service')?.status);

for (const name of ['brand-new', 'api-service']) {
  const result = await dst('POST', '/api/config/import', { payload, rootId: 'www', key: byName.get(name).key });
  check(
    `旧格式导入 ${name} → ${result.body.status ?? result.status}`,
    result.body.status === 'cloned',
    result.body.message ?? JSON.stringify(result.body).slice(0, 120),
  );
}

const yaml = fs.readFileSync(`${BASE}/dst-home/config/repositories.yaml`, 'utf8');
const block = (name) => yaml.split(/\n {2}- id:/).find((part) => part.includes(`name: ${name}`)) ?? '';
const capabilitiesOf = (name) => block(name).match(/capabilities:[\s\S]{0,160}/)?.[0]?.replace(/\s+/g, ' ') ?? '未找到';

const brandNew = block('brand-new');
check('缺字段 → 默认策略', brandNew.includes('aiCommitPolicy: redacted-patch'), brandNew.match(/aiCommitPolicy: .*/)?.[0] ?? '未找到');
check(
  '缺字段 → 六个开关全开',
  ['fetch', 'pull', 'stage', 'commit', 'stash', 'push'].every((key) => new RegExp(`${key}: true`).test(brandNew)),
  capabilitiesOf('brand-new'),
);

const apiService = block('api-service');
check(
  '部分字段 → 写了的照原样',
  /commit: false/.test(apiService) && /push: false/.test(apiService),
  capabilitiesOf('api-service'),
);
check('部分字段 → 缺的补 true', /fetch: true/.test(apiService) && /stage: true/.test(apiService) && /stash: true/.test(apiService));

console.log(fail.length ? `\n${fail.length} 项失败` : '\n全部通过');
process.exit(fail.length ? 1 : 0);
