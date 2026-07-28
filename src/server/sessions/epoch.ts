import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type {
  RotateSessionVaultEpochRequest,
  RotateSessionVaultEpochResult,
  SessionCheckpointPayload,
  SessionDetail,
  SessionVaultBinding,
  SessionVaultEpoch,
  SessionVaultEpochCatalog,
  SessionVaultEpochSessionList,
  SessionVaultEpochStatus,
} from '../../shared/sessions.js';
import {
  rotateSessionVaultEpochRequestSchema,
  rotateSessionVaultEpochResultSchema,
  sessionVaultBindingSchema,
  sessionVaultEpochCatalogSchema,
  sessionVaultEpochSchema,
  sessionVaultEpochSessionListSchema,
  sessionVaultEpochStatusSchema,
} from '../../shared/sessions.js';
import { runGit, runGitText } from '../git/runner.js';
import {
  listSessionVaultSessions,
  sessionVaultCheckpointPayload,
  sessionVaultSessionDetail,
  type SessionCatalogOptions,
  type SessionListQuery,
} from './catalog.js';
import { recoverCheckpointTransactions } from './checkpoint.js';
import { normalizeRemoteUrl } from './discovery.js';
import { recoverLifecycleTransactions } from './lifecycle.js';
import { recoverLineageTransactions } from './lineage.js';
import { pullSessionVault, pushSessionVault, sessionVaultSyncStatus } from './sync.js';
import {
  initializeSessionVault,
  loadSessionVaultBinding,
  loadSessionVaultStatus,
  resolveSessionVaultBindingPath,
  writeSessionVaultBinding,
} from './vault.js';
import { withSessionVaultLock } from './vault-lock.js';

const defaultRotationThresholdBytes = 512 * 1024 * 1024;

export interface SessionVaultEpochOptions extends SessionCatalogOptions {
  epochCatalogPath?: string;
  epochJournalPath?: string;
  rotationThresholdBytes?: number;
}

export type SessionVaultEpochErrorCode =
  | 'epoch-not-configured'
  | 'epoch-catalog-invalid'
  | 'epoch-concurrent-change'
  | 'epoch-archived-readonly'
  | 'epoch-not-found'
  | 'epoch-vault-unavailable'
  | 'epoch-vault-changed'
  | 'epoch-rotation-not-synced'
  | 'epoch-rotation-path-reused'
  | 'epoch-rotation-remote-reused'
  | 'epoch-rotation-remote-not-empty'
  | 'epoch-rotation-recovery-required';

export class SessionVaultEpochError extends Error {
  constructor(
    readonly code: SessionVaultEpochErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionVaultEpochError';
  }
}

const rotationJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  stage: z.enum(['prepared', 'binding-switched']),
  preparedBindingPath: z.string().min(1).max(4_000),
  oldBinding: sessionVaultBindingSchema,
  newBinding: sessionVaultBindingSchema,
  previousEpoch: sessionVaultEpochSchema,
  activeEpoch: sessionVaultEpochSchema,
  catalog: sessionVaultEpochCatalogSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type RotationJournal = z.infer<typeof rotationJournalSchema>;

function resolveEpochCatalogPath(options: SessionVaultEpochOptions): string {
  return path.resolve(
    options.epochCatalogPath
      ?? path.join(path.dirname(resolveSessionVaultBindingPath(options)), 'session-vault-epochs.yaml'),
  );
}

function resolveEpochJournalPath(options: SessionVaultEpochOptions): string {
  return path.resolve(
    options.epochJournalPath
      ?? path.join(path.dirname(resolveSessionVaultBindingPath(options)), 'session-vault-epoch-rotation.json'),
  );
}

function resolveEpochDirectory(epochId: string, options: SessionVaultEpochOptions): string {
  return path.join(path.dirname(resolveEpochCatalogPath(options)), 'session-vault-epochs', epochId);
}

