import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { SessionVaultBinding, SessionVaultSyncStatus } from '../../shared/sessions.js';
import {
  sessionVaultManifestSchema,
  sessionVaultSyncStatusSchema,
} from '../../shared/sessions.js';
import { runGit, runGitText } from '../git/runner.js';
import { recoverCheckpointTransactionsWithinLock } from './checkpoint.js';
import { normalizeRemoteUrl } from './discovery.js';
import { redactSensitiveText } from './secrets.js';
import {
  loadSessionVaultStatus,
  resolveSessionVaultBindingPath,
  type SessionVaultServiceOptions,
} from './vault.js';
import { withSessionVaultLock } from './vault-lock.js';
import { recoverLifecycleTransactionsWithinLock } from './lifecycle.js';
import { recoverLineageTransactionsWithinLock } from './lineage.js';

const vaultBranch = 'main';

const persistedSyncStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().min(1).max(2_000).nullable(),
}).strict();
type PersistedSyncState = z.infer<typeof persistedSyncStateSchema>;

export interface SessionVaultSyncOptions extends SessionVaultServiceOptions {
  statePath?: string;
}

export type SessionVaultSyncErrorCode =
  | 'vault-not-configured'
  | 'remote-sync-disabled'
  | 'remote-privacy-unconfirmed'
  | 'remote-configuration-changed'
  | 'vault-worktree-dirty'
  | 'vault-branch-invalid'
  | 'vault-remote-unavailable'
  | 'vault-diverged'
  | 'vault-push-failed'
  | 'vault-pull-failed';

export class SessionVaultSyncError extends Error {
  constructor(
    readonly code: SessionVaultSyncErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionVaultSyncError';
  }
}

function resolveSyncStatePath(options: SessionVaultSyncOptions): string {
  return path.resolve(options.statePath ?? path.join(path.dirname(resolveSessionVaultBindingPath(options)), 'session-vault-sync.json'));
}

async function readPersistedSyncState(options: SessionVaultSyncOptions): Promise<PersistedSyncState> {
  let contents: string;
  try {
    contents = await readFile(resolveSyncStatePath(options), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schemaVersion: 1, lastAttemptAt: null, lastSuccessAt: null, lastError: null };
  }
  try {
    return persistedSyncStateSchema.parse(JSON.parse(contents));
  } catch {
    throw new SessionVaultSyncError('vault-not-configured', '本机 Session Vault 同步状态文件已损坏，请备份后移走该文件再重试');
  }
}

async function writePersistedSyncState(options: SessionVaultSyncOptions, state: PersistedSyncState): Promise<void> {
  const parsed = persistedSyncStateSchema.parse(state);
  const filePath = resolveSyncStatePath(options);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof SessionVaultSyncError) return redactSensitiveText(error.message).slice(0, 2_000);
  return 'Session Vault 远端同步失败；本机 checkpoint 已保留，请检查网络或远端权限后重试';
}

function remoteTrackingRef(remoteName: string): string {
  return `refs/remotes/${remoteName}/${vaultBranch}`;
}

function ensureRemoteName(remoteName: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) {
    throw new SessionVaultSyncError('remote-configuration-changed', 'Session Vault remote 名称不安全，请重新绑定');
  }
}

async function currentHead(vaultPath: string): Promise<string | null> {
  return runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null);
}

async function trackedRemoteHead(vaultPath: string, remoteName: string): Promise<string | null> {
  return runGitText(vaultPath, ['rev-parse', '--verify', `${remoteTrackingRef(remoteName)}^{commit}`]).catch(() => null);
}

async function aheadBehind(
  vaultPath: string,
  localHead: string | null,
  remoteHead: string | null,
): Promise<{ ahead: number; behind: number }> {
  if (!localHead && !remoteHead) return { ahead: 0, behind: 0 };
  if (localHead && !remoteHead) {
    const count = Number.parseInt(await runGitText(vaultPath, ['rev-list', '--count', localHead]), 10);
    return { ahead: Number.isFinite(count) ? count : 0, behind: 0 };
  }
  if (!localHead && remoteHead) {
    const count = Number.parseInt(await runGitText(vaultPath, ['rev-list', '--count', remoteHead]), 10);
    return { ahead: 0, behind: Number.isFinite(count) ? count : 0 };
  }
  const output = await runGitText(vaultPath, ['rev-list', '--left-right', '--count', `${localHead}...${remoteHead}`]);
  const [aheadText = '0', behindText = '0'] = output.split(/\s+/);
  return {
    ahead: Number.parseInt(aheadText, 10) || 0,
    behind: Number.parseInt(behindText, 10) || 0,
  };
}

