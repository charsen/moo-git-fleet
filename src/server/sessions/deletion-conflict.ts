import { createHash } from 'node:crypto';
import os from 'node:os';
import type {
  CheckpointCaptureResult,
  SessionDeletionConflictSaveRequest,
  SessionDeletionConflictSaveResult,
} from '../../shared/sessions.js';
import {
  sessionDeletionConflictSaveRequestSchema,
  sessionDeletionConflictSaveResultSchema,
} from '../../shared/sessions.js';
import { runGitText } from '../git/runner.js';
import { captureCheckpoint, CheckpointCaptureError } from './checkpoint.js';
import {
  SessionCatalogError,
  type SessionCatalogOptions,
  sessionVaultCheckpointPayload,
  sessionVaultSessionDetail,
} from './catalog.js';
import { mutateSessionLifecycle } from './lifecycle.js';
import { sessionVaultSyncStatus } from './sync.js';
import { loadSessionVaultStatus } from './vault.js';
import { sessionEventMachineSegment } from './vault-write.js';

export interface SessionDeletionConflictOptions extends SessionCatalogOptions {
  machine?: string;
  auditDirectory?: string;
}

export class SessionDeletionConflictError extends Error {
  constructor(
    readonly code:
      | 'vault-not-configured'
      | 'remote-update-required'
      | 'session-not-conflicted'
      | 'stale-deletion-conflict'
      | 'invalid-source-checkpoint'
      | 'save-target-conflict',
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionDeletionConflictError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function machineName(options: SessionDeletionConflictOptions): string {
  return (options.machine ?? process.env.GIT_FLEET_MACHINE ?? os.hostname()).trim().slice(0, 255) || 'machine';
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertMutationReady(options: SessionCatalogOptions): Promise<void> {
  const sync = await sessionVaultSyncStatus(options);
  if (sync.behind === 0 && sync.state !== 'diverged') return;
  throw new SessionDeletionConflictError(
    'remote-update-required',
    sync.ahead > 0
      ? 'Session Vault 本机与已知远端已经分叉，请先完成同步后再处置删除冲突'
      : 'Session Vault 已知远端有新提交，请先拉取更新后再处置删除冲突',
  );
}

async function existingSavedCheckpoint(
  newSessionId: string,
  sourceCheckpointId: string,
  options: SessionDeletionConflictOptions,
): Promise<{ checkpoint: CheckpointCaptureResult['checkpoint']; commitHash: string } | null> {
  let detail;
  try {
    detail = await sessionVaultSessionDetail(newSessionId, options);
  } catch (error) {
    if (error instanceof SessionCatalogError && error.statusCode === 404) return null;
    throw error;
  }
  const checkpoint = detail.checkpoints.find((item) => item.splitFromCheckpointId === sourceCheckpointId);
  if (!checkpoint || detail.checkpoints.length !== 1) {
    throw new SessionDeletionConflictError('save-target-conflict', '另存目标会话标识已被其他 checkpoint 占用，已停止写入');
  }
  const vaultStatus = await loadSessionVaultStatus(options);
  if (!vaultStatus.configured || !vaultStatus.binding) {
    throw new SessionDeletionConflictError('vault-not-configured', 'Session Vault 尚未初始化');
  }
  const eventPath = `events/${sessionEventMachineSegment(checkpoint.machine)}/${checkpoint.eventId}.json`;
  const commitHash = await runGitText(vaultStatus.binding.vaultPath, ['log', '-1', '--format=%H', '--', eventPath]);
  if (!/^[a-f0-9]{40,64}$/.test(commitHash)) {
    throw new SessionDeletionConflictError('save-target-conflict', '另存 checkpoint 已存在但无法定位其 Vault Commit');
  }
  return { checkpoint, commitHash };
}

export async function saveSessionDeletionConflictAsNew(
  sessionId: string,
  request: SessionDeletionConflictSaveRequest,
  options: SessionDeletionConflictOptions = {},
): Promise<SessionDeletionConflictSaveResult> {
  const input = sessionDeletionConflictSaveRequestSchema.parse(request);
  const expectedConflicts = sortedUnique(input.expectedConflictCheckpointIds);
  if (expectedConflicts.length !== input.expectedConflictCheckpointIds.length) {
    throw new SessionDeletionConflictError('stale-deletion-conflict', '删除冲突 checkpoint 列表包含重复项，请刷新详情后重试');
  }
  await assertMutationReady(options);
  const [vaultStatus, detail] = await Promise.all([
    loadSessionVaultStatus(options),
    sessionVaultSessionDetail(sessionId, options),
  ]);
  if (!vaultStatus.configured || !vaultStatus.binding) {
    throw new SessionDeletionConflictError('vault-not-configured', 'Session Vault 尚未初始化');
  }
  if (detail.session.lifecycleState !== 'trashed' || !detail.session.deletionConflict) {
    throw new SessionDeletionConflictError('session-not-conflicted', '当前会话已经没有“删除后产生新内容”冲突，请刷新详情');
  }
  if (detail.session.lifecycleVersion !== input.expectedLifecycleVersion) {
    throw new SessionDeletionConflictError('stale-deletion-conflict', '会话删除状态已经变化，请刷新详情后重新确认');
  }
  const currentConflicts = [...detail.session.deletionConflictCheckpointIds].sort();
  if (!sameIds(currentConflicts, expectedConflicts)) {
    throw new SessionDeletionConflictError('stale-deletion-conflict', '删除后产生的新 checkpoint 已变化，请刷新详情后重新选择');
  }
  if (!currentConflicts.includes(input.sourceCheckpointId)) {
    throw new SessionDeletionConflictError('invalid-source-checkpoint', '另存来源必须选择当前删除冲突中的一个 checkpoint');
  }

  const source = await sessionVaultCheckpointPayload(sessionId, input.sourceCheckpointId, options);
  const newSessionId = `fleet:trash-conflict:${digest(`${sessionId}\0${input.expectedLifecycleVersion}\0${input.sourceCheckpointId}`).slice(0, 32)}`;
  let saved = await existingSavedCheckpoint(newSessionId, input.sourceCheckpointId, options);
  if (!saved) {
    try {
      const captured = await captureCheckpoint({
        vaultPath: vaultStatus.binding.vaultPath,
        sessionId: newSessionId,
        session: {
          provider: source.checkpoint.provider,
          providerSessionId: source.checkpoint.providerSessionId,
          projectId: source.checkpoint.projectId,
          repositoryId: source.checkpoint.repositoryId,
          repositoryName: source.checkpoint.repositoryId,
          title: input.summary.goal,
        },
        summary: input.summary,
        workspace: source.workspace,
        parentCheckpointIds: [],
        expectedHeadCheckpointIds: [],
        resumedFromCheckpointId: null,
        splitFromCheckpointId: input.sourceCheckpointId,
        machine: machineName(options),
        capabilities: source.checkpoint.capabilities,
        now: options.now,
      });
      saved = { checkpoint: captured.checkpoint, commitHash: captured.commitHash };
    } catch (error) {
      if (error instanceof CheckpointCaptureError) {
        throw new SessionDeletionConflictError('save-target-conflict', error.message);
      }
      throw error;
    }
  }

  const resolution = await mutateSessionLifecycle(
    sessionId,
    'resolve-trash-conflict',
    input.expectedLifecycleVersion,
    { ...options, machine: machineName(options), resolvedCheckpointIds: [input.sourceCheckpointId] },
  );
  return sessionDeletionConflictSaveResultSchema.parse({
    schemaVersion: 1,
    newSessionId,
    checkpoint: saved.checkpoint,
    checkpointCommitHash: saved.commitHash,
    resolution,
    message: resolution.auditRecorded
      ? '已把删除后产生的新内容另存为独立会话；原会话继续留在废纸篓'
      : `${resolution.message}；新会话已经生成`,
  });
}
