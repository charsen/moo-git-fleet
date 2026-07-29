import type {
  BranchesSnapshot,
  CommitPreview,
  CommitSuggestion,
  DashboardPayload,
  FileChange,
  OperationsPayload,
  ProfileConfig,
  ProfileViewPreferences,
  PruneMissingRepositoriesResult,
  RepositoryConfig,
  RepositoryCommit,
  RepositoryRootMutationResult,
  RepositoryStatus,
  ScanCandidate,
  StashEntry,
  UpstreamRepairPlan,
  UpstreamRepairRequest,
  UpstreamRepairResult,
} from '../shared/contracts';
import type {
  CheckpointCaptureRequest,
  CheckpointDiscoveryPayload,
  CheckpointJob,
  CheckpointPreview,
  InitializeSessionVaultRequest,
  SessionCheckpointPayload,
  SessionDetail,
  SessionDeletionConflictSaveRequest,
  SessionDeletionConflictSaveResult,
  SessionForkMergeResult,
  SessionForkMergeRequest,
  SessionForkSelectRequest,
  SessionForkSelectResult,
  SessionForkSplitRequest,
  SessionForkSplitResult,
  SessionLifecycleFilter,
  SessionLifecycleMutationAction,
  SessionLifecycleMutationResult,
  SessionListPayload,
  SessionProvider,
  SessionTrashEmptyPreview,
  SessionTrashEmptyResult,
  RotateSessionVaultEpochRequest,
  RotateSessionVaultEpochResult,
  SessionVaultEpochSessionList,
  SessionVaultEpochStatus,
  SessionVaultStatus,
  SessionVaultSyncStatus,
} from '../shared/sessions';
import type { RecoveryPlan } from '../shared/recovery';
import type {
  NativeRollbackRequest,
  NativeRollbackResult,
  NativeRestoreExecuteRequest,
  NativeRestoreResult,
} from '../shared/native-capsule';
import type {
  CmuxConfig,
  CmuxOpenResult,
  CmuxSettingsStatus,
} from '../shared/cmux';
import type { ProviderPermissionMode } from '../shared/provider-command';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function shouldRetryApiQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const needsToken = !['GET', 'HEAD'].includes(method);
  const token = needsToken ? await getSessionToken() : '';
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  if (token) headers.set('x-git-fleet-token', token);
  let response = await fetch(url, {
    ...init,
    headers,
  });
  if (response.status === 403 && needsToken) {
    sessionToken = null;
    const refreshedToken = await getSessionToken();
    const retryHeaders = new Headers(init?.headers);
    if (init?.body) retryHeaders.set('content-type', 'application/json');
    retryHeaders.set('x-git-fleet-token', refreshedToken);
    response = await fetch(url, {
      ...init,
      headers: retryHeaders,
    });
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? `请求失败：${response.status}`);
  return body;
}

let sessionToken: string | null = null;

async function getSessionToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('无法建立本地会话');
  sessionToken = ((await response.json()) as { token: string }).token;
  return sessionToken;
}

