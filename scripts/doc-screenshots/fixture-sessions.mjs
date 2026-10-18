#!/usr/bin/env node
/**
 * 造 Claude / Codex 会话夹具（纯虚构内容），供 docs 截图使用。
 *
 * Claude 侧的目录名是 `cwd` 把 `/` 换成 `-` 的结果（`path.resolve(p).replaceAll('/', '-')`），
 * 和 `src/server` 里的读取逻辑必须一致，否则会话页会一条都扫不到。
 * 会话页要出现「已备份」而不是「待备份」，还需要 capture.sh 调一次
 * `POST /api/session-backup/initialize` 和 `POST /api/session-sync`。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.MOO_FLEET_DOCS_ROOT || '/tmp/moo-fleet-docs';
const claudeRoot = path.join(ROOT, 'claude', 'projects');
const codexRoot = path.join(ROOT, 'codex', 'sessions');
const projectsRoot = path.join(ROOT, 'projects');

const encode = (p) => path.resolve(p).replaceAll('/', '-');
const line = (obj) => `${JSON.stringify(obj)}\n`;

function writeSession(projectDir, id, { title, startedAt, turns, tokens }) {
  const dir = path.join(claudeRoot, encode(projectDir));
  fs.mkdirSync(dir, { recursive: true });
  const rows = [line({ type: 'session_start', timestamp: startedAt, title, cwd: projectDir })];
  let clock = Date.parse(startedAt);
  for (const turn of turns) {
    clock += 60_000;
    rows.push(line({ type: 'user', timestamp: new Date(clock).toISOString(), message: { role: 'user', content: turn.user } }));
    clock += 90_000;
    rows.push(
      line({
        type: 'assistant',
        timestamp: new Date(clock).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: turn.assistant }] },
      }),
    );
  }
  if (tokens) rows.push(line({ type: 'usage', timestamp: new Date(clock).toISOString(), ...tokens }));
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.join(''));
  return { dir, id };
}

const project = (name) => path.join(projectsRoot, name);

const created = [
  writeSession(project('acme-web'), 'a1f4c9d2-7b31-4e08-9c55-2d6a8e13f001', {
    title: '把首页统计卡片换成新的配色令牌',
    startedAt: '2026-10-16T09:12:00.000Z',
    turns: [
      { user: '首页那四个统计卡片还在用写死的颜色，帮我换成主题令牌。', assistant: '我先看一遍卡片组件里有哪些硬编码色值。' },
      { user: '顺便把 hover 态的边框也统一。', assistant: '已改成 --color-border 与 --color-surface-hover，并核对了五套主题。' },
    ],
    tokens: { input: 18420, output: 3210 },
  }),
  writeSession(project('northwind-api'), 'b7d2e510-3c44-4a19-8f27-6e1b9d4c7002', {
    title: '给 handler 补入参校验与错误码',
    startedAt: '2026-10-17T02:40:00.000Z',
    turns: [
      { user: 'handler 现在对空 id 没有任何防御，补一下。', assistant: '我加了前置校验，缺 id 时抛 400 对应的错误。' },
      { user: 'validate 那边也一起改，保持语义一致。', assistant: '两个文件已对齐，都要求 id 存在。' },
    ],
    tokens: { input: 9610, output: 1840 },
  }),
  writeSession(project('demo-mobile'), 'c3a8f621-91d0-4b7e-a5c3-8f2e0b6d4003', {
    title: '排查移动端接口 base 路径不一致',
    startedAt: '2026-10-15T14:05:00.000Z',
    turns: [
      { user: '远端新加了个 api 模块，本地拉下来之后路径对不上。', assistant: '差异在 base 常量，我对比了两边的提交。' },
    ],
    tokens: { input: 5230, output: 760 },
  }),
  writeSession(project('docs-site'), 'd9e1b734-5f62-4c88-b0a1-7d3c9e2f5004', {
    title: '文档站草稿暂存，先不提交',
    startedAt: '2026-10-14T07:30:00.000Z',
    turns: [{ user: '这段先 stash 起来，等版本号定了再写。', assistant: '已 stash，说明里写了 WIP: 文档草稿。' }],
    tokens: { input: 3120, output: 410 },
  }),
  writeSession(project('analytics-etl'), 'e5c4a082-6d17-4f39-9b62-1a8f3d0c6005', {
    title: '把全量抽取改成增量',
    startedAt: '2026-10-13T11:20:00.000Z',
    turns: [
      { user: '全量跑一次要四十分钟，改成按水位线增量。', assistant: '按 updated_at 做了水位线，首次仍走全量。' },
      { user: '打一个 v0.3.0 的 tag。', assistant: '已打 tag v0.3.0 并推送到远端。' },
    ],
    tokens: { input: 14780, output: 2660 },
  }),
];

// Codex 侧一个会话，让会话页出现两个 provider。
fs.mkdirSync(codexRoot, { recursive: true });
const codexRows = [
  line({
    timestamp: '2026-10-16T06:00:00.000Z',
    type: 'session_meta',
    payload: { cwd: project('infra-scripts'), title: '整理部署脚本的失败重试' },
  }),
  line({
    timestamp: '2026-10-16T06:02:00.000Z',
    type: 'response_item',
    payload: { kind: 'message', role: 'user', text: '部署脚本失败后没有重试，补一个。' },
  }),
  line({
    timestamp: '2026-10-16T06:04:00.000Z',
    type: 'response_item',
    payload: { kind: 'message', role: 'assistant', text: '加了三次退避重试，失败仍会明确退出。' },
  }),
];
fs.writeFileSync(path.join(codexRoot, 'rollout-2026-10-16T06-00-00-7f3a.jsonl'), codexRows.join(''));

console.log('claude 会话:', created.length);
for (const entry of created) console.log('  ', path.basename(entry.dir), entry.id);
console.log('codex 会话: 1');
