import { describe, expect, it } from 'vitest';
import type { DashboardPayload, RepositoryStatus } from '../shared/contracts.js';
import { replaceDashboardRepository } from './dashboard-cache.js';

describe('dashboard repository cache', () => {
  it('replaces the matching repository with the fresh operation result', () => {
    const first = { config: { id: 'first' }, behind: 0 } as RepositoryStatus;
    const second = { config: { id: 'second' }, behind: 0 } as RepositoryStatus;
    const fresh = { ...second, behind: 4 } as RepositoryStatus;
    const dashboard = { repositories: [first, second] } as DashboardPayload;

    const updated = replaceDashboardRepository(dashboard, fresh);

    expect(updated?.repositories).toEqual([first, fresh]);
    expect(dashboard.repositories).toEqual([first, second]);
  });

  it('leaves an empty query cache unchanged', () => {
    const status = { config: { id: 'first' } } as RepositoryStatus;
    expect(replaceDashboardRepository(undefined, status)).toBeUndefined();
  });
});
