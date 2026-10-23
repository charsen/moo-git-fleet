import { describe, expect, it } from 'vitest';
import {
  LUNCH_END_MINUTE,
  LUNCH_START_MINUTE,
  MINUTES_PER_WORKDAY,
  RESTART_GAP_MINUTES,
  SEGMENT_CONTEXT_MINUTES,
  SEGMENT_GAP_MINUTES,
  WORKDAY_END_MINUTE,
  WORKDAY_START_MINUTE,
  formatMinuteOfDay,
  formatWorkdayWindow,
  normalMinutesPerWorkday,
} from './work-window.js';

describe('work-window', () => {
  it('正常上班时段的净时长正好等于折合分母', () => {
    // 这是整套口径的地基：窗口自己必须能验算出 480，否则「折合 N 个 8 小时工作日」
    // 就是拿一个说不清来源的分母去除一个含午休的分子。
    expect(normalMinutesPerWorkday()).toBe(MINUTES_PER_WORKDAY);
    expect(normalMinutesPerWorkday()).toBe(480);
  });

  it('午休夹在上班与下班之间，且不为空', () => {
    expect(WORKDAY_START_MINUTE).toBeLessThan(LUNCH_START_MINUTE);
    expect(LUNCH_START_MINUTE).toBeLessThan(LUNCH_END_MINUTE);
    expect(LUNCH_END_MINUTE).toBeLessThan(WORKDAY_END_MINUTE);
  });

  it('重新开工的门槛比切段门槛宽，否则准备时间会被重复补', () => {
    // 两个数回答的是不同问题：90 分钟决定「是不是连着干的」，
    // 180 分钟决定「中间是不是走开过」。相等的话每条 >90 分钟的缝都会补一次 30 分钟。
    expect(RESTART_GAP_MINUTES).toBeGreaterThan(SEGMENT_GAP_MINUTES);
    expect(RESTART_GAP_MINUTES).toBeGreaterThan(SEGMENT_CONTEXT_MINUTES);
  });

  it('formatMinuteOfDay 补零并按 24 小时取模', () => {
    expect(formatMinuteOfDay(0)).toBe('00:00');
    expect(formatMinuteOfDay(510)).toBe('08:30');
    expect(formatMinuteOfDay(810)).toBe('13:30');
    expect(formatMinuteOfDay(1440)).toBe('00:00');
    expect(formatMinuteOfDay(-30)).toBe('23:30');
  });

  it('文案里的窗口与参与计算的常量一致', () => {
    expect(formatWorkdayWindow()).toBe('08:30–12:00、13:30–18:00');
  });
});
