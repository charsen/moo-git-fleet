import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

const execute = promisify(execFile);

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-stage-api-'));
  const cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true });
  const git = async (...args: string[]): Promise<string> => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Stage Test');
  await git('config', 'user.email', 'stage@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  return { root, cwd, git };
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
  const registeredRoot = await app.inject({
    method: 'POST', url: '/api/repository-roots', headers, payload: { path: path.join(root, 'repos') },
  });
  const registered = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    headers,
    payload: {
      rootId: registeredRoot.json().rootId,
      relativePath: 'demo',
      name: 'Stage Demo',
      group: 'Tests',
      tags: [],
    },
  });
  expect(registered.statusCode).toBe(201);
  const id: string = registered.json().id;
  const listFiles = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/files`, headers: host })).json();
    return payload.files as Array<{ id: string; path: string; staged: boolean; conflicted: boolean }>;
  };
  return { app, id, headers, host, listFiles };
}

it('暂存前复核文件快照：内容在拿到 token 之后变了就 409', async () => {
  const { root, cwd } = await createFixture();
  const { app, id, headers, listFiles } = await startApp(root);
  try {
    await writeFile(path.join(cwd, 'note.md'), '第一版\n');
    const before = (await listFiles()).find((file) => file.path === 'note.md')!;
    expect(before).toBeTruthy();

    // 用户拿到 token 之后，编辑器又保存了一次（或另一个终端 checkout 过）。
    await writeFile(path.join(cwd, 'note.md'), '第二版，用户没在 diff 里看过\n');

    const stale = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/stage`, headers, payload: { fileIds: [before.id] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain('已变化');

    // 索引里不能有半份内容。
    const after = (await listFiles()).find((file) => file.path === 'note.md')!;
    expect(after.staged).toBe(false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('冲突文件不允许用「暂存」当成「已解决」', async () => {
  const { root, cwd, git } = await createFixture();
  const { app, id, headers, listFiles } = await startApp(root);
  try {
    await git('checkout', '-q', '-b', 'side');
    await writeFile(path.join(cwd, 'README.md'), 'side\n');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qam', 'side');
    await git('checkout', '-q', 'main');
    await writeFile(path.join(cwd, 'README.md'), 'main\n');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qam', 'main');
    await execute('git', ['-C', cwd, 'merge', 'side']).catch(() => undefined);

    const conflicted = (await listFiles()).find((file) => file.path === 'README.md')!;
    expect(conflicted.conflicted).toBe(true);

    const staged = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/stage`, headers, payload: { fileIds: [conflicted.id] },
    });
    expect(staged.statusCode).toBe(409);
    expect(staged.json().error).toContain('先解决冲突');

    // 仍然是未合并状态，没有被 `git add` 悄悄标成已解决。
    expect((await listFiles()).find((file) => file.path === 'README.md')!.conflicted).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
