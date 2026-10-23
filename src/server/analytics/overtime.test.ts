import { describe, expect, it } from 'vitest';
import { buildSegmentSpans, summarizeOvertime, wallClockMinute } from './overtime.js';

/**
 * 2026-03-02 是周一，2026-03-03 是周二，2026-03-07 是周六，2026-03-08 是周日。
 * 所有断言的期望值都是手算出来的，写清楚才能当口径文档看。
 */
function at(timestamp: string): number {
  const minute = wallClockMinute(timestamp);
  if (minute === null) throw new Error(`解析失败：${timestamp}`);
  return minute;
}

describe('wallClockMinute', () => {
  it('取本地时间部分，忽略时区后缀', () => {
    // 同一个墙钟时间、不同时区后缀，必须得到同一个值——
    // 否则 08:00 提交的加班判定会因为提交里写的是 +08:00 还是 -07:00 而翻转。
    expect(at('2026-03-02T10:00:00+08:00')).toBe(at('2026-03-02T10:00:00-07:00'));
    expect(at('2026-03-02T10:00:00+08:00')).toBe(at('2026-03-02T10:00:00Z'));
  });

  it('相邻两天的同一时刻差 1440 分钟', () => {
    expect(at('2026-03-03T10:00:00+08:00') - at('2026-03-02T10:00:00+08:00')).toBe(1440);
  });

  it('丢掉小时越界的脏记录', () => {
    // 历史里有几条 `2026-08-28T43:33:00Z`，是导入时把时区偏移写进了秒位
    expect(wallClockMinute('2026-08-28T43:33:00Z')).toBeNull();
    expect(wallClockMinute('2026-08-28T10:73:00Z')).toBeNull();
    expect(wallClockMinute('not a date')).toBeNull();
  });
});

describe('buildSegmentSpans', () => {
  it('单个提交也补一段准备时间', () => {
    const { spans, segments } = buildSegmentSpans([at('2026-03-02T10:00:00+08:00')]);

    expect(segments).toBe(1);
    expect(spans).toHaveLength(1);
    // 10:00 提交 → [09:30, 10:00)
    expect(spans[0].end - spans[0].start).toBe(30);
  });

  it('间隔 90 分钟算同一段，91 分钟拆成两段', () => {
    const same = buildSegmentSpans([at('2026-03-02T19:00:00+08:00'), at('2026-03-02T20:30:00+08:00')]);
    expect(same.segments).toBe(1);
    // 30 分钟准备 + 90 分钟间隔
    expect(same.spans.reduce((sum, span) => sum + span.end - span.start, 0)).toBe(120);

    const apart = buildSegmentSpans([at('2026-03-02T19:00:00+08:00'), at('2026-03-02T20:31:00+08:00')]);
    expect(apart.segments).toBe(2);
    // 两段各自补 30 分钟准备，中间那 91 分钟不算工作
    expect(apart.spans.reduce((sum, span) => sum + span.end - span.start, 0)).toBe(60);
  });

  it('同一分钟的重复提交不产生零长区间', () => {
    const minute = at('2026-03-02T19:00:00+08:00');
    const { spans, segments } = buildSegmentSpans([minute, minute, minute]);

    expect(segments).toBe(1);
    expect(spans).toHaveLength(1);
  });

  it('空输入返回空结果', () => {
    expect(buildSegmentSpans([])).toEqual({ spans: [], segments: 0 });
  });
});

