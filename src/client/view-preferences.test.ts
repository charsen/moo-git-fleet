import { describe, expect, it } from 'vitest';
import { defaultViewPreferences, parseViewPreferences } from './view-preferences.js';

describe('view preference cache parsing', () => {
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
});
