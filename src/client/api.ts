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
import type { SessionProvider } from '../shared/sessions';
import type {
  BackupStatus,
  LocalSessionList,
  LocalSessionPreviewPayload,
  SessionBackupCandidateList,
  SessionSyncDecision,
  SessionSyncResult,
} from '../shared/session-sync';

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

/**
 * fetch 在后端进程不在时抛的是英文 TypeError（"Failed to fetch"），
 * 直接透传到界面对使用者毫无帮助；统一翻译成能行动的中文。
 */
async function connectedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiError(0, '连不上 Moo Fleet 本地服务；请确认应用正在运行，然后重试');
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const needsToken = !['GET', 'HEAD'].includes(method);
  const token = needsToken ? await getSessionToken() : '';
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  if (token) headers.set('x-git-fleet-token', token);
  let response = await connectedFetch(url, {
    ...init,
    headers,
  });
  if (response.status === 403 && needsToken) {
    sessionToken = null;
    const refreshedToken = await getSessionToken();
    const retryHeaders = new Headers(init?.headers);
    if (init?.body) retryHeaders.set('content-type', 'application/json');
    retryHeaders.set('x-git-fleet-token', refreshedToken);
    response = await connectedFetch(url, {
      ...init,
      headers: retryHeaders,
    });
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? `本地服务返回异常（${response.status}），请稍后重试`);
  return body;
}

let sessionToken: string | null = null;

async function getSessionToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  const response = await connectedFetch('/api/session');
  if (!response.ok) throw new Error('无法建立本地会话');
  sessionToken = ((await response.json()) as { token: string }).token;
  return sessionToken;
}

export const api = {
  dashboard: () => request<DashboardPayload>('/api/dashboard'),
  sessionBackupStatus: () => request<BackupStatus>('/api/session-backup'),
  sessionBackupCandidates: () => request<SessionBackupCandidateList>('/api/session-backup/candidates'),
  initializeSessionBackup: (input: { backupPath: string | null }) =>
    request<BackupStatus>('/api/session-backup/initialize', { method: 'POST', body: JSON.stringify(input) }),
  localSessions: () => request<LocalSessionList>('/api/local-sessions'),
  localSession: (provider: SessionProvider, providerSessionId: string) =>
    request<LocalSessionPreviewPayload>(`/api/local-sessions/${provider}/${encodeURIComponent(providerSessionId)}`),
  trashLocalSession: (provider: SessionProvider, providerSessionId: string, alsoRemoveFromBackup = false) =>
    request<{ trashed: boolean; backupRemoved: boolean }>(
      `/api/local-sessions/${provider}/${encodeURIComponent(providerSessionId)}/trash`,
      { method: 'POST', body: JSON.stringify({ alsoRemoveFromBackup }) },
    ),
  syncSessions: () => request<SessionSyncResult>('/api/session-sync', { method: 'POST' }),
  resolveSessionSync: (input: { provider: SessionProvider; providerSessionId: string; decision: SessionSyncDecision }) =>
    request<SessionSyncResult>('/api/session-sync/resolve', { method: 'POST', body: JSON.stringify(input) }),
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
