import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  Checkpoint,
  CheckpointCapabilities,
  CheckpointCaptureProgress,
  CheckpointCaptureResult,
  DiscoveredSession,
  HandoffSummary,
  WorkspaceSnapshot,
} from '../../shared/sessions.js';
import {
  checkpointCaptureProgressSchema,
  checkpointCaptureResultSchema,
  checkpointSchema,
  handoffSummarySchema,
  workspaceSnapshotSchema,
} from '../../shared/sessions.js';
import { runGit, runGitText, runGitWithEnvironment } from '../git/runner.js';
import { parsePorcelainV2 } from '../git/scanner.js';
import { readSessionEventsAtHead, SessionEventStoreError } from './event-store.js';
import { assertNoSecrets, type SecretScanFile } from './secrets.js';
import { deriveSessionLineageStates } from './lineage-state.js';
import { withSessionVaultLock } from './vault-lock.js';
import {
  assertSessionVaultClean,
  assertSessionVaultIdentity,
  assertSessionVaultWriteReady,
  sessionEventMachineSegment,
  sessionVaultPathTrackedAtHead,
  stageSessionVaultPaths,
} from './vault-write.js';

const stagingFiles = ['handoff.md', 'workspace.json', 'manifest.json'] as const;

export type CheckpointTestPhase =
  | 'after-final-scan'
  | 'after-object-publish'
  | 'after-event-publish'
  | 'after-index-stage'
  | 'after-commit';

const checkpointJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1).max(255),
  checkpointId: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['staging-written', 'object-published', 'event-published', 'index-staged', 'committed']),
  stagingPath: z.string().regex(/^\.fleet\/staging\/[A-Za-z0-9._-]+$/),
  objectPath: z.string().regex(/^objects\/[a-f0-9]{64}$/),
  eventPath: z.string().regex(/^events\/[a-z0-9-]+-[a-f0-9]{8}\/[0-9a-f-]{36}\.json$/),
  preCaptureHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type CheckpointJournal = z.infer<typeof checkpointJournalSchema>;

export interface CaptureCheckpointInput {
  vaultPath: string;
  operationId?: string;
  sessionId: string;
  session: Pick<
    DiscoveredSession,
    'provider' | 'providerSessionId' | 'projectId' | 'repositoryId' | 'repositoryName' | 'title'
  >;
  summary: HandoffSummary;
  workspace: WorkspaceSnapshot;
  parentCheckpointIds?: string[];
  expectedHeadCheckpointIds?: string[];
  resumedFromCheckpointId?: string | null;
  splitFromCheckpointId?: string | null;
  machine: string;
  capabilities: CheckpointCapabilities;
  now?: Date;
  onProgress?: (progress: CheckpointCaptureProgress) => void | Promise<void>;
  testHook?: (phase: CheckpointTestPhase, stagingPath: string) => void | Promise<void>;
}

interface PayloadFiles {
  handoff: string;
  workspace: string;
  manifest: string;
}

export type CheckpointIdentityInput = Pick<
  CaptureCheckpointInput,
  | 'sessionId'
  | 'session'
  | 'summary'
  | 'workspace'
  | 'parentCheckpointIds'
  | 'resumedFromCheckpointId'
  | 'splitFromCheckpointId'
>;

export class CheckpointCaptureError extends Error {
  readonly statusCode = 409;
}