function resolveActiveIndexPath(options: SessionVaultEpochOptions): string {
  return path.resolve(
    options.indexPath
      ?? path.join(path.dirname(resolveSessionVaultBindingPath(options)), 'session-vault-index.json'),
  );
}

function resolveActiveSyncStatePath(options: SessionVaultEpochOptions): string {
  return path.resolve(
    options.statePath
      ?? path.join(path.dirname(resolveSessionVaultBindingPath(options)), 'session-vault-sync.json'),
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readEpochCatalog(options: SessionVaultEpochOptions): Promise<SessionVaultEpochCatalog | null> {
  const filePath = resolveEpochCatalogPath(options);
  if (!(await exists(filePath))) return null;
  try {
    return sessionVaultEpochCatalogSchema.parse(parse(await readFile(filePath, 'utf8')));
  } catch {
    throw new SessionVaultEpochError(
      'epoch-catalog-invalid',
      '本机 Session Vault 纪元目录无法识别。请先备份该文件，再修复或移走后重试。',
    );
  }
}

async function writeEpochCatalog(
  options: SessionVaultEpochOptions,
  catalog: SessionVaultEpochCatalog,
): Promise<void> {
  const parsed = sessionVaultEpochCatalogSchema.parse(catalog);
  await writeAtomic(resolveEpochCatalogPath(options), stringify(parsed, { indent: 2 }));
}

async function readRotationJournal(options: SessionVaultEpochOptions): Promise<RotationJournal | null> {
  const filePath = resolveEpochJournalPath(options);
  if (!(await exists(filePath))) return null;
  try {
    return rotationJournalSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    throw new SessionVaultEpochError(
      'epoch-rotation-recovery-required',
      'Vault 纪元轮换恢复记录已损坏。旧、新 Vault 都未被删除，请先备份本机配置并人工确认当前 binding。',
    );
  }
}

async function writeRotationJournal(
  options: SessionVaultEpochOptions,
  journal: RotationJournal,
): Promise<void> {
  const parsed = rotationJournalSchema.parse(journal);
  await writeAtomic(resolveEpochJournalPath(options), `${JSON.stringify(parsed, null, 2)}\n`);
}

function bindingMatches(left: SessionVaultBinding | null, right: SessionVaultBinding): boolean {
  return Boolean(
    left
      && path.resolve(left.vaultPath) === path.resolve(right.vaultPath)
      && left.normalizedRemoteUrl === right.normalizedRemoteUrl,
  );
}

function epochIdFor(binding: SessionVaultBinding, createdAt: string): string {
  const identity = binding.normalizedRemoteUrl
    ? `remote:${binding.normalizedRemoteUrl}`
    : `local:${path.resolve(binding.vaultPath)}`;
  return createHash('sha256')
    .update(`moo-fleet-session-vault-epoch-v1\0${createdAt}\0${identity}`)
    .digest('hex');
}

async function currentHead(vaultPath: string): Promise<string | null> {
  return runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null);
}

async function repositoryStorageBytes(vaultPath: string): Promise<number> {
  const output = await runGitText(vaultPath, ['count-objects', '-v']).catch(() => '');
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([a-z-]+):\s+(\d+)$/);
    if (match?.[1] && match[2]) values.set(match[1], Number.parseInt(match[2], 10) || 0);
  }
  return Math.max(0, ((values.get('size') ?? 0) + (values.get('size-pack') ?? 0)) * 1024);
}

async function sessionCount(options: SessionCatalogOptions): Promise<number> {
  return (await listSessionVaultSessions({ page: 1, pageSize: 1, lifecycle: 'all' }, options)).total;
}

