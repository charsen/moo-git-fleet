/**
 * 分析页的统一报告窗口：过去 N 个自然周（默认 52，即近一年），周一为首列，本周为最后一列。
 *
 * 为什么放在 shared 而不是各写一份：服务端要用它给 `git log --since` 划界
 * （代码量不能对全历史跑 numstat），客户端要用它决定画哪几列格子，界面上的
 * 「近一年 / 近 3 个月」也要和服务端实际用的窗口对得上。两边各算一次最容易
 * 差一天，而这一天的偏差会直接让「近一年共 N 次提交」这个数字和格子对不上——
 * 正是上一轮刚修掉的那类毛病。窗口和预设只在这里定义一次。
 */

/** 热力图默认展示 52 列（一年）。 */
export const heatmapWeekCount = 52;

/**
 * 分析页可选的时间段。
 *
 * 单位是「周」而不是「天」：热力图是按整周分列的，给 30 天只会让第一列缺半格，
 * 而「近一个月」和「近 4 周」在读者眼里没有区别。52 周按 7 天算正好 364 天。
 */
export interface AnalyticsRangeOption {
  weeks: number;
  label: string;
}

export const analyticsRangeOptions: readonly AnalyticsRangeOption[] = [
  { weeks: 13, label: '近 3 个月' },
  { weeks: 26, label: '近 6 个月' },
  { weeks: 52, label: '近一年' },
  { weeks: 104, label: '近两年' },
];

/** 默认「近一年」，和原来写死的 52 周是同一个值——老用户看到的还是同一张图。 */
export const defaultAnalyticsWeeks = heatmapWeekCount;

/**
 * 上限 5 年。
 *
 * 不是技术限制（多长的窗口都算得出来），是排版限制：热力图一列 15px，
 * 5 年 260 列已经是 3900px，再长就只能在水平滚动条上拖了。真要更长的历史，
 * 该换一种图形，而不是把周格子继续拉长。
 */
export const maxAnalyticsWeeks = 260;

/**
 * 把外部输入（查询参数 / localStorage）收敛成一个合法周数。
 *
 * 一律**回落到默认值**而不是报错：这是只读的统计接口，参数写错时给一张
 * 「近一年」的图，比给一个 400 更符合调用方的预期（界面上也不会因此白屏）。
 */
export function normalizeAnalyticsWeeks(value: unknown): number {
  const weeks =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > maxAnalyticsWeeks) return defaultAnalyticsWeeks;
  return weeks;
}

/** 预设标签；不在预设里的周数自己拼一个。 */
export function analyticsRangeLabel(weeks: number): string {
  return analyticsRangeOptions.find((option) => option.weeks === weeks)?.label ?? `近 ${weeks} 周`;
}

/**
 * 本地日期 → 自 1970-01-01 起的天数。
 *
 * 和 `overtime.ts` 里的 `dayIndexOf(墙钟分钟)` 是同一套坐标（都按 UTC 天算），
 * 非上班时长才能用同一个窗口起点去筛。
 */
export function dayIndexFromIso(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
}

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

/** 日期串加减天数，返回同样格式的本地日期串。 */
export function shiftIsoDays(date: string, days: number): string {
  const shifted = localDateFromIso(date);
  shifted.setDate(shifted.getDate() + days);
  return localIsoDate(shifted);
}

/**
 * 分析页所选的时间段：四个预设之一，或用户自选的起止日期。
 *
 * 自定义范围**精确到天**，不再对齐到整周。之前只有预设时窗口天然是整周，
 * 「周数」就够用了；一旦能选 10-01 ~ 10-15，再多算三天就不是用户要的口径。
 * 热力图仍然按整周画列（行必须对应星期），窗口外的格子标成 `inWindow: false`
 * 不绘制也不计数——图好看和数字准确是两件事，不能让前者改后者。
 */
export type AnalyticsRange =
  | { kind: 'preset'; weeks: number }
  | { kind: 'custom'; start: string; end: string };

export const defaultAnalyticsRange: AnalyticsRange = { kind: 'preset', weeks: defaultAnalyticsWeeks };

/** 自定义范围最长 5 年，和 `maxAnalyticsWeeks` 同一个理由：再长热力图只能拖着看。 */
export const maxAnalyticsRangeDays = maxAnalyticsWeeks * 7;

