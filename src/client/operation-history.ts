import type { OperationRecord, OperationSkipReason } from '../shared/contracts';

export interface OperationHistoryRow {
  kind: 'operation';
  key: string;
  operation: OperationRecord;
  operationIndex: number;
  nested: boolean;
}

export interface SuccessfulFetchGroup {
  kind: 'successful-fetch-group';
  key: string;
  batchId: string;
  operations: OperationRecord[];
  expanded: boolean;
}

export type OperationHistoryItem = OperationHistoryRow | SuccessfulFetchGroup;

export function operationSkipReason(operation: OperationRecord): OperationSkipReason | null {
  if (operation.state !== 'skipped') return null;
  if (operation.skipReason) return operation.skipReason;
  if (/已经是最新状态|没有需要推送的 commit|本地存在领先提交，无需 Pull/.test(operation.message)) {
    return 'not-needed';
  }
  if (operation.message.includes('仓库配置禁止')) return 'disabled';
  return 'blocked';
}

export function isOperationIssue(operation: OperationRecord): boolean {
  return operation.state === 'failed' || operationSkipReason(operation) === 'blocked';
}

export function isOperationRetryable(operation: OperationRecord): boolean {
  return operation.state === 'failed' || operationSkipReason(operation) === 'blocked';
}

export function operationsRefetchInterval(streamConnected: boolean, hasRunningBatch: boolean): number | false {
  if (hasRunningBatch) return streamConnected ? 2_000 : 1_000;
  return streamConnected ? false : 10_000;
}

function isSuccessfulBatchFetch(operation: OperationRecord): operation is OperationRecord & { batchId: string } {
  return operation.type === 'fetch' && operation.state === 'success' && Boolean(operation.batchId);
}

export function buildOperationHistoryItems(
  operations: OperationRecord[],
  expandedBatchIds: ReadonlySet<string>,
  minimumGroupSize = 3,
): OperationHistoryItem[] {
  const successfulFetchGroups = new Map<string, OperationRecord[]>();
  for (const operation of operations) {
    if (!isSuccessfulBatchFetch(operation)) continue;
    const group = successfulFetchGroups.get(operation.batchId) ?? [];
    group.push(operation);
    successfulFetchGroups.set(operation.batchId, group);
  }

  const operationIndexes = new Map(operations.map((operation, index) => [operation.id, index]));
  const emittedBatchIds = new Set<string>();
  const items: OperationHistoryItem[] = [];

  for (const operation of operations) {
    if (isSuccessfulBatchFetch(operation)) {
      const batchId = operation.batchId;
      const group = successfulFetchGroups.get(batchId);
      if (group && group.length >= minimumGroupSize) {
        if (emittedBatchIds.has(batchId)) continue;
        emittedBatchIds.add(batchId);
        const expanded = expandedBatchIds.has(batchId);
        items.push({
          kind: 'successful-fetch-group',
          key: `fetch-group:${batchId}`,
          batchId,
          operations: group,
          expanded,
        });
        if (expanded) {
          items.push(...group.map((groupedOperation) => ({
            kind: 'operation' as const,
            key: groupedOperation.id,
            operation: groupedOperation,
            operationIndex: operationIndexes.get(groupedOperation.id) ?? 0,
            nested: true,
          })));
        }
        continue;
      }
    }
    items.push({
      kind: 'operation',
      key: operation.id,
      operation,
      operationIndex: operationIndexes.get(operation.id) ?? 0,
      nested: false,
    });
  }

  return items;
}
