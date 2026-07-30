/**
 * 「几分钟前」的统一实现。
 *
 * 之前仓库工作台和 AI 会话页各写了一份，其中一份遇到无法解析的时间会显示 “NaN 秒前”。
 * 这里统一实现并修掉那个问题；两处原本就不同的地方（空值占位、超过 30 天的写法）
 * 用参数保留，不顺手改动各自页面已有的显示。
 */
export interface RelativeTimeOptions {
  /** 没有时间可显示时的占位，比如列表里的 `—`。 */
  empty?: string;
  /**
   * 超过 30 天怎么显示：`days` 继续数天数（仓库列表看新鲜度更直观），
   * `date` 换成具体日期（会话列表里更好认）。默认 `days`，与各自原有行为一致。
   */
  longAgo?: 'days' | 'date';
  /** 便于测试固定“现在”。 */
  now?: number;
}

export function relativeTime(value: string | null | undefined, options: RelativeTimeOptions = {}): string {
  const empty = options.empty ?? '时间未知';
  if (!value) return empty;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return empty;

  const seconds = Math.max(0, Math.round(((options.now ?? Date.now()) - timestamp) / 1_000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30 || (options.longAgo ?? 'days') === 'days') return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}
