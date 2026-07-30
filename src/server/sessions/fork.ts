import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { nativeCapsuleManifestSchema } from '../../shared/native-capsule.js';
import type {
  CheckpointCaptureResult,
  SessionForkMergeResult,
  SessionForkMergeRequest,
  SessionForkSelectRequest,
  SessionForkSelectResult,
  SessionForkSplitRequest,
  SessionForkSplitResult,
} from '../../shared/sessions.js';
import {
  sessionForkMergeResultSchema,
  sessionForkMergeRequestSchema,
  sessionForkSelectResultSchema,
  sessionForkSelectRequestSchema,
  sessionForkSplitRequestSchema,
  sessionForkSplitResultSchema,
} from '../../shared/sessions.js';
import { runGitText } from '../git/runner.js';
import { captureCheckpoint, CheckpointCaptureError } from './checkpoint.js';
import {
  SessionCatalogError,
  type SessionNativeCapsulePayload,
  type SessionCatalogOptions,
  sessionVaultCheckpointPayload,
  sessionVaultNativeCapsulePayload,
  sessionVaultSessionDetail,
} from './catalog.js';
import type { NativeCapsuleCapture } from './native-capsule.js';
import { appendSessionLineageResolution, SessionLineageError } from './lineage.js';
import {
  appendSessionOperationAudit,
  hashSessionAuditId,
  type SessionForkAuditAction,
  type SessionOperationAuditOptions,
} from './session-operation-audit.js';
import { sessionVaultSyncStatus } from './sync.js';
import { loadSessionVaultStatus } from './vault.js';
import { sessionEventMachineSegment } from './vault-write.js';

export type SessionForkErrorCode =
  | 'vault-not-configured'
  | 'remote-update-required'
  | 'session-not-forked'
  | 'stale-fork-state'
  | 'invalid-base-checkpoint'
  | 'split-session-conflict';

export class SessionForkError extends Error {
  constructor(
    readonly code: SessionForkErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionForkError';
  }
}

export interface SessionForkOptions extends SessionCatalogOptions, SessionOperationAuditOptions {
  machine?: string;
}

const unauditedSessionForkSplitResultSchema = sessionForkSplitResultSchema.omit({ auditRecorded: true });

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicProviderSessionId(sessionId: string, checkpointId: string): string {
  const source = digest(`${sessionId}\0${checkpointId}\0split-provider-session`).slice(0, 32).split('');
  source[12] = '4';
  source[16] = ['8', '9', 'a', 'b'][Number.parseInt(source[16] ?? '0', 16) % 4]!;
  const value = source.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function replaceExactString(value: unknown, sourceId: string, targetId: string): unknown {
  if (typeof value === 'string') return value === sourceId ? targetId : value;
  if (Array.isArray(value)) return value.map((item) => replaceExactString(item, sourceId, targetId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    replaceExactString(item, sourceId, targetId),
  ]));
}

function duplicateNativeCapsule(
  source: SessionNativeCapsulePayload,
  providerSessionId: string,
  capturedAt: string,
): NativeCapsuleCapture | undefined {
  if (source.manifest.status !== 'verified' || !source.recordContent) return undefined;
  const originalFile = source.manifest.files[0];
  if (!originalFile) return undefined;
  const records = source.recordContent.split(/\r?\n/).filter(Boolean).map((line) => {
    const parsed: unknown = JSON.parse(line);
    return JSON.stringify(replaceExactString(parsed, source.manifest.providerSessionId, providerSessionId));
  });
  const recordContent = `${records.join('\n')}\n`;
  const fileName = source.manifest.provider === 'claude'
    ? `${providerSessionId}.jsonl`
    : originalFile.fileName.includes(source.manifest.providerSessionId)
      ? originalFile.fileName.replace(source.manifest.providerSessionId, providerSessionId)
      : `rollout-${providerSessionId}.jsonl`;
  return {
    manifest: nativeCapsuleManifestSchema.parse({
      ...source.manifest,
      providerSessionId,
      capturedAt,
      files: [{
        ...originalFile,
        fileName,
        sha256: digest(recordContent),
        bytes: Buffer.byteLength(recordContent),
      }],
    }),
    recordContent,
  };
}

