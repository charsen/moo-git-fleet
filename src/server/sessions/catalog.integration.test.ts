import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionDetail,
  SessionLifecycleMutationResult,
  SessionListPayload,
  SessionVaultSyncStatus,
} from '../../shared/sessions.js';
import type { RecoveryPlan } from '../../shared/recovery.js';
import { captureCheckpoint } from './checkpoint.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

async function request<T>(
  app: FastifyInstance,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  token?: string,
): Promise<{ statusCode: number; body: T }> {
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

describe('Session Vault list and synchronization API', () => {
  it('guards writes, validates pagination, and exposes a committed checkpoint through list/detail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-catalog-api-'));
    temporaryDirectories.push(root);
    const fleetHome = path.join(root, 'fleet-home');
    const fleetSource = path.join(root, 'fleet-source');
    const vaultPath = path.join(root, 'private-vault');
    const remotePath = path.join(root, 'private-vault-remote.git');
    await mkdir(fleetSource, { recursive: true });
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    await git(root, ['init', '--bare', remotePath]);
    vi.stubEnv('GIT_FLEET_HOME', fleetHome);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetSource);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();

    try {
      const token = (await request<{ token: string }>(app, 'GET', '/api/session')).body.token;
      const initialized = await request<{ configured: boolean }>(
        app,
        'POST',
        '/api/session-vault/initialize',
        {
          vaultPath,
          remoteUrl: remotePath,
          enableRemoteSync: true,
          confirmationPhrase: '这是我控制的私有远端',
        },
        token,
      );
      expect(initialized).toMatchObject({ statusCode: 200, body: { configured: true } });

      const captured = await captureCheckpoint({
        vaultPath,
        sessionId: 'fleet:synthetic-api-catalog',
        session: {
          provider: 'codex',
          providerSessionId: '88888888-8888-4888-8888-888888888888',
          projectId: 'remote:synthetic-api-project',
          repositoryId: 'synthetic-api-project',
          repositoryName: 'Synthetic API Project',
          title: 'Synthetic API catalog handoff',
        },
        summary: {
          goal: 'Continue the synthetic API catalog',
          completed: ['Captured one synthetic checkpoint'],
          decisions: [],
          nextSteps: ['Push the synthetic Vault'],
          blockers: [],
          commands: [],
          risks: [],
          source: 'manual',
          reviewedAt: '2026-07-28T08:00:00.000Z',
        },
        workspace: {
          projectId: 'remote:synthetic-api-project',
          repositoryId: 'synthetic-api-project',
          branch: 'feature/api-catalog',
          head: '8'.repeat(40),
          dirty: false,
          changedFiles: 0,
          stagedFiles: 0,
          modifiedFiles: 0,
          deletedFiles: 0,
          renamedFiles: 0,
          untrackedFiles: 0,
        },
        machine: 'synthetic-api-machine',
        capabilities: {
          nativeResume: false,
          universalHandoff: true,
          codeReachable: true,
          wipRef: null,
          sourceSync: null,
        },
        now: new Date('2026-07-28T08:00:00.000Z'),
      });

      const list = await request<SessionListPayload>(app, 'GET', '/api/sessions?page=1&pageSize=50');
      expect(list).toMatchObject({
        statusCode: 200,
        body: {
          total: 1,
          items: [{ sessionId: 'fleet:synthetic-api-catalog', provider: 'codex' }],
          sync: { state: 'local-ahead', pendingLocal: true },
        },
      });
      const invalidPage = await request<{ error: string }>(app, 'GET', '/api/sessions?pageSize=51');
      expect(invalidPage.statusCode).toBe(400);
      const detail = await request<SessionDetail>(
        app,
        'GET',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}`,
      );
      expect(detail).toMatchObject({
        statusCode: 200,
        body: {
          latestHandoffMarkdown: expect.stringContaining('Continue the synthetic API catalog'),
          latestWorkspace: { branch: 'feature/api-catalog' },
        },
      });

      const unauthorizedLifecycle = await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/lifecycle`,
        { action: 'pin', expectedLifecycleVersion: null },
      );
      expect(unauthorizedLifecycle.statusCode).toBe(403);
      const pinned = await request<SessionLifecycleMutationResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/lifecycle`,
        { action: 'pin', expectedLifecycleVersion: null },
        token,
      );
      expect(pinned).toMatchObject({ statusCode: 200, body: { event: { action: 'pin' } } });
      const staleLifecycle = await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/lifecycle`,
        { action: 'archive', expectedLifecycleVersion: null },
        token,
      );
      expect(staleLifecycle).toMatchObject({ statusCode: 409, body: { error: expect.stringContaining('刷新列表') } });
      const archived = await request<SessionLifecycleMutationResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/lifecycle`,
        { action: 'archive', expectedLifecycleVersion: pinned.body.event.eventId },
        token,
      );
      expect(archived).toMatchObject({ statusCode: 200, body: { event: { action: 'archive' } } });
      expect(await request<SessionListPayload>(app, 'GET', '/api/sessions')).toMatchObject({
        statusCode: 200,
        body: { total: 0, counts: { active: 0, archived: 1, all: 1 } },
      });
      expect(await request<SessionListPayload>(app, 'GET', '/api/sessions?lifecycle=all')).toMatchObject({
        statusCode: 200,
        body: { total: 1, items: [{ pinned: true, lifecycleState: 'archived' }] },
      });

      const unauthorizedRecovery = await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/restore/plan`,
        {},
      );
      expect(unauthorizedRecovery.statusCode).toBe(403);
      const recovery = await request<RecoveryPlan>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/restore/plan`,
        {},
        token,
      );
      expect(recovery).toMatchObject({
        statusCode: 200,
        body: {
          mapping: { state: 'needs-selection' },
          canStartUniversal: false,
          command: null,
        },
      });

      const unauthorized = await request<{ error: string }>(app, 'POST', '/api/session-vault/push');
      expect(unauthorized.statusCode).toBe(403);
      const pushed = await request<SessionVaultSyncStatus>(app, 'POST', '/api/session-vault/push', {}, token);
      expect(pushed).toMatchObject({ statusCode: 200, body: { state: 'synced', pendingLocal: false } });
      expect(await git(remotePath, ['rev-parse', 'refs/heads/main'])).toBe(archived.body.commitHash);

      const remoteWriterPath = path.join(root, 'remote-writer');
      await git(root, ['clone', '--branch', 'main', remotePath, remoteWriterPath]);
      await git(remoteWriterPath, ['config', 'user.name', 'Synthetic Remote Writer']);
      await git(remoteWriterPath, ['config', 'user.email', 'synthetic-remote@example.test']);
      await writeFile(path.join(remoteWriterPath, 'remote-marker.txt'), 'synthetic remote lifecycle guard\n');
      await git(remoteWriterPath, ['add', '--', 'remote-marker.txt']);
      await git(remoteWriterPath, ['commit', '-m', 'synthetic remote lifecycle guard']);
      await git(remoteWriterPath, ['push', 'origin', 'main']);
      await git(vaultPath, ['fetch', 'origin']);
      expect(await request<SessionListPayload>(app, 'GET', '/api/sessions?lifecycle=all')).toMatchObject({
        statusCode: 200,
        body: { sync: { state: 'remote-ahead', behind: 1 } },
      });
      const localHeadBeforeBlockedLifecycle = await git(vaultPath, ['rev-parse', 'HEAD']);
      const blockedLifecycle = await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent('fleet:synthetic-api-catalog')}/lifecycle`,
        { action: 'restore', expectedLifecycleVersion: archived.body.event.eventId },
        token,
      );
      expect(blockedLifecycle).toMatchObject({
        statusCode: 409,
        body: { error: expect.stringContaining('先拉取更新') },
      });
      expect(await git(vaultPath, ['rev-parse', 'HEAD'])).toBe(localHeadBeforeBlockedLifecycle);

      const pulled = await request<SessionVaultSyncStatus>(app, 'POST', '/api/session-vault/pull', {}, token);
      expect(pulled).toMatchObject({ statusCode: 200, body: { state: 'synced', remoteChecked: true } });
    } finally {
      await app.close();
    }
  }, 20_000);
});
