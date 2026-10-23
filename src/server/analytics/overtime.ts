/**
 * 非上班时间推算。
 *
 * 提交数只能说明「动了多少次」，说明不了「投入多久」。这里补的是时长。
 *
 * ## 口径
 *
 * 1. 相邻提交间隔 ≤ 90 分钟，视作同一个连续工作段（中途没断过手）；
 * 2. 每段开工前补 30 分钟准备时间，但只在**重新开工**时补——距上一段结束
 *    ≥ 180 分钟才补（见 `RESTART_GAP_MINUTES`）。一天里被午休、开会切开的三段，
 *    人没离开工位，每段都补一次等于凭空造出 90 分钟；
 * 3. 工作日的正常上班时段是 08:30–12:00 与 13:30–18:00，合计 480 分钟 = 1 个工作日；
 * 4. 其余时间算非上班：工作日早于 08:30、晚于 18:00、午休，以及周末全天；
 * 5. 时长 ÷ 480 折合 8 小时工作日；
 * 6. 单日非上班时长不足 15 分钟的仍然算「涉及这一天」，但另给一个 `lightDays` 计数：
 *    「下班前最后 5 分钟提交了一次」是真实记录，剔掉会显得数字被修饰过；
 *    可它也不该被读成「这天有加班投入」，所以两个数一起给。
 *
 * ## 午休为什么单列
 *
 * 12:00–13:30 是个"灰洞"：一段跨过它的区间只能证明这一小时半里没有提交，
 * 既不能证明在休息，也不能证明在干活。所以默认剪掉，两头都不计。但如果一段
 * **整段落在午休里**（提交就发生在 12:30），那它本身就是证据，计入午休加班。
 *
 * 不这么处理的话，有两种错法：整段算上班 → 全勤一天变成 1.19 个工作日，
 * 和分母 480 直接打架；整段丢弃 → 午休里真实的 635 条提交（占 6.25%）凭空消失。
 *
 * ## 为什么不引时区
 *
 * 刻意不引入 `Date` 做时区换算：所有提交时间先映射成「墙钟分钟」
 * （自 1970-01-01 起的天数 × 1440 + 时 × 60 + 分），之后全是整数加减。
 * 这样 23:50 到次日 00:10 就是相邻的 20 分钟，不会因为机器时区、夏令时
 * 或者提交里那个 `+08:00` / `-07:00` 的后缀而错位。墙钟时间本来就是
 * 「这个人当时几点」，和界面上的 7×24 矩阵是同一套口径。
 *
 * ## 为什么不管法定节假日与调休
 *
 * 日界只认「周一至周五上班、周六日休息」，不读年度日历——这是 2026-10-23
 * 明确的非目标，不是待补的洞。原理由：这份数据只用来看趋势，不做考勤结算；
 * 而维护一张每年更新的日历（国务院每年 11 月前后才发布次年安排）代价远大于
 * 它带来的偏差，且偏差两个方向相反（节假日里的工作日提交少记加班、
 * 调休上班的周六多记加班），量级都在几十小时。
 *
 * 真要拿它做结算依据，第一步是先补 `config/work-calendar.yaml`，
 * 而不是调这几个常量。
 */
