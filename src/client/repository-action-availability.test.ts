import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../shared/contracts';
import {
  batchEligibleRepositoryCount,
  pullAvailability,
  pushAvailability,
} from './repository-action-availability.js';

function repository(update: Partial<RepositoryStatus> = {}): RepositoryStatus {
  return {
    config: {
      id: 'repository-a',
      name: 'Repository A',
      root: 'repositories',
      path: 'repository-a',
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 1,
      tags: [],
      aiCommitPolicy: 'disabled',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    },
    absolutePath: '/tmp/repository-a',
    available: true,
    branch: 'master',
    detached: false,
    upstream: 'origin/master',
    remoteUrl: 'git@example.test:fleet/repository-a.git',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    staged: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0,
    stashCount: 0,
    inProgressOperation: null,
    lastFetchedAt: '2026-07-26T08:00:00.000Z',
    state: 'clean',
    lastCommit: null,
    latestTag: null,
    gitIdentity: { name: 'Fleet', email: 'fleet@example.test', complete: true },
    scannedAt: '2026-07-26T08:00:00.000Z',
    error: null,
    ...update,
  };
}

describe('repository safe action availability', () => {
  it('allows only a clean, behind-only repository to Pull', () => {
    expect(pullAvailability(repository({ behind: 2 })).available).toBe(true);
    expect(pullAvailability(repository({ behind: 2, modified: 1 })).detail).toContain('工作区有');
    expect(pullAvailability(repository({ ahead: 1, behind: 2 })).detail).toContain('已分叉');
  });

  it('requires Fetch capability for Pull and Push because both actions refresh first', () => {
    const withoutFetch = repository({
      ahead: 1,
      config: {
        ...repository().config,
        capabilities: { ...repository().config.capabilities, fetch: false },
      },
    });

    expect(pullAvailability(withoutFetch).detail).toContain('同时允许 Fetch');
    expect(pushAvailability(withoutFetch).detail).toContain('同时允许 Fetch');
  });

  it('allows Push with local worktree changes but rejects remote-behind or zero-ahead states', () => {
    expect(pushAvailability(repository({ ahead: 2, modified: 3 })).available).toBe(true);
    expect(pushAvailability(repository({ ahead: 2, behind: 1 })).detail).toContain('远端存在新提交');
    expect(pushAvailability(repository()).detail).toContain('没有待推送提交');
  });

  it('counts only repositories that currently pass the client-side safe precheck', () => {
    const repositories = [
      repository({ config: { ...repository().config, id: 'pull-ready' }, behind: 2 }),
      repository({ config: { ...repository().config, id: 'push-ready' }, ahead: 1 }),
      repository({ config: { ...repository().config, id: 'clean' } }),
    ];

    expect(batchEligibleRepositoryCount(repositories, 'pull')).toBe(1);
    expect(batchEligibleRepositoryCount(repositories, 'push')).toBe(1);
    expect(batchEligibleRepositoryCount(repositories, 'fetch')).toBe(3);
  });
});
