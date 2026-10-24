/**
 * 提交热力图的日期网格与窗口统计。
 *
 * 从 `CommitHeatmap.vue` 里抽出来的原因有两个：
 * 1. 日期边界是这块最容易错的地方（时区、周一为首列、跨年、闰年、今天之后），
 *    纯函数才测得了；
 * 2. 服务端按所选时间段裁剪数据，图也只画这个时间段。窗口口径必须和实际
 *    画出来的列严格一致，否则统计卡片和格子对不上号。
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
  /**
   * 是否落在所选时间段内。
   *
   * 自定义起止日期不一定对齐到周一/周日，而格子必须按星期排列，所以首尾两列
   * 会各多出几天窗口外的日期。这几天不绘制、不计数——图要整列，数字要精确。
   */
  inWindow: boolean;
}

export interface HeatmapWindowSummary {
  /** 窗口内的提交总数 */
  commits: number;
  /** 窗口内有提交的天数 */
  activeDays: number;
  /** 窗口内单日峰值，色阶以它为上限 */
  maxDaily: number;
}

/**
 * 生成过去 `weekCount` 周的日期网格；每列自上而下为周一 → 周日，最后一列是本周。
 *
 * 按「周数」推算窗口的版本。时间段可选之后，页面一律走
 * `buildHeatmapWeeksForWindow`（照服务端回传的起止日期画），这个入口现在只有
 * 测试在用——留着它是因为「周数 → 网格」仍然是最直观的断言写法。
 */
export function buildHeatmapWeeks(
  today: Date,
  daily: Record<string, number>,
  weekCount: number = heatmapWeekCount,
): HeatmapDay[][] {
  const window = reportWindow(today, weekCount);
  return buildHeatmapWeeksForWindow(window.start, window.end, daily, localIsoDate(today));
}

/**
 * 按**显式**的起止日期生成网格。
 *
 * 时间段可选之后，「哪几列」不能再由前端自己按周数推：服务端按所选范围算窗口、
 * 前端再算一遍，看着一致，但只要有一边换了算法（比如把「本周」改成「上周」）
 * 两边就会差一周。现在服务端把窗口原样回传，前端照着画，误差无从产生。
 *
 * 行必须对应星期，所以网格向外扩到整周：从 `start` 所在周的周一开始，
 * 画到 `end` 所在周的周日；多出来的格子 `inWindow: false`，不绘制也不计数。
 * 预设范围本来就对齐整周，扩不出多余的天。
 */
export function buildHeatmapWeeksForWindow(
  startIso: string,
  endIso: string,
  daily: Record<string, number>,
  todayIso: string,
): HeatmapDay[][] {
  const startDate = localDateFromIso(startIso);
  const endDate = localDateFromIso(endIso);
  // getDay()：周日是 0，这里换算成「离本周一几天」
  const firstMonday = shiftDays(startDate, -((startDate.getDay() + 6) % 7));
  const lastSunday = shiftDays(endDate, (7 - endDate.getDay()) % 7);
  const spanDays = Math.round((lastSunday.getTime() - firstMonday.getTime()) / 86_400_000) + 1;
  const weekCount = Math.max(1, Math.ceil(spanDays / 7));

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
        inWindow: iso >= startIso && iso <= endIso,
      });
    }
    weeks.push(days);
  }

  return weeks;
}

const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export interface MonthLabel {
  /** 该月第一列在网格里的下标 */
  index: number;
  label: string;
}

/**
 * 给热力图顶部的月份刻度挑位置。
 *
 * 早先的实现是「换月就打标签，两个标签不足 3 列就丢后一个」。窗口左边界因此出事：
 * 起始那一两周往往只属于上个月，这个残月占掉第一个标签位，紧接着的完整月份又因
 * 间距不足被丢掉——近一年渲染成「10月 … 12月」，11 月凭空消失；近 3 个月是
 * 「7月 9月 10月」，8 月没了。真机在 1024 / 2304 都能看见。
 *
 * 现在的判断按「月段」来：先把周列切成月段（周四代表整周，跨月周不算到上一月），
 * 两端不足两列的残月不打标签，把位置让给后面那个完整的月，然后再套 3 列的最小间距。
 */
export function buildMonthLabels(weeks: HeatmapDay[][]): MonthLabel[] {
  const runs: { month: number; start: number; end: number }[] = [];
  weeks.forEach((week, weekIndex) => {
    const midDay = week[3];
    if (!midDay) return;
    // 直接拆字符串，别用 new Date(iso)：ISO 日期会被当成 UTC 解析，西半球会错月。
    const month = Number(midDay.date.slice(5, 7)) - 1;
    const last = runs[runs.length - 1];
    if (last && last.month === month) last.end = weekIndex;
    else runs.push({ month, start: weekIndex, end: weekIndex });
  });

  const labels: MonthLabel[] = [];
  let lastIndex = -10;
  runs.forEach((run, runIndex) => {
    const span = run.end - run.start + 1;
    const atEdge = runIndex === 0 || runIndex === runs.length - 1;
    if (atEdge && span < 2) return;
    // 太挤的两个月只保留前一个，否则标签会叠在一起
    if (run.start - lastIndex < 3) return;
    labels.push({ index: run.start, label: monthNames[run.month] });
    lastIndex = run.start;
  });
  return labels;
}

