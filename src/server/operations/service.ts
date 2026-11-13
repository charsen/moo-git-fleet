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
import { AppError, conflictError } from '../errors.js';

/**
 * 每个仓库当前的操作占用者。
 *
 * 区分前台与后台不是为了记账，是为了让「自动 Fetch」不挡人：后台批次只在前台
 * 没有操作时占着仓库，用户一批量 Pull / Push，它就该整批收工；反过来，前台撞上
 * 后台占用的仓库会短暂等它让出（实测单仓 fetch 约 1.1 秒），而不是立刻 409。
 */
const activeRepositories = new Map<string, 'foreground' | 'background'>();
/** 正在运行的前台批次数；后台批次每次取下一个仓库前看它，大于 0 就让路。 */
let activeForegroundBatches = 0;
/** 前台等后台让路的上限。单仓 fetch 实测中位 1074 ms、最慢 1206 ms，5 秒覆盖一次在途请求。 */
const backgroundYieldWaitMs = 5_000;
const backgroundYieldPollMs = 50;
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

export class BatchAlreadyRunningError extends AppError {
  constructor() {
    super('相同仓库集合的 Git 批次已有实例正在执行', 'conflict', 409);
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

/**
 * 占住一个仓库。返回 false 表示这次没拿到，调用方决定是报冲突还是跳过。
 *
 * 后台（自动 Fetch）从不等待：拿不到就说明用户正在这个仓库上做事，让开更划算。
 * 前台只在占用者是后台时才等，且有时限——占用者若是另一个前台操作，等下去就是
 * 排队而不是让路，仍按冲突处理（与既有行为一致）。
 */
async function acquireRepository(repositoryId: string, background: boolean): Promise<boolean> {
  if (background) {
    if (activeRepositories.has(repositoryId)) return false;
    activeRepositories.set(repositoryId, 'background');
    return true;
  }
  const deadline = Date.now() + backgroundYieldWaitMs;
  for (;;) {
    const holder = activeRepositories.get(repositoryId);
    if (!holder) {
      activeRepositories.set(repositoryId, 'foreground');
      return true;
    }
    if (holder === 'foreground' || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, backgroundYieldPollMs));
  }
}

export async function withRepositoryLock<T>(repositoryId: string, handler: () => Promise<T>): Promise<T> {
  if (!(await acquireRepository(repositoryId, false))) throw conflictError('该仓库已有 Git 操作正在执行');
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
  // 与 `BatchOperationType` 保持同步：漏一种类型不会报错，只会让那种批次的记录
  // 在日志重建时凭空消失（接口先返回、几百毫秒后再查就没了）。
  return type === 'fetch'
    || type === 'pull'
    || type === 'pull-branches'
    || type === 'push'
    || type === 'push-branches'
    || type === 'merge-branches';
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
  background = false,
): Promise<{ operation: OperationRecord; result: T }> {
  if (!(await acquireRepository(operation.repositoryId, background))) {
    const now = new Date().toISOString();
    operation.startedAt = now;
    operation.finishedAt = now;
    operation.durationMs = 0;
    if (background) {
      // 后台批次撞上用户操作：记「已让路」而不是失败，否则「需处理」会被自动 Fetch 撑满。
      operation.state = 'skipped';
      operation.message = '用户正在这个仓库上操作，本轮自动 Fetch 已让路';
      operation.skipReason = 'interrupted';
      publishOperations();
      await persist(operation).catch(() => undefined);
      return { operation, result: undefined as unknown as T };
    }
    operation.state = 'failed';
    operation.message = '该仓库已有 Git 操作正在执行';
    operation.skipReason = null;
    publishOperations();
    await persist(operation).catch(() => undefined);
    throw conflictError(operation.message);
  }
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
  // 已经记在内存里的批次：日志只有逐仓操作，批次级标记（后台 / 让路）只能从这里续上。
  const known = new Map(recentBatches.map((batch) => [batch.id, batch]));
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
    const previous = known.get(id);
    if (previous && locallyActiveBatchIds.has(id)) continue;
    /*
     * 已知且已完成的批次：计数以我们自己的记录为准，不按操作窗口重算。
     *
     * `recentOperations` 只留最近 100 条，紧接着再跑一批就足以把上一批的操作挤出窗口——
     * 实测 66 仓的自动 Fetch 真跑完了 66 个（日志里有 66 行），界面上却显示成 34/66。
     * 重算只在「这个批次不是本进程记录的」（别的进程写的日志）时才需要。
     */
    if (previous?.state === 'completed') {
      batches.set(id, previous);
      continue;
    }
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
    // 日志里只有逐仓操作，没有批次级标记：`background` 只能沿用内存里那份记录，
    // `interrupted` 还能从逐仓的 skipReason 反推（进程重启后依然认得出来）。
    const interrupted = previous?.interrupted === true
      || operations.some((operation) => operation.skipReason === 'interrupted');
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
      ...(previous?.background ? { background: true } : {}),
      ...(interrupted ? { interrupted: true } : {}),
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
  options: { background?: boolean } = {},
): BatchRecord {
  const background = options.background === true;
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
    ...(background ? { background: true } : {}),
  };
  const leasePath = requestKey ? claimBatchLease(requestKey, batch) : null;
  recentBatches.unshift(batch);
  if (recentBatches.length > 20) recentBatches.length = 20;
  if (requestKey) activeBatchRequests.set(requestKey, batch);
  // 前台批次一创建就登记：后台批次下一次取仓库时就能看见它并让路，
  // 不必等它的第一条操作真正开始跑。
  if (!background) activeForegroundBatches += 1;
  publishOperations();
  const queue = repositories.map((repository) => ({
    repository,
    operation: queuedOperation(repository, type, batch.id),
  }));

