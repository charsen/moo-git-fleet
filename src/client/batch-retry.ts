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
  options: { allowBranchTypes?: boolean } = {},
): string[] {
  // 多分支/双线合并批次是否可重试由调用方判断：只有本会话保存了原始参数
  // （modes / targets / mergeTargets / pullTargets）时才允许，否则重试会把
  // 「推 dev+main」降级成「只推当前分支」。
  if (!batch || batch.state !== 'completed') return [];
  // 默认不重试多分支/双线合并：没有原始参数时重新入队会改变用户意图。
  if (!options.allowBranchTypes && ['push-branches', 'pull-branches', 'merge-branches'].includes(batch.type)) return [];
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
