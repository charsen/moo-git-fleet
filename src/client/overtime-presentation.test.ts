import { describe, expect, it } from 'vitest';
import type { CommitOvertimeSummary } from '../shared/contracts';
import { formatHours, formatWorkdays, isZeroHours, overtimeParts } from './overtime-presentation';

function overtime(patch: Partial<CommitOvertimeSummary> = {}): CommitOvertimeSummary {
  return {
    workMinutes: 0,
    offHoursMinutes: 0,
    workdayMinutes: 0,
    weekendMinutes: 0,
    earlyMinutes: 0,
    lunchMinutes: 0,
    eveningMinutes: 0,
    segments: 0,
    activeDays: 0,
    equivalentDays: 0,
    ...patch,
  };
}

describe('formatHours', () => {
  it('分钟折成一位小数的小时', () => {
    expect(formatHours(0)).toBe('0.0');
    expect(formatHours(30)).toBe('0.5');
    expect(formatHours(49_476)).toBe('824.6');
  });

  it('过千加千分位，别让五位数字连成一片', () => {
    expect(formatHours(105_102)).toBe('1,751.7');
  });
});

describe('formatWorkdays', () => {
  it('折合工作日收成一位小数', () => {
    expect(formatWorkdays(0)).toBe('0.0');
    expect(formatWorkdays(103.08)).toBe('103.1');
  });
});

describe('isZeroHours', () => {
  it('跟着显示出来的字判断，而不是原始分钟数', () => {
    expect(isZeroHours(0)).toBe(true);
    // 2 分钟 = 0.033 小时，渲染成 0.0，那就必须当成零
    expect(isZeroHours(2)).toBe(true);
    // 3 分钟 = 0.05 小时，渲染成 0.1，不再算零
    expect(isZeroHours(3)).toBe(false);
    expect(isZeroHours(30)).toBe(false);
  });
});

describe('overtimeParts', () => {
  it('固定顺序：晚间 → 周末 → 早间 → 午休', () => {
    const parts = overtimeParts(
      overtime({ eveningMinutes: 30, weekendMinutes: 600, earlyMinutes: 10, lunchMinutes: 5 }),
    );

    expect(parts.map((part) => part.key)).toEqual(['evening', 'weekend', 'early', 'lunch']);
    // 顺序不随数据大小变：跨月对比时标签得待在同一行
    expect(parts.map((part) => part.label)).toEqual(['工作日晚间', '周末', '工作日早间', '工作日午休']);
  });

  it('四段占比加起来正好 100%', () => {
    const parts = overtimeParts(
      overtime({ eveningMinutes: 41_200, weekendMinutes: 23_952, earlyMinutes: 4_324, lunchMinutes: 900 }),
    );
    const total = parts.reduce((sum, part) => sum + part.share, 0);

    expect(total).toBeCloseTo(100, 10);
  });

  it('分母取四段之和，不取服务端的汇总字段', () => {
    // 汇总字段漏了更新（或以后口径改了没同步）时，宽度仍要按明细分配，
    // 否则条形整体缩放、图例还是原值，屏幕上两个数各说各话。
    const parts = overtimeParts(overtime({ eveningMinutes: 100, weekendMinutes: 100, offHoursMinutes: 0 }));

    expect(parts.find((part) => part.key === 'evening')?.share).toBe(50);
    expect(parts.find((part) => part.key === 'weekend')?.share).toBe(50);
  });

  it('最大的一段用最实的底色，其余依次变淡', () => {
    const parts = overtimeParts(overtime({ eveningMinutes: 100, weekendMinutes: 900, earlyMinutes: 10 }));
    const opacity = Object.fromEntries(parts.map((part) => [part.key, part.opacity]));

    expect(opacity.weekend).toBe(1);
    expect(opacity.evening).toBe(0.72);
    expect(opacity.early).toBe(0.5);
    // 午休常态为 0，排在最后、用最淡的底色
    expect(opacity.lunch).toBe(0.32);
  });

  it('全为零时不给宽度，也不会算出 NaN', () => {
    const parts = overtimeParts(overtime());

    expect(parts.every((part) => part.share === 0)).toBe(true);
    expect(parts.every((part) => Number.isFinite(part.share))).toBe(true);
  });

  it('只有一段时它独占整条', () => {
    const parts = overtimeParts(overtime({ weekendMinutes: 600 }));

    expect(parts.find((part) => part.key === 'weekend')?.share).toBe(100);
    expect(parts.filter((part) => part.key !== 'weekend').every((part) => part.share === 0)).toBe(true);
  });
});
