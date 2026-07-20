import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../shared/contracts';
import { hasWorktreeChanges, matchesRepositoryStateFilter } from './repository-signals.js';

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
});
