import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
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
import { loadSessionVaultStatus } from './vault.js';

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

  await movePathToTrash(sourcePath);

  let backupDeletion: LocalSessionDeleteResult['backupDeletion'] = 'not-backed-up';
  let syncPending = false;
  let followup = '原始会话文件已移到系统废纸篓';
  if (catalogError) {
    backupDeletion = 'pending';
    syncPending = true;
    followup = `本地文件已删除，但暂时无法更新备份记录：${safeMessage(catalogError, '会话备份不可用')}`;
  } else if (existing?.session.lifecycleState === 'trashed') {
    backupDeletion = 'already-trashed';
  } else if (existing) {
    try {
      await mutateSessionLifecycle(
        sessionId,
        'trash',
        existing.session.lifecycleVersion,
        options.vault ?? {},
      );
      backupDeletion = 'recorded';
      followup = '本地文件已移到系统废纸篓，删除记录也已写入会话备份';
      const status = await loadSessionVaultStatus(options.vault);
      if (status.binding?.remoteSyncEnabled) {
        try {
          await pushSessionVault(options.vault);
        } catch (error) {
          syncPending = true;
          followup = `${followup}；远端同步待重试：${safeMessage(error, '网络或远端暂不可用')}`;
        }
      }
    } catch (error) {
      backupDeletion = 'pending';
      syncPending = true;
      followup = `本地文件已删除，但备份删除记录待重试：${safeMessage(error, '会话备份暂不可写')}`;
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
