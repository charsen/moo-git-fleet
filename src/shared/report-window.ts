/**
 * 分析页的统一报告窗口：过去 52 个自然周，周一为首列，本周为最后一列。
 *
 * 为什么放在 shared 而不是各写一份：服务端要用它给 `git log --since` 划界
 * （代码量不能对全历史跑 numstat），客户端要用它决定画哪 52 列格子。
 * 两边各算一次最容易差一天，而这一天的偏差会直接让「近 52 周提交」这个数字
 * 和格子对不上——正是上一轮刚修掉的那类毛病。窗口只在这里算一次。
 */

/** 热力图固定展示 52 列（一年）。 */
export const heatmapWeekCount = 52;

/** 归零到当天 00:00，避免跨夏令时的时候时分秒把日期算歪。 */
function atMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function shiftDays(date: Date, days: number): Date {
  const shifted = atMidnight(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

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

export interface ReportWindow {
  /** 第一列（周一）的日期 */
  start: string;
  /** 最后一列（本周周日）的日期 */
  end: string;
}

/** 计算窗口起止日期；`weekCount` 只在测试里改。 */
export function reportWindow(today: Date, weekCount: number = heatmapWeekCount): ReportWindow {
  const base = atMidnight(today);
  // 本周的周日：周一 offset 6、周六 offset 1、周日 offset 0
  const endOfWeek = shiftDays(base, (7 - base.getDay()) % 7);
  const start = shiftDays(endOfWeek, -(weekCount * 7 - 1));
  return { start: localIsoDate(start), end: localIsoDate(endOfWeek) };
}

/** 把 YYYY-MM-DD 当成**本地**日期解析，避免 `new Date(str)` 按 UTC 算差一天。 */
export function localDateFromIso(date: string): Date {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}
