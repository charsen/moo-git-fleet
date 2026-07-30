import { z } from 'zod';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import type { DiscoveredSession, SessionProvider } from '../../shared/sessions.js';
import type { LocalSessionBackupState, LocalSessionList, LocalSessionPreviewPayload } from '../../shared/session-sync.js';
import { localSessionItemSchema, localSessionListSchema, localSessionPreviewPayloadSchema } from '../../shared/session-sync.js';
import { loadRepositories } from '../config/store.js';
import { deviceName, loadBackupBinding, type BackupRepoOptions } from './backup-repo.js';
import { listBackupSessions } from './backup-store.js';
import { previewSessionContent } from './content-preview.js';
import { discoverSessions } from './discovery.js';

/**
 * 本机会话列表：直接读这台电脑上的 Claude / Codex 会话文件，不需要先连 Git。
 * 列表里的备份状态只用文件大小和时间做粗判，真正的比对在「同步会话」里做。
 */

export interface LocalSessionOptions extends BackupRepoOptions {
  repositories?: RepositoriesConfig;
  claudeHome?: string;
  codexHome?: string;
}

export async function listLocalSessions(options: LocalSessionOptions = {}): Promise<LocalSessionList> {
  const repositories = options.repositories ?? (await loadRepositories());
  const discovery = await discoverSessions({
    repositories,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    recentDays: null,
  });
  const binding = await loadBackupBinding(options).catch(() => null);
  const backups = binding ? await listBackupSessions(binding.backupPath) : [];
  const backupByKey = new Map(backups.map((entry) => [`${entry.meta.provider}:${entry.meta.providerSessionId}`, entry]));

  const items = discovery.sessions
    .map((session) => {
      const entry = backupByKey.get(`${session.provider}:${session.providerSessionId}`);
      const backupState: LocalSessionBackupState = !entry
        ? 'not-backed-up'
        : entry.meta.deleted
          ? 'deleted-in-backup'
          : entry.meta.bytes === session.bytes
            ? 'backed-up'
            : 'changed';
      return localSessionItemSchema.parse({
        ...session,
        backupState,
        backupDevice: entry?.meta.device ?? null,
        backupUpdatedAt: entry?.meta.updatedAt ?? null,
      });
    });

  const localKeys = new Set(discovery.sessions.map((session) => `${session.provider}:${session.providerSessionId}`));
  return localSessionListSchema.parse({
    scannedAt: discovery.scannedAt,
    device: deviceName(),
    backupConfigured: Boolean(binding),
    items,
    onlyInBackup: backups.filter(
      (entry) => !entry.meta.deleted && !localKeys.has(`${entry.meta.provider}:${entry.meta.providerSessionId}`),
    ).length,
    errors: discovery.errors.map((error) => ({
      provider: error.provider,
      path: error.path,
      message: error.message,
    })),
  });
}

/** 会话内容预览：直接读本机文件，不脱敏——这是你自己电脑上你自己的对话。 */
export async function localSessionPreview(
  request: { provider: SessionProvider; providerSessionId: string; maxItems?: number },
  options: LocalSessionOptions = {},
): Promise<LocalSessionPreviewPayload> {
  const repositories = options.repositories ?? (await loadRepositories());
  const discovery = await discoverSessions({
    repositories,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    recentDays: null,
    only: { provider: request.provider, providerSessionId: request.providerSessionId },
  });
  const session = discovery.sessions[0];
  if (!session) {
    const error = new Error('找不到这条本机会话，可能已经删除了。');
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  return localSessionPreviewPayloadSchema.parse({
    session,
    preview: await previewSessionContent(session.sourcePath, { maxItems: request.maxItems ?? 200 }),
  });
}
