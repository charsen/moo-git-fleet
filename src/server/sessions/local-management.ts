import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  DiscoveredSession,
  LocalSessionDetail,
  LocalSessionDeleteRequest,
  LocalSessionDeleteResult,
  SessionProvider,
} from '../../shared/sessions.js';
import {
  localSessionDetailSchema,
  localSessionDeleteRequestSchema,
  localSessionDeleteResultSchema,
} from '../../shared/sessions.js';
import { isPathInside, loadRepositories } from '../config/store.js';
import { movePathToTrash } from '../system/trash.js';
import { SessionCatalogError, sessionVaultSessionDetail } from './catalog.js';
import { previewSessionContent } from './content-preview.js';
import {
  discoverSessions,
  sessionProviderRoot,
} from './discovery.js';
import { logicalSessionId, type SessionCheckpointWorkflowOptions } from './handoff.js';
import { mutateSessionLifecycle } from './lifecycle.js';
import { pushSessionVault } from './sync.js';
import { loadSessionVaultStatus, resolveSessionVaultBindingPath } from './vault.js';

const pendingDeletionSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.object({
    sessionId: z.string().min(1).max(255),
    provider: z.enum(['claude', 'codex']),
    providerSessionId: z.string().min(1).max(255),
    createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(5_000),
}).strict();
type PendingDeletion = z.infer<typeof pendingDeletionSchema>['items'][number];
let pendingDeletionQueue = Promise.resolve();

export class LocalSessionManagementError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'LocalSessionManagementError';
  }
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 1_500) : fallback;
}

function pendingDeletionPath(options: SessionCheckpointWorkflowOptions): string {
  return path.join(path.dirname(resolveSessionVaultBindingPath(options.vault)), 'pending-session-deletions.json');
}

async function readPendingDeletions(options: SessionCheckpointWorkflowOptions): Promise<PendingDeletion[]> {
  try {
    return pendingDeletionSchema.parse(JSON.parse(await readFile(pendingDeletionPath(options), 'utf8'))).items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new LocalSessionManagementError('本机删除待办记录损坏，请先检查应用数据目录');
  }
}

