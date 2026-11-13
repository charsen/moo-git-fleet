import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

const temporaryDirectories: string[] = [];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-push-branches-api-'));
  temporaryDirectories.push(root);
  const cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true });
  const remotePath = path.join(root, 'remote.git');
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await execute('git', ['init', '--bare', '-q', '--initial-branch=main', remotePath]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Push Branches Test');
  await git('config', 'user.email', 'push-branches@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await git('remote', 'add', 'origin', remotePath);
  await git('push', '-q', '-u', 'origin', 'main');
  await git('branch', 'dev');
  await git('push', '-q', '-u', 'origin', 'dev');
  // 两条分支各领先一笔未推送的提交。
  await writeFile(path.join(cwd, 'main.txt'), 'main\n');
  await git('add', 'main.txt');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'main work');
  await git('checkout', '-q', 'dev');
  await writeFile(path.join(cwd, 'dev.txt'), 'dev\n');
  await git('add', 'dev.txt');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'dev work');
  return { root, cwd, remotePath, git };
}

async function startApp(root: string) {
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8788');
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8788' };
  const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
  const headers = { ...host, 'x-git-fleet-token': token };
  const registeredRoot = await app.inject({
    method: 'POST',
    url: '/api/repository-roots',
    headers,
    payload: { path: path.join(root, 'repos') },
  });
  const registered = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    headers,
    payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Push Branches Demo', group: 'Tests', tags: [] },
  });
  expect(registered.statusCode).toBe(201);
  const id: string = registered.json().id;
  return {
    app,
    id,
    headers,
    plan: () => app.inject({ method: 'GET', url: `/api/repositories/${id}/push/branches`, headers }),
    push: (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/repositories/${id}/push/branches`, headers, payload }),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it('预检返回候选分支与预选，执行时一次推两条分支', async () => {
  const { root, remotePath, git } = await createFixture();
  const { id, app, plan, push } = await startApp(root);

  const planResponse = await plan();
  expect(planResponse.statusCode).toBe(200);
  const planBody = planResponse.json();
  expect(planBody.defaultBranch).toBe('main');
  expect(planBody.suggested).toEqual(['dev', 'main']);
  const devEntry = planBody.branches.find((branch: { name: string }) => branch.name === 'dev');
  const mainEntry = planBody.branches.find((branch: { name: string }) => branch.name === 'main');
  expect(devEntry.blocker).toBeNull();
  expect(mainEntry.blocker).toBeNull();

  const response = await push({
    branches: [
      { name: 'dev', head: devEntry.head },
      { name: 'main', head: mainEntry.head },
    ],
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.result.branches.map((branch: { state: string }) => branch.state)).toEqual(['pushed', 'pushed']);
  expect(body.operation.message).toBe('已推送 dev、main');
  expect(body.result.status.branch).toBe('dev');

  const remoteMain = await promisify(execFile)('git', ['-C', remotePath, 'rev-parse', 'refs/heads/main']);
  expect(remoteMain.stdout.trim()).toBe(await git('rev-parse', 'main'));
  await app.close();
  expect(id).toBeTruthy();
});

it('重复分支与超过上限的请求在参数校验阶段被拒', async () => {
  const { root } = await createFixture();
  const { app, push } = await startApp(root);
  const head = 'a'.repeat(40);

  expect((await push({ branches: [{ name: 'dev', head }, { name: 'dev', head }] })).statusCode).toBe(400);
  const tooMany = Array.from({ length: 11 }, (_, index) => ({ name: `b${index}`, head }));
  expect((await push({ branches: tooMany })).statusCode).toBe(400);
  // head 必须是完整对象 id，短 sha 一律拒绝。
  expect((await push({ branches: [{ name: 'dev', head: 'abc123' }] })).statusCode).toBe(400);
  await app.close();
});
