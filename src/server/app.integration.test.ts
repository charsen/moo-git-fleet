import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

async function jsonRequest<T>(
  app: FastifyInstance,
  options: Omit<InjectOptions, 'headers' | 'payload'> & { payload?: unknown },
  token?: string,
): Promise<{ statusCode: number; body: T }> {
  const response = await app.inject({
    ...options,
    headers: {
      ...hostHeaders,
      ...(token ? { 'x-git-fleet-token': token } : {}),
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: options.payload === undefined ? undefined : JSON.stringify(options.payload),
  });
  return { statusCode: response.statusCode, body: response.json<T>() };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Git Fleet API workflow', () => {
  it('adds a local repository and completes the staged Commit flow with an audited operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-api-flow-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const repositoriesRoot = path.join(root, 'repositories');
    const repositoryPath = path.join(repositoriesRoot, 'demo');
    await git(root, ['init', '--initial-branch=master', repositoryPath]);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet API Test']);
    await git(repositoryPath, ['config', 'user.email', 'api@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    try {
      const unauthorized = await jsonRequest<{ error: string }>(app, {
        method: 'POST',
        url: '/api/repository-roots',
        payload: { id: 'test', path: repositoriesRoot },
      });
      expect(unauthorized).toMatchObject({ statusCode: 403, body: { error: '本地会话已失效，请刷新页面' } });

      const session = await jsonRequest<{ token: string }>(app, { method: 'GET', url: '/api/session' });
      expect(session.statusCode).toBe(200);
      const token = session.body.token;

      const roots = await jsonRequest<Record<string, string>>(
        app,
        { method: 'POST', url: '/api/repository-roots', payload: { id: 'test', path: repositoriesRoot } },
        token,
      );
      expect(roots.statusCode).toBe(200);
      expect(roots.body.test).toBe(await realpath(repositoriesRoot));

      const added = await jsonRequest<{ id: string; name: string }>(
        app,
        {
          method: 'POST',
          url: '/api/repositories',
          payload: { rootId: 'test', relativePath: 'demo', name: 'Demo API', group: 'Tests', tags: ['api'] },
        },
        token,
      );
      expect(added).toMatchObject({ statusCode: 201, body: { name: 'Demo API' } });
      const repositoryId = added.body.id;

      await writeFile(path.join(repositoryPath, 'README.md'), 'updated through API\n');
      await writeFile(path.join(repositoryPath, 'notes.md'), 'new through API\n');
      const files = await jsonRequest<{ files: Array<{ id: string; path: string; staged: boolean }> }>(app, {
        method: 'GET',
        url: `/api/repositories/${repositoryId}/files`,
      });
      expect(files.statusCode).toBe(200);
      expect(files.body.files.map((file) => file.path)).toHaveLength(2);
      expect(files.body.files.map((file) => file.path)).toEqual(expect.arrayContaining(['README.md', 'notes.md']));

      const staged = await jsonRequest<{ files: Array<{ path: string; staged: boolean }> }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/stage`,
          payload: { fileIds: files.body.files.map((file) => file.id) },
        },
        token,
      );
      expect(staged.statusCode).toBe(200);
      expect(staged.body.files.every((file) => file.staged)).toBe(true);

      const preview = await jsonRequest<{ fingerprint: string; files: string[]; truncated: boolean }>(
        app,
        { method: 'POST', url: `/api/repositories/${repositoryId}/commit/preview`, payload: {} },
        token,
      );
      expect(preview).toMatchObject({
        statusCode: 200,
        body: { files: ['README.md', 'notes.md'], truncated: false },
      });
      expect(preview.body.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const suggestion = await jsonRequest<{ source: string; message: string; fingerprint: string }>(
        app,
        { method: 'POST', url: `/api/repositories/${repositoryId}/commit/suggest`, payload: {} },
        token,
      );
      expect(suggestion).toMatchObject({
        statusCode: 200,
        body: { source: 'local', fingerprint: preview.body.fingerprint },
      });

      const staleCommit = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit`,
          payload: {
            message: suggestion.body.message,
            fingerprint: '0'.repeat(64),
            pushAfterCommit: false,
          },
        },
        token,
      );
      expect(staleCommit).toMatchObject({ statusCode: 409 });
      expect(staleCommit.body.error).toContain('暂存区已变化');
      expect(await git(repositoryPath, ['rev-list', '--count', 'HEAD'])).toBe('1');

      const committed = await jsonRequest<{
        operation: { type: string; state: string };
        result: { hash: string; treeMatches: boolean };
        pushOperation: null;
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit`,
          payload: {
            message: suggestion.body.message,
            fingerprint: preview.body.fingerprint,
            pushAfterCommit: false,
          },
        },
        token,
      );
      expect(committed).toMatchObject({
        statusCode: 200,
        body: {
          operation: { type: 'commit', state: 'success' },
          result: { treeMatches: true },
          pushOperation: null,
        },
      });
      expect(committed.body.result.hash).toMatch(/^[a-f0-9]{40}$/);
      expect(await git(repositoryPath, ['status', '--porcelain'])).toBe('');
      expect(await git(repositoryPath, ['show', '-1', '--no-patch', '--format=%s'])).toBe(suggestion.body.message.split('\n')[0]);

      const dashboard = await jsonRequest<{
        repositories: Array<{ config: { id: string }; state: string; staged: number; modified: number }>;
        scan: { startedAt: string; completedAt: string; durationMs: number };
      }>(app, { method: 'GET', url: '/api/dashboard' });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.body.scan.durationMs).toBeGreaterThanOrEqual(0);
      expect(new Date(dashboard.body.scan.completedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(dashboard.body.scan.startedAt).getTime(),
      );
      expect(dashboard.body.repositories).toContainEqual(
        expect.objectContaining({ config: expect.objectContaining({ id: repositoryId }), staged: 0, modified: 0 }),
      );

      const restricted = await jsonRequest<{ capabilities: { fetch: boolean } }>(
        app,
        {
          method: 'PATCH',
          url: `/api/repositories/${repositoryId}/config`,
          payload: { capabilities: { fetch: false } },
        },
        token,
      );
      expect(restricted).toMatchObject({ statusCode: 200, body: { capabilities: { fetch: false } } });

      const invalidBatch = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/batches', payload: { type: 'fetch', repositoryIds: ['missing-repository'] } },
        token,
      );
      expect(invalidBatch).toMatchObject({ statusCode: 400 });
      expect(invalidBatch.body.error).toContain('未知或已禁用');

      const duplicateBatch = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/batches', payload: { type: 'fetch', repositoryIds: [repositoryId, repositoryId] } },
        token,
      );
      expect(duplicateBatch).toMatchObject({ statusCode: 400 });
      expect(duplicateBatch.body.error).toContain('重复项');

      const selectedBatch = await jsonRequest<{ batch: { id: string; total: number } }>(
        app,
        { method: 'POST', url: '/api/batches', payload: { type: 'fetch', repositoryIds: [repositoryId] } },
        token,
      );
      expect(selectedBatch).toMatchObject({ statusCode: 202, body: { batch: { total: 1 } } });
      let selectedBatchState = '';
      for (let attempt = 0; attempt < 50 && selectedBatchState !== 'completed'; attempt += 1) {
        const current = await jsonRequest<{ batches: Array<{ id: string; state: string; skipped: number }> }>(
          app,
          { method: 'GET', url: '/api/operations' },
        );
        const batch = current.body.batches.find((item) => item.id === selectedBatch.body.batch.id);
        selectedBatchState = batch?.state ?? '';
        if (selectedBatchState !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
        else expect(batch?.skipped).toBe(1);
      }
      expect(selectedBatchState).toBe('completed');

      const operations = await jsonRequest<{ operations: Array<{ repositoryId: string; type: string; state: string }> }>(
        app,
        { method: 'GET', url: '/api/operations' },
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'commit', state: 'success' }),
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'commit', state: 'failed' }),
      );
      const operationLogFiles = await readdir(path.join(home, '.data', 'operations'));
      const operationLog = await readFile(path.join(home, '.data', 'operations', operationLogFiles[0] ?? ''), 'utf8');
      expect(operationLog).toContain('"type":"commit"');
      expect(await readFile(path.join(home, 'config', 'repositories.yaml'), 'utf8')).toContain('name: Demo API');
    } finally {
      await app.close();
    }
  });
});
