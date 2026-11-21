import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
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
          '',
          secondHash,
          'Fix drawer',
          'Moo Developer',
          '2026-07-21T23:00:00+00:00',
          '',
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
        branches: [],
        parents: [],
      },
      {
        hash: secondHash,
        subject: 'Fix drawer',
        author: 'Moo Developer',
        committedAt: '2026-07-21T23:00:00+00:00',
        tags: [],
        branches: [],
        parents: [],
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
          secondHash,
          'Fix drawer',
          'Moo Developer',
          '2026-07-21T23:00:00+00:00',
          'tag: v0.1.5',
          '',
          '',
        ].join('\0'),
      ).map((commit) => commit.tags),
    ).toEqual([['v0.1.6', 'v0.1.6-hotfix'], ['v0.1.5']]);
  });

  it('keeps tag-like subjects out of the tag list', () => {
    expect(
      parseRecentCommits(
        [firstHash, 'chore: drop tag: v9.9 from docs', 'Moo Developer', '2026-07-22T01:00:00+00:00', '', '', ''].join('\0'),
      ),
    ).toEqual([
      {
        hash: firstHash,
        subject: 'chore: drop tag: v9.9 from docs',
        author: 'Moo Developer',
        committedAt: '2026-07-22T01:00:00+00:00',
        tags: [],
        branches: [],
        parents: [],
      },
    ]);
  });

  it('rejects malformed records instead of rendering unsafe partial metadata', () => {
    expect(() =>
      parseRecentCommits([firstHash, 'Missing author', '', '2026-07-22T01:00:00+00:00', '', ''].join('\0')),
    ).toThrow('读取最近提交失败');
  });

  it('rejects records whose field count is not a multiple of six', () => {
    expect(() =>
      parseRecentCommits([firstHash, 'Missing decoration', 'Moo Developer', '2026-07-22T01:00:00+00:00', ''].join('\0')),
    ).toThrow('读取最近提交失败');
  });


  it('keeps commits with an empty subject instead of failing the whole page', () => {
    const [commit] = parseRecentCommits([firstHash, '', 'Moo Developer', '2026-07-22T01:00:00+00:00', '', secondHash].join('\0'));
    expect(commit?.subject).toBe('');
    expect(commit?.parents).toEqual([secondHash]);
  });
  it('extracts branch pointers (local, remote, HEAD) and parents for the graph', () => {
    const [commit] = parseRecentCommits(
      [
        firstHash,
        'Merge feature',
        'Moo Developer',
        '2026-07-22T01:00:00+00:00',
        'HEAD -> main, origin/main, origin/HEAD, tag: v1.0, dev, origin/dev',
        [secondHash, '0123456789abcdef0123456789abcdef01234566'].join(' '),
      ].join('\0'),
    );
    expect(commit?.branches?.sort()).toEqual(['dev', 'main', 'origin/dev', 'origin/main']);
    expect(commit?.parents).toEqual([secondHash, '0123456789abcdef0123456789abcdef01234566']);
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
      tip: null,
    });
  });

  it('treats an unborn branch ref as an empty history instead of a missing branch', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-unborn-commits-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await expect(listCommitPage(repository, { limit: 20, skip: 0, ref: 'refs/heads/main' })).resolves.toEqual({
      commits: [],
      hasMore: false,
      tip: null,
    });
    await expect(listCommitPage(repository, { limit: 20, skip: 0, ref: 'refs/heads/main', order: 'topo' })).resolves.toEqual({
      commits: [],
      hasMore: false,
      tip: null,
    });
  });
});

describe('branch history snapshots', () => {
  it('reads local and remote branches without checking out or changing dirty data and pins pagination', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-branch-history-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(repository, 'history.txt'), `main ${i}\n`);
      await git(repository, ['add', '.']);
      await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', `main ${i}`]);
    }
    const head = await gitText(repository, ['rev-parse', 'HEAD']);
    await git(repository, ['branch', 'dev', 'HEAD~1']);
    await git(repository, ['update-ref', 'refs/remotes/origin/dev', 'HEAD~1']);
    await writeFile(path.join(repository, 'history.txt'), 'dirty\n');
    await git(repository, ['add', '.']);
    await writeFile(path.join(repository, 'history.txt'), 'partially staged\n');
    const status = await gitText(repository, ['status', '--porcelain=v1']);
    const staged = await gitText(repository, ['diff', '--cached']);
    const first = await listCommitPage(repository, { limit: 2, skip: 0, ref: 'refs/heads/dev' });
    expect(first.commits.map(item => item.subject)).toEqual(['main 2', 'main 1']);
    await git(repository, ['update-ref', 'refs/heads/dev', head]);
    const tail = await listCommitPage(repository, { limit: 2, skip: 2, ref: 'refs/heads/dev', tip: first.tip! });
    expect(tail.commits.map(item => item.subject)).toEqual(['main 0']);
    expect(tail.hasMore).toBe(false);
    const remote = await listCommitPage(repository, { limit: 20, skip: 0, ref: 'refs/remotes/origin/dev' });
    expect(remote.commits.map(item => item.subject)).toEqual(['main 2', 'main 1', 'main 0']);
    expect(await gitText(repository, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await gitText(repository, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await gitText(repository, ['status', '--porcelain=v1'])).toBe(status);
    expect(await gitText(repository, ['diff', '--cached'])).toBe(staged);
    await expect(listCommitPage(repository, { limit: 20, skip: 0, ref: '--all' })).rejects.toThrow('引用无效');
    await expect(listCommitPage(repository, { limit: 20, skip: 0, ref: 'refs/heads/dev~1' })).rejects.toThrow('引用无效');
    await expect(listCommitPage(repository, { limit: 20, skip: 0, ref: 'refs/heads/missing' })).rejects.toThrow('已不存在');
  });
});

