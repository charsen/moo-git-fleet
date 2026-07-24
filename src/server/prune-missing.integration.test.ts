import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PruneMissingRepositoriesResult, RepositoryStatus } from '../shared/contracts.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

async function initRepository(root: string, name: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const repositoryPath = path.join(root, name);
  await git(root, ['init', '--initial-branch=master', repositoryPath]);
  await git(repositoryPath, ['config', 'user.name', 'Fleet Prune Test']);
  await git(repositoryPath, ['config', 'user.email', 'prune@example.test']);
  await writeFile(path.join(repositoryPath, 'README.md'), `${name}\n`);
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
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

describe('prune missing repositories API', () => {
  it('drops only the entries whose local directory is gone and keeps repositories that reappear', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-prune-missing-'));
    temporaryDirectories.push(fixture);
    const repositoriesRoot = path.join(fixture, 'Repositories');
    await initRepository(repositoriesRoot, 'alpha');
    await initRepository(repositoriesRoot, 'beta');

    vi.stubEnv('GIT_FLEET_HOME', path.join(fixture, 'home'));
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    try {
      const session = await jsonRequest<{ token: string }>(app, { method: 'GET', url: '/api/session' });
      const token = session.body.token;

      const roots = await jsonRequest<{ rootId: string }>(
        app,
        { method: 'POST', url: '/api/repository-roots', payload: { path: repositoriesRoot } },
        token,
      );
      const rootId = roots.body.rootId;

      const alpha = await jsonRequest<{ id: string }>(
        app,
        { method: 'POST', url: '/api/repositories', payload: { rootId, relativePath: 'alpha', name: 'Alpha' } },
        token,
      );
      const beta = await jsonRequest<{ id: string }>(
        app,
        { method: 'POST', url: '/api/repositories', payload: { rootId, relativePath: 'beta', name: 'Beta' } },
        token,
      );
      expect(alpha.statusCode).toBe(201);
      expect(beta.statusCode).toBe(201);

      // Remove Alpha from disk; Fleet must surface it as missing but still count it until cleaned.
      await rm(path.join(repositoriesRoot, 'alpha'), { recursive: true, force: true });

      const beforePrune = await jsonRequest<{ repositories: RepositoryStatus[] }>(
        app,
        { method: 'POST', url: '/api/repositories/refresh' },
        token,
      );
      const stateById = new Map(beforePrune.body.repositories.map((repository) => [repository.config.id, repository.state]));
      expect(stateById.get(alpha.body.id)).toBe('missing');
      expect(stateById.get(beta.body.id)).not.toBe('missing');

      // Beta still exists on disk, so a re-verification must skip it even when the client asks to prune it.
      const pruned = await jsonRequest<PruneMissingRepositoriesResult>(
        app,
        { method: 'POST', url: '/api/repositories/prune-missing', payload: { ids: [alpha.body.id, beta.body.id] } },
        token,
      );
      expect(pruned.statusCode).toBe(200);
      expect(pruned.body).toEqual({ removed: [alpha.body.id], skipped: [beta.body.id] });

      const afterPrune = await jsonRequest<{ repositories: RepositoryStatus[] }>(
        app,
        { method: 'POST', url: '/api/repositories/refresh' },
        token,
      );
      expect(afterPrune.body.repositories.map((repository) => repository.config.id)).toEqual([beta.body.id]);
    } finally {
      await app.close();
    }
  });
});
