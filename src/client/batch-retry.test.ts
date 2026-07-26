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

  it('does not retry a running or missing batch', () => {
    const running = { ...batch, state: 'running' as const };
    expect(retryableBatchRepositoryIds(running, [operation({})], ['repository-a'])).toEqual([]);
    expect(retryableBatchRepositoryIds(null, [operation({})], ['repository-a'])).toEqual([]);
  });
});

describe('batch retry confirmation', () => {
  it('describes Pull as fast-forward only', () => {
    expect(batchRetryConfirmationDetails('pull')).toEqual([
      '重新执行全部安全预检，只允许 fast-forward。',
      '条件仍不满足的仓库会再次安全跳过。',
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
});
