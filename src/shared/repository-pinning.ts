import type { RepositoryStatus } from './contracts.js';

type PinnableRepository = Pick<RepositoryStatus, 'config' | 'lastCommit'>;
type ActiveRepository = Pick<RepositoryStatus, 'config' | 'lastCommit' | 'state'>;

function activityRank(repository: ActiveRepository): number {
  const rank: Record<RepositoryStatus['state'], number> = {
    conflict: 0,
    'operation-in-progress': 1,
    diverged: 2,
    dirty: 3,
    ahead: 4,
    behind: 5,
    'remote-unknown': 6,
    missing: 7,
    invalid: 8,
    clean: 9,
  };
  return rank[repository.state];
}

function latestCommitTime(repository: PinnableRepository): number {
  const timestamp = Date.parse(repository.lastCommit?.committedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function compareRepositoryLastCommit(a: PinnableRepository, b: PinnableRepository): number {
  return latestCommitTime(b) - latestCommitTime(a) || a.config.name.localeCompare(b.config.name);
}

export function compareRepositoryActivity(a: ActiveRepository, b: ActiveRepository): number {
  return activityRank(a) - activityRank(b) || compareRepositoryLastCommit(a, b);
}

export function compareRepositoryPinning(a: PinnableRepository, b: PinnableRepository): number | null {
  if (a.config.pinned !== b.config.pinned) return a.config.pinned ? -1 : 1;
  if (!a.config.pinned) return null;
  return compareRepositoryLastCommit(a, b);
}
