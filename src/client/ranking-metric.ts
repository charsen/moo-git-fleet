/**
 * 排行榜的度量。
 *
 * 提交数说明不了产出：一次依赖升级能刷出几万行 lock，一次提交也可能只改一个错别字。
 * 但提交数也有不可替代的地方——「这个仓库还在不在动」只有它能答。所以给两种，
 * 由用户自己切，而不是替他选一个。
 *
 * 放在页面级而不是每张卡自己一份：两张排行排的是同一批提交，各带一个开关时，
 * 界面上看着能分别设置，实际上绑的是同一个状态——不如就只留一个。
 */

export type RankingMetric = 'commits' | 'volume';

export const defaultRankingMetric: RankingMetric = 'commits';

/** 本机存了旧值或垃圾时回落到默认，不因为一个坏字符串报错。 */
export function normalizeRankingMetric(raw: unknown): RankingMetric {
  return raw === 'volume' ? 'volume' : defaultRankingMetric;
}