import {
  LUNCH_END_MINUTE,
  LUNCH_START_MINUTE,
  MINUTES_PER_WORKDAY,
  RESTART_GAP_MINUTES,
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

/** 两个左闭右开区间的交集长度。 */
function overlap(from: number, to: number, start: number, end: number): number {
  return Math.max(0, Math.min(to, end) - Math.max(from, start));
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
  /**
   * 这段有没有「提交落在午休里」作为锚点。
   *
   * 只看区间几何会被 12:00 与 13:30 各一次提交骗到：那 90 分钟整段落在午休范围内，
   * 但人显然是去吃饭了，不是连着干了 90 分钟。所以锚点定在**提交自己**身上——
   * 区间段要求两端提交都在午休内，准备段要求它所对应的那次提交在午休内。
   */
  anchored: boolean;
}

interface SegmentSpans {
  spans: Span[];
  segments: number;
}

/** 提交时刻（当天第几分钟）是否落在午休窗口里。 */
function isLunchClock(minuteOfDay: number): boolean {
  return minuteOfDay >= LUNCH_START_MINUTE && minuteOfDay < LUNCH_END_MINUTE;
}

/**
 * 把一堆墙钟分钟切成工作段，再把每段展开成「有长度的区间」。
 *
 * 单个提交也算一段，区间就是它前面那 30 分钟准备时间——不补的话，
 * 一天只提交一次的人贡献的时长是 0。
 *
 * 但准备时间只在「重新开工」时补：上一段刚结束没多久又开始提交，说明人一直
 * 在工位上，中间那点空隙不是重新搭环境。这条把「每段各补一次」的九成虚增去掉，
 * 同时保留了「午休后、晚饭后回来接着干」的那一次。
 */
export function buildSegmentSpans(minutes: number[]): SegmentSpans {
  const ordered = [...new Set(minutes)].sort((left, right) => left - right);
  if (ordered.length === 0) return { spans: [], segments: 0 };

  const clockOf = (minute: number) => ((minute % minutesPerDay) + minutesPerDay) % minutesPerDay;
  const spans: Span[] = [];
  let segments = 0;
  let index = 0;
  /** 上一段最后一个提交的时刻；`null` 表示这是当天第一段。 */
  let previousEnd: number | null = null;

  while (index < ordered.length) {
    const first = ordered[index];
    if (previousEnd === null || first - previousEnd >= RESTART_GAP_MINUTES) {
      spans.push({ start: first - SEGMENT_CONTEXT_MINUTES, end: first, anchored: isLunchClock(clockOf(first)) });
    }
    segments += 1;
    index += 1;

    let cursor = first;
    while (index < ordered.length && ordered[index] - cursor <= SEGMENT_GAP_MINUTES) {
      // 同一分钟的重复提交（多仓库同时落盘）间隔为 0，不产生区间
      if (ordered[index] > cursor) {
        spans.push({
          start: cursor,
          end: ordered[index],
          anchored: isLunchClock(clockOf(cursor)) && isLunchClock(clockOf(ordered[index])),
        });
      }
      cursor = ordered[index];
      index += 1;
    }
    previousEnd = cursor;
  }

  return { spans, segments };
}

/** 一天的区间落在各时段上的分钟数。 */
interface DayPart {
  /** 正常上班时段 */
  normal: number;
  /** 工作日 08:30 之前 */
  early: number;
  /** 工作日午休，且整段都在午休内（有提交锚定） */
  lunch: number;
  /** 工作日 18:00 之后 */
  evening: number;
  /** 周末全天 */
  weekend: number;
  /** 跨过午休、但没有提交锚定的那部分——剪掉，不计入任何一档 */
  dropped: number;
}

function splitDayPart(from: number, to: number, weekday: number, anchored: boolean): DayPart {
  const length = to - from;
  const empty: DayPart = { normal: 0, early: 0, lunch: 0, evening: 0, weekend: 0, dropped: 0 };

  // 周末没有制度化的午休，全天都是非上班时间，不做剪裁
  if (weekday >= 5) return { ...empty, weekend: length };

  const early = overlap(from, to, 0, WORKDAY_START_MINUTE);
  const evening = overlap(from, to, WORKDAY_END_MINUTE, minutesPerDay);
  const lunchWindow = overlap(from, to, LUNCH_START_MINUTE, LUNCH_END_MINUTE);

  // 午休里的时间只有在有提交锚定的时候才算数，否则是灰洞
  const lunch = anchored ? lunchWindow : 0;
  const dropped = anchored ? 0 : lunchWindow;

  return {
    normal: Math.max(0, length - early - evening - lunchWindow),
    early,
    lunch,
    evening,
    weekend: 0,
    dropped,
  };
}

/** 低于这个分钟数的日子算「只是碰了一下」：下班前最后一个提交通常不到 15 分钟。 */
const LIGHT_DAY_MINUTES = 15;

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
  let lunchMinutes = 0;
  const offHoursByDay = new Map<number, number>();

  for (const span of spans) {
    if (span.end <= span.start) continue;

    // 区间可能跨午夜：23:20 开工、次日 00:10 结束，两天各算各的窗口
    let cursor = span.start;
    while (cursor < span.end) {
      const dayIndex = dayIndexOf(cursor);
      const dayEnd = (dayIndex + 1) * minutesPerDay;
      const partEnd = Math.min(span.end, dayEnd);
      const from = cursor - dayIndex * minutesPerDay;
      const to = partEnd - dayIndex * minutesPerDay;

      const part = splitDayPart(from, to, weekdayOf(dayIndex), span.anchored);
      const counted = part.normal + part.early + part.lunch + part.evening + part.weekend;
      workMinutes += counted;

      if (part.early) {
        earlyMinutes += part.early;
        workdayMinutes += part.early;
      }
      if (part.lunch) {
        lunchMinutes += part.lunch;
        workdayMinutes += part.lunch;
      }
      if (part.evening) {
        eveningMinutes += part.evening;
        workdayMinutes += part.evening;
      }
      if (part.weekend) weekendMinutes += part.weekend;

      const off = part.early + part.lunch + part.evening + part.weekend;
      if (off > 0) offHoursByDay.set(dayIndex, (offHoursByDay.get(dayIndex) ?? 0) + off);

      cursor = partEnd;
    }
  }

  const offHoursMinutes = workdayMinutes + weekendMinutes;

  let lightDays = 0;
  for (const off of offHoursByDay.values()) if (off < LIGHT_DAY_MINUTES) lightDays += 1;

  return {
    workMinutes,
    offHoursMinutes,
    workdayMinutes,
    weekendMinutes,
    earlyMinutes,
    lunchMinutes,
    eveningMinutes,
    segments,
    activeDays: offHoursByDay.size,
    lightDays,
    equivalentDays: Math.round((offHoursMinutes / MINUTES_PER_WORKDAY) * 100) / 100,
  };
}
