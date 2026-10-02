import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { ConflictPreview, FileChange } from '../shared/contracts.js';

it('binds the selected conflict version to its index and operation snapshot through the API', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-conflict-api-')), cwd = path.join(root, 'repos', 'demo');
  await mkdir(cwd, { recursive: true }); const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
  await git('init', '-qb', 'main'); await git('config', 'user.name', 'Conflict Test'); await git('config', 'user.email', 'conflict@example.test');
  const commit = async (content: string, message: string) => { await writeFile(path.join(cwd, 'app.txt'), content); await git('add', '.'); await git('-c', 'commit.gpgSign=false', 'commit', '-qm', message); };
  await commit('base\n', 'base'); await git('switch', '-qc', 'side'); await commit('incoming\n', 'side'); await git('switch', '-q', 'main'); await commit('current\n', 'main'); await git('merge', 'side').catch(() => undefined);
  vi.stubEnv('GIT_FLEET_HOME', path.join(root, 'home')); vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude')); vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex')); vi.stubEnv('GIT_FLEET_PORT', '8787'); vi.resetModules();
  const { buildApp } = await import('./app.js'); const app = await buildApp();
  try {
    const host = { host: '127.0.0.1:8787' }, get = (url: string) => app.inject({ method: 'GET', url, headers: host });
    const token = (await get('/api/session')).json().token, headers = { ...host, 'x-git-fleet-token': token };
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload });
    const registeredRoot = await post('/api/repository-roots', { path: path.join(root, 'repos') });
    const registered = await post('/api/repositories', { rootId: registeredRoot.json().rootId, relativePath: 'demo', name: 'Conflict Demo', group: 'Tests', tags: [] }); expect(registered.statusCode).toBe(201);
    const id = registered.json().id, readFiles = async () => (await get(`/api/repositories/${id}/files`)).json<{ files: FileChange[] }>().files;
    const file = (await readFiles()).find(file => file.conflicted)!; expect(file).toBeDefined();
    const before = await readFile(path.join(cwd, 'app.txt'), 'utf8'); const index = await git('ls-files', '--stage');
    const response = await get(`/api/repositories/${id}/conflicts/preview?fileId=${file.id}`); expect(response.statusCode).toBe(200);
    const preview = response.json<ConflictPreview>(); expect(preview.sides.map(side => side.file?.content)).toEqual(['base\n', 'current\n', 'incoming\n']);
    expect(await git('ls-files', '--stage')).toBe(index); expect(await readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe(before);
    const url = `/api/repositories/${id}/conflicts/resolve`, payload = { fileId: file.id, strategy: 'theirs', expectedConflictFingerprint: preview.fingerprint };
    expect((await app.inject({ method: 'POST', url, headers: host, payload })).statusCode).toBe(403);
    expect((await post(url, { ...payload, expectedConflictFingerprint: 'bad' })).statusCode).toBe(400);
    // Change only the merge target: the file token stays current, but the preview must expire.
    await writeFile(path.join(cwd, '.git', 'MERGE_HEAD'), await git('rev-parse', 'HEAD') + '\n');
    const blocked = await post(url, { ...payload, fileId: (await readFiles()).find(file => file.conflicted)!.id });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error).toContain('已变化'); expect(await readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe(before);
    const freshFile = (await readFiles()).find(file => file.conflicted)!;
    const fresh = (await get(`/api/repositories/${id}/conflicts/preview?fileId=${freshFile.id}`)).json<ConflictPreview>();
    const resolved = await post(url, { fileId: freshFile.id, strategy: 'theirs', expectedConflictFingerprint: fresh.fingerprint }); expect(resolved.statusCode).toBe(200);
    expect(await readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('incoming\n'); expect((await readFiles()).some(file => file.conflicted)).toBe(false);
    expect((await get(`/api/repositories/${id}/conflicts/preview?fileId=${freshFile.id}`)).statusCode).toBe(409);
    expect((await get(`/api/repositories/missing/conflicts/preview?fileId=${freshFile.id}`)).statusCode).toBe(404);
  } finally { await app.close(); vi.unstubAllEnvs(); vi.resetModules(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
