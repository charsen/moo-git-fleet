/**
 * 代码量卡片的展示换算。
 *
 * 和服务端 `code-volume.ts` 分工：那边算「哪些行算人工产出」，这边只管
 * 「几十万行的数字怎么写进一个卡片」。抽成纯函数是因为这里有三个容易错的点——
 * 万 / 亿的单位切换、零值、以及两段构成条的比例。
 */
import type { CommitCodeVolumeSummary } from '../shared/contracts';

/**
 * 行数的紧凑写法。
 *
 * 五位以上的数字直接铺开会把整张卡片顶宽（真实数据单仓库就能到百万行），
 * 所以过万用「万」、过亿用「亿」，各留一位小数；一位小数正好是 .0 时省掉。
 */
export function formatLines(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';

  const trim = (text: string): string => (text.endsWith('.0') ? text.slice(0, -2) : text);

  if (value >= 100_000_000) return `${trim((value / 100_000_000).toFixed(1))} 亿`;
  if (value >= 10_000) return `${trim((value / 10_000).toFixed(1))} 万`;
  return value.toLocaleString('en-US');
}

/** 增删行合计，也就是卡片上的大数字。 */
export function totalLines(volume: CommitCodeVolumeSummary): number {
  return volume.additions + volume.deletions;
}

export interface VolumePart {
  key: 'additions' | 'deletions';
  label: string;
  lines: number;
  /** 占「增 + 删」的百分比；总量为 0 时全为 0 */
  share: number;
}

const volumePartOrder: { key: VolumePart['key']; label: string }[] = [
  { key: 'additions', label: '新增' },
  { key: 'deletions', label: '删除' },
];

/** 两段构成条：新增在前（绿）、删除在后（红），顺序固定，跨月对比时位置才稳定。 */
export function volumeParts(volume: CommitCodeVolumeSummary): VolumePart[] {
  const parts = volumePartOrder.map((entry) => ({
    key: entry.key,
    label: entry.label,
    lines: entry.key === 'additions' ? volume.additions : volume.deletions,
  }));
  // 分母用两段自己的和，不用服务端的任何汇总字段：万一哪天对不上，
  // 条形会整体缩放而图例还是原值，屏幕上两个数各说各话
  const total = parts.reduce((sum, part) => sum + part.lines, 0);

  return parts.map((part) => ({
    ...part,
    share: total > 0 ? (part.lines / total) * 100 : 0,
  }));
}

/** 「+120.1 万 / −57.3 万」这种副标题。只要求两个数，仓库 / 作者行也能直接用。 */
export function volumeBreakdown(volume: { additions: number; deletions: number }): string {
  return `+${formatLines(volume.additions)} / −${formatLines(volume.deletions)}`;
}