async function activeEpochSnapshot(
  sequence: number,
  options: SessionVaultEpochOptions,
): Promise<SessionVaultEpoch> {
  const status = await loadSessionVaultStatus(options);
  if (!status.configured || !status.binding || !status.manifest) {
    throw new SessionVaultEpochError('epoch-not-configured', 'Session Vault 尚未配置');
  }
  const vaultPath = await realpath(status.binding.vaultPath);
  const [head, storageBytes, totalSessions] = await Promise.all([
    currentHead(vaultPath),
    repositoryStorageBytes(vaultPath),
    sessionCount(options),
  ]);
  return sessionVaultEpochSchema.parse({
    schemaVersion: 1,
    epochId: epochIdFor({ ...status.binding, vaultPath }, status.manifest.createdAt),
    sequence,
    state: 'active',
    readOnly: false,
    vaultPath,
    remoteSyncEnabled: status.binding.remoteSyncEnabled,
    remoteName: status.binding.remoteName,
    normalizedRemoteUrl: status.binding.normalizedRemoteUrl,
    privacyState: status.binding.privacyState,
    createdAt: status.manifest.createdAt,
    activatedAt: status.binding.initializedAt,
    archivedAt: null,
    head,
    storageBytes,
    sessionCount: totalSessions,
  });
}

async function archivedEpochSnapshot(
  epoch: SessionVaultEpoch,
  archivedAt: string,
  options: SessionVaultEpochOptions,
): Promise<SessionVaultEpoch> {
  const vaultPath = await realpath(epoch.vaultPath).catch(() => epoch.vaultPath);
  const archivedOptions = await catalogOptionsForEpoch({ ...epoch, vaultPath }, options, false);
  const [head, storageBytes, totalSessions] = await Promise.all([
    currentHead(vaultPath),
    repositoryStorageBytes(vaultPath),
    sessionCount(archivedOptions),
  ]);
  return sessionVaultEpochSchema.parse({
    ...epoch,
    state: 'archived',
    readOnly: true,
    vaultPath,
    archivedAt,
    head,
    storageBytes,
    sessionCount: totalSessions,
  });
}

async function clearActiveAuxiliaryState(options: SessionVaultEpochOptions): Promise<void> {
  await Promise.all([
    rm(resolveActiveIndexPath(options), { force: true }),
    rm(resolveActiveSyncStatePath(options), { force: true }),
  ]);
}

async function writeArchivedBinding(
  epoch: SessionVaultEpoch,
  options: SessionVaultEpochOptions,
): Promise<string> {
  const bindingPath = path.join(resolveEpochDirectory(epoch.epochId, options), 'binding.yaml');
  await writeSessionVaultBinding(
    sessionVaultBindingSchema.parse({
      schemaVersion: 1,
      vaultPath: epoch.vaultPath,
      remoteSyncEnabled: false,
      remoteName: epoch.remoteName,
      normalizedRemoteUrl: epoch.normalizedRemoteUrl,
      privacyState: epoch.privacyState,
      initializedAt: epoch.activatedAt,
    }),
    { bindingPath },
  );
  return bindingPath;
}

async function finalizeRotationJournal(
  options: SessionVaultEpochOptions,
  journal: RotationJournal,
): Promise<void> {
  await writeArchivedBinding(journal.previousEpoch, options);
  await clearActiveAuxiliaryState(options);
  await writeEpochCatalog(options, journal.catalog);
  await Promise.all([
    rm(journal.preparedBindingPath, { force: true }),
    rm(`${journal.preparedBindingPath}.index.json`, { force: true }),
    rm(`${journal.preparedBindingPath}.sync.json`, { force: true }),
    rm(resolveEpochJournalPath(options), { force: true }),
  ]);
}

export async function recoverSessionVaultEpochRotation(
  options: SessionVaultEpochOptions = {},
): Promise<void> {
  const journal = await readRotationJournal(options);
  if (!journal) return;
  const binding = await loadSessionVaultBinding(options);
  if (bindingMatches(binding, journal.newBinding)) {
    await finalizeRotationJournal(options, journal);
    return;
  }
  if (bindingMatches(binding, journal.oldBinding)) {
    await Promise.all([
      rm(journal.preparedBindingPath, { force: true }),
      rm(`${journal.preparedBindingPath}.index.json`, { force: true }),
      rm(`${journal.preparedBindingPath}.sync.json`, { force: true }),
      rm(resolveEpochJournalPath(options), { force: true }),
    ]);
    return;
  }
  throw new SessionVaultEpochError(
    'epoch-rotation-recovery-required',
    'Vault 轮换中途退出后，当前 binding 与旧、新 Vault 都不一致。为避免误写，Fleet 已停止自动恢复。',
  );
}

