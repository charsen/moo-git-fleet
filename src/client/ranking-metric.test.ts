import { describe, expect, it } from 'vitest';
import { defaultRankingMetric, normalizeRankingMetric } from './ranking-metric';

describe('排行口径', () => {
  it('合法值原样保留', () => {
    expect(normalizeRankingMetric('commits')).toBe('commits');
    expect(normalizeRankingMetric('volume')).toBe('volume');
  });

  it('没存过时按提交数排', () => {
    // 提交数是「这个仓库还在不在动」唯一答得出来的度量，作默认值更不容易误导
    expect(defaultRankingMetric).toBe('commits');
    expect(normalizeRankingMetric(null)).toBe('commits');
  });

  it('坏值回落而不是抛错', () => {
    // 本机存储可能留着旧版本写的字符串，或被人手改坏；读不出来不该让整页挂掉
    for (const raw of ['', 'COMMITS', 'lines', '0', '{}', undefined, 42]) {
      expect(normalizeRankingMetric(raw)).toBe('commits');
    }
  });
});
