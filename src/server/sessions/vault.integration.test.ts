import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const privateRemoteConfirmation = '这是我控制的私有远端';
const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

async function request<T>(app: FastifyInstance, method: InjectOptions['method'], url: string, payload?: unknown, token?: string) {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...hostHeaders,
      ...(token ? { 'x-git-fleet-token': token } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { statusCode: response.statusCode, body: response.json<T>() };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session Vault API boundary', () => {
  it('exposes a guarded status/initialize flow and keeps confirmation server-side', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-api-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'fleet-home');
    const fleetPath = path.join(root, 'fleet-source');
    const vaultPath = path.join(root, 'private-vault');
    await mkdir(fleetPath, { recursive: true });
    await git(root, ['init', '--initial-branch=main', fleetPath]);
    await git(fleetPath, ['remote', 'add', 'origin', 'https://example.test/open-source/moo-git-fleet.git']);
    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetPath);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();

    try {
      const initial = await request<{ configured: boolean; privacyLabel: string }>(app, 'GET', '/api/session-vault');
      expect(initial).toMatchObject({ statusCode: 200, body: { configured: false, privacyLabel: '仅本机（未启用远端同步）' } });

      const session = await request<{ token: string }>(app, 'GET', '/api/session');
      const token = session.body.token;
      const unauthorized = await request<{ error: string }>(
        app,
        'POST',
        '/api/session-vault/initialize',
        { vaultPath, remoteUrl: 'https://example.test/private/session-vault.git', enableRemoteSync: true },
      );
      expect(unauthorized.statusCode).toBe(403);

      const missingConfirmation = await request<{ error: string }>(
        app,
        'POST',
        '/api/session-vault/initialize',
        { vaultPath, remoteUrl: 'https://example.test/private/session-vault.git', enableRemoteSync: true },
        token,
      );
      expect(missingConfirmation).toMatchObject({ statusCode: 409 });
      expect(missingConfirmation.body.error).toContain(privateRemoteConfirmation);
      await expect(access(path.join(vaultPath, '.git'))).rejects.toThrow();

      const initialized = await request<{
        configured: boolean;
        privacyLabel: string;
        binding: { remoteSyncEnabled: boolean; privacyState: string };
      }>(
        app,
        'POST',
        '/api/session-vault/initialize',
        {
          vaultPath,
          remoteUrl: 'https://example.test/private/session-vault.git',
          enableRemoteSync: true,
          confirmationPhrase: privateRemoteConfirmation,
        },
        token,
      );
      expect(initialized).toMatchObject({
        statusCode: 200,
        body: {
          configured: true,
          privacyLabel: '私有（用户确认，未经 Fleet 验证）',
          binding: { remoteSyncEnabled: true, privacyState: 'private-user-confirmed' },
        },
      });

      const current = await request<{ configured: boolean; binding: { remoteSyncEnabled: boolean } }>(
        app,
        'GET',
        '/api/session-vault',
      );
      expect(current).toMatchObject({ statusCode: 200, body: { configured: true, binding: { remoteSyncEnabled: true } } });
    } finally {
      await app.close();
    }
  });
});