async function reconciledCatalog(options: SessionVaultEpochOptions): Promise<{
  catalog: SessionVaultEpochCatalog;
  activeEpoch: SessionVaultEpoch;
}> {
  await recoverSessionVaultEpochRotation(options);
  const status = await loadSessionVaultStatus(options);
  if (!status.configured || !status.binding || !status.manifest) {
    throw new SessionVaultEpochError('epoch-not-configured', 'Session Vault 尚未配置');
  }
  const currentEpochId = epochIdFor(status.binding, status.manifest.createdAt);
  const existing = await readEpochCatalog(options);
  if (!existing) {
    const activeEpoch = await activeEpochSnapshot(1, options);
    const catalog = sessionVaultEpochCatalogSchema.parse({
      schemaVersion: 1,
      activeEpochId: activeEpoch.epochId,
      updatedAt: new Date().toISOString(),
      epochs: [activeEpoch],
    });
    await writeEpochCatalog(options, catalog);
    return { catalog, activeEpoch };
  }

  const archivedMatch = existing.epochs.find(
    (epoch) => epoch.epochId === currentEpochId && epoch.state === 'archived',
  );
  if (archivedMatch) {
    throw new SessionVaultEpochError(
      'epoch-archived-readonly',
      `Vault 纪元 #${archivedMatch.sequence} 已归档为只读，不能重新作为当前写入仓库。`,
    );
  }

  if (existing.activeEpochId === currentEpochId) {
    const sequence = existing.epochs.find((epoch) => epoch.epochId === currentEpochId)?.sequence ?? 1;
    const activeEpoch = await activeEpochSnapshot(sequence, options);
    return {
      catalog: sessionVaultEpochCatalogSchema.parse({
        ...existing,
        epochs: existing.epochs.map((epoch) => epoch.epochId === currentEpochId ? activeEpoch : epoch),
      }),
      activeEpoch,
    };
  }

  const now = new Date().toISOString();
  const previousActive = existing.epochs.find((epoch) => epoch.epochId === existing.activeEpochId);
  if (!previousActive) {
    throw new SessionVaultEpochError('epoch-catalog-invalid', 'Vault 纪元目录缺少当前写入纪元');
  }
  const previousArchived = await archivedEpochSnapshot(previousActive, now, options);
  const nextSequence = Math.max(...existing.epochs.map((epoch) => epoch.sequence)) + 1;
  const activeEpoch = await activeEpochSnapshot(nextSequence, options);
  const catalog = sessionVaultEpochCatalogSchema.parse({
    schemaVersion: 1,
    activeEpochId: activeEpoch.epochId,
    updatedAt: now,
    epochs: [
      ...existing.epochs
        .filter((epoch) => epoch.epochId !== previousArchived.epochId)
        .map((epoch) => epoch.state === 'active'
          ? sessionVaultEpochSchema.parse({ ...epoch, state: 'archived', readOnly: true, archivedAt: now })
          : epoch),
      previousArchived,
      activeEpoch,
    ],
  });
  await writeArchivedBinding(previousArchived, options);
  await clearActiveAuxiliaryState(options);
  await writeEpochCatalog(options, catalog);
  return { catalog, activeEpoch };
}

