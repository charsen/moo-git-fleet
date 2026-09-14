import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { commitDetail, listCommitPage, parseRecentCommits } from './commits.js';

const firstHash = '0123456789abcdef0123456789abcdef01234567';
const secondHash = '89abcdef0123456789abcdef0123456789abcdef';
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
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
          '',
          secondHash,
          'Fix drawer',
          'Moo Developer',
          '2026-07-21T23:00:00+00:00',
          '',
          '',
        ].join('\0'),
      ),
    ).toEqual([
      {
        hash: firstHash,
        subject: 'Add recent commits',
        author: 'Moo Developer',
        committedAt: '2026-07-22T01:00:00+00:00',
        tags: [],
      },
      {
        hash: secondHash,
        subject: 'Fix drawer',
        author: 'Moo Developer',
        committedAt: '2026-07-21T23:00:00+00:00',
        tags: [],
      },
    ]);
  });

  it('collects release tags from the decoration field and ignores branch pointers', () => {
    expect(
      parseRecentCommits(
        [
          firstHash,
          'Release the drawer',
          'Moo Developer',
          '2026-07-22T01:00:00+00:00',
          'HEAD -> master, tag: v0.1.6, tag: v0.1.6-hotfix, origin/master, origin/HEAD',
          secondHash,
          'Fix drawer',
          'Moo Developer',
          '2026-07-21T23:00:00+00:00',
          'tag: v0.1.5',
          '',
        ].join('\0'),
      ).map((commit) => commit.tags),
    ).toEqual([['v0.1.6', 'v0.1.6-hotfix'], ['v0.1.5']]);
  });

  it('keeps tag-like subjects out of the tag list', () => {
    expect(
      parseRecentCommits(
        [firstHash, 'chore: drop tag: v9.9 from docs', 'Moo Developer', '2026-07-22T01:00:00+00:00', '', ''].join('\0'),
      ),
    ).toEqual([
      {
        hash: firstHash,
        subject: 'chore: drop tag: v9.9 from docs',
        author: 'Moo Developer',
        committedAt: '2026-07-22T01:00:00+00:00',
        tags: [],
      },
    ]);
  });

  it('rejects malformed records instead of rendering unsafe partial metadata', () => {
    expect(() =>
      parseRecentCommits([firstHash, 'Missing author', '', '2026-07-22T01:00:00+00:00', '', ''].join('\0')),
    ).toThrow('读取最近提交失败');
  });

  it('rejects records whose field count is not a multiple of five', () => {
    expect(() =>
      parseRecentCommits([firstHash, 'Missing decoration', 'Moo Developer', '2026-07-22T01:00:00+00:00', ''].join('\0')),
    ).toThrow('读取最近提交失败');
  });

  it('keeps control separators in real Git subjects and paginates without losing the tail', async () => {
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

    const firstPage = await listCommitPage(repository, { limit: 7, skip: 0 });
    expect(firstPage.commits).toHaveLength(7);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.commits[0]?.subject).toBe(unusualSubject);

    const secondPage = await listCommitPage(repository, { limit: 7, skip: 7 });
    expect(secondPage.commits).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.commits[0]?.subject).toBe('commit 1');

    // 分页拼接必须覆盖全部 8 条，不重不漏。
    const paged = [...firstPage.commits, ...secondPage.commits].map((commit) => commit.subject);
    expect(new Set(paged).size).toBe(8);
  });

  it('reports lightweight and annotated tags on the commits they point at', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-tagged-commits-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);

    for (let index = 1; index <= 3; index += 1) {
      await writeFile(path.join(repository, 'history.txt'), `commit ${index}\n`);
      await git(repository, ['add', 'history.txt']);
      await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', `commit ${index}`]);
      if (index === 1) await git(repository, ['tag', 'v0.1.0']);
      if (index === 2) await git(repository, ['-c', 'tag.gpgSign=false', 'tag', '-a', 'v0.2.0', '-m', 'release 0.2.0']);
      if (index === 3) await git(repository, ['tag', 'v0.3.0-rc.1']);
      if (index === 3) await git(repository, ['-c', 'tag.gpgSign=false', 'tag', '-a', 'v0.3.0', '-m', 'release 0.3.0']);
    }

    const { commits, hasMore } = await listCommitPage(repository, { limit: 20, skip: 0 });
    expect(hasMore).toBe(false);
    expect(commits.map((commit) => [commit.subject, [...commit.tags].sort()])).toEqual([
      ['commit 3', ['v0.3.0', 'v0.3.0-rc.1']],
      ['commit 2', ['v0.2.0']],
      ['commit 1', ['v0.1.0']],
    ]);
  });

  it('returns an empty page for a newly initialized repository without commits', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-empty-commits-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);

    await expect(listCommitPage(repository, { limit: 20, skip: 0 })).resolves.toEqual({
      commits: [],
      hasMore: false,
    });
  });
});

describe('commitDetail', () => {
  async function detailFixture(prefix: string): Promise<{ repository: string; head: string }> {
    const repository = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    return { repository, head: '' };
  }

  it('returns metadata, diffstat and patch for a single commit', async () => {
    const { repository } = await detailFixture('git-fleet-commit-detail-');
    await writeFile(path.join(repository, 'app.txt'), 'first\n');
    await git(repository, ['add', 'app.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'first commit']);
    await writeFile(path.join(repository, 'app.txt'), 'first\nsecond\n');
    await git(repository, ['add', 'app.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'second commit', '-m', 'body line']);
    await git(repository, ['tag', 'v1.0.0']);

    const head = await gitText(repository, ['rev-parse', 'HEAD']);
    const detail = await commitDetail(repository, head);
    expect(detail.hash).toBe(head);
    expect(detail.subject).toBe('second commit');
    expect(detail.body).toBe('body line');
    expect(detail.author).toBe('Moo Developer');
    expect(detail.tags).toEqual(['v1.0.0']);
    expect(detail.parents).toHaveLength(1);
    expect(detail.stat).toContain('app.txt');
    expect(detail.patch).toContain('+second');
    // `git show --format=` 会先输出空行，详情必须把它去掉，否则渲染层会多一条空行。
    expect(detail.patch.startsWith('\n')).toBe(false);
    expect(detail.stat.startsWith('\n')).toBe(false);
    expect(detail.truncated).toBe(false);
  });

  it('rejects malformed hashes and unknown commits', async () => {
    const { repository } = await detailFixture('git-fleet-commit-detail-reject-');
    await writeFile(path.join(repository, 'app.txt'), 'first\n');
    await git(repository, ['add', 'app.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'first commit']);

    await expect(commitDetail(repository, 'not-a-hash')).rejects.toThrow('Commit 哈希无效');
    await expect(commitDetail(repository, 'a'.repeat(40))).rejects.toThrow('找不到 Commit');
  });

  it('handles the root commit which has no parent', async () => {
    const { repository } = await detailFixture('git-fleet-commit-detail-root-');
    await writeFile(path.join(repository, 'app.txt'), 'root\n');
    await git(repository, ['add', 'app.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'root commit']);

    const head = await gitText(repository, ['rev-parse', 'HEAD']);
    const detail = await commitDetail(repository, head);
    expect(detail.parents).toEqual([]);
    expect(detail.patch).toContain('+root');
  });
});
