import type { ProfileViewPreferences } from '../shared/contracts';

export const defaultViewPreferences: ProfileViewPreferences = {
  repositorySort: 'activity',
  repositoryFilter: 'all',
  batchScope: 'visible',
};

const repositorySortModes = new Set(['activity', 'name', 'group', 'commit', 'fetch']);
const repositoryFilters = new Set(['all', 'attention', 'dirty', 'ahead', 'behind', 'stale']);
const batchScopes = new Set(['visible', 'all']);

export function parseViewPreferences(value: unknown): ProfileViewPreferences | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ProfileViewPreferences>;
  if (!repositorySortModes.has(candidate.repositorySort ?? '')) return null;
  if (!repositoryFilters.has(candidate.repositoryFilter ?? '')) return null;
  if (!batchScopes.has(candidate.batchScope ?? '')) return null;
  return {
    repositorySort: candidate.repositorySort as ProfileViewPreferences['repositorySort'],
    repositoryFilter: candidate.repositoryFilter as ProfileViewPreferences['repositoryFilter'],
    batchScope: candidate.batchScope as ProfileViewPreferences['batchScope'],
  };
}
