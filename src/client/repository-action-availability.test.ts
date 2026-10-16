import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../shared/contracts';
import {
  batchEligibleRepositoryCount,
  pullAvailability,
  pushAvailability,
  syncAvailability,
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

describe('repository action availability', () => {
  it('allows Pull when behind, including diverged and dirty-worktree (with auto-stash)', () => {
    expect(pullAvailability(repository({ behind: 2 })).available).toBe(true);
    // 脏工作区：可用，提示自动 Stash
    expect(pullAvailability(repository({ behind: 2, modified: 1 })).available).toBe(true);
    expect(pullAvailability(repository({ behind: 2, modified: 1 })).detail).toContain('自动 Stash');
    // 分叉：可用，Pull 会整合
    expect(pullAvailability(repository({ ahead: 1, behind: 2 })).available).toBe(true);
    // 仅领先：无需 Pull
    expect(pullAvailability(repository({ ahead: 1 })).available).toBe(false);
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

  it('excludes dirty worktrees from the batch count, matching what the server actually skips', () => {
    // 批量不传 stashFirst，服务端会以 safetyBlocked 跳过脏仓库；
    // 若这里仍算作「可执行」，弹窗会先承诺 N 个、执行后却报跳过 M 个。
    const repositories = [
      repository({ config: { ...repository().config, id: 'clean-ready' }, behind: 2 }),
      repository({ config: { ...repository().config, id: 'dirty-ready' }, behind: 2, modified: 1 }),
    ];

    expect(batchEligibleRepositoryCount(repositories, 'pull')).toBe(1);

    // 单仓场景（默认允许 Auto Stash）仍然可执行，只是提示会自动暂存。
    expect(pullAvailability(repositories[1]).available).toBe(true);
    expect(pullAvailability(repositories[1]).detail).toContain('自动 Stash');
    expect(syncAvailability(repositories[1]).available).toBe(true);
    // 批量场景明确指出会被跳过，而不是静默少算。
    expect(pullAvailability(repositories[1], { allowsAutoStash: false })).toMatchObject({
      available: false,
    });
    expect(pullAvailability(repositories[1], { allowsAutoStash: false }).detail).toContain('跳过');
  });

  it('allows sync when diverged or ahead-only, including dirty-worktree (with auto-stash)', () => {
    // 分叉：可用
    expect(syncAvailability(repository({ ahead: 1, behind: 2 })).available).toBe(true);
    // 仅落后：可用，sync 拉取后自动推
    expect(syncAvailability(repository({ behind: 2 })).available).toBe(true);
    // 仅领先：可用，sync 直接推送
    expect(syncAvailability(repository({ ahead: 2 })).available).toBe(true);
    // 完全一致：无需同步
    expect(syncAvailability(repository()).available).toBe(false);
    // 分叉但工作区不干净 → 可用，提示自动 Stash
    expect(syncAvailability(repository({ ahead: 1, behind: 2, modified: 1 })).available).toBe(true);
    expect(syncAvailability(repository({ ahead: 1, behind: 2, modified: 1 })).detail).toContain('自动 Stash');
    // 未关联 upstream → 拒绝
    expect(syncAvailability(repository({ ahead: 1, behind: 2, upstream: null })).detail).toContain('upstream');
  });

  it('requires Fetch, Pull and Push capability for sync', () => {
    const withoutPush = repository({
      ahead: 1,
      behind: 2,
      config: {
        ...repository().config,
        capabilities: { ...repository().config.capabilities, push: false },
      },
    });
    expect(syncAvailability(withoutPush).detail).toContain('同时允许 Push');

    const withoutFetch = repository({
      ahead: 1,
      behind: 2,
      config: {
        ...repository().config,
        capabilities: { ...repository().config.capabilities, fetch: false },
      },
    });
    expect(syncAvailability(withoutFetch).detail).toContain('同时允许 Fetch');
  });
});
