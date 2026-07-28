import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RotateSessionVaultEpochResult,
  SessionDetail,
  SessionVaultEpochSessionList,
  SessionVaultEpochStatus,
} from '../../shared/sessions.js';
import type { CaptureCheckpointInput } from './checkpoint.js';
import { captureCheckpoint } from './checkpoint.js';
import { loadSessionVaultStatus } from './vault.js';

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

function checkpointInput(vaultPath: string, index: number): CaptureCheckpointInput {
  return {
    vaultPath,
    sessionId: `fleet:synthetic-epoch-session-${index}`,
    session: {
      provider: 'codex',
      providerSessionId: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
      projectId: `remote:synthetic-epoch-${index}`,
      repositoryId: `synthetic-epoch-${index}`,
      repositoryName: 'Synthetic Epoch Project',
      title: `Synthetic epoch session ${index}`,
    },
    summary: {
      goal: `Continue synthetic epoch ${index}`,
      completed: ['Created synthetic checkpoint data'],
      decisions: ['Keep the archived Vault read-only'],
      nextSteps: ['Verify epoch search and detail'],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: `2026-07-28T0${index}:00:00.000Z`,
    },
    workspace: {
      projectId: `remote:synthetic-epoch-${index}`,
      repositoryId: `synthetic-epoch-${index}`,
      branch: `feature/epoch-${index}`,
      head: String(index).repeat(40),
      dirty: false,
      changedFiles: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      untrackedFiles: 0,
    },
    machine: `synthetic-epoch-machine-${index}`,
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync: null,
    },
    now: new Date(`2026-07-28T0${index}:05:00.000Z`),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session Vault epoch rotation API', () => {
  it('archives the old Vault as searchable read-only history and writes new checkpoints only to the new epoch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-epoch-api-'));
    temporaryDirectories.push(root);
    const fleetHome = path.join(root, 'fleet-home');
    const fleetSource = path.join(root, 'fleet-source');
    const oldVaultPath = path.join(root, 'private-vault-01');
    const newVaultPath = path.join(root, 'private-vault-02');
    await mkdir(fleetSource, { recursive: true });
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('GIT_FLEET_HOME', fleetHome);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetSource);

    const { buildApp } = await import('../app.js');
    const app = await buildApp();
    try {
      const session = await request<{ token: string }>(app, 'GET', '/api/session');
      const token = session.body.token;
      expect((await request(app, 'POST', '/api/session-vault/initialize', { vaultPath: oldVaultPath }, token)).statusCode).toBe(200);
      await captureCheckpoint(checkpointInput(oldVaultPath, 1));
      const oldHead = await git(oldVaultPath, ['rev-parse', 'HEAD']);

      const before = await request<SessionVaultEpochStatus>(app, 'GET', '/api/session-vault/epochs');
      expect(before.body.activeEpoch).toMatchObject({ sequence: 1, sessionCount: 1, readOnly: false });

      const rotated = await request<RotateSessionVaultEpochResult>(
        app,
        'POST',
        '/api/session-vault/rotate-epoch',
        {
          vaultPath: newVaultPath,
          enableRemoteSync: false,
          remoteName: 'origin',
          remoteUrl: null,
          confirmationPhrase: '',
          expectedActiveEpochId: before.body.activeEpochId,
          acknowledgeReadOnlyArchive: true,
        },
        token,
      );
      expect(rotated.statusCode).toBe(200);
      expect(rotated.body).toMatchObject({
        forcePushUsed: false,
        previousEpoch: { sequence: 1, readOnly: true, head: oldHead },
        activeEpoch: { sequence: 2, readOnly: false, sessionCount: 0 },
      });

      const binding = await loadSessionVaultStatus();
      expect(await realpath(binding.binding!.vaultPath)).toBe(await realpath(newVaultPath));
      await captureCheckpoint(checkpointInput(newVaultPath, 2));
      expect(await git(oldVaultPath, ['rev-parse', 'HEAD'])).toBe(oldHead);

      const epochs = await request<SessionVaultEpochStatus>(app, 'GET', '/api/session-vault/epochs');
      const archived = epochs.body.archivedEpochs[0]!;
      expect(epochs.body.activeEpoch).toMatchObject({ sequence: 2, sessionCount: 1 });
      expect(archived).toMatchObject({ sequence: 1, readOnly: true, sessionCount: 1, head: oldHead });

      const archivedSessions = await request<SessionVaultEpochSessionList>(
        app,
        'GET',
        `/api/session-vault/epochs/${archived.epochId}/sessions?search=epoch%20session%201&lifecycle=all`,
      );
      expect(archivedSessions.statusCode).toBe(200);
      expect(archivedSessions.body).toMatchObject({
        epoch: { epochId: archived.epochId, readOnly: true },
        total: 1,
        items: [{ sessionId: 'fleet:synthetic-epoch-session-1' }],
      });
      const detail = await request<SessionDetail>(
        app,
        'GET',
        `/api/session-vault/epochs/${archived.epochId}/sessions/fleet%3Asynthetic-epoch-session-1`,
      );
      expect(detail.body.latestHandoffMarkdown).toContain('Continue synthetic epoch 1');

      const rebind = await request<{ error: string }>(
        app,
        'POST',
        '/api/session-vault/initialize',
        { vaultPath: oldVaultPath },
        token,
      );
      expect(rebind.statusCode).toBe(409);
      expect(rebind.body.error).toContain('已归档为只读');
    } finally {
      await app.close();
    }
  }, 30_000);
});
