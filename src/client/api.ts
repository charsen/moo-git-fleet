import type {
  DashboardPayload,
  ProfileConfig,
  RepositoryConfig,
  ScanCandidate,
} from '../shared/contracts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败：${response.status}`);
  return body;
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
};
