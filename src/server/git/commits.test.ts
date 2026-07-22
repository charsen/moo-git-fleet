import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listRecentCommits, parseRecentCommits } from './commits.js';

const firstHash = '0123456789abcdef0123456789abcdef01234567';
const secondHash = '89abcdef0123456789abcdef0123456789abcdef';
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('recent commit parsing', () => {
  it('parses Git records in newest-first order', () => {
    expect(
      parseRecentCommits(
        [
          firstHash,
          'Add recent commits',
          'Moo Developer',
          '2026-07-22T01:00:00+00:00',
          secondHash,
          'Fix drawer',
          'Moo Developer',
          '2026-07-21T23:00:00+00:00',
          '',
        ].join('\0'),
      ),
    ).toEqual([
      {
        hash: firstHash,
        subject: 'Add recent commits',
        author: 'Moo Developer',
        committedAt: '2026-07-22T01:00:00+00:00',
      },
      {
        hash: secondHash,
        subject: 'Fix drawer',
        author: 'Moo Developer',
        committedAt: '2026-07-21T23:00:00+00:00',
      },
    ]);
  });

  it('rejects malformed records instead of rendering unsafe partial metadata', () => {
    expect(() =>
      parseRecentCommits([firstHash, 'Missing author', '', '2026-07-22T01:00:00+00:00', ''].join('\0')),
    ).toThrow('读取最近提交失败');
  });

  it('keeps control separators in real Git subjects and still caps the result at seven commits', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-recent-commits-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    const unusualSubject = 'edge\x1erecord\x1ffield';

    for (let index = 1; index <= 8; index += 1) {
      await writeFile(path.join(repository, 'history.txt'), `commit ${index}\n`);
      await git(repository, ['add', 'history.txt']);
      await git(repository, [
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-m',
        index === 8 ? unusualSubject : `commit ${index}`,
      ]);
    }

    const commits = await listRecentCommits(repository, 100);
    expect(commits).toHaveLength(7);
    expect(commits[0]?.subject).toBe(unusualSubject);
  });

  it('returns an empty list for a newly initialized repository without commits', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-empty-commits-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);

    await expect(listRecentCommits(repository)).resolves.toEqual([]);
  });
});
