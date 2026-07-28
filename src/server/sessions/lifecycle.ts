import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  LifecycleEvent,
  LifecycleAction,
  SessionVaultBinding,
  SessionLifecycleMutationAction,
  SessionLifecycleMutationResult,
  SessionTrashEmptyPreview,
  SessionTrashEmptyRequest,
  SessionTrashEmptyResult,
} from '../../shared/sessions.js';
import {
  lifecycleEventSchema,
  sessionLifecycleMutationResultSchema,
  sessionTrashEmptyPreviewSchema,
  sessionTrashEmptyRequestSchema,
  sessionTrashEmptyResultSchema,
} from '../../shared/sessions.js';
import { runGit, runGitText } from '../git/runner.js';
import { recoverCheckpointTransactionsWithinLock } from './checkpoint.js';
import { deriveSessionCatalog, readSessionPayloadObjectsAtHead } from './catalog.js';
import { readSessionEventsAtHead, SessionEventStoreError } from './event-store.js';
import {
  appendSessionOperationAudit,
  hashSessionAuditId,
  type SessionOperationAuditOptions,
} from './session-operation-audit.js';
import {
  applyLifecycleEvent,
  deriveSessionLifecycleStates,
  SessionLifecycleStateError,
} from './lifecycle-state.js';
import { assertNoSecrets } from './secrets.js';
import { loadSessionVaultStatus, type SessionVaultServiceOptions } from './vault.js';
import { withSessionVaultLock } from './vault-lock.js';
import {
  assertSessionVaultClean,
  assertSessionVaultIdentity,
  assertSessionVaultWriteReady,
  sessionEventMachineSegment,
  sessionVaultPathTrackedAtHead,
  stageSessionVaultPaths,
} from './vault-write.js';

export type LifecycleTestPhase =
  | 'after-event-publish'
  | 'after-index-stage'
  | 'after-trash-objects-removed'
  | 'after-trash-index-stage';

const lifecycleJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  eventId: z.string().uuid(),
  eventPath: z.string().regex(/^events\/[a-z0-9-]+-[a-f0-9]{8}\/[0-9a-f-]{36}\.json$/),
  temporaryPath: z.string().regex(/^\.fleet\/lifecycle-staging\/[0-9a-f-]{36}\.event\.tmp$/),
  phase: z.enum(['prepared', 'event-published', 'index-staged', 'committed']),
  preMutationHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type LifecycleJournal = z.infer<typeof lifecycleJournalSchema>;

const trashEmptyJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  operationType: z.literal('trash-empty'),
  objectPaths: z.array(z.string().regex(/^objects\/[a-f0-9]{64}$/)).min(1).max(100_000),
  phase: z.enum(['prepared', 'objects-removed', 'index-staged', 'committed']),
  preMutationHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type TrashEmptyJournal = z.infer<typeof trashEmptyJournalSchema>;

export interface SessionLifecycleOptions extends SessionVaultServiceOptions, SessionOperationAuditOptions {
  machine?: string;
  trashRetentionDays?: number;
  resolvedCheckpointIds?: string[];
  testHook?: (phase: LifecycleTestPhase, path: string) => void | Promise<void>;
}

export class SessionLifecycleError extends Error {
  constructor(
    readonly code:
      | 'vault-not-configured'
      | 'vault-empty'
      | 'remote-update-required'
      | 'session-not-found'
      | 'stale-lifecycle-state'
      | 'stale-trash-preview'
      | 'trash-not-ready'
      | 'invalid-transition'
      | 'lifecycle-write-failed',
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionLifecycleError';
  }
}

