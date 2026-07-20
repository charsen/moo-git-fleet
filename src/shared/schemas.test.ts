import { describe, expect, it } from 'vitest';
import { profileConfigSchema, repositoryConfigSchema } from './schemas.js';

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
