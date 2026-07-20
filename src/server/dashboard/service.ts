import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RepositoriesConfig, RepositoryStatus } from '../../shared/contracts.js';
import { scanRepositories } from '../git/scanner.js';

export interface DashboardScanResult {
  repositories: RepositoryStatus[];
  scan: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
}

type RepositoryScanner = (config: RepositoriesConfig) => Promise<RepositoryStatus[]>;

const activeScans = new Map<string, Promise<DashboardScanResult>>();

function scanKey(config: RepositoriesConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export async function scanDashboardRepositories(
  config: RepositoriesConfig,
  scanner: RepositoryScanner = scanRepositories,
): Promise<DashboardScanResult> {
  const key = scanKey(config);
  const active = activeScans.get(key);
  if (active) return active;

  const startedAt = new Date();
  const started = performance.now();
  const scan = scanner(config).then((repositories) => ({
    repositories,
    scan: {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    },
  }));
  activeScans.set(key, scan);
  try {
    return await scan;
  } finally {
    if (activeScans.get(key) === scan) activeScans.delete(key);
  }
}
