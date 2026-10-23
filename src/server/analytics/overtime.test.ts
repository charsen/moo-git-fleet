import { describe, expect, it } from 'vitest';
import { buildSegmentSpans, summarizeOvertime, wallClockMinute } from './overtime.js';
import { normalMinutesPerWorkday } from '../../shared/work-window.js';

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
    // 只补第一段的 30 分钟：中间那 91 分钟不算工作，但也没久到需要重新开工
    expect(apart.spans.reduce((sum, span) => sum + span.end - span.start, 0)).toBe(30);
  });

  it('离开超过 3 小时才重新补准备时间', () => {
    // 18:00 与 21:00 相隔 180 分钟：够久，算重新开工
    const restarted = buildSegmentSpans([at('2026-03-02T18:00:00+08:00'), at('2026-03-02T21:00:00+08:00')]);
    expect(restarted.segments).toBe(2);
    // 17:30–18:00 + 20:30–21:00
    expect(restarted.spans.reduce((sum, span) => sum + span.end - span.start, 0)).toBe(60);

    // 18:00 与 20:59 相隔 179 分钟：差一分钟就不算离开过
    const continuous = buildSegmentSpans([at('2026-03-02T18:00:00+08:00'), at('2026-03-02T20:59:00+08:00')]);
    expect(continuous.segments).toBe(2);
    expect(continuous.spans.reduce((sum, span) => sum + span.end - span.start, 0)).toBe(30);
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

  it('同一天多段：相隔够久才各自补准备时间，段数如实上报', () => {
    const result = summarizeOvertime([
      at('2026-03-02T09:00:00+08:00'),
      at('2026-03-02T19:00:00+08:00'),
      at('2026-03-02T22:00:00+08:00'),
    ]);

    // 09:00 一段（30 分钟时段内，不算加班）；19:00 与 22:00 相隔 180/600 分钟 → 三段都补准备时间
    expect(result.segments).toBe(3);
    expect(result.offHoursMinutes).toBe(60);
    expect(result.activeDays).toBe(1);
  });

  it('全勤一天正好等于 1 个工作日', () => {
    // 08:30–12:00 与 13:30–18:00 每 5 分钟提交一次，午休没人提交，但 90 分钟的缝
    // 刚好落在段间隔上限内，整段仍然是一段——正是要验的那种「在岗 9.5 小时」
    const fullDay: number[] = [];
    for (let minute = 510; minute <= 720; minute += 5) fullDay.push(at('2026-03-02T00:00:00+08:00') + minute);
    for (let minute = 810; minute <= 1080; minute += 5) fullDay.push(at('2026-03-02T00:00:00+08:00') + minute);

    const result = summarizeOvertime(fullDay);

    // 正常上班时段净 480 分钟，正好是分母；午休那 90 分钟被剪掉
    expect(result.workMinutes - result.offHoursMinutes).toBe(480);
    expect(normalMinutesPerWorkday()).toBe(480);
    // 08:00–08:30 的准备时间算早到
    expect(result.earlyMinutes).toBe(30);
    expect(result.offHoursMinutes).toBe(30);
    expect(result.lunchMinutes).toBe(0);
  });

  it('跨过午休、午休里又没有提交的那一段，两头都不计', () => {
    // 11:50 与 13:10 相隔 80 分钟 → 同一段，整段跨过午休
    const result = summarizeOvertime([at('2026-03-02T11:50:00+08:00'), at('2026-03-02T13:10:00+08:00')]);

    // 只留下 11:20–11:50 准备 + 11:50–12:00 的 10 分钟，12:00–13:10 是灰洞
    expect(result.workMinutes).toBe(40);
    expect(result.lunchMinutes).toBe(0);
    expect(result.offHoursMinutes).toBe(0);
  });

  it('午休里的孤立提交算午休加班', () => {
    const result = summarizeOvertime([at('2026-03-02T12:30:00+08:00')]);

    // 12:00–12:30 整段落在午休里，提交就是证据
    expect(result.lunchMinutes).toBe(30);
    expect(result.offHoursMinutes).toBe(30);
    expect(result.workdayMinutes).toBe(30);
  });

  it('周末不剪午休：周末没有制度化的午休', () => {
    const result = summarizeOvertime([at('2026-03-07T11:50:00+08:00'), at('2026-03-07T13:10:00+08:00')]);

    // 30 分钟准备 + 80 分钟间隔，全部算周末
    expect(result.weekendMinutes).toBe(110);
    expect(result.offHoursMinutes).toBe(110);
    expect(result.lunchMinutes).toBe(0);
  });

  it('空输入时所有字段为零，而不是 null 或 NaN', () => {
    expect(summarizeOvertime([])).toEqual({
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
    });
  });
});
