import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * 工作台批量多分支拉取的接口级测试。
 *
 * 覆盖「规则 → 每仓分支」这一层：两个仓库里一个同时有 dev 和 main、另一个只有 main，
 * 批量必须前者拉两条、后者拉一条并说明 dev 为什么缺席；快照只带分支名，脏数据不会悄悄扩大范围。
 */

const temporaryDirectories: string[] = [];
const execute = promisify(execFile);

async function createRepository(root: string, name: string, options: { withDev: boolean; pending?: boolean }): Promise<string> {
  const cwd = path.join(root, 'repos', name);
  await mkdir(cwd, { recursive: true });
  const remotePath = path.join(root, `${name}.git`);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await execute('git', ['init', '--bare', '-q', '--initial-branch=main', remotePath]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Batch Pull Test');
  await git('config', 'user.email', 'batch-pull@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await git('remote', 'add', 'origin', remotePath);
  await git('push', '-q', '-u', 'origin', 'main');
  if (options.withDev) {
    await git('branch', 'dev');
    await git('push', '-q', '-u', 'origin', 'dev');
  }
  // 用另一个克隆把两条线都往前推一笔，再让本地 fetch，于是本地各分支都落后 1。
  // `pending: false` 用于造「已经和远端一致」的仓库，验证排序把它垫到后面。
  if (options.pending !== false) {
    const seed = path.join(root, `${name}-seed`);
    await execute('git', ['clone', '-q', remotePath, seed]);
    const seedGit = async (...args: string[]) => (await execute('git', ['-C', seed, ...args])).stdout.trim();
    await seedGit('config', 'user.name', 'Seed');
    await seedGit('config', 'user.email', 'seed@example.test');
    await seedGit('checkout', '-q', 'main');
    await writeFile(path.join(seed, 'incoming.txt'), 'incoming\n');
    await seedGit('add', 'incoming.txt');
    await seedGit('-c', 'commit.gpgSign=false', 'commit', '-qm', 'incoming main');
    await seedGit('push', '-q', 'origin', 'main');
    if (options.withDev) {
      await seedGit('checkout', '-q', 'dev');
      await writeFile(path.join(seed, 'dev-incoming.txt'), 'dev incoming\n');
      await seedGit('add', 'dev-incoming.txt');
      await seedGit('-c', 'commit.gpgSign=false', 'commit', '-qm', 'incoming dev');
      await seedGit('push', '-q', 'origin', 'dev');
    }
  }
  await git('fetch', '-q', 'origin');
  return remotePath;
}

async function startApp(root: string, names: string[] = ['alpha', 'beta']) {
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8790');
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8790' };
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
    plan: (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/batches/pull-branches/plan', headers, payload }),
    start: (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/batches', headers, payload }),
    async awaitBatch(batchId: string) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await app.inject({ method: 'GET', url: '/api/operations', headers });
        const batch = current.json().batches.find((item: { id: string }) => item.id === batchId);
        if (batch?.state === 'completed') return batch;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('批次未在预期时间内完成');
    },
    operations: async () => (await app.inject({ method: 'GET', url: '/api/operations', headers })).json().operations,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it('批量多分支：有 dev 的仓拉两条，没 dev 的仓拉一条并说明原因', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-pull-'));
  temporaryDirectories.push(root);
  const alphaRemote = await createRepository(root, 'alpha', { withDev: true });
  const betaRemote = await createRepository(root, 'beta', { withDev: false });
  const { app, ids, repositoryIds, plan, start, awaitBatch, operations } = await startApp(root);

  const planned = await plan({ repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(planned.statusCode).toBe(200);
  const alpha = planned.json().plan.repositories.find((item: { repositoryId: string }) => item.repositoryId === ids.alpha);
  const beta = planned.json().plan.repositories.find((item: { repositoryId: string }) => item.repositoryId === ids.beta);
  expect(planned.json().plan).toMatchObject({ total: 2, eligible: 2 });
  expect(alpha.branches.map((branch: { name: string }) => branch.name).sort()).toEqual(['dev', 'main']);
  expect(alpha.blocker).toBeNull();
  expect(alpha.pending).toBe(2);
  expect(beta.branches.map((branch: { name: string }) => branch.name)).toEqual(['main']);
  expect(beta.pending).toBe(1);
  // 没有 dev 不是错误，但必须在清单里说清楚，否则用户会以为漏拉了。
  expect(beta.skipped).toEqual([{ name: 'dev', reason: '本地没有 dev 或 develop 分支' }]);

  const started = await start({ type: 'pull-branches', repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(started.statusCode).toBe(202);
  const batch = await awaitBatch(started.json().batch.id);
  expect(batch).toMatchObject({ total: 2, success: 2, failed: 0 });

  const history = await operations();
  const pullOperations = history.filter((operation: { batchId: string }) => operation.batchId === started.json().batch.id);
  expect(pullOperations).toHaveLength(2);
  expect(pullOperations.every((operation: { type: string }) => operation.type === 'pull-branches')).toBe(true);

  // 本地真的追上了远端：两条分支都要与远端一致，才算「一起拉」。
  const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  const alphaCwd = path.join(root, 'repos', 'alpha');
  const betaCwd = path.join(root, 'repos', 'beta');
  expect(await git(alphaCwd, 'rev-parse', 'dev')).toBe(await git(alphaRemote, 'rev-parse', 'refs/heads/dev'));
  expect(await git(alphaCwd, 'rev-parse', 'main')).toBe(await git(alphaRemote, 'rev-parse', 'refs/heads/main'));
  expect(await git(betaCwd, 'rev-parse', 'main')).toBe(await git(betaRemote, 'rev-parse', 'refs/heads/main'));

  // 紧接着再跑一次：已经没有落后分支，整批记成跳过而不是失败。
  const again = await start({ type: 'pull-branches', repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(again.statusCode).toBe(202);
  expect(await awaitBatch(again.json().batch.id)).toMatchObject({ total: 2, skipped: 2, failed: 0 });

  // 预检也应当同步归零，避免工具栏数字和实际执行脱节。
  const replanned = await plan({ repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(replanned.json().plan.eligible).toBe(0);
  await app.close();
});

it('pullTargets 快照只拉指定分支：没写进去的分支即使落后也不动', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-pull-snapshot-'));
  temporaryDirectories.push(root);
  const remote = await createRepository(root, 'alpha', { withDev: true });
  const { app, ids, repositoryIds, start, awaitBatch } = await startApp(root, ['alpha']);

  const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  const cwd = path.join(root, 'repos', 'alpha');
  const mainBefore = await git(cwd, 'rev-parse', 'main');

  // 只钉 dev 一条：main 虽然也落后，但没进快照就不该被顺手拉。
  const started = await start({
    type: 'pull-branches',
    repositoryIds,
    pullTargets: [{ repositoryId: ids.alpha, branches: ['dev'] }],
  });
  expect(started.statusCode).toBe(202);
  expect(await awaitBatch(started.json().batch.id)).toMatchObject({ total: 1, success: 1, failed: 0 });

  expect(await git(cwd, 'rev-parse', 'dev')).toBe(await git(remote, 'rev-parse', 'refs/heads/dev'));
  // main 一步没动，仍是预览前的本地提交。
  expect(await git(cwd, 'rev-parse', 'main')).toBe(mainBefore);
  await app.close();
});

it('快照里的仓库不在范围内时直接拒绝，不静默少拉', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-pull-scope-'));
  temporaryDirectories.push(root);
  await createRepository(root, 'alpha', { withDev: true });
  await createRepository(root, 'beta', { withDev: false });
  const { app, ids, repositoryIds, start } = await startApp(root);

  const started = await start({
    type: 'pull-branches',
    repositoryIds,
    pullTargets: [{ repositoryId: `${ids.alpha}-outsider`, branches: ['main'] }],
  });
  expect(started.statusCode).toBe(400);
  expect(started.json().error).toContain('范围外');
  await app.close();
});

it('档位参数非法时在预检阶段就被拒', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-pull-invalid-'));
  temporaryDirectories.push(root);
  await createRepository(root, 'alpha', { withDev: true });
  const { app, repositoryIds, plan, start } = await startApp(root, ['alpha']);

  expect((await plan({ repositoryIds, modes: [] })).statusCode).toBe(400);
  expect((await plan({ repositoryIds, modes: ['current', 'current'] })).statusCode).toBe(400);
  expect((await plan({ repositoryIds, modes: ['unknown'] })).statusCode).toBe(400);
  expect((await start({ type: 'pull-branches', repositoryIds, modes: ['current', 'current'] })).statusCode).toBe(400);
  await app.close();
});
