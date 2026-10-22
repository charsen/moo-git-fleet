import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion, parseVersion } from './version.js';

describe('parseVersion', () => {
  it('accepts a plain semver and strips the release tag prefix', () => {
    expect(parseVersion('0.1.35')).toEqual([0, 1, 35]);
    expect(parseVersion('v0.1.35')).toEqual([0, 1, 35]);
    expect(parseVersion('  V2.10.3 ')).toEqual([2, 10, 3]);
  });

  it('ignores prerelease and build metadata without treating them as newer', () => {
    expect(parseVersion('v0.2.0-beta.1')).toEqual([0, 2, 0]);
    expect(parseVersion('0.2.0+abc123')).toEqual([0, 2, 0]);
  });

  it('returns null for anything it cannot read', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('0.1')).toBeNull();
    expect(parseVersion('release-0.1.35')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('returns 0 for equal versions regardless of the v prefix', () => {
    expect(compareVersions('v0.1.35', '0.1.35')).toBe(0);
  });

  it('returns null when either side is unreadable', () => {
    expect(compareVersions('0.1.35', 'nightly')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('only reports a real increase', () => {
    expect(isNewerVersion('0.1.36', '0.1.35')).toBe(true);
    expect(isNewerVersion('0.1.35', '0.1.35')).toBe(false);
    expect(isNewerVersion('0.1.34', '0.1.35')).toBe(false);
  });

  it('stays quiet when the upstream tag cannot be parsed', () => {
    expect(isNewerVersion(null, '0.1.35')).toBe(false);
    expect(isNewerVersion('nightly', '0.1.35')).toBe(false);
  });
});
