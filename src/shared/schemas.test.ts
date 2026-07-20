import { describe, expect, it } from 'vitest';
import { autoCommitRequestSchema, batchRequestSchema, commitRequestSchema, profileConfigSchema, repositoryConfigSchema } from './schemas.js';

describe('profileConfigSchema', () => {
  it('migrates existing profiles with browser notifications disabled', () => {
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

    expect(profile.profile.notificationsEnabled).toBe(false);
    expect(profile.profile.autoFetchIntervalMinutes).toBe(0);
    expect(profile.profile.viewPreferences).toEqual({
      repositorySort: 'activity',
      repositoryFilter: 'all',
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
