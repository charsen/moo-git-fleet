import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  BatchOperationType,
  BatchRecord,
  OperationRecord,
  OperationSkipReason,
  OperationsPayload,
  OperationType,
  RepositoryConfig,
} from '../../shared/contracts.js';
import { appRoot } from '../config/store.js';
import { invalidateDashboardScans } from '../dashboard/service.js';

const activeRepositories = new Set<string>();
const recentOperations: OperationRecord[] = [];
const recentBatches: BatchRecord[] = [];
const activeBatchRequests = new Map<string, BatchRecord>();
const subscribers = new Set<(payload: OperationsPayload) => void>();
const dataDirectory = path.join(appRoot, '.data');
const operationLogDirectory = path.join(dataDirectory, 'operations');
const batchLeaseDirectory = path.join(dataDirectory, 'batch-leases');
const batchLeaseMaxAgeMs = 7 * 24 * 60 * 60 * 1_000;
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
let operationsInitialized = false;
let persistedLogSignature = '';

export class BatchAlreadyRunningError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('相同仓库集合的 Git 批次已有实例正在执行');
    this.name = 'BatchAlreadyRunningError';
  }
}

interface BatchLeaseRecord {
  pid: number;
  batchId: string;
  createdAt: string;
}

interface OperationOutput<T> {
  result: T;
  message: string;
  skipped?: boolean;
  skipReason?: OperationSkipReason;
}

