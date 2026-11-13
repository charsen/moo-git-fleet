import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * 工作台「双线合并」的接口级测试。
 *
 * 覆盖的是「预检 → 快照 → 批量执行」这条链路：一个仓库有 dev 与 main、一个只有 main，
 * 两边都要把任务分支合回各自存在的目标线；工作区脏的仓库整仓跳过；快照越界直接拒绝。
 */

const temporaryDirectories: string[] = [];
const execute = promisify(execFile);

async function createRepository(root: string, name: string, options: { withDev: boolean }): Promise<string> {
  const cwd = path.join(root, 'repos', name);
  await mkdir(cwd, { recursive: true });
  const remotePath = path.join(root, `${name}.git`);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await execute('git', ['init', '--bare', '-q', '--initial-branch=main', remotePath]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Batch Merge Test');
  await git('config', 'user.email', 'batch-merge@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await git('remote', 'add', 'origin', remotePath);
  await git('push', '-q', '-u', 'origin', 'main');
  if (options.withDev) {
    await git('branch', 'dev');
    await git('push', '-q', '-u', 'origin', 'dev');
  }
  // 任务分支：只加一个文件，能同时快进到 dev 与 main。
  await git('checkout', '-q', '-b', 'feature');
  await writeFile(path.join(cwd, 'feature.txt'), 'feature\n');
  await git('add', 'feature.txt');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'feature work');
  return cwd;
}

async function createConflictingRepository(root: string, name: string): Promise<string> {
  const cwd = path.join(root, 'repos', name);
  await mkdir(cwd, { recursive: true });
  const remotePath = path.join(root, `${name}.git`);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await execute('git', ['init', '--bare', '-q', '--initial-branch=main', remotePath]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Batch Merge Test');
  await git('config', 'user.email', 'batch-merge@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await writeFile(path.join(cwd, 'shared.txt'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await git('remote', 'add', 'origin', remotePath);
  await git('push', '-q', '-u', 'origin', 'main');
  await git('branch', 'dev');
  await git('push', '-q', '-u', 'origin', 'dev');
  // 两条任务分支都改同一行、内容不同：先合 feature-a 再合 feature-b 必然冲突。
  await git('checkout', '-q', '-b', 'feature-a');
  await writeFile(path.join(cwd, 'shared.txt'), 'a\n');
  await git('add', 'shared.txt');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'feature a');
  await git('checkout', '-q', 'main');
  await git('checkout', '-q', '-b', 'feature-b');
  await writeFile(path.join(cwd, 'shared.txt'), 'b\n');
  await git('add', 'shared.txt');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'feature b');
  return cwd;
}

async function startApp(root: string, names: string[]) {
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8791');
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8791' };
  const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
  const headers = { ...host, 'x-git-fleet-token': token };
  const registeredRoot = await app.inject({
    method: 'POST',
    url: '/api/repository-roots',
    headers,
    payload: { path: path.join(root, 'repos') },
  });
  const ids: Record<string, string> = {};
  for (const name of names) {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers,
      payload: { rootId: registeredRoot.json().rootId, relativePath: name, name, group: 'Tests', tags: [] },
    });
    expect(registered.statusCode).toBe(201);
    ids[name] = registered.json().id;
  }
  const repositoryIds = names.map((name) => ids[name] as string);
  return {
    app,
    ids,
    repositoryIds,
    plan: (payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: '/api/batches/merge-branches/plan', headers, payload }),
    start: (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/batches', headers, payload }),
    async awaitBatch(batchId: string) {
      let last: unknown = null;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const current = await app.inject({ method: 'GET', url: '/api/operations', headers });
        const payload = current.json();
        last = payload;
        const batch = payload.batches.find((item: { id: string }) => item.id === batchId);
        if (batch?.state === 'completed') return batch;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`批次未在预期时间内完成：${JSON.stringify(last)}`);
    },
    operations: async () => (await app.inject({ method: 'GET', url: '/api/operations', headers })).json().operations,
  };
}