describe('summarizeOvertime', () => {
  it('正常上班时段的提交不算非上班时间', () => {
    const result = summarizeOvertime([at('2026-03-02T10:00:00+08:00'), at('2026-03-02T10:30:00+08:00')]);

    // 30 分钟准备 + 30 分钟间隔
    expect(result.workMinutes).toBe(60);
    expect(result.offHoursMinutes).toBe(0);
    expect(result.workdayMinutes).toBe(0);
    expect(result.segments).toBe(1);
    expect(result.activeDays).toBe(0);
    expect(result.equivalentDays).toBe(0);
  });

  it('工作日晚间计入非上班时间', () => {
    const result = summarizeOvertime([at('2026-03-02T19:00:00+08:00')]);

    // [18:30, 19:00) 整段都在 18:00 之后
    expect(result.eveningMinutes).toBe(30);
    expect(result.earlyMinutes).toBe(0);
    expect(result.weekendMinutes).toBe(0);
    expect(result.offHoursMinutes).toBe(30);
    expect(result.workdayMinutes).toBe(30);
    expect(result.activeDays).toBe(1);
  });

  it('清晨提交只算 08:30 之前的那一截', () => {
    const result = summarizeOvertime([at('2026-03-02T08:40:00+08:00')]);

    // [08:10, 08:40) 与 [00:00, 08:30) 求交 → 20 分钟
    expect(result.earlyMinutes).toBe(20);
    expect(result.eveningMinutes).toBe(0);
    expect(result.offHoursMinutes).toBe(20);
  });

  it('08:30 之前的提交整段都算', () => {
    const result = summarizeOvertime([at('2026-03-02T08:00:00+08:00')]);

    expect(result.earlyMinutes).toBe(30);
    expect(result.offHoursMinutes).toBe(30);
  });

  it('周末全天都算非上班时间', () => {
    const saturday = summarizeOvertime([at('2026-03-07T12:00:00+08:00')]);
    expect(saturday.weekendMinutes).toBe(30);
    expect(saturday.workdayMinutes).toBe(0);
    expect(saturday.offHoursMinutes).toBe(30);

    // 周末凌晨同样算，不会落到 early 里
    const earlySaturday = summarizeOvertime([at('2026-03-07T02:00:00+08:00')]);
    expect(earlySaturday.earlyMinutes).toBe(0);
    expect(earlySaturday.weekendMinutes).toBe(30);
  });

  it('跨午夜的工作段按自然日拆开，各算各的窗口', () => {
    // 周一 23:50 与周二 00:10，间隔 20 分钟 → 同一段
    const result = summarizeOvertime([at('2026-03-02T23:50:00+08:00'), at('2026-03-03T00:10:00+08:00')]);

    expect(result.segments).toBe(1);
    // 23:20–23:50 → 30 分钟晚间；23:50–24:00 → 10 分钟晚间；00:00–00:10 → 10 分钟清晨
    expect(result.eveningMinutes).toBe(40);
    expect(result.earlyMinutes).toBe(10);
    expect(result.offHoursMinutes).toBe(50);
    expect(result.workMinutes).toBe(50);
    // 两天各自有非上班时间
    expect(result.activeDays).toBe(2);
  });

  it('跨午夜到周末时按周末计价', () => {
    // 周五 23:50 → 周六 00:10
    const result = summarizeOvertime([at('2026-03-06T23:50:00+08:00'), at('2026-03-07T00:10:00+08:00')]);

    // 周五 23:20–24:00 共 40 分钟晚间 + 周六 00:00–00:10 共 10 分钟周末
    expect(result.eveningMinutes).toBe(40);
    expect(result.weekendMinutes).toBe(10);
    expect(result.offHoursMinutes).toBe(50);
  });

  it('折合工作日按 8 小时除', () => {
    // 周六从 07:00 起每 30 分钟一次提交，共 33 个点：
    // 30 分钟准备 + 32 × 30 分钟间隔 = 990 分钟，末次 23:00，不跨日
    const minutes: number[] = [];
    for (let index = 0; index <= 32; index += 1) {
      minutes.push(at('2026-03-07T07:00:00+08:00') + index * 30);
    }

    const result = summarizeOvertime(minutes);

    expect(result.segments).toBe(1);
    expect(result.workMinutes).toBe(990);
    expect(result.weekendMinutes).toBe(990);
    expect(result.activeDays).toBe(1);
    // 990 / 480 = 2.0625 → 2.06
    expect(result.equivalentDays).toBe(2.06);
  });

  it('同一天多段各自补准备时间，段数如实上报', () => {
    const result = summarizeOvertime([
      at('2026-03-02T09:00:00+08:00'),
      at('2026-03-02T19:00:00+08:00'),
      at('2026-03-02T22:00:00+08:00'),
    ]);

    // 09:00 一段（30 分钟时段内，不算加班）；19:00 与 22:00 间隔 180 分钟 → 分成两段
    expect(result.segments).toBe(3);
    expect(result.offHoursMinutes).toBe(60);
    expect(result.activeDays).toBe(1);
  });

  it('空输入时所有字段为零，而不是 null 或 NaN', () => {
    expect(summarizeOvertime([])).toEqual({
      workMinutes: 0,
      offHoursMinutes: 0,
      workdayMinutes: 0,
      weekendMinutes: 0,
      earlyMinutes: 0,
      eveningMinutes: 0,
      segments: 0,
      activeDays: 0,
      equivalentDays: 0,
    });
  });
});
