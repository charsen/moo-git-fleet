import type {
  AppliedHunksResult,
  AnalyticsRepositoryScope,
  ApplyHunksRequest,
  AssumeUnchangedRequest,
  BatchOperationType,
  BranchesSnapshot,
  BranchComparison,
  BranchDeletionPreview,
  CommitHeatmapData,
  ConflictPreview,
  RevisionTreePage,
  RevisionFile,
  FileBlame,
  ReflogPage,
  RemoteCredentialOverview,
  RemoteProtocolBatchResult,
  RemoteProtocolSwitchResult,
  RepositoryRemoteMutation,
  RepositoryRemotesSnapshot,
  SaveRemoteCredentialRequest,
  CheckoutRemoteBranchRequest,
  CommitDetail,
  CommitPage,
  CommitPageQuery,
  CommitPreview,
  CommitRewriteResult,
  CommitSuggestion,
  CloneRepositoryResult,
  ConflictResolutionStrategy,
  CreateBranchRequest,
  LastCommitSnapshot,
  ReplayResult,
  CreateTagRequest,
  DashboardPayload,
  DarkTheme,
  DeleteBranchRequest,
  DeleteRemoteBranchRequest,
  DeleteRemoteTagRequest,
  DeleteTagRequest,
  FileChange,
  IgnoreFileRules,
  IgnoreRuleRequest,
  IgnoreRuleResult,
  IgnoredEntry,
  MergePreview,
  MergePreviewRequest,
  MergeBranchRequest,
  MarkedFile,
  OperationsPayload,
  ProfileConfig,
  ProfileViewPreferences,
  PruneMissingRepositoriesResult,
  PushTagRequest,
  RemoveIgnoreRuleRequest,
  RemoveIgnoreRuleResult,
  RenameBranchRequest,
  ResolveConflictRequest,
  RepositoryConfig,
  RepositoryOperation,
  RepositoryRootMutationResult,
  RepositoryStatus,
  ReleaseCheckResult,
  ScanCandidate,
  StashDetail,
  StashEntry,
  TagEntry,
  UpstreamRepairPlan,
  UpstreamRepairRequest,
  UpstreamRepairResult,
} from '../shared/contracts';
import type { RemoteProtocol } from '../shared/remote-url';
import type { AnalyticsRange } from '../shared/report-window';
import type { SessionProvider } from '../shared/sessions';
import type {
  BackupStatus,
  LocalSessionList,
  LocalSessionPreviewPayload,
  SessionBackupCandidateList,
  SessionSyncDecision,
  SessionSyncResult,
  TrashLocalSessionsRequest,
  TrashLocalSessionsResult,
} from '../shared/session-sync';

/**
 * 写操作统一的响应信封：一条操作记录 + 该操作的结果。
 *
 * 服务端所有写路由都返回这个形状，客户端原先在十来个方法里各写了一遍同样的
 * 内联类型，改一处就得记得改全部。
 */
type OperationEnvelope<T> = {
  operation: OperationsPayload['operations'][number];
  result: T;
};

type BranchWriteResponse = OperationEnvelope<{
  status: RepositoryStatus;
  files: FileChange[];
  branches: BranchesSnapshot;
  stashed?: StashEntry | null;
}>;

type ConflictOperationResponse = OperationEnvelope<{
  operation: RepositoryOperation;
  status: RepositoryStatus;
  files: FileChange[];
}>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 服务端给的机器可读错误码，只有需要界面特殊处理的错误才有（如 `legacy-vault`）。 */
    readonly code?: string,
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
  const body = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? `本地服务返回异常（${response.status}），请稍后重试`,
      body.code,
    );
  }
  return body;
}

let sessionToken: string | null = null;
/** 正在进行中的 `/api/session` 请求。见 `getSessionToken`。 */
let sessionTokenRequest: Promise<string> | null = null;

/**
 * 拿本地会话 token。
 *
 * 页面启动时会同时发好几个写请求（刷新、同步、保存偏好），原先它们各自看到
 * `sessionToken === null`，于是并发打出同样几个 `/api/session`。这里把在途请求
 * 共享出去，只有第一次真的发出去；失败时清空，下次重试。
 */