async function gitAt(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-C', cwd, ...args])).stdout.trim();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it('批量双线合并：有 dev 的仓合两条线，没 dev 的仓只合主分支，最后都切回任务分支', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-merge-'));
  temporaryDirectories.push(root);
  const alpha = await createRepository(root, 'alpha', { withDev: true });
  const beta = await createRepository(root, 'beta', { withDev: false });
  const { app, ids, repositoryIds, plan, start, awaitBatch, operations } = await startApp(root, ['alpha', 'beta']);

  const planned = await plan({ repositoryIds });
  expect(planned.statusCode).toBe(200);
  const body = planned.json().plan;
  expect(body).toMatchObject({ total: 2, eligible: 2 });
  const alphaPlan = body.repositories.find((item: { repositoryId: string }) => item.repositoryId === ids.alpha);
  const betaPlan = body.repositories.find((item: { repositoryId: string }) => item.repositoryId === ids.beta);
  expect(alphaPlan.targets).toEqual(['dev', 'main']);
  expect(betaPlan.targets).toEqual(['main']);
  expect(alphaPlan.sources.map((source: { name: string }) => source.name)).toEqual(['feature']);
  expect(alphaPlan.pendingMerges).toBe(2);
  expect(betaPlan.pendingMerges).toBe(1);
  // 预检是只读的，不能顺手把用户切走。
  expect(await gitAt(alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');

  const started = await start({
    type: 'merge-branches',
    repositoryIds,
    mergeTargets: [
      { repositoryId: ids.alpha, sources: [{ name: 'feature', head: alphaPlan.sources[0].head }], targets: ['dev', 'main'] },
      { repositoryId: ids.beta, sources: [{ name: 'feature', head: betaPlan.sources[0].head }], targets: ['main'] },
    ],
  });
  expect(started.statusCode).toBe(202);
  expect(await awaitBatch(started.json().batch.id)).toMatchObject({ total: 2, success: 2, failed: 0 });

  // 两条线都拿到了 feature 的文件，且工作区回到任务分支上。
  expect(await gitAt(alpha, 'show', 'dev:feature.txt')).toBe('feature');
  expect(await gitAt(alpha, 'show', 'main:feature.txt')).toBe('feature');
  expect(await gitAt(beta, 'show', 'main:feature.txt')).toBe('feature');
  expect(await gitAt(alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
  expect(await gitAt(beta, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');

  const history = await operations();
  const merges = history.filter((operation: { batchId: string }) => operation.batchId === started.json().batch.id);
  expect(merges.every((operation: { type: string }) => operation.type === 'merge-branches')).toBe(true);
  expect(merges.every((operation: { message: string }) => operation.message.includes('已切回 feature'))).toBe(true);

  // 再跑一次：没有任何线要动，整批记跳过而不是失败。
  const again = await start({ type: 'merge-branches', repositoryIds });
  expect(again.statusCode).toBe(202);
  expect(await awaitBatch(again.json().batch.id)).toMatchObject({ total: 2, skipped: 2, failed: 0 });
  await app.close();
});

it('工作区不干净的仓库整仓跳过，且不会切走它的分支', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-merge-dirty-'));
  temporaryDirectories.push(root);
  const alpha = await createRepository(root, 'alpha', { withDev: true });
  await writeFile(path.join(alpha, 'feature.txt'), 'uncommitted\n');
  const { app, repositoryIds, plan, start, awaitBatch, operations } = await startApp(root, ['alpha']);

  const planned = await plan({ repositoryIds });
  const row = planned.json().plan.repositories[0];
  // 脏工作区不再整仓 blocker，而是把源分支标为被挡下（可清���的另算）。
  expect(row.blocker).toBeNull();
  expect(row.worktreeDirty).toBe(true);
  expect(row.sources.length).toBeGreaterThan(0);
  expect(row.sources.every((source: { blocker: string | null }) => source.blocker?.includes('工作区有未提交改动'))).toBe(true);
  expect(planned.json().plan.eligible).toBe(0);

  const started = await start({ type: 'merge-branches', repositoryIds });
  expect(started.statusCode).toBe(202);
  expect(await awaitBatch(started.json().batch.id)).toMatchObject({ total: 1, skipped: 1, failed: 0 });
  const history = await operations();
  expect(history[0].skipReason).toBe('blocked');
  expect(history[0].message).toContain('工作区有未提交改动');
  expect(await gitAt(alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
  await app.close();
});

it('快照越界与非法参数在入队前就被拒', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-merge-invalid-'));
  temporaryDirectories.push(root);
  await createRepository(root, 'alpha', { withDev: true });
  const { app, ids, repositoryIds, start } = await startApp(root, ['alpha']);
  const head = '0'.repeat(40);

  const outsider = await start({
    type: 'merge-branches',
    repositoryIds,
    mergeTargets: [{ repositoryId: `${ids.alpha}-outsider`, sources: [{ name: 'feature', head }], targets: ['dev'] }],
  });
  expect(outsider.statusCode).toBe(400);
  expect(outsider.json().error).toContain('范围外');

  // 目标线最多两条：dev + main 就够了，多出来的必然是想混进去的第三张网。
  const tooManyTargets = await start({
    type: 'merge-branches',
    repositoryIds,
    mergeTargets: [{ repositoryId: ids.alpha, sources: [{ name: 'feature', head }], targets: ['dev', 'main', 'release'] }],
  });
  expect(tooManyTargets.statusCode).toBe(400);

  const duplicateSource = await start({
    type: 'merge-branches',
    repositoryIds,
    mergeTargets: [
      { repositoryId: ids.alpha, sources: [{ name: 'feature', head }, { name: 'feature', head }], targets: ['dev'] },
    ],
  });
  expect(duplicateSource.statusCode).toBe(400);
  await app.close();
});

it('两条源分支冲突时整仓记失败、仓库停在目标线且不再继续', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-merge-conflict-'));
  temporaryDirectories.push(root);
  const alpha = await createConflictingRepository(root, 'alpha');
  const { app, ids, repositoryIds, plan, start, awaitBatch, operations } = await startApp(root, ['alpha']);

  const planned = await plan({ repositoryIds });
  const row = planned.json().plan.repositories[0];
  expect(row.targets).toEqual(['dev', 'main']);
  const sources = row.sources.map((source: { name: string; head: string }) => ({ name: source.name, head: source.head }));
  expect(sources.map((source: { name: string }) => source.name).sort()).toEqual(['feature-a', 'feature-b']);

  const started = await start({
    type: 'merge-branches',
    repositoryIds,
    mergeTargets: [{ repositoryId: ids.alpha, sources, targets: ['dev', 'main'] }],
  });
  expect(started.statusCode).toBe(202);
  // 冲突按失败计：批次抽屉的「需处理」要能点出这一仓，而不是假装成功。
  expect(await awaitBatch(started.json().batch.id)).toMatchObject({ total: 1, success: 0, failed: 1 });

  // 冲突后仓库停在目标线 dev、处于 merge 中途 —— 不谎报已切回 feature。
  expect(await gitAt(alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev');
  expect(await gitAt(alpha, 'rev-parse', '--verify', 'MERGE_HEAD')).toMatch(/^[a-f0-9]{40}$/);

  const history = await operations();
  expect(history[0].type).toBe('merge-branches');
  expect(history[0].state).toBe('failed');
  expect(history[0].message).toContain('冲突');
  await app.close();
});

it('可选清理：合并后删除已完全合进两条线的任务分支，并落到目标线', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-merge-cleanup-'));
  temporaryDirectories.push(root);
  const alpha = await createRepository(root, 'alpha', { withDev: true });
  const { app, ids, repositoryIds, plan, start, awaitBatch } = await startApp(root, ['alpha']);

  const row = (await plan({ repositoryIds })).json().plan.repositories[0];
  const sources = row.sources.map((source: { name: string; head: string }) => ({ name: source.name, head: source.head }));

  const started = await start({
    type: 'merge-branches',
    repositoryIds,
    deleteMergedBranches: true,
    mergeTargets: [{ repositoryId: ids.alpha, sources, targets: row.targets }],
  });
  expect(started.statusCode).toBe(202);
  expect(await awaitBatch(started.json().batch.id)).toMatchObject({ total: 1, success: 1, failed: 0 });

  expect(await gitAt(alpha, 'show', 'dev:feature.txt')).toBe('feature');
  expect(await gitAt(alpha, 'show', 'main:feature.txt')).toBe('feature');
  // feature 已完全合进 dev / main，被删除；结束时切到主分支 main。
  expect(await gitAt(alpha, 'branch', '--list', 'feature')).toBe('');
  expect(await gitAt(alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  // dev / main 本身绝不在清理范围。
  expect((await gitAt(alpha, 'branch', '--format=%(refname:short)')).split('\n').sort()).toEqual(['dev', 'main']);
  await app.close();
});

it('已同步、无内容可合并时也能只清理：删已合并分支并切到主分支', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-merge-cleanonly-'));
  temporaryDirectories.push(root);
  const alpha = await createRepository(root, 'alpha', { withDev: true });
  const { app, ids, repositoryIds, plan, start, awaitBatch } = await startApp(root, ['alpha']);

  // 先正常合并一次（不清理），让 feature 进入 dev / main。
  const first = (await plan({ repositoryIds })).json().plan.repositories[0];
  const firstSources = first.sources.map((source: { name: string; head: string }) => ({ name: source.name, head: source.head }));
  const merged = await start({
    type: 'merge-branches',
    repositoryIds,
    mergeTargets: [{ repositoryId: ids.alpha, sources: firstSources, targets: first.targets }],
  });
  expect(merged.statusCode).toBe(202);
  await awaitBatch(merged.json().batch.id);

  // 再预检：没有可合并源分支，但 feature 是可清理的已合并分支。
  const second = (await plan({ repositoryIds })).json().plan.repositories[0];
  expect(second.sources).toHaveLength(0);
  expect(second.mergedBranches).toEqual(['feature']);

  // 只清理：sources 传空数组 + deleteMergedBranches。
  const cleaned = await start({
    type: 'merge-branches',
    repositoryIds,
    deleteMergedBranches: true,
    mergeTargets: [{ repositoryId: ids.alpha, sources: [], targets: second.targets }],
  });
  expect(cleaned.statusCode).toBe(202);
  // 只清理也算有产出：不能被记成跳过。
  expect(await awaitBatch(cleaned.json().batch.id)).toMatchObject({ total: 1, success: 1, failed: 0, skipped: 0 });

  expect(await gitAt(alpha, 'branch', '--list', 'feature')).toBe('');
  expect(await gitAt(alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  expect((await gitAt(alpha, 'branch', '--format=%(refname:short)')).split('\n').sort()).toEqual(['dev', 'main']);
  await app.close();
});
