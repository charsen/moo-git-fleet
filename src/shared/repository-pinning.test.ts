import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from './contracts.js';
import { compareRepositoryActivity, compareRepositoryLastCommit, compareRepositoryPinning } from './repository-pinning.js';

function repository(name: string, pinned: boolean, committedAt: string | null): RepositoryStatus {
  return {
    config: { id: name, name, root: 'dev', path: name, group: 'test', enabled: true, pinned, order: 0, tags: [], aiCommitPolicy: 'redacted-patch', capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true } },
    absolutePath: `/tmp/${name}`, available: true, branch: 'master', detached: false, upstream: 'origin/master', remoteUrl: null,
    ahead: 0, behind: 0, changedFiles: 0, staged: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, stashCount: 0,
    inProgressOperation: null, lastFetchedAt: null, state: 'clean',
    lastCommit: committedAt ? { hash: name, subject: name, author: 'test', committedAt } : null,
    latestTag: null, gitIdentity: { name: 'test', email: 'test@example.com', complete: true }, scannedAt: committedAt ?? '', error: null,
  };
}

describe('compareRepositoryPinning', () => {
  it('always places pinned repositories before unpinned repositories', () => {
    expect(compareRepositoryPinning(repository('old-pin', true, '2026-01-01T00:00:00Z'), repository('new', false, '2026-07-21T00:00:00Z'))).toBeLessThan(0);
  });

  it('orders multiple pinned repositories by latest commit descending', () => {
    const repositories = [
      repository('older', true, '2026-07-19T00:00:00Z'),
      repository('newer', true, '2026-07-21T00:00:00Z'),
    ];
    repositories.sort((a, b) => compareRepositoryPinning(a, b) ?? 0);
    expect(repositories.map((item) => item.config.name)).toEqual(['newer', 'older']);
  });

  it('leaves two unpinned repositories to the selected downstream sort', () => {
    expect(compareRepositoryPinning(repository('a', false, null), repository('b', false, null))).toBeNull();
  });

  it('orders ordinary repositories by latest commit and places repositories without commits last', () => {
    const repositories = [
      repository('no-commit', false, null),
      repository('older', false, '2026-07-19T00:00:00Z'),
      repository('newer', false, '2026-07-21T00:00:00Z'),
    ];
    repositories.sort(compareRepositoryLastCommit);
    expect(repositories.map((item) => item.config.name)).toEqual(['newer', 'older', 'no-commit']);
  });

  it('uses the repository name as a stable fallback for missing or invalid commit dates', () => {
    const repositories = [repository('zeta', false, null), repository('alpha', false, 'not-a-date')];
    repositories.sort(compareRepositoryLastCommit);
    expect(repositories.map((item) => item.config.name)).toEqual(['alpha', 'zeta']);
  });

  it('places repositories with activity before clean repositories and uses commit time within the same state', () => {
    const cleanNewest = repository('clean-newest', false, '2026-07-22T00:00:00Z');
    const dirtyOlder = repository('dirty-older', false, '2026-07-19T00:00:00Z');
    const dirtyNewer = repository('dirty-newer', false, '2026-07-21T00:00:00Z');
    dirtyOlder.state = 'dirty';
    dirtyNewer.state = 'dirty';
    const repositories = [cleanNewest, dirtyOlder, dirtyNewer];
    repositories.sort(compareRepositoryActivity);
    expect(repositories.map((item) => item.config.name)).toEqual(['dirty-newer', 'dirty-older', 'clean-newest']);
  });

  it('promotes every repository state with activity before clean repositories', () => {
    const states: RepositoryStatus['state'][] = [
      'conflict',
      'operation-in-progress',
      'diverged',
      'dirty',
      'ahead',
      'behind',
      'remote-unknown',
      'missing',
      'invalid',
    ];
    const repositories = states.map((state, index) => {
      const item = repository(state, false, `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`);
      item.state = state;
      return item;
    });
    repositories.push(repository('clean-newest', false, '2026-07-31T00:00:00Z'));

    repositories.reverse().sort(compareRepositoryActivity);

    expect(repositories.map((item) => item.state)).toEqual([...states, 'clean']);
  });
});
