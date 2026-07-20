import type {
  CommitPreview,
  CommitSuggestion,
  DashboardPayload,
  FileChange,
  OperationsPayload,
  ProfileConfig,
  ProfileViewPreferences,
  RepositoryConfig,
  RepositoryImportCandidate,
  RepositoryManifestPreview,
  ScanCandidate,
  StashEntry,
} from '../shared/contracts';

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
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败：${response.status}`);
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
  refresh: () => request<DashboardPayload>('/api/repositories/refresh', { method: 'POST' }),
  saveProfile: (profile: ProfileConfig['profile']) =>
    request<ProfileConfig>('/api/settings/profile', { method: 'PUT', body: JSON.stringify(profile) }),
  saveViewPreferences: (viewPreferences: ProfileViewPreferences) =>
    request<ProfileConfig>('/api/settings/view-preferences', {
      method: 'PATCH',
      body: JSON.stringify(viewPreferences),
    }),
  addRoot: (id: string, path: string) =>
    request<Record<string, string>>('/api/repository-roots', {
      method: 'POST',
      body: JSON.stringify({ id, path }),
    }),
  removeRoot: (id: string) =>
    request<Record<string, string>>(`/api/repository-roots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scanRoot: (rootId: string) =>
    request<{ candidates: ScanCandidate[] }>('/api/repository-scan', {
      method: 'POST',
      body: JSON.stringify({ rootId }),
    }),
  previewRepositoryManifest: (sourcePath: string) =>
    request<RepositoryManifestPreview>('/api/repository-manifest/preview', {
      method: 'POST',
      body: JSON.stringify({ sourcePath }),
    }),
  importRepositoryManifest: (sourcePath: string, candidates: RepositoryImportCandidate[]) =>
    request<{ repositories: RepositoryConfig[] }>('/api/repository-manifest/import', {
      method: 'POST',
      body: JSON.stringify({ sourcePath, candidates }),
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
  suggestCommit: (id: string) =>
    request<CommitSuggestion>(`/api/repositories/${encodeURIComponent(id)}/commit/suggest`, { method: 'POST' }),
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
