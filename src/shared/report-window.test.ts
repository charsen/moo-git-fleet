import { describe, expect, it } from 'vitest';
import {
  analyticsRangeLabel,
  analyticsRangeOptions,
  dayIndexFromIso,
  defaultAnalyticsWeeks,
  heatmapWeekCount,
  localDateFromIso,
  localIsoDate,
  maxAnalyticsWeeks,
  normalizeAnalyticsWeeks,
  reportWindow,
  shiftDays,
} from './report-window.js';

/** 造一个本地时间日期；不用 `new Date('2026-10-22')`，那会被当成 UTC。 */
function day(year: number, month: number, date: number, hour = 0): Date {
  return new Date(year, month - 1, date, hour);
}

describe('reportWindow', () => {
  it('本周日所在的列是最后一列，第一列永远是周一', () => {
    // 2026-10-23 是周五，本周日是 10-25
    const window = reportWindow(day(2026, 10, 23));

    expect(window.end).toBe('2026-10-25');
    expect(localDateFromIso(window.end).getDay()).toBe(0);
    expect(localDateFromIso(window.start).getDay()).toBe(1);
  });

  it('窗口恰好覆盖 52 个自然周（364 天）', () => {
    const window = reportWindow(day(2026, 10, 23));
    const days = (localDateFromIso(window.end).getTime() - localDateFromIso(window.start).getTime()) / 86_400_000;

    expect(days + 1).toBe(heatmapWeekCount * 7);
  });

  it('当天就是周日时，最后一列就是当天', () => {
    // 2026-10-25 是周日
    expect(reportWindow(day(2026, 10, 25)).end).toBe('2026-10-25');
  });

  it('周一的「本周」从当天开始，不会被推到下一周', () => {
    // 2026-10-19 是周一：本周日是 10-25
    expect(reportWindow(day(2026, 10, 19)).end).toBe('2026-10-25');
  });

  it('跨年时首末日期跨过 12 月且不跳日', () => {
    // 2026-01-02 是周五，回推 51 周 + 本周
    const window = reportWindow(day(2026, 1, 2));

    expect(window.end).toBe('2026-01-04');
    // 2026-01-04 往前推 363 天 = 2025-01-06，正好是周一
    expect(window.start).toBe('2025-01-06');
    expect(localDateFromIso(window.start).getDay()).toBe(1);
  });

  it('时区与时刻不影响结果：同一天任何时刻算出的窗口都一样', () => {
    expect(reportWindow(day(2026, 10, 23, 0))).toEqual(reportWindow(day(2026, 10, 23, 23)));
  });

  it('weekCount 可调，给测试与小窗口场景留口子', () => {
    const window = reportWindow(day(2026, 10, 23), 2);

    expect(window.start).toBe('2026-10-12');
    expect(window.end).toBe('2026-10-25');
  });
});

describe('normalizeAnalyticsWeeks', () => {
  it('默认是近一年，和写死的 52 周是同一个值', () => {
    expect(defaultAnalyticsWeeks).toBe(52);
    expect(heatmapWeekCount).toBe(defaultAnalyticsWeeks);
    expect(normalizeAnalyticsWeeks(undefined)).toBe(52);
    expect(normalizeAnalyticsWeeks(null)).toBe(52);
  });

  it('接受数字与数字字符串', () => {
    expect(normalizeAnalyticsWeeks(13)).toBe(13);
    expect(normalizeAnalyticsWeeks('26')).toBe(26);
    expect(normalizeAnalyticsWeeks(' 104 ')).toBe(104);
  });

  it('非法输入一律回落到默认值，不抛错', () => {
    for (const value of ['', 'abc', '0', '-4', '2.5', '52.0.1', Number.NaN, Infinity, {}, []]) {
      expect(normalizeAnalyticsWeeks(value)).toBe(defaultAnalyticsWeeks);
    }
  });

  it('超出上限（5 年）也回落，避免画出几千列', () => {
    expect(normalizeAnalyticsWeeks(maxAnalyticsWeeks + 1)).toBe(defaultAnalyticsWeeks);
    expect(normalizeAnalyticsWeeks(maxAnalyticsWeeks)).toBe(maxAnalyticsWeeks);
    expect(normalizeAnalyticsWeeks(1)).toBe(1);
  });
});

describe('analyticsRangeOptions', () => {
  it('预设按周数递增，且都带中文标签', () => {
    const weeks = analyticsRangeOptions.map((option) => option.weeks);
    expect([...weeks].sort((left, right) => left - right)).toEqual(weeks);
    for (const option of analyticsRangeOptions) {
      expect(option.label.length).toBeGreaterThan(1);
      expect(normalizeAnalyticsWeeks(option.weeks)).toBe(option.weeks);
    }
  });

  it('默认值一定落在预设里，否则选择器上没有任何一项是选中态', () => {
    expect(analyticsRangeOptions.some((option) => option.weeks === defaultAnalyticsWeeks)).toBe(true);
  });

  it('标签查表，未知周数自己拼一个', () => {
    expect(analyticsRangeLabel(52)).toBe('近一年');
    expect(analyticsRangeLabel(13)).toBe('近 3 个月');
    expect(analyticsRangeLabel(37)).toBe('近 37 周');
  });
});

describe('dayIndexFromIso', () => {
  it('按 UTC 天算，与 Date.UTC 一致', () => {
    expect(dayIndexFromIso('1970-01-01')).toBe(0);
    expect(dayIndexFromIso('1970-01-02')).toBe(1);
    expect(dayIndexFromIso('2026-10-23')).toBe(Date.UTC(2026, 9, 23) / 86_400_000);
  });

  it('跨月跨年相邻两天正好差 1', () => {
    expect(dayIndexFromIso('2026-03-01') - dayIndexFromIso('2026-02-28')).toBe(1);
    expect(dayIndexFromIso('2026-01-01') - dayIndexFromIso('2025-12-31')).toBe(1);
  });
});

describe('shiftDays', () => {
  it('按本地日历加减天数，不带上时分秒', () => {
    const shifted = shiftDays(new Date(2026, 9, 23, 18, 42, 7), -1);

    expect(localIsoDate(shifted)).toBe('2026-10-22');
    expect(shifted.getHours()).toBe(0);
  });
});
