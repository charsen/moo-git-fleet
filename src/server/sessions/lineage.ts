import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  SessionForkResolutionResult,
  SessionLineageAction,
  SessionLineageEvent,
} from '../../shared/sessions.js';
import {
  sessionForkResolutionResultSchema,
  sessionLineageEventSchema,
} from '../../shared/sessions.js';
import { runGitText } from '../git/runner.js';
import { recoverCheckpointTransactionsWithinLock } from './checkpoint.js';
import { readSessionEventsAtHead, SessionEventStoreError } from './event-store.js';
import { recoverLifecycleTransactionsWithinLock } from './lifecycle.js';
import { deriveSessionLineageStates, SessionLineageStateError } from './lineage-state.js';
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

const lineageJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  eventId: z.string().uuid(),
  eventPath: z.string().regex(/^events\/[a-z0-9-]+-[a-f0-9]{8}\/[0-9a-f-]{36}\.json$/),
  temporaryPath: z.string().regex(/^\.fleet\/lineage-staging\/[0-9a-f-]{36}\.event\.tmp$/),
  phase: z.enum(['prepared', 'event-published', 'index-staged', 'committed']),
  preMutationHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type LineageJournal = z.infer<typeof lineageJournalSchema>;

export interface AppendSessionLineageInput {
  sessionId: string;
  action: SessionLineageAction;
  expectedHeadCheckpointIds: string[];
  selectedHeadCheckpointId: string;
  splitSessions?: SessionLineageEvent['splitSessions'];
}

export interface SessionLineageOptions extends SessionVaultServiceOptions {
  machine?: string;
  testHook?: (phase: 'after-event-publish' | 'after-index-stage', path: string) => void | Promise<void>;
}

export class SessionLineageError extends Error {
  constructor(
    readonly code:
      | 'vault-not-configured'
      | 'vault-empty'
      | 'session-not-forked'
      | 'stale-fork-state'
      | 'lineage-write-failed',
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionLineageError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function journalRoot(vaultPath: string): string {
  return path.join(vaultPath, '.fleet', 'lineage-journal');
}

function journalPath(vaultPath: string, operationId: string): string {
  return path.join(journalRoot(vaultPath), `${digest(operationId)}.json`);
}

async function writeJournal(vaultPath: string, journal: LineageJournal): Promise<string> {
  const parsed = lineageJournalSchema.parse({ ...journal, updatedAt: new Date().toISOString() });
  const finalPath = journalPath(vaultPath, parsed.operationId);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function cleanupLineageStaging(vaultPath: string): Promise<void> {
  const root = path.join(vaultPath, '.fleet', 'lineage-staging');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true })));
}

async function recoverLineageTransactionsUnlocked(vaultPath: string): Promise<string[]> {
  await assertSessionVaultIdentity(vaultPath);
  let entries;
  try {
    entries = await readdir(journalRoot(vaultPath), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await cleanupLineageStaging(vaultPath);
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
      throw new SessionLineageError('lineage-write-failed', 'lineage 恢复 journal 中出现未知文件，已停止自动恢复');
    }
    let journal: LineageJournal;
    try {
      journal = lineageJournalSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
    } catch {
      throw new SessionLineageError('lineage-write-failed', 'lineage 恢复 journal 已损坏，已保留现场');
    }
    if (entry.name !== path.basename(journalPath(vaultPath, journal.operationId))) {
      throw new SessionLineageError('lineage-write-failed', 'lineage 恢复 journal 身份不匹配，已保留现场');
    }
    const tracked = await sessionVaultPathTrackedAtHead(vaultPath, journal.eventPath);
    if (!tracked) {
      await runGitText(vaultPath, ['reset', 'HEAD', '--', journal.eventPath]).catch(() => undefined);
      await rm(path.join(vaultPath, journal.eventPath), { force: true });
    }
    await rm(path.join(vaultPath, journal.temporaryPath), { force: true });
    await rm(filePath, { force: true });
    recovered.push(journal.operationId);
  }
  await cleanupLineageStaging(vaultPath);
  return recovered;
}

export async function recoverLineageTransactions(vaultPathInput: string): Promise<string[]> {
  const vaultPath = await realpath(path.resolve(vaultPathInput));
  return withSessionVaultLock(vaultPath, () => recoverLineageTransactionsUnlocked(vaultPath));
}