export class SimulatedLifecycleInterruption extends Error {
  constructor(message = 'Synthetic lifecycle interruption') {
    super(message);
    this.name = 'SimulatedLifecycleInterruption';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function journalRoot(vaultPath: string): string {
  return path.join(vaultPath, '.fleet', 'lifecycle-journal');
}

function journalPath(vaultPath: string, operationId: string): string {
  return path.join(journalRoot(vaultPath), `${digest(operationId)}.json`);
}

async function writeJournal(vaultPath: string, journal: LifecycleJournal): Promise<string> {
  const parsed = lifecycleJournalSchema.parse({ ...journal, updatedAt: new Date().toISOString() });
  const finalPath = journalPath(vaultPath, parsed.operationId);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function writeTrashEmptyJournal(vaultPath: string, journal: TrashEmptyJournal): Promise<string> {
  const parsed = trashEmptyJournalSchema.parse({ ...journal, updatedAt: new Date().toISOString() });
  const finalPath = journalPath(vaultPath, parsed.operationId);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function restoreObjectPaths(vaultPath: string, objectPaths: string[]): Promise<void> {
  for (let offset = 0; offset < objectPaths.length; offset += 100) {
    await runGitText(vaultPath, [
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ...objectPaths.slice(offset, offset + 100),
    ]);
  }
}

async function resetEventIndex(vaultPath: string, eventPath: string): Promise<void> {
  await runGitText(vaultPath, ['reset', 'HEAD', '--', eventPath]).catch(() => undefined);
}

async function cleanupLifecycleStaging(vaultPath: string): Promise<void> {
  const root = path.join(vaultPath, '.fleet', 'lifecycle-staging');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true })));
}

async function recoverLifecycleTransactionsUnlocked(vaultPath: string): Promise<string[]> {
  await assertSessionVaultIdentity(vaultPath);
  let entries;
  try {
    entries = await readdir(journalRoot(vaultPath), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await cleanupLifecycleStaging(vaultPath);
      return [];
    }
    throw error;
  }
  const recovered: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(journalRoot(vaultPath), entry.name);
    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      await rm(filePath, { force: true });
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      throw new SessionLifecycleError('lifecycle-write-failed', '生命周期恢复 journal 中出现了未知文件，已停止自动恢复');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      throw new SessionLifecycleError('lifecycle-write-failed', '生命周期恢复 journal 已损坏，已停止自动恢复并保留现场');
    }
    const eventJournal = lifecycleJournalSchema.safeParse(raw);
    const trashJournal = trashEmptyJournalSchema.safeParse(raw);
    if (eventJournal.success) {
      if (entry.name !== path.basename(journalPath(vaultPath, eventJournal.data.operationId))) {
        throw new SessionLifecycleError('lifecycle-write-failed', '生命周期恢复 journal 身份不匹配，已停止自动恢复并保留现场');
      }
      const tracked = await sessionVaultPathTrackedAtHead(vaultPath, eventJournal.data.eventPath);
      if (!tracked) {
        await resetEventIndex(vaultPath, eventJournal.data.eventPath);
        await rm(path.join(vaultPath, eventJournal.data.eventPath), { force: true });
      }
      await rm(path.join(vaultPath, eventJournal.data.temporaryPath), { force: true });
      recovered.push(eventJournal.data.operationId);
    } else if (trashJournal.success) {
      if (entry.name !== path.basename(journalPath(vaultPath, trashJournal.data.operationId))) {
        throw new SessionLifecycleError('lifecycle-write-failed', '生命周期恢复 journal 身份不匹配，已停止自动恢复并保留现场');
      }
      const currentHead = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
      const currentPayloadObjects = currentHead
        ? await readSessionPayloadObjectsAtHead(vaultPath, currentHead)
        : new Map<string, { bytes: number; files: number }>();
      const deletionCommitted = currentHead !== trashJournal.data.preMutationHead && trashJournal.data.objectPaths.every(
        (objectPath) => !currentPayloadObjects.has(objectPath.slice('objects/'.length)),
      );
      if (!deletionCommitted) await restoreObjectPaths(vaultPath, trashJournal.data.objectPaths);
      recovered.push(trashJournal.data.operationId);
    } else {
      throw new SessionLifecycleError('lifecycle-write-failed', '生命周期恢复 journal 已损坏，已停止自动恢复并保留现场');
    }
    await rm(filePath, { force: true });
  }
  await cleanupLifecycleStaging(vaultPath);
  return recovered;
}