function machineName(options: SessionForkOptions): string {
  return (options.machine ?? process.env.GIT_FLEET_MACHINE ?? os.hostname()).trim().slice(0, 255) || 'machine';
}

function forkAuditErrorCode(error: unknown): string {
  if (error instanceof SessionForkError || error instanceof SessionLineageError) return error.code;
  if (error instanceof SessionCatalogError) return 'session-catalog-error';
  if (error instanceof CheckpointCaptureError) return 'checkpoint-capture-failed';
  return 'unexpected-error';
}

function auditWarning(message: string, auditRecorded: boolean): string {
  return auditRecorded
    ? message
    : `${message}；但本地审计日志写入失败，请检查应用数据目录权限`;
}

async function runAuditedForkOperation<T>(
  sessionId: string,
  action: SessionForkAuditAction,
  options: SessionForkOptions,
  operation: () => Promise<T>,
  identifiers: (result: T) => { eventId: string; commitHash: string },
): Promise<{ result: T; auditRecorded: boolean }> {
  const operationId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let result: T | undefined;
  let caught: unknown = null;
  try {
    result = await operation();
  } catch (error) {
    caught = error;
  }

  const finishedAt = new Date().toISOString();
  const committed = result ? identifiers(result) : null;
  let auditRecorded = true;
  try {
    await appendSessionOperationAudit({
      schemaVersion: 1,
      operationId,
      category: 'session-fork',
      action,
      result: caught ? 'failed' : 'success',
      sessionIdHash: hashSessionAuditId(sessionId),
      eventId: committed?.eventId ?? null,
      commitHash: committed?.commitHash ?? null,
      errorCode: caught ? forkAuditErrorCode(caught) : null,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    }, options);
  } catch {
    auditRecorded = false;
  }
  if (caught) throw caught;
  if (!result) throw new SessionForkError('stale-fork-state', '会话分支操作未完成', 500);
  return { result, auditRecorded };
}

async function assertForkMutationReady(options: SessionCatalogOptions): Promise<void> {
  const sync = await sessionVaultSyncStatus(options);
  if (sync.behind === 0 && sync.state !== 'diverged') return;
  throw new SessionForkError(
    'remote-update-required',
    sync.ahead > 0
      ? 'Session Vault 本机与已知远端已经分叉，请先完成同步后再处理会话分支'
      : 'Session Vault 已知远端有新提交，请先拉取更新后再处理会话分支',
  );
}

export async function mergeSessionFork(
  sessionId: string,
  request: SessionForkMergeRequest,
  options: SessionForkOptions = {},
): Promise<SessionForkMergeResult> {
  const audited = await runAuditedForkOperation(
    sessionId,
    'merge',
    options,
    async () => {
      const input = sessionForkMergeRequestSchema.parse(request);
      const expectedHeads = sortedUnique(input.expectedHeadCheckpointIds);
      if (expectedHeads.length !== input.expectedHeadCheckpointIds.length) {
        throw new SessionForkError('stale-fork-state', '待合并的 checkpoint head 存在重复项，请刷新会话详情后重试');
      }
      await assertForkMutationReady(options);
      const [vaultStatus, detail] = await Promise.all([
        loadSessionVaultStatus(options),
        sessionVaultSessionDetail(sessionId, options),
      ]);
      if (!vaultStatus.configured || !vaultStatus.binding) {
        throw new SessionForkError('vault-not-configured', 'Session Vault 尚未初始化');
      }
      const currentHeads = [...detail.session.headCheckpointIds].sort();
      if (currentHeads.length < 2) {
        throw new SessionForkError('session-not-forked', '当前会话已经不是分叉状态，请刷新详情后继续');
      }
      if (!sameIds(currentHeads, expectedHeads)) {
        throw new SessionForkError('stale-fork-state', '会话分叉 head 已变化，请刷新详情并重新确认合并范围');
      }
      if (!currentHeads.includes(input.baseCheckpointId)) {
        throw new SessionForkError('invalid-base-checkpoint', '恢复基线必须选择当前分叉中的一个 head checkpoint');
      }
      const base = await sessionVaultCheckpointPayload(sessionId, input.baseCheckpointId, options);
      return captureCheckpoint({
        vaultPath: vaultStatus.binding.vaultPath,
        sessionId,
        session: {
          provider: base.checkpoint.provider,
          providerSessionId: base.checkpoint.providerSessionId,
          projectId: base.checkpoint.projectId,
          repositoryId: base.checkpoint.repositoryId,
          repositoryName: base.checkpoint.repositoryId,
          title: input.summary.goal,
        },
        summary: input.summary,
        workspace: base.workspace,
        parentCheckpointIds: currentHeads,
        expectedHeadCheckpointIds: currentHeads,
        resumedFromCheckpointId: null,
        machine: machineName(options),
        capabilities: base.checkpoint.capabilities,
        now: options.now,
      });
    },
    (result) => ({ eventId: result.checkpoint.eventId, commitHash: result.commitHash }),
  );
  return sessionForkMergeResultSchema.parse({
    ...audited.result,
    auditRecorded: audited.auditRecorded,
    message: auditWarning(
      `已生成合并交接点 ${audited.result.checkpoint.checkpointId.slice(0, 10)}；全部分支内容仍保留在时间线中`,
      audited.auditRecorded,
    ),
  });
}