describe('commit ordering', () => {
  it('walks side branches contiguously under topo order and keeps pagination stable', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-commit-order-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    const commitAt = async (file: string, subject: string, iso: string): Promise<void> => {
      await writeFile(path.join(repository, file), subject + '\n', { flag: 'a' });
      await git(repository, ['add', file]);
      await execFileAsync('git', ['-C', repository, '-c', 'commit.gpgSign=false', 'commit', '-m', subject], {
        env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
      });
    };
    await commitAt('main.txt', 'base', '2026-01-01T00:00:00+00:00');
    await git(repository, ['checkout', '-q', '-b', 'side']);
    await commitAt('side.txt', 'side 1', '2026-01-02T00:00:00+00:00');
    await commitAt('side.txt', 'side 2', '2026-01-03T00:00:00+00:00');
    await git(repository, ['checkout', '-q', 'main']);
    await commitAt('main.txt', 'main 1', '2026-01-10T00:00:00+00:00');
    await commitAt('main.txt', 'main 2', '2026-01-20T00:00:00+00:00');
    await execFileAsync('git', ['-C', repository, '-c', 'commit.gpgSign=false', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-30T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-30T00:00:00+00:00' },
    });

    // 默认（提交时间序）会把旁支留在列表末尾——这就是选择器里的「提交历史」排序。
    const dated = await listCommitPage(repository, { limit: 20, skip: 0 });
    expect(dated.commits.map(commit => commit.subject)).toEqual(['merge side', 'main 2', 'main 1', 'side 2', 'side 1', 'base']);

    // 提交图要拓扑序：合并后紧接着旁支自己的提交，泳道不会被拉长。
    const topo = await listCommitPage(repository, { limit: 20, skip: 0, order: 'topo' });
    expect(topo.commits.map(commit => commit.subject)).toEqual(['merge side', 'side 2', 'side 1', 'main 2', 'main 1', 'base']);
    // 拓扑序下父提交永远在子提交之后出现，布局才能把父边一律画向下方。
    const seen = new Set<string>();
    for (const commit of topo.commits) {
      for (const parent of commit.parents ?? []) expect(seen.has(parent), '父提交 ' + parent + ' 出现在子提交之前').toBe(false);
      seen.add(commit.hash);
    }

    // 分页沿用 topo 序：两页拼起来与一次取完完全一致。
    const firstPage = await listCommitPage(repository, { limit: 3, skip: 0, order: 'topo' });
    const secondPage = await listCommitPage(repository, { limit: 3, skip: 3, order: 'topo', tip: firstPage.tip! });
    expect([...firstPage.commits, ...secondPage.commits].map(commit => commit.subject)).toEqual(topo.commits.map(commit => commit.subject));
  });

  it('keeps parents after children under date order when committer clocks are skewed', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-commit-date-order-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    const commitAt = async (file: string, subject: string, iso: string): Promise<void> => {
      await writeFile(path.join(repository, file), subject + '\n', { flag: 'a' });
      await git(repository, ['add', file]);
      await execFileAsync('git', ['-C', repository, '-c', 'commit.gpgSign=false', 'commit', '-m', subject], {
        env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
      });
    };
    await commitAt('main.txt', 'root', '2026-03-01T00:00:00+00:00');
    await git(repository, ['checkout', '-q', '-b', 'side']);
    await commitAt('side.txt', 'child1', '2026-01-01T00:00:00+00:00');
    await git(repository, ['checkout', '-q', 'main']);
    await commitAt('main.txt', 'child2', '2026-02-01T00:00:00+00:00');
    await execFileAsync('git', ['-C', repository, '-c', 'commit.gpgSign=false', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-04-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-04-01T00:00:00+00:00' },
    });

    // 默认 log 序会输出 merge → child2 → root → child1（root 早于 child1）；--date-order 不允许父提交
    // 先于任何子提交出现，才能保证提交图不会为已出现过的父提交再开一条永不闭合的泳道。
    const dated = await listCommitPage(repository, { limit: 20, skip: 0, order: 'date' });
    expect(dated.commits.map(commit => commit.subject)).toEqual(['merge side', 'child2', 'child1', 'root']);
    const seen = new Set<string>();
    for (const commit of dated.commits) {
      for (const parent of commit.parents ?? []) expect(seen.has(parent), '父提交 ' + parent + ' 出现在子提交之前').toBe(false);
      seen.add(commit.hash);
    }
  });
});

