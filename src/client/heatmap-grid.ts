/**
 * 提交热力图的日期网格与窗口统计。
 *
 * 从 `CommitHeatmap.vue` 里抽出来的原因有两个：
 * 1. 日期边界是这块最容易错的地方（时区、周一为首列、跨年、闰年、今天之后），
 *    纯函数才测得了；
 * 2. 服务端回的是全量历史，而图只画 52 周。窗口口径必须和实际画出来的列严格一致，
 *    否则统计卡片和格子对不上号。
 *
 * 窗口本身的定义不在这个文件里——`shared/report-window.ts` 才是唯一出处，
 * 服务端要给 numstat 划 `--since` 时引的是同一份。
 */

import { heatmapWeekCount, localDateFromIso, localIsoDate, reportWindow, shiftDays } from '../shared/report-window';

export { heatmapWeekCount, localIsoDate };

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

/** 热力图固定展示 52 列（一年）。窗口定义见 `shared/report-window.ts`。 */

/**
 * 生成过去 `weekCount` 周的日期网格；每列自上而下为周一 → 周日，最后一列是本周。
 */
export function buildHeatmapWeeks(
  today: Date,
  daily: Record<string, number>,
  weekCount: number = heatmapWeekCount,
): HeatmapDay[][] {
  const todayIso = localIsoDate(today);
  const firstMonday = localDateFromIso(reportWindow(today, weekCount).start);

  const weeks: HeatmapDay[][] = [];
  for (let week = 0; week < weekCount; week += 1) {
    const weekStart = shiftDays(firstMonday, week * 7);

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