function batchLeasePath(requestKey: string): string {
  const digest = createHash('sha256').update(requestKey).digest('hex');
  return path.join(batchLeaseDirectory, `${digest}.json`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeBatchLease(existing: BatchLeaseRecord): boolean {
  if (!processIsAlive(existing.pid)) return false;
  const createdAt = Date.parse(existing.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  return Date.now() - createdAt < batchLeaseMaxAgeMs;
}

function claimBatchLease(requestKey: string, batch: BatchRecord): string {
  mkdirSync(batchLeaseDirectory, { recursive: true, mode: 0o700 });
  const leasePath = batchLeasePath(requestKey);
  const lease: BatchLeaseRecord = { pid: process.pid, batchId: batch.id, createdAt: batch.createdAt };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(leasePath, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
      chmodSync(leasePath, 0o600);
      return leasePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: BatchLeaseRecord | null = null;
      try {
        existing = JSON.parse(readFileSync(leasePath, 'utf8')) as BatchLeaseRecord;
      } catch {
        // A partially written or damaged lease can be safely reclaimed.
      }
      if (existing && activeBatchLease(existing)) throw new BatchAlreadyRunningError();
      try {
        unlinkSync(leasePath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new BatchAlreadyRunningError();
}

function releaseBatchLease(leasePath: string, batchId: string): void {
  try {
    const existing = JSON.parse(readFileSync(leasePath, 'utf8')) as BatchLeaseRecord;
    if (existing.batchId === batchId) unlinkSync(leasePath);
  } catch {
    // A crashed or externally removed lease needs no further cleanup.
  }
}

export async function withRepositoryLock<T>(repositoryId: string, handler: () => Promise<T>): Promise<T> {
  if (activeRepositories.has(repositoryId)) throw new Error('该仓库已有 Git 操作正在执行');
  activeRepositories.add(repositoryId);
  try {
    return await handler();
  } finally {
    invalidateDashboardScans();
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
  await mkdir(operationLogDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  await chmod(operationLogDirectory, 0o700);
  const date = operationDate(new Date(record.finishedAt ?? record.startedAt ?? Date.now()));
  if (lastCleanupDate !== date) {
    await cleanupExpiredLogs();
    lastCleanupDate = date;
  }
  const logPath = await writableOperationLogPath(date);
  await appendFile(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(logPath, 0o600);
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
    skipReason: null,
  };
  rememberOperation(operation);
  publishOperations();
  return operation;
}

async function executeOperation<T>(
  operation: OperationRecord,
  handler: () => Promise<OperationOutput<T>>,
): Promise<{ operation: OperationRecord; result: T }> {
  if (activeRepositories.has(operation.repositoryId)) {
    const now = new Date().toISOString();
    operation.state = 'failed';
    operation.startedAt = now;
    operation.finishedAt = now;
    operation.durationMs = 0;
    operation.message = '该仓库已有 Git 操作正在执行';
    operation.skipReason = null;
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
    operation.skipReason = output.skipped ? output.skipReason ?? 'blocked' : null;
    return { operation, result: output.result };
  } catch (error) {
    operation.state = 'failed';
    operation.message = error instanceof Error ? error.message : 'Git 操作失败';
    operation.skipReason = null;
    throw error;
  } finally {
    operation.finishedAt = new Date().toISOString();
    operation.durationMs = Date.now() - startedAt;
    invalidateDashboardScans();
    activeRepositories.delete(operation.repositoryId);
    publishOperations();
    await persist(operation).catch(() => undefined);
  }
}

async function operationLogPaths(): Promise<string[]> {
  const files = await operationLogFiles();
  return [legacyOperationLogPath, ...files.map((file) => path.join(operationLogDirectory, file.name))];
}

async function readPersistedOperations(): Promise<{ records: OperationRecord[]; signature: string }> {
  const logPaths = await operationLogPaths();
  const signatures = await Promise.all(
    logPaths.map(async (logPath) => {
      try {
        const info = await stat(logPath);
        return `${logPath}:${info.size}:${info.mtimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${logPath}:missing`;
        throw error;
      }
    }),
  );
  const signature = signatures.join('|');
  if (signature === persistedLogSignature) return { records: [], signature };

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
  return { records, signature };
}

function operationSortTimestamp(operation: OperationRecord): string {
  return operation.finishedAt ?? operation.startedAt ?? '';
}

function rebuildBatchRecords(): void {
  const existingRunning = new Map(recentBatches.filter((batch) => batch.state === 'running').map((batch) => [batch.id, batch]));
  const locallyActiveBatchIds = new Set([...activeBatchRequests.values()].map((batch) => batch.id));
  const grouped = new Map<string, OperationRecord[]>();
  for (const operation of recentOperations) {
    if (!operation.batchId || !isBatchOperationType(operation.type)) continue;
    const operations = grouped.get(operation.batchId) ?? [];
    operations.push(operation);
    grouped.set(operation.batchId, operations);
  }
  const batches = new Map<string, BatchRecord>(existingRunning);
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
    const completed = operations.filter((operation) => ['success', 'skipped', 'failed'].includes(operation.state)).length;
    const previous = batches.get(id);
    if (previous && locallyActiveBatchIds.has(id)) continue;
    batches.set(id, {
      id,
      type: first.type,
      state: completed === operations.length ? 'completed' : 'running',
      createdAt: previous?.createdAt ?? createdAt,
      finishedAt: completed === operations.length ? finishedAt : null,
      total: previous?.total ?? operations.length,
      completed,
      success: operations.filter((operation) => operation.state === 'success').length,
      skipped: operations.filter((operation) => operation.state === 'skipped').length,
      failed: operations.filter((operation) => operation.state === 'failed').length,
    });
  }
  recentBatches.splice(
    0,
    recentBatches.length,
    ...[...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
  );
}

export async function synchronizeOperations(): Promise<boolean> {
  const { records, signature } = await readPersistedOperations();
  if (signature === persistedLogSignature) return false;
  const operationsById = new Map(recentOperations.map((operation) => [operation.id, operation]));
  for (const record of records) operationsById.set(record.id, record);
  recentOperations.splice(
    0,
    recentOperations.length,
    ...[...operationsById.values()].sort((a, b) => operationSortTimestamp(b).localeCompare(operationSortTimestamp(a))).slice(0, 100),
  );
  rebuildBatchRecords();
  persistedLogSignature = signature;
  return true;
}

export async function initializeOperations(): Promise<void> {
  if (!operationsInitialized) {
    await cleanupExpiredLogs();
    operationsInitialized = true;
  }
  await synchronizeOperations();
}

export async function runOperation<T>(
  repository: { id: string; name: string },
  type: OperationType,
  handler: () => Promise<OperationOutput<T>>,
): Promise<{ operation: OperationRecord; result: T }> {
  const outcome = await runOperationSettled(repository, type, handler);
  if (!outcome.ok) throw outcome.error;
  return { operation: outcome.operation, result: outcome.result };
}

export async function runOperationSettled<T>(
  repository: { id: string; name: string },
  type: OperationType,
  handler: () => Promise<OperationOutput<T>>,
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
  handler: (repository: Pick<RepositoryConfig, 'id' | 'name'>) => Promise<OperationOutput<T>>,
): BatchRecord {
  const requestKey = repositories.length > 0
    ? `${type}:${repositories.map((repository) => repository.id).sort().join(',')}`
    : null;
  if (requestKey) {
    const existing = activeBatchRequests.get(requestKey);
    if (existing?.state === 'running') return existing;
  }
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
  const leasePath = requestKey ? claimBatchLease(requestKey, batch) : null;
  recentBatches.unshift(batch);
  if (recentBatches.length > 20) recentBatches.length = 20;
  if (requestKey) activeBatchRequests.set(requestKey, batch);
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
    if (requestKey && activeBatchRequests.get(requestKey) === batch) activeBatchRequests.delete(requestKey);
    if (leasePath) releaseBatchLease(leasePath, batch.id);
    publishOperations();
  })();

  return batch;
}
