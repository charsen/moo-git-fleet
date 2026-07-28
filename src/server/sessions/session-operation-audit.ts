import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { lifecycleActionSchema } from '../../shared/sessions.js';
import { appRoot } from '../config/store.js';

export const sessionForkAuditActionSchema = z.enum(['select-head', 'merge', 'split']);
export type SessionForkAuditAction = z.infer<typeof sessionForkAuditActionSchema>;

const sessionOperationAuditActionSchema = z.union([
  lifecycleActionSchema,
  sessionForkAuditActionSchema,
  z.literal('empty'),
]);

const auditRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  category: z.enum(['session-lifecycle', 'session-fork', 'session-trash']),
  action: sessionOperationAuditActionSchema,
  result: z.enum(['success', 'failed']),
  sessionIdHash: z.string().regex(/^[a-f0-9]{64}$/),
  eventId: z.string().min(1).max(255).nullable(),
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  errorCode: z.string().regex(/^[a-z0-9-]+$/).max(100).nullable(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
}).strict().superRefine((record, context) => {
  const validAction = record.category === 'session-lifecycle'
    ? lifecycleActionSchema.safeParse(record.action).success
    : record.category === 'session-fork'
      ? sessionForkAuditActionSchema.safeParse(record.action).success
      : record.action === 'empty';
  if (!validAction) {
    context.addIssue({
      code: 'custom',
      path: ['action'],
      message: '会话操作审计 category 与 action 不匹配',
    });
  }
});
export type SessionOperationAuditRecord = z.infer<typeof auditRecordSchema>;

export interface SessionOperationAuditOptions {
  auditDirectory?: string;
}

const configuredMaxBytes = Number(process.env.GIT_FLEET_OPERATION_LOG_MAX_BYTES ?? 5 * 1024 * 1024);
const configuredRetentionDays = Number(process.env.GIT_FLEET_OPERATION_LOG_RETENTION_DAYS ?? 30);
const maxBytes = Number.isFinite(configuredMaxBytes)
  ? Math.min(100 * 1024 * 1024, Math.max(256, Math.trunc(configuredMaxBytes)))
  : 5 * 1024 * 1024;
const retentionDays = Number.isFinite(configuredRetentionDays)
  ? Math.min(365, Math.max(1, Math.trunc(configuredRetentionDays)))
  : 30;
const dayMs = 24 * 60 * 60 * 1_000;
let writeQueue = Promise.resolve();
let lastCleanupDate: string | null = null;

function auditDirectory(options: SessionOperationAuditOptions): string {
  return path.resolve(options.auditDirectory ?? path.join(appRoot, '.data', 'operations'));
}

function datePart(value: string): string {
  return value.slice(0, 10);
}

async function cleanupExpired(directory: string, now: Date): Promise<void> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const cutoff = now.getTime() - retentionDays * dayMs;
  await Promise.all(files.flatMap((name) => {
    const match = name.match(/^session-(?:lifecycle|operations)-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/);
    if (!match?.[1] || new Date(`${match[1]}T00:00:00.000Z`).getTime() >= cutoff) return [];
    return [rm(path.join(directory, name), { force: true })];
  }));
}

async function writablePath(directory: string, date: string): Promise<string> {
  for (let segment = 1; segment <= 10_000; segment += 1) {
    const suffix = segment === 1 ? '' : `-${segment}`;
    const filePath = path.join(directory, `session-operations-${date}${suffix}.jsonl`);
    try {
      if ((await stat(filePath)).size < maxBytes) return filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return filePath;
      throw error;
    }
  }
  throw new Error('会话操作审计日志分片数量超出限制');
}

export function hashSessionAuditId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export async function appendSessionOperationAudit(
  record: SessionOperationAuditRecord,
  options: SessionOperationAuditOptions = {},
): Promise<void> {
  const parsed = auditRecordSchema.parse(record);
  const task = async (): Promise<void> => {
    const directory = auditDirectory(options);
    const date = datePart(parsed.finishedAt);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    if (lastCleanupDate !== date) {
      await cleanupExpired(directory, new Date(parsed.finishedAt));
      lastCleanupDate = date;
    }
    const filePath = await writablePath(directory, date);
    await appendFile(filePath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600);
  };
  const result = writeQueue.then(task, task);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function sessionOperationAuditDirectory(options: SessionOperationAuditOptions = {}): string {
  return auditDirectory(options);
}
