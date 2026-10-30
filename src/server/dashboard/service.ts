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
let scanGeneration = 0;

/**
 * 结果复用窗口。
 *
 * 一次用户动作经常触发两三次刷新（抽屉里的文件、分支与表单各刷一次），而整页扫描
 * 在 54 个仓库上约 400 ms。窗口只吸收这种成串的重复调用：写操作会推进 generation，
 * 缓存键随之失效，所以「刚写完立刻读」永远是重新扫的。
 */
const resultReuseMs = 1_500;
let cachedScan: { key: string; at: number; result: DashboardScanResult } | null = null;

function scanKey(config: RepositoriesConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export async function scanDashboardRepositories(
  config: RepositoriesConfig,
  scanner: RepositoryScanner = scanRepositories,
): Promise<DashboardScanResult> {
  const generation = scanGeneration;
  const key = `${generation}:${scanKey(config)}`;
  if (cachedScan && cachedScan.key === key && Date.now() - cachedScan.at < resultReuseMs) {
    return cachedScan.result;
  }
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
    const result = await scan;
    // 扫描期间发生过写操作时 generation 已经变了，这份结果不能再被复用。
    if (generation === scanGeneration) cachedScan = { key, at: Date.now(), result };
    return result;
  } finally {
    if (activeScans.get(key) === scan) activeScans.delete(key);
  }
}

export function invalidateDashboardScans(): void {
  scanGeneration += 1;
}
