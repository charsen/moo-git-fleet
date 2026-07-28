import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionDeletionConflictSaveResult,
  SessionDetail,
  SessionLifecycleMutationResult,
  SessionListPayload,
  SessionTrashEmptyPreview,
  SessionTrashEmptyResult,
} from '../../shared/sessions.js';
import type { CaptureCheckpointInput } from './checkpoint.js';
import { captureCheckpoint } from './checkpoint.js';
import { mutateSessionLifecycle } from './lifecycle.js';

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

function checkpointInput(vaultPath: string, sessionId: string, index: number): CaptureCheckpointInput {
  return {
    vaultPath,
    sessionId,
    session: {
      provider: 'codex',
      providerSessionId: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
      projectId: `remote:synthetic-trash-api-${index}`,
      repositoryId: `synthetic-trash-api-${index}`,
      repositoryName: 'Synthetic Trash API',
      title: `Synthetic trash API session ${index}`,
    },
    summary: {
      goal: `Exercise synthetic trash API session ${index}`,
      completed: [],
      decisions: [],
      nextSteps: [`Review synthetic trash API session ${index}`],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: `2026-07-28T0${index}:00:00.000Z`,
    },
    workspace: {
      projectId: `remote:synthetic-trash-api-${index}`,
      repositoryId: `synthetic-trash-api-${index}`,
      branch: `feature/trash-api-${index}`,
      head: String(index).repeat(40),
      dirty: false,
      changedFiles: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      untrackedFiles: 0,
    },
    machine: `synthetic-trash-api-machine-${index}`,
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync: null,
    },
    now: new Date(`2026-07-28T0${index}:00:00.000Z`),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session Vault trash API', () => {
  it('guards cleanup, filters trash, rejects a stale preview, and keeps purged metadata readable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-trash-api-'));
    temporaryDirectories.push(root);
    const fleetHome = path.join(root, 'fleet-home');
    const fleetSource = path.join(root, 'fleet-source');
    const vaultPath = path.join(root, 'private-vault');
    await mkdir(fleetSource, { recursive: true });
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    vi.stubEnv('GIT_FLEET_HOME', fleetHome);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetSource);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();

    try {
      const token = (await request<{ token: string }>(app, 'GET', '/api/session')).body.token;
      expect(await request(app, 'POST', '/api/session-vault/initialize', { vaultPath }, token)).toMatchObject({
        statusCode: 200,
      });

      const expiredSessionId = 'fleet:synthetic-trash-api-expired';
      const retainedSessionId = 'fleet:synthetic-trash-api-retained';
      const expiredCheckpoint = await captureCheckpoint(checkpointInput(vaultPath, expiredSessionId, 1));
      await captureCheckpoint(checkpointInput(vaultPath, retainedSessionId, 2));
      const expired = await mutateSessionLifecycle(expiredSessionId, 'trash', null, {
        trashRetentionDays: 1,
        now: new Date('2000-01-01T00:00:00.000Z'),
      });
      const retained = await mutateSessionLifecycle(retainedSessionId, 'trash', null, {
        trashRetentionDays: 3_650,
        now: new Date('2990-01-01T00:00:00.000Z'),
      });

      expect(await request<SessionListPayload>(app, 'GET', '/api/sessions?lifecycle=trashed')).toMatchObject({
        statusCode: 200,
        body: {
          total: 2,
          counts: { active: 0, archived: 0, trashed: 2, all: 2 },
          items: expect.arrayContaining([
            expect.objectContaining({ sessionId: expiredSessionId, payloadState: 'available' }),
            expect.objectContaining({ sessionId: retainedSessionId, payloadState: 'available' }),
          ]),
        },
      });

      const preview = await request<SessionTrashEmptyPreview>(app, 'GET', '/api/session-vault/trash/preview');
      expect(preview).toMatchObject({
        statusCode: 200,
        body: {
          totalTrashed: 2,
          eligibleSessions: 1,
          retainedSessions: 1,
          removableObjects: 1,
          canEmpty: true,
          blockers: [],
          historyWarning: expect.stringContaining('Git 历史'),
        },
      });
      expect(preview.body.removableBytes).toBeGreaterThan(0);

      const cleanupPayload = {
        expectedFingerprint: preview.body.fingerprint,
        acknowledgeGitHistoryRetention: true,
      };
      expect(await request<{ error: string }>(
        app,
        'POST',
        '/api/session-vault/trash/empty',
        cleanupPayload,
      )).toMatchObject({ statusCode: 403, body: { error: '本地会话已失效，请刷新页面' } });

      const restored = await request<SessionLifecycleMutationResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(retainedSessionId)}/lifecycle`,
        { action: 'untrash', expectedLifecycleVersion: retained.event.eventId },
        token,
      );
      expect(restored).toMatchObject({ statusCode: 200, body: { event: { action: 'untrash' } } });
      expect(await request<{ error: string }>(
        app,
        'POST',
        '/api/session-vault/trash/empty',
        cleanupPayload,
        token,
      )).toMatchObject({
        statusCode: 409,
        body: { error: expect.stringContaining('重新查看清理预览') },
      });

      const refreshed = await request<SessionTrashEmptyPreview>(app, 'GET', '/api/session-vault/trash/preview');
      expect(refreshed).toMatchObject({
        statusCode: 200,
        body: { totalTrashed: 1, eligibleSessions: 1, retainedSessions: 0, canEmpty: true },
      });
      const emptied = await request<SessionTrashEmptyResult>(
        app,
        'POST',
        '/api/session-vault/trash/empty',
        {
          expectedFingerprint: refreshed.body.fingerprint,
          acknowledgeGitHistoryRetention: true,
        },
        token,
      );
      expect(emptied).toMatchObject({
        statusCode: 200,
        body: {
          removedSessions: 1,
          removedObjects: 1,
          auditRecorded: true,
          message: expect.stringContaining('Git 历史仍可能保留'),
        },
      });
      expect(emptied.body.removedBytes).toBeGreaterThan(0);

      expect(await request<SessionListPayload>(app, 'GET', '/api/sessions?lifecycle=trashed')).toMatchObject({
        statusCode: 200,
        body: {
          total: 1,
          counts: { active: 1, archived: 0, trashed: 1, all: 2 },
          items: [{
            sessionId: expiredSessionId,
            lifecycleVersion: expired.event.eventId,
            payloadState: 'purged',
            payloadBytes: 0,
          }],
        },
      });
      expect(await request<SessionDetail>(
        app,
        'GET',
        `/api/sessions/${encodeURIComponent(expiredSessionId)}`,
      )).toMatchObject({
        statusCode: 200,
        body: { latestHandoffMarkdown: null, latestWorkspace: null },
      });
      expect(await request<{ error: string }>(
        app,
        'GET',
        `/api/sessions/${encodeURIComponent(expiredSessionId)}/checkpoints/${expiredCheckpoint.checkpoint.checkpointId}`,
      )).toMatchObject({
        statusCode: 410,
        body: { error: expect.stringContaining('Git 历史或备份') },
      });
      expect(await git(vaultPath, ['status', '--porcelain'])).toBe('');
    } finally {
      await app.close();
    }
  }, 20_000);

  it('guards deletion-conflict save-as-new, rejects stale heads, and keeps the original session trashed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-trash-conflict-api-'));
    temporaryDirectories.push(root);
    const fleetHome = path.join(root, 'fleet-home');
    const fleetSource = path.join(root, 'fleet-source');
    const vaultPath = path.join(root, 'private-vault');
    await mkdir(fleetSource, { recursive: true });
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    vi.stubEnv('GIT_FLEET_HOME', fleetHome);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetSource);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();

    try {
      const token = (await request<{ token: string }>(app, 'GET', '/api/session')).body.token;
      expect(await request(app, 'POST', '/api/session-vault/initialize', { vaultPath }, token)).toMatchObject({
        statusCode: 200,
      });

      const sessionId = 'fleet:synthetic-trash-conflict-api';
      const firstInput = checkpointInput(vaultPath, sessionId, 3);
      const first = await captureCheckpoint(firstInput);
      const trashed = await mutateSessionLifecycle(sessionId, 'trash', null, {
        trashRetentionDays: 30,
        now: new Date('2026-07-28T04:00:00.000Z'),
      });
      const continuedInput = checkpointInput(vaultPath, sessionId, 3);
      continuedInput.summary = {
        ...continuedInput.summary,
        goal: 'Continue synthetic work from an old device after deletion',
        nextSteps: ['Resolve the synthetic deletion conflict'],
        reviewedAt: '2026-07-28T05:00:00.000Z',
      };
      continuedInput.parentCheckpointIds = [first.checkpoint.checkpointId];
      continuedInput.expectedHeadCheckpointIds = [first.checkpoint.checkpointId];
      continuedInput.resumedFromCheckpointId = first.checkpoint.checkpointId;
      continuedInput.machine = 'synthetic-trash-conflict-old-device';
      continuedInput.now = new Date('2026-07-28T05:00:00.000Z');
      const continued = await captureCheckpoint(continuedInput);

      const detail = await request<SessionDetail>(
        app,
        'GET',
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(detail).toMatchObject({
        statusCode: 200,
        body: {
          session: {
            lifecycleState: 'trashed',
            lifecycleVersion: trashed.event.eventId,
            deletionConflict: true,
            deletionConflictCheckpointIds: [continued.checkpoint.checkpointId],
          },
        },
      });

      const summary = {
        goal: 'Continue the synthetic deletion conflict as a new session',
        completed: ['Reviewed the old-device checkpoint'],
        decisions: ['Keep the original logical session in trash'],
        nextSteps: ['Continue the synthetic verification'],
        blockers: [],
        commands: [],
        risks: ['Synthetic test data only'],
        source: 'manual' as const,
        reviewedAt: '2026-07-28T06:00:00.000Z',
      };
      const saveUrl = `/api/sessions/${encodeURIComponent(sessionId)}/trash-conflict/save-as-new`;
      const savePayload = {
        expectedLifecycleVersion: trashed.event.eventId,
        expectedConflictCheckpointIds: [continued.checkpoint.checkpointId],
        sourceCheckpointId: continued.checkpoint.checkpointId,
        summary,
      };
      expect(await request<{ error: string }>(app, 'POST', saveUrl, savePayload)).toMatchObject({
        statusCode: 403,
        body: { error: '本地会话已失效，请刷新页面' },
      });
      expect(await request<{ error: string }>(app, 'POST', saveUrl, {
        ...savePayload,
        expectedConflictCheckpointIds: [first.checkpoint.checkpointId],
      }, token)).toMatchObject({
        statusCode: 409,
        body: { error: expect.stringContaining('新 checkpoint 已变化') },
      });

      const saved = await request<SessionDeletionConflictSaveResult>(app, 'POST', saveUrl, savePayload, token);
      expect(saved).toMatchObject({
        statusCode: 200,
        body: {
          newSessionId: expect.stringMatching(/^fleet:trash-conflict:/),
          checkpoint: { splitFromCheckpointId: continued.checkpoint.checkpointId },
          resolution: {
            event: {
              action: 'resolve-trash-conflict',
              resolvedCheckpointIds: [continued.checkpoint.checkpointId],
            },
            auditRecorded: true,
          },
          message: expect.stringContaining('原会话继续留在废纸篓'),
        },
      });
      expect(saved.body.checkpointCommitHash).toMatch(/^[a-f0-9]{40,64}$/);

      expect(await request<SessionDetail>(app, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`)).toMatchObject({
        statusCode: 200,
        body: { session: { lifecycleState: 'trashed', deletionConflict: false } },
      });
      expect(await request<SessionDetail>(
        app,
        'GET',
        `/api/sessions/${encodeURIComponent(saved.body.newSessionId)}`,
      )).toMatchObject({
        statusCode: 200,
        body: {
          session: { lifecycleState: 'active', checkpointCount: 1 },
          checkpoints: [{ splitFromCheckpointId: continued.checkpoint.checkpointId }],
        },
      });
      expect(await git(vaultPath, ['status', '--porcelain'])).toBe('');
    } finally {
      await app.close();
    }
  }, 20_000);
});
