import type { RepositoryState, RepositoryStatus } from '../shared/contracts';

export type RepositoryFilter = 'all' | 'attention' | RepositoryState;

type RepositorySignals = Pick<
  RepositoryStatus,
  'state' | 'ahead' | 'behind' | 'staged' | 'modified' | 'untracked' | 'deleted' | 'renamed' | 'conflicted' | 'gitIdentity'
>;

export function hasWorktreeChanges(repository: RepositorySignals): boolean {
  return repository.staged + repository.modified + repository.untracked + repository.deleted + repository.renamed + repository.conflicted > 0;
}

export function matchesRepositoryStateFilter(repository: RepositorySignals, filter: RepositoryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return repository.state !== 'clean' || !repository.gitIdentity.complete;
  if (filter === 'dirty') return hasWorktreeChanges(repository);
  if (filter === 'ahead') return (repository.ahead ?? 0) > 0;
  if (filter === 'behind') return (repository.behind ?? 0) > 0;
  return repository.state === filter;
}

export function repositoryFilterCounts(repositories: RepositorySignals[]): Record<'all' | 'attention' | 'dirty' | 'ahead' | 'behind', number> {
  return {
    all: repositories.length,
    attention: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'attention')).length,
    dirty: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'dirty')).length,
    ahead: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'ahead')).length,
    behind: repositories.filter((repository) => matchesRepositoryStateFilter(repository, 'behind')).length,
  };
}
