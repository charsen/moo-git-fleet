/**
 * 非上班时间推算。
 *
 * 提交数只能说明「动了多少次」，说明不了「投入多久」。这里补的是时长：
 *
 * 1. 相邻提交间隔 ≤ 90 分钟，视作同一个连续工作段（中途没断过手）；
 * 2. 每段开工前补 30 分钟准备时间——写代码之前总要看一眼上下文；
 * 3. 工作段落在「工作日 08:30 前 / 18:00 后、周末全天」的部分，算非上班时间；
 * 4. 时长 ÷ 480 折合 8 小时工作日。
 *
 * 刻意不引入 `Date` 做时区换算：所有提交时间先映射成「墙钟分钟」
 * （自 1970-01-01 起的天数 × 1440 + 时 × 60 + 分），之后全是整数加减。
 * 这样 23:50 到次日 00:10 就是相邻的 20 分钟，不会因为机器时区、夏令时
 * 或者提交里那个 `+08:00` / `-07:00` 的后缀而错位。墙钟时间本来就是
 * 「这个人当时几点」，和界面上的 7×24 矩阵是同一套口径。
 */
import {
  MINUTES_PER_WORKDAY,
  SEGMENT_CONTEXT_MINUTES,
  SEGMENT_GAP_MINUTES,
  WORKDAY_END_MINUTE,
  WORKDAY_START_MINUTE,
} from '../../shared/work-window.js';
import type { CommitOvertimeSummary } from '../../shared/contracts.js';

const minutesPerDay = 1440;

/** 一天里的第几天（1970-01-01 为 0），周末判定与跨日拆分都靠它。 */
function dayIndexOf(minute: number): number {
  return Math.floor(minute / minutesPerDay);
}

/** 周一 = 0，和 7×24 矩阵的行序一致。 */
function weekdayOf(dayIndex: number): number {
  return (new Date(dayIndex * minutesPerDay * 60_000).getUTCDay() + 6) % 7;
}

/**
 * `%aI` 的本地时间部分 → 墙钟分钟；解析不出来返回 `null`。
 *
 * 只取前 16 位里的年月日时分，忽略时区后缀——理由见文件头。历史里有几条
 * 形如 `2026-08-28T43:33:00Z` 的脏时间（时区偏移被写进了秒位），小时越界，
 * 这里直接丢掉：它们是导入时损坏的记录，算进时长只会污染结论。
 */
export function wallClockMinute(timestamp: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(timestamp);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const hours = Number(hour);
  const minutes = Number(minute);
  if (hours > 23 || minutes > 59) return null;

  const days = Date.UTC(Number(year), Number(month) - 1, Number(day)) / 60_000;
  if (!Number.isFinite(days)) return null;
  return days + hours * 60 + minutes;
}

interface Span {
  /** 闭端 */
  start: number;
  /** 开端 */
  end: number;
}

interface SegmentSpans {
  spans: Span[];
  segments: number;
}

/**
 * 把一堆墙钟分钟切成工作段，再把每段展开成「有长度的区间」。
 *
 * 单个提交也算一段，区间就是它前面那 30 分钟准备时间——不补的话，
 * 一天只提交一次的人贡献的时长是 0。
 */
export function buildSegmentSpans(minutes: number[]): SegmentSpans {
  const ordered = [...new Set(minutes)].sort((left, right) => left - right);
  if (ordered.length === 0) return { spans: [], segments: 0 };

  const spans: Span[] = [];
  let segments = 0;
  let index = 0;

  while (index < ordered.length) {
    const first = ordered[index];
    spans.push({ start: first - SEGMENT_CONTEXT_MINUTES, end: first });
    segments += 1;
    index += 1;

    let cursor = first;
    while (index < ordered.length && ordered[index] - cursor <= SEGMENT_GAP_MINUTES) {
      // 同一分钟的重复提交（多仓库同时落盘）间隔为 0，不产生区间
      if (ordered[index] > cursor) spans.push({ start: cursor, end: ordered[index] });
      cursor = ordered[index];
      index += 1;
    }
  }

  return { spans, segments };
}

/** 一天的区间里，落在非上班时段的部分。 */
function offHoursInDay(startMinute: number, endMinute: number, weekday: number): {
  early: number;
  evening: number;
  weekend: number;
} {
  if (weekday >= 5) return { early: 0, evening: 0, weekend: endMinute - startMinute };

  const early = Math.max(0, Math.min(endMinute, WORKDAY_START_MINUTE) - startMinute);
  const evening = Math.max(0, endMinute - Math.max(startMinute, WORKDAY_END_MINUTE));
  return { early, evening, weekend: 0 };
}

/**
 * 汇总非上班时长。入参是原始提交时间的墙钟分钟，顺序无所谓，内部会去重排序。
 */
export function summarizeOvertime(minutes: number[]): CommitOvertimeSummary {
  const { spans, segments } = buildSegmentSpans(minutes);

  let workMinutes = 0;
  let workdayMinutes = 0;
  let weekendMinutes = 0;
  let earlyMinutes = 0;
  let eveningMinutes = 0;
  const offHoursByDay = new Map<number, number>();

  for (const span of spans) {
    if (span.end <= span.start) continue;
    workMinutes += span.end - span.start;

    // 区间可能跨午夜：23:20 开工、次日 00:10 结束，两天各算各的窗口
    let cursor = span.start;
    while (cursor < span.end) {
      const dayIndex = dayIndexOf(cursor);
      const dayEnd = (dayIndex + 1) * minutesPerDay;
      const partEnd = Math.min(span.end, dayEnd);
      const from = cursor - dayIndex * minutesPerDay;
      const to = partEnd - dayIndex * minutesPerDay;

      const part = offHoursInDay(from, to, weekdayOf(dayIndex));
      if (part.early) {
        earlyMinutes += part.early;
        workdayMinutes += part.early;
      }
      if (part.evening) {
        eveningMinutes += part.evening;
        workdayMinutes += part.evening;
      }
      if (part.weekend) weekendMinutes += part.weekend;

      const off = part.early + part.evening + part.weekend;
      if (off > 0) offHoursByDay.set(dayIndex, (offHoursByDay.get(dayIndex) ?? 0) + off);

      cursor = partEnd;
    }
  }

  const offHoursMinutes = workdayMinutes + weekendMinutes;

  return {
    workMinutes,
    offHoursMinutes,
    workdayMinutes,
    weekendMinutes,
    earlyMinutes,
    eveningMinutes,
    segments,
    activeDays: offHoursByDay.size,
    equivalentDays: Math.round((offHoursMinutes / MINUTES_PER_WORKDAY) * 100) / 100,
  };
}
