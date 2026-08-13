import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoriesConfig, RepositoryStatus } from '../../shared/contracts.js';

let temporaryHome = '';
let service: typeof import('./service.js');

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待批量操作完成超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-operations-'));
  vi.stubEnv('GIT_FLEET_HOME', temporaryHome);
  vi.resetModules();
  service = await import('./service.js');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(temporaryHome, { recursive: true, force: true });
});

describe('batch operation queue', () => {
  it('invalidates a dashboard scan that started before an audited Git operation completed', async () => {
    const dashboard = await import('../dashboard/service.js');
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: temporaryHome },
        defaultRemote: 'origin',
        scanDepth: 1,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [],
    };
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scanner = async (): Promise<RepositoryStatus[]> => {
      calls += 1;
      if (calls === 1) await firstGate;
      return [];
    };

    const beforeOperation = dashboard.scanDashboardRepositories(config, scanner);
    await service.runOperation({ id: 'fresh-after-fetch', name: 'fresh' }, 'fetch', async () => ({
      result: null,
      message: 'Fetch completed',
    }));
    const afterOperation = dashboard.scanDashboardRepositories(config, scanner);

    expect(calls).toBe(2);
    releaseFirst();
    await expect(Promise.all([beforeOperation, afterOperation])).resolves.toHaveLength(2);
  });

  it('continues after skips and failures while respecting concurrency', async () => {
    const repositories = [
      { id: 'batch-success', name: 'success' },
      { id: 'batch-skip', name: 'skip' },
      { id: 'batch-fail', name: 'fail' },
    ];
    let running = 0;
    let maximumRunning = 0;
    const batch = service.startBatch(repositories, 'fetch', 2, async (repository) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      if (repository.id === 'batch-fail') throw new Error('network failed');
      return {
        result: null,
        message: repository.id === 'batch-skip' ? 'not needed' : 'done',
        skipped: repository.id === 'batch-skip',
        skipReason: repository.id === 'batch-skip' ? 'not-needed' : undefined,
      };
    });

    await waitFor(() => batch.state === 'completed');

    expect(maximumRunning).toBe(2);
    expect(batch).toMatchObject({ total: 3, completed: 3, success: 1, skipped: 1, failed: 1 });
    const records = service.listOperations().filter((operation) => operation.batchId === batch.id);
    expect(records.map((operation) => operation.state).sort()).toEqual(['failed', 'skipped', 'success']);
    expect(records.find((operation) => operation.state === 'skipped')?.skipReason).toBe('not-needed');
  });

  it('coalesces identical batches while the first batch is running', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = service.startBatch(
      [
        { id: 'coalesced-a', name: 'a' },
        { id: 'coalesced-b', name: 'b' },
      ],
      'fetch',
      1,
      async () => {
        markStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { result: null, message: 'done' };
      },
    );
    const second = service.startBatch(
      [
        { id: 'coalesced-b', name: 'b' },
        { id: 'coalesced-a', name: 'a' },
      ],
      'fetch',
      1,
      async () => ({ result: null, message: 'must not run' }),
    );

    expect(second).toBe(first);
    expect(service.listBatches().filter((batch) => batch.id === first.id)).toHaveLength(1);
    await started;
    await waitFor(() => first.state === 'completed');

    const afterCompletion = service.startBatch(
      [
        { id: 'coalesced-a', name: 'a' },
        { id: 'coalesced-b', name: 'b' },
      ],
      'fetch',
      1,
      async () => ({ result: null, message: 'new batch' }),
    );
    expect(afterCompletion).not.toBe(first);
    await waitFor(() => afterCompletion.state === 'completed');
  });

  it('rejects the same batch from a second service process and reclaims it after exit', async () => {
    let markStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = service.startBatch([{ id: 'cross-process', name: 'cross-process' }], 'fetch', 1, async () => {
      markStarted();
      await held;
      return { result: null, message: 'done' };
    });
    await started;

    vi.resetModules();
    const secondService = await import('./service.js');
    try {
      expect(() =>
        secondService.startBatch([{ id: 'cross-process', name: 'cross-process' }], 'fetch', 1, async () => ({
          result: null,
          message: 'must not run',
        })),
      ).toThrow('相同仓库集合的 Git 批次已有实例正在执行');
    } finally {
      releaseFirst();
    }

    await waitFor(() => first.state === 'completed');
    const afterExit = secondService.startBatch(
      [{ id: 'cross-process', name: 'cross-process' }],
      'fetch',
      1,
      async () => ({ result: null, message: 'reclaimed' }),
    );
    await waitFor(() => afterExit.state === 'completed');
  });

  it('reclaims an expired cross-process lease even when its PID has been reused', async () => {
    const repository = { id: 'expired-lease', name: 'expired lease' };
    const requestKey = `fetch:${repository.id}`;
    const leaseDirectory = path.join(temporaryHome, '.data', 'batch-leases');
    const leasePath = path.join(leaseDirectory, `${createHash('sha256').update(requestKey).digest('hex')}.json`);
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(leasePath, JSON.stringify({
      pid: process.pid,
      batchId: 'stale-batch',
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    }));

    const batch = service.startBatch([repository], 'fetch', 1, async () => ({ result: null, message: 'reclaimed' }));
    await waitFor(() => batch.state === 'completed');

    expect(batch).toMatchObject({ state: 'completed', total: 1, success: 1 });
  });

  it('publishes immutable queue snapshots and stops after unsubscribe', async () => {
    const snapshots: Array<ReturnType<typeof service.operationsPayload>> = [];
    const unsubscribe = service.subscribeOperations((payload) => snapshots.push(payload));
    const batch = service.startBatch([{ id: 'streamed-repository', name: 'streamed' }], 'fetch', 1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { result: null, message: 'streamed done' };
    });

    await waitFor(() => batch.state === 'completed');

    const operationStates = snapshots.flatMap((payload) => payload.operations.map((operation) => operation.state));
    const batchStates = snapshots.flatMap((payload) => payload.batches.map((item) => item.state));
    expect(operationStates).toContain('queued');
    expect(operationStates).toContain('running');
    expect(operationStates).toContain('success');
    expect(batchStates).toContain('running');
    expect(batchStates).toContain('completed');
    const snapshotCount = snapshots.length;
    unsubscribe();
    await service.runOperation({ id: 'after-unsubscribe', name: 'after' }, 'fetch', async () => ({
      result: null,
      message: 'not streamed',
    }));
    expect(snapshots).toHaveLength(snapshotCount);
  });

  it('returns a failed operation record to workflows that need partial-success handling', async () => {
    const outcome = await service.runOperationSettled({ id: 'settled-failure', name: 'settled' }, 'push', async () => {
      throw new Error('remote moved');
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failed outcome');
    expect(outcome.error.message).toBe('remote moved');
    expect(outcome.operation).toMatchObject({ type: 'push', state: 'failed', message: 'remote moved' });
  });

  it('shares the repository mutex with non-audited worktree mutations', async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = service.withRepositoryLock(
      'shared-repository',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          started();
        }),
    );
    await startedPromise;

    const blocked = await service.runOperationSettled({ id: 'shared-repository', name: 'shared' }, 'switch-branch', async () => ({
      result: null,
      message: 'should not run',
    }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('expected repository lock to block operation');
    expect(blocked.error.message).toContain('已有 Git 操作');

    release();
    await held;
    await expect(
      service.withRepositoryLock('shared-repository', async () => 'released'),
    ).resolves.toBe('released');
  });

  it('rotates operation logs by size', async () => {
    vi.stubEnv('GIT_FLEET_OPERATION_LOG_MAX_BYTES', '256');
    vi.resetModules();
    const rotatingService = await import('./service.js');
    for (let index = 0; index < 3; index += 1) {
      await rotatingService.runOperation({ id: `rotated-${index}`, name: `rotated-${index}` }, 'fetch', async () => ({
        result: null,
        message: `completed ${index} ${'x'.repeat(300)}`,
      }));
    }

    const files = (await readdir(path.join(temporaryHome, '.data', 'operations'))).filter((file) => file.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((file) => /-2\.jsonl$/.test(file))).toBe(true);
    await Promise.all(
      files.map(async (file) => {
        expect((await stat(path.join(temporaryHome, '.data', 'operations', file))).mode & 0o777).toBe(0o600);
      }),
    );
  });

  it('synchronizes completed operations written by another service process', async () => {
    await service.initializeOperations();
    const operationDirectory = path.join(temporaryHome, '.data', 'operations');
    await mkdir(operationDirectory, { recursive: true });
    const finishedAt = new Date().toISOString();
    const record = {
      id: 'external-operation',
      batchId: 'external-batch',
      repositoryId: 'external-repository',
      repositoryName: 'external',
      type: 'fetch',
      state: 'success',
      startedAt: finishedAt,
      finishedAt,
      durationMs: 1,
      message: 'external done',
    };
    await appendFile(
      path.join(operationDirectory, `operations-${finishedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify(record)}\n`,
    );

    expect(service.listOperations()).not.toContainEqual(expect.objectContaining({ id: record.id }));
    await expect(service.synchronizeOperations()).resolves.toBe(true);
    expect(service.listOperations()).toContainEqual(expect.objectContaining({ id: record.id, state: 'success' }));
    expect(service.listBatches()).toContainEqual(
      expect.objectContaining({ id: record.batchId, state: 'completed', total: 1, success: 1 }),
    );
    await expect(service.synchronizeOperations()).resolves.toBe(false);
  });

  it('restores legacy and rotated logs, ignores damaged lines and removes expired files', async () => {
    const operationDirectory = path.join(temporaryHome, '.data', 'operations');
    await mkdir(operationDirectory, { recursive: true });
    const now = new Date();
    const currentDate = now.toISOString().slice(0, 10);
    const record = (id: string, finishedAt: string) => ({
      id,
      batchId: null,
      repositoryId: id,
      repositoryName: id,
      type: 'fetch',
      state: 'success',
      startedAt: finishedAt,
      finishedAt,
      durationMs: 1,
      message: 'restored',
    });
    await writeFile(
      path.join(temporaryHome, '.data', 'operations.jsonl'),
      `${JSON.stringify(record('legacy', new Date(now.getTime() - 1_000).toISOString()))}\n`,
    );
    await writeFile(
      path.join(operationDirectory, `operations-${currentDate}.jsonl`),
      `${JSON.stringify(record('rotated', now.toISOString()))}\n{damaged json}\n`,
    );
    const expiredPath = path.join(operationDirectory, 'operations-2000-01-01.jsonl');
    await writeFile(expiredPath, `${JSON.stringify(record('expired', '2000-01-01T00:00:00.000Z'))}\n`);

    vi.resetModules();
    const restoredService = await import('./service.js');
    await restoredService.initializeOperations();

    expect(restoredService.listOperations().map((operation) => operation.id)).toEqual(['rotated', 'legacy']);
    await expect(readFile(expiredPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