/** 这一格是否要画：落在所选窗口内、且已经发生。 */
export function isHeatmapDayDrawn(day: HeatmapDay | undefined): boolean {
  return Boolean(day && day.inWindow && day.elapsed);
}

/** 汇总窗口内的提交数、活跃天数与单日峰值（只算窗口内已经发生的日期）。 */
export function summarizeHeatmapWindow(weeks: HeatmapDay[][]): HeatmapWindowSummary {
  let commits = 0;
  let activeDays = 0;
  let maxDaily = 0;

  for (const week of weeks) {
    for (const day of week) {
      if (!isHeatmapDayDrawn(day)) continue;
      commits += day.count;
      if (day.count > 0) activeDays += 1;
      if (day.count > maxDaily) maxDaily = day.count;
    }
  }

  return { commits, activeDays, maxDaily };
}

/**
 * 短窗口按天摊平：每列一天，按日期升序。
 *
 * 7 行网格在列数少的时候会退化成一条对角线——7 天的窗口只有 2 列，画出来是 7 个
 * 斜着排的格子，剩下六行恒空；45 天也只有 7 列。这是「按周画列」这个画法本身在
 * 短窗口上的极限，不是留白多寡的问题。所以短窗口换画法：一列一天，高度表示提交数。
 *
 * 只收窗口内、已经发生的日子，和网格用的是同一个判据（`isHeatmapDayDrawn`），
 * 保证两种画法给出的总数、活跃天数、峰值完全一致。
 */
export function flattenWindowDays(weeks: HeatmapDay[][]): DailyBarPoint[] {
  const points: DailyBarPoint[] = [];
  for (const week of weeks) {
    for (const day of week) {
      if (!isHeatmapDayDrawn(day)) continue;
      points.push({ date: day.date, count: day.count });
    }
  }
  return points;
}

export interface DailyBarPoint {
  date: string;
  count: number;
}

export interface DailyBar {
  date: string;
  count: number;
  x: number;
  width: number;
  height: number;
  /** 1–4，和热力图共用色阶；0 表示空白天 */
  level: number;
}

export interface DailyBarsLayout {
  bars: DailyBar[];
  /** 命中区：一天一个整高透明矩形。柱子只有几个像素宽时靠它接住悬停。 */
  slots: { date: string; count: number; x: number; width: number }[];
  /** 底部日期刻度 */
  ticks: { x: number; label: string }[];
  maxCount: number;
  /** 空白天也画一根短桩，基线才连得起来 */
  stubHeight: number;
  slot: number;
  barWidth: number;
}

/** 空白天短桩的高度：够看见、不喧宾夺主。 */
export const dailyBarStubHeight = 2;

export interface DailyBarsOptions {
  /** 绘图区宽度（CSS 像素） */
  width: number;
  /** 绘图区高度，不含顶部余量与底部刻度 */
  plotHeight: number;
  maxBarWidth?: number;
  /** 底部最多几个日期刻度 */
  maxTicks?: number;
}

/**
 * 把「每天一个数」排成柱状图。
 *
 * 宽度永远是整幅：柱子按 `width / 天数` 分槽，这样短窗口不会再把卡片空掉一大半。
 * 槽位宽到离谱时（7 天在 1440 下一天 190px）靠 `maxBarWidth` 把柱子本身钉住，
 * 否则会变成七块色板；柱子在自己的槽里居中，读起来仍是「一天一根」。
 */
