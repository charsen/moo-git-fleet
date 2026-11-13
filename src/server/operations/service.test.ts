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

  it('lets a background batch yield as soon as the user starts their own batch', async () => {
    const repositories = Array.from({ length: 6 }, (_, index) => ({ id: `yield-${index}`, name: `yield-${index}` }));
    // 两个闸门把时序钉死：后台卡在第一个仓库，前台整批在跑，否则「谁先跑完」会决定断言。
    let releaseBackground!: () => void;
    let markBackgroundStarted!: () => void;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    let releaseForeground!: () => void;
    let markForegroundStarted!: () => void;
    const foregroundStarted = new Promise<void>((resolve) => {
      markForegroundStarted = resolve;
    });
    const foregroundGate = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });

    const background = service.startBatch(
      repositories,
      'fetch',
      1,
      async (repository) => {
        if (repository.id === 'yield-0') {
          markBackgroundStarted();
          await backgroundGate;
        }
        return { result: null, message: 'fetched' };
      },
      { background: true },
    );
    await backgroundStarted;

    const foreground = service.startBatch([{ id: 'user-push', name: 'user-push' }], 'push', 1, async () => {
      markForegroundStarted();
      await foregroundGate;
      return { result: null, message: 'pushed' };
    });
    await foregroundStarted;
    releaseBackground();
    // 用户批次还在跑：后台必须在这时候收工，而不是排在它后面。
    await waitFor(() => background.state === 'completed');
    releaseForeground();
    await waitFor(() => foreground.state === 'completed');

    expect(background.background).toBe(true);
    expect(background.interrupted).toBe(true);
    // 让路不是失败：剩下 5 个仓库记 skipped/interrupted，「需处理」不该被它撑满。
    expect(background.failed).toBe(0);
    expect(background.success).toBe(1);
    expect(background.skipped).toBe(5);
    const yielded = service.listOperations().filter((operation) => operation.batchId === background.id && operation.skipReason === 'interrupted');
    expect(yielded).toHaveLength(5);
    // 用户那一条必须完整跑完，不能被自动 Fetch 拖着。
    const userOperations = service.listOperations().filter((operation) => operation.batchId === foreground.id);
    expect(userOperations.map((operation) => operation.state)).toEqual(['success']);
  });

  it('lets a foreground operation wait for a background fetch to release the repository', async () => {
    let release!: () => void;
    const background = service.startBatch(
      [{ id: 'shared-background', name: 'shared' }],
      'fetch',
      1,
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { result: null, message: 'fetched' };
      },
      { background: true },
    );
    await waitFor(() => service.listOperations().some((operation) => operation.batchId === background.id && operation.state === 'running'));

    const foreground = service.runOperation({ id: 'shared-background', name: 'shared' }, 'push', async () => ({
      result: null,
      message: 'pushed',
    }));
    setTimeout(() => release(), 30);

    await expect(foreground).resolves.toBeTruthy();
    const push = service.listOperations().find((operation) => operation.type === 'push' && operation.repositoryId === 'shared-background');
    expect(push?.state).toBe('success');
  });

  it('skips a background fetch that lands on a repository the user is already using', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = service.withRepositoryLock(
      'busy-repository',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          markStarted();
        }),
    );
    await started;

    const background = service.startBatch(
      [{ id: 'busy-repository', name: 'busy' }],
      'fetch',
      1,
      async () => ({ result: null, message: 'must not run' }),
      { background: true },
    );
    await waitFor(() => background.state === 'completed');

    const operation = service.listOperations().find((record) => record.batchId === background.id);
    expect(operation?.state).toBe('skipped');
    expect(operation?.skipReason).toBe('interrupted');
    expect(background.failed).toBe(0);

    release();
    await held;
  });

  it('keeps background and interrupted flags when batches are rebuilt from the operation log', async () => {
    await service.initializeOperations();
    const repositories = [{ id: 'rebuild-0', name: 'rebuild-0' }, { id: 'rebuild-1', name: 'rebuild-1' }];
    let releaseBackground!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const background = service.startBatch(
      repositories,
      'fetch',
      1,
      async (repository) => {
        if (repository.id === 'rebuild-0') {
          markStarted();
          await gate;
        }
        return { result: null, message: 'fetched' };
      },
      { background: true },
    );
    await started;
    const foreground = service.startBatch([{ id: 'rebuild-user', name: 'rebuild-user' }], 'push', 1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { result: null, message: 'pushed' };
    });
    releaseBackground();
    await waitFor(() => background.state === 'completed');
    await waitFor(() => foreground.state === 'completed');

    // 外部进程补一条操作日志：签名一变就会触发按日志重建批次记录。
    const operationDirectory = path.join(temporaryHome, '.data', 'operations');
    const finishedAt = new Date().toISOString();
    await appendFile(
      path.join(operationDirectory, `operations-${finishedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify({
        id: 'rebuild-external',
        batchId: 'rebuild-external-batch',
        repositoryId: 'rebuild-external',
        repositoryName: 'external',
        type: 'fetch',
        state: 'success',
        startedAt: finishedAt,
        finishedAt,
        durationMs: 1,
        message: 'external done',
      })}\n`,
    );
    await expect(service.synchronizeOperations()).resolves.toBe(true);

    const rebuilt = service.listBatches().find((batch) => batch.id === background.id);
    expect(rebuilt?.background).toBe(true);
    expect(rebuilt?.interrupted).toBe(true);
    expect(rebuilt?.completed).toBe(2);
  });

  it('keeps a completed batch count when its operations fall out of the 100-row window', async () => {
    await service.initializeOperations();
    const bigRepositories = Array.from({ length: 60 }, (_, index) => ({ id: `big-${index}`, name: `big-${index}` }));
    const older = service.startBatch(bigRepositories, 'fetch', 8, async () => ({ result: null, message: 'fetched' }));
    await waitFor(() => older.state === 'completed');
    // 再跑一批 60 个：两条批次合起来 120 条，最早那条会被挤出内存窗口。
    const newer = service.startBatch(
      Array.from({ length: 60 }, (_, index) => ({ id: `next-${index}`, name: `next-${index}` })),
      'fetch',
      8,
      async () => ({ result: null, message: 'fetched' }),
    );
    await waitFor(() => newer.state === 'completed');
    expect(service.listOperations()).toHaveLength(100);

    const finishedAt = new Date().toISOString();
    await appendFile(
      path.join(temporaryHome, '.data', 'operations', `operations-${finishedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify({
        id: 'window-external',
        batchId: 'window-external-batch',
        repositoryId: 'window-external',
        repositoryName: 'external',
        type: 'fetch',
        state: 'success',
        startedAt: finishedAt,
        finishedAt,
        durationMs: 1,
        message: 'external done',
      })}\n`,
    );
    await expect(service.synchronizeOperations()).resolves.toBe(true);

    const rebuilt = service.listBatches().find((batch) => batch.id === older.id);
    // 真跑完了 60 个仓库；按被截断的窗口重算会掉成 40/60。
    expect(rebuilt?.completed).toBe(60);
    expect(rebuilt?.total).toBe(60);
    expect(rebuilt?.success).toBe(60);
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
