/**
 * 工时口径的唯一来源。
 *
 * 服务端按这套常量切工作段、算非上班时长，客户端按同一份常量生成文案。
 * 两边各写一遍的话，改了一处忘另一处，界面就会理直气壮地写着已经不对的时间——
 * 「工作日 08:30–18:00 之外」这句话，必须和真正参与计算的那几个数是同一个出处。
 *
 * 单位统一用**分钟**，时间点用「当天第几分钟」（00:00 = 0，08:30 = 510）。
 */

/** 工作日上班时间 08:30。 */
export const WORKDAY_START_MINUTE = 8 * 60 + 30;

/** 工作日下班时间 18:00。 */
export const WORKDAY_END_MINUTE = 18 * 60;

/** 相邻两次提交间隔不超过这么久，就算同一个连续工作段。 */
export const SEGMENT_GAP_MINUTES = 90;

/** 每个工作段开工前补的准备时间。 */
export const SEGMENT_CONTEXT_MINUTES = 30;

/** 折合工时的分母：一个工作日 8 小时。 */
export const MINUTES_PER_WORKDAY = 8 * 60;

/** `510` → `08:30`。越界值按 24 小时取模，不抛错（调用方都是常量）。 */
export function formatMinuteOfDay(minute: number): string {
  const normalized = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const rest = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** `08:30–18:00`，界面文案用。 */
export function formatWorkdayWindow(): string {
  return `${formatMinuteOfDay(WORKDAY_START_MINUTE)}–${formatMinuteOfDay(WORKDAY_END_MINUTE)}`;
}