/** Caller must already hold the Session Vault lock. */
export async function recoverLineageTransactionsWithinLock(vaultPath: string): Promise<string[]> {
  return recoverLineageTransactionsUnlocked(vaultPath);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export async function appendSessionLineageResolution(
  input: AppendSessionLineageInput,
  options: SessionLineageOptions = {},
): Promise<SessionForkResolutionResult> {
  const vaultStatus = await loadSessionVaultStatus(options);
  if (!vaultStatus.configured || !vaultStatus.binding) {
    throw new SessionLineageError('vault-not-configured', 'Session Vault 尚未初始化');
  }
  const vaultPath = await realpath(vaultStatus.binding.vaultPath);
  return withSessionVaultLock(vaultPath, async () => {
    await recoverCheckpointTransactionsWithinLock(vaultPath);
    await recoverLifecycleTransactionsWithinLock(vaultPath);
    await recoverLineageTransactionsUnlocked(vaultPath);
    await assertSessionVaultWriteReady(vaultPath, false);
    const preMutationHead = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '');
    if (!preMutationHead) throw new SessionLineageError('vault-empty', 'Session Vault 中尚无可处理的会话', 404);
    let events;
    try {
      events = await readSessionEventsAtHead(vaultPath, preMutationHead);
    } catch (error) {
      if (error instanceof SessionEventStoreError) throw new SessionLineageError('lineage-write-failed', error.message);
      throw error;
    }
    const lineage = deriveSessionLineageStates(events).get(input.sessionId);
    if (!lineage) throw new SessionLineageError('session-not-forked', 'Session Vault 会话不存在', 404);
    if (lineage.headCheckpointIds.length < 2) {
      throw new SessionLineageError('session-not-forked', '当前会话已经不是分叉状态，请刷新详情后继续');
    }
    const expectedHeads = sortedUnique(input.expectedHeadCheckpointIds);
    if (
      expectedHeads.length !== input.expectedHeadCheckpointIds.length ||
      expectedHeads.join('\0') !== [...lineage.headCheckpointIds].sort().join('\0')
    ) {
      throw new SessionLineageError('stale-fork-state', '会话分叉 head 已变化，请刷新详情后重新确认');
    }
    if (!expectedHeads.includes(input.selectedHeadCheckpointId)) {
      throw new SessionLineageError('stale-fork-state', '所选 checkpoint 已不是当前会话 head');
    }

    const eventId = randomUUID();
    const operationId = randomUUID();
    const machine = (options.machine ?? process.env.GIT_FLEET_MACHINE ?? os.hostname()).trim().slice(0, 255) || 'machine';
    const event = sessionLineageEventSchema.parse({
      schemaVersion: 1,
      eventType: 'lineage',
      eventId,
      sessionId: input.sessionId,
      action: input.action,
      expectedResolutionVersion: lineage.resolutionVersion,
      expectedHeadCheckpointIds: expectedHeads,
      selectedHeadCheckpointId: input.selectedHeadCheckpointId,
      discardedHeadCheckpointIds: expectedHeads.filter((checkpointId) => checkpointId !== input.selectedHeadCheckpointId),
      splitSessions: input.splitSessions ?? [],
      machine,
      createdAt: (options.now ?? new Date()).toISOString(),
    });
    try {
      deriveSessionLineageStates([...events, event]);
    } catch (error) {
      if (error instanceof SessionLineageStateError) {
        throw new SessionLineageError('stale-fork-state', error.message);
      }
      throw error;
    }
    const eventContent = `${JSON.stringify(event, null, 2)}\n`;
    assertNoSecrets([{ path: 'lineage-event.json', content: eventContent }]);
    const machineDirectory = sessionEventMachineSegment(machine);
    const relativeEventPath = path.posix.join('events', machineDirectory, `${eventId}.json`);
    const relativeTemporaryPath = path.posix.join('.fleet', 'lineage-staging', `${operationId}.event.tmp`);
    const eventPath = path.join(vaultPath, relativeEventPath);
    const temporaryPath = path.join(vaultPath, relativeTemporaryPath);
    let journal: LineageJournal = {
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
        `lineage: ${input.action} ${digest(input.sessionId).slice(0, 12)}`,
      ]);
      journal = { ...journal, phase: 'committed' };
      activeJournalPath = await writeJournal(vaultPath, journal);
      const commitHash = await runGitText(vaultPath, ['rev-parse', 'HEAD']);
      await assertSessionVaultClean(vaultPath, 'lineage 事件');
      await rm(activeJournalPath, { force: true });
      return sessionForkResolutionResultSchema.parse({
        schemaVersion: 1,
        event,
        commitHash,
        message: input.action === 'split'
          ? '会话分支已拆分为独立逻辑会话，原始 lineage 仍完整保留'
          : '已记录继续使用的会话 head；被搁置分支仍保留在历史中',
      });
    } catch (error) {
      await recoverLineageTransactionsUnlocked(vaultPath).catch(() => undefined);
      throw error;
    }
  });
}