export async function selectSessionForkHead(
  sessionId: string,
  request: SessionForkSelectRequest,
  options: SessionForkOptions = {},
): Promise<SessionForkSelectResult> {
  const audited = await runAuditedForkOperation(
    sessionId,
    'select-head',
    options,
    async () => {
      const input = sessionForkSelectRequestSchema.parse(request);
      await assertForkMutationReady(options);
      return appendSessionLineageResolution(
        {
          sessionId,
          action: 'select-head',
          expectedHeadCheckpointIds: input.expectedHeadCheckpointIds,
          selectedHeadCheckpointId: input.selectedHeadCheckpointId,
        },
        { ...options, machine: machineName(options) },
      );
    },
    (result) => ({ eventId: result.event.eventId, commitHash: result.commitHash }),
  );
  return sessionForkSelectResultSchema.parse({
    ...audited.result,
    auditRecorded: audited.auditRecorded,
    message: auditWarning(audited.result.message, audited.auditRecorded),
  });
}

async function existingSplitCheckpoint(
  newSessionId: string,
  sourceHeadCheckpointId: string,
  options: SessionForkOptions,
): Promise<{ checkpoint: CheckpointCaptureResult['checkpoint']; commitHash: string } | null> {
  let detail;
  try {
    detail = await sessionVaultSessionDetail(newSessionId, options);
  } catch (error) {
    if (error instanceof SessionCatalogError && error.statusCode === 404) return null;
    throw error;
  }
  const checkpoint = detail.checkpoints.find((item) => item.splitFromCheckpointId === sourceHeadCheckpointId);
  if (!checkpoint || detail.checkpoints.length !== 1) {
    throw new SessionForkError('split-session-conflict', '拆分目标会话标识已被其他 checkpoint 占用，已停止写入');
  }
  const vaultStatus = await loadSessionVaultStatus(options);
  if (!vaultStatus.configured || !vaultStatus.binding) {
    throw new SessionForkError('vault-not-configured', 'Session Vault 尚未初始化');
  }
  const eventPath = `events/${sessionEventMachineSegment(checkpoint.machine)}/${checkpoint.eventId}.json`;
  const commitHash = await runGitText(vaultStatus.binding.vaultPath, ['log', '-1', '--format=%H', '--', eventPath]);
  if (!/^[a-f0-9]{40,64}$/.test(commitHash)) {
    throw new SessionForkError('split-session-conflict', '拆分 checkpoint 已存在但无法定位其 Vault Commit');
  }
  return { checkpoint, commitHash };
}