function syncMessage(state: SessionVaultSyncStatus['state'], ahead: number, behind: number): string {
  if (state === 'unconfigured') return 'Session Vault 尚未配置';
  if (state === 'local-only') return 'Checkpoint 仅保存在本机，未启用远端同步';
  if (state === 'unconfirmed') return '远端隐私状态尚未确认，只能保存在本机';
  if (state === 'remote-unknown') return '尚未检查 Session Vault 远端，请先拉取更新';
  if (state === 'synced') return '本机与 Session Vault 远端一致';
  if (state === 'local-ahead') return `本机有 ${ahead} 个待同步 Commit`;
  if (state === 'remote-ahead') return `远端有 ${behind} 个新 Commit，等待拉取`;
  if (state === 'diverged') return '本机与远端已经分叉，当前版本不会自动覆盖任一方';
  return '上次同步失败，本机 checkpoint 仍然完整保留';
}

async function configuredContext(options: SessionVaultSyncOptions): Promise<{
  vaultPath: string;
  binding: SessionVaultBinding;
  remoteName: string;
}> {
  const status = await loadSessionVaultStatus(options);
  if (!status.configured || !status.binding || !status.manifest) {
    throw new SessionVaultSyncError('vault-not-configured', 'Session Vault 尚未初始化', 409);
  }
  if (!status.binding.remoteSyncEnabled || !status.binding.remoteName || !status.binding.normalizedRemoteUrl) {
    throw new SessionVaultSyncError('remote-sync-disabled', 'Session Vault 当前为仅本机模式，请先配置并启用私有远端', 409);
  }
  if (status.binding.privacyState !== 'private-user-confirmed' || !status.manifest.remote?.privateConfirmed) {
    throw new SessionVaultSyncError('remote-privacy-unconfirmed', 'Session Vault 远端尚未确认私有，已阻止同步', 409);
  }
  ensureRemoteName(status.binding.remoteName);
  return {
    vaultPath: await realpath(status.binding.vaultPath),
    binding: status.binding,
    remoteName: status.binding.remoteName,
  };
}

async function assertRemoteMatchesBinding(
  vaultPath: string,
  remoteName: string,
  binding: SessionVaultBinding,
): Promise<void> {
  const actualUrl = await runGitText(vaultPath, ['remote', 'get-url', remoteName]).catch(() => '');
  if (!actualUrl || normalizeRemoteUrl(actualUrl) !== binding.normalizedRemoteUrl) {
    throw new SessionVaultSyncError(
      'remote-configuration-changed',
      'Session Vault Git remote 与本机确认记录不一致，请先检查仓库归属并重新绑定',
    );
  }
}

async function assertVaultBranch(vaultPath: string, localHead: string | null): Promise<void> {
  if (!localHead) return;
  const branch = await runGitText(vaultPath, ['branch', '--show-current']);
  if (branch !== vaultBranch) {
    throw new SessionVaultSyncError('vault-branch-invalid', `Session Vault 必须停留在 ${vaultBranch} 分支，当前为 ${branch || 'detached HEAD'}`);
  }
}

