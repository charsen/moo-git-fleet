import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../shared/contracts';
import {
  batchEligibleRepositoryCount,
  batchPlanDetails,
  pullAvailability,
  pushAvailability,
  summarizeBatchPlan,
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

describe('batch plan details', () => {
  function named(name: string, update: Partial<RepositoryStatus> = {}): RepositoryStatus {
    const base = repository(update);
    return { ...base, config: { ...base.config, id: name, name } };
  }

  it('names the repositories that will run and why the rest are skipped', () => {
    const repositories = [
      named('analytics-etl', { behind: 2 }),
      named('northwind-api', { behind: 1 }),
      named('acme-web', { ahead: 3 }),
      named('docs-site', { modified: 1, behind: 1 }),
    ];
    expect(batchPlanDetails(repositories, 'pull')).toEqual([
      '将执行：analytics-etl、northwind-api',
      '跳过：acme-web（只有本地领先提交）、docs-site（工作区不干净）',
    ]);
  });

  it('collapses long skip lists into counts ordered by frequency', () => {
    const repositories = [
      named('a', { behind: 1 }),
      named('b'),
      named('c'),
      named('d'),
      named('e'),
      named('f', { ahead: 1 }),
    ];
    expect(batchPlanDetails(repositories, 'pull')).toEqual([
      '将执行：a',
      '跳过：已是最新 ×4、只有本地领先提交 ×1',
    ]);
  });

  it('truncates a long execute list to four names plus a count', () => {
    const repositories = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => named(name, { ahead: 1 }));
    expect(batchPlanDetails(repositories, 'push')).toEqual(['将执行：a、b、c、d 等 6 个']);
  });

  it('returns a single line when everything is eligible', () => {
    expect(batchPlanDetails([named('a', { ahead: 1 })], 'push')).toEqual(['将执行：a']);
  });

  it('keeps the reason codes and the counts in sync with the batch buttons', () => {
    const dirty = named('dirty', { behind: 2, modified: 1 });
    const plan = summarizeBatchPlan([dirty, named('fresh')], 'pull');
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: 'dirty', reason: 'dirty-worktree', label: '工作区不干净' },
      { name: 'fresh', reason: 'up-to-date', label: '已是最新' },
    ]);
    expect(batchEligibleRepositoryCount([dirty], 'pull')).toBe(0);
    expect(batchEligibleRepositoryCount([dirty], 'push')).toBe(0);
  });
});
