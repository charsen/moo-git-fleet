import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-ignore-rules-api-'));
  const cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Ignore Rules Test');
  await git('config', 'user.email', 'rules@example.test');
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git('add', 'README.md');
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
    payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Ignore Rules Demo', group: 'Tests', tags: [] },
  });
  expect(registered.statusCode).toBe(201);
  const id: string = registered.json().id;
  const post = (suffix: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/repositories/${id}/ignore-rules/${suffix}`, headers, payload });
  const listFiles = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/files`, headers: host })).json();
    return payload.files as Array<{ id: string; path: string }>;
  };
  const listIgnored = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/ignored`, headers: host })).json();
    return payload.ignored as Array<{ id: string; path: string }>;
  };
  const listRules = async () => {
    const payload = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/ignore-rules`, headers: host })).json();
    return payload.files as Array<{ target: string; displayPath: string; exists: boolean; lines: Array<{ line: number; text: string; kind: string }> }>;
  };
  return { app, id, headers, host, post, listFiles, listIgnored, listRules };
}

async function cleanup(app: { close: () => Promise<void> }, root: string): Promise<void> {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
}

it('lists rules with their real line numbers and guards removal', async () => {
  const { root, cwd } = await createFixture();
  const { app, id, headers, host, post, listRules } = await startApp(root);
  try {
    await writeFile(path.join(cwd, '.gitignore'), '# 注释\ndraft.log\nlocal.txt\n');
    await writeFile(path.join(cwd, 'draft.log'), 'x\n');
    await writeFile(path.join(cwd, 'local.txt'), 'x\n');

    const files = await listRules();
    expect(files.map((file) => file.target)).toEqual(['gitignore', 'exclude']);
    expect(files[0]?.displayPath).toBe('.gitignore');
    expect(files[0]?.lines).toEqual([
      { line: 1, text: '# 注释', kind: 'comment' },
      { line: 2, text: 'draft.log', kind: 'rule' },
      { line: 3, text: 'local.txt', kind: 'rule' },
    ]);

    // 写接口必须带 session token。
    expect((await app.inject({
      method: 'POST', url: `/api/repositories/${id}/ignore-rules/remove`, headers: host,
      payload: { target: 'gitignore', line: 2, pattern: 'draft.log' },
    })).statusCode).toBe(403);

    // 行号与内容不匹配 → 409；注释行 → 400。
    expect((await post('remove', { target: 'gitignore', line: 2, pattern: 'wrong' })).statusCode).toBe(409);
    expect((await post('remove', { target: 'gitignore', line: 9, pattern: 'draft.log' })).statusCode).toBe(409);
    expect((await post('remove', { target: 'gitignore', line: 1, pattern: '# 注释' })).statusCode).toBe(400);
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('# 注释\ndraft.log\nlocal.txt\n');

    const removed = await post('remove', { target: 'gitignore', line: 2, pattern: 'draft.log' });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().result).toEqual({ target: 'gitignore', line: 2, pattern: 'draft.log', displayPath: '.gitignore' });
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('# 注释\nlocal.txt\n');
    // 取消忽略后文件重新回到工作区清单。
    expect(removed.json().files.map((file: { path: string }) => file.path)).toContain('draft.log');
    expect((await listRules())[0]?.lines.map((line) => line.text)).toEqual(['# 注释', 'local.txt']);

    const disabled = await app.inject({
      method: 'PATCH', url: `/api/repositories/${id}/config`, headers, payload: { capabilities: { stage: false } },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await post('remove', { target: 'gitignore', line: 2, pattern: 'local.txt' })).statusCode).toBe(409);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);

it('unignores from the ignored listing and leaves other sources alone', async () => {
  const { root, cwd } = await createFixture();
  const { app, post, listFiles, listIgnored } = await startApp(root);
  try {
    await writeFile(path.join(cwd, '.gitignore'), 'draft.log\n');
    await writeFile(path.join(cwd, 'draft.log'), 'x\n');
    await mkdir(path.join(cwd, 'sub'));
    await writeFile(path.join(cwd, 'sub', '.gitignore'), 'inner.txt\n');
    await writeFile(path.join(cwd, 'sub', 'inner.txt'), 'x\n');

    const ignored = await listIgnored();
    const draft = ignored.find((entry) => entry.path === 'draft.log')!;
    const inner = ignored.find((entry) => entry.path === 'sub/inner.txt')!;
    expect(draft).toBeTruthy();
    expect(inner).toBeTruthy();

    const removed = await post('unignore', { fileId: draft.id });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().result.removed).toBe(true);
    expect(removed.json().result.source).toBe('.gitignore');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('');
    expect(removed.json().files.map((file: { path: string }) => file.path)).toContain('draft.log');
    expect(await listFiles()).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'draft.log' })]));

    // 嵌套 .gitignore 不是本轮支持的两个文件：只提示来源，不动任何文件。
    const nested = await post('unignore', { fileId: inner.id });
    expect(nested.statusCode).toBe(200);
    expect(nested.json().result).toMatchObject({ removed: false, source: 'sub/.gitignore' });
    expect(nested.json().message).toContain('sub/.gitignore');
    expect(await readFile(path.join(cwd, 'sub', '.gitignore'), 'utf8')).toBe('inner.txt\n');
    expect((await listIgnored()).map((entry) => entry.path)).toContain('sub/inner.txt');

    expect((await post('unignore', { fileId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(409);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);

it('opens the ignore files through the server-resolved path', async () => {
  const { root, cwd } = await createFixture();
  const resolvedCwd = await realpath(cwd);
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  vi.resetModules();
  // 绝不能真的把编辑器拉起来：只断言服务端解析出的目标路径。
  const open = await import('./system/open.js');
  const spy = vi.spyOn(open, 'openRepositoryLocation').mockResolvedValue(undefined);
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const host = { host: '127.0.0.1:8787' };
  try {
    const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
    const headers = { ...host, 'x-git-fleet-token': token };
    const registeredRoot = await app.inject({ method: 'POST', url: '/api/repository-roots', headers, payload: { path: path.join(root, 'repos') } });
    const registered = await app.inject({
      method: 'POST', url: '/api/repositories', headers,
      payload: { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Ignore Rules Demo', group: 'Tests', tags: [] },
    });
    const id: string = registered.json().id;
    const openFile = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/repositories/${id}/open`, headers, payload });

    expect((await openFile({ target: 'editor', ignoreFile: 'gitignore' })).statusCode).toBe(200);
    expect(spy).toHaveBeenLastCalledWith('editor', resolvedCwd, path.join(resolvedCwd, '.gitignore'));
    expect((await openFile({ target: 'editor', ignoreFile: 'exclude' })).statusCode).toBe(200);
    expect(spy).toHaveBeenLastCalledWith('editor', resolvedCwd, path.join(resolvedCwd, '.git', 'info', 'exclude'));

    // fileId 与 ignoreFile 互斥；reveal / editor 必须二选一。
    expect((await openFile({ target: 'editor', fileId: '00000000-0000-4000-8000-000000000000', ignoreFile: 'gitignore' })).statusCode).toBe(400);
    expect((await openFile({ target: 'reveal' })).statusCode).toBe(400);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    await cleanup(app, root);
  }
}, 30_000);
