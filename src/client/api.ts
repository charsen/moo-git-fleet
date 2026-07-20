import type {
  DashboardPayload,
  ProfileConfig,
  RepositoryConfig,
  ScanCandidate,
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
};
