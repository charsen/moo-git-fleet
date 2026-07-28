import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Checkpoint,
  SessionCheckpointPayload,
  SessionForkMergeResult,
  SessionForkSelectResult,
  SessionForkSplitResult,
  SessionListPayload,
} from '../../shared/sessions.js';
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

function checkpointInput(
  vaultPath: string,
  sessionId: string,
  index: number,
  parentCheckpointIds: string[] = [],
) {
  return {
    vaultPath,
    sessionId,
    session: {
      provider: 'codex' as const,
      providerSessionId: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
      projectId: `remote:synthetic-fork-api-${sessionId}`,
      repositoryId: `synthetic-fork-api-${sessionId}`,
      repositoryName: 'Synthetic Fork API',
      title: `Synthetic fork API head ${index}`,
    },
    summary: {
      goal: `Continue synthetic fork API head ${index}`,
      completed: [`Captured synthetic head ${index}`],
      decisions: [],
      nextSteps: [`Continue synthetic head ${index}`],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual' as const,
      reviewedAt: `2026-07-28T0${index}:00:00.000Z`,
    },
    workspace: {
      projectId: `remote:synthetic-fork-api-${sessionId}`,
      repositoryId: `synthetic-fork-api-${sessionId}`,
      branch: `feature/fork-api-${index}`,
      head: String(index).repeat(40),
      dirty: false,
      changedFiles: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      untrackedFiles: 0,
    },
    parentCheckpointIds,
    machine: `synthetic-api-machine-${index}`,
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

async function forkedSession(vaultPath: string, sessionId: string): Promise<[Checkpoint, Checkpoint]> {
  const root = await captureCheckpoint(checkpointInput(vaultPath, sessionId, 1));
  const left = await captureCheckpoint(
    checkpointInput(vaultPath, sessionId, 2, [root.checkpoint.checkpointId]),
  );
  const right = await captureCheckpoint(
    checkpointInput(vaultPath, sessionId, 3, [root.checkpoint.checkpointId]),
  );
  return [left.checkpoint, right.checkpoint];
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session fork resolution API', () => {
  it('requires explicit head selection for recovery and guards merge/split writes with the local token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-fork-api-'));
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
    vi.stubEnv('GIT_FLEET_MACHINE', 'synthetic-api-resolver');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();

    try {
      const token = (await request<{ token: string }>(app, 'GET', '/api/session')).body.token;
      expect(await request(app, 'POST', '/api/session-vault/initialize', { vaultPath }, token)).toMatchObject({
        statusCode: 200,
      });
      const splitSessionId = 'fleet:synthetic-fork-api-split';
      const [left, right] = await forkedSession(vaultPath, splitSessionId);
      const list = await request<SessionListPayload>(app, 'GET', '/api/sessions');
      expect(list).toMatchObject({ statusCode: 200, body: { items: [{ forked: true }] } });

      const selectedPayload = await request<SessionCheckpointPayload>(
        app,
        'GET',
        `/api/sessions/${encodeURIComponent(splitSessionId)}/checkpoints/${left.checkpointId}`,
      );
      expect(selectedPayload).toMatchObject({
        statusCode: 200,
        body: { checkpoint: { checkpointId: left.checkpointId } },
      });
      expect(await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(splitSessionId)}/restore/plan`,
        {},
        token,
      )).toMatchObject({ statusCode: 409, body: { error: expect.stringContaining('选择一个 head') } });

      const splitPayload = {
        expectedHeadCheckpointIds: [left.checkpointId, right.checkpointId],
        selectedHeadCheckpointId: left.checkpointId,
        splitHeadCheckpointId: right.checkpointId,
        newSessionSummary: {
          goal: 'Continue the right API branch separately',
          completed: ['Reviewed the synthetic API split'],
          decisions: ['Keep the left head in the original session'],
          nextSteps: ['Continue the new synthetic API session'],
          blockers: [],
          commands: [],
          risks: [],
          source: 'manual',
          reviewedAt: '2026-07-28T04:00:00.000Z',
        },
      };
      expect(await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(splitSessionId)}/fork/split`,
        splitPayload,
      )).toMatchObject({ statusCode: 403 });
      const split = await request<SessionForkSplitResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(splitSessionId)}/fork/split`,
        splitPayload,
        token,
      );
      expect(split).toMatchObject({
        statusCode: 200,
        body: {
          auditRecorded: true,
          checkpoint: { splitFromCheckpointId: right.checkpointId },
          resolution: { event: { action: 'split', selectedHeadCheckpointId: left.checkpointId } },
        },
      });
      expect(await request<SessionListPayload>(app, 'GET', '/api/sessions')).toMatchObject({
        statusCode: 200,
        body: { total: 2, items: expect.arrayContaining([expect.objectContaining({ forked: false })]) },
      });

      const mergeSessionId = 'fleet:synthetic-fork-api-merge';
      const [mergeLeft, mergeRight] = await forkedSession(vaultPath, mergeSessionId);
      const mergePayload = {
        expectedHeadCheckpointIds: [mergeLeft.checkpointId, mergeRight.checkpointId],
        baseCheckpointId: mergeLeft.checkpointId,
        summary: {
          goal: 'Merge the synthetic API branches',
          completed: ['Reviewed both API branches'],
          decisions: ['Use the left API branch as recovery baseline'],
          nextSteps: ['Continue the merged API session'],
          blockers: [],
          commands: [],
          risks: [],
          source: 'manual',
          reviewedAt: '2026-07-28T05:00:00.000Z',
        },
      };
      expect(await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(mergeSessionId)}/fork/merge`,
        mergePayload,
      )).toMatchObject({ statusCode: 403 });
      const merged = await request<SessionForkMergeResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(mergeSessionId)}/fork/merge`,
        mergePayload,
        token,
      );
      expect(merged).toMatchObject({ statusCode: 200, body: { auditRecorded: true } });

      const selectSessionId = 'fleet:synthetic-fork-api-select';
      const [selectLeft, selectRight] = await forkedSession(vaultPath, selectSessionId);
      const selectPayload = {
        expectedHeadCheckpointIds: [selectLeft.checkpointId, selectRight.checkpointId],
        selectedHeadCheckpointId: selectRight.checkpointId,
      };
      expect(await request<{ error: string }>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(selectSessionId)}/fork/select`,
        selectPayload,
      )).toMatchObject({ statusCode: 403 });
      const selected = await request<SessionForkSelectResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(selectSessionId)}/fork/select`,
        selectPayload,
        token,
      );
      expect(selected).toMatchObject({
        statusCode: 200,
        body: {
          auditRecorded: true,
          event: { action: 'select-head', selectedHeadCheckpointId: selectRight.checkpointId },
        },
      });

      const auditDirectory = path.join(fleetHome, '.data', 'operations');
      const auditContents = (await Promise.all(
        (await readdir(auditDirectory)).map((file) => readFile(path.join(auditDirectory, file), 'utf8')),
      )).join('\n');
      expect(auditContents).toContain('"category":"session-fork"');
      expect(auditContents).toContain('"action":"split"');
      expect(auditContents).toContain('"action":"merge"');
      expect(auditContents).toContain('"action":"select-head"');
      expect(auditContents).not.toContain(splitSessionId);
      expect(auditContents).not.toContain(mergeSessionId);
      expect(auditContents).not.toContain(selectSessionId);
      expect(auditContents).not.toContain('Merge the synthetic API branches');
      expect(auditContents).not.toContain(vaultPath);

      await rm(auditDirectory, { recursive: true, force: true });
      await writeFile(auditDirectory, 'synthetic audit blocker\n');
      const warningSessionId = 'fleet:synthetic-fork-api-audit-warning';
      const [warningLeft, warningRight] = await forkedSession(vaultPath, warningSessionId);
      const warning = await request<SessionForkSelectResult>(
        app,
        'POST',
        `/api/sessions/${encodeURIComponent(warningSessionId)}/fork/select`,
        {
          expectedHeadCheckpointIds: [warningLeft.checkpointId, warningRight.checkpointId],
          selectedHeadCheckpointId: warningLeft.checkpointId,
        },
        token,
      );
      expect(warning).toMatchObject({
        statusCode: 200,
        body: {
          auditRecorded: false,
          commitHash: expect.stringMatching(/^[a-f0-9]{40,64}$/),
          message: expect.stringContaining('已记录继续使用的会话 head；被搁置分支仍保留在历史中；但本地审计日志写入失败'),
        },
      });
      expect(await request(app, 'GET', `/api/sessions/${encodeURIComponent(warningSessionId)}`)).toMatchObject({
        statusCode: 200,
        body: { session: { forked: false, headCheckpointIds: [warningLeft.checkpointId] } },
      });
      expect(await git(vaultPath, ['rev-parse', 'HEAD'])).toBe(warning.body.commitHash);
      expect(await git(vaultPath, ['status', '--porcelain'])).toBe('');
    } finally {
      await app.close();
    }
  }, 20_000);
});
