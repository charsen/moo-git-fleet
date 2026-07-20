import { describe, expect, it } from 'vitest';
import { parsePorcelainV2, repositoryId } from './scanner.js';

describe('parsePorcelainV2', () => {
  it('parses branch divergence and worktree counts', () => {
    const output = Buffer.from(
      '# branch.head master\0# branch.upstream origin/master\0# branch.ab +2 -1\0' +
        '1 M. N... 100644 100644 100644 abc abc src/a.ts\0' +
        '1 .D N... 100644 100644 000000 abc abc src/b.ts\0' +
        '? notes.txt\0' +
        'u UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts\0',
    );
    expect(parsePorcelainV2(output)).toMatchObject({
      branch: 'master',
      upstream: 'origin/master',
      ahead: 2,
      behind: 1,
      staged: 1,
      modified: 1,
      deleted: 1,
      untracked: 1,
      conflicted: 1,
    });
  });
});

describe('repositoryId', () => {
  it('is stable for a canonical path', () => {
    expect(repositoryId('Wisdom City', '/Volumes/dev/wwwroot/wisdomcity')).toBe(
      repositoryId('Wisdom City', '/Volumes/dev/wwwroot/wisdomcity'),
    );
  });
});
