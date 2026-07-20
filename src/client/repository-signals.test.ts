import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../shared/contracts';
import { hasWorktreeChanges, isRemoteStale, matchesRepositoryStateFilter, repositoryFilterCounts } from './repository-signals.js';

function signals(update: Partial<RepositoryStatus> = {}): RepositoryStatus {
  return {
    state: 'clean',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
    remoteUrl: 'git@example.test:fleet/repository.git',
    lastFetchedAt: '2026-07-20T08:00:00.000Z',
    gitIdentity: { name: 'Fleet', email: 'fleet@example.test', complete: true },
    ...update,
  } as RepositoryStatus;
}

describe('repository signal filters', () => {
  it('keeps remote divergence visible even when the primary state is dirty', () => {
    const repository = signals({ state: 'dirty', behind: 12, untracked: 1 });

    expect(matchesRepositoryStateFilter(repository, 'behind')).toBe(true);
    expect(matchesRepositoryStateFilter(repository, 'dirty')).toBe(true);
    expect(matchesRepositoryStateFilter(repository, 'ahead')).toBe(false);
  });

  it('counts conflict and operation states with changed files as worktree changes', () => {
    expect(hasWorktreeChanges(signals({ state: 'conflict', conflicted: 1 }))).toBe(true);
    expect(hasWorktreeChanges(signals({ state: 'operation-in-progress', staged: 1 }))).toBe(true);
  });

  it('includes a clean repository with incomplete Git identity in attention results', () => {
    const repository = signals({ gitIdentity: { name: null, email: null, complete: false } });

    expect(matchesRepositoryStateFilter(repository, 'attention')).toBe(true);
  });

  it('treats configured remotes as stale after 24 hours or before the first Fetch', () => {
    const now = Date.parse('2026-07-21T08:00:00.000Z');
    expect(isRemoteStale(signals({ lastFetchedAt: '2026-07-20T08:00:01.000Z' }), now)).toBe(false);
    expect(isRemoteStale(signals({ lastFetchedAt: '2026-07-20T08:00:00.000Z' }), now)).toBe(true);
    expect(isRemoteStale(signals({ lastFetchedAt: null }), now)).toBe(true);
    expect(isRemoteStale(signals({ remoteUrl: null, lastFetchedAt: null }), now)).toBe(false);
    expect(matchesRepositoryStateFilter(signals({ state: 'clean', lastFetchedAt: null }), 'attention', now)).toBe(true);
  });

  it('counts repositories per signal without treating commit distance as repository count', () => {
    const repositories = [
      signals({ state: 'dirty', behind: 12, untracked: 1 }),
      signals({ state: 'ahead', ahead: 3 }),
      signals(),
    ];

    expect(repositoryFilterCounts(repositories, Date.parse('2026-07-20T08:30:00.000Z'))).toEqual({
      all: 3,
      attention: 2,
      dirty: 1,
      ahead: 1,
      behind: 1,
      stale: 0,
    });
  });
});
