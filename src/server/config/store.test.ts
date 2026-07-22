import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectDefaultRoots, migrateProfileDefaults } from './store.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('detectDefaultRoots', () => {
  it('does not seed a developer-specific path when it is unavailable', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-missing-root-'));
    expect(detectDefaultRoots(path.join(parent, 'not-created'))).toEqual({});
  });

  it('keeps an available default root for existing development installs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-default-root-'));
    expect(detectDefaultRoots(root)).toEqual({ dev: root });
  });
});

describe('profile default migrations', () => {
  it('moves the legacy name default to activity only once', () => {
    const legacy = {
      version: 1 as const,
      profile: {
        displayName: 'Developer',
        avatar: null,
        locale: 'zh-CN' as const,
        theme: 'moon' as const,
        preferredCommitLanguage: 'zh-CN' as const,
        aiCommitMode: 'review' as const,
        autoFetchIntervalMinutes: 0 as const,
        viewPreferences: {
          repositorySort: 'name' as const,
          repositoryFilter: 'all' as const,
          repositoryGroup: null,
          batchScope: 'visible' as const,
        },
      },
      gitIdentity: { source: 'git-config' as const },
      migrations: { activitySortDefault: false },
    };

    const migrated = migrateProfileDefaults(legacy);
    expect(migrated.profile.viewPreferences.repositorySort).toBe('activity');
    expect(migrated.migrations.activitySortDefault).toBe(true);
    expect(migrateProfileDefaults({
      ...migrated,
      profile: {
        ...migrated.profile,
        viewPreferences: { ...migrated.profile.viewPreferences, repositorySort: 'name' },
      },
    }).profile.viewPreferences.repositorySort).toBe('name');
  });
});

describe('config update transactions', () => {
  it('preserves concurrent profile changes instead of overwriting a stale snapshot', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-profile-transaction-'));
    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.resetModules();
    const { loadProfile, updateProfile } = await import('./store.js');

    await Promise.all([
      updateProfile(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ...current, profile: { ...current.profile, displayName: 'Fleet User' } };
      }),
      updateProfile((current) => ({
        ...current,
        profile: { ...current.profile, locale: 'en-US' },
      })),
    ]);

    const profile = await loadProfile();
    expect(profile.profile.displayName).toBe('Fleet User');
    expect(profile.profile.locale).toBe('en-US');
  });

  it('preserves concurrent repository config changes and continues after a failed update', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-repositories-transaction-'));
    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.resetModules();
    const { loadRepositories, updateRepositories } = await import('./store.js');

    await Promise.all([
      updateRepositories(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        current.settings.roots.first = '/tmp/first';
        return current;
      }),
      updateRepositories((current) => {
        current.settings.roots.second = '/tmp/second';
        return current;
      }),
    ]);
    await expect(
      updateRepositories(() => {
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');
    await updateRepositories((current) => {
      current.settings.roots.third = '/tmp/third';
      return current;
    });

    const config = await loadRepositories();
    expect(config.settings.roots).toMatchObject({
      first: '/tmp/first',
      second: '/tmp/second',
      third: '/tmp/third',
    });
  });
});
