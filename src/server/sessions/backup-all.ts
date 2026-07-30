import { randomUUID } from 'node:crypto';
import type {
  ProviderCapabilities,
  SessionBackupItem,
  SessionBackupJob,
  SessionProvider,
} from '../../shared/sessions.js';
import { sessionBackupJobSchema } from '../../shared/sessions.js';
import { loadRepositories } from '../config/store.js';
import { backupLocalSession, type SessionCheckpointWorkflowOptions } from './handoff.js';
import { retryPendingLocalSessionDeletions } from './local-management.js';
import { discoverSessions } from './discovery.js';
import { probeProviderCapabilities } from './probe.js';
import { redactSensitiveText } from './secrets.js';

const jobs = new Map<string, SessionBackupJob>();

function snapshot(job: SessionBackupJob): SessionBackupJob {
  return sessionBackupJobSchema.parse({
    ...job,
    items: job.items.map((item) => ({ ...item })),
  });
}

function safeError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate?.code === 'string' && candidate.code
      ? candidate.code.slice(0, 255)
      : 'session-backup-failed',
    message: typeof candidate?.message === 'string' && candidate.message
      ? redactSensitiveText(candidate.message).slice(0, 2_000)
      : '会话备份失败',
  };
}

function providerMap(
  providers: SessionProvider[],
  options: SessionCheckpointWorkflowOptions,
): Promise<Map<SessionProvider, ProviderCapabilities>> {
  const unique = [...new Set(providers)];
  const configured = options.providerCapabilities;
  return Promise.all(unique.map(async (provider) => [
    provider,
    configured?.provider === provider
      ? configured
      : await probeProviderCapabilities({ provider, command: provider }),
  ] as const)).then((entries) => new Map(entries));
}

function pendingItem(session: {
  provider: SessionProvider;
  providerSessionId: string;
  title: string | null;
  lastActivityAt: string | null;
}): SessionBackupItem {
  return {
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    title: session.title ? redactSensitiveText(session.title) : null,
    lastActivityAt: session.lastActivityAt,
    state: 'pending',
    checkpointId: null,
    message: '等待备份',
  };
}

export function sessionBackupJob(operationId: string): SessionBackupJob | null {
  const job = jobs.get(operationId);
  return job ? snapshot(job) : null;
}

export function startSessionBackupAll(
  options: SessionCheckpointWorkflowOptions = {},
): SessionBackupJob {
  const active = [...jobs.values()].find((job) => job.state === 'queued' || job.state === 'running');
  if (active) return snapshot(active);
  const operationId = randomUUID();
  const job = sessionBackupJobSchema.parse({
    operationId,
    state: 'queued',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    backedUp: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    items: [],
    error: null,
  });
  jobs.set(operationId, job);

  void (async () => {
    job.state = 'running';
    try {
      await retryPendingLocalSessionDeletions(options);
      const repositories = options.repositories ?? await loadRepositories();
      const discovery = await discoverSessions({
        repositories,
        claudeHome: options.claudeHome,
        codexHome: options.codexHome,
        recentDays: null,
      });
      if (discovery.sessions.length > 5_000) {
        throw new Error('本机会话超过 5,000 条，请先清理明显无用的历史会话');
      }
      job.items = discovery.sessions.map(pendingItem);
      job.total = job.items.length;
      const capabilities = await providerMap(discovery.sessions.map((session) => session.provider), options);

      for (let index = 0; index < discovery.sessions.length; index += 1) {
        const session = discovery.sessions[index];
        const item = job.items[index];
        item.state = 'running';
        item.message = '正在检查会话内容';
        if (!session.readable) {
          item.state = 'skipped';
          item.message = session.error ? redactSensitiveText(session.error) : '会话文件不可读';
          job.skipped += 1;
          continue;
        }
        try {
          const result = await backupLocalSession({
            session,
            machine: options.machine,
            captureNative: true,
            requireNative: true,
            skipUnchanged: true,
            skipBlocked: true,
            providerCapabilities: capabilities.get(session.provider),
          }, options);
          item.state = result.outcome;
          item.message = result.message;
          item.checkpointId = result.checkpoint?.checkpoint.checkpointId ?? null;
          if (result.outcome === 'backed-up') job.backedUp += 1;
          else if (result.outcome === 'unchanged') job.unchanged += 1;
          else job.skipped += 1;
        } catch (error) {
          item.state = 'failed';
          item.message = safeError(error).message;
          job.failed += 1;
        }
      }
      job.state = 'success';
    } catch (error) {
      job.state = 'failed';
      job.error = safeError(error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return snapshot(job);
}

export function resetSessionBackupJobsForTests(): void {
  jobs.clear();
}
