import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      };
    });

    await waitFor(() => batch.state === 'completed');

    expect(maximumRunning).toBe(2);
    expect(batch).toMatchObject({ total: 3, completed: 3, success: 1, skipped: 1, failed: 1 });
    const records = service.listOperations().filter((operation) => operation.batchId === batch.id);
    expect(records.map((operation) => operation.state).sort()).toEqual(['failed', 'skipped', 'success']);
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
});