describe('tag refs', () => {
  it('lists history starting at an annotated tag target', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-tag-ref-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    const commitFile = async (file: string, subject: string): Promise<string> => {
      await writeFile(path.join(repository, file), subject + '\n');
      await git(repository, ['add', file]);
      await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', subject]);
      return gitText(repository, ['rev-parse', 'HEAD']);
    };
    await commitFile('a.txt', 'first');
    const tagged = await commitFile('b.txt', 'second');
    await commitFile('c.txt', 'third');
    await git(repository, ['-c', 'tag.gpgSign=false', 'tag', '-a', 'v1', '-m', 'release one', tagged]);

    const page = await listCommitPage(repository, { ref: 'refs/tags/v1', limit: 10, skip: 0 });
    expect(page.commits.map((commit) => commit.subject)).toEqual(['second', 'first']);
    expect(page.commits[0]?.hash).toBe(tagged);
  });
});

  it('accepts a raw commit hash as the ref, so two arbitrary commits can be compared', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-hash-ref-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.name', 'Moo Developer']);
    await git(repository, ['config', 'user.email', 'moo@example.test']);
    await writeFile(path.join(repository, 'a.txt'), 'first\n');
    await git(repository, ['add', 'a.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'first']);
    const first = await gitText(repository, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repository, 'b.txt'), 'second\n');
    await git(repository, ['add', 'b.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'second']);

    const page = await listCommitPage(repository, { ref: first, limit: 10, skip: 0 });
    expect(page.commits.map((commit) => commit.subject)).toEqual(['first']);
  });

describe('shallow clones', () => {
  it('marks a shallow clone so the UI does not present a truncated history as complete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-shallow-'));
    temporaryDirectories.push(root);
    const origin = path.join(root, 'origin');
    await execFileAsync('git', ['init', '--initial-branch=main', origin]);
    await git(origin, ['config', 'user.name', 'Moo Developer']);
    await git(origin, ['config', 'user.email', 'moo@example.test']);
    for (const [file, subject] of [['a.txt', 'first'], ['b.txt', 'second']] as const) {
      await writeFile(path.join(origin, file), subject + '\n');
      await git(origin, ['add', file]);
      await git(origin, ['-c', 'commit.gpgSign=false', 'commit', '-m', subject]);
    }
    const shallow = path.join(root, 'shallow');
    await execFileAsync('git', ['clone', '--depth=1', `file://${origin}`, shallow]);

    const page = await listCommitPage(shallow, { limit: 10, skip: 0 });
    expect(page.shallow).toBe(true);
    expect(page.commits).toHaveLength(1);
    expect(page.hasMore).toBe(false);
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
  it('returns NUL-safe renamed and binary files for a merge relative to its first parent', async () => {
    const { repository } = await detailFixture('git-fleet-merge-files-');
    const oldPath = 'old\tname.txt'; const newPath = '中文\nrenamed.txt';
    await writeFile(path.join(repository, oldPath), 'stable content\n');
    await git(repository, ['add', '.']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);
    await git(repository, ['switch', '-c', 'feature']);
    await rename(path.join(repository, oldPath), path.join(repository, newPath));
    await writeFile(path.join(repository, 'binary.dat'), Buffer.from([0, 1, 2, 0]));
    await git(repository, ['add', '.']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'rename and binary']);
    await git(repository, ['switch', 'main']);
    await writeFile(path.join(repository, 'main.txt'), 'main\n');
    await git(repository, ['add', '.']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'main']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'merge', '--no-ff', 'feature', '-m', 'merge feature']);
    const result = await commitDetail(repository, await gitText(repository, ['rev-parse', 'HEAD']));
    expect(result.parents).toHaveLength(2);
    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: newPath, originalPath: oldPath, status: 'R', patch: expect.stringContaining('rename from') }),
      expect.objectContaining({ path: 'binary.dat', status: 'A', patch: expect.stringContaining('Binary files') }),
    ]));
    expect(result.files).toHaveLength(2);
    expect(result.patch).toContain('rename from');
  });

});
