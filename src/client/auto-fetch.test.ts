import { describe, expect, it } from 'vitest';
import { autoFetchIntervalLabel, isAutoFetchDue, parseLastAutoFetchAt } from './auto-fetch.js';

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
});
