/**
 * 提交热力图的日期网格与窗口统计。
 *
 * 从 `CommitHeatmap.vue` 里抽出来的原因有两个：
 * 1. 日期边界是这块最容易错的地方（时区、周一为首列、跨年、闰年、今天之后），
 *    纯函数才测得了；
 * 2. 服务端回的是全量历史，而图只画 52 周。窗口口径必须和实际画出来的列严格一致，
 *    否则统计卡片和格子对不上号。
 */

export interface HeatmapDay {
  /** 本地时区的 YYYY-MM-DD */
  date: string;
  /** 当天提交数 */
  count: number;
  /** 是否已经发生（今天及以前）。未来日期不绘制，也不计入窗口统计。 */
  elapsed: boolean;
}

export interface HeatmapWindowSummary {
  /** 窗口内的提交总数 */
  commits: number;
  /** 窗口内有提交的天数 */
  activeDays: number;
  /** 窗口内单日峰值，色阶以它为上限 */
  maxDaily: number;
}

/** 热力图固定展示 52 列（一年）。 */
export const heatmapWeekCount = 52;

/**
 * 本地时区的 YYYY-MM-DD。
 *
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 日期。东八区本地 00:00 转成 UTC
 * 是前一天 16:00，截出来整体前移一天，整张热力图跟着错位一格。
 */
export function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 归零到当天 00:00，避免跨夏令时的时候时分秒把日期算歪。 */
function atMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function shiftDays(date: Date, days: number): Date {
  const shifted = atMidnight(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

/**
 * 生成过去 `weekCount` 周的日期网格；每列自上而下为周一 → 周日，最后一列是本周。
 */
export function buildHeatmapWeeks(
  today: Date,
  daily: Record<string, number>,
  weekCount: number = heatmapWeekCount,
): HeatmapDay[][] {
  const base = atMidnight(today);
  const todayIso = localIsoDate(base);

  // 本周的周日：周一 offset 6、周六 offset 1、周日 offset 0
  const endOfWeek = shiftDays(base, (7 - base.getDay()) % 7);

  const weeks: HeatmapDay[][] = [];
  for (let week = weekCount - 1; week >= 0; week -= 1) {
    // 回推到该周的周一
    const weekStart = shiftDays(endOfWeek, -(week * 7 + 6));

    const days: HeatmapDay[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = shiftDays(weekStart, offset);
      const iso = localIsoDate(date);
      days.push({
        date: iso,
        count: daily[iso] ?? 0,
        // 同格式的 ISO 日期串可以直接比较
        elapsed: iso <= todayIso,
      });
    }
    weeks.push(days);
  }

  return weeks;
}

/** 汇总窗口内的提交数、活跃天数与单日峰值（只算已经发生的日期）。 */
export function summarizeHeatmapWindow(weeks: HeatmapDay[][]): HeatmapWindowSummary {
  let commits = 0;
  let activeDays = 0;
  let maxDaily = 0;

  for (const week of weeks) {
    for (const day of week) {
      if (!day.elapsed) continue;
      commits += day.count;
      if (day.count > 0) activeDays += 1;
      if (day.count > maxDaily) maxDaily = day.count;
    }
  }

  return { commits, activeDays, maxDaily };
}

/** 把提交数映射到 0–4 档，0 表示空格子。 */
export function heatmapLevel(count: number, maxDaily: number): number {
  if (count <= 0) return 0;
  if (maxDaily <= 1) return 4;
  // 1..max 均分四档：最大值落在第 4 档，1 次提交不会直接跳到最亮
  return Math.min(Math.floor(((count - 1) * 4) / maxDaily) + 1, 4);
}

/** 深夜档：22:00 – 05:59。 */
const lateNightHours = new Set([22, 23, 0, 1, 2, 3, 4, 5]);

export interface HourlySummary {
  total: number;
  /** 周一至周五 */
  workday: number;
  /** 周六 + 周日 */
  weekend: number;
  /** 22 点至次日 6 点 */
  lateNight: number;
  /** 最忙的那一格；全空时为 null */
  peak: { weekday: number; hour: number; count: number } | null;
}

/** 汇总 7×24 时段矩阵：工作日 / 周末 / 深夜占比，以及峰值时段。 */
export function summarizeHourly(hourly: number[][]): HourlySummary {
  let total = 0;
  let workday = 0;
  let weekend = 0;
  let lateNight = 0;
  let peak: HourlySummary['peak'] = null;

  for (let weekday = 0; weekday < hourly.length; weekday += 1) {
    const row = hourly[weekday];
    for (let hour = 0; hour < row.length; hour += 1) {
      const count = row[hour] ?? 0;
      if (count <= 0) continue;
      total += count;
      if (weekday <= 4) workday += count;
      else weekend += count;
      if (lateNightHours.has(hour)) lateNight += count;
      // 并列时保留先遇到的（更早的星期 / 更早的小时），结果才稳定
      if (!peak || count > peak.count) peak = { weekday, hour, count };
    }
  }

  return { total, workday, weekend, lateNight, peak };
}

export type FreshnessBucket = 'week' | 'month' | 'quarter' | 'older';

export type RepositoryFreshness = Record<FreshnessBucket, number>;

/** 把 YYYY-MM-DD 当成**本地**日期解析，避免 `new Date(str)` 按 UTC 算差一天。 */
function localDateFromIso(date: string): Date {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/**
 * 按「最近一次提交距今多久」把仓库分档。
 *
 * 没有提交记录的仓库（lastCommitDate 为 null）不计入任何一档：
 * 「从没提交过」和「很久没动」是两件事，混在一起会误导。
 */
export function bucketRepositoryFreshness(
  repositories: { lastCommitDate: string | null }[],
  today: Date,
): RepositoryFreshness {
  const buckets: RepositoryFreshness = { week: 0, month: 0, quarter: 0, older: 0 };
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  for (const repository of repositories) {
    if (!repository.lastCommitDate) continue;
    const days = Math.round((base - localDateFromIso(repository.lastCommitDate).getTime()) / 86_400_000);
    // 时钟偏差导致「未来提交」时按最近算，不要落进 older
    if (days <= 7) buckets.week += 1;
    else if (days <= 30) buckets.month += 1;
    else if (days <= 90) buckets.quarter += 1;
    else buckets.older += 1;
  }

  return buckets;
}
