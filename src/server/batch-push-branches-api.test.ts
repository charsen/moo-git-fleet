import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * 工作台批量多分支推送的接口级测试。
 *
 * 覆盖的是「规则 → 每仓分支」这一层：两个仓库里一个同时有 dev 和 main、
 * 另一个只有 main，批量必须前者推两条、后者推一条并说明 dev 为什么缺席。
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
  await git('config', 'user.name', 'Batch Push Test');
  await git('config', 'user.email', 'batch-push@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await git('remote', 'add', 'origin', remotePath);
  await git('push', '-q', '-u', 'origin', 'main');
  if (options.withDev) {
    await git('branch', 'dev');
    await git('push', '-q', '-u', 'origin', 'dev');
    await git('checkout', '-q', 'dev');
    await writeFile(path.join(cwd, 'dev.txt'), 'dev\n');
    await git('add', 'dev.txt');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'dev work');
    await git('checkout', '-q', 'main');
  }
  // 主分支都留一笔未推送提交：两条分支都必须真的推上去。
  // `pending: false` 用于造「已经和远端一致」的仓库，验证排序把它的行垫到后面。
  if (options.pending !== false) {
    await writeFile(path.join(cwd, 'main.txt'), 'main\n');
    await git('add', 'main.txt');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'main work');
  }
  return remotePath;
}

