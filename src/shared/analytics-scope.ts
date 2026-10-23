import type { AnalyticsRepositoryScope } from './contracts.js';

export function isAnalyticsRepositoryScope(value: unknown): value is AnalyticsRepositoryScope {
  return value === null || (Array.isArray(value) && value.length <= 10_000
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 120));
}

/** null 表示全部仓库；空数组明确表示未选仓库，不能回落为全部。 */
export function normalizeAnalyticsRepositoryScope(scope: AnalyticsRepositoryScope): AnalyticsRepositoryScope {
  return scope === null ? null : [...new Set(scope)].sort();
}

export function sameAnalyticsRepositoryScope(left: AnalyticsRepositoryScope, right: AnalyticsRepositoryScope): boolean {
  return JSON.stringify(normalizeAnalyticsRepositoryScope(left)) === JSON.stringify(normalizeAnalyticsRepositoryScope(right));
}

/** 本机旧值或损坏的存储回落到默认；合法的空选择保留。 */
export function readStoredAnalyticsRepositoryScope(raw: string | null): AnalyticsRepositoryScope {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (isAnalyticsRepositoryScope(value)) return normalizeAnalyticsRepositoryScope(value);
  } catch { /* 不可用的本机存储使用默认范围。 */ }
  return null;
}