export class SimulatedCheckpointInterruption extends Error {
  constructor(message = 'Synthetic checkpoint interruption') {
    super(message);
    this.name = 'SimulatedCheckpointInterruption';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function markdownList(items: string[]): string {
  return items.length === 0 ? '- 无\n' : `${items.map((item) => `- ${item.replaceAll('\n', '\n  ')}`).join('\n')}\n`;
}

export function renderHandoffMarkdown(summary: HandoffSummary): string {
  return [
    '# AI 会话交接',
    '',
    '## 目标',
    '',
    summary.goal || '未填写',
    '',
    '## 已完成',
    '',
    markdownList(summary.completed).trimEnd(),
    '',
    '## 已确认决定',
    '',
    markdownList(summary.decisions).trimEnd(),
    '',
    '## 下一步',
    '',
    markdownList(summary.nextSteps).trimEnd(),
    '',
    '## 阻塞项',
    '',
    markdownList(summary.blockers).trimEnd(),
    '',
    '## 已验证命令',
    '',
    markdownList(summary.commands).trimEnd(),
    '',
    '## 风险与待复核',
    '',
    markdownList(summary.risks).trimEnd(),
    '',
    `摘要来源：${summary.source}`,
    `复核时间：${summary.reviewedAt ?? '未复核'}`,
    '',
  ].join('\n');
}

export async function captureWorkspaceSnapshot(
  repositoryPath: string,
  projectId: string,
  repositoryId: string | null,
): Promise<WorkspaceSnapshot> {
  const statusResult = await runGitWithEnvironment(
    repositoryPath,
    ['status', '--porcelain=v2', '--branch', '-z'],
    { GIT_OPTIONAL_LOCKS: '0' },
  );
  if (statusResult.exitCode !== 0) throw new CheckpointCaptureError(statusResult.stderr || '无法读取项目 Git 工作区状态');
  const parsed = parsePorcelainV2(statusResult.stdout);
  const head = await runGitText(repositoryPath, ['rev-parse', 'HEAD']).catch(() => null);
  return workspaceSnapshotSchema.parse({
    projectId,
    repositoryId,
    branch: parsed.branch,
    head,
    dirty: parsed.changedFiles > 0,
    changedFiles: parsed.changedFiles,
    stagedFiles: parsed.staged,
    modifiedFiles: parsed.modified,
    deletedFiles: parsed.deleted,
    renamedFiles: parsed.renamed,
    untrackedFiles: parsed.untracked,
  });
}

function payloadFiles(
  input: Pick<CaptureCheckpointInput, 'session' | 'summary' | 'workspace'>,
  createdAt: string,
): PayloadFiles {
  const summary = handoffSummarySchema.parse(input.summary);
  const workspace = workspaceSnapshotSchema.parse(input.workspace);
  return {
    handoff: renderHandoffMarkdown(summary),
    workspace: `${JSON.stringify(workspace, null, 2)}\n`,
    manifest: `${JSON.stringify(
      {
        schemaVersion: 1,
        provider: input.session.provider,
        providerSessionId: input.session.providerSessionId,
        summarySource: summary.source,
        reviewedAt: summary.reviewedAt,
        createdAt,
      },
      null,
      2,
    )}\n`,
  };
}

function payloadSecretFiles(files: PayloadFiles): SecretScanFile[] {
  return [
    { path: 'handoff.md', content: files.handoff },
    { path: 'workspace.json', content: files.workspace },
    { path: 'manifest.json', content: files.manifest },
  ];
}

function checkpointContentId(input: CheckpointIdentityInput, files: PayloadFiles, createdAt: string): string {
  return digest(
    JSON.stringify({
      sessionId: input.sessionId,
      provider: input.session.provider,
      providerSessionId: input.session.providerSessionId,
      parentCheckpointIds: input.parentCheckpointIds ?? [],
      resumedFromCheckpointId: input.resumedFromCheckpointId ?? null,
      splitFromCheckpointId: input.splitFromCheckpointId ?? null,
      createdAt,
      files,
    }),
  );
}

export function plannedCheckpointId(input: CheckpointIdentityInput, now: Date): string {
  const createdAt = now.toISOString();
  const summary = handoffSummarySchema.parse(input.summary);
  const workspace = workspaceSnapshotSchema.parse(input.workspace);
  const files = payloadFiles({ ...input, summary, workspace }, createdAt);
  return checkpointContentId({ ...input, summary, workspace }, files, createdAt);
}

async function emitProgress(
  input: CaptureCheckpointInput,
  operationId: string,
  checkpointId: string | null,
  step: CheckpointCaptureProgress['step'],
  state: CheckpointCaptureProgress['state'],
  message: string,
): Promise<void> {
  if (!input.onProgress) return;
  await input.onProgress(
    checkpointCaptureProgressSchema.parse({
      operationId,
      checkpointId,
      step,
      state,
      message,
      occurredAt: new Date().toISOString(),
    }),
  );
}

async function readStagingSecretFiles(stagingPath: string): Promise<SecretScanFile[]> {
  const files: SecretScanFile[] = [];
  for (const fileName of stagingFiles) {
    const filePath = path.join(stagingPath, fileName);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new CheckpointCaptureError('Checkpoint staging 中出现了非白名单文件类型');
    files.push({ path: fileName, content: await readFile(filePath, 'utf8') });
  }
  const actualNames = (await readdir(stagingPath)).sort();
  if (actualNames.join('\0') !== [...stagingFiles].sort().join('\0')) {
    throw new CheckpointCaptureError('Checkpoint staging 文件白名单已变化，已停止写入');
  }
  return files;
}

async function verifyExistingObject(objectPath: string, files: PayloadFiles): Promise<boolean> {
  try {
    const expected = new Map<string, string>([
      ['handoff.md', files.handoff],
      ['workspace.json', files.workspace],
      ['manifest.json', files.manifest],
    ]);
    const names = (await readdir(objectPath)).sort();
    if (names.join('\0') !== [...expected.keys()].sort().join('\0')) return false;
    for (const [name, content] of expected) {
      if ((await readFile(path.join(objectPath, name), 'utf8')) !== content) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function assertCheckpointLineageInput(
  vaultPath: string,
  head: string | null,
  sessionId: string,
  checkpointId: string,
  parentCheckpointIds: string[],
  expectedHeadCheckpointIds: string[] | undefined,
  resumedFromCheckpointId: string | null,
  splitFromCheckpointId: string | null,
): Promise<void> {
  let events;
  try {
    events = await readSessionEventsAtHead(vaultPath, head);
  } catch (error) {
    if (error instanceof SessionEventStoreError) throw new CheckpointCaptureError(error.message);
    throw error;
  }
  const checkpoints = new Map(
    events.filter((event) => event.eventType === 'checkpoint').map((event) => [event.checkpointId, event]),
  );
  if (checkpoints.has(checkpointId)) {
    throw new CheckpointCaptureError('相同 checkpointId 已存在，已停止写入重复事件');
  }
  if (new Set(parentCheckpointIds).size !== parentCheckpointIds.length) {
    throw new CheckpointCaptureError('parentCheckpointIds 存在重复项，请重新预览会话接力链');
  }
  if (expectedHeadCheckpointIds) {
    if (new Set(expectedHeadCheckpointIds).size !== expectedHeadCheckpointIds.length) {
      throw new CheckpointCaptureError('expectedHeadCheckpointIds 存在重复项，请重新读取会话分叉状态');
    }
    const currentHeads = [...(deriveSessionLineageStates(events).get(sessionId)?.headCheckpointIds ?? [])].sort();
    const expectedHeads = [...expectedHeadCheckpointIds].sort();
    if (currentHeads.join('\0') !== expectedHeads.join('\0')) {
      throw new CheckpointCaptureError('会话 head 已变化，请刷新分叉状态后重新选择继续或合并');
    }
    const currentHeadSet = new Set(currentHeads);
    if (parentCheckpointIds.some((parentId) => !currentHeadSet.has(parentId))) {
      throw new CheckpointCaptureError('Checkpoint parent 已不是当前 head，请刷新分叉状态后重试');
    }
  }
  for (const parentId of parentCheckpointIds) {
    const parent = checkpoints.get(parentId);
    if (!parent || parent.sessionId !== sessionId) {
      throw new CheckpointCaptureError('Checkpoint parent 不存在或不属于当前逻辑会话，请重新拉取并预览');
    }
  }
  if (resumedFromCheckpointId) {
    const resumedFrom = checkpoints.get(resumedFromCheckpointId);
    if (!resumedFrom || resumedFrom.sessionId !== sessionId) {
      throw new CheckpointCaptureError('接力来源 checkpoint 不存在或不属于当前逻辑会话，请重新拉取并预览');
    }
  }
  if (splitFromCheckpointId) {
    const splitFrom = checkpoints.get(splitFromCheckpointId);
    if (!splitFrom || splitFrom.sessionId === sessionId || parentCheckpointIds.length > 0) {
      throw new CheckpointCaptureError('拆分来源 checkpoint 不存在、仍属于当前会话，或新会话错误携带了 parent');
    }
  }
}

async function writePayload(stagingPath: string, files: PayloadFiles): Promise<void> {
  await mkdir(stagingPath, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(stagingPath, 'handoff.md'), files.handoff, { mode: 0o600 }),
    writeFile(path.join(stagingPath, 'workspace.json'), files.workspace, { mode: 0o600 }),
    writeFile(path.join(stagingPath, 'manifest.json'), files.manifest, { mode: 0o600 }),
  ]);
}

function checkpointJournalRoot(vaultPath: string): string {
  return path.join(vaultPath, '.fleet', 'checkpoint-journal');
}

function checkpointJournalPath(vaultPath: string, operationId: string): string {
  return path.join(checkpointJournalRoot(vaultPath), `${digest(operationId)}.json`);
}

async function writeCheckpointJournal(vaultPath: string, journal: CheckpointJournal): Promise<string> {
  const parsed = checkpointJournalSchema.parse({ ...journal, updatedAt: new Date().toISOString() });
  const journalRoot = checkpointJournalRoot(vaultPath);
  const finalPath = checkpointJournalPath(vaultPath, parsed.operationId);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

function journalCommitPaths(journal: CheckpointJournal): string[] {
  return ['.gitignore', 'vault.yaml', journal.objectPath, journal.eventPath];
}

function belongsToJournal(name: string, journal: CheckpointJournal): boolean {
  return (
    name === '.gitignore' ||
    name === 'vault.yaml' ||
    name === journal.eventPath ||
    name === journal.objectPath ||
    name.startsWith(`${journal.objectPath}/`)
  );
}

async function rollbackCheckpointIndex(vaultPath: string, journal: CheckpointJournal): Promise<void> {
  const stagedResult = await runGit(vaultPath, ['diff', '--cached', '--name-only', '-z']);
  if (stagedResult.exitCode !== 0) throw new CheckpointCaptureError(stagedResult.stderr || '无法检查待恢复的 Vault 暂存区');
  const stagedNames = stagedResult.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((name) => belongsToJournal(name, journal));
  if (stagedNames.length === 0) return;
  const hasHead = Boolean(await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD']).catch(() => ''));
  if (hasHead) {
    await runGitText(vaultPath, ['reset', 'HEAD', '--', ...journalCommitPaths(journal)]);
    return;
  }
  for (const stagedPath of stagedNames) {
    await runGitText(vaultPath, ['update-index', '--force-remove', '--', stagedPath]);
  }
}

async function recoverCheckpointStaging(vaultPath: string): Promise<string[]> {
  const stagingRoot = path.join(vaultPath, '.fleet', 'staging');
  let entries;
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(stagingRoot, entry.name);
    await rm(candidate, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

/** Recover interrupted publish/index phases without touching committed checkpoints. */
async function recoverCheckpointTransactionsUnlocked(vaultPath: string): Promise<string[]> {
  await assertSessionVaultIdentity(vaultPath);
  const journalRoot = checkpointJournalRoot(vaultPath);
  let entries;
  try {
    entries = await readdir(journalRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await recoverCheckpointStaging(vaultPath);
      return [];
    }
    throw error;
  }

  const recovered: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(journalRoot, entry.name);
    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      await rm(entryPath, { force: true });
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      throw new CheckpointCaptureError('Checkpoint 恢复 journal 中出现了未知文件，已停止自动恢复');
    }
    let journal: CheckpointJournal;
    try {
      journal = checkpointJournalSchema.parse(JSON.parse(await readFile(entryPath, 'utf8')));
    } catch {
      throw new CheckpointCaptureError('Checkpoint 恢复 journal 已损坏，已停止自动恢复并保留现场');
    }
    if (entry.name !== path.basename(checkpointJournalPath(vaultPath, journal.operationId))) {
      throw new CheckpointCaptureError('Checkpoint 恢复 journal 身份不匹配，已停止自动恢复并保留现场');
    }

    const [eventTracked, objectTracked] = await Promise.all([
      sessionVaultPathTrackedAtHead(vaultPath, journal.eventPath),
      sessionVaultPathTrackedAtHead(vaultPath, journal.objectPath),
    ]);
    if (eventTracked && !objectTracked) {
      throw new CheckpointCaptureError('Checkpoint 事件已提交但对象缺失，Vault 历史需要人工检查');
    }
    if (!eventTracked) {
      await rollbackCheckpointIndex(vaultPath, journal);
      await rm(path.join(vaultPath, journal.eventPath), { force: true });
      if (!objectTracked) await rm(path.join(vaultPath, journal.objectPath), { recursive: true, force: true });
    }
    await rm(path.join(vaultPath, journal.stagingPath), { recursive: true, force: true });
    await rm(entryPath, { force: true });
    recovered.push(journal.operationId);
  }
  await recoverCheckpointStaging(vaultPath);
  return recovered.sort();
}

export async function recoverCheckpointTransactions(vaultPathInput: string): Promise<string[]> {
  const vaultPath = await realpath(path.resolve(vaultPathInput));
  return withSessionVaultLock(vaultPath, () => recoverCheckpointTransactionsUnlocked(vaultPath));
}

/** Caller must already hold `withSessionVaultLock` for this Vault. */
export async function recoverCheckpointTransactionsWithinLock(vaultPath: string): Promise<string[]> {
  return recoverCheckpointTransactionsUnlocked(vaultPath);
}

async function captureCheckpointUnlocked(
  input: CaptureCheckpointInput,
  vaultPath: string,
): Promise<CheckpointCaptureResult> {
  const startedAt = Date.now();
  const operationId = input.operationId ?? randomUUID();
  const createdAt = (input.now ?? new Date()).toISOString();
  let checkpointId: string | null = null;
  let stagingPath: string | null = null;
  let journalPath: string | null = null;

  try {
    await emitProgress(input, operationId, null, 'preparing', 'running', '校验 Vault、摘要与工作区');
    if (!input.summary.reviewedAt) throw new CheckpointCaptureError('交接摘要尚未复核，不能生成 checkpoint');
    await recoverCheckpointTransactionsUnlocked(vaultPath);
    await assertSessionVaultWriteReady(vaultPath);
    const summary = handoffSummarySchema.parse(input.summary);
    const workspace = workspaceSnapshotSchema.parse(input.workspace);
    const files = payloadFiles({ ...input, summary, workspace }, createdAt);
    checkpointId = checkpointContentId(input, files, createdAt);
    const eventId = randomUUID();
    const machineDirectory = sessionEventMachineSegment(input.machine);
    const relativeStagingPath = path.posix.join('.fleet', 'staging', `${checkpointId}-${randomUUID()}`);
    const relativeObjectPath = path.posix.join('objects', checkpointId);
    const relativeEventPath = path.posix.join('events', machineDirectory, `${eventId}.json`);
    stagingPath = path.join(vaultPath, relativeStagingPath);
    const objectPath = path.join(vaultPath, relativeObjectPath);
    const eventPath = path.join(vaultPath, relativeEventPath);
    const payloadPath = relativeObjectPath;
    const checkpoint: Checkpoint = checkpointSchema.parse({
      schemaVersion: 1,
      eventType: 'checkpoint',
      eventId,
      checkpointId,
      parentCheckpointIds: input.parentCheckpointIds ?? [],
      resumedFromCheckpointId: input.resumedFromCheckpointId ?? null,
      splitFromCheckpointId: input.splitFromCheckpointId ?? null,
      sessionId: input.sessionId,
      provider: input.session.provider,
      providerSessionId: input.session.providerSessionId,
      title: input.session.title?.trim() || summary.goal,
      projectId: input.session.projectId,
      repositoryId: input.session.repositoryId,
      branch: workspace.branch,
      head: workspace.head,
      machine: input.machine,
      createdAt,
      payloadPath,
      capabilities: input.capabilities,
    });
    const eventContent = `${JSON.stringify(checkpoint, null, 2)}\n`;
    const preCaptureHead = await runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
    await assertCheckpointLineageInput(
      vaultPath,
      preCaptureHead,
      input.sessionId,
      checkpointId,
      checkpoint.parentCheckpointIds,
      input.expectedHeadCheckpointIds,
      checkpoint.resumedFromCheckpointId,
      checkpoint.splitFromCheckpointId ?? null,
    );
    let journal: CheckpointJournal = {
      schemaVersion: 1,
      operationId,
      checkpointId,
      phase: 'staging-written',
      stagingPath: relativeStagingPath,
      objectPath: relativeObjectPath,
      eventPath: relativeEventPath,
      preCaptureHead,
      updatedAt: new Date().toISOString(),
    };

    await emitProgress(input, operationId, checkpointId, 'writing-staging', 'running', '写入隔离 staging');
    await writePayload(stagingPath, files);
    journalPath = await writeCheckpointJournal(vaultPath, journal);
    await emitProgress(input, operationId, checkpointId, 'secret-scan', 'running', '执行最终秘密扫描');
    assertNoSecrets([...(await readStagingSecretFiles(stagingPath)), { path: 'event.json', content: eventContent }]);
    await input.testHook?.('after-final-scan', stagingPath);

    await emitProgress(input, operationId, checkpointId, 'publishing-object', 'running', '发布不可变交接对象');
    await mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    if (await verifyExistingObject(objectPath, files)) {
      await rm(stagingPath, { recursive: true, force: true });
    } else {
      try {
        await stat(objectPath);
        throw new CheckpointCaptureError('Checkpoint 内容哈希发生冲突，已停止写入');
      } catch (error) {
        if (error instanceof CheckpointCaptureError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(stagingPath, objectPath);
    }
    journal = { ...journal, phase: 'object-published' };
    journalPath = await writeCheckpointJournal(vaultPath, journal);
    await input.testHook?.('after-object-publish', objectPath);

    const eventDirectory = path.join(vaultPath, 'events', machineDirectory);
    const temporaryEventPath = path.join(vaultPath, '.fleet', 'staging', `${eventId}.event.tmp`);
    await emitProgress(input, operationId, checkpointId, 'writing-event', 'running', '追加不可变 checkpoint 事件');
    await mkdir(eventDirectory, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(temporaryEventPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryEventPath, eventContent, { mode: 0o600 });
    await rename(temporaryEventPath, eventPath);
    journal = { ...journal, phase: 'event-published' };
    journalPath = await writeCheckpointJournal(vaultPath, journal);
    await input.testHook?.('after-event-publish', eventPath);

    await emitProgress(input, operationId, checkpointId, 'committing', 'running', '提交本机 Vault checkpoint');
    const commitPaths = journalCommitPaths(journal);
    await stageSessionVaultPaths(vaultPath, commitPaths, [relativeObjectPath]);
    journal = { ...journal, phase: 'index-staged' };
    journalPath = await writeCheckpointJournal(vaultPath, journal);
    await input.testHook?.('after-index-stage', vaultPath);
    await runGitText(vaultPath, [
      '-c',
      'user.name=Moo Fleet',
      '-c',
      'user.email=moo-fleet@localhost',
      'commit',
      '-m',
      `checkpoint: ${checkpointId.slice(0, 12)}`,
    ]);
    journal = { ...journal, phase: 'committed' };
    journalPath = await writeCheckpointJournal(vaultPath, journal);
    await input.testHook?.('after-commit', vaultPath);
    const commitHash = await runGitText(vaultPath, ['rev-parse', 'HEAD']);
    await assertSessionVaultClean(vaultPath, 'Checkpoint ');
    const result = checkpointCaptureResultSchema.parse({
      operationId,
      checkpoint,
      commitHash,
      durationMs: Date.now() - startedAt,
    });
    await rm(journalPath, { force: true });
    journalPath = null;
    await emitProgress(input, operationId, checkpointId, 'complete', 'completed', 'Checkpoint 已保存到本机 Vault');
    return result;
  } catch (error) {
    if (!(error instanceof SimulatedCheckpointInterruption)) {
      if (journalPath) await recoverCheckpointTransactionsUnlocked(vaultPath).catch(() => undefined);
      else if (stagingPath) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await emitProgress(
      input,
      operationId,
      checkpointId,
      'failed',
      'failed',
      error instanceof Error ? error.message : 'Checkpoint 采集失败',
    ).catch(() => undefined);
    throw error;
  }
}

export async function captureCheckpoint(input: CaptureCheckpointInput): Promise<CheckpointCaptureResult> {
  const vaultPath = await realpath(path.resolve(input.vaultPath));
  return withSessionVaultLock(vaultPath, () => captureCheckpointUnlocked(input, vaultPath));
}