export async function loadSessionVaultEpochStatus(
  options: SessionVaultEpochOptions = {},
): Promise<SessionVaultEpochStatus> {
  const vaultStatus = await loadSessionVaultStatus(options);
  if (!vaultStatus.configured) {
    return sessionVaultEpochStatusSchema.parse({
      schemaVersion: 1,
      configured: false,
      activeEpochId: null,
      activeEpoch: null,
      archivedEpochs: [],
      totalEpochs: 0,
      rotationThresholdBytes: options.rotationThresholdBytes ?? defaultRotationThresholdBytes,
      rotationSuggested: false,
      rotationReason: null,
    });
  }
  const { catalog, activeEpoch } = await reconciledCatalog(options);
  const threshold = options.rotationThresholdBytes ?? defaultRotationThresholdBytes;
  const archivedEpochs = catalog.epochs
    .filter((epoch) => epoch.state === 'archived')
    .sort((left, right) => right.sequence - left.sequence);
  const rotationSuggested = activeEpoch.storageBytes >= threshold;
  return sessionVaultEpochStatusSchema.parse({
    schemaVersion: 1,
    configured: true,
    activeEpochId: activeEpoch.epochId,
    activeEpoch,
    archivedEpochs,
    totalEpochs: catalog.epochs.length,
    rotationThresholdBytes: threshold,
    rotationSuggested,
    rotationReason: rotationSuggested
      ? `当前 Vault Git 对象约占 ${activeEpoch.storageBytes} 字节，已达到建议轮换阈值。`
      : null,
  });
}

async function canonicalCandidate(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => path.resolve(candidate));
}

export async function assertSessionVaultPathNotArchived(
  candidate: string,
  options: SessionVaultEpochOptions = {},
): Promise<void> {
  const catalog = await readEpochCatalog(options);
  if (!catalog) return;
  const canonical = await canonicalCandidate(candidate);
  const archived = catalog.epochs.find(
    (epoch) => epoch.state === 'archived' && path.resolve(epoch.vaultPath) === canonical,
  );
  if (archived) {
    throw new SessionVaultEpochError(
      'epoch-archived-readonly',
      `Vault 纪元 #${archived.sequence} 已归档为只读。请新建独立目录，旧纪元仍可从会话接力中搜索和查看。`,
    );
  }
}

export async function assertSessionVaultInitializationAllowed(
  candidate: string,
  options: SessionVaultEpochOptions = {},
): Promise<void> {
  await assertSessionVaultPathNotArchived(candidate, options);
  const canonical = await canonicalCandidate(candidate);
  const current = await loadSessionVaultStatus(options);
  if (current.configured && current.binding) {
    const currentPath = await canonicalCandidate(current.binding.vaultPath);
    if (currentPath !== canonical) {
      throw new SessionVaultEpochError(
        'epoch-concurrent-change',
        'Session Vault 已有当前写入仓库。切换到独立目录必须使用“开启新纪元”，以先同步并只读归档旧 Vault。',
      );
    }
  }
  const catalog = await readEpochCatalog(options);
  if (!catalog) return;
  const active = catalog.epochs.find((epoch) => epoch.epochId === catalog.activeEpochId);
  if (active && path.resolve(active.vaultPath) !== canonical) {
    throw new SessionVaultEpochError(
      'epoch-concurrent-change',
      'Session Vault 已有当前写入纪元。切换到独立仓库必须使用“开启新纪元”，以先同步并只读归档旧 Vault。',
    );
  }
}

async function synchronizeBeforeRotation(options: SessionVaultEpochOptions): Promise<void> {
  const status = await loadSessionVaultStatus(options);
  if (!status.binding?.remoteSyncEnabled) return;
  await pullSessionVault(options);
  await pushSessionVault(options);
  const sync = await sessionVaultSyncStatus(options);
  if (sync.state !== 'synced') {
    throw new SessionVaultEpochError(
      'epoch-rotation-not-synced',
      `旧 Vault 必须先与远端完全同步；当前状态：${sync.message}`,
    );
  }
}