export function layoutDailyBars(points: DailyBarPoint[], options: DailyBarsOptions): DailyBarsLayout {
  const width = Math.max(0, options.width);
  const plotHeight = Math.max(0, options.plotHeight);
  const maxBarWidth = options.maxBarWidth ?? 60;
  const maxTicks = options.maxTicks ?? 7;
  const maxCount = points.reduce((peak, point) => Math.max(peak, point.count), 0);
  const empty: DailyBarsLayout = {
    bars: [],
    slots: [],
    ticks: [],
    maxCount,
    stubHeight: dailyBarStubHeight,
    slot: 0,
    barWidth: 0,
  };
  if (points.length === 0 || width <= 0 || plotHeight <= 0) return empty;

  const slot = width / points.length;
  const barWidth = Math.max(1, Math.min(slot * 0.62, maxBarWidth));

  const bars = points.map((point, index) => ({
    date: point.date,
    count: point.count,
    x: index * slot + (slot - barWidth) / 2,
    width: barWidth,
    // 有提交的最矮也给 3px：1 次提交画成 1px 高就看不见了
    height: point.count > 0
      ? Math.max(dailyBarStubHeight + 1, (point.count / maxCount) * plotHeight)
      : dailyBarStubHeight,
    level: heatmapLevel(point.count, maxCount),
  }));

  const slots = points.map((point, index) => ({
    date: point.date,
    count: point.count,
    x: index * slot,
    width: slot,
  }));

  // 刻度按「放得下几个」等距取，首日一定有；最后一个不满一档就不补，免得和倒数第二个挤在一起
  const stride = Math.max(1, Math.ceil(points.length / maxTicks));
  /**
   * 首尾刻度往内收一点。
   *
   * 刻度是 `text-anchor: middle` 的，第一根落在 `slot / 2`——7 天时只有 7px，
   * 「7/27」整块会伸出绘图区被裁掉一半，图上只剩「/27」。收进半个字宽就正常了。
   */
  const tickInset = 16;
  const ticks: { x: number; label: string }[] = [];
  for (let index = 0; index < points.length; index += stride) {
    const date = points[index].date;
    const center = index * slot + slot / 2;
    ticks.push({
      x: Math.min(Math.max(center, tickInset), Math.max(tickInset, width - tickInset)),
      label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`,
    });
  }

  return { bars, slots, ticks, maxCount, stubHeight: dailyBarStubHeight, slot, barWidth };
}

/** 柱状图的键盘光标：一天一格，比 7×N 网格简单，序号就是日期顺序。 */
export function moveDailyBarCursor(current: number, key: HeatmapArrowKey, total: number): number | null {
  if (total <= 0) return null;
  const last = total - 1;
  const step = key === 'ArrowLeft' ? -1
    : key === 'ArrowRight' ? 1
      : key === 'ArrowUp' ? -7
        : key === 'ArrowDown' ? 7
          : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  const next = current + step;
  // 撞到边界就停住，和网格那边一致：不弹回，也不绕回去
  if (next < 0 || next > last) return null;
  return next;
}

/**
 * 窗口内有提交的仓库数。
 *
 * 判据是「最近一次提交的日期 ≥ 窗口起点」：只要窗口里有提交，最后一次提交
 * 一定落在窗口内；反过来，最后提交早于窗口起点的仓库，窗口里一次都没有。
 *
 * 之所以不直接用服务端的 `summary.activeRepos`（那是全部历史里有提交的仓库），
 * 是因为这张卡和旁边三张并排，另三张都只算所选时间段——同一个数字旁边并排放着
 * 两种时间范围，读者只会得出一个错误结论。
 */
export function countRepositoriesActiveSince(
  repositories: { lastCommitDate: string | null }[],
  start: string,
): number {
  if (!start) return 0;
  // 同格式的 ISO 日期串可以直接比较，不需要建 Date
  return repositories.filter((repo) => repo.lastCommitDate !== null && repo.lastCommitDate >= start).length;
}

/**
 * 热力图键盘光标：列（第几周）与行（周一 = 0）。
 *
 * 735 个格子（近两年）不可能每个都进 Tab 序列——那比只能用鼠标更糟。
 * 所以整张图只留一个 Tab 站点，进入之后用方向键在网格里走。
 */
export interface HeatmapCursor {
  week: number;
  day: number;
}

export type HeatmapArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * 方向键在 7×N 网格里移动光标。
 *
 * 语义按**视觉矩阵**来，不按日历线性顺序：左右换一列（周），上下换一行（星期），
 * 到边界就停住。这样「上」永远是紧邻上一行，不会把周一的上一格解释成上周日——
 * 视觉上那两格离得最远。
 *
 * 返回 `null` 表示这一下不该动：撞到边界，或落点是这张图根本没画的格子
 * （`inWindow` 之外，或今天之后的未来日期；模板里只画 `isHeatmapDayDrawn` 为真的格）。
 * 调用方据此决定要不要 `preventDefault`——不拦截的话，方向键会顺带把页面滚走。
 */
export function moveHeatmapCursor(
  cursor: HeatmapCursor,
  key: HeatmapArrowKey,
  weeks: HeatmapDay[][],
): HeatmapCursor | null {
  const lastWeek = weeks.length - 1;
  if (lastWeek < 0) return null;

  const next = { ...cursor };
  if (key === 'ArrowLeft') next.week -= 1;
  else if (key === 'ArrowRight') next.week += 1;
  else if (key === 'ArrowUp') next.day -= 1;
  else if (key === 'ArrowDown') next.day += 1;
  else if (key === 'Home') next.week = 0;
  else next.week = lastWeek;

  if (next.week < 0 || next.week > lastWeek || next.day < 0 || next.day > 6) return null;
  if (isHeatmapDayDrawn(weeks[next.week]?.[next.day])) return next;

  // Home / End 的落点可能是本周还没到的那几天（周日按 End 更常见）。
  // 这一列里往前再找一个已经发生的日子；找不到就老实不动。
  if (key === 'Home' || key === 'End') {
    for (let day = 6; day >= 0; day -= 1) {
      if (isHeatmapDayDrawn(weeks[next.week]?.[day])) return { week: next.week, day };
    }
  }
  return null;
}

/** 进入网格时的初始光标：最后一个已经发生的日子（通常是今天，或本周最近一天）。 */
export function initialHeatmapCursor(weeks: HeatmapDay[][]): HeatmapCursor | null {
  for (let week = weeks.length - 1; week >= 0; week -= 1) {
    for (let day = 6; day >= 0; day -= 1) {
      if (isHeatmapDayDrawn(weeks[week]?.[day])) return { week, day };
    }
  }
  return null;
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
