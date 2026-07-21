import type { RepositoryState, RepositoryStatus } from '../shared/contracts';

export type RepositoryFilter = 'all' | 'today' | 'attention' | 'stale' | RepositoryState;

type RepositorySignals = Pick<
  RepositoryStatus,
  | 'state'
  | 'ahead'
  | 'behind'
  | 'staged'
  | 'modified'
  | 'untracked'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'gitIdentity'
  | 'remoteUrl'
  | 'lastFetchedAt'
>;

export const remoteFreshnessThresholdMs = 24 * 60 * 60 * 1_000;

export function hasWorktreeChanges(repository: RepositorySignals): boolean {
  return repository.staged + repository.modified + repository.untracked + repository.deleted + repository.renamed + repository.conflicted > 0;
}

export function isRemoteStale(repository: Pick<RepositorySignals, 'remoteUrl' | 'lastFetchedAt'>, now = Date.now()): boolean {
  if (!repository.remoteUrl) return false;
  if (!repository.lastFetchedAt) return true;
  const fetchedAt = new Date(repository.lastFetchedAt).getTime();
  return !Number.isFinite(fetchedAt) || now - fetchedAt >= remoteFreshnessThresholdMs;
}

export function needsDailyAction(repository: RepositorySignals): boolean {
  if (hasWorktreeChanges(repository) || (repository.ahead ?? 0) > 0 || (repository.behind ?? 0) > 0) return true;
  return ['missing', 'invalid', 'conflict', 'operation-in-progress', 'diverged'].includes(repository.state);
}

export function matchesRepositoryStateFilter(repository: RepositorySignals, filter: RepositoryFilter, now = Date.now()): boolean {
  if (filter === 'all') return true;
  if (filter === 'today') return needsDailyAction(repository);
  if (filter === 'attention') return repository.state !== 'clean' || !repository.gitIdentity.complete || isRemoteStale(repository, now);
  if (filter === 'dirty') return hasWorktreeChanges(repository);
  if (filter === 'ahead') return (repository.ahead ?? 0) > 0;
  if (filter === 'behind') return (repository.behind ?? 0) > 0;
  if (filter === 'stale') return isRemoteStale(repository, now);
  return repository.state === filter;
}

export function repositoryFilterCounts(
  repositories: RepositorySignals[],
  now = Date.now(),
): Record<'all' | 'today' | 'attention' | 'dirty' | 'ahead' | 'behind' | 'stale', number> {
  return {
    all: repositories.length,
    today: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'today', now)).length,
    attention: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'attention', now)).length,
    dirty: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'dirty', now)).length,
    ahead: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'ahead', now)).length,
    behind: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'behind', now)).length,
    stale: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'stale', now)).length,
  };
}