async function assertRotationRepositoryClean(vaultPath: string): Promise<void> {
  const head = await currentHead(vaultPath);
  if (head) {
    const branch = await runGitText(vaultPath, ['branch', '--show-current']);
    if (branch !== 'main') {
      throw new SessionVaultEpochError('epoch-rotation-not-synced', '旧 Vault 必须停留在 main 分支才能轮换');
    }
  }
  const status = await runGit(vaultPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.exitCode !== 0) {
    throw new SessionVaultEpochError('epoch-rotation-not-synced', '无法确认旧 Vault 工作区状态');
  }
  const records = status.stdout.toString('utf8').split('\0').filter(Boolean);
  const bootstrapOnly = !head && records.every((record) => ['?? .gitignore', '?? vault.yaml'].includes(record));
  if (records.length > 0 && !bootstrapOnly) {
    throw new SessionVaultEpochError(
      'epoch-rotation-not-synced',
      '旧 Vault 仍有未提交内容或恢复现场，已停止轮换。请先完成当前 checkpoint。',
    );
  }
}

async function assertNewRemoteEmpty(binding: SessionVaultBinding): Promise<void> {
  if (!binding.remoteSyncEnabled || !binding.remoteName) return;
  const result = await runGit(
    binding.vaultPath,
    ['ls-remote', '--heads', binding.remoteName, 'refs/heads/main'],
    300_000,
    undefined,
    1_000_000,
  );
  if (result.exitCode !== 0) {
    throw new SessionVaultEpochError(
      'epoch-rotation-not-synced',
      '无法确认新纪元私有远端为空。请检查网络、权限或远端地址后重试。',
      502,
    );
  }
  if (result.stdout.toString('utf8').trim()) {
    throw new SessionVaultEpochError(
      'epoch-rotation-remote-not-empty',
      '新纪元远端的 main 分支已经包含历史。为避免混入其他 Vault，请使用一个全新的空私有仓库。',
    );
  }
}

async function assertNewVaultEmpty(binding: SessionVaultBinding): Promise<void> {
  if (await currentHead(binding.vaultPath)) {
    throw new SessionVaultEpochError(
      'epoch-rotation-path-reused',
      '新纪元目录已经包含 Git 历史。请使用新的空目录或空 Git 仓库。',
    );
  }
  const status = await runGit(binding.vaultPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.exitCode !== 0) {
    throw new SessionVaultEpochError('epoch-rotation-path-reused', '无法确认新纪元目录为空');
  }
  const records = status.stdout.toString('utf8').split('\0').filter(Boolean);
  if (!records.every((record) => ['?? .gitignore', '?? vault.yaml'].includes(record))) {
    throw new SessionVaultEpochError(
      'epoch-rotation-path-reused',
      '新纪元目录包含 Vault 引导文件之外的内容。请改用新的空目录。',
    );
  }
}

