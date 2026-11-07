/**
 * 跨机配置迁移的真机驱动：直连两个真实运行中的实例，跑完整链路。
 *
 * 用法：node scripts/transfer-e2e/drive.mjs [--prepare]
 *   --prepare  先重置目标机（重新 seed），再跑
 *
 * 这不是单测：它打的是 dist 里真实构建的服务，读写真实 YAML 与真实 git 仓库。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'http://127.0.0.1:8801';
const DST = 'http://127.0.0.1:8802';
const BASE = process.env.MOO_FLEET_E2E_BASE ?? '/tmp/moo-fleet-transfer-e2e';

const fail = [];
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) fail.push(`${label} ${detail}`);
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function tokenOf(base) {
  const response = await fetch(`${base}/api/session`);
  return (await response.json()).token;
}

function client(base, token) {
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-git-fleet-token': token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    // 两个分支都会赋值，初始值一律用不上——写成 `let json = null` 只是噪音。
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  };
}

const srcToken = await tokenOf(SRC);
const dstToken = await tokenOf(DST);
const src = client(SRC, srcToken);
const dst = client(DST, dstToken);

if (process.argv.includes('--prepare')) {
  execFileSync(path.join(import.meta.dirname, 'seed.sh'), { stdio: 'inherit' });
}

// 1. 源机导出 -----------------------------------------------------------------
const exported = await src('GET', '/api/config/export');
check('源机导出 200', exported.status === 200, `status=${exported.status}`);
const payload = exported.body;
const remotes = payload.repositories.map((entry) => entry.remote);
check(
  '导出保留原始远端地址（不是 insteadOf 展开值）',
  remotes.every((remote) => remote === null || remote.startsWith('git@gitee.com:')),
  JSON.stringify(remotes),
);
check('导出不含 git 凭证', !JSON.stringify(payload).includes('token@'));
check('导出带外观', Boolean(payload.appearance?.theme), payload.appearance?.theme);
check('导出带 Key', payload.ai?.apiKey === 'sk-source-machine-key-0001');
const brandNewExport = payload.repositories.find((entry) => entry.name === 'brand-new');
check('导出带 AI 策略', brandNewExport?.aiCommitPolicy === 'disabled', brandNewExport?.aiCommitPolicy);
check(
  '导出带能力开关',
  brandNewExport?.capabilities?.commit === false && brandNewExport?.capabilities?.push === false,
  JSON.stringify(brandNewExport?.capabilities),
);
// UI 链路要一份真实的导出文件（浏览器的 file input 只能喂磁盘上的文件）。
fs.writeFileSync(`${BASE}/export.json`, `${JSON.stringify(payload, null, 2)}\n`);

// 2. 目标机预览 ---------------------------------------------------------------
const preview = await dst('POST', '/api/config/import/preview', { payload, rootId: 'www' });
check('预览 200', preview.status === 200, `status=${preview.status}`);
const byName = new Map(preview.body.candidates.map((candidate) => [candidate.name, candidate]));
const expected = {
  'api-service': 'clone',      // 登记还在但目录已被外部删掉 → 应重建
  'web-console': 'conflict',   // 同名目录不是 Git 仓库
  'docs-site': 'conflict',     // 同名目录是不相干的 Git 仓库（origin 不同）
  'legacy-core': 'link',       // 已克隆同一远端（SSH vs HTTPS 写法不同）
  'fresh-repo': 'existing',    // 已登记且目录在
  'brand-new': 'clone',        // 全新
  'orphan-tool': 'no-remote',  // 目录不在、也没远端
};
for (const [name, status] of Object.entries(expected)) {
  const candidate = byName.get(name);
  check(`预览 ${name} = ${status}`, candidate?.status === status, `实际 ${candidate?.status} · ${candidate?.detail ?? ''}`);
}
check('预览 counts 自洽', preview.body.counts.clone === 2 && preview.body.counts.conflict === 2);
check('预览 Key 状态 = overwrite', preview.body.settings.apiKeyState === 'overwrite');

// 3. 逐条导入 ----------------------------------------------------------------
const order = ['api-service', 'web-console', 'docs-site', 'legacy-core', 'fresh-repo', 'brand-new', 'orphan-tool'];
for (const name of order) {
  const candidate = byName.get(name);
  const result = await dst('POST', '/api/config/import', { payload, rootId: 'www', key: candidate.key });
  check(
    `导入 ${name} (${candidate.status}) → ${result.body.status ?? result.status}`,
    result.status === 200,
    `${result.body.status} · ${result.body.message ?? JSON.stringify(result.body)}`,
  );
}

// 4. 落盘检查 ----------------------------------------------------------------
const cloned = ['api-service', 'brand-new'];
for (const name of cloned) {
  const gitConfig = `${BASE}/dst-root/${name}/.git/config`;
  check(`克隆落地 ${name}`, fs.existsSync(gitConfig));
  if (fs.existsSync(gitConfig)) {
    const raw = fs.readFileSync(gitConfig, 'utf8');
    check(`${name} 的 origin 是原始地址`, raw.includes(`git@gitee.com:acme/${name}.git`), raw.match(/url = .*/)?.[0]);
  }
}
check('冲突目录未被改动', fs.existsSync(`${BASE}/dst-root/web-console/notes.txt`));
check('冲突仓库 origin 未被改写', fs.readFileSync(`${BASE}/dst-root/docs-site/.git/config`, 'utf8').includes('other-remote'));

