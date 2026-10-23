import { describe, expect, it } from 'vitest';
import { readStoredAnalyticsRepositoryScope, sameAnalyticsRepositoryScope } from './analytics-scope.js';
import { analyticsQuerySchema } from './schemas.js';

describe('analytics repository scope', () => {
  it('保留全部与空选择的区别，并忽略勾选顺序和重复 ID', () => {
    expect(readStoredAnalyticsRepositoryScope(null)).toBeNull();
    expect(readStoredAnalyticsRepositoryScope('[]')).toEqual([]);
    expect(readStoredAnalyticsRepositoryScope('["beta","alpha","beta"]')).toEqual(['alpha', 'beta']);
    expect(sameAnalyticsRepositoryScope(['beta', 'alpha'], ['alpha', 'beta', 'alpha'])).toBe(true);
    expect(sameAnalyticsRepositoryScope([], null)).toBe(false);
  });

  it('损坏的本机设置回到默认，合法空选择不会变成全部', () => {
    for (const raw of ['oops', '{}', '[12]', '[""]']) expect(readStoredAnalyticsRepositoryScope(raw)).toBeNull();
    expect(readStoredAnalyticsRepositoryScope('[]')).toEqual([]);
  });

  it('接口能无损传递带标点的 ID，并拒绝非法范围而不扩大到全部', () => {
    expect(analyticsQuerySchema.parse({ weeks: '26', repositoryIds: '["repo,beta","repo&alpha","repo,beta"]' }))
      .toEqual({ weeks: '26', repositoryIds: ['repo&alpha', 'repo,beta'] });
    expect(analyticsQuerySchema.parse({ repositoryIds: '[]' }).repositoryIds).toEqual([]);
    expect(analyticsQuerySchema.parse({}).repositoryIds).toBeUndefined();
    for (const value of ['oops', '{}', '[1]', '[""]']) {
      expect(analyticsQuerySchema.safeParse({ repositoryIds: value }).success).toBe(false);
    }
  });
});
