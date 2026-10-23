/**
 * 工时口径的唯一来源。
 *
 * 服务端按这套常量切工作段、算非上班时长，客户端按同一份常量生成文案。
 * 两边各写一遍的话，改了一处忘另一处，界面就会理直气壮地写着已经不对的时间——
 * 「工作日 08:30–12:00、13:30–18:00 之外」这句话，必须和真正参与计算的那几个数
 * 是同一个出处。
 *
 * 单位统一用**分钟**，时间点用「当天第几分钟」（00:00 = 0，08:30 = 510）。
 *
 * ## 为什么必须把午休单独列出来
 *
 * 上班时段 08:30–18:00 是 570 分钟 = 9.5 小时，但折算工时的分母是 480 分钟
 * = 8 小时。这两个数在旧版里同时存在且没有午休这一项，于是「一个人 08:30 到
 * 18:00 一直在提交」会被算成 570 分钟投入 = 1.19 个工作日——先不说加不加班，
 * 他连正常上班都还没干满一天。
 *
 * 把午休 12:00–13:30 显式剥出来后：
 *
 *     08:30–12:00 = 210 分钟
 *     13:30–18:00 = 270 分钟
 *     合计         = 480 分钟 = 1 个工作日
 *
 * 窗口自己就能验算分母，不需要再拿一个说不清来源的 480 去凑。`MINUTES_PER_WORKDAY`
 * 仍然保留为常量，但 `normalMinutesPerWorkday()` 会算一遍这两段之和，两者不一致
 * 时由单测直接报错。
 */

/** 工作日上班时间 08:30。 */
export const WORKDAY_START_MINUTE = 8 * 60 + 30;

/** 工作日午休开始 12:00。 */
export const LUNCH_START_MINUTE = 12 * 60;

/** 工作日午休结束 13:30。 */
export const LUNCH_END_MINUTE = 13 * 60 + 30;

/** 工作日下班时间 18:00。 */
export const WORKDAY_END_MINUTE = 18 * 60;

/** 相邻两次提交间隔不超过这么久，就算同一个连续工作段。 */
export const SEGMENT_GAP_MINUTES = 90;

/**
 * 每个工作段开工前补的准备时间。
 *
 * 只补在「重新开工」的段首（见 `RESTART_GAP_MINUTES`）：一天里被午休、开会切开的
 * 那几段，人并没有离开工位，不该每段都重新补一次。
 */
export const SEGMENT_CONTEXT_MINUTES = 30;

/**
 * 距上一段结束超过这么久，才认为中间真的离开过，需要补一次准备时间。
 *
 * 比 `SEGMENT_GAP_MINUTES` 宽，是因为这两个数回答的是不同问题：
 * 90 分钟决定「这两次提交是不是连着干的」，180 分钟决定「中间是不是走开过」。
 * 一段 100 分钟的空隙既断开了工作段，又不至于让人重新开环境——补 30 分钟
 * 准备时间是凭空造时间。
 */
export const RESTART_GAP_MINUTES = 180;

/** 折合工时的分母：一个工作日 8 小时。 */
export const MINUTES_PER_WORKDAY = 8 * 60;

/** `510` → `08:30`。越界值按 24 小时取模，不抛错（调用方都是常量）。 */
export function formatMinuteOfDay(minute: number): string {
  const normalized = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const rest = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * 工作日一天里「正常上班」的净分钟数 = 上午 + 下午两段。
 *
 * 存在的意义是让「分母 480」这件事可验算：这个函数和 `MINUTES_PER_WORKDAY`
 * 必须相等，否则窗口和分母又各说各话了。
 */
export function normalMinutesPerWorkday(): number {
  return (LUNCH_START_MINUTE - WORKDAY_START_MINUTE) + (WORKDAY_END_MINUTE - LUNCH_END_MINUTE);
}

/** `08:30–12:00、13:30–18:00`，界面文案用。 */
export function formatWorkdayWindow(): string {
  return (
    `${formatMinuteOfDay(WORKDAY_START_MINUTE)}–${formatMinuteOfDay(LUNCH_START_MINUTE)}` +
    `、${formatMinuteOfDay(LUNCH_END_MINUTE)}–${formatMinuteOfDay(WORKDAY_END_MINUTE)}`
  );
}
