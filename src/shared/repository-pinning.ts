import type { RepositoryStatus } from './contracts.js';

type PinnableRepository = Pick<RepositoryStatus, 'config' | 'lastCommit'>;

function latestCommitTime(repository: PinnableRepository): number {
  return new Date(repository.lastCommit?.committedAt ?? 0).getTime();
}

export function compareRepositoryPinning(a: PinnableRepository, b: PinnableRepository): number | null {
  if (a.config.pinned !== b.config.pinned) return a.config.pinned ? -1 : 1;
  if (!a.config.pinned) return null;
  return latestCommitTime(b) - latestCommitTime(a) || a.config.name.localeCompare(b.config.name);
}