async function startApp(root: string, names: string[] = ['alpha', 'beta']) {
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8789');
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8789' };
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
      app.inject({ method: 'POST', url: '/api/batches/push-branches/plan', headers, payload }),
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

it('批量多分支：有 dev 的仓推两条，没 dev 的仓推一条并说明原因', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-push-'));
  temporaryDirectories.push(root);
  const alphaRemote = await createRepository(root, 'alpha', { withDev: true });
  const betaRemote = await createRepository(root, 'beta', { withDev: false });
  const { app, ids, repositoryIds, plan, start, awaitBatch, operations } = await startApp(root);

  const planned = await plan({ repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(planned.statusCode).toBe(200);
  const alpha = planned.json().plan.repositories.find((item: { repositoryId: string }) => item.repositoryId === ids.alpha);
  const beta = planned.json().plan.repositories.find((item: { repositoryId: string }) => item.repositoryId === ids.beta);
  expect(planned.json().plan).toMatchObject({ total: 2, eligible: 2 });
  expect(alpha.targets.map((branch: { name: string }) => branch.name).sort()).toEqual(['dev', 'main']);
  expect(alpha.blocker).toBeNull();
  expect(beta.targets.map((branch: { name: string }) => branch.name)).toEqual(['main']);
  // 没有 dev 不是错误，但必须在清单里说清楚，否则用户会以为漏推了。
  expect(beta.skipped).toEqual([{ name: 'dev', reason: '仓库没有 dev 或 develop 分支' }]);

  const started = await start({ type: 'push-branches', repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(started.statusCode).toBe(202);
  const batch = await awaitBatch(started.json().batch.id);
  expect(batch).toMatchObject({ total: 2, success: 2, failed: 0 });

  const history = await operations();
  const pushOperations = history.filter((operation: { batchId: string }) => operation.batchId === started.json().batch.id);
  expect(pushOperations).toHaveLength(2);
  expect(pushOperations.every((operation: { type: string }) => operation.type === 'push-branches')).toBe(true);
  expect(pushOperations.map((operation: { message: string }) => operation.message).sort()).toEqual([
    '已推送 dev、main',
    '已推送 main',
  ]);

  // 远端真的前进了：两条分支都要与本地一致，才算「一起提交」。
  const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  const alphaCwd = path.join(root, 'repos', 'alpha');
  const betaCwd = path.join(root, 'repos', 'beta');
  expect(await git(alphaRemote, 'rev-parse', 'refs/heads/dev')).toBe(await git(alphaCwd, 'rev-parse', 'dev'));
  expect(await git(alphaRemote, 'rev-parse', 'refs/heads/main')).toBe(await git(alphaCwd, 'rev-parse', 'main'));
  expect(await git(betaRemote, 'rev-parse', 'refs/heads/main')).toBe(await git(betaCwd, 'rev-parse', 'main'));

  // 紧接着再跑一次：已经没有可推分支，整批记成跳过而不是失败。
  const again = await start({ type: 'push-branches', repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(again.statusCode).toBe(202);
  expect(await awaitBatch(again.json().batch.id)).toMatchObject({ total: 2, skipped: 2, failed: 0 });

  // 预检也应当同步归零，避免工具栏数字和实际执行脱节。
  const replanned = await plan({ repositoryIds, modes: ['current', 'default', 'dev'] });
  expect(replanned.json().plan.eligible).toBe(0);
  await app.close();
});

it('预检清单把有提交可推的仓库排前面，已经是最新的垫后', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-push-order-'));
  temporaryDirectories.push(root);
  // 注册顺序是 idle 在前：排序必须看「有没有东西可推」，不能沿用范围顺序。
  await createRepository(root, 'idle', { withDev: false, pending: false });
  await createRepository(root, 'busy', { withDev: true });
  const { app, repositoryIds, plan } = await startApp(root, ['idle', 'busy']);

  const planned = await plan({ repositoryIds, modes: ['current', 'default'] });
  expect(planned.statusCode).toBe(200);
  const body = planned.json().plan;
  expect(body).toMatchObject({ total: 2, eligible: 1 });
  expect(body.repositories.map((item: { repositoryName: string }) => item.repositoryName)).toEqual(['busy', 'idle']);
  expect(body.repositories[0].targets).not.toHaveLength(0);
  expect(body.repositories[1].targets).toEqual([]);
  await app.close();
});

it('预览之后分支又长了提交：按快照拒推，不把新提交一起带上去', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-push-snapshot-'));
  temporaryDirectories.push(root);
  const remote = await createRepository(root, 'alpha', { withDev: true });
  const { app, ids, repositoryIds, plan, start, awaitBatch, operations } = await startApp(root, ['alpha']);

  const planned = await plan({ repositoryIds, modes: ['current', 'default', 'dev'] });
  const alpha = planned.json().plan.repositories[0];
  const devTarget = alpha.targets.find((branch: { name: string }) => branch.name === 'dev');
  expect(devTarget).toBeTruthy();

  const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  const remoteDevBefore = await git(remote, 'rev-parse', 'refs/heads/dev');

  // 模拟「窗口还开着，另一个终端往 dev 补了一笔提交」：快照里的 head 就此过期。
  const cwd = path.join(root, 'repos', 'alpha');
  await git(cwd, 'checkout', '-q', 'dev');
  await writeFile(path.join(cwd, 'late.txt'), 'late\n');
  await git(cwd, 'add', 'late.txt');
  await git(cwd, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'late work');

  const started = await start({
    type: 'push-branches',
    repositoryIds,
    targets: [{ repositoryId: ids.alpha, branches: [{ name: 'dev', head: devTarget.head }] }],
  });
  expect(started.statusCode).toBe(202);
  // 有分支被拒按失败计：批次抽屉的「需处理」要点得出来。
  expect(await awaitBatch(started.json().batch.id)).toMatchObject({ total: 1, success: 0, failed: 1 });

  // 远端一步没动。如果这里变成「推成功了但少一笔」，就说明快照被重新算过。
  expect(await git(remote, 'rev-parse', 'refs/heads/dev')).toBe(remoteDevBefore);
  const history = await operations();
  // 抽屉里只有这一句话，所以必须带上分支名和原因，不能只说「dev 推送失败」。
  expect(history[0].message).toContain('dev：分支在预览后已变化');
  await app.close();
});

it('快照里的仓库不在范围内时直接拒绝，不静默少推', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-push-scope-'));
  temporaryDirectories.push(root);
  await createRepository(root, 'alpha', { withDev: true });
  await createRepository(root, 'beta', { withDev: false });
  const { app, ids, repositoryIds, start } = await startApp(root);

  const started = await start({
    type: 'push-branches',
    repositoryIds,
    targets: [{ repositoryId: `${ids.alpha}-outsider`, branches: [{ name: 'main', head: '0'.repeat(40) }] }],
  });
  expect(started.statusCode).toBe(400);
  expect(started.json().error).toContain('范围外');
  await app.close();
});

it('档位参数非法时在预检阶段就被拒', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-batch-push-invalid-'));
  temporaryDirectories.push(root);
  await createRepository(root, 'alpha', { withDev: true });
  await createRepository(root, 'beta', { withDev: false });
  const { app, repositoryIds, plan, start } = await startApp(root);

  expect((await plan({ repositoryIds, modes: [] })).statusCode).toBe(400);
  expect((await plan({ repositoryIds, modes: ['current', 'current'] })).statusCode).toBe(400);
  expect((await plan({ repositoryIds, modes: ['unknown'] })).statusCode).toBe(400);
  expect((await start({ type: 'push-branches', repositoryIds, modes: ['current', 'current'] })).statusCode).toBe(400);
  // 批量不提供同步，边界仍要守住。
  expect((await start({ type: 'sync', repositoryIds })).statusCode).toBe(400);
  await app.close();
});
