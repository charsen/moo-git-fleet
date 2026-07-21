import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  BatchOperationType,
  BatchRecord,
  OperationRecord,
  OperationsPayload,
  OperationType,
  RepositoryConfig,
} from '../../shared/contracts.js';
import { appRoot } from '../config/store.js';

const activeRepositories = new Set<string>();
const recentOperations: OperationRecord[] = [];
const recentBatches: BatchRecord[] = [];
const subscribers = new Set<(payload: OperationsPayload) => void>();
const dataDirectory = path.join(appRoot, '.data');
const operationLogDirectory = path.join(dataDirectory, 'operations');
const legacyOperationLogPath = path.join(dataDirectory, 'operations.jsonl');
const dayMs = 24 * 60 * 60 * 1_000;
const configuredLogMaxBytes = Number(process.env.GIT_FLEET_OPERATION_LOG_MAX_BYTES ?? 5 * 1024 * 1024);
const configuredRetentionDays = Number(process.env.GIT_FLEET_OPERATION_LOG_RETENTION_DAYS ?? 30);
const operationLogMaxBytes = Number.isFinite(configuredLogMaxBytes)
  ? Math.min(100 * 1024 * 1024, Math.max(256, Math.trunc(configuredLogMaxBytes)))
  : 5 * 1024 * 1024;
const operationLogRetentionDays = Number.isFinite(configuredRetentionDays)
  ? Math.min(365, Math.max(1, Math.trunc(configuredRetentionDays)))
  : 30;
let lastCleanupDate: string | null = null;

export async function withRepositoryLock<T>(repositoryId: string, handler: () => Promise<T>): Promise<T> {
  if (activeRepositories.has(repositoryId)) throw new Error('该仓库已有 Git 操作正在执行');
  activeRepositories.add(repositoryId);
  try {
    return await handler();
  } finally {
    activeRepositories.delete(repositoryId);
  }
}

interface OperationLogFile {
  name: string;
  date: string;
  segment: number;
}

function operationDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

function parseOperationLogFile(name: string): OperationLogFile | null {
  const match = name.match(/^operations-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.jsonl$/);
  if (!match?.[1]) return null;
  return { name, date: match[1], segment: Number(match[2] ?? 1) };
}

async function operationLogFiles(): Promise<OperationLogFile[]> {
  try {
    return (await readdir(operationLogDirectory))
      .map(parseOperationLogFile)
      .filter((file): file is OperationLogFile => Boolean(file))
      .sort((a, b) => a.date.localeCompare(b.date) || a.segment - b.segment);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function cleanupExpiredLogs(now = new Date()): Promise<void> {
  const cutoff = now.getTime() - operationLogRetentionDays * dayMs;
  const files = await operationLogFiles();
  await Promise.all(
    files
      .filter((file) => new Date(`${file.date}T00:00:00.000Z`).getTime() < cutoff)
      .map((file) => rm(path.join(operationLogDirectory, file.name), { force: true })),
  );
}

async function writableOperationLogPath(date: string): Promise<string> {
  for (let segment = 1; segment <= 10_000; segment += 1) {
    const suffix = segment === 1 ? '' : `-${segment}`;
    const filePath = path.join(operationLogDirectory, `operations-${date}${suffix}.jsonl`);
    try {
      if ((await stat(filePath)).size < operationLogMaxBytes) return filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return filePath;
      throw error;
    }
  }
  throw new Error('操作日志分片数量超出限制');
}

export function operationsPayload(): OperationsPayload {
  return {
    batches: recentBatches.map((batch) => ({ ...batch })),
    operations: recentOperations.map((operation) => ({ ...operation })),
  };
}

function publishOperations(): void {
  if (subscribers.size === 0) return;
  const payload = operationsPayload();
  for (const subscriber of subscribers) {
    try {
      subscriber(payload);
    } catch {
      // A disconnected client must never interrupt a Git operation.
    }
  }
}

export function subscribeOperations(subscriber: (payload: OperationsPayload) => void): () => void {
  subscribers.add(subscriber);
  try {
    subscriber(operationsPayload());
  } catch {
    subscribers.delete(subscriber);
  }
  return () => subscribers.delete(subscriber);
}

function isBatchOperationType(type: OperationType): type is BatchOperationType {
  return type === 'fetch' || type === 'pull' || type === 'push';
}

async function persist(record: OperationRecord): Promise<void> {
  await mkdir(operationLogDirectory, { recursive: true });
  const date = operationDate(new Date(record.finishedAt ?? record.startedAt ?? Date.now()));
  if (lastCleanupDate !== date) {
    await cleanupExpiredLogs();
    lastCleanupDate = date;
  }
  await appendFile(await writableOperationLogPath(date), `${JSON.stringify(record)}\n`, { mode: 0o600 });
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
  publishOperations();
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
    publishOperations();
    await persist(operation).catch(() => undefined);
    throw new Error(operation.message);
  }
  activeRepositories.add(operation.repositoryId);
  const startedAt = Date.now();
  operation.state = 'running';
  operation.startedAt = new Date(startedAt).toISOString();
  operation.message = '执行中';
  publishOperations();

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
    publishOperations();
    await persist(operation).catch(() => undefined);
  }
}

export async function initializeOperations(): Promise<void> {
  if (recentOperations.length > 0) return;
  await cleanupExpiredLogs();
  const files = await operationLogFiles();
  const logPaths = [legacyOperationLogPath, ...files.map((file) => path.join(operationLogDirectory, file.name))];
  const records: OperationRecord[] = [];
  for (const logPath of logPaths) {
    let contents: string;
    try {
      contents = await readFile(logPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of contents.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as OperationRecord;
        records.push({ ...parsed, batchId: parsed.batchId ?? null });
      } catch {
        // Ignore one damaged JSONL line instead of preventing local startup.
      }
    }
  }
  records.sort((a, b) => (b.finishedAt ?? b.startedAt ?? '').localeCompare(a.finishedAt ?? a.startedAt ?? ''));
  recentOperations.push(...records.slice(0, 100));

  if (recentOperations.length > 0) {
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
  }
}

export async function runOperation<T>(
  repository: { id: string; name: string },
  type: OperationType,
  handler: () => Promise<{ result: T; message: string; skipped?: boolean }>,
): Promise<{ operation: OperationRecord; result: T }> {
  const outcome = await runOperationSettled(repository, type, handler);
  if (!outcome.ok) throw outcome.error;
  return { operation: outcome.operation, result: outcome.result };
}

export async function runOperationSettled<T>(
  repository: { id: string; name: string },
  type: OperationType,
  handler: () => Promise<{ result: T; message: string; skipped?: boolean }>,
): Promise<
  | { ok: true; operation: OperationRecord; result: T }
  | { ok: false; operation: OperationRecord; error: Error }
> {
  const operation = queuedOperation(repository, type, null);
  try {
    const output = await executeOperation(operation, handler);
    return { ok: true, ...output };
  } catch (error) {
    return {
      ok: false,
      operation,
      error: error instanceof Error ? error : new Error('Git 操作失败'),
    };
  }
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
  publishOperations();
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
        publishOperations();
      }
    });
    await Promise.all(workers);
    batch.state = 'completed';
    batch.finishedAt = new Date().toISOString();
    publishOperations();
  })();

  return batch;
}
