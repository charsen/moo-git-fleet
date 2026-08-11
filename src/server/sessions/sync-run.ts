import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import type { DiscoveredSession, SessionProvider } from '../../shared/sessions.js';
import type {
  BackupSessionMeta,
  SessionSyncDecision,
  SessionSyncRelation,
  TrashLocalSessionsRequest,
  TrashLocalSessionsResult,
} from '../../shared/session-sync.js';
import { sessionProviderSchema } from '../../shared/sessions.js';
import {
  sessionSyncDecisionOptions,
  sessionSyncDecisionSchema,
  keptCopySeparator,
  sessionSyncItemSchema,
  sessionSyncResultSchema,
  trashLocalSessionsResultSchema,
  trashLocalSessionsSchema,
  type SessionSyncItem,
  type SessionSyncResult,
} from '../../shared/session-sync.js';
import { isPathInside, loadRepositories } from '../config/store.js';
import { isSystemNoise, messageText } from './content-preview.js';
import { movePathToTrash } from '../system/trash.js';
import {
  BackupRepoError,
  alignToRemote,
  claimBackupOwnership,
  commitAll,
  deviceName,
  fetchBackupRemote,
  isFleetBackupRepository,
  pushBackup,
  recordSyncResult,
  remoteHead,
  requireBackupBinding,
  withBackupLock,
  type BackupBinding,
  type BackupRepoOptions,
} from './backup-repo.js';
import {
  listBackupSessions,
  readBackupMeta,
  readBackupTranscript,
  writeBackupSession,
  writeBackupTombstone,
} from './backup-store.js';
import {
  autoActionFor,
  commonPrefixLength,
  completeContent,
  contentRelation,
  presenceRelation,
  splitTranscript,
} from './compare.js';
import {
  discoverSessions,
  encodeClaudeProjectPath,
  localProjectPaths,
  sessionProviderRoot,
} from './discovery.js';

/**
 * 一次「同步会话」做的事，按顺序就这四步：
 *   1. 收下另一台电脑的最新备份（fetch 后把备份仓对齐到远端）
 *   2. 把本机每条会话和备份比一比
 *   3. 能自动定的自动定：谁更全就用谁；本机没有的会话写回本机
 *   4. 剩下真分叉和「另一台删了本机还在」的，交给用户选，最后统一 push 一次
 */

export interface SessionSyncOptions extends BackupRepoOptions {
  repositories?: RepositoriesConfig;
  claudeHome?: string;
  codexHome?: string;
}

interface SyncContext {
  binding: BackupBinding;
  /** 这次没连上私有 Git，只在本机备份。 */
  offline: boolean;
  repositories: RepositoriesConfig;
  device: string;
  now: Date;
  providerRoots: Record<SessionProvider, string>;
  projectPaths: Map<string, string>;
  notes: string[];
}

/** 单个会话超过这个体积时提醒一次：每次同步都会在 Git 里留一份新副本。 */
const largeSessionBytes = 20 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * 备份是从这个文件写出去的：只要文件在那之后没有再被修改，且大小一致，
 * 内容就必然和备份一致。省掉一次几十 MB 的读取和逐行比较。
 */
function unchangedSinceBackup(local: DiscoveredSession, meta: BackupSessionMeta): boolean {
  if (local.bytes !== meta.bytes) return false;
  return new Date(local.modifiedAt).getTime() <= new Date(meta.updatedAt).getTime();
}

function sessionKey(provider: SessionProvider, providerSessionId: string): string {
  return `${provider}:${providerSessionId}`;
}

