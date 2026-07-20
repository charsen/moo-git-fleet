import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { appRoot } from '../config/store.js';

export type OperationType = 'fetch' | 'pull' | 'push';
export type OperationState = 'running' | 'success' | 'failed' | 'skipped';

export interface OperationRecord {
  id: string;
  repositoryId: string;
  repositoryName: string;
  type: OperationType;
  state: OperationState;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  message: string;
}

const activeRepositories = new Set<string>();
const recentOperations: OperationRecord[] = [];
const operationLogPath = path.join(appRoot, '.data', 'operations.jsonl');

async function persist(record: OperationRecord): Promise<void> {
  await mkdir(path.dirname(operationLogPath), { recursive: true });
  await appendFile(operationLogPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export async function runOperation<T>(
  repository: { id: string; name: string },
  type: OperationType,
  handler: () => Promise<{ result: T; message: string; skipped?: boolean }>,
): Promise<{ operation: OperationRecord; result: T }> {
  if (activeRepositories.has(repository.id)) throw new Error('该仓库已有 Git 操作正在执行');
  activeRepositories.add(repository.id);
  const startedAt = Date.now();
  const operation: OperationRecord = {
    id: randomUUID(),
    repositoryId: repository.id,
    repositoryName: repository.name,
    type,
    state: 'running',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: null,
    message: '',
  };
  recentOperations.unshift(operation);
  if (recentOperations.length > 100) recentOperations.length = 100;

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
    activeRepositories.delete(repository.id);
    await persist(operation).catch(() => undefined);
  }
}

export function listOperations(): OperationRecord[] {
  return recentOperations;
}
