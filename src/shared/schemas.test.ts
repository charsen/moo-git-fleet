import { describe, expect, it } from 'vitest';
import { profileConfigSchema } from './schemas.js';

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
