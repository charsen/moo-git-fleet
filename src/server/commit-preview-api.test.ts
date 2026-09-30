import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

it('protects preview and suggestion index reads with the same lock as Git writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-preview-lock-'));
  const cwd = path.join(root, 'repos', 'demo'); await mkdir(cwd, { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Preview Test'); await git('config', 'user.email', 'preview@example.test');
  await writeFile(path.join(cwd, 'demo.txt'), 'base\n'); await git('add', '.');
  await git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  await writeFile(path.join(cwd, 'demo.txt'), 'selected\n'); await git('add', '.');
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home'));
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787'); vi.resetModules();
  const files = await import('./git/files.js');
  const originalPreview = files.commitPreview;
  const { buildApp } = await import('./app.js'); const app = await buildApp();
  let release: (() => void) | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const host = { host: '127.0.0.1:8787' };
    const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json().token;
    const headers = { ...host, 'x-git-fleet-token': token };
    const post = async (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers, payload });
    const registeredRoot = await post('/api/repository-roots', { path: path.join(root, 'repos') });
    const registered = await post('/api/repositories', { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Preview Demo', group: 'Tests', tags: [] });
    expect(registered.statusCode).toBe(201); const id = registered.json().id;
    expect((await app.inject({ method: 'PATCH', url: `/api/repositories/${id}/config`, headers, payload: { aiCommitPolicy: 'disabled' } })).statusCode).toBe(200);
    const fileSnapshot = (await app.inject({ method: 'GET', url: `/api/repositories/${id}/files`, headers: host })).json();
    const fileIds = fileSnapshot.files.map((file: { id: string }) => file.id);
    const spy = vi.spyOn(files, 'commitPreview');
    for (const endpoint of ['preview', 'suggest']) {
      let started!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; release = resolve; });
      const snapshot = await originalPreview(cwd);
      spy.mockImplementationOnce(async repositoryPath => { started(); await gate; return originalPreview(repositoryPath); });
      const request = post(`/api/repositories/${id}/commit/${endpoint}`, endpoint === 'suggest' ? { fingerprint: snapshot.fingerprint } : {});
      pending = request.then(response => response);
      await ready;
      const before = await git('diff', '--cached');
      const conflicting = await post(`/api/repositories/${id}/unstage`, { fileIds });
      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json().error).toContain('Git 操作正在执行');
      expect(await git('diff', '--cached')).toBe(before);
      expect((await post(`/api/repositories/${id}/commit/preview`)).statusCode).toBe(409);
      resume(); const response = await request; pending = undefined;
      expect(response.statusCode).toBe(200);
    }
    expect((await post(`/api/repositories/${id}/unstage`, { fileIds })).statusCode).toBe(200);
    expect(await git('diff', '--cached')).toBe('');
    expect(await git('show', 'HEAD:demo.txt')).toBe('base');
    expect(await git('branch', '--show-current')).toBe('main');
  } finally {
    release?.(); await pending;
    vi.restoreAllMocks(); await app.close(); vi.unstubAllEnvs(); vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