/** 格式对但日子不存在（`2026-02-31`）也要挡掉，否则会静默少算好几天。 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return localIsoDate(localDateFromIso(value)) === value;
}

/** 解析后的窗口：起止日期是唯一的真相，`weeks` 只在预设时存在。 */
export interface ResolvedAnalyticsRange {
  kind: 'preset' | 'custom';
  /** 预设的周数；自定义范围为 null */
  weeks: number | null;
  start: string;
  end: string;
  /** 卡头与工具栏用的短标签 */
  label: string;
  /** 含首尾的天数 */
  days: number;
}

/**
 * 把外部输入收敛成一个可用窗口。
 *
 * 顺序是「先看 start/end，不成立再看 weeks」，两种情况都非法时回落到默认预设——
 * 和 `normalizeAnalyticsWeeks` 同一套策略：只读统计接口宁可给一张近一年的图，
 * 也不要因为参数写错就白屏。回落时界面靠 `rangeAdjusted` 明确告知实际范围。
 */
export function resolveAnalyticsRange(
  input: { weeks?: unknown; start?: unknown; end?: unknown },
  today: Date = new Date(),
): ResolvedAnalyticsRange {
  const { start, end } = input;
  if (isIsoDate(start) && isIsoDate(end)) {
    // 两个框填反了也认：算「早的那天 → 晚的那天」，比让用户自己找哪个填错有用
    const from = start <= end ? start : end;
    const to = start <= end ? end : start;
    const days = dayIndexFromIso(to) - dayIndexFromIso(from) + 1;
    if (days >= 1 && days <= maxAnalyticsRangeDays) {
      return { kind: 'custom', weeks: null, start: from, end: to, label: `自定义 ${days} 天`, days };
    }
  }

  const weeks = normalizeAnalyticsWeeks(input.weeks ?? defaultAnalyticsWeeks);
  const window = reportWindow(today, weeks);
  return { kind: 'preset', weeks, start: window.start, end: window.end, label: analyticsRangeLabel(weeks), days: weeks * 7 };
}

/** 查询键 / 缓存键：预设用周数，自定义用起止日期，两者不会撞。 */
export function analyticsRangeKey(range: AnalyticsRange): string {
  return range.kind === 'preset' ? String(range.weeks) : `${range.start}~${range.end}`;
}

export function sameAnalyticsRange(left: AnalyticsRange, right: AnalyticsRange): boolean {
  return analyticsRangeKey(left) === analyticsRangeKey(right);
}

/**
 * 手上这份数据的窗口，是不是就是所选的那个。
 *
 * 「正在切换」靠它判断：预设比周数，自定义比起止日期。只比其中一个会把
 * 「近一年 → 自选 364 天」误判成没变，于是一边显示旧数字一边说已经统计好了。
 */
export function rangeMatchesSelection(
  actual: { kind: 'preset' | 'custom'; weeks: number | null; start: string; end: string },
  selected: AnalyticsRange,
): boolean {
  if (actual.kind !== selected.kind) return false;
  if (selected.kind === 'preset') return actual.weeks === selected.weeks;
  return actual.start === selected.start && actual.end === selected.end;
}

/**
 * 读本机存的时间段，兼容 v1（只存了一个纯数字周数）。
 *
 * 坏值一律回落到默认预设而不是抛错：存的是上一次「看一眼」的视角，
 * 读不出来就给它一个合理的起点，不值得让整页打不开。
 */
export function readStoredAnalyticsRange(raw: string | null): AnalyticsRange {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return defaultAnalyticsRange;
  if (/^\d+$/.test(trimmed)) return { kind: 'preset', weeks: normalizeAnalyticsWeeks(trimmed) };

  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.kind === 'custom' && isIsoDate(record.start) && isIsoDate(record.end)) {
        const days = Math.abs(dayIndexFromIso(record.end) - dayIndexFromIso(record.start)) + 1;
        if (days <= maxAnalyticsRangeDays) return { kind: 'custom', start: record.start, end: record.end };
      }
      return { kind: 'preset', weeks: normalizeAnalyticsWeeks(record.weeks) };
    }
  } catch { /* 坏值走默认 */ }
  return defaultAnalyticsRange;
}

