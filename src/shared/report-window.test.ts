import { describe, expect, it } from 'vitest';
import {
  analyticsRangeKey,
  analyticsRangeLabel,
  analyticsRangeOptions,
  dayIndexFromIso,
  defaultAnalyticsRange,
  defaultAnalyticsWeeks,
  heatmapWeekCount,
  localDateFromIso,
  localIsoDate,
  maxAnalyticsRangeDays,
  maxAnalyticsWeeks,
  normalizeAnalyticsWeeks,
  rangeMatchesSelection,
  readStoredAnalyticsRange,
  reportWindow,
  resolveAnalyticsRange,
  sameAnalyticsRange,
  shiftDays,
  shiftIsoDays,
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

describe('自定义时间段', () => {
  // 2026-10-24 是周六；预设窗口的最后一列是「本周周日」= 10-25
  const today = day(2026, 10, 24);

  it('预设仍然按整周对齐', () => {
    const range = resolveAnalyticsRange({ weeks: 26 }, today);

    expect(range.kind).toBe('preset');
    expect(range.weeks).toBe(26);
    expect(range.start).toBe('2026-04-27'); // 周一
    expect(range.end).toBe('2026-10-25'); // 周日
    expect(range.label).toBe('近 6 个月');
    expect(range.days).toBe(182);
  });

  it('自选日期精确到天，不对齐整周', () => {
    const range = resolveAnalyticsRange({ start: '2026-10-01', end: '2026-10-15' }, today);

    expect(range).toMatchObject({ kind: 'custom', weeks: null, start: '2026-10-01', end: '2026-10-15' });
    expect(range.days).toBe(15);
    expect(range.label).toBe('自定义 15 天');
  });

  it('起止填反了自动换回来', () => {
    const range = resolveAnalyticsRange({ start: '2026-10-15', end: '2026-10-01' }, today);

    expect(range.start).toBe('2026-10-01');
    expect(range.end).toBe('2026-10-15');
  });

  it('同一天也算一天', () => {
    expect(resolveAnalyticsRange({ start: '2026-10-01', end: '2026-10-01' }, today).days).toBe(1);
  });

  it('日期不成立时回落预设，并给出 weeks 以便界面说明', () => {
    // 10 月没有 32 号；服务端只读接口不报错，回落到默认窗口
    for (const input of [
      { start: '2026-10-32', end: '2026-11-01' },
      { start: '2026-02-31', end: '2026-03-01' },
      { start: '', end: '2026-11-01' },
      { start: 'yesterday', end: '2026-11-01' },
    ]) {
      const range = resolveAnalyticsRange({ ...input, weeks: 13 }, today);
      expect(range.kind).toBe('preset');
      expect(range.weeks).toBe(13);
    }
  });

  it('超过 5 年回落预设', () => {
    const range = resolveAnalyticsRange({ start: '2019-01-01', end: '2026-10-15' }, today);

    expect(range.kind).toBe('preset');
    expect(range.weeks).toBe(defaultAnalyticsWeeks);
  });

  it('正好 5 年仍然收下', () => {
    const start = shiftIsoDays('2026-10-25', -(maxAnalyticsRangeDays - 1));
    const range = resolveAnalyticsRange({ start, end: '2026-10-25' }, today);

    expect(range.kind).toBe('custom');
    expect(range.days).toBe(maxAnalyticsRangeDays);
  });

  it('范围键把预设和自定义分开，同一天的两个入口不去重', () => {
    // 「近一年」会跟着今天滚动，手选 364 天是钉死的窗口，明天就不是同一件事了
    expect(analyticsRangeKey({ kind: 'preset', weeks: 52 })).toBe('52');
    expect(analyticsRangeKey({ kind: 'custom', start: '2025-10-26', end: '2026-10-25' })).toBe('2025-10-26~2026-10-25');
    expect(sameAnalyticsRange({ kind: 'preset', weeks: 52 }, { kind: 'preset', weeks: 52 })).toBe(true);
    expect(sameAnalyticsRange({ kind: 'preset', weeks: 52 }, { kind: 'custom', start: '2025-10-26', end: '2026-10-25' })).toBe(false);
  });

  it('判断「数据是不是所选范围」要比到具体日期', () => {
    const actual = { kind: 'custom' as const, weeks: null, start: '2026-10-01', end: '2026-10-15' };

    expect(rangeMatchesSelection(actual, { kind: 'custom', start: '2026-10-01', end: '2026-10-15' })).toBe(true);
    expect(rangeMatchesSelection(actual, { kind: 'custom', start: '2026-10-01', end: '2026-10-16' })).toBe(false);
    expect(rangeMatchesSelection(actual, { kind: 'preset', weeks: 52 })).toBe(false);
    expect(rangeMatchesSelection({ kind: 'preset', weeks: 26, start: '2026-04-27', end: '2026-10-25' }, { kind: 'preset', weeks: 26 })).toBe(true);
  });
});

describe('readStoredAnalyticsRange', () => {
  it('读不出东西时给默认', () => {
    expect(readStoredAnalyticsRange(null)).toEqual(defaultAnalyticsRange);
    expect(readStoredAnalyticsRange('')).toEqual(defaultAnalyticsRange);
    expect(readStoredAnalyticsRange('{')).toEqual(defaultAnalyticsRange);
  });

  it('兼容 v1 的纯数字周数', () => {
    expect(readStoredAnalyticsRange('26')).toEqual({ kind: 'preset', weeks: 26 });
    // 越界的旧值走区间校验
    expect(readStoredAnalyticsRange('9999')).toEqual({ kind: 'preset', weeks: defaultAnalyticsWeeks });
  });

  it('v2 的 JSON 原样读回', () => {
    expect(readStoredAnalyticsRange('{"kind":"preset","weeks":13}')).toEqual({ kind: 'preset', weeks: 13 });
    expect(readStoredAnalyticsRange('{"kind":"custom","start":"2026-10-01","end":"2026-10-15"}'))
      .toEqual({ kind: 'custom', start: '2026-10-01', end: '2026-10-15' });
  });

  it('存成反的起止日期也按「早的那天 → 晚的那天」读回', () => {
    // 手改过 localStorage、或旧版本写反过，都会走到这里。原样返回会让图表拿到
    // start > end 的窗口：一天都画不出来，页面上是空图，而且不报错。
    expect(readStoredAnalyticsRange('{"kind":"custom","start":"2026-10-15","end":"2026-10-01"}'))
      .toEqual({ kind: 'custom', start: '2026-10-01', end: '2026-10-15' });
  });

  it('JSON 里的自定义范围不成立时退回预设', () => {
    expect(readStoredAnalyticsRange('{"kind":"custom","start":"2026-10-32","end":"2026-11-01"}'))
      .toEqual({ kind: 'preset', weeks: defaultAnalyticsWeeks });
    expect(readStoredAnalyticsRange('{"kind":"custom","start":"2019-01-01","end":"2026-10-15"}'))
      .toEqual({ kind: 'preset', weeks: defaultAnalyticsWeeks });
  });
});
