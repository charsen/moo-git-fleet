import type { AutoFetchIntervalMinutes, BatchRecord } from '../shared/contracts';

export const autoFetchIntervals: AutoFetchIntervalMinutes[] = [0, 15, 30, 60, 120, 240];

export function parseLastAutoFetchAt(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function latestFetchBatchAt(batches: Array<Pick<BatchRecord, 'type' | 'createdAt'>>): number | null {
  const timestamps = batches
    .filter((batch) => batch.type === 'fetch')
    .map((batch) => Date.parse(batch.createdAt))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function isAutoFetchDue(
  intervalMinutes: AutoFetchIntervalMinutes,
  lastAutoFetchAt: number | null,
  now = Date.now(),
): boolean {
  if (intervalMinutes === 0) return false;
  if (lastAutoFetchAt === null) return true;
  return now - lastAutoFetchAt >= intervalMinutes * 60_000;
}

export function autoFetchIntervalLabel(intervalMinutes: AutoFetchIntervalMinutes): string {
  if (intervalMinutes === 0) return '关闭';
  if (intervalMinutes < 60) return `${intervalMinutes} 分钟`;
  return `${intervalMinutes / 60} 小时`;
}

/**
 * 距离下一次自动 Fetch 还剩多少毫秒；关掉自动 Fetch 时返回 `null`。
 *
 * 调度器以前每 60 秒才看一次表，周期到点后还得白等最多一分钟；有了这个函数就能
 * 直接把定时器压到「到期那一刻」，代价是零。
 */
export function autoFetchDelayMs(
  intervalMinutes: AutoFetchIntervalMinutes,
  lastAutoFetchAt: number | null,
  now = Date.now(),
): number | null {
  if (intervalMinutes === 0) return null;
  if (lastAutoFetchAt === null) return 0;
  return Math.max(0, lastAutoFetchAt + intervalMinutes * 60_000 - now);
}

export function autoFetchRemainingLabel(delayMs: number): string {
  const minutes = Math.ceil(delayMs / 60_000);
  if (minutes <= 0) return '即将开始';
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `约 ${hours} 小时后` : `约 ${hours} 小时 ${rest} 分钟后`;
}