  void (async () => {
    let nextIndex = 0;
    let yielded = false;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
      while (nextIndex < queue.length) {
        // 后台批次每取一个仓库前看一眼：用户已经开始自己的批次就让路。
        // 不这么做的话，66 仓的自动 Fetch（实测 23 秒）会把批量 Pull / Push 压成
        // 逐仓等锁，用户看到的就是「fetch 的时候什么都干不了」。
        if (background && activeForegroundBatches > 0) {
          yielded = true;
          break;
        }
        const item = queue[nextIndex];
        nextIndex += 1;
        if (!item) continue;
        try {
          await executeOperation(item.operation, () => handler(item.repository), background);
        } catch {
          // The operation already contains the actionable error and the batch continues.
        }
        batch.completed += 1;
        batch[item.operation.state === 'success' ? 'success' : item.operation.state === 'skipped' ? 'skipped' : 'failed'] += 1;
        publishOperations();
      }
    });
    try {
      await Promise.all(workers);
      if (yielded) await settleYieldedItems(queue, batch);
    } finally {
      if (!background) activeForegroundBatches = Math.max(0, activeForegroundBatches - 1);
      batch.state = 'completed';
      batch.finishedAt = new Date().toISOString();
      if (requestKey && activeBatchRequests.get(requestKey) === batch) activeBatchRequests.delete(requestKey);
      if (leasePath) releaseBatchLease(leasePath, batch.id);
      publishOperations();
    }
  })();

  return batch;
}

/**
 * 把让路后没来得及执行的仓库一次性收尾。
 *
 * 记成 `interrupted` 而不是 `blocked`：让路是设计内的行为，不该让「需处理」变红，
 * 也不该出现在重试清单里——下一轮自动 Fetch 会重新覆盖这些仓库。
 */
async function settleYieldedItems(
  queue: Array<{ operation: OperationRecord }>,
  batch: BatchRecord,
): Promise<void> {
  const now = new Date().toISOString();
  const pending = queue.filter((item) => item.operation.state === 'queued');
  for (const item of pending) {
    item.operation.state = 'skipped';
    item.operation.startedAt = now;
    item.operation.finishedAt = now;
    item.operation.durationMs = 0;
    item.operation.message = '用户发起了其他操作，本轮自动 Fetch 已让路';
    item.operation.skipReason = 'interrupted';
    batch.completed += 1;
    batch.skipped += 1;
  }
  if (pending.length > 0) batch.interrupted = true;
  publishOperations();
  await Promise.all(pending.map((item) => persist(item.operation).catch(() => undefined)));
}
