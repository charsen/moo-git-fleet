import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-assume-api-'));
  const cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Assume Test');
  await git('config', 'user.email', 'assume@example.test');
  await writeFile(path.join(cwd, 'notes.txt'), 'v1\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  return { root, cwd };
}

async function startApp(root: string) {
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  vi.resetModules();
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8787' };
  const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
  const headers = { ...host, 'x-git-fleet-token': token };
  const registeredRoot = await app.inject({ method: 'POST', url: '/api/repository-roots', headers, payload: { path: path.join(root, 'repos') } });
  const registered = await app.inject({
    method: 'POST', url: '/api/repositories', headers,
    payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Assume Demo', group: 'Tests', tags: [] },
  });
  expect(registered.statusCode).toBe(201);
  const id: string = registered.json().id;
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/repositories/${id}/assume-unchanged`, headers, payload });
  const listFiles = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/files`, headers: host })).json();
    return payload.files as Array<{ id: string; path: string }>;
  };
  const listMarked = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/assume-unchanged`, headers: host })).json();
    return payload.files as Array<{ id: string; path: string }>;
  };
  return { app, id, headers, host, post, listFiles, listMarked };
}

async function cleanup(app: { close: () => Promise<void> }, root: string): Promise<void> {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
}

it('marks and unmarks a tracked file through the API', async () => {
  const { root, cwd } = await createFixture();
  const { app, id, headers, host, post, listFiles, listMarked } = await startApp(root);
  try {
    await writeFile(path.join(cwd, 'notes.txt'), 'v2\n');
    const notes = (await listFiles()).find((file) => file.path === 'notes.txt')!;
    expect(notes).toBeTruthy();
    expect(await listMarked()).toEqual([]);

    // 写接口必须带 session token。
    expect((await app.inject({
      method: 'POST', url: `/api/repositories/${id}/assume-unchanged`, headers: host,
      payload: { fileId: notes.id, assumed: true },
    })).statusCode).toBe(403);

    const marked = await post({ fileId: notes.id, assumed: true });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().result).toEqual({ path: 'notes.txt', assumed: true });
    // 标记后本地修改不再出现在工作区清单，改由已标记清单承载。
    expect(marked.json().files).toEqual([]);
    expect(marked.json().marked).toEqual([{ id: expect.any(String), path: 'notes.txt' }]);
    expect(await listFiles()).toEqual([]);
    expect((await listMarked()).map((file) => file.path)).toEqual(['notes.txt']);

    const unmarked = await post({ fileId: (await listMarked())[0]!.id, assumed: false });
    expect(unmarked.statusCode).toBe(200);
    expect(unmarked.json().result).toEqual({ path: 'notes.txt', assumed: false });
    expect(unmarked.json().marked).toEqual([]);
    expect((await listFiles()).map((file) => file.path)).toEqual(['notes.txt']);
    expect(await listMarked()).toEqual([]);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);

it('rejects untracked files, stale ids and disabled capabilities', async () => {
  const { root, cwd } = await createFixture();
  const { app, id, headers, post, listFiles } = await startApp(root);
  try {
    await writeFile(path.join(cwd, 'draft.txt'), 'x\n');
    const draft = (await listFiles()).find((file) => file.path === 'draft.txt')!;
    const untracked = await post({ fileId: draft.id, assumed: true });
    expect(untracked.statusCode).toBe(409);
    expect(untracked.json().error).toContain('不在版本控制里');

    expect((await post({ fileId: '00000000-0000-4000-8000-000000000000', assumed: true })).statusCode).toBe(409);

    const disabled = await app.inject({
      method: 'PATCH', url: `/api/repositories/${id}/config`, headers, payload: { capabilities: { stage: false } },
    });
    expect(disabled.statusCode).toBe(200);
    const notes = (await listFiles()).find((file) => file.path === 'draft.txt')!;
    expect((await post({ fileId: notes.id, assumed: true })).statusCode).toBe(409);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);
