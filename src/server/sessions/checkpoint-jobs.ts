import { randomUUID } from 'node:crypto';
import type {
  CheckpointCaptureProgress,
  CheckpointCaptureResult,
  CheckpointJob,
  CheckpointJobsPayload,
} from '../../shared/sessions.js';
import { checkpointJobSchema, checkpointJobsPayloadSchema } from '../../shared/sessions.js';
import { redactSensitiveText } from './secrets.js';

const jobs = new Map<string, CheckpointJob>();
const subscribers = new Set<(payload: CheckpointJobsPayload) => void>();

function payload(): CheckpointJobsPayload {
  return checkpointJobsPayloadSchema.parse({
    jobs: [...jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((job) => ({ ...job, progress: [...job.progress] })),
  });
}

function publish(): void {
  if (subscribers.size === 0) return;
  const current = payload();
  for (const subscriber of subscribers) {
    try {
      subscriber(current);
    } catch {
      // A disconnected UI must never interrupt a checkpoint capture.
    }
  }
}

function safeError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' && candidate.code ? candidate.code.slice(0, 255) : 'checkpoint-capture-failed';
  const message =
    typeof candidate?.message === 'string' && candidate.message
      ? redactSensitiveText(candidate.message).slice(0, 2_000)
      : 'Checkpoint 采集失败';
  return { code, message };
}

export function checkpointJobsPayload(): CheckpointJobsPayload {
  return payload();
}

export function checkpointJob(operationId: string): CheckpointJob | null {
  const job = jobs.get(operationId);
  return job ? checkpointJobSchema.parse({ ...job, progress: [...job.progress] }) : null;
}

export function subscribeCheckpointJobs(subscriber: (payload: CheckpointJobsPayload) => void): () => void {
  subscribers.add(subscriber);
  try {
    subscriber(payload());
  } catch {
    subscribers.delete(subscriber);
  }
  return () => subscribers.delete(subscriber);
}

export function startCheckpointJob(
  handler: (
    operationId: string,
    onProgress: (progress: CheckpointCaptureProgress) => void,
  ) => Promise<CheckpointCaptureResult>,
): CheckpointJob {
  const operationId = randomUUID();
  const job = checkpointJobSchema.parse({
    operationId,
    state: 'queued',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    progress: [],
    result: null,
    error: null,
  });
  jobs.set(operationId, job);
  publish();

  void (async () => {
    job.state = 'running';
    publish();
    try {
      job.result = await handler(operationId, (progress) => {
        job.progress.push({ ...progress, message: redactSensitiveText(progress.message) });
        if (job.progress.length > 50) job.progress.splice(0, job.progress.length - 50);
        publish();
      });
      job.state = 'success';
    } catch (error) {
      job.state = 'failed';
      job.error = safeError(error);
    } finally {
      job.finishedAt = new Date().toISOString();
      publish();
    }
  })();

  return checkpointJobSchema.parse(job);
}

export function resetCheckpointJobsForTests(): void {
  jobs.clear();
  subscribers.clear();
}
