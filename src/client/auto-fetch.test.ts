import { describe, expect, it } from 'vitest';
import { autoFetchIntervalLabel, isAutoFetchDue, latestFetchBatchAt, parseLastAutoFetchAt } from './auto-fetch.js';

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
});