export async function recoverLifecycleTransactions(vaultPathInput: string): Promise<string[]> {
  const vaultPath = await realpath(path.resolve(vaultPathInput));
  return withSessionVaultLock(vaultPath, () => recoverLifecycleTransactionsUnlocked(vaultPath));
}

/** Caller must already hold the Session Vault lock. */
export async function recoverLifecycleTransactionsWithinLock(vaultPath: string): Promise<string[]> {
  return recoverLifecycleTransactionsUnlocked(vaultPath);
}

function machineName(options: SessionLifecycleOptions): string {
  return (options.machine ?? process.env.GIT_FLEET_MACHINE ?? os.hostname()).trim().slice(0, 255) || 'machine';
}

async function assertNoKnownRemoteLifecycleConflict(
  vaultPath: string,
  binding: SessionVaultBinding,
  localHead: string | null,
): Promise<void> {
  if (
    !binding.remoteSyncEnabled ||
    binding.privacyState !== 'private-user-confirmed' ||
    !binding.remoteName
  ) return;
  if (!/^[A-Za-z0-9._-]+$/.test(binding.remoteName)) {
    throw new SessionLifecycleError('lifecycle-write-failed', 'Session Vault remote 名称不安全，请重新绑定');
  }
  const remoteHead = await runGitText(vaultPath, [
    'rev-parse',
    '--verify',
    `refs/remotes/${binding.remoteName}/main^{commit}`,
  ]).catch(() => '');
  if (!remoteHead) return;
  if (!localHead) {
    throw new SessionLifecycleError(
      'remote-update-required',
      'Session Vault 已知远端已有内容，请先拉取更新后再管理会话',
    );
  }
  const output = await runGitText(vaultPath, [
    'rev-list',
    '--left-right',
    '--count',
    `${localHead}...${remoteHead}`,
  ]);
  const [aheadText = '0', behindText = '0'] = output.split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10) || 0;
  const behind = Number.parseInt(behindText, 10) || 0;
  if (behind === 0) return;
  throw new SessionLifecycleError(
    'remote-update-required',
    ahead > 0
      ? 'Session Vault 本机与已知远端已经分叉，请先解决同步状态后再管理会话'
      : 'Session Vault 已知远端有新提交，请先拉取更新后再管理会话',
  );
}

const trashHistoryWarning = '清空只会从当前 Vault 工作树移除到期交接对象；Git 历史、远端历史或备份中仍可能保留旧内容。';

interface TrashEmptyPlan {
  preview: SessionTrashEmptyPreview;
  objectPaths: string[];
  removedSessionIds: string[];
}

async function knownRemoteTrashBlocker(
  vaultPath: string,
  binding: SessionVaultBinding,
  localHead: string,
): Promise<string | null> {
  if (!binding.remoteSyncEnabled) return null;
  if (binding.privacyState !== 'private-user-confirmed' || !binding.remoteName) {
    return '远端隐私状态尚未确认，不能清空可能尚未同步到其他设备的废纸篓';
  }
  if (!/^[A-Za-z0-9._-]+$/.test(binding.remoteName)) return 'Session Vault remote 名称不安全，请重新绑定';
  const remoteHead = await runGitText(vaultPath, [
    'rev-parse',
    '--verify',
    `refs/remotes/${binding.remoteName}/main^{commit}`,
  ]).catch(() => '');
  if (!remoteHead) return '尚未建立远端同步基线，请先 Push 并让其他设备 Pull 后再清空';
  const output = await runGitText(vaultPath, ['rev-list', '--left-right', '--count', `${localHead}...${remoteHead}`]);
  const [aheadText = '0', behindText = '0'] = output.split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10) || 0;
  const behind = Number.parseInt(behindText, 10) || 0;
  if (behind > 0) return ahead > 0
    ? '本机与远端已经分叉，请先解决同步状态后再清空废纸篓'
    : '远端存在尚未拉取的提交，请先拉取更新后再清空废纸篓';
  if (ahead > 0) return '本机仍有尚未 Push 的生命周期事件，请先同步到远端后再清空废纸篓';
  return null;
}

