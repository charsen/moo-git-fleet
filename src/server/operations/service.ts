import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BatchOperationType,
  BatchRecord,
  OperationRecord,
  OperationType,
  RepositoryConfig,
} from '../../shared/contracts.js';
import { appRoot } from '../config/store.js';

const activeRepositories = new Set<string>();
const recentOperations: OperationRecord[] = [];
const recentBatches: BatchRecord[] = [];
const operationLogPath = path.join(appRoot, '.data', 'operations.jsonl');

function isBatchOperationType(type: OperationType): type is BatchOperationType {
  return type === 'fetch' || type === 'pull' || type === 'push';
}

async function persist(record: OperationRecord): Promise<void> {
  await mkdir(path.dirname(operationLogPath), { recursive: true });
  await appendFile(operationLogPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function rememberOperation(operation: OperationRecord): void {
  recentOperations.unshift(operation);
  if (recentOperations.length > 100) recentOperations.length = 100;
}

function queuedOperation(
  repository: Pick<RepositoryConfig, 'id' | 'name'>,
  type: OperationType,
  batchId: string | null,
): OperationRecord {
  const operation: OperationRecord = {
    id: randomUUID(),
    batchId,
    repositoryId: repository.id,
    repositoryName: repository.name,
    type,
    state: 'queued',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    message: '等待执行',
  };
  rememberOperation(operation);
  return operation;
}

async function executeOperation<T>(
  operation: OperationRecord,
  handler: () => Promise<{ result: T; message: string; skipped?: boolean }>,
): Promise<{ operation: OperationRecord; result: T }> {
  if (activeRepositories.has(operation.repositoryId)) {
    const now = new Date().toISOString();
    operation.state = 'failed';
    operation.startedAt = now;
    operation.finishedAt = now;
    operation.durationMs = 0;
    operation.message = '该仓库已有 Git 操作正在执行';
    await persist(operation).catch(() => undefined);
    throw new Error(operation.message);
  }
  activeRepositories.add(operation.repositoryId);
  const startedAt = Date.now();
  operation.state = 'running';
  operation.startedAt = new Date(startedAt).toISOString();
  operation.message = '执行中';

  try {
    const output = await handler();
    operation.state = output.skipped ? 'skipped' : 'success';
    operation.message = output.message;
    return { operation, result: output.result };
  } catch (error) {
    operation.state = 'failed';
    operation.message = error instanceof Error ? error.message : 'Git 操作失败';
    throw error;
  } finally {
    operation.finishedAt = new Date().toISOString();
    operation.durationMs = Date.now() - startedAt;
    activeRepositories.delete(operation.repositoryId);
    await persist(operation).catch(() => undefined);
  }
}

export async function initializeOperations(): Promise<void> {
  if (recentOperations.length > 0) return;
  try {
    const lines = (await readFile(operationLogPath, 'utf8')).trim().split('\n').filter(Boolean).slice(-100).reverse();
    for (const line of lines) {
      const parsed = JSON.parse(line) as OperationRecord;
      recentOperations.push({ ...parsed, batchId: parsed.batchId ?? null });
    }
    const grouped = new Map<string, OperationRecord[]>();
    for (const operation of recentOperations) {
      if (!operation.batchId || !isBatchOperationType(operation.type)) continue;
      const operations = grouped.get(operation.batchId) ?? [];
      operations.push(operation);
      grouped.set(operation.batchId, operations);
    }
    for (const [id, operations] of grouped) {
      const first = operations[0];
      if (!first || !isBatchOperationType(first.type)) continue;
      const createdAt = operations
        .map((operation) => operation.startedAt ?? operation.finishedAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? new Date().toISOString();
      const finishedAt = operations
        .map((operation) => operation.finishedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      recentBatches.push({
        id,
        type: first.type,
        state: 'completed',
        createdAt,
        finishedAt,
        total: operations.length,
        completed: operations.length,
        success: operations.filter((operation) => operation.state === 'success').length,
        skipped: operations.filter((operation) => operation.state === 'skipped').length,
        failed: operations.filter((operation) => operation.state === 'failed').length,
      });
    }
    recentBatches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (recentBatches.length > 20) recentBatches.length = 20;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function runOperation<T>(
  repository: { id: string; name: string },
  type: OperationType,
  handler: () => Promise<{ result: T; message: string; skipped?: boolean }>,
): Promise<{ operation: OperationRecord; result: T }> {
  return executeOperation(queuedOperation(repository, type, null), handler);
}

export function listOperations(): OperationRecord[] {
  return recentOperations;
}

export function listBatches(): BatchRecord[] {
  return recentBatches;
}

export function startBatch<T>(
  repositories: Array<Pick<RepositoryConfig, 'id' | 'name'>>,
  type: BatchOperationType,
  concurrency: number,
  handler: (repository: Pick<RepositoryConfig, 'id' | 'name'>) => Promise<{
    result: T;
    message: string;
    skipped?: boolean;
  }>,
): BatchRecord {
  const batch: BatchRecord = {
    id: randomUUID(),
    type,
    state: repositories.length === 0 ? 'completed' : 'running',
    createdAt: new Date().toISOString(),
    finishedAt: repositories.length === 0 ? new Date().toISOString() : null,
    total: repositories.length,
    completed: 0,
    success: 0,
    skipped: 0,
    failed: 0,
  };
  recentBatches.unshift(batch);
  if (recentBatches.length > 20) recentBatches.length = 20;
  const queue = repositories.map((repository) => ({
    repository,
    operation: queuedOperation(repository, type, batch.id),
  }));

  void (async () => {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
      while (nextIndex < queue.length) {
        const item = queue[nextIndex];
        nextIndex += 1;
        if (!item) continue;
        try {
          await executeOperation(item.operation, () => handler(item.repository));
        } catch {
          // The operation already contains the actionable error and the batch continues.
        }
        batch.completed += 1;
        batch[item.operation.state === 'success' ? 'success' : item.operation.state === 'skipped' ? 'skipped' : 'failed'] += 1;
      }
    });
    await Promise.all(workers);
    batch.state = 'completed';
    batch.finishedAt = new Date().toISOString();
  })();

  return batch;
}