export const api = {
  dashboard: () => request<DashboardPayload>('/api/dashboard'),
  sessionVaultStatus: () => request<SessionVaultStatus>('/api/session-vault'),
  initializeSessionVault: (input: InitializeSessionVaultRequest) =>
    request<SessionVaultStatus>('/api/session-vault/initialize', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  sessionVaultSync: () => request<SessionVaultSyncStatus>('/api/session-vault/sync'),
  sessionVaultEpochs: () => request<SessionVaultEpochStatus>('/api/session-vault/epochs'),
  pullSessionVault: () => request<SessionVaultSyncStatus>('/api/session-vault/pull', { method: 'POST' }),
  pushSessionVault: () => request<SessionVaultSyncStatus>('/api/session-vault/push', { method: 'POST' }),
  rotateSessionVaultEpoch: (input: RotateSessionVaultEpochRequest) =>
    request<RotateSessionVaultEpochResult>('/api/session-vault/rotate-epoch', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  sessionTrashEmptyPreview: () => request<SessionTrashEmptyPreview>('/api/session-vault/trash/preview'),
  emptySessionTrash: (expectedFingerprint: string) => request<SessionTrashEmptyResult>('/api/session-vault/trash/empty', {
    method: 'POST',
    body: JSON.stringify({ expectedFingerprint, acknowledgeGitHistoryRetention: true }),
  }),
  sessions: (input: { page: number; pageSize: number; search?: string; provider?: SessionProvider | null; lifecycle?: SessionLifecycleFilter }) => {
    const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
    if (input.search) query.set('search', input.search);
    if (input.provider) query.set('provider', input.provider);
    if (input.lifecycle) query.set('lifecycle', input.lifecycle);
    return request<SessionListPayload>(`/api/sessions?${query.toString()}`);
  },
  archivedEpochSessions: (
    epochId: string,
    input: { page: number; pageSize: number; search?: string; provider?: SessionProvider | null; lifecycle?: SessionLifecycleFilter },
  ) => {
    const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
    if (input.search) query.set('search', input.search);
    if (input.provider) query.set('provider', input.provider);
    if (input.lifecycle) query.set('lifecycle', input.lifecycle);
    return request<SessionVaultEpochSessionList>(
      `/api/session-vault/epochs/${encodeURIComponent(epochId)}/sessions?${query.toString()}`,
    );
  },
  sessionDetail: (sessionId: string) =>
    request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  sessionDiscovery: () => request<CheckpointDiscoveryPayload>('/api/session-discovery'),
  sessionCheckpointPreview: (provider: SessionProvider, providerSessionId: string) =>
    request<CheckpointPreview>(
      `/api/sessions/${provider}/${encodeURIComponent(providerSessionId)}/checkpoint-preview`,
    ),
  sessionProviderSummaryPreview: (provider: SessionProvider, providerSessionId: string) =>
    request<CheckpointPreview>(
      `/api/sessions/${provider}/${encodeURIComponent(providerSessionId)}/checkpoint-preview/provider-summary`,
      { method: 'POST', body: JSON.stringify({ allowProviderInvocation: true }) },
    ),
  startSessionCheckpoint: (
    provider: SessionProvider,
    providerSessionId: string,
    input: CheckpointCaptureRequest,
  ) => request<CheckpointJob>(
    `/api/sessions/${provider}/${encodeURIComponent(providerSessionId)}/checkpoints`,
    { method: 'POST', body: JSON.stringify(input) },
  ),
  sessionCheckpointJob: (operationId: string) =>
    request<CheckpointJob>(`/api/session-checkpoint-jobs/${encodeURIComponent(operationId)}`),
  archivedEpochSessionDetail: (epochId: string, sessionId: string) =>
    request<SessionDetail>(
      `/api/session-vault/epochs/${encodeURIComponent(epochId)}/sessions/${encodeURIComponent(sessionId)}`,
    ),
  sessionCheckpointPayload: (sessionId: string, checkpointId: string) =>
    request<SessionCheckpointPayload>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}`,
    ),
  archivedEpochCheckpointPayload: (epochId: string, sessionId: string, checkpointId: string) =>
    request<SessionCheckpointPayload>(
      `/api/session-vault/epochs/${encodeURIComponent(epochId)}/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}`,
    ),
  saveDeletionConflictAsNew: (sessionId: string, input: SessionDeletionConflictSaveRequest) =>
    request<SessionDeletionConflictSaveResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/trash-conflict/save-as-new`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  mergeSessionFork: (sessionId: string, input: SessionForkMergeRequest) =>
    request<SessionForkMergeResult>(`/api/sessions/${encodeURIComponent(sessionId)}/fork/merge`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  selectSessionForkHead: (sessionId: string, input: SessionForkSelectRequest) =>
    request<SessionForkSelectResult>(`/api/sessions/${encodeURIComponent(sessionId)}/fork/select`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  splitSessionFork: (sessionId: string, input: SessionForkSplitRequest) =>
    request<SessionForkSplitResult>(`/api/sessions/${encodeURIComponent(sessionId)}/fork/split`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  mutateSessionLifecycle: (
    sessionId: string,
    action: SessionLifecycleMutationAction,
    expectedLifecycleVersion: string | null,
  ) => request<SessionLifecycleMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/lifecycle`, {
    method: 'POST',
    body: JSON.stringify({ action, expectedLifecycleVersion }),
  }),
  sessionRecoveryPlan: (
    sessionId: string,
    input: {
      localPath?: string | null;
      checkpointId?: string;
      permissionMode?: ProviderPermissionMode;
      refreshRemote?: boolean;
    } = {},
  ) =>
    request<RecoveryPlan>(`/api/sessions/${encodeURIComponent(sessionId)}/restore/plan`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  executeNativeRestore: (sessionId: string, input: NativeRestoreExecuteRequest) =>
    request<NativeRestoreResult>(`/api/sessions/${encodeURIComponent(sessionId)}/restore/execute`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  rollbackNativeRestore: (sessionId: string, input: NativeRollbackRequest) =>
    request<NativeRollbackResult>(`/api/sessions/${encodeURIComponent(sessionId)}/restore/rollback`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  cmuxSettings: () => request<CmuxSettingsStatus>('/api/settings/cmux'),
  saveCmuxSettings: (config: CmuxConfig) =>
    request<CmuxSettingsStatus>('/api/settings/cmux', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  openRecoveryInCmux: (
    sessionId: string,
    input: {
      localPath?: string | null;
      checkpointId?: string;
      permissionMode?: ProviderPermissionMode;
      expectedLaunchFingerprint: string;
      confirmOpenInCmux: true;
    },
  ) => request<CmuxOpenResult>(`/api/sessions/${encodeURIComponent(sessionId)}/restore/cmux-open`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  refresh: () => request<DashboardPayload>('/api/repositories/refresh', { method: 'POST' }),
  saveProfile: (profile: ProfileConfig['profile']) =>
    request<ProfileConfig>('/api/settings/profile', { method: 'PUT', body: JSON.stringify(profile) }),
  saveViewPreferences: (viewPreferences: ProfileViewPreferences) =>
    request<ProfileConfig>('/api/settings/view-preferences', {
      method: 'PATCH',
      body: JSON.stringify(viewPreferences),
    }),
  saveDeepSeekApiKey: (apiKey: string) =>
    request<{ configured: boolean }>('/api/settings/deepseek-api-key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  loadDeepSeekApiKey: () =>
    request<{ apiKey: string }>('/api/settings/deepseek-api-key/read', { method: 'POST' }),
  readSystemClipboard: () =>
    request<{ text: string }>('/api/system/clipboard/read', { method: 'POST' }),
  addRoot: (path: string, internalId?: string) =>
    request<RepositoryRootMutationResult>('/api/repository-roots', {
      method: 'POST',
      body: JSON.stringify(internalId ? { id: internalId, path } : { path }),
    }),
  removeRoot: (id: string) =>
    request<Record<string, string>>(`/api/repository-roots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  selectDirectory: (initialPath?: string) =>
    request<{ path: string | null }>('/api/system/select-directory', {
      method: 'POST',
      body: JSON.stringify(initialPath ? { initialPath } : {}),
    }),
  scanRoot: (rootId: string) =>
    request<{ candidates: ScanCandidate[] }>('/api/repository-scan', {
      method: 'POST',
      body: JSON.stringify({ rootId }),
    }),
  addRepository: (candidate: ScanCandidate, group = '未分组') =>
    request<RepositoryConfig>('/api/repositories', {
      method: 'POST',
      body: JSON.stringify({
        rootId: candidate.rootId,
        relativePath: candidate.relativePath,
        name: candidate.name,
        group,
        tags: [],
      }),
    }),
  updateRepository: (id: string, update: Partial<RepositoryConfig>) =>
    request<RepositoryConfig>(`/api/repositories/${encodeURIComponent(id)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    }),
  removeRepository: (id: string) =>
    request<{ removed: string; deletedFromDisk: boolean }>(`/api/repositories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  pruneMissingRepositories: (ids: string[]) =>
    request<PruneMissingRepositoriesResult>('/api/repositories/prune-missing', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  operations: () => request<OperationsPayload>('/api/operations'),
  startBatch: (type: 'fetch' | 'pull' | 'push', repositoryIds?: string[]) =>
    request<{ batch: OperationsPayload['batches'][number] }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify({ type, repositoryIds }),
    }),
  fetchRepository: (id: string) =>
    request<{ operation: { message: string; state: string } }>(`/api/repositories/${encodeURIComponent(id)}/fetch`, {
      method: 'POST',
    }),
  pullRepository: (id: string) =>
    request<{ operation: { message: string; state: string } }>(`/api/repositories/${encodeURIComponent(id)}/pull`, {
      method: 'POST',
    }),
  pushRepository: (id: string) =>
    request<{ operation: { message: string; state: string } }>(`/api/repositories/${encodeURIComponent(id)}/push`, {
      method: 'POST',
    }),
  repositoryBranches: (id: string) =>
    request<BranchesSnapshot>(`/api/repositories/${encodeURIComponent(id)}/branches`),
  upstreamRepairPlan: (id: string) =>
    request<UpstreamRepairPlan>(`/api/repositories/${encodeURIComponent(id)}/upstream/repair`),
  repairUpstream: (id: string, input: UpstreamRepairRequest) =>
    request<{
      operation: OperationsPayload['operations'][number];
      result: UpstreamRepairResult;
    }>(`/api/repositories/${encodeURIComponent(id)}/upstream`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  repositoryCommits: (id: string) =>
    request<{ commits: RepositoryCommit[] }>(`/api/repositories/${encodeURIComponent(id)}/commits`),
  switchRepositoryBranch: (id: string, branch: string, expectedBranch: string | null, expectedHead: string) =>
    request<{
      operation: OperationsPayload['operations'][number];
      result: { status: RepositoryStatus; files: FileChange[]; branches: BranchesSnapshot };
    }>(`/api/repositories/${encodeURIComponent(id)}/branches/switch`, {
      method: 'POST',
      body: JSON.stringify({ branch, expectedBranch, expectedHead }),
    }),
  repositoryFiles: (id: string) =>
    request<{ files: FileChange[] }>(`/api/repositories/${encodeURIComponent(id)}/files`),
  repositoryStashes: (id: string) =>
    request<{ stashes: StashEntry[] }>(`/api/repositories/${encodeURIComponent(id)}/stashes`),
  createStash: (id: string, message: string, includeUntracked: boolean) =>
    request<{
      operation: OperationsPayload['operations'][number];
      result: { stash: StashEntry; stashes: StashEntry[] };
    }>(`/api/repositories/${encodeURIComponent(id)}/stashes`, {
      method: 'POST',
      body: JSON.stringify({ message, includeUntracked }),
    }),
  applyStash: (id: string, stash: Pick<StashEntry, 'ref' | 'hash'>) =>
    request<{
      operation: OperationsPayload['operations'][number];
      result: { stash: StashEntry; stashes: StashEntry[] };
    }>(`/api/repositories/${encodeURIComponent(id)}/stashes/apply`, {
      method: 'POST',
      body: JSON.stringify({ ref: stash.ref, expectedHash: stash.hash }),
    }),
  dropStash: (id: string, stash: Pick<StashEntry, 'ref' | 'hash'>) =>
    request<{
      operation: OperationsPayload['operations'][number];
      result: { stash: StashEntry; stashes: StashEntry[]; status: RepositoryStatus };
    }>(`/api/repositories/${encodeURIComponent(id)}/stashes/drop`, {
      method: 'POST',
      body: JSON.stringify({ ref: stash.ref, expectedHash: stash.hash }),
    }),
  openRepository: (id: string, target: 'finder' | 'terminal' | 'vscode') =>
    request<{ opened: string }>(`/api/repositories/${encodeURIComponent(id)}/open`, {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  fileDiff: (id: string, fileId: string, kind: 'staged' | 'unstaged') =>
    request<{ path: string; kind: string; diff: string }>(
      `/api/repositories/${encodeURIComponent(id)}/diff?kind=${kind}&fileId=${encodeURIComponent(fileId)}`,
    ),
  stageFiles: (id: string, fileIds: string[]) =>
    request<{ files: FileChange[] }>(`/api/repositories/${encodeURIComponent(id)}/stage`, {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }),
  unstageFiles: (id: string, fileIds: string[]) =>
    request<{ files: FileChange[] }>(`/api/repositories/${encodeURIComponent(id)}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }),
  discardFile: (id: string, fileId: string) =>
    request<{ result: { action: 'trash' | 'restore'; path: string }; files: FileChange[] }>(
      `/api/repositories/${encodeURIComponent(id)}/files/discard`,
      { method: 'POST', body: JSON.stringify({ fileId }) },
    ),
  commitPreview: (id: string) =>
    request<CommitPreview>(`/api/repositories/${encodeURIComponent(id)}/commit/preview`, { method: 'POST' }),
  suggestCommit: (id: string, fingerprint: string, signal?: AbortSignal) =>
    request<CommitSuggestion>(`/api/repositories/${encodeURIComponent(id)}/commit/suggest`, {
      method: 'POST',
      body: JSON.stringify({ fingerprint }),
      signal,
    }),
  commit: (id: string, message: string, fingerprint: string, pushAfterCommit = false) =>
    request<{ operation: { message: string; state: string }; pushOperation: { message: string; state: string } | null; message: string }>(`/api/repositories/${encodeURIComponent(id)}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message, fingerprint, pushAfterCommit }),
    }),
  autoCommit: (id: string, fingerprint: string, pushAfterCommit = false) =>
    request<{ operation: { message: string; state: string }; pushOperation: { message: string; state: string } | null; message: string }>(`/api/repositories/${encodeURIComponent(id)}/commit/auto`, {
      method: 'POST',
      body: JSON.stringify({ fingerprint, pushAfterCommit }),
    }),
};
