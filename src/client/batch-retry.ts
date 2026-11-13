import type { BatchOperationType, BatchRecord, OperationRecord } from '../shared/contracts';
import { isOperationRetryable } from './operation-history';
import { batchTypeLabel } from './presentation';

export function batchSignalAriaLabel(
  batch: Pick<BatchRecord, 'type' | 'state' | 'completed' | 'total'>,
): string {
  const state = batch.state === 'running' ? '正在执行' : '已完成';
  return `${batchTypeLabel(batch.type)} 批量任务${state} ${batch.completed} / ${batch.total}，打开操作记录`;
}

export function batchRetryConfirmationDetails(type: Exclude<BatchOperationType, 'fetch'>): string[] {
  return type === 'pull'
    ? ['默认 merge 整合远端，工作区不满足条件时可勾选自动 Stash。', '条件仍不满足的仓库会再次跳过。']
    : ['重新检查每个仓库的工作区、upstream 和远端状态。', '继续使用明确 refspec，永远不会 force push。'];
}

export function retryableBatchRepositoryIds(
  batch: BatchRecord | null,
  operations: OperationRecord[],
  enabledRepositoryIds: Iterable<string>,
): string[] {
  // 多分支批次不提供单仓重试：`startBatch` 重新入队时只带仓库 id，
  // 重试会退化成「每个仓只推 / 拉当前分支」，把「推 dev + 主分支 / 拉 dev + 主分支」的
  // 意图悄悄改掉；双线合并重试则会重新跑一次合并计划。整类都只允许用户重开窗口。
  if (
    !batch
    || batch.state !== 'completed'
    || batch.type === 'push-branches'
    || batch.type === 'pull-branches'
    || batch.type === 'merge-branches'
  ) return [];
  const enabled = new Set(enabledRepositoryIds);
  const selected = new Set<string>();
  for (const operation of operations) {
    if (
      operation.batchId === batch.id &&
      operation.type === batch.type &&
      isOperationRetryable(operation) &&
      enabled.has(operation.repositoryId)
    ) {
      selected.add(operation.repositoryId);
    }
  }
  return [...selected];
}
