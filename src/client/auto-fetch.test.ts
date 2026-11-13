import { describe, expect, it } from 'vitest';
import {
  autoFetchDelayMs,
  autoFetchIntervalLabel,
  autoFetchRemainingLabel,
  isAutoFetchDue,
  latestFetchBatchAt,
  parseLastAutoFetchAt,
} from './auto-fetch.js';

describe('automatic Fetch scheduling', () => {
  it('runs immediately when enabled without a previous Fetch and waits for the configured interval afterward', () => {
    const now = Date.UTC(2026, 6, 20, 8, 0, 0);
    expect(isAutoFetchDue(30, null, now)).toBe(true);
    expect(isAutoFetchDue(30, now - 29 * 60_000, now)).toBe(false);
    expect(isAutoFetchDue(30, now - 30 * 60_000, now)).toBe(true);
    expect(isAutoFetchDue(0, null, now)).toBe(false);
  });

  it('rejects damaged timestamps and formats compact interval labels', () => {
    expect(parseLastAutoFetchAt(null)).toBeNull();
    expect(parseLastAutoFetchAt('damaged')).toBeNull();
    expect(parseLastAutoFetchAt('1721462400000')).toBe(1721462400000);
    expect(autoFetchIntervalLabel(15)).toBe('15 分钟');
    expect(autoFetchIntervalLabel(120)).toBe('2 小时');
  });

  it('uses persisted Fetch batches across browser origins and ignores other batch types', () => {
    expect(
      latestFetchBatchAt([
        { type: 'pull', createdAt: '2026-07-20T08:00:00.000Z' },
        { type: 'fetch', createdAt: '2026-07-20T09:00:00.000Z' },
        { type: 'fetch', createdAt: '2026-07-20T10:00:00.000Z' },
      ]),
    ).toBe(Date.parse('2026-07-20T10:00:00.000Z'));
    expect(latestFetchBatchAt([{ type: 'push', createdAt: 'damaged' }])).toBeNull();
  });

  it('schedules the exact remaining wait instead of rounding up to the next polling tick', () => {
    const now = Date.UTC(2026, 6, 20, 8, 0, 0);
    // 到期前 42 秒：定时器就该压在 42 秒后，而不是等下一个整分钟。
    expect(autoFetchDelayMs(30, now - 30 * 60_000 + 42_000, now)).toBe(42_000);
    // 已经过期：立即到期，不返回负数。
    expect(autoFetchDelayMs(30, now - 40 * 60_000, now)).toBe(0);
    // 从未跑过、或自动 Fetch 关闭。
    expect(autoFetchDelayMs(30, null, now)).toBe(0);
    expect(autoFetchDelayMs(0, now - 60 * 60_000, now)).toBeNull();
  });

  it('describes the remaining wait in the same units users configured', () => {
    expect(autoFetchRemainingLabel(0)).toBe('即将开始');
    expect(autoFetchRemainingLabel(1_000)).toBe('约 1 分钟后');
    expect(autoFetchRemainingLabel(42_000)).toBe('约 1 分钟后');
    expect(autoFetchRemainingLabel(20 * 60_000)).toBe('约 20 分钟后');
    expect(autoFetchRemainingLabel(60 * 60_000)).toBe('约 1 小时后');
    expect(autoFetchRemainingLabel(95 * 60_000)).toBe('约 1 小时 35 分钟后');
  });
});
