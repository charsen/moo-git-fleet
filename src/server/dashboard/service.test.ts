import { describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryStatus } from '../../shared/contracts.js';
import { invalidateDashboardScans, scanDashboardRepositories } from './service.js';

function config(name = 'demo'): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { test: '/tmp' },
      defaultRemote: 'origin',
      scanDepth: 1,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [
      {
        id: `${name}-repository`,
        name,
        root: 'test',
        path: name,
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 10,
        tags: [],
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: false, pull: false, stage: false, commit: false, stash: false, push: false },
      },
    ],
  };
}

describe('dashboard scan coordination', () => {
  it('coalesces concurrent scans for the same repository configuration', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanner = async (): Promise<RepositoryStatus[]> => {
      calls += 1;
      await gate;
      return [];
    };

    const first = scanDashboardRepositories(config(), scanner);
    const second = scanDashboardRepositories(config(), scanner);
    expect(calls).toBe(1);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    expect(firstResult.scan.startedAt).toBe(secondResult.scan.startedAt);
    expect(firstResult.scan.durationMs).toBeGreaterThanOrEqual(0);

    await scanDashboardRepositories(config(), scanner);
    expect(calls).toBe(2);
  });

  it('keeps different configurations in independent scan lanes', async () => {
    let calls = 0;
    const scanner = async (): Promise<RepositoryStatus[]> => {
      calls += 1;
      return [];
    };

    await Promise.all([
      scanDashboardRepositories(config('first'), scanner),
      scanDashboardRepositories(config('second'), scanner),
    ]);

    expect(calls).toBe(2);
  });

  it('does not reuse a scan that started before a Git operation invalidated dashboard state', async () => {
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

    const beforeOperation = scanDashboardRepositories(config(), scanner);
    invalidateDashboardScans();
    const afterOperation = scanDashboardRepositories(config(), scanner);

    expect(calls).toBe(2);
    releaseFirst();
    const [staleResult, freshResult] = await Promise.all([beforeOperation, afterOperation]);
    expect(staleResult).not.toBe(freshResult);
  });
});
