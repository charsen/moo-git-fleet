import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-ignore-api-'));
  const cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Ignore Test');
  await git('config', 'user.email', 'ignore@example.test');
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
  const registeredRoot = await app.inject({ method: 'POST', url: '/api/repository-roots', headers, payload: { path: path.join(root, 'repos') } });
  const registered = await app.inject({
    method: 'POST', url: '/api/repositories', headers,
    payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Ignore Demo', group: 'Tests', tags: [] },
  });
  expect(registered.statusCode).toBe(201);
  const id: string = registered.json().id;
  const listFiles = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/files`, headers: host })).json();
    return payload.files as Array<{ id: string; path: string }>;
  };
  return { app, id, headers, host, listFiles };
}

it('writes ignore and exclude rules and reflects them in the file listings', async () => {
  const { root, cwd, git } = await createFixture();
  const { app, id, headers, host, listFiles } = await startApp(root);
  try {
    await writeFile(path.join(cwd, 'draft.log'), 'noise\n');
    const draft = (await listFiles()).find((file) => file.path === 'draft.log')!;
    expect(draft).toBeTruthy();

    // 写接口必须带 session token。
    const anonymous = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers: host,
      payload: { fileId: draft.id, target: 'gitignore', scope: 'path' },
    });
    expect(anonymous.statusCode).toBe(403);

    const ignored = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: draft.id, target: 'gitignore', scope: 'path' },
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json().result).toEqual({ target: 'gitignore', pattern: '/draft.log', created: true });
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('/draft.log\n');
    expect(ignored.json().files.map((file: { path: string }) => file.path)).not.toContain('draft.log');

    // 规则已存在时不重复追加：已跟踪文件不受忽略影响，仍会出现在清单里。
    await writeFile(path.join(cwd, 'keep.txt'), 'v1\n');
    await git('add', 'keep.txt');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'track keep');
    await writeFile(path.join(cwd, '.gitignore'), '/draft.log\nkeep.txt\n');
    await git('add', '.gitignore');
    await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'ignore keep');
    await writeFile(path.join(cwd, 'keep.txt'), 'v2\n');
    const keep = (await listFiles()).find((file) => file.path === 'keep.txt')!;
    const deduped = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: keep.id, target: 'gitignore', scope: 'name' },
    });
    expect(deduped.statusCode).toBe(200);
    expect(deduped.json().result).toEqual({ target: 'gitignore', pattern: 'keep.txt', created: false });
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('/draft.log\nkeep.txt\n');

    // 本地排除写 .git/info/exclude，不动 .gitignore。
    await writeFile(path.join(cwd, 'local-only.txt'), 'x\n');
    const localEntry = (await listFiles()).find((file) => file.path === 'local-only.txt')!;
    const excluded = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: localEntry.id, target: 'exclude', scope: 'name' },
    });
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json().result).toEqual({ target: 'exclude', pattern: 'local-only.txt', created: true });
    expect(await readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('local-only.txt');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('/draft.log\nkeep.txt\n');

    const listing = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/ignored`, headers: host })).json();
    expect(listing.truncated).toBe(false);
    expect(listing.ignored.map((entry: { path: string }) => entry.path).sort()).toEqual(['draft.log', 'local-only.txt']);
    expect(await git('check-ignore', 'draft.log')).toBe('draft.log');
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('rejects invalid requests, stale file ids and disabled capabilities', async () => {
  const { root, cwd } = await createFixture();
  const { app, id, headers, host, listFiles } = await startApp(root);
  try {
    await writeFile(path.join(cwd, 'draft.log'), 'noise\n');
    const draft = (await listFiles()).find((file) => file.path === 'draft.log')!;

    const missingPattern = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: draft.id, target: 'gitignore', scope: 'custom' },
    });
    expect(missingPattern.statusCode).toBe(400);

    const invalidPattern = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: draft.id, target: 'gitignore', scope: 'custom', pattern: 'a\nb' },
    });
    expect(invalidPattern.statusCode).toBe(400);

    const staleId = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: '00000000-0000-4000-8000-000000000000', target: 'gitignore', scope: 'path' },
    });
    expect(staleId.statusCode).toBe(409);

    // reveal / editor 必须带 fileId。
    expect((await app.inject({
      method: 'POST', url: `/api/repositories/${id}/open`, headers, payload: { target: 'reveal' },
    })).statusCode).toBe(400);

    const disabled = await app.inject({
      method: 'PATCH', url: `/api/repositories/${id}/config`, headers, payload: { capabilities: { stage: false } },
    });
    expect(disabled.statusCode).toBe(200);
    const blocked = await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore`, headers,
      payload: { fileId: draft.id, target: 'gitignore', scope: 'path' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain('禁止文件修改');
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