async function writePendingDeletions(
  items: PendingDeletion[],
  options: SessionCheckpointWorkflowOptions,
): Promise<void> {
  const filePath = pendingDeletionPath(options);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(pendingDeletionSchema.parse({ schemaVersion: 1, items }), null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function updatePendingDeletions<T>(
  options: SessionCheckpointWorkflowOptions,
  handler: (items: PendingDeletion[]) => Promise<{ items: PendingDeletion[]; result: T }>,
): Promise<T> {
  const task = pendingDeletionQueue.then(async () => {
    const updated = await handler(await readPendingDeletions(options));
    await writePendingDeletions(updated.items, options);
    return updated.result;
  });
  pendingDeletionQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function enqueuePendingDeletion(
  item: PendingDeletion,
  options: SessionCheckpointWorkflowOptions,
): Promise<void> {
  await updatePendingDeletions(options, async (items) => ({
    items: [...items.filter((current) => current.sessionId !== item.sessionId), item],
    result: undefined,
  }));
}

async function removePendingDeletion(
  sessionId: string,
  options: SessionCheckpointWorkflowOptions,
): Promise<void> {
  await updatePendingDeletions(options, async (items) => ({
    items: items.filter((item) => item.sessionId !== sessionId),
    result: undefined,
  }));
}

export interface PendingLocalSessionDeletionResult {
  resolvedSessionIds: string[];
  pendingSessionIds: string[];
  syncPending: boolean;
  message: string;
}

export async function retryPendingLocalSessionDeletions(
  options: SessionCheckpointWorkflowOptions = {},
): Promise<PendingLocalSessionDeletionResult> {
  return updatePendingDeletions(options, async (items) => {
    const remaining: PendingDeletion[] = [];
    const resolvedSessionIds: string[] = [];
    for (const item of items) {
      try {
        const detail = await sessionVaultSessionDetail(item.sessionId, options.vault ?? {});
        if (detail.session.lifecycleState !== 'trashed') {
          await mutateSessionLifecycle(
            item.sessionId,
            'trash',
            detail.session.lifecycleVersion,
            options.vault ?? {},
          );
        }
        resolvedSessionIds.push(item.sessionId);
      } catch (error) {
        if (error instanceof SessionCatalogError && error.statusCode === 404) {
          resolvedSessionIds.push(item.sessionId);
          continue;
        }
        remaining.push(item);
      }
    }

    let syncPending = remaining.length > 0;
    let syncMessage = '';
    if (resolvedSessionIds.length > 0) {
      try {
        const status = await loadSessionVaultStatus(options.vault);
        if (status.binding?.remoteSyncEnabled) await pushSessionVault(options.vault);
      } catch (error) {
        syncPending = true;
        syncMessage = `；远端同步待重试：${safeMessage(error, '网络或远端暂不可用')}`;
      }
    }
    return {
      items: remaining,
      result: {
        resolvedSessionIds,
        pendingSessionIds: remaining.map((item) => item.sessionId),
        syncPending,
        message: remaining.length > 0
          ? `${remaining.length} 条删除记录仍待对齐${syncMessage}`
          : `删除记录已对齐${syncMessage}`,
      },
    };
  });
}

async function resolveLocalSession(
  provider: SessionProvider,
  providerSessionId: string,
  options: SessionCheckpointWorkflowOptions,
): Promise<{
  session: DiscoveredSession;
  discoveryInput: {
    repositories: Awaited<ReturnType<typeof loadRepositories>>;
    claudeHome?: string;
    codexHome?: string;
    recentDays: null;
  };
}> {
  const repositories = options.repositories ?? await loadRepositories();
  const discoveryInput = {
    repositories,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    recentDays: null as const,
  };
  const discovery = await discoverSessions(discoveryInput);
  const session = discovery.sessions.find((item) => (
    item.provider === provider && item.providerSessionId === providerSessionId
  ));
  if (!session) throw new LocalSessionManagementError('本机会话不存在或已经删除', 404);
  return { session, discoveryInput };
}

export async function localSessionDetail(
  provider: SessionProvider,
  providerSessionId: string,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<LocalSessionDetail> {
  const { session } = await resolveLocalSession(provider, providerSessionId, options);
  return localSessionDetailSchema.parse({
    schemaVersion: 1,
    session,
    content: await previewSessionContent(session.sourcePath, { maxItems: 200 }),
  });
}

export async function deleteLocalSession(
  provider: SessionProvider,
  providerSessionId: string,
  request: LocalSessionDeleteRequest,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<LocalSessionDeleteResult> {
  localSessionDeleteRequestSchema.parse(request);
  const { session, discoveryInput } = await resolveLocalSession(provider, providerSessionId, options);

  const discoveredInfo = await lstat(session.sourcePath).catch(() => null);
  if (!discoveredInfo?.isFile() || discoveredInfo.isSymbolicLink()) {
    throw new LocalSessionManagementError('会话文件已变化，请重新扫描后再删除');
  }
  const configuredRoot = sessionProviderRoot(discoveryInput, provider);
  const [providerRoot, sourcePath] = await Promise.all([
    realpath(configuredRoot),
    realpath(session.sourcePath),
  ]).catch(() => {
    throw new LocalSessionManagementError('无法确认会话文件的安全边界，请重新扫描后再试');
  });
  const sourceInfo = await lstat(sourcePath).catch(() => null);
  if (
    !sourceInfo?.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourcePath === providerRoot ||
    !isPathInside(providerRoot, sourcePath) ||
    path.extname(sourcePath).toLowerCase() !== '.jsonl'
  ) {
    throw new LocalSessionManagementError('会话文件不在 Claude/Codex 白名单目录内，已停止删除');
  }

  const sessionId = logicalSessionId(provider, providerSessionId);
  let existing: Awaited<ReturnType<typeof sessionVaultSessionDetail>> | null = null;
  let catalogError: unknown = null;
  try {
    existing = await sessionVaultSessionDetail(sessionId, options.vault ?? {});
  } catch (error) {
    if (!(error instanceof SessionCatalogError) || error.statusCode !== 404) catalogError = error;
  }

  const deletion: PendingDeletion = {
    sessionId,
    provider,
    providerSessionId,
    createdAt: new Date().toISOString(),
  };
  const shouldTrackDeletion = Boolean(catalogError || (existing && existing.session.lifecycleState !== 'trashed'));
  if (shouldTrackDeletion) await enqueuePendingDeletion(deletion, options);
  try {
    await movePathToTrash(sourcePath);
  } catch (error) {
    if (shouldTrackDeletion) await removePendingDeletion(sessionId, options).catch(() => undefined);
    throw error;
  }

  let backupDeletion: LocalSessionDeleteResult['backupDeletion'] = 'not-backed-up';
  let syncPending = false;
  let followup = '原始会话文件已移到系统废纸篓';
  if (existing?.session.lifecycleState === 'trashed') {
    backupDeletion = 'already-trashed';
  } else if (shouldTrackDeletion) {
    try {
      const retried = await retryPendingLocalSessionDeletions(options);
      const pending = retried.pendingSessionIds.includes(sessionId);
      backupDeletion = pending ? 'pending' : 'recorded';
      syncPending = retried.syncPending;
      followup = pending
        ? `本地文件已删除，备份删除记录会在下次 Pull 或备份时自动重试：${safeMessage(catalogError, retried.message)}`
        : `本地文件已移到系统废纸篓，${retried.message}`;
    } catch (error) {
      backupDeletion = 'pending';
      syncPending = true;
      followup = `本地文件已删除，备份删除记录会自动重试：${safeMessage(error, '会话备份暂不可写')}`;
    }
  }

  return localSessionDeleteResultSchema.parse({
    schemaVersion: 1,
    provider,
    providerSessionId,
    movedToTrash: true,
    backupDeletion,
    syncPending,
    message: followup,
  });
}