export async function rotateSessionVaultEpoch(
  request: RotateSessionVaultEpochRequest,
  options: SessionVaultEpochOptions = {},
): Promise<RotateSessionVaultEpochResult> {
  const input = rotateSessionVaultEpochRequestSchema.parse(request);
  await recoverSessionVaultEpochRotation(options);
  const initial = await reconciledCatalog(options);
  if (initial.activeEpoch.epochId !== input.expectedActiveEpochId) {
    throw new SessionVaultEpochError(
      'epoch-concurrent-change',
      '当前 Vault 纪元已经变化，请刷新纪元目录后重新确认。',
    );
  }
  await assertSessionVaultPathNotArchived(input.vaultPath, options);
  const requestedPath = await canonicalCandidate(input.vaultPath);
  if (initial.catalog.epochs.some((epoch) => path.resolve(epoch.vaultPath) === requestedPath)) {
    throw new SessionVaultEpochError(
      'epoch-rotation-path-reused',
      '新纪元必须使用独立目录，不能复用当前或已归档 Vault 的工作目录。',
    );
  }
  if (input.remoteUrl) {
    const requestedRemote = normalizeRemoteUrl(input.remoteUrl);
    if (initial.catalog.epochs.some((epoch) => epoch.normalizedRemoteUrl === requestedRemote)) {
      throw new SessionVaultEpochError(
        'epoch-rotation-remote-reused',
        '新纪元必须使用独立私有远端，不能复用当前或已归档 Vault 的远端仓库。',
      );
    }
  }

  const initialStatus = await loadSessionVaultStatus(options);
  if (!initialStatus.binding) {
    throw new SessionVaultEpochError('epoch-not-configured', 'Session Vault 尚未配置');
  }
  const initialBinding = initialStatus.binding;
  await recoverCheckpointTransactions(initialBinding.vaultPath);
  await recoverLifecycleTransactions(initialBinding.vaultPath);
  await recoverLineageTransactions(initialBinding.vaultPath);
  await synchronizeBeforeRotation(options);

  return withSessionVaultLock(initialBinding.vaultPath, async () => {
    const currentStatus = await loadSessionVaultStatus(options);
    if (!currentStatus.binding || !bindingMatches(currentStatus.binding, initialBinding)) {
      throw new SessionVaultEpochError('epoch-concurrent-change', 'Vault binding 在轮换前发生变化，请刷新后重试。');
    }
    const currentSync = await sessionVaultSyncStatus(options);
    if (currentStatus.binding.remoteSyncEnabled && currentSync.state !== 'synced') {
      throw new SessionVaultEpochError(
        'epoch-rotation-not-synced',
        `旧 Vault 在轮换前又产生了待同步内容：${currentSync.message}`,
      );
    }
    await assertRotationRepositoryClean(currentStatus.binding.vaultPath);

    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    const operationId = randomUUID();
    const preparedBindingPath = path.join(
      path.dirname(resolveEpochCatalogPath(options)),
      'session-vault-epochs',
      `.prepare-${operationId}.yaml`,
    );
    const newStatus = await initializeSessionVault(input, {
      ...options,
      bindingPath: preparedBindingPath,
      now,
    });
    if (!newStatus.binding || !newStatus.manifest) {
      throw new SessionVaultEpochError('epoch-rotation-recovery-required', '新 Vault 已准备，但本机 binding 未能建立。');
    }
    if (initial.catalog.epochs.some((epoch) => path.resolve(epoch.vaultPath) === path.resolve(newStatus.binding!.vaultPath))) {
      throw new SessionVaultEpochError(
        'epoch-rotation-path-reused',
        '新纪元目录解析后与现有 Vault 重合，已停止切换。',
      );
    }
    if (
      newStatus.binding.normalizedRemoteUrl
      && initial.catalog.epochs.some((epoch) => epoch.normalizedRemoteUrl === newStatus.binding!.normalizedRemoteUrl)
    ) {
      throw new SessionVaultEpochError(
        'epoch-rotation-remote-reused',
        '新纪元远端解析后与现有 Vault 重合，已停止切换。',
      );
    }
    await assertNewVaultEmpty(newStatus.binding);
    await assertNewRemoteEmpty(newStatus.binding);

    const previousEpoch = await archivedEpochSnapshot(initial.activeEpoch, timestamp, options);
    const nextSequence = Math.max(...initial.catalog.epochs.map((epoch) => epoch.sequence)) + 1;
    const preparedOptions: SessionVaultEpochOptions = {
      ...options,
      bindingPath: preparedBindingPath,
      indexPath: `${preparedBindingPath}.index.json`,
      statePath: `${preparedBindingPath}.sync.json`,
    };
    const activeEpoch = await activeEpochSnapshot(nextSequence, preparedOptions);
    const catalog = sessionVaultEpochCatalogSchema.parse({
      schemaVersion: 1,
      activeEpochId: activeEpoch.epochId,
      updatedAt: timestamp,
      epochs: [
        ...initial.catalog.epochs.filter((epoch) => epoch.epochId !== previousEpoch.epochId),
        previousEpoch,
        activeEpoch,
      ],
    });
    let journal = rotationJournalSchema.parse({
      schemaVersion: 1,
      operationId,
      stage: 'prepared',
      preparedBindingPath,
      oldBinding: currentStatus.binding,
      newBinding: newStatus.binding,
      previousEpoch,
      activeEpoch,
      catalog,
      updatedAt: timestamp,
    });
    await writeRotationJournal(options, journal);
    await writeSessionVaultBinding(newStatus.binding, options);
    journal = rotationJournalSchema.parse({ ...journal, stage: 'binding-switched', updatedAt: new Date().toISOString() });
    await writeRotationJournal(options, journal);
    await finalizeRotationJournal(options, journal);
    return rotateSessionVaultEpochResultSchema.parse({
      schemaVersion: 1,
      previousEpoch,
      activeEpoch,
      forcePushUsed: false,
      message: `Vault 纪元 #${previousEpoch.sequence} 已归档为只读；新纪元 #${activeEpoch.sequence} 已开始接收 checkpoint。`,
    });
  });
}

