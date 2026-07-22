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