async function vaultStatusRecords(vaultPath: string): Promise<string[]> {
  const result = await runGit(vaultPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.exitCode !== 0) throw new SessionVaultSyncError('vault-worktree-dirty', '无法检查 Session Vault 工作区');
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

async function assertVaultClean(vaultPath: string, allowBootstrap: boolean): Promise<void> {
  const records = await vaultStatusRecords(vaultPath);
  const allowed = new Set(['?? .gitignore', '?? vault.yaml']);
  if (records.length === 0 || (allowBootstrap && records.every((record) => allowed.has(record)))) return;
  throw new SessionVaultSyncError(
    'vault-worktree-dirty',
    `Session Vault 工作区存在 ${records.length} 项未处理变更；请先完成或恢复本机 checkpoint，再重试同步`,
  );
}

async function fetchRemote(vaultPath: string, remoteName: string): Promise<void> {
  const result = await runGit(vaultPath, ['fetch', '--prune', '--no-tags', remoteName], 300_000);
  if (result.exitCode !== 0) {
    throw new SessionVaultSyncError(
      'vault-remote-unavailable',
      '无法连接 Session Vault 私有远端；本机 checkpoint 已保留，请检查网络或权限后重试',
      502,
    );
  }
}

async function assertNoRebaseResidue(vaultPath: string): Promise<void> {
  const [unmerged, status] = await Promise.all([
    runGit(vaultPath, ['ls-files', '-u']),
    runGit(vaultPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  if (unmerged.exitCode !== 0 || status.exitCode !== 0 || unmerged.stdout.length > 0 || status.stdout.length > 0) {
    throw new SessionVaultSyncError(
      'vault-worktree-dirty',
      'Session Vault 自动整合未能恢复干净工作区，已停止同步；请先备份 Vault 并检查 Git 状态',
    );
  }
}

async function rebaseLocalEventsOntoRemote(vaultPath: string, remoteName: string): Promise<void> {
  const originalHead = await currentHead(vaultPath);
  if (!originalHead) return;
  const result = await runGit(
    vaultPath,
    [
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'rebase',
      remoteTrackingRef(remoteName),
    ],
    300_000,
  );
  if (result.exitCode === 0) {
    await assertVaultClean(vaultPath, false);
    return;
  }

  const aborted = await runGit(vaultPath, ['rebase', '--abort'], 30_000);
  const restoredHead = await currentHead(vaultPath);
  if (aborted.exitCode !== 0 || restoredHead !== originalHead) {
    throw new SessionVaultSyncError(
      'vault-worktree-dirty',
      'Session Vault 自动整合失败且无法恢复原始 HEAD，已停止同步；请先备份 Vault 并检查 Git 状态',
    );
  }
  await assertNoRebaseResidue(vaultPath);
  throw new SessionVaultSyncError(
    'vault-diverged',
    'Session Vault 自动整合遇到路径冲突，已恢复到操作前状态且未留下冲突标记；请保留两侧 Vault 并人工检查重复事件',
  );
}

async function integrateRemoteHead(
  vaultPath: string,
  remoteName: string,
  localHead: string,
  remoteHead: string,
): Promise<'unchanged' | 'fast-forwarded' | 'rebased'> {
  const counts = await aheadBehind(vaultPath, localHead, remoteHead);
  if (counts.behind === 0) return 'unchanged';
  if (counts.ahead === 0) {
    await runGitText(vaultPath, ['merge', '--ff-only', remoteTrackingRef(remoteName)]);
    return 'fast-forwarded';
  }
  await rebaseLocalEventsOntoRemote(vaultPath, remoteName);
  return 'rebased';
}

async function readRemoteManifest(vaultPath: string, remoteHead: string, binding: SessionVaultBinding): Promise<void> {
  const contents = await runGitText(vaultPath, ['show', `${remoteHead}:vault.yaml`]).catch(() => '');
  let manifest;
  try {
    manifest = sessionVaultManifestSchema.parse(parseYaml(contents));
  } catch {
    throw new SessionVaultSyncError('remote-configuration-changed', '远端不是可识别的 Moo Fleet Session Vault，已停止同步');
  }
  if (
    !manifest.remote?.privateConfirmed ||
    !binding.normalizedRemoteUrl ||
    manifest.remote.normalizedUrl !== binding.normalizedRemoteUrl
  ) {
    throw new SessionVaultSyncError('remote-configuration-changed', '远端 Vault 身份或私有确认记录与本机绑定不一致，已停止同步');
  }
}

async function bootstrapFromRemote(vaultPath: string, remoteName: string): Promise<void> {
  await assertVaultClean(vaultPath, true);
  const [ignoreContents, manifestContents] = await Promise.all([
    readFile(path.join(vaultPath, '.gitignore'), 'utf8').catch(() => null),
    readFile(path.join(vaultPath, 'vault.yaml'), 'utf8').catch(() => null),
  ]);
  await Promise.all([
    rm(path.join(vaultPath, '.gitignore'), { force: true }),
    rm(path.join(vaultPath, 'vault.yaml'), { force: true }),
  ]);
  try {
    await runGitText(vaultPath, ['checkout', '-B', vaultBranch, remoteTrackingRef(remoteName)]);
  } catch (error) {
    if (!(await currentHead(vaultPath))) {
      await Promise.all([
        ignoreContents === null
          ? Promise.resolve()
          : writeFile(path.join(vaultPath, '.gitignore'), ignoreContents, { mode: 0o600 }),
        manifestContents === null
          ? Promise.resolve()
          : writeFile(path.join(vaultPath, 'vault.yaml'), manifestContents, { mode: 0o600 }),
      ]);
    }
    throw error;
  }
}

async function recordFailure(
  options: SessionVaultSyncOptions,
  previous: PersistedSyncState,
  attemptedAt: string,
  error: unknown,
): Promise<void> {
  await writePersistedSyncState(options, {
    schemaVersion: 1,
    lastAttemptAt: attemptedAt,
    lastSuccessAt: previous.lastSuccessAt,
    lastError: safeFailureMessage(error),
  });
}

async function recordSuccess(
  options: SessionVaultSyncOptions,
  attemptedAt: string,
): Promise<void> {
  await writePersistedSyncState(options, {
    schemaVersion: 1,
    lastAttemptAt: attemptedAt,
    lastSuccessAt: attemptedAt,
    lastError: null,
  });
}

export async function sessionVaultSyncStatus(
  options: SessionVaultSyncOptions = {},
): Promise<SessionVaultSyncStatus> {
  const [vaultStatus, persisted] = await Promise.all([
    loadSessionVaultStatus(options),
    readPersistedSyncState(options),
  ]);
  if (!vaultStatus.configured || !vaultStatus.binding || !vaultStatus.manifest) {
    return sessionVaultSyncStatusSchema.parse({
      ...persisted,
      configured: false,
      remoteSyncEnabled: false,
      remoteChecked: false,
      state: 'unconfigured',
      localHead: null,
      remoteHead: null,
      ahead: 0,
      behind: 0,
      pendingLocal: false,
      message: syncMessage('unconfigured', 0, 0),
    });
  }
  const vaultPath = await realpath(vaultStatus.binding.vaultPath);
  const localHead = await currentHead(vaultPath);
  if (!vaultStatus.binding.remoteSyncEnabled || !vaultStatus.binding.remoteName) {
    const counts = await aheadBehind(vaultPath, localHead, null);
    return sessionVaultSyncStatusSchema.parse({
      ...persisted,
      configured: true,
      remoteSyncEnabled: false,
      remoteChecked: false,
      state: 'local-only',
      localHead,
      remoteHead: null,
      ...counts,
      pendingLocal: Boolean(localHead),
      message: syncMessage('local-only', counts.ahead, counts.behind),
    });
  }
  if (vaultStatus.binding.privacyState !== 'private-user-confirmed') {
    const counts = await aheadBehind(vaultPath, localHead, null);
    return sessionVaultSyncStatusSchema.parse({
      ...persisted,
      configured: true,
      remoteSyncEnabled: true,
      remoteChecked: false,
      state: 'unconfirmed',
      localHead,
      remoteHead: null,
      ...counts,
      pendingLocal: Boolean(localHead),
      message: syncMessage('unconfirmed', counts.ahead, counts.behind),
    });
  }
  ensureRemoteName(vaultStatus.binding.remoteName);
  const remoteHead = await trackedRemoteHead(vaultPath, vaultStatus.binding.remoteName);
  const counts = await aheadBehind(vaultPath, localHead, remoteHead);
  const remoteChecked = Boolean(remoteHead || persisted.lastSuccessAt);
  let state: SessionVaultSyncStatus['state'];
  if (!localHead && !remoteHead && !remoteChecked) state = 'remote-unknown';
  else if (counts.ahead > 0 && counts.behind > 0) state = 'diverged';
  else if (counts.ahead > 0) state = 'local-ahead';
  else if (counts.behind > 0) state = 'remote-ahead';
  else state = 'synced';
  if (persisted.lastError && state !== 'synced') state = 'sync-failed';
  return sessionVaultSyncStatusSchema.parse({
    ...persisted,
    configured: true,
    remoteSyncEnabled: true,
    remoteChecked,
    state,
    localHead,
    remoteHead,
    ...counts,
    pendingLocal: counts.ahead > 0,
    message: syncMessage(state, counts.ahead, counts.behind),
  });
}

export async function pullSessionVault(options: SessionVaultSyncOptions = {}): Promise<SessionVaultSyncStatus> {
  const context = await configuredContext(options);
  const attemptedAt = (options.now ?? new Date()).toISOString();
  const previous = await readPersistedSyncState(options);
  return withSessionVaultLock(context.vaultPath, async () => {
    try {
      await recoverCheckpointTransactionsWithinLock(context.vaultPath);
      await recoverLifecycleTransactionsWithinLock(context.vaultPath);
      await recoverLineageTransactionsWithinLock(context.vaultPath);
      await assertRemoteMatchesBinding(context.vaultPath, context.remoteName, context.binding);
      const localBefore = await currentHead(context.vaultPath);
      await assertVaultBranch(context.vaultPath, localBefore);
      await assertVaultClean(context.vaultPath, !localBefore);
      await fetchRemote(context.vaultPath, context.remoteName);
      const remoteHead = await trackedRemoteHead(context.vaultPath, context.remoteName);
      if (remoteHead) await readRemoteManifest(context.vaultPath, remoteHead, context.binding);
      if (!localBefore && remoteHead) {
        await bootstrapFromRemote(context.vaultPath, context.remoteName);
      } else if (localBefore && remoteHead) {
        await integrateRemoteHead(context.vaultPath, context.remoteName, localBefore, remoteHead);
      }
      await assertVaultClean(context.vaultPath, false);
      await recordSuccess(options, attemptedAt);
      return sessionVaultSyncStatus(options);
    } catch (error) {
      await recordFailure(options, previous, attemptedAt, error).catch(() => undefined);
      if (error instanceof SessionVaultSyncError) throw error;
      throw new SessionVaultSyncError('vault-pull-failed', 'Session Vault Pull 未完成；本机 checkpoint 已保留', 502);
    }
  });
}

export async function pushSessionVault(options: SessionVaultSyncOptions = {}): Promise<SessionVaultSyncStatus> {
  const context = await configuredContext(options);
  const attemptedAt = (options.now ?? new Date()).toISOString();
  const previous = await readPersistedSyncState(options);
  return withSessionVaultLock(context.vaultPath, async () => {
    try {
      await recoverCheckpointTransactionsWithinLock(context.vaultPath);
      await recoverLifecycleTransactionsWithinLock(context.vaultPath);
      await recoverLineageTransactionsWithinLock(context.vaultPath);
      await assertRemoteMatchesBinding(context.vaultPath, context.remoteName, context.binding);
      const localHead = await currentHead(context.vaultPath);
      await assertVaultBranch(context.vaultPath, localHead);
      await assertVaultClean(context.vaultPath, !localHead);
      await fetchRemote(context.vaultPath, context.remoteName);
      const remoteHead = await trackedRemoteHead(context.vaultPath, context.remoteName);
      if (remoteHead) await readRemoteManifest(context.vaultPath, remoteHead, context.binding);
      if (!localHead) {
        if (remoteHead) {
          throw new SessionVaultSyncError('vault-diverged', '远端已有 Session Vault 内容，请先拉取更新再保存或推送');
        }
        await recordSuccess(options, attemptedAt);
        return sessionVaultSyncStatus(options);
      }
      if (remoteHead) {
        const integration = await integrateRemoteHead(context.vaultPath, context.remoteName, localHead, remoteHead);
        if (integration === 'fast-forwarded') {
          await recordSuccess(options, attemptedAt);
          return sessionVaultSyncStatus(options);
        }
      }
      let pushed = false;
      for (let attempt = 0; attempt < 2 && !pushed; attempt += 1) {
        const headToPush = await currentHead(context.vaultPath);
        if (!headToPush) break;
        const result = await runGit(
          context.vaultPath,
          ['push', '--porcelain', context.remoteName, `${headToPush}:refs/heads/${vaultBranch}`],
          300_000,
        );
        if (result.exitCode === 0) {
          pushed = true;
          break;
        }
        if (attempt === 0) {
          await fetchRemote(context.vaultPath, context.remoteName);
          const refreshedRemoteHead = await trackedRemoteHead(context.vaultPath, context.remoteName);
          const refreshedLocalHead = await currentHead(context.vaultPath);
          if (refreshedRemoteHead) await readRemoteManifest(context.vaultPath, refreshedRemoteHead, context.binding);
          if (refreshedRemoteHead && refreshedLocalHead) {
            await integrateRemoteHead(context.vaultPath, context.remoteName, refreshedLocalHead, refreshedRemoteHead);
            continue;
          }
        }
      }
      if (!pushed) {
        throw new SessionVaultSyncError(
          'vault-push-failed',
          'Session Vault Push 被网络或远端拒绝；自动刷新并重试后仍未完成，本机 checkpoint 已保留',
          502,
        );
      }
      await fetchRemote(context.vaultPath, context.remoteName);
      await recordSuccess(options, attemptedAt);
      return sessionVaultSyncStatus(options);
    } catch (error) {
      await recordFailure(options, previous, attemptedAt, error).catch(() => undefined);
      if (error instanceof SessionVaultSyncError) throw error;
      throw new SessionVaultSyncError('vault-push-failed', 'Session Vault Push 未完成；本机 checkpoint 已保留', 502);
    }
  });
}
