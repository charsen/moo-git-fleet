/**
 * 非上班时间卡片的展示换算。
 *
 * 从组件里抽出来的原因和 `heatmap-grid.ts` 一样：这里是「数字怎么变成字」的地方，
 * 纯函数才测得了。尤其是那条构成条——四段宽度之和必须落在 100%，四舍五入的
 * 误差要是留在最后一段，条尾就会空出一小截或者溢出到卡片外面。
 */
import type { CommitOvertimeSummary } from '../shared/contracts';

/** 分钟 → 小时，一位小数并带千分位（`824.6` / `1,751.7`）。 */
export function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return hours.toLocaleString('zh-CN', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** 折合工作日，一位小数。服务端给的是两位，展示再收一档。 */
export function formatWorkdays(days: number): string {
  return days.toFixed(1);
}

/**
 * 这个时长在屏幕上是不是「0.0」。
 *
 * 零值灰化必须跟着**显示出来的字**走，不能跟原始分钟数走：午休里 2 分钟的提交
 * 会被渲染成 `0.0`，按 `minutes === 0` 判断的话，屏幕上明明写着 0.0 却没有灰掉，
 * 旁边那个真 0 又是灰的——同一个位置上两种样式，谁也说不清哪个才算零。
 */
export function isZeroHours(minutes: number): boolean {
  return formatHours(minutes) === '0.0';
}

/** 卡片上的一段「非上班时间构成」。 */
export interface OvertimePart {
  key: 'evening' | 'weekend' | 'early' | 'lunch';
  label: string;
  minutes: number;
  /** 占非上班总时长的百分比；总时长为 0 时全为 0 */
  share: number;
  /** 归一化后的不透明度，用来在不换色相的前提下区分主次 */
  opacity: number;
}

/**
 * 固定顺序：晚间 → 周末 → 早间 → 午休。顺序不随数据变，跨月对比时位置才是稳定的。
 *
 * 午休放最后，是因为它只在「午休里真的提交过」时才有值，常态是 0；
 * 排在前面会让一根常态为零的图例占住视线。
 */
const partOrder: { key: OvertimePart['key']; label: string; pick: (value: CommitOvertimeSummary) => number }[] = [
  { key: 'evening', label: '工作日晚间', pick: (value) => value.eveningMinutes },
  { key: 'weekend', label: '周末', pick: (value) => value.weekendMinutes },
  { key: 'early', label: '工作日早间', pick: (value) => value.earlyMinutes },
  { key: 'lunch', label: '工作日午休', pick: (value) => value.lunchMinutes },
];

const opacityByRank = [1, 0.72, 0.5, 0.32];

/**
 * 把四段换算成宽度与透明度。
 *
 * 分母用四段自己的和，不用 `offHoursMinutes`：后者是服务端算好的汇总，
 * 万一哪天它和明细对不上（漏加一段、口径改了没同步），条形就会整体缩放，
 * 而图例还是原值——屏幕上两个数各说各话。段落宽度只信任段落自己。
 */
export function overtimeParts(overtime: CommitOvertimeSummary): OvertimePart[] {
  const parts = partOrder.map((entry) => ({
    key: entry.key,
    label: entry.label,
    minutes: entry.pick(overtime),
  }));
  const total = parts.reduce((sum, part) => sum + part.minutes, 0);

  // 谁是最大的那段，谁就用最实的底色——不排序，只借不透明度表达主次
  const ranked = [...parts].sort((left, right) => right.minutes - left.minutes);
  const opacityOf = new Map(ranked.map((part, rank) => [part.key, opacityByRank[rank] ?? 0.3]));

  return parts.map((part) => ({
    ...part,
    share: total > 0 ? (part.minutes / total) * 100 : 0,
    opacity: opacityOf.get(part.key) ?? 0.3,
  }));
}
