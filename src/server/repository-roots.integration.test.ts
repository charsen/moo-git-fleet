import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryRootMutationResult } from '../shared/contracts.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('repository root identity API', () => {
  it('returns the existing root identity when a symlink resolves to an already configured directory', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-root-identity-'));
    temporaryDirectories.push(fixture);
    const repositoriesRoot = path.join(fixture, 'Repositories-研发');
    const linkedRoot = path.join(fixture, 'Repositories-link');
    await mkdir(repositoriesRoot);
    await symlink(repositoriesRoot, linkedRoot);

    vi.stubEnv('GIT_FLEET_HOME', path.join(fixture, 'home'));
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    try {
      const session = await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:8787' } });
      const token = session.json<{ token: string }>().token;
      const requestHeaders = {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        'x-git-fleet-token': token,
      };
      const createdResponse = await app.inject({
        method: 'POST',
        url: '/api/repository-roots',
        headers: requestHeaders,
        payload: JSON.stringify({ path: repositoriesRoot }),
      });
      const created = createdResponse.json<RepositoryRootMutationResult>();
      const canonicalPath = await realpath(repositoriesRoot);
      expect(createdResponse.statusCode).toBe(200);
      expect(created).toMatchObject({ canonicalPath, created: true });
      expect(created.roots[created.rootId]).toBe(canonicalPath);

      const reusedResponse = await app.inject({
        method: 'POST',
        url: '/api/repository-roots',
        headers: requestHeaders,
        payload: JSON.stringify({ path: linkedRoot, id: 'wrong-client-guess' }),
      });
      expect(reusedResponse.statusCode).toBe(200);
      expect(reusedResponse.json<RepositoryRootMutationResult>()).toEqual({
        roots: created.roots,
        rootId: created.rootId,
        canonicalPath,
        created: false,
      });
    } finally {
      await app.close();
    }
  });
});
