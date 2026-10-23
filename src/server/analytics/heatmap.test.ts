import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { aggregateCommitHeatmap } from './heatmap.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

function repositoryConfig(
  id: string,
  name: string,
  absolutePath: string,
  enabled = true,
): RepositoryConfig {
  return {
    id,
    name,
    // roots 留空时 resolveRepositoryPath 直接 path.resolve(repository.path)
    root: 'root',
    path: absolutePath,
    group: 'group',
    enabled,
    pinned: false,
    order: 0,
    tags: [],
    aiCommitPolicy: 'disabled',
    capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
  };
}

function configOf(repositories: RepositoryConfig[]): RepositoriesConfig {
  return {
    version: 1,
    settings: { roots: {}, defaultRemote: 'origin', scanDepth: 2, localScanConcurrency: 4, networkConcurrency: 2 },
    repositories,
  };
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { env: { ...process.env, ...env } });
}

async function makeRepository(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `mf-heatmap-${label}-`));
  temporaryDirectories.push(directory);
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.email', 'dev@example.com']);
  await git(directory, ['config', 'user.name', 'Default Author']);
  return directory;
}

/** 用固定的作者 / 提交时间落一个提交，保证 `%aI` 可预测。 */
async function commitAt(
  cwd: string,
  isoDate: string,
  message: string,
  author = 'Default Author',
): Promise<void> {
  await writeFile(path.join(cwd, `${message}.txt`), message);
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author.replace(/\s+/g, '.')}@example.com`,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('aggregateCommitHeatmap', () => {
  it('按日期跨仓库累加，并给出首末日期', async () => {
    const alpha = await makeRepository('alpha');
    await commitAt(alpha, '2026-03-02T10:00:00+08:00', 'alpha-a');
    await commitAt(alpha, '2026-03-02T11:00:00+08:00', 'alpha-b');
    await commitAt(alpha, '2026-03-05T09:00:00+08:00', 'alpha-c');

    const beta = await makeRepository('beta');
    await commitAt(beta, '2026-03-02T12:00:00+08:00', 'beta-a');
    await commitAt(beta, '2026-03-09T12:00:00+08:00', 'beta-b');

    const result = await aggregateCommitHeatmap(configOf([
      repositoryConfig('alpha', 'Alpha', alpha),
      repositoryConfig('beta', 'Beta', beta),
    ]));

    expect(result.daily).toEqual({
      '2026-03-02': 3,
      '2026-03-05': 1,
      '2026-03-09': 1,
    });
    expect(result.summary).toEqual({
      totalCommits: 5,
      totalRepos: 2,
      activeRepos: 2,
      firstDate: '2026-03-02',
      lastDate: '2026-03-09',
    });
    expect(result.byRepo).toEqual([
      { repositoryId: 'alpha', repositoryName: 'Alpha', total: 3, lastCommitDate: '2026-03-05' },
      { repositoryId: 'beta', repositoryName: 'Beta', total: 2, lastCommitDate: '2026-03-09' },
    ]);
    expect(result.byAuthor['Default Author']).toBe(5);
  });

  it('按星期 × 小时统计，周一是第 0 行', async () => {
    const repository = await makeRepository('hourly');
    // 2026-03-02 是周一，2026-03-05 是周四
    await commitAt(repository, '2026-03-02T10:00:00+08:00', 'a');
    await commitAt(repository, '2026-03-02T10:30:00+08:00', 'b');
    await commitAt(repository, '2026-03-05T09:15:00+08:00', 'c');

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('hourly', 'Hourly', repository)]));

    expect(result.hourly).toHaveLength(7);
    expect(result.hourly.every((row) => row.length === 24)).toBe(true);
    expect(result.hourly[0][10]).toBe(2);
    expect(result.hourly[3][9]).toBe(1);
    // 总数必须和 daily 对得上，别出现「格子数漏了」
    expect(result.hourly.flat().reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it('不计合并提交，避免发版合并把当天顶成峰值', async () => {
    const repository = await makeRepository('merge');
    await commitAt(repository, '2026-04-01T10:00:00+08:00', 'base');
    await git(repository, ['checkout', '-q', '-b', 'feature']);
    await commitAt(repository, '2026-04-02T10:00:00+08:00', 'feature-work');
    await git(repository, ['checkout', '-q', 'main']);
    await commitAt(repository, '2026-04-03T10:00:00+08:00', 'main-work');
    await git(repository, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge-feature'], {
      GIT_AUTHOR_DATE: '2026-04-04T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-04-04T10:00:00+08:00',
    });

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('merge', 'Merge', repository)]));

    expect(result.daily['2026-04-04']).toBeUndefined();
    expect(result.summary.totalCommits).toBe(3);
  });

  it('不计 stash 提交（`--all` 会把它算进来）', async () => {
    const repository = await makeRepository('stash');
    await commitAt(repository, '2026-07-01T10:00:00+08:00', 'tracked');
    await writeFile(path.join(repository, 'tracked.txt'), 'dirty');
    // 落一个 stash：会生成两个 commit，时间戳是「什么时候 stash 的」
    await git(repository, ['stash', 'push', '-q'], {
      GIT_AUTHOR_DATE: '2026-07-20T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-07-20T10:00:00+08:00',
    });

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('stash', 'Stash', repository)]));

    expect(result.daily['2026-07-20']).toBeUndefined();
    expect(result.summary.totalCommits).toBe(1);
  });

  it('跳过不可用仓库、空仓库与已停用仓库', async () => {
    const filled = await makeRepository('filled');
    await commitAt(filled, '2026-05-01T10:00:00+08:00', 'only');

    const empty = await makeRepository('empty');
    const missing = path.join(os.tmpdir(), 'mf-heatmap-does-not-exist');

    const disabled = await makeRepository('disabled');
    await commitAt(disabled, '2026-05-02T10:00:00+08:00', 'hidden');

    const result = await aggregateCommitHeatmap(configOf([
      repositoryConfig('filled', 'Filled', filled),
      repositoryConfig('empty', 'Empty', empty),
      repositoryConfig('missing', 'Missing', missing),
      repositoryConfig('disabled', 'Disabled', disabled, false),
    ]));

    expect(result.summary.totalCommits).toBe(1);
    // 停用的仓库连「总数」都不参与
    expect(result.summary.totalRepos).toBe(3);
    expect(result.summary.activeRepos).toBe(1);
    expect(result.byRepo.map((repo) => repo.repositoryName)).toEqual(['Filled']);
  });

  it('作者榜最多保留 50 人，且按提交数降序', async () => {
    const repository = await makeRepository('authors');
    for (let index = 0; index < 60; index += 1) {
      await commitAt(repository, '2026-06-01T10:00:00+08:00', `c${index}`, `Author ${index}`);
    }

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('authors', 'Authors', repository)]));
    const entries = Object.entries(result.byAuthor);

    expect(entries).toHaveLength(50);
    expect(result.summary.totalCommits).toBe(60);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index][1]).toBeLessThanOrEqual(entries[index - 1][1]);
    }
  });

  it('同名不同大小写归并成一个人，展示出现最多的写法', async () => {
    const repository = await makeRepository('casing');
    await commitAt(repository, '2026-08-01T10:00:00+08:00', 'a', 'Charsen');
    await commitAt(repository, '2026-08-01T11:00:00+08:00', 'b', 'Charsen');
    await commitAt(repository, '2026-08-02T11:00:00+08:00', 'c', 'charsen');

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('casing', 'Casing', repository)]));

    // 不归并的话排行榜上会出现「Charsen 2」和「charsen 1」两行
    expect(result.byAuthor).toEqual({ Charsen: 3 });
    expect(result.summary.totalCommits).toBe(3);
  });

  it('空仓库列表返回零值而不是报错', async () => {
    const result = await aggregateCommitHeatmap(configOf([]));

    expect(result).toEqual({
      daily: {},
      hourly: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
      byRepo: [],
      byAuthor: {},
      summary: { totalCommits: 0, totalRepos: 0, activeRepos: 0, firstDate: null, lastDate: null },
    });
  });
});
