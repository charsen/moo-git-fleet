import type { DashboardPayload, RepositoryStatus } from '../shared/contracts.js';

export function replaceDashboardRepository(
  dashboard: DashboardPayload | undefined,
  status: RepositoryStatus,
): DashboardPayload | undefined {
  if (!dashboard) return dashboard;
  return {
    ...dashboard,
    repositories: dashboard.repositories.map((repository) => (
      repository.config.id === status.config.id ? status : repository
    )),
  };
}