async function catalogOptionsForEpoch(
  epoch: SessionVaultEpoch,
  options: SessionVaultEpochOptions,
  verifyHead = true,
): Promise<SessionCatalogOptions> {
  const vaultPath = await realpath(epoch.vaultPath).catch(() => {
    throw new SessionVaultEpochError(
      'epoch-vault-unavailable',
      `Vault 纪元 #${epoch.sequence} 的本机目录不可访问；请重新挂载磁盘或恢复该只读克隆。`,
      404,
    );
  });
  if (!(await stat(vaultPath)).isDirectory()) {
    throw new SessionVaultEpochError('epoch-vault-unavailable', '归档 Vault 路径不是目录', 404);
  }
  if (verifyHead && (await currentHead(vaultPath)) !== epoch.head) {
    throw new SessionVaultEpochError(
      'epoch-vault-changed',
      `Vault 纪元 #${epoch.sequence} 的 HEAD 已变化。为保持只读语义，Fleet 已停止读取并要求人工确认。`,
    );
  }
  const bindingPath = await writeArchivedBinding({ ...epoch, vaultPath }, options);
  const directory = resolveEpochDirectory(epoch.epochId, options);
  return {
    ...options,
    bindingPath,
    indexPath: path.join(directory, 'index.json'),
    statePath: path.join(directory, 'sync.json'),
  };
}

async function archivedEpoch(
  epochId: string,
  options: SessionVaultEpochOptions,
): Promise<SessionVaultEpoch> {
  const status = await loadSessionVaultEpochStatus(options);
  const epoch = status.archivedEpochs.find((item) => item.epochId === epochId);
  if (!epoch) throw new SessionVaultEpochError('epoch-not-found', '归档 Vault 纪元不存在', 404);
  return epoch;
}

export async function listArchivedSessionVaultSessions(
  epochId: string,
  query: SessionListQuery = {},
  options: SessionVaultEpochOptions = {},
): Promise<SessionVaultEpochSessionList> {
  const epoch = await archivedEpoch(epochId, options);
  const archivedOptions = await catalogOptionsForEpoch(epoch, options);
  const [payload, activeSync] = await Promise.all([
    listSessionVaultSessions(query, archivedOptions),
    sessionVaultSyncStatus(options),
  ]);
  return sessionVaultEpochSessionListSchema.parse({ ...payload, sync: activeSync, epoch });
}

export async function archivedSessionVaultSessionDetail(
  epochId: string,
  sessionId: string,
  options: SessionVaultEpochOptions = {},
): Promise<SessionDetail> {
  const epoch = await archivedEpoch(epochId, options);
  return sessionVaultSessionDetail(sessionId, await catalogOptionsForEpoch(epoch, options));
}

export async function archivedSessionVaultCheckpointPayload(
  epochId: string,
  sessionId: string,
  checkpointId: string,
  options: SessionVaultEpochOptions = {},
): Promise<SessionCheckpointPayload> {
  const epoch = await archivedEpoch(epochId, options);
  return sessionVaultCheckpointPayload(
    sessionId,
    checkpointId,
    await catalogOptionsForEpoch(epoch, options),
  );
}
