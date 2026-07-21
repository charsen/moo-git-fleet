import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from './contracts.js';
import { compareRepositoryPinning } from './repository-pinning.js';

function repository(name: string, pinned: boolean, committedAt: string | null): RepositoryStatus {
  return {
    config: { id: name, name, root: 'dev', path: name, group: 'test', enabled: true, pinned, order: 0, tags: [], aiCommitPolicy: 'redacted-patch', capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true } },
    absolutePath: `/tmp/${name}`, available: true, branch: 'master', detached: false, upstream: 'origin/master', remoteUrl: null,
    ahead: 0, behind: 0, staged: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, stashCount: 0,
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
});
