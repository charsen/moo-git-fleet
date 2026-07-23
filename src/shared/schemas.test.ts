import { describe, expect, it } from 'vitest';
import {
  addRootSchema,
  autoCommitRequestSchema,
  batchRequestSchema,
  commitRequestSchema,
  commitSuggestionRequestSchema,
  profileConfigSchema,
  profileViewPreferencesSchema,
  repositoryConfigSchema,
  switchBranchSchema,
} from './schemas.js';

describe('addRootSchema', () => {
  it('accepts a directory path without exposing an internal id field', () => {
    expect(addRootSchema.parse({ path: '/Users/Developer/Projects/研发项目' })).toEqual({
      path: '/Users/Developer/Projects/研发项目',
    });
    expect(addRootSchema.parse({ id: 'legacy-root', path: '/Volumes/Code' })).toEqual({
      id: 'legacy-root',
      path: '/Volumes/Code',
    });
  });
});

describe('profileConfigSchema', () => {
  it('fills current defaults when parsing a legacy profile', () => {
    const profile = profileConfigSchema.parse({
      version: 1,
      profile: {
        displayName: 'Developer',
        avatar: null,
        locale: 'zh-CN',
        theme: 'moon',
        preferredCommitLanguage: 'zh-CN',
        aiCommitMode: 'review',
      },
      gitIdentity: { source: 'git-config' },
    });

    expect(profile.profile.autoFetchIntervalMinutes).toBe(0);
    expect(profile.profile.viewPreferences).toEqual({
      repositorySort: 'activity',
      repositoryFilter: 'all',
      repositoryGroup: null,
      batchScope: 'visible',
    });
  });

  it('accepts the persisted today filter', () => {
    expect(profileViewPreferencesSchema.parse({ repositoryFilter: 'today' })).toEqual({
      repositorySort: 'activity',
      repositoryFilter: 'today',
      repositoryGroup: null,
      batchScope: 'visible',
    });
  });

});

describe('repositoryConfigSchema', () => {
  it('migrates existing repositories to redacted patch AI input', () => {
    const repository = repositoryConfigSchema.parse({
      id: 'legacy-repository',
      name: 'Legacy Repository',
      root: 'dev',
      path: 'legacy-repository',
      group: 'Legacy',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    });

    expect(repository.aiCommitPolicy).toBe('redacted-patch');
  });
});

describe('commit request schemas', () => {
  it('keeps post-commit Push disabled unless the browser explicitly requests it', () => {
    const fingerprint = 'a'.repeat(64);
    expect(commitRequestSchema.parse({ message: 'feat: test', fingerprint }).pushAfterCommit).toBe(false);
    expect(commitSuggestionRequestSchema.parse({ fingerprint })).toEqual({ fingerprint });
    expect(autoCommitRequestSchema.parse({ fingerprint }).pushAfterCommit).toBe(false);
    expect(commitRequestSchema.parse({ message: 'feat: test', fingerprint, pushAfterCommit: true }).pushAfterCommit).toBe(true);
  });
});

describe('batchRequestSchema', () => {
  it('supports an explicit repository scope while preserving all-repository compatibility', () => {
    expect(batchRequestSchema.parse({ type: 'fetch' })).toEqual({ type: 'fetch' });
    expect(batchRequestSchema.parse({ type: 'pull', repositoryIds: ['repository-1', 'repository-2'] })).toEqual({
      type: 'pull',
      repositoryIds: ['repository-1', 'repository-2'],
    });
    expect(() => batchRequestSchema.parse({ type: 'push', repositoryIds: [] })).toThrow();
  });
});

describe('switchBranchSchema', () => {
  it('supports attached and detached expected states with exact Git object IDs', () => {
    const expectedHead = 'a'.repeat(40);
    expect(switchBranchSchema.parse({ branch: 'feature/example', expectedBranch: 'master', expectedHead })).toEqual({
      branch: 'feature/example',
      expectedBranch: 'master',
      expectedHead,
    });
    expect(switchBranchSchema.parse({ branch: 'master', expectedBranch: null, expectedHead })).toMatchObject({
      expectedBranch: null,
    });
    expect(() => switchBranchSchema.parse({ branch: '', expectedBranch: 'master', expectedHead })).toThrow();
    expect(() => switchBranchSchema.parse({ branch: 'main', expectedBranch: 'master', expectedHead: 'a'.repeat(41) })).toThrow();
  });
});
