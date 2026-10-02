import { describe, expect, it } from 'vitest';
import {
  addRootSchema,
  autoCommitRequestSchema,
  batchRequestSchema,
  commitRequestSchema,
  commitPageQuerySchema,
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
  it('validates optional appearance settings without changing legacy profile defaults', () => {
    expect(profileViewPreferencesSchema.parse({ interfaceFont: 'system', interfaceFontSize: 16 })).toMatchObject({ interfaceFont: 'system', interfaceFontSize: 16 });
    expect(() => profileViewPreferencesSchema.parse({ interfaceFont: 'url(example)' })).toThrow();
    expect(() => profileViewPreferencesSchema.parse({ interfaceFontSize: 11 })).toThrow();
    expect(() => profileViewPreferencesSchema.parse({ interfaceFontSize: 17 })).toThrow();
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


describe('branch commit page query', () => {
  it('accepts full branch references and validates pagination anchors', () => {
    expect(commitPageQuerySchema.parse({ ref: 'refs/remotes/origin/dev', tip: 'a'.repeat(40) })).toMatchObject({ limit: 20, skip: 0, ref: 'refs/remotes/origin/dev' });
    expect(commitPageQuerySchema.safeParse({ ref: '--all' }).success).toBe(false);
    expect(commitPageQuerySchema.safeParse({ ref: 'dev' }).success).toBe(false);
    expect(commitPageQuerySchema.safeParse({ tip: 'HEAD~1' }).success).toBe(false);
  });
  it('accepts outgoing scope with pinned upstream OIDs and rejects revision expressions', () => {
    expect(commitPageQuerySchema.parse({ scope: 'outgoing', ref: 'refs/heads/main', tip: 'a'.repeat(40), excludeTip: 'b'.repeat(40) })).toMatchObject({ scope: 'outgoing', excludeTip: 'b'.repeat(40) });
    expect(commitPageQuerySchema.safeParse({ excludeTip: 'HEAD~1' }).success).toBe(false);
  });
  it('validates all-history, search and literal single-file paths', () => {
    expect(commitPageQuerySchema.parse({ scope: 'all', search: ' body ', searchField: 'message' })).toMatchObject({ scope: 'all', search: 'body' });
    expect(commitPageQuerySchema.parse({ filePath: '中文\nname\t[x].txt' })).toMatchObject({ filePath: '中文\nname\t[x].txt' });
    for (const filePath of ['../secret', '/absolute', 'a/../b', 'a\0b', 'C:/outside']) expect(commitPageQuerySchema.safeParse({ filePath }).success).toBe(false);
    expect(commitPageQuerySchema.safeParse({ searchField: 'unsupported' }).success).toBe(false);
    expect(commitPageQuerySchema.safeParse({ search: 'a\0b' }).success).toBe(false);
    expect(commitPageQuerySchema.safeParse({ snapshot: 'HEAD~1' }).success).toBe(false);
  });
});