async function buildTrashEmptyPlan(
  vaultPath: string,
  binding: SessionVaultBinding,
  head: string,
  now: Date,
): Promise<TrashEmptyPlan> {
  const [events, payloadObjects, status] = await Promise.all([
    readSessionEventsAtHead(vaultPath, head),
    readSessionPayloadObjectsAtHead(vaultPath, head),
    runGit(vaultPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const catalog = deriveSessionCatalog(events, payloadObjects);
  const trashed = catalog.items.filter((item) => item.lifecycleState === 'trashed');
  const retainedPayloads = trashed.filter((item) => item.payloadState !== 'purged');
  const forked = retainedPayloads.filter((item) => item.forked);
  const deletionConflicts = retainedPayloads.filter((item) => item.deletionConflict);
  const blockedSessionIds = new Set([
    ...forked.map((item) => item.sessionId),
    ...deletionConflicts.map((item) => item.sessionId),
  ]);
  const expired = retainedPayloads.filter((item) => {
    const retentionTimestamp = Date.parse(item.retentionUntil ?? '');
    return Number.isFinite(retentionTimestamp) && retentionTimestamp <= now.getTime() && !blockedSessionIds.has(item.sessionId);
  });
  const objectPaths = [...new Set(expired.flatMap((item) =>
    (catalog.checkpoints.get(item.sessionId) ?? [])
      .filter((checkpoint) => payloadObjects.has(checkpoint.checkpointId))
      .map((checkpoint) => checkpoint.payloadPath),
  ))].sort();
  const removableBytes = objectPaths.reduce((total, objectPath) => {
    const checkpointId = objectPath.slice('objects/'.length);
    return total + (payloadObjects.get(checkpointId)?.bytes ?? 0);
  }, 0);
  const blockers: string[] = [];
  if (status.exitCode !== 0) blockers.push('无法确认 Session Vault 工作区状态');
  else if (status.stdout.byteLength > 0) blockers.push('Session Vault 工作区存在未处理变更，请先恢复干净状态');
  const remoteBlocker = await knownRemoteTrashBlocker(vaultPath, binding, head);
  if (remoteBlocker) blockers.push(remoteBlocker);
  if (forked.length > 0) blockers.push(`有 ${forked.length} 条废纸篓会话仍有多个活跃 checkpoint head，请先合并、选择或拆分`);
  if (deletionConflicts.length > 0) blockers.push(`有 ${deletionConflicts.length} 条已删除会话产生了新内容，请先恢复或另存为新会话`);
  if (objectPaths.length === 0) blockers.push('当前没有已满 30 天且仍保留交接对象的废纸篓会话');
  const fingerprint = digest(JSON.stringify({
    head,
    sessions: expired.map((item) => [item.sessionId, item.lifecycleVersion, item.retentionUntil]),
    forkedSessions: forked.map((item) => [item.sessionId, item.headCheckpointIds]),
    deletionConflicts: deletionConflicts.map((item) => [item.sessionId, item.deletionConflictCheckpointIds]),
    objectPaths,
    removableBytes,
  }));
  return {
    preview: sessionTrashEmptyPreviewSchema.parse({
      schemaVersion: 1,
      fingerprint,
      generatedAt: now.toISOString(),
      totalTrashed: trashed.length,
      eligibleSessions: expired.length,
      retainedSessions: trashed.length - expired.length,
      forkedSessions: forked.length,
      deletionConflictSessions: deletionConflicts.length,
      removableObjects: objectPaths.length,
      removableBytes,
      syncReady: !remoteBlocker,
      syncMessage: remoteBlocker ?? (binding.remoteSyncEnabled
        ? '远端同步基线与本机一致，可以安全提交当前对象删除'
        : '仅本机 Vault，无跨设备同步阻塞'),
      canEmpty: blockers.length === 0 && objectPaths.length > 0,
      blockers,
      historyWarning: trashHistoryWarning,
    }),
    objectPaths,
    removedSessionIds: expired.map((item) => item.sessionId),
  };
}

export async function previewSessionTrashEmpty(
  options: SessionLifecycleOptions = {},
): Promise<SessionTrashEmptyPreview> {
  const vaultStatus = await loadSessionVaultStatus(options);
  if (!vaultStatus.configured || !vaultStatus.binding) {
    throw new SessionLifecycleError('vault-not-configured', 'Session Vault 尚未初始化');
  }
  const vaultPath = await realpath(vaultStatus.binding.vaultPath);
  const head = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
  if (!head) throw new SessionLifecycleError('vault-empty', 'Session Vault 中尚无可清理的会话', 404);
  return (await buildTrashEmptyPlan(vaultPath, vaultStatus.binding, head, options.now ?? new Date())).preview;
}

function transitionMessage(action: LifecycleAction): string {
  return {
    pin: '会话已置顶，生命周期事件已保存到本机 Vault',
    unpin: '会话已取消置顶，生命周期事件已保存到本机 Vault',
    archive: '会话已归档，仍可在“已归档”或“全部”中恢复',
    restore: '会话已恢复到活跃列表',
    trash: '会话已移入废纸篓，默认保留 30 天；provider 原始会话与项目源码未受影响',
    untrash: '会话已从废纸篓恢复，checkpoint 内容保持不变',
    'resolve-trash-conflict': '已确认删除后产生的新内容已另存；原会话继续留在废纸篓',
  }[action];
}

function trashRetentionUntil(now: Date, options: SessionLifecycleOptions): string {
  const configured = options.trashRetentionDays ?? 30;
  const days = Number.isFinite(configured) ? Math.min(3_650, Math.max(1, Math.trunc(configured))) : 30;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

function auditErrorCode(error: unknown): string {
  if (error instanceof SessionLifecycleError) return error.code;
  if (error instanceof SessionLifecycleStateError) return 'invalid-transition';
  if (error instanceof SessionEventStoreError) return 'invalid-vault-event';
  return 'unexpected-error';
}

export async function mutateSessionLifecycle(
  sessionId: string,
  action: LifecycleAction,
  expectedLifecycleVersion: string | null,
  options: SessionLifecycleOptions = {},
): Promise<SessionLifecycleMutationResult> {
  const operationId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let event: LifecycleEvent | null = null;
  let eventIdForAudit: string | null = null;
  let result: SessionLifecycleMutationResult | null = null;
  let caught: unknown = null;

  try {
    const vaultStatus = await loadSessionVaultStatus(options);
    if (!vaultStatus.configured || !vaultStatus.binding) {
      throw new SessionLifecycleError('vault-not-configured', 'Session Vault 尚未初始化');
    }
    const vaultPath = await realpath(vaultStatus.binding.vaultPath);
    result = await withSessionVaultLock(vaultPath, async () => {
      await recoverCheckpointTransactionsWithinLock(vaultPath);
      await recoverLifecycleTransactionsUnlocked(vaultPath);
      await assertSessionVaultWriteReady(vaultPath, false);
      const preMutationHead = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
      await assertNoKnownRemoteLifecycleConflict(vaultPath, vaultStatus.binding!, preMutationHead || null);
      if (!preMutationHead) throw new SessionLifecycleError('vault-empty', 'Session Vault 中尚无可管理的会话', 404);
      let events;
      try {
        events = await readSessionEventsAtHead(vaultPath, preMutationHead);
      } catch (error) {
        if (error instanceof SessionEventStoreError) throw new SessionLifecycleError('lifecycle-write-failed', error.message);
        throw error;
      }
      const current = deriveSessionLifecycleStates(events).get(sessionId);
      if (!current) throw new SessionLifecycleError('session-not-found', 'Session Vault 会话不存在', 404);
      if (current.version !== expectedLifecycleVersion) {
        throw new SessionLifecycleError('stale-lifecycle-state', '会话生命周期状态已经变化，请刷新列表后重试');
      }
      if (action === 'untrash') {
        const payloadObjects = await readSessionPayloadObjectsAtHead(vaultPath, preMutationHead);
        const session = deriveSessionCatalog(events, payloadObjects).items.find((item) => item.sessionId === sessionId);
        if (!session || session.payloadState !== 'available') {
          throw new SessionLifecycleError(
            'invalid-transition',
            '当前 Vault 的交接对象已经清理，不能直接恢复；请从 Git 历史或备份人工找回后再操作',
          );
        }
      }

      const now = options.now ?? new Date();
      const createdAt = now.toISOString();
      const eventId = randomUUID();
      eventIdForAudit = eventId;
      const machine = machineName(options);
      event = lifecycleEventSchema.parse({
        schemaVersion: 1,
        eventType: 'lifecycle',
        eventId,
        sessionId,
        action,
        machine,
        createdAt,
        retentionUntil: action === 'trash' ? trashRetentionUntil(now, options) : null,
        resolvedCheckpointIds: action === 'resolve-trash-conflict' ? options.resolvedCheckpointIds : undefined,
        reason: action === 'trash'
          ? '用户手动移入废纸篓'
          : action === 'untrash'
            ? '用户手动恢复废纸篓会话'
            : action === 'resolve-trash-conflict'
              ? '用户已将删除后产生的新内容另存为独立会话'
            : null,
      });
      try {
        applyLifecycleEvent(current, event);
      } catch (error) {
        if (error instanceof SessionLifecycleStateError) {
          throw new SessionLifecycleError('invalid-transition', error.message);
        }
        throw error;
      }
      const eventContent = `${JSON.stringify(event, null, 2)}\n`;
      assertNoSecrets([{ path: 'lifecycle-event.json', content: eventContent }]);

      const machineDirectory = sessionEventMachineSegment(machine);
      const relativeEventPath = path.posix.join('events', machineDirectory, `${eventId}.json`);
      const relativeTemporaryPath = path.posix.join('.fleet', 'lifecycle-staging', `${operationId}.event.tmp`);
      const eventPath = path.join(vaultPath, relativeEventPath);
      const temporaryPath = path.join(vaultPath, relativeTemporaryPath);
      let journal: LifecycleJournal = {
        schemaVersion: 1,
        operationId,
        eventId,
        eventPath: relativeEventPath,
        temporaryPath: relativeTemporaryPath,
        phase: 'prepared',
        preMutationHead,
        updatedAt: new Date().toISOString(),
      };
      let activeJournalPath = await writeJournal(vaultPath, journal);
      try {
        await Promise.all([
          mkdir(path.dirname(eventPath), { recursive: true, mode: 0o700 }),
          mkdir(path.dirname(temporaryPath), { recursive: true, mode: 0o700 }),
        ]);
        await writeFile(temporaryPath, eventContent, { mode: 0o600, flag: 'wx' });
        await rename(temporaryPath, eventPath);
        journal = { ...journal, phase: 'event-published' };
        activeJournalPath = await writeJournal(vaultPath, journal);
        await options.testHook?.('after-event-publish', eventPath);

        await stageSessionVaultPaths(vaultPath, [relativeEventPath]);
        journal = { ...journal, phase: 'index-staged' };
        activeJournalPath = await writeJournal(vaultPath, journal);
        await options.testHook?.('after-index-stage', vaultPath);
        await runGitText(vaultPath, [
          '-c',
          'user.name=Moo Fleet',
          '-c',
          'user.email=moo-fleet@localhost',
          'commit',
          '-m',
          `lifecycle: ${action} ${hashSessionAuditId(sessionId).slice(0, 12)}`,
        ]);
        journal = { ...journal, phase: 'committed' };
        activeJournalPath = await writeJournal(vaultPath, journal);
        const commitHash = await runGitText(vaultPath, ['rev-parse', 'HEAD']);
        await assertSessionVaultClean(vaultPath, '生命周期事件');
        const parsed = sessionLifecycleMutationResultSchema.parse({
          schemaVersion: 1,
          event,
          commitHash,
          auditRecorded: true,
          message: transitionMessage(action),
        });
        await rm(activeJournalPath, { force: true });
        return parsed;
      } catch (error) {
        if (!(error instanceof SimulatedLifecycleInterruption)) {
          await recoverLifecycleTransactionsUnlocked(vaultPath).catch(() => undefined);
        }
        throw error;
      }
    });
  } catch (error) {
    caught = error;
  }

  const finishedAt = new Date().toISOString();
  const auditRecord = {
    schemaVersion: 1 as const,
    operationId,
    category: 'session-lifecycle' as const,
    action,
    result: caught ? 'failed' as const : 'success' as const,
    sessionIdHash: hashSessionAuditId(sessionId),
    eventId: eventIdForAudit,
    commitHash: result?.commitHash ?? null,
    errorCode: caught ? auditErrorCode(caught) : null,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  };
  try {
    await appendSessionOperationAudit(auditRecord, options);
  } catch {
    if (!caught && result) {
      result = sessionLifecycleMutationResultSchema.parse({
        ...result,
        auditRecorded: false,
        message: `${result.message}；但本地审计日志写入失败，请检查应用数据目录权限`,
      });
    }
  }
  if (caught) throw caught;
  if (!result) throw new SessionLifecycleError('lifecycle-write-failed', '生命周期事件未完成', 500);
  return result;
}

async function stageRemovedObjectPaths(vaultPath: string, objectPaths: string[]): Promise<void> {
  for (let offset = 0; offset < objectPaths.length; offset += 100) {
    await runGitText(vaultPath, ['add', '-A', '--', ...objectPaths.slice(offset, offset + 100)]);
  }
  const expectedIds = new Set(objectPaths.map((objectPath) => objectPath.slice('objects/'.length)));
  const staged = await runGit(vaultPath, ['diff', '--cached', '--name-only', '-z']);
  if (staged.exitCode !== 0) throw new SessionLifecycleError('lifecycle-write-failed', '无法校验废纸篓清理暂存区');
  const names = staged.stdout.toString('utf8').split('\0').filter(Boolean);
  if (names.length === 0) throw new SessionLifecycleError('trash-not-ready', '废纸篓清理没有产生可提交的对象删除');
  const unexpected = names.filter((name) => {
    const match = name.match(/^objects\/([a-f0-9]{64})\//);
    return !match?.[1] || !expectedIds.has(match[1]);
  });
  if (unexpected.length > 0) {
    throw new SessionLifecycleError('lifecycle-write-failed', '废纸篓清理暂存区出现非本次操作文件，已停止提交');
  }
}

export async function emptySessionTrash(
  request: SessionTrashEmptyRequest,
  options: SessionLifecycleOptions = {},
): Promise<SessionTrashEmptyResult> {
  const input = sessionTrashEmptyRequestSchema.parse(request);
  const operationId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let result: SessionTrashEmptyResult | null = null;
  let caught: unknown = null;

  try {
    const vaultStatus = await loadSessionVaultStatus(options);
    if (!vaultStatus.configured || !vaultStatus.binding) {
      throw new SessionLifecycleError('vault-not-configured', 'Session Vault 尚未初始化');
    }
    const vaultPath = await realpath(vaultStatus.binding.vaultPath);
    result = await withSessionVaultLock(vaultPath, async () => {
      await recoverCheckpointTransactionsWithinLock(vaultPath);
      await recoverLifecycleTransactionsUnlocked(vaultPath);
      await assertSessionVaultWriteReady(vaultPath, false);
      if (vaultStatus.binding!.remoteSyncEnabled) {
        const remoteName = vaultStatus.binding!.remoteName;
        if (!remoteName || !/^[A-Za-z0-9._-]+$/.test(remoteName)) {
          throw new SessionLifecycleError('trash-not-ready', 'Session Vault remote 配置无效，已停止清空');
        }
        try {
          await runGitText(vaultPath, ['fetch', '--prune', remoteName], 60_000);
        } catch {
          throw new SessionLifecycleError('trash-not-ready', '无法刷新 Session Vault 远端状态，已停止清空以避免其他设备丢失恢复入口');
        }
      }
      const preMutationHead = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
      if (!preMutationHead) throw new SessionLifecycleError('vault-empty', 'Session Vault 中尚无可清理的会话', 404);
      const plan = await buildTrashEmptyPlan(vaultPath, vaultStatus.binding!, preMutationHead, options.now ?? new Date());
      if (plan.preview.fingerprint !== input.expectedFingerprint) {
        throw new SessionLifecycleError('stale-trash-preview', '废纸篓内容或同步状态已经变化，请重新查看清理预览');
      }
      if (!plan.preview.canEmpty) {
        throw new SessionLifecycleError('trash-not-ready', plan.preview.blockers[0] ?? '当前废纸篓不能安全清空');
      }
      let journal: TrashEmptyJournal = {
        schemaVersion: 1,
        operationId,
        operationType: 'trash-empty',
        objectPaths: plan.objectPaths,
        phase: 'prepared',
        preMutationHead,
        updatedAt: new Date().toISOString(),
      };
      let activeJournalPath = await writeTrashEmptyJournal(vaultPath, journal);
      try {
        await Promise.all(plan.objectPaths.map((objectPath) =>
          rm(path.join(vaultPath, objectPath), { recursive: true, force: true }),
        ));
        journal = { ...journal, phase: 'objects-removed' };
        activeJournalPath = await writeTrashEmptyJournal(vaultPath, journal);
        await options.testHook?.('after-trash-objects-removed', vaultPath);

        await stageRemovedObjectPaths(vaultPath, plan.objectPaths);
        journal = { ...journal, phase: 'index-staged' };
        activeJournalPath = await writeTrashEmptyJournal(vaultPath, journal);
        await options.testHook?.('after-trash-index-stage', vaultPath);
        await runGitText(vaultPath, [
          '-c',
          'user.name=Moo Fleet',
          '-c',
          'user.email=moo-fleet@localhost',
          'commit',
          '-m',
          `trash: empty ${plan.removedSessionIds.length} expired sessions`,
        ]);
        journal = { ...journal, phase: 'committed' };
        activeJournalPath = await writeTrashEmptyJournal(vaultPath, journal);
        const commitHash = await runGitText(vaultPath, ['rev-parse', 'HEAD']);
        await assertSessionVaultClean(vaultPath, '废纸篓清理');
        await rm(activeJournalPath, { force: true });
        return sessionTrashEmptyResultSchema.parse({
          schemaVersion: 1,
          removedSessions: plan.removedSessionIds.length,
          removedObjects: plan.objectPaths.length,
          removedBytes: plan.preview.removableBytes,
          commitHash,
          auditRecorded: true,
          message: `已从当前 Vault 移除 ${plan.objectPaths.length} 个到期交接对象；Git 历史仍可能保留旧内容`,
        });
      } catch (error) {
        if (!(error instanceof SimulatedLifecycleInterruption)) {
          await recoverLifecycleTransactionsUnlocked(vaultPath).catch(() => undefined);
        }
        throw error;
      }
    });
  } catch (error) {
    caught = error;
  }

  try {
    await appendSessionOperationAudit({
      schemaVersion: 1,
      operationId,
      category: 'session-trash',
      action: 'empty',
      result: caught ? 'failed' : 'success',
      sessionIdHash: hashSessionAuditId(`trash-empty:${input.expectedFingerprint}`),
      eventId: null,
      commitHash: result?.commitHash ?? null,
      errorCode: caught ? auditErrorCode(caught) : null,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    }, options);
  } catch {
    if (!caught && result) {
      result = sessionTrashEmptyResultSchema.parse({
        ...result,
        auditRecorded: false,
        message: `${result.message}；但本地审计日志写入失败，请检查应用数据目录权限`,
      });
    }
  }
  if (caught) throw caught;
  if (!result) throw new SessionLifecycleError('lifecycle-write-failed', '废纸篓清理未完成', 500);
  return result;
}
