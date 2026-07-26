import type { BatchOperationType, BatchRecord, OperationRecord } from '../shared/contracts';
import { isOperationRetryable } from './operation-history';

export function batchSignalAriaLabel(
  batch: Pick<BatchRecord, 'type' | 'state' | 'completed' | 'total'>,
): string {
  const state = batch.state === 'running' ? '正在执行' : '已完成';
  return `${batch.type.toUpperCase()} 批量任务${state} ${batch.completed} / ${batch.total}，打开操作记录`;
}

export function batchRetryConfirmationDetails(type: Exclude<BatchOperationType, 'fetch'>): string[] {
  return type === 'pull'
    ? ['重新执行全部安全预检，只允许 fast-forward。', '条件仍不满足的仓库会再次安全跳过。']
    : ['重新检查每个仓库的工作区、upstream 和远端状态。', '继续使用明确 refspec，永远不会 force push。'];
}

export function retryableBatchRepositoryIds(
  batch: BatchRecord | null,
  operations: OperationRecord[],
  enabledRepositoryIds: Iterable<string>,
): string[] {
  if (!batch || batch.state !== 'completed') return [];
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