async function getSessionToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  sessionTokenRequest ??= (async () => {
    try {
      const response = await connectedFetch('/api/session');
      if (!response.ok) throw new Error('无法建立本地会话');
      const token = ((await response.json()) as { token: string }).token;
      sessionToken = token;
      return token;
    } finally {
      sessionTokenRequest = null;
    }
  })();
  return sessionTokenRequest;
}

/**
 * 仓库级接口的路径。
 *
 * 仓库 id 是「名称 slug + 路径哈希」，理论上不会出现需要转义的字符，但它来自
 * 配置且会被拼进 URL，转义放在这一处就不会漏。原先 70 个方法各自拼了一遍
 * `/api/repositories/${encodeURIComponent(id)}…`。
 */
function repoPath(id: string, suffix = ''): string {
  return `/api/repositories/${encodeURIComponent(id)}${suffix}`;
}

export const api = {
  dashboard: () => request<DashboardPayload>('/api/dashboard'),
  checkForUpdate: () => request<ReleaseCheckResult>('/api/update-check'),
  sessionBackupStatus: () => request<BackupStatus>('/api/session-backup'),
  sessionBackupCandidates: () => request<SessionBackupCandidateList>('/api/session-backup/candidates'),
  initializeSessionBackup: (input: { backupPath: string | null; upgradeLegacy?: boolean }) =>
    request<BackupStatus>('/api/session-backup/initialize', { method: 'POST', body: JSON.stringify(input) }),
  localSessions: () => request<LocalSessionList>('/api/local-sessions'),
  localSession: (provider: SessionProvider, providerSessionId: string, signal?: AbortSignal) =>
    request<LocalSessionPreviewPayload>(`/api/local-sessions/${provider}/${encodeURIComponent(providerSessionId)}`, { signal }),
  trashLocalSession: (provider: SessionProvider, providerSessionId: string, alsoRemoveFromBackup = false) =>
    request<{ trashed: boolean; backupRemoved: boolean }>(
      `/api/local-sessions/${provider}/${encodeURIComponent(providerSessionId)}/trash`,
      { method: 'POST', body: JSON.stringify({ alsoRemoveFromBackup }) },
    ),
  trashLocalSessions: (input: TrashLocalSessionsRequest) =>
    request<TrashLocalSessionsResult>('/api/local-sessions/trash-batch', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  syncSessions: () => request<SessionSyncResult>('/api/session-sync', { method: 'POST' }),
  resolveSessionSync: (input: { provider: SessionProvider; providerSessionId: string; decision: SessionSyncDecision }) =>
    request<SessionSyncResult>('/api/session-sync/resolve', { method: 'POST', body: JSON.stringify(input) }),
  refresh: () => request<DashboardPayload>('/api/repositories/refresh', { method: 'POST' }),
  saveProfile: (profile: ProfileConfig['profile']) =>
    request<ProfileConfig>('/api/settings/profile', { method: 'PUT', body: JSON.stringify(profile) }),
  saveTheme: (theme: DarkTheme) =>
    request<ProfileConfig>('/api/settings/theme', { method: 'PATCH', body: JSON.stringify({ theme }) }),
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
  /** 弹系统「选择文件夹」窗口（macOS / Windows / Linux 各有实现）；path 为 null 表示用户取消。 */
  pickNativeFolder: (prompt?: string) =>
    request<{ path: string | null }>('/api/native/pick-folder', {
      method: 'POST',
      body: JSON.stringify(prompt ? { prompt } : {}),
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
    request<RepositoryConfig>(repoPath(id, '/config'), {
      method: 'PATCH',
      body: JSON.stringify(update),
    }),
  removeRepository: (id: string) =>
    request<{ removed: string; deletedFromDisk: boolean }>(repoPath(id), {
      method: 'DELETE',
    }),
  pruneMissingRepositories: (ids: string[]) =>
    request<PruneMissingRepositoriesResult>('/api/repositories/prune-missing', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  operations: () => request<OperationsPayload>('/api/operations'),
  remoteCredentials: () => request<RemoteCredentialOverview>('/api/credentials'),
  saveRemoteCredential: (input: SaveRemoteCredentialRequest) =>
    request<{ host: string; stored: boolean }>('/api/credentials', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  removeRemoteCredential: (host: string) =>
    request<{ host: string; removed: boolean }>(`/api/credentials?host=${encodeURIComponent(host)}`, {
      method: 'DELETE',
    }),
  switchRemoteProtocol: (id: string, target: RemoteProtocol) =>
    request<{ operation: { message: string; state: string }; result: RemoteProtocolSwitchResult }>(
      repoPath(id, '/remote-protocol'),
      { method: 'POST', body: JSON.stringify({ target }) },
    ),
  switchRemoteProtocolBatch: (target: RemoteProtocol, repositoryIds: string[]) =>
    request<RemoteProtocolBatchResult>('/api/repositories/remote-protocol', {
      method: 'POST',
      body: JSON.stringify({ target, repositoryIds }),
    }),
  repositoryRemotes: (id: string) =>
    request<RepositoryRemotesSnapshot>(repoPath(id, '/remotes')),
  addRepositoryRemote: (id: string, input: { name: string; url: string }) =>
    request<{ operation: { message: string; state: string }; result: RepositoryRemoteMutation }>(
      repoPath(id, '/remotes'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  setRepositoryRemoteUrl: (id: string, input: { name: string; url: string }) =>
    request<{ operation: { message: string; state: string }; result: RepositoryRemoteMutation }>(
      repoPath(id, '/remotes/url'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  renameRepositoryRemote: (id: string, input: { name: string; nextName: string }) =>
    request<{ operation: { message: string; state: string }; result: RepositoryRemoteMutation }>(
      repoPath(id, '/remotes/rename'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  removeRepositoryRemote: (id: string, input: { name: string }) =>
    request<{ operation: { message: string; state: string }; result: RepositoryRemoteMutation }>(
      repoPath(id, '/remotes/remove'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  startBatch: (type: BatchOperationType, repositoryIds?: string[]) =>
    request<{ batch: OperationsPayload['batches'][number] }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify({ type, repositoryIds }),
    }),
  fetchRepository: (id: string) =>
    request<{ operation: { message: string; state: string }; result: RepositoryStatus }>(repoPath(id, '/fetch'), {
      method: 'POST',
    }),
  pullRepository: (id: string, options: { stashFirst?: boolean; rebase?: boolean } = {}) =>
    request<{ operation: { message: string; state: string }; result: RepositoryStatus }>(repoPath(id, '/pull'), {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  pushRepository: (id: string) =>
    request<{ operation: { message: string; state: string }; result: RepositoryStatus }>(repoPath(id, '/push'), {
      method: 'POST',
    }),
  syncRepository: (id: string, options: { stashFirst?: boolean; rebase?: boolean } = {}) =>
    request<{ operation: { message: string; state: string }; result: RepositoryStatus }>(repoPath(id, '/sync'), {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  repositoryBranches: (id: string) =>
    request<BranchesSnapshot>(repoPath(id, '/branches')),
  upstreamRepairPlan: (id: string) =>
    request<UpstreamRepairPlan>(repoPath(id, '/upstream/repair')),
  repairUpstream: (id: string, input: UpstreamRepairRequest) =>
    request<OperationEnvelope<UpstreamRepairResult>>(repoPath(id, '/upstream'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  repositoryCommits: (id: string, options?: CommitPageQuery, signal?: AbortSignal) =>
    request<CommitPage>(
      repoPath(id, `/commits?${new URLSearchParams(Object.entries(options ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`), { signal },
    ),
  commitDetail: (id: string, hash: string, filePath?: string, signal?: AbortSignal) =>
    request<CommitDetail>(
      repoPath(id, `/commits/${encodeURIComponent(hash)}${filePath ? `?${new URLSearchParams({ filePath })}` : ''}`),
      { signal },
    ),
  branchComparison: (id: string, tip: string, baseTip: string, signal?: AbortSignal) =>
    request<BranchComparison>(repoPath(id, `/comparison?${new URLSearchParams({ tip, baseTip })}`), { signal }),
  revisionTree: (id: string, input: { commit: string; path: string; skip?: number; search?: string }, signal?: AbortSignal) =>
    request<RevisionTreePage>(repoPath(id, `/tree?${new URLSearchParams({ ...input, skip: String(input.skip ?? 0) })}`), { signal }),
  revisionFile: (id: string, commit: string, path: string, signal?: AbortSignal) =>
    request<RevisionFile>(repoPath(id, `/revision-file?${new URLSearchParams({ commit, path })}`), { signal }),
  fileBlame: (id: string, commit: string, path: string, signal?: AbortSignal) =>
    request<FileBlame>(repoPath(id, `/blame?${new URLSearchParams({ commit, path })}`), { signal }),
  reflog: (id: string, ref: string, snapshot?: string, skip = 0, signal?: AbortSignal) =>
    request<ReflogPage>(repoPath(id, `/reflog?${new URLSearchParams({ ref, skip: String(skip), ...(snapshot ? { snapshot } : {}) })}`), { signal }),
  conflictPreview: (id: string, fileId: string, signal?: AbortSignal) =>
    request<ConflictPreview>(repoPath(id, `/conflicts/preview?${new URLSearchParams({ fileId })}`), { signal }),
  switchRepositoryBranch: (id: string, branch: string, expectedBranch: string | null, expectedHead: string) =>
    request<OperationEnvelope<{ status: RepositoryStatus; files: FileChange[]; branches: BranchesSnapshot }>>(repoPath(id, '/branches/switch'), {
      method: 'POST',
      body: JSON.stringify({ branch, expectedBranch, expectedHead }),
    }),
  previewBranchMerge: (id: string, input: MergePreviewRequest) => request<MergePreview>(repoPath(id, '/branches/merge-preview'), { method: 'POST', body: JSON.stringify(input) }),
  mergeBranch: (id: string, input: MergeBranchRequest) => request<BranchWriteResponse>(repoPath(id, '/branches/merge'), { method: 'POST', body: JSON.stringify(input) }),
  createBranch: (id: string, input: CreateBranchRequest) =>
    request<BranchWriteResponse>(repoPath(id, '/branches/create'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  renameBranch: (id: string, input: RenameBranchRequest) =>
    request<BranchWriteResponse>(repoPath(id, '/branches/rename'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteBranch: (id: string, input: DeleteBranchRequest) =>
    request<BranchWriteResponse & { result: { backupTag: string | null } }>(repoPath(id, '/branches/delete'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  branchDeletionPreview: (id: string, input: DeleteBranchRequest) =>
    request<{ preview: BranchDeletionPreview }>(repoPath(id, '/branches/delete-preview'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteRemoteBranch: (id: string, input: DeleteRemoteBranchRequest) =>
    request<BranchWriteResponse & { result: { deleted: { remote: string; branch: string; head: string } } }>(
      repoPath(id, '/branches/delete-remote'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  checkoutRemoteBranch: (id: string, input: CheckoutRemoteBranchRequest) =>
    request<BranchWriteResponse>(repoPath(id, '/branches/checkout-remote'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  repositoryFiles: (id: string) =>
    request<{ files: FileChange[] }>(repoPath(id, '/files')),
  repositoryStashes: (id: string) =>
    request<{ stashes: StashEntry[] }>(repoPath(id, '/stashes')),
  repositoryTags: (id: string) =>
    request<{ tags: TagEntry[] }>(repoPath(id, '/tags')),
  /** `tags` 为 null 表示读不到远端（无远端 / 离线 / 认证失败），不能据此判断标签是否存在。 */
  remoteTagNames: (id: string) =>
    request<{ remote: string; tags: string[] | null }>(repoPath(id, '/tags/remote')),
  createTag: (id: string, input: CreateTagRequest) =>
    request<OperationEnvelope<{ tag: TagEntry; tags: TagEntry[]; status: RepositoryStatus; pushed: boolean; pushError: string | null }>>(repoPath(id, '/tags'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteTag: (id: string, input: DeleteTagRequest) =>
    request<OperationEnvelope<{ tag: TagEntry; tags: TagEntry[]; status: RepositoryStatus }>>(repoPath(id, '/tags/delete'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteRemoteTag: (id: string, input: DeleteRemoteTagRequest) =>
    request<OperationEnvelope<{ tag: TagEntry; tags: TagEntry[]; status: RepositoryStatus }>>(repoPath(id, '/tags/delete-remote'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  pushTag: (id: string, input: PushTagRequest) =>
    request<OperationEnvelope<{ tag: TagEntry }>>(repoPath(id, '/tags/push'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createStash: (id: string, message: string, includeUntracked: boolean) =>
    request<OperationEnvelope<{ stash: StashEntry; stashes: StashEntry[] }>>(repoPath(id, '/stashes'), {
      method: 'POST',
      body: JSON.stringify({ message, includeUntracked }),
    }),
  stashDetail: (id: string, hash: string, signal?: AbortSignal) =>
    request<StashDetail>(repoPath(id, `/stashes/${encodeURIComponent(hash)}/patch`), { signal }),
  applyStash: (id: string, stash: Pick<StashEntry, 'ref' | 'hash'>) =>
    request<OperationEnvelope<{ stash: StashEntry; stashes: StashEntry[] }>>(repoPath(id, '/stashes/apply'), {
      method: 'POST',
      body: JSON.stringify({ ref: stash.ref, expectedHash: stash.hash }),
    }),
  popStash: (id: string, stash: Pick<StashEntry, 'ref' | 'hash'>) =>
    request<OperationEnvelope<{ stash: StashEntry; stashes: StashEntry[]; status: RepositoryStatus }>>(repoPath(id, '/stashes/pop'), {
      method: 'POST',
      body: JSON.stringify({ ref: stash.ref, expectedHash: stash.hash }),
    }),
  dropStash: (id: string, stash: Pick<StashEntry, 'ref' | 'hash'>) =>
    request<OperationEnvelope<{ stash: StashEntry; stashes: StashEntry[]; status: RepositoryStatus }>>(repoPath(id, '/stashes/drop'), {
      method: 'POST',
      body: JSON.stringify({ ref: stash.ref, expectedHash: stash.hash }),
    }),
  openRepository: (id: string, target: 'finder' | 'terminal' | 'vscode' | 'reveal' | 'editor', fileId?: string, ignoreFile?: 'gitignore' | 'exclude') =>
    request<{ opened: string }>(repoPath(id, '/open'), {
      method: 'POST',
      body: JSON.stringify({ target, fileId, ignoreFile }),
    }),
  fileDiff: (id: string, fileId: string, kind: 'staged' | 'unstaged') =>
    request<{ path: string; kind: string; diff: string; truncated: boolean }>(
      repoPath(id, `/diff?kind=${kind}&fileId=${encodeURIComponent(fileId)}`),
    ),
  stageFiles: (id: string, fileIds: string[]) =>
    request<{ files: FileChange[] }>(repoPath(id, '/stage'), {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }),
  unstageFiles: (id: string, fileIds: string[]) =>
    request<{ files: FileChange[] }>(repoPath(id, '/unstage'), {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }),
  applyHunks: (id: string, input: ApplyHunksRequest) =>
    request<{ result: AppliedHunksResult; status: RepositoryStatus; files: FileChange[] }>(
      repoPath(id, '/hunks'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  discardFile: (id: string, fileId: string) =>
    request<{ result: { action: 'trash' | 'restore'; path: string }; files: FileChange[] }>(
      repoPath(id, '/files/discard'),
      { method: 'POST', body: JSON.stringify({ fileId }) },
    ),
  repositoryIgnoredFiles: (id: string) =>
    request<{ ignored: IgnoredEntry[]; truncated: boolean }>(
      repoPath(id, '/ignored'),
    ),
  ignoreRule: (id: string, input: IgnoreRuleRequest) =>
    request<{ result: IgnoreRuleResult; files: FileChange[]; status: RepositoryStatus }>(
      repoPath(id, '/ignore'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  ignoreRules: (id: string) =>
    request<{ files: IgnoreFileRules[] }>(repoPath(id, '/ignore-rules')),
  removeIgnoreRule: (id: string, input: RemoveIgnoreRuleRequest) =>
    request<{ result: RemoveIgnoreRuleResult; files: FileChange[]; status: RepositoryStatus }>(
      repoPath(id, '/ignore-rules/remove'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  unignoreFile: (id: string, fileId: string) =>
    request<{
      result: { removed: boolean; source: string; pattern: string; line: number | null; displayPath: string | null };
      message: string;
      files: FileChange[];
      status: RepositoryStatus;
    }>(repoPath(id, '/ignore-rules/unignore'), {
      method: 'POST',
      body: JSON.stringify({ fileId }),
    }),
  markedFiles: (id: string) =>
    request<{ files: MarkedFile[] }>(repoPath(id, '/assume-unchanged')),
  setAssumeUnchanged: (id: string, input: AssumeUnchangedRequest) =>
    request<{ result: { path: string; assumed: boolean }; files: FileChange[]; marked: MarkedFile[]; status: RepositoryStatus }>(
      repoPath(id, '/assume-unchanged'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  resolveConflict: (id: string, input: ResolveConflictRequest) =>
    request<{
      result: { action: ConflictResolutionStrategy; path: string };
      status: RepositoryStatus;
      files: FileChange[];
    }>(repoPath(id, '/conflicts/resolve'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  continueOperation: (id: string) =>
    request<ConflictOperationResponse>(repoPath(id, '/conflicts/continue'), {
      method: 'POST',
    }),
  abortOperation: (id: string) =>
    request<ConflictOperationResponse>(repoPath(id, '/conflicts/abort'), {
      method: 'POST',
    }),
  commitPreview: (id: string) =>
    request<CommitPreview>(repoPath(id, '/commit/preview'), { method: 'POST' }),
  suggestCommit: (id: string, fingerprint: string, signal?: AbortSignal) =>
    request<CommitSuggestion>(repoPath(id, '/commit/suggest'), {
      method: 'POST',
      body: JSON.stringify({ fingerprint }),
      signal,
    }),
  commit: (id: string, message: string, fingerprint: string, pushAfterCommit = false) =>
    request<{ operation: { message: string; state: string }; pushOperation: { message: string; state: string } | null; message: string }>(repoPath(id, '/commit'), {
      method: 'POST',
      body: JSON.stringify({ message, fingerprint, pushAfterCommit }),
    }),
  autoCommit: (id: string, fingerprint: string, pushAfterCommit = false) =>
    request<{ operation: { message: string; state: string }; pushOperation: { message: string; state: string } | null; message: string }>(repoPath(id, '/commit/auto'), {
      method: 'POST',
      body: JSON.stringify({ fingerprint, pushAfterCommit }),
    }),
  lastCommit: (id: string) =>
    request<LastCommitSnapshot>(repoPath(id, '/commit/last')),
  amendCommit: (id: string, input: { message: string; fingerprint: string }) =>
    request<{ operation: { message: string; state: string }; result: CommitRewriteResult }>(
      repoPath(id, '/commit/amend'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  undoCommit: (id: string, input: { fingerprint: string }) =>
    request<{ operation: { message: string; state: string }; result: CommitRewriteResult }>(
      repoPath(id, '/commit/undo'),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  revertCommit: (id: string, hash: string) =>
    request<{ operation: { message: string; state: string }; result: ReplayResult & { status: RepositoryStatus } }>(
      repoPath(id, '/commit/revert'),
      { method: 'POST', body: JSON.stringify({ hash }) },
    ),
  cherryPickCommit: (id: string, hash: string) =>
    request<{ operation: { message: string; state: string }; result: ReplayResult & { status: RepositoryStatus } }>(
      repoPath(id, '/commit/cherry-pick'),
      { method: 'POST', body: JSON.stringify({ hash }) },
    ),
  cloneRepository: (input: { rootId: string; url: string; directory?: string; name?: string; group?: string }) =>
    request<CloneRepositoryResult>('/api/repositories/clone', { method: 'POST', body: JSON.stringify(input) }),
  commitHeatmap: (range: AnalyticsRange, repositoryIds: AnalyticsRepositoryScope = null) => {
    const query = new URLSearchParams();
    if (range.kind === 'preset') query.set('weeks', String(range.weeks));
    else {
      query.set('start', range.start);
      query.set('end', range.end);
    }
    if (repositoryIds !== null) query.set('repositoryIds', JSON.stringify(repositoryIds));
    return request<CommitHeatmapData>(`/api/analytics/heatmap?${query}`);
  },
};