/** 读本机会话内容。写到一半的最后一行不参与比对，和写进备份的口径保持一致。 */
async function readContent(filePath: string): Promise<string | null> {
  const content = await readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return content === null ? null : completeContent(content);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function buildContext(options: SessionSyncOptions): Promise<SyncContext> {
  const binding = await requireBackupBinding(options);
  const repositories = options.repositories ?? (await loadRepositories());
  const discoveryInput = { repositories, claudeHome: options.claudeHome, codexHome: options.codexHome };
  return {
    binding,
    offline: false,
    repositories,
    device: deviceName(),
    now: options.now ?? new Date(),
    providerRoots: {
      claude: sessionProviderRoot(discoveryInput, 'claude'),
      codex: sessionProviderRoot(discoveryInput, 'codex'),
    },
    projectPaths: await localProjectPaths(repositories),
    notes: [],
  };
}

/** 会话文件在 provider 目录里的相对位置，跨电脑恢复时用得上。 */
function relativeSourcePath(context: SyncContext, session: DiscoveredSession): string | null {
  const root = context.providerRoots[session.provider];
  if (!isPathInside(root, session.sourcePath)) return null;
  return path.relative(root, session.sourcePath);
}

/**
 * 决定备份里的会话应该写到本机哪里：
 * Claude 的目录名编码了项目绝对路径，两台电脑不一样，所以优先按本机项目目录重建；
 * 找不到对应项目时原样按备份里的相对路径落地，至少能在列表里看到、能预览。
 */
function restoreTargetPath(context: SyncContext, meta: BackupSessionMeta): string | null {
  const root = context.providerRoots[meta.provider];
  if (meta.provider === 'claude') {
    const localProject = context.projectPaths.get(meta.projectId) ?? meta.projectPath;
    if (localProject) {
      return path.join(root, 'projects', encodeClaudeProjectPath(localProject), `${meta.providerSessionId}.jsonl`);
    }
  }
  if (meta.sourceRelativePath) {
    const target = path.join(root, meta.sourceRelativePath);
    return isPathInside(root, target) ? target : null;
  }
  if (meta.provider === 'codex') {
    return path.join(root, 'sessions', 'restored', `rollout-${meta.providerSessionId}.jsonl`);
  }
  return null;
}

function backupDetails(context: SyncContext, session: DiscoveredSession) {
  return {
    title: session.title,
    projectId: session.projectId,
    projectPath: session.projectPath,
    repositoryName: session.repositoryName,
    lastActivityAt: session.lastActivityAt,
    sourceRelativePath: relativeSourcePath(context, session),
    messageCount: session.messageCount,
  };
}

function detailsFromMeta(meta: BackupSessionMeta) {
  return {
    title: meta.title,
    projectId: meta.projectId,
    projectPath: meta.projectPath,
    repositoryName: meta.repositoryName,
    lastActivityAt: meta.lastActivityAt,
    sourceRelativePath: meta.sourceRelativePath,
    messageCount: meta.messageCount,
  };
}

/**
 * 项目身份有强弱之分：`remote:` 由 Git 远端推导，两台电脑上必然一致，跨机器可用；
 * `local:` 只是本机路径的哈希，换台电脑就对不上；`unknown:` 什么也说明不了。
 */
function projectIdStrength(projectId: string): number {
  if (projectId.startsWith('remote:')) return 2;
  if (projectId.startsWith('local:')) return 1;
  return 0;
}

/**
 * 备份里已经记下的项目身份，不要被这台电脑更弱的判断盖掉。
 * 典型场景：会话从另一台电脑恢复过来，本机没登记这个项目，但备份里记着远端推导的 projectId。
 */
function mergedDetails(context: SyncContext, local: DiscoveredSession, previous: BackupSessionMeta | null) {
  const details = backupDetails(context, local);
  if (!previous || projectIdStrength(details.projectId) >= projectIdStrength(previous.projectId)) return details;
  return {
    ...details,
    projectId: previous.projectId,
    projectPath: details.projectPath ?? previous.projectPath,
    repositoryName: details.repositoryName ?? previous.repositoryName,
    sourceRelativePath: details.sourceRelativePath ?? previous.sourceRelativePath,
  };
}

/** 把本机会话写进备份仓；没有现成内容时直接从源文件拷贝，不经过字符串。 */
async function backupFromLocal(
  context: SyncContext,
  local: DiscoveredSession,
  previous: BackupSessionMeta | null,
  content?: string,
): Promise<void> {
  await writeBackupSession({
    backupPath: context.binding.backupPath,
    provider: local.provider,
    providerSessionId: local.providerSessionId,
    ...(content === undefined ? { sourcePath: local.sourcePath } : { content }),
    device: context.device,
    now: context.now,
    details: mergedDetails(context, local, previous),
  });
}

/** 把备份里的会话写回本机；无法确定落点时返回 false 并记一条说明。 */
async function restoreToLocal(context: SyncContext, meta: BackupSessionMeta, content: string): Promise<boolean> {
  const target = restoreTargetPath(context, meta);
  if (!target) {
    context.notes.push(`${meta.title ?? meta.providerSessionId}：备份里没有足够信息确定本机位置，已跳过`);
    return false;
  }
  await writeFileAtomic(target, content);
  // 连同备份时间一起还原（`cp -p` 的做法）：否则这台电脑上的文件永远比备份"新"，
  // 「没动过就跳过」的快速通道就再也命中不了，每次同步都要重读几百 MB。
  const backedUpAt = new Date(meta.updatedAt);
  if (Number.isFinite(backedUpAt.getTime())) {
    await utimes(target, backedUpAt, backedUpAt).catch(() => undefined);
  }
  return true;
}

interface PairedSession {
  provider: SessionProvider;
  providerSessionId: string;
  local: DiscoveredSession | null;
  meta: BackupSessionMeta | null;
  hasBackupTranscript: boolean;
}

async function pairSessions(
  context: SyncContext,
  options: SessionSyncOptions,
  only?: { provider: SessionProvider; providerSessionId: string },
): Promise<PairedSession[]> {
  const [discovery, backups] = await Promise.all([
    discoverSessions({
      repositories: context.repositories,
      claudeHome: options.claudeHome,
      codexHome: options.codexHome,
      recentDays: null,
      only,
    }),
    listBackupSessions(context.binding.backupPath),
  ]);
  const paired = new Map<string, PairedSession>();
  for (const session of discovery.sessions) {
    if (!session.readable) continue;
    paired.set(sessionKey(session.provider, session.providerSessionId), {
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      local: session,
      meta: null,
      hasBackupTranscript: false,
    });
  }
  for (const entry of backups) {
    if (only && (entry.meta.provider !== only.provider || entry.meta.providerSessionId !== only.providerSessionId)) {
      continue;
    }
    const key = sessionKey(entry.meta.provider, entry.meta.providerSessionId);
    const existing = paired.get(key);
    if (existing) {
      existing.meta = entry.meta;
      existing.hasBackupTranscript = entry.hasTranscript;
      continue;
    }
    paired.set(key, {
      provider: entry.meta.provider,
      providerSessionId: entry.meta.providerSessionId,
      local: null,
      meta: entry.meta,
      hasBackupTranscript: entry.hasTranscript,
    });
  }
  return [...paired.values()];
}

/** 取分叉点之后的第一句可读内容，供界面并排展示。 */
function firstDivergedText(lines: readonly string[] | null, from: number): string | null {
  if (!lines) return null;
  for (const line of lines.slice(from)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const text = messageText(value)?.text;
    if (text && !isSystemNoise(text)) return text.slice(0, 120);
  }
  return null;
}

function pendingItem(
  pair: PairedSession,
  relation: SessionSyncRelation,
  localLines: string[] | null,
  backupLines: string[] | null,
): SessionSyncItem {
  const commonLines = localLines && backupLines ? commonPrefixLength(localLines, backupLines) : 0;
  return sessionSyncItemSchema.parse({
    provider: pair.provider,
    providerSessionId: pair.providerSessionId,
    title: pair.local?.title ?? pair.meta?.title ?? null,
    projectName:
      pair.local?.repositoryName
      ?? pair.meta?.repositoryName
      ?? pair.meta?.projectPath?.split(/[\\/]/).filter(Boolean).at(-1)
      ?? null,
    relation,
    localLines: localLines?.length ?? null,
    backupLines: backupLines?.length ?? null,
    commonLines,
    localFirstDiff: firstDivergedText(localLines, commonLines),
    backupFirstDiff: firstDivergedText(backupLines, commonLines),
    lastActivityAt: pair.local?.lastActivityAt ?? pair.meta?.lastActivityAt ?? null,
    backupDevice: pair.meta?.device ?? null,
    choices: sessionSyncDecisionOptions[relation],
  });
}

/**
 * 收下另一台电脑的最新备份。
 *
 * 备份仓的**内容**都能从本机会话重新生成，所以直接对齐远端最省事；
 * 唯一生成不回来的是**墓碑**（本机已经删掉的会话），对齐前先记下来，
 * 对齐后把还比远端新的那些补回去——否则离线时做的删除会被悄悄撤销。
 */
async function receiveRemote(context: SyncContext): Promise<void> {
  if (!context.binding.remoteName) return;
  const failure = await fetchBackupRemote(context.binding.backupPath, context.binding.remoteName);
  if (failure) {
    context.notes.push(`没有连上私有 Git（${failure}），这次只在本机备份`);
    context.offline = true;
    return;
  }
  const head = await remoteHead(context.binding.backupPath, context.binding.remoteName);
  if (!head) return;

  const localTombstones = (await listBackupSessions(context.binding.backupPath))
    .filter((entry) => entry.meta.deleted)
    .map((entry) => entry.meta);
  await alignToRemote(context.binding.backupPath, head);
  if (localTombstones.length === 0) return;

  const afterAlign = new Map(
    (await listBackupSessions(context.binding.backupPath))
      .map((entry) => [sessionKey(entry.meta.provider, entry.meta.providerSessionId), entry.meta]),
  );
  for (const tombstone of localTombstones) {
    const remote = afterAlign.get(sessionKey(tombstone.provider, tombstone.providerSessionId));
    // 远端那份更新（比如另一台电脑选了「保留本机」把内容写了回来）就听远端的。
    if (remote && new Date(remote.updatedAt).getTime() >= new Date(tombstone.updatedAt).getTime()) continue;
    await writeBackupTombstone({
      backupPath: context.binding.backupPath,
      provider: tombstone.provider,
      providerSessionId: tombstone.providerSessionId,
      device: tombstone.device,
      now: new Date(tombstone.deletedAt ?? tombstone.updatedAt),
      previous: remote ?? tombstone,
    });
  }
}

export async function runSessionSync(options: SessionSyncOptions = {}): Promise<SessionSyncResult> {
  return withBackupLock(() => syncWithinLock(options));
}

async function syncWithinLock(options: SessionSyncOptions): Promise<SessionSyncResult> {
  const context = await buildContext(options);
  const ranAt = context.now.toISOString();
  try {
    await receiveRemote(context);
    // 对齐远端可能把旧格式内容（旧版备份仓的 vault.yaml / events / objects）重新拉回工作树，
    // clean 也可能把未跟踪的 marker 扫掉。在写会话之前把备份仓收回 Fleet 名下，
    // 这些多余的东西就会跟着这次同步的提交一起从远端消失。墓碑在 sessions/ 下，不受影响。
    await claimBackupOwnership(context.binding.backupPath);
    const pairs = await pairSessions(context, options);
    let backedUp = 0;
    let restored = 0;
    let skipped = 0;
    const pending: SessionSyncItem[] = [];
    const largeSessions: number[] = [];

    for (const pair of pairs) {
      // 会话文件动辄几十 MB。备份之后没有再写过的文件不可能有新内容，
      // 直接按 stat 的大小和修改时间跳过，不必读进来逐行比。
      if (pair.local && pair.meta && !pair.meta.deleted && unchangedSinceBackup(pair.local, pair.meta)) {
        skipped += 1;
        continue;
      }
      // 一边没有内容时不用读文件，看"有没有"就能定关系。
      const presence = presenceRelation({
        hasLocal: Boolean(pair.local),
        hasBackup: pair.hasBackupTranscript,
        backupDeleted: pair.meta?.deleted,
      });
      const localContent = presence === null && pair.local ? await readContent(pair.local.sourcePath) : null;
      const backupContent = presence === null
        ? await readBackupTranscript(context.binding.backupPath, pair.provider, pair.providerSessionId)
        : null;
      const localLines = localContent === null ? null : splitTranscript(localContent);
      const backupLines = backupContent === null ? null : splitTranscript(backupContent);
      const relation = presence ?? contentRelation(localLines ?? [], backupLines ?? []);

      switch (autoActionFor(relation)) {
        case 'skip':
          skipped += 1;
          break;
        case 'write-backup':
          if (!pair.local) break;
          await backupFromLocal(context, pair.local, pair.meta, localContent ?? undefined);
          backedUp += 1;
          if (pair.local.bytes >= largeSessionBytes) largeSessions.push(pair.local.bytes);
          break;
        case 'write-local': {
          if (!pair.meta) break;
          const content = backupContent
            ?? (await readBackupTranscript(context.binding.backupPath, pair.provider, pair.providerSessionId));
          if (content === null) break;
          if (await restoreToLocal(context, pair.meta, content)) restored += 1;
          break;
        }
        case 'ask':
          pending.push(pendingItem(pair, relation, localLines, backupLines));
          break;
      }
    }

    if (largeSessions.length > 0) {
      const largest = formatMegabytes(Math.max(...largeSessions));
      context.notes.push(
        `本次有 ${largeSessions.length} 条超大会话（最大 ${largest}），它们每次变化都会在备份仓里留一份新副本，仓库会明显变大`,
      );
    }
    const pushed = await publish(context, `同步会话：备份 ${backedUp} 条 · 恢复 ${restored} 条`);
    await recordSyncResult({ at: ranAt, error: null }, options);
    return sessionSyncResultSchema.parse({
      ranAt,
      backedUp,
      restored,
      skipped,
      pending,
      pushed,
      notes: context.notes,
      message: summarize(backedUp, restored, skipped, pending.length),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步没有完成';
    await recordSyncResult({ at: ranAt, error: message }, options).catch(() => undefined);
    throw error instanceof BackupRepoError ? error : new BackupRepoError(message);
  }
}

function summarize(backedUp: number, restored: number, skipped: number, pending: number): string {
  const parts: string[] = [];
  if (backedUp) parts.push(`备份 ${backedUp} 条`);
  if (restored) parts.push(`恢复 ${restored} 条`);
  if (skipped) parts.push(`${skipped} 条没有变化`);
  if (pending) parts.push(`${pending} 条需要你决定`);
  return parts.length ? `同步完成：${parts.join(' · ')}` : '同步完成：没有需要处理的会话';
}

/**
 * 提交并上传一次。上一轮没推上去的提交会在这里一起带上去。
 * 上传失败不算这次同步失败——本机备份已经写好了，只是如实说一声。
 */
async function publish(context: SyncContext, message: string): Promise<boolean> {
  await commitAll(context.binding.backupPath, message);
  if (!context.binding.remoteName || context.offline) return false;
  const failure = await pushBackup(context.binding.backupPath, context.binding.remoteName);
  if (!failure) return true;
  context.notes.push(`已在本机备份，但没能上传到私有 Git（${failure}），下次同步会一起带上去`);
  return false;
}

export const sessionSyncResolveSchema = z.object({
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  decision: sessionSyncDecisionSchema,
});
export type SessionSyncResolveRequest = z.infer<typeof sessionSyncResolveSchema>;

const decisionMessages: Record<SessionSyncDecision, string> = {
  'keep-local': '保留本机版本',
  'keep-backup': '保留另一台电脑的版本',
  'keep-both': '两份都留',
  'delete-local': '跟随另一台电脑删除',
};

/** 应用用户对一条会话的选择：用本机 / 用备份 / 两份都留 / 跟随删除。 */
export async function resolveSessionSync(
  request: SessionSyncResolveRequest,
  options: SessionSyncOptions = {},
): Promise<SessionSyncResult> {
  const input = sessionSyncResolveSchema.parse(request);
  return withBackupLock(() => resolveWithinLock(input, options));
}

async function resolveWithinLock(
  input: SessionSyncResolveRequest,
  options: SessionSyncOptions,
): Promise<SessionSyncResult> {
  const context = await buildContext(options);
  const ranAt = context.now.toISOString();
  const [pair] = await pairSessions(context, options, {
    provider: input.provider,
    providerSessionId: input.providerSessionId,
  });
  if (!pair) throw new BackupRepoError('这条会话已经不在列表里了，请重新同步一次。');

  // 按需读：跟随删除两边都不用读，别为一条几十 MB 的会话白跑一趟。
  const requireLocal = async (): Promise<{ session: DiscoveredSession; content: string }> => {
    const content = pair.local ? await readContent(pair.local.sourcePath) : null;
    if (!pair.local || content === null) throw new BackupRepoError('本机已经没有这条会话了。');
    return { session: pair.local, content };
  };
  const requireBackup = async (): Promise<{ meta: BackupSessionMeta; content: string }> => {
    const content = pair.hasBackupTranscript
      ? await readBackupTranscript(context.binding.backupPath, pair.provider, pair.providerSessionId)
      : null;
    if (!pair.meta || content === null) throw new BackupRepoError('备份里没有这条会话的内容。');
    return { meta: pair.meta, content };
  };
  let backedUp = 0;
  let restored = 0;

  switch (input.decision) {
    case 'keep-local': {
      const local = await requireLocal();
      await backupFromLocal(context, local.session, pair.meta, local.content);
      backedUp += 1;
      break;
    }
    case 'keep-backup': {
      const backup = await requireBackup();
      if (await restoreToLocal(context, backup.meta, backup.content)) restored += 1;
      break;
    }
    case 'keep-both': {
      const backup = await requireBackup();
      const local = await requireLocal();
      const copyId =
        `${pair.providerSessionId}${keptCopySeparator}${context.device.replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 120);
      const copyMeta: BackupSessionMeta = {
        ...backup.meta,
        providerSessionId: copyId,
        sourceRelativePath: null,
        title: backup.meta.title ? `${backup.meta.title}（来自 ${backup.meta.device}）` : null,
      };
      if (await restoreToLocal(context, copyMeta, backup.content)) restored += 1;
      context.notes.push(
        '另存的那份用了新的文件名，可以在列表里查看和搜索；provider 能否直接 resume 取决于它自己的实现',
      );
      await writeBackupSession({
        backupPath: context.binding.backupPath,
        provider: pair.provider,
        providerSessionId: copyId,
        content: backup.content,
        device: backup.meta.device,
        now: context.now,
        details: detailsFromMeta(copyMeta),
      });
      await backupFromLocal(context, local.session, pair.meta, local.content);
      backedUp += 2;
      break;
    }
    case 'delete-local': {
      if (pair.local) await movePathToTrash(pair.local.sourcePath);
      await writeBackupTombstone({
        backupPath: context.binding.backupPath,
        provider: pair.provider,
        providerSessionId: pair.providerSessionId,
        device: context.device,
        now: context.now,
        previous: pair.meta,
      });
      break;
    }
  }

  const pushed = await publish(context, `处理会话冲突：${decisionMessages[input.decision]}`);
  await recordSyncResult({ at: ranAt, error: null }, options);
  return sessionSyncResultSchema.parse({
    ranAt,
    backedUp,
    restored,
    skipped: 0,
    pending: [],
    pushed,
    notes: context.notes,
    message: '已按你的选择处理这条会话',
  });
}

/** 删除本机会话：默认只移到系统废纸篓，可选同时在备份里留一条删除记录。 */
export async function trashLocalSession(
  request: { provider: SessionProvider; providerSessionId: string; alsoRemoveFromBackup?: boolean },
  options: SessionSyncOptions = {},
): Promise<{ trashed: boolean; backupRemoved: boolean }> {
  const result = await trashLocalSessions({
    items: [{ provider: request.provider, providerSessionId: request.providerSessionId }],
    alsoRemoveFromBackup: request.alsoRemoveFromBackup ?? false,
  }, options);
  const [item] = result.items;
  if (!item || item.error) throw new BackupRepoError(item?.error ?? '找不到这条本机会话，可能已经删除了。');
  return { trashed: item.trashed, backupRemoved: item.backupRemoved };
}

/**
 * 批量删除在同一把备份锁内完成：先做整批预检，再逐条移入废纸篓；
 * 单项失败不阻断其余项，成功项的墓碑最后只提交和上传一次。
 */
export async function trashLocalSessions(
  request: TrashLocalSessionsRequest,
  options: SessionSyncOptions = {},
): Promise<TrashLocalSessionsResult> {
  const input = trashLocalSessionsSchema.parse(request);
  return withBackupLock(() => trashManyWithinLock(input, options));
}

async function trashManyWithinLock(
  request: TrashLocalSessionsRequest,
  options: SessionSyncOptions,
): Promise<TrashLocalSessionsResult> {
  // 选择跨机删除时，先确认备份仓仍可用；失败时整批本机文件保持不动。
  const binding = request.alsoRemoveFromBackup ? await requireBackupBinding(options) : null;
  if (binding && !(await isFleetBackupRepository(binding.backupPath))) {
    throw new BackupRepoError('当前备份目录已不是 Moo Fleet 管理的会话备份仓。请重新设置备份位置；本机会话不受影响。');
  }
  const repositories = options.repositories ?? (await loadRepositories());
  const discovery = await discoverSessions({
    repositories,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    recentDays: null,
  });
  const requestedKeys = new Set(request.items.map((item) => sessionKey(item.provider, item.providerSessionId)));
  const sessionsByKey = new Map(
    discovery.sessions
      .filter((session) => requestedKeys.has(sessionKey(session.provider, session.providerSessionId)))
      .map((session) => [sessionKey(session.provider, session.providerSessionId), session]),
  );
  const items: TrashLocalSessionsResult['items'] = [];
  const notes: string[] = [];

  for (const target of request.items) {
    const session = sessionsByKey.get(sessionKey(target.provider, target.providerSessionId));
    if (!session) {
      items.push({ ...target, trashed: false, backupRemoved: false, error: '找不到这条本机会话，可能已经删除了。' });
      continue;
    }
    try {
      await movePathToTrash(session.sourcePath);
      items.push({ ...target, trashed: true, backupRemoved: false, error: null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '系统废纸篓操作失败';
      items.push({ ...target, trashed: false, backupRemoved: false, error: `移到系统废纸篓失败：${reason}` });
    }
  }

  if (!binding) return trashLocalSessionsResultSchema.parse({ items, pushed: false, notes });

  const now = options.now ?? new Date();
  for (const item of items) {
    if (!item.trashed) continue;
    try {
      const previous = await readBackupMeta(binding.backupPath, item.provider, item.providerSessionId);
      await writeBackupTombstone({
        backupPath: binding.backupPath,
        provider: item.provider,
        providerSessionId: item.providerSessionId,
        device: deviceName(),
        now,
        previous,
      });
      item.backupRemoved = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '备份删除记录写入失败';
      item.error = `本机会话已进入废纸篓，但备份删除记录写入失败：${reason}`;
    }
  }

  let pushed = false;
  const backupRemoved = items.filter((item) => item.backupRemoved).length;
  if (backupRemoved > 0) {
    try {
      const committed = await commitAll(binding.backupPath, `批量删除会话备份：${backupRemoved} 条`);
      if (committed && binding.remoteName) {
        const failure = await pushBackup(binding.backupPath, binding.remoteName);
        if (failure) notes.push(`删除记录已保存在本机备份，但没能上传到私有 Git（${failure}），下次同步会一起带上去`);
        else pushed = true;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '保存备份提交失败';
      notes.push(`本机会话已进入废纸篓，但删除记录没有完成 Git 提交（${reason}）`);
    }
  }
  return trashLocalSessionsResultSchema.parse({ items, pushed, notes });
}
