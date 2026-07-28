import { describe, expect, it } from 'vitest';
import type { OperationRecord } from '../shared/contracts';
import {
  buildOperationHistoryItems,
  isOperationIssue,
  isOperationRetryable,
  operationsRefetchInterval,
} from './operation-history.js';

function operation(id: string, update: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id,
    batchId: 'batch-fetch',
    repositoryId: id,
    repositoryName: id,
    type: 'fetch',
    state: 'success',
    startedAt: '2026-07-26T08:00:00.000Z',
    finishedAt: '2026-07-26T08:00:01.000Z',
    durationMs: 1_000,
    message: 'Fetch 完成',
    ...update,
  };
}

describe('operation history presentation', () => {
  it('collapses three or more successful Fetch operations from the same batch', () => {
    const operations = [operation('a'), operation('b'), operation('c'), operation('push', { type: 'push' })];
    const items = buildOperationHistoryItems(operations, new Set());

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'successful-fetch-group', batchId: 'batch-fetch' });
    expect(items[1]).toMatchObject({ kind: 'operation', operation: { id: 'push' } });
  });

  it('keeps the group header and reveals its original operations when expanded', () => {
    const items = buildOperationHistoryItems(
      [operation('a'), operation('b'), operation('c')],
      new Set(['batch-fetch']),
    );

    expect(items.map((item) => item.kind)).toEqual([
      'successful-fetch-group',
      'operation',
      'operation',
      'operation',
    ]);
  });

  it('only treats failed and blocked skips as items needing attention', () => {
    expect(isOperationIssue(operation('failed', { state: 'failed' }))).toBe(true);
    expect(isOperationIssue(operation('blocked', { state: 'skipped', skipReason: 'blocked' }))).toBe(true);
    expect(isOperationIssue(operation('noop', { state: 'skipped', skipReason: 'not-needed' }))).toBe(false);
    expect(isOperationIssue(operation('disabled', { state: 'skipped', skipReason: 'disabled' }))).toBe(false);
    expect(isOperationIssue(operation('success'))).toBe(false);
  });

  it('keeps legacy skipped records useful without treating normal no-ops as problems', () => {
    expect(isOperationRetryable(operation('legacy-blocked', { state: 'skipped', message: '工作区不干净' }))).toBe(true);
    expect(isOperationRetryable(operation('legacy-noop', { state: 'skipped', message: '已经是最新状态' }))).toBe(false);
    expect(isOperationRetryable(operation('legacy-disabled', { state: 'skipped', message: '仓库配置禁止 pull 操作' }))).toBe(false);
  });
});

describe('operations polling fallback', () => {
  it('keeps a low-frequency safety poll while a batch is running even when SSE is connected', () => {
    expect(operationsRefetchInterval(true, true)).toBe(2_000);
    expect(operationsRefetchInterval(false, true)).toBe(1_000);
  });

  it('stops idle polling when SSE is healthy and uses a slow fallback when disconnected', () => {
    expect(operationsRefetchInterval(true, false)).toBe(false);
    expect(operationsRefetchInterval(false, false)).toBe(10_000);
  });
});