export async function splitSessionFork(
  sessionId: string,
  request: SessionForkSplitRequest,
  options: SessionForkOptions = {},
): Promise<SessionForkSplitResult> {
  const audited = await runAuditedForkOperation(
    sessionId,
    'split',
    options,
    async () => {
      const input = sessionForkSplitRequestSchema.parse(request);
      const expectedHeads = sortedUnique(input.expectedHeadCheckpointIds);
      if (
        expectedHeads.length !== 2 ||
        input.selectedHeadCheckpointId === input.splitHeadCheckpointId ||
        !expectedHeads.includes(input.selectedHeadCheckpointId) ||
        !expectedHeads.includes(input.splitHeadCheckpointId)
      ) {
        throw new SessionForkError('stale-fork-state', '拆分操作必须从两个当前 head 中各选择一条保留与一条拆出');
      }
      await assertForkMutationReady(options);
      const [vaultStatus, detail, source, sourceNative] = await Promise.all([
        loadSessionVaultStatus(options),
        sessionVaultSessionDetail(sessionId, options),
        sessionVaultCheckpointPayload(sessionId, input.splitHeadCheckpointId, options),
        sessionVaultNativeCapsulePayload(sessionId, input.splitHeadCheckpointId, options),
      ]);
      if (!vaultStatus.configured || !vaultStatus.binding) {
        throw new SessionForkError('vault-not-configured', 'Session Vault 尚未初始化');
      }
      const currentHeads = [...detail.session.headCheckpointIds].sort();
      if (!sameIds(currentHeads, expectedHeads)) {
        throw new SessionForkError('stale-fork-state', '会话分叉 head 已变化，请刷新详情后重新拆分');
      }

      const newSessionId = `fleet:split:${digest(`${sessionId}\0${input.splitHeadCheckpointId}`).slice(0, 32)}`;
      let splitCheckpoint = await existingSplitCheckpoint(newSessionId, input.splitHeadCheckpointId, options);
      if (!splitCheckpoint) {
        const now = options.now ?? new Date();
        const providerSessionId = deterministicProviderSessionId(newSessionId, input.splitHeadCheckpointId);
        const nativeCapsule = duplicateNativeCapsule(sourceNative, providerSessionId, now.toISOString());
        const captured = await captureCheckpoint({
          vaultPath: vaultStatus.binding.vaultPath,
          sessionId: newSessionId,
          session: {
            provider: source.checkpoint.provider,
            providerSessionId,
            projectId: source.checkpoint.projectId,
            repositoryId: source.checkpoint.repositoryId,
            repositoryName: source.checkpoint.repositoryId,
            title: input.newSessionSummary.goal,
          },
          summary: input.newSessionSummary,
          workspace: source.workspace,
          parentCheckpointIds: [],
          expectedHeadCheckpointIds: [],
          resumedFromCheckpointId: null,
          splitFromCheckpointId: input.splitHeadCheckpointId,
          machine: machineName(options),
          capabilities: source.checkpoint.capabilities,
          nativeCapsule,
          now,
        });
        splitCheckpoint = { checkpoint: captured.checkpoint, commitHash: captured.commitHash };
      }

      const resolution = await appendSessionLineageResolution(
        {
          sessionId,
          action: 'split',
          expectedHeadCheckpointIds: expectedHeads,
          selectedHeadCheckpointId: input.selectedHeadCheckpointId,
          splitSessions: [{
            sourceHeadCheckpointId: input.splitHeadCheckpointId,
            newSessionId,
            newCheckpointId: splitCheckpoint.checkpoint.checkpointId,
          }],
        },
        { ...options, machine: machineName(options) },
      );
      return unauditedSessionForkSplitResultSchema.parse({
        schemaVersion: 1,
        newSessionId,
        checkpoint: splitCheckpoint.checkpoint,
        checkpointCommitHash: splitCheckpoint.commitHash,
        resolution,
        message: '已把两条 checkpoint head 拆成两个独立逻辑会话；原始对象与 lineage 均完整保留',
      });
    },
    (result) => ({ eventId: result.resolution.event.eventId, commitHash: result.resolution.commitHash }),
  );
  return sessionForkSplitResultSchema.parse({
    ...audited.result,
    auditRecorded: audited.auditRecorded,
    message: auditWarning(audited.result.message, audited.auditRecorded),
  });
}
