import { describe, expect, it } from 'vitest';
import { defaultViewPreferences, parseViewPreferences } from './view-preferences.js';

describe('view preference cache parsing', () => {
  it('保留仓库范围的全部与空选择，去重排序并拒绝损坏的 ID', () => {
    expect(parseViewPreferences({ ...defaultViewPreferences, analyticsRepositoryIds: ['beta', 'alpha', 'beta'] }))
      .toMatchObject({ analyticsRepositoryIds: ['alpha', 'beta'] });
    expect(parseViewPreferences({ ...defaultViewPreferences, analyticsRepositoryIds: [] }))
      .toMatchObject({ analyticsRepositoryIds: [] });
    expect(parseViewPreferences({ ...defaultViewPreferences, analyticsRepositoryIds: null }))
      .toMatchObject({ analyticsRepositoryIds: null });
    expect(parseViewPreferences({ ...defaultViewPreferences, analyticsRepositoryIds: [12] })).toBeNull();
    expect(parseViewPreferences(defaultViewPreferences)).not.toHaveProperty('analyticsRepositoryIds');
  });
  it('accepts the supported repository view preferences', () => {
    expect(parseViewPreferences({ repositorySort: 'group', repositoryFilter: 'behind', batchScope: 'all' })).toEqual({
      repositorySort: 'group',
      repositoryFilter: 'behind',
      repositoryGroup: null,
      batchScope: 'all',
    });
    expect(parseViewPreferences({ repositorySort: 'fetch', repositoryFilter: 'stale', batchScope: 'visible' })).toEqual({
      repositorySort: 'fetch',
      repositoryFilter: 'stale',
      repositoryGroup: null,
      batchScope: 'visible',
    });
    expect(parseViewPreferences({ repositorySort: 'activity', repositoryFilter: 'today', batchScope: 'visible' })).toEqual({
      repositorySort: 'activity',
      repositoryFilter: 'today',
      repositoryGroup: null,
      batchScope: 'visible',
    });
    expect(parseViewPreferences({ repositorySort: 'activity', repositoryFilter: 'all', repositoryGroup: '业务包', batchScope: 'visible' })).toEqual({
      repositorySort: 'activity',
      repositoryFilter: 'all',
      repositoryGroup: '业务包',
      batchScope: 'visible',
    });
  });

  it('rejects damaged or obsolete cache values', () => {
    expect(parseViewPreferences(null)).toBeNull();
    expect(parseViewPreferences({ ...defaultViewPreferences, repositorySort: 'random' })).toBeNull();
    expect(parseViewPreferences({ ...defaultViewPreferences, repositoryGroup: '' })).toBeNull();
    expect(parseViewPreferences({ repositorySort: 'activity' })).toBeNull();
  });
  it('keeps appearance preferences and rejects unsupported cache settings', () => {
    const value = { ...defaultViewPreferences, interfaceFont: 'hiragino', interfaceFontSize: 16, codeFont: 'fira-code', codeFontSize: 15 };
    expect(parseViewPreferences(value)).toEqual(value);
    expect(parseViewPreferences({ ...value, interfaceFont: 'unknown' })).toBeNull();
    expect(parseViewPreferences({ ...value, interfaceFontSize: 17 })).toBeNull();
    expect(parseViewPreferences({ ...value, interfaceFontSize: 12.5 })).toBeNull();
    expect(parseViewPreferences({ ...value, codeFont: 'comic-sans' })).toBeNull();
    expect(parseViewPreferences({ ...value, codeFontSize: 17 })).toBeNull();
    expect(parseViewPreferences({ ...value, codeFontSize: 12.5 })).toBeNull();
    // 省略代码字号表示跟随界面字号：结果里不带该字段。
    expect(parseViewPreferences({ ...value, codeFontSize: undefined })).not.toHaveProperty('codeFontSize');
    // 新增的等宽界面字体与代码字体都是合法取值。
    expect(parseViewPreferences({ ...value, interfaceFont: 'cascadia-code' })).toMatchObject({ interfaceFont: 'cascadia-code' });
    expect(parseViewPreferences({ ...value, codeFont: 'source-code-pro' })).toMatchObject({ codeFont: 'source-code-pro' });
  });
  it('keeps the file list view and defaults it to flat', () => {
    expect(defaultViewPreferences.fileListView).toBe('flat');
    expect(parseViewPreferences({ ...defaultViewPreferences, fileListView: 'tree' })).toMatchObject({ fileListView: 'tree' });
    // 省略该字段时结果里也不带，让旧 profile 走默认值。
    expect(parseViewPreferences({ repositorySort: 'activity', repositoryFilter: 'all', batchScope: 'visible' })).not.toHaveProperty('fileListView');
    expect(parseViewPreferences({ ...defaultViewPreferences, fileListView: 'grid' })).toBeNull();
  });
});