// 目标机配置里，克隆进来的 brand-new 必须带着源机器的策略与关掉的开关。
const dstRepositories = fs.readFileSync(`${BASE}/dst-home/config/repositories.yaml`, 'utf8');
const brandNewBlock = dstRepositories
  .split(/\n {2}- id:/)
  .find((block) => block.includes('name: brand-new')) ?? '';
check('导入后 AI 策略随仓库落地', brandNewBlock.includes('aiCommitPolicy: disabled'), brandNewBlock.match(/aiCommitPolicy: .*/)?.[0] ?? '未找到');
check(
  '导入后能力开关保持关闭',
  /commit: false/.test(brandNewBlock) && /push: false/.test(brandNewBlock) && /stage: false/.test(brandNewBlock),
  brandNewBlock.match(/capabilities:[\s\S]{0,160}/)?.[0]?.replace(/\s+/g, ' ') ?? '未找到',
);

// 5. 应用设置 ----------------------------------------------------------------
const settings = await dst('POST', '/api/config/import/settings', { payload });
check('应用设置 200', settings.status === 200, `status=${settings.status}`);
check('Key 已写入并生效', settings.body.apiKeyApplied === true && settings.body.apiKeyEffective === true);
const dstProfile = fs.readFileSync(`${BASE}/dst-home/config/profile.yaml`, 'utf8');
check('主题已覆盖', dstProfile.includes('theme: monokai'));
check('界面字体已覆盖', dstProfile.includes('interfaceFont: plex') && dstProfile.includes('interfaceFontSize: 15'));
check('代码字体已覆盖', dstProfile.includes('codeFont: fira-code') && dstProfile.includes('codeFontSize: 13'));
check('排序等本机视角未被改动', dstProfile.includes('repositorySort: name'));
check('语言偏好未被改动', dstProfile.includes('preferredCommitLanguage: en-US'));
const tokenMode = (fs.statSync(`${BASE}/dst-home/deepseek_token`).mode & 0o777).toString(8);
check('Key 文件权限 600', tokenMode === '600', tokenMode);
check('Key 内容已替换', fs.readFileSync(`${BASE}/dst-home/deepseek_token`, 'utf8').trim() === 'sk-source-machine-key-0001');

// 6. 再预览：全应变成已有 ------------------------------------------------
const after = await dst('POST', '/api/config/import/preview', { payload, rootId: 'www' });
const afterByName = new Map(after.body.candidates.map((candidate) => [candidate.name, candidate]));
check('二次预览 api-service 已在工作台', afterByName.get('api-service')?.status === 'existing', afterByName.get('api-service')?.detail);
check('二次预览 brand-new 已在工作台', afterByName.get('brand-new')?.status === 'existing');
check('二次预览 web-console 仍是冲突', afterByName.get('web-console')?.status === 'conflict');
check('二次预览 settings 的 Key = same', after.body.settings.apiKeyState === 'same', after.body.settings.apiKeyState);

console.log(fail.length ? `\n${fail.length} 项失败` : '\n全部通过');
process.exit(fail.length ? 1 : 0);
