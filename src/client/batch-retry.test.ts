import { describe, expect, it } from 'vitest';
import type { BatchRecord, OperationRecord } from '../shared/contracts';
import { batchRetryConfirmationDetails, batchSignalAriaLabel, retryableBatchRepositoryIds } from './batch-retry.js';

const batch: BatchRecord = {
  id: 'batch-current',
  type: 'pull',
  state: 'completed',
  createdAt: '2026-07-20T10:00:00.000Z',
  finishedAt: '2026-07-20T10:01:00.000Z',
  total: 4,
  completed: 4,
  success: 1,
  skipped: 2,
  failed: 1,
};

function operation(update: Partial<OperationRecord>): OperationRecord {
  return {
    id: crypto.randomUUID(),
    batchId: batch.id,
    repositoryId: 'repository-a',
    repositoryName: 'Repository A',
    type: batch.type,
    state: 'failed',
    startedAt: batch.createdAt,
    finishedAt: batch.finishedAt,
    durationMs: 100,
    message: 'failed',
    ...update,
  };
}

describe('batch retry selection', () => {
  it('selects unique failed and blocked repositories that are still enabled', () => {
    const operations = [
      operation({ repositoryId: 'repository-a', state: 'failed' }),
      operation({ repositoryId: 'repository-b', state: 'skipped', skipReason: 'blocked' }),
      operation({ repositoryId: 'repository-a', state: 'skipped', skipReason: 'blocked' }),
      operation({ repositoryId: 'repository-noop', state: 'skipped', skipReason: 'not-needed' }),
      operation({ repositoryId: 'repository-disabled', state: 'skipped', skipReason: 'disabled' }),
      operation({ repositoryId: 'repository-c', state: 'success' }),
      operation({ repositoryId: 'repository-d', batchId: 'batch-older' }),
      operation({ repositoryId: 'repository-e', type: 'push' }),
      operation({ repositoryId: 'repository-removed', state: 'failed' }),
    ];

    expect(
      retryableBatchRepositoryIds(
        batch,
        operations,
        ['repository-a', 'repository-b', 'repository-c', 'repository-noop', 'repository-disabled'],
      ),
    ).toEqual(['repository-a', 'repository-b']);
  });

  it('does not retry a multi-branch push batch', () => {
    // startBatch 重新入队时只带仓库 id，重试会退化成「只推当前分支」，
    // 把「推 dev + 主分支」的意图悄悄改掉，所以整类不给重试。
    const multi = { ...batch, type: 'push-branches' as const };
    expect(
      retryableBatchRepositoryIds(multi, [operation({ type: 'push-branches', state: 'failed' })], ['repository-a']),
    ).toEqual([]);
  });

  it('does not retry multi-branch pull or double-line merge batches either', () => {
    // 同一条理由：重新入队只带仓库 id，拉取会退化成「只拉当前分支」，
    // 合并会重跑一次计划，都不该由一个「重试」按钮悄悄决定。
    for (const type of ['pull-branches', 'merge-branches'] as const) {
      expect(
        retryableBatchRepositoryIds({ ...batch, type }, [operation({ type, state: 'failed' })], ['repository-a']),
      ).toEqual([]);
    }
  });

  it('does not retry a running or missing batch', () => {
    const running = { ...batch, state: 'running' as const };
    expect(retryableBatchRepositoryIds(running, [operation({})], ['repository-a'])).toEqual([]);
    expect(retryableBatchRepositoryIds(null, [operation({})], ['repository-a'])).toEqual([]);
  });
});

describe('batch retry confirmation', () => {
  it('describes Pull as integrating with merge by default', () => {
    expect(batchRetryConfirmationDetails('pull')).toEqual([
      '默认 merge 整合远端，工作区不满足条件时可勾选自动 Stash。',
      '条件仍不满足的仓库会再次跳过。',
    ]);
  });

  it('describes Push checks without claiming to run Fetch', () => {
    const details = batchRetryConfirmationDetails('push');

    expect(details).toEqual([
      '重新检查每个仓库的工作区、upstream 和远端状态。',
      '继续使用明确 refspec，永远不会 force push。',
    ]);
    expect(details.join('')).not.toContain('Fetch');
  });
});

describe('batch progress signal', () => {
  it('announces a running batch as in progress', () => {
    expect(batchSignalAriaLabel({ ...batch, state: 'running', completed: 2 })).toBe(
      'PULL 批量任务正在执行 2 / 4，打开操作记录',
    );
  });

  it('announces a completed batch as completed', () => {
    expect(batchSignalAriaLabel(batch)).toBe('PULL 批量任务已完成 4 / 4，打开操作记录');
  });

  it('names a multi-branch batch in Chinese instead of the raw type', () => {
    expect(batchSignalAriaLabel({ ...batch, type: 'push-branches' })).toBe(
      '多分支推送 批量任务已完成 4 / 4，打开操作记录',
    );
    expect(batchSignalAriaLabel({ ...batch, type: 'pull-branches' })).toBe(
      '多分支拉取 批量任务已完成 4 / 4，打开操作记录',
    );
  });
});
