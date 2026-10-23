import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { dayIndexFromIso, localIsoDate } from '../../shared/report-window.js';
import { aggregateCommitHeatmap, resetAnalyticsCache } from './heatmap.js';

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
  email?: string,
): Promise<void> {
  await writeFile(path.join(cwd, `${message}.txt`), message);
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email ?? `${author.replace(/\s+/g, '.')}@example.com`,
  });
}

/** 落一个「写满 N 行」的文件并提交，用来验证行数统计。 */
async function commitLines(
  cwd: string,
  isoDate: string,
  fileName: string,
  lines: number,
  author = 'Default Author',
): Promise<void> {
  const content = Array.from({ length: lines }, (_, index) => `line ${index}`).join('\n');
  await writeFile(path.join(cwd, fileName), `${content}\n`);
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-q', '-m', `add ${fileName}`], {
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
  it('仓库多选统一限定所有指标，并在所选时间轴上重算投入', async () => {
    const alpha = await makeRepository('scope-alpha');
    const beta = await makeRepository('scope-beta');
    const day = localIsoDate(new Date());
    await commitLines(alpha, `${day}T20:00:00+08:00`, 'alpha.ts', 12, 'Alice');
    await commitLines(beta, `${day}T20:20:00+08:00`, 'beta.ts', 7, 'Bob');
    const config = configOf([
      repositoryConfig('alpha', 'Alpha', alpha),
      repositoryConfig('beta', 'Beta', beta),
      repositoryConfig('disabled', 'Disabled', '/not-a-managed-repository', false),
      repositoryConfig('missing', 'Missing', '/not-a-managed-repository'),
    ]);
    const [onlyAlpha, onlyBeta, both, all] = await Promise.all([
      aggregateCommitHeatmap(config, { repositoryIds: ['alpha'] }),
      aggregateCommitHeatmap(config, { repositoryIds: ['beta'] }),
      aggregateCommitHeatmap(config, { repositoryIds: ['beta', 'alpha', 'beta'] }),
      aggregateCommitHeatmap(config),
    ]);
    expect(onlyAlpha.repositoryScope).toEqual(['alpha']);
    expect(onlyAlpha.daily).toEqual({ [day]: 1 });
    expect(onlyAlpha.hourly.flat().reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(onlyAlpha.byRepo.map((repo) => repo.repositoryId)).toEqual(['alpha']);
    expect(onlyAlpha.byAuthor).toEqual([{ name: 'Alice', aliases: [], commits: 1, additions: 12, deletions: 0 }]);
    expect(onlyAlpha.codeVolume.additions).toBe(12);
    expect(onlyAlpha.summary).toMatchObject({ totalRepos: 1, totalCommits: 1, unreadable: { count: 0, names: [], reason: null } });
    expect(onlyBeta.byRepo.map((repo) => repo.repositoryId)).toEqual(['beta']);
    expect(onlyBeta.codeVolume.additions).toBe(7);
    expect(both.repositoryScope).toEqual(['alpha', 'beta']);
    expect(both.codeVolume.additions).toBe(19);
    expect(both.daily[day]).toBe(2);
    expect(both.summary.totalRepos).toBe(2);
    expect(both.overtime.workMinutes).toBe(50);
    expect(onlyAlpha.overtime.workMinutes + onlyBeta.overtime.workMinutes).toBe(60);
    expect(all.repositoryScope).toBeNull();
    expect(all.summary.unreadable.count).toBe(1);
    expect((await aggregateCommitHeatmap(config, { repositoryIds: ['alpha', 'beta'] }))).toEqual(both);

    for (const ids of [[], ['unknown'], ['disabled']]) {
      const empty = await aggregateCommitHeatmap(config, { repositoryIds: ids });
      expect(empty.summary.totalRepos).toBe(0);
      expect(empty.summary.totalCommits).toBe(0);
      expect(empty.byRepo).toEqual([]);
      expect(empty.codeVolume.additions).toBe(0);
      expect(empty.overtime.workMinutes).toBe(0);
    }
  });

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
      unreadable: { count: 0, names: [], reason: null },
    });
    expect(result.byRepo).toEqual([
      { repositoryId: 'alpha', repositoryName: 'Alpha', total: 3, lastCommitDate: '2026-03-05', additions: 3, deletions: 0 },
      { repositoryId: 'beta', repositoryName: 'Beta', total: 2, lastCommitDate: '2026-03-09', additions: 2, deletions: 0 },
    ]);
    expect(result.byAuthor).toEqual([
      { name: 'Default Author', aliases: [], commits: 5, additions: 5, deletions: 0 },
    ]);
    expect(result.codeVolume).toEqual({ additions: 5, deletions: 0, files: 5, excludedFiles: 0, binaryFiles: 0 });
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
    // 目录不存在是「读不到」，空仓库只是「还没提交」——两者不能混成一个桶，
    // 否则界面上那句「还没有提交记录」会替一个坏路径背锅。
    expect(result.summary.unreadable.count).toBe(1);
    expect(result.summary.unreadable.names).toEqual(['Missing']);
    // 原因要一起带回来：界面原来写死「目录不可访问或不是 Git 仓库」，
    // 遇到别的原因（比如 git 自己拒绝执行）就会把人引到错的地方。
    expect(result.summary.unreadable.reason).toBeTruthy();
  });

  it('空仓库不算读取失败，也不带失败原因', async () => {
    const empty = await makeRepository('empty-only');

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('empty', 'Empty', empty)]));

    // `git log HEAD` 在空仓库上也会失败（ambiguous argument 'HEAD'），
    // 但那是「还没开始写」，不是坏了——原因必须留空，否则界面会把它当故障报出来。
    expect(result.summary.unreadable).toEqual({ count: 0, names: [], reason: null });
  });

  it('作者榜最多保留 50 人，且按提交数降序', async () => {
    const repository = await makeRepository('authors');
    for (let index = 0; index < 60; index += 1) {
      await commitAt(repository, '2026-06-01T10:00:00+08:00', `c${index}`, `Author ${index}`);
    }

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('authors', 'Authors', repository)]));

    expect(result.byAuthor).toHaveLength(50);
    expect(result.summary.totalCommits).toBe(60);
    for (let index = 1; index < result.byAuthor.length; index += 1) {
      expect(result.byAuthor[index].commits).toBeLessThanOrEqual(result.byAuthor[index - 1].commits);
    }
  });

  it('同名不同大小写归并成一个人，展示出现最多的写法', async () => {
    const repository = await makeRepository('casing');
    await commitAt(repository, '2026-08-01T10:00:00+08:00', 'a', 'Charsen');
    await commitAt(repository, '2026-08-01T11:00:00+08:00', 'b', 'Charsen');
    await commitAt(repository, '2026-08-02T11:00:00+08:00', 'c', 'charsen');

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('casing', 'Casing', repository)]));

    // 不归并的话排行榜上会出现「Charsen 2」和「charsen 1」两行
    expect(result.byAuthor).toEqual([{ name: 'Charsen', aliases: [], commits: 3, additions: 3, deletions: 0 }]);
    expect(result.summary.totalCommits).toBe(3);
  });

  it('空仓库列表返回零值而不是报错', async () => {
    const result = await aggregateCommitHeatmap(configOf([]));

    // 窗口跟着「今天」走，不能写死日期：只断言跨度是 52 个整周（含首尾共 364 天），
    // 且首尾自洽。写死日期会在跨年那天莫名其妙红一次。
    const { range } = result;
    expect(range.weeks).toBe(52);
    expect(range.label).toBe('近一年');
    expect(dayIndexFromIso(range.end) - dayIndexFromIso(range.start)).toBe(52 * 7 - 1);

    const { range: _range, ...rest } = result;
    expect(rest).toEqual({
      repositoryScope: null,
      daily: {},
      hourly: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
      byRepo: [],
      byAuthor: [],
      codeVolume: { additions: 0, deletions: 0, files: 0, excludedFiles: 0, binaryFiles: 0 },
      overtime: {
        workMinutes: 0,
        offHoursMinutes: 0,
        workdayMinutes: 0,
        weekendMinutes: 0,
        earlyMinutes: 0,
        lunchMinutes: 0,
        eveningMinutes: 0,
        segments: 0,
        activeDays: 0,
        lightDays: 0,
        equivalentDays: 0,
      },
      summary: {
        totalCommits: 0,
        totalRepos: 0,
        activeRepos: 0,
        firstDate: null,
        lastDate: null,
        unreadable: { count: 0, names: [], reason: null },
      },
    });
  });

  it('跨仓库的提交串成同一段连续工作，晚间计入非上班时间', async () => {
    const alpha = await makeRepository('overtime-alpha');
    const beta = await makeRepository('overtime-beta');
    // 2026-03-02 周一：先在 alpha 干到 19:00，19:20 又在 beta 提交
    await commitAt(alpha, '2026-03-02T19:00:00+08:00', 'evening-a');
    await commitAt(beta, '2026-03-02T19:20:00+08:00', 'evening-b');
    await commitAt(alpha, '2026-03-02T10:00:00+08:00', 'morning');

    const result = await aggregateCommitHeatmap(configOf([
      repositoryConfig('alpha', 'Alpha', alpha),
      repositoryConfig('beta', 'Beta', beta),
    ]));

    // 10:00 在正常工时内，19:00 与 19:20 同属一段晚间：[18:30,19:00) + [19:00,19:20)
    expect(result.overtime.eveningMinutes).toBe(50);
    expect(result.overtime.earlyMinutes).toBe(0);
    expect(result.overtime.weekendMinutes).toBe(0);
    expect(result.overtime.offHoursMinutes).toBe(50);
    // 两段：正常工时一段（30 分钟准备）、晚间一段
    expect(result.overtime.segments).toBe(2);
    expect(result.overtime.activeDays).toBe(1);
    // 换了目录不该断成两段，所以 19:00 与 19:20 之间的 20 分钟要算进来
    expect(result.overtime.workMinutes).toBe(30 + 50);
  });

  it('周末提交整段计入非上班时间', async () => {
    const repository = await makeRepository('overtime-weekend');
    // 2026-03-07 周六
    await commitAt(repository, '2026-03-07T14:00:00+08:00', 'weekend-a');

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('weekend', 'Weekend', repository)]));

    expect(result.overtime.weekendMinutes).toBe(30);
    expect(result.overtime.workdayMinutes).toBe(0);
    expect(result.overtime.equivalentDays).toBe(0.06);
  });

  it('代码量剔除锁文件等生成文件，并单独报出剔除数量', async () => {
    const repository = await makeRepository('volume-generated');
    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'package-lock.json', 200);
    await commitLines(repository, '2026-03-02T10:10:00+08:00', 'app.ts', 12);

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('v', 'V', repository)]));

    // 200 行的锁文件不能进总量，但要能说出「剔了 1 个」
    expect(result.codeVolume).toEqual({ additions: 12, deletions: 0, files: 1, excludedFiles: 1, binaryFiles: 0 });
    expect(result.byRepo[0]).toMatchObject({ total: 2, additions: 12, deletions: 0 });
  });

  it('超出所选时间段的提交不进任何一项统计', async () => {
    const repository = await makeRepository('volume-window');
    await commitLines(repository, '2020-01-06T10:00:00+08:00', 'ancient.ts', 99);
    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'fresh.ts', 7);

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('w', 'W', repository)]));

    // 2020 那笔既不算提交数、也不算代码量：整页现在是同一个窗口口径，
    // 不再有「提交数看全历史、代码量看窗口」这种同一屏两种范围的情况
    expect(result.summary.totalCommits).toBe(1);
    expect(result.summary.firstDate).toBe('2026-03-02');
    expect(result.daily['2020-01-06']).toBeUndefined();
    expect(result.codeVolume.additions).toBe(7);
    expect(result.byRepo[0].total).toBe(1);
    // 但「最近一次提交」是绝对时间，仍然指到最新那天
    expect(result.byRepo[0].lastCommitDate).toBe('2026-03-02');
    // 有提交记录的仓库数按全历史算，页面不会因为窗口里没东西就退化成「暂无数据」
    expect(result.summary.activeRepos).toBe(1);
  });

  it('按 weeks 收窄窗口：更老的提交被排除，标签与范围一起回传', async () => {
    const repository = await makeRepository('weeks');
    // 距今 400 天上下：52 周（364 天）之外、104 周（728 天）之内
    const older = new Date();
    older.setDate(older.getDate() - 400);
    const newer = new Date();
    newer.setDate(newer.getDate() - 10);
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T10:00:00+08:00`;
    await commitLines(repository, iso(older), 'older.ts', 40);
    await commitLines(repository, iso(newer), 'newer.ts', 5);

    const config = configOf([repositoryConfig('k', 'K', repository)]);
    const oneYear = await aggregateCommitHeatmap(config, { weeks: 52 });
    const twoYears = await aggregateCommitHeatmap(config, { weeks: 104 });

    expect(oneYear.range.weeks).toBe(52);
    expect(oneYear.range.label).toBe('近一年');
    expect(oneYear.summary.totalCommits).toBe(1);
    expect(oneYear.codeVolume.additions).toBe(5);

    expect(twoYears.range.weeks).toBe(104);
    expect(twoYears.range.label).toBe('近两年');
    expect(twoYears.summary.totalCommits).toBe(2);
    expect(twoYears.codeVolume.additions).toBe(45);
    // 窗口变宽之后起点必须更早，否则「近两年」和「近一年」就是同一张图
    expect(twoYears.range.start < oneYear.range.start).toBe(true);
  });

  it('非法 weeks 回落到近一年，而不是抛错或返回空', async () => {
    const repository = await makeRepository('weeks-invalid');
    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'app.ts', 3);
    const config = configOf([repositoryConfig('i', 'I', repository)]);

    for (const weeks of ['abc', '', '0', '-4', '2.5', '9999', null, undefined]) {
      const result = await aggregateCommitHeatmap(config, { weeks });
      expect(result.range.weeks).toBe(52);
      expect(result.summary.totalCommits).toBe(1);
    }
  });

  it('新提交会刷新缓存里的代码量', async () => {
    const repository = await makeRepository('volume-cache');
    const config = configOf([repositoryConfig('c', 'C', repository)]);
    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'first.ts', 5);

    const first = await aggregateCommitHeatmap(config);
    expect(first.codeVolume.additions).toBe(5);
    expect(first.summary.totalCommits).toBe(1);

    // 引用没变时走缓存；这里引用变了，必须重新算，不能拿上一次的账
    await commitLines(repository, '2026-03-03T10:00:00+08:00', 'second.ts', 9);

    const second = await aggregateCommitHeatmap(config);
    expect(second.codeVolume.additions).toBe(14);
    // 全历史 log 同样必须重跑：只按引用签名复用，不能无条件吃上一次的结果
    expect(second.summary.totalCommits).toBe(2);
    expect(second.daily['2026-03-03']).toBe(1);
  });

  it('增量重算与全量扫描的结果完全一致', async () => {
    const repository = await makeRepository('volume-equivalence');
    const config = configOf([repositoryConfig('c', 'C', repository)]);

    // 一条窗口外的老提交：增量补算如果顺手把祖先也 diff 了，它就会混进代码量，
    // 而全量扫描是按 `--since` 过滤掉的，两边立刻分叉
    await commitLines(repository, '2020-01-06T10:00:00+08:00', 'ancient.ts', 99);
    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'app.ts', 12);
    // 先跑一次，落下一份「逐提交」基线
    await aggregateCommitHeatmap(config);

    // 再落一串形态各异的提交：普通文件、锁文件、重命名、删文件、二进制
    await commitLines(repository, '2026-03-03T10:00:00+08:00', 'package-lock.json', 300);
    await commitLines(repository, '2026-03-04T10:00:00+08:00', 'feature.ts', 8);
    await git(repository, ['mv', 'feature.ts', 'renamed.ts']);
    await git(repository, ['commit', '-q', '-m', 'rename'], {
      GIT_AUTHOR_DATE: '2026-03-05T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-03-05T10:00:00+08:00',
    });
    await git(repository, ['rm', '-q', 'app.ts']);
    await git(repository, ['commit', '-q', '-m', 'remove app'], {
      GIT_AUTHOR_DATE: '2026-03-06T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-03-06T10:00:00+08:00',
    });
    await writeFile(path.join(repository, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-q', '-m', 'binary'], {
      GIT_AUTHOR_DATE: '2026-03-07T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-03-07T10:00:00+08:00',
    });

    // 这次必然走增量：只 diff 新出现的五个提交
    const incremental = await aggregateCommitHeatmap(config);
    // 清空缓存后重跑，这次是纯全量扫描
    resetAnalyticsCache();
    const full = await aggregateCommitHeatmap(config);

    // 增量路径只要漏算一个提交、或者忘了删掉已消失的提交，这里就会分叉
    expect(incremental.codeVolume).toEqual(full.codeVolume);
    expect(incremental.byAuthor).toEqual(full.byAuthor);
    expect(incremental.daily).toEqual(full.daily);
    expect(incremental.overtime).toEqual(full.overtime);
    expect(incremental.byRepo).toEqual(full.byRepo);
  });

  it('用户关掉 diff.renames 之后，增量补算仍按重命名处理', async () => {
    const repository = await makeRepository('volume-rename-config');
    const config = configOf([repositoryConfig('c', 'C', repository)]);
    // 默认 diff.renames 是开的，`-M` 看起来像废话；把它关掉才是 `-M` 真正起作用的场景，
    // 也是「一次重命名被记成删 8 行 + 增 8 行」会真实发生的地方
    await git(repository, ['config', 'diff.renames', 'false']);

    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'feature.ts', 8);
    await aggregateCommitHeatmap(config);

    await git(repository, ['mv', 'feature.ts', 'renamed.ts']);
    await git(repository, ['commit', '-q', '-m', 'rename'], {
      GIT_AUTHOR_DATE: '2026-03-03T10:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-03-03T10:00:00+08:00',
    });

    const incremental = await aggregateCommitHeatmap(config);
    resetAnalyticsCache();
    const full = await aggregateCommitHeatmap(config);

    expect(incremental.codeVolume).toEqual(full.codeVolume);
    // 重命名是 0 增 0 删，总量必须还是最初那 8 行
    expect(incremental.codeVolume).toMatchObject({ additions: 8, deletions: 0 });
  });

  it('历史被改写后，已经不在窗口里的提交要撤账', async () => {
    const repository = await makeRepository('volume-rewrite');
    const config = configOf([repositoryConfig('c', 'C', repository)]);

    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'first.ts', 5);
    await commitLines(repository, '2026-03-03T10:00:00+08:00', 'second.ts', 9);
    expect((await aggregateCommitHeatmap(config)).codeVolume.additions).toBe(14);

    // `reset --hard` 之后 second.ts 那次提交已经不在任何引用上，
    // 增量缓存如果只「补新的」不「撤旧的」，这里会永远停在 14
    await git(repository, ['reset', '--hard', 'HEAD~1']);

    expect((await aggregateCommitHeatmap(config)).codeVolume.additions).toBe(5);
  });

  it('增量补算同样剔除生成文件，不因为换了一条路径就放行', async () => {
    const repository = await makeRepository('volume-incremental-generated');
    const config = configOf([repositoryConfig('c', 'C', repository)]);

    await commitLines(repository, '2026-03-02T10:00:00+08:00', 'app.ts', 10);
    expect((await aggregateCommitHeatmap(config)).codeVolume).toMatchObject({ additions: 10, excludedFiles: 0 });

    await commitLines(repository, '2026-03-03T10:00:00+08:00', 'yarn.lock', 8000);

    const result = await aggregateCommitHeatmap(config);
    expect(result.codeVolume).toMatchObject({ additions: 10, excludedFiles: 1 });
  });

  it('同一个人的多种写法与多个邮箱归并成一个身份', async () => {
    const alpha = await makeRepository('identity-alpha');
    await commitAt(alpha, '2026-03-02T10:00:00+08:00', 'a1', 'charsen', '780537@qq.com');
    await commitAt(alpha, '2026-03-02T11:00:00+08:00', 'a2', 'charsen', '780537@gmail.com');

    const beta = await makeRepository('identity-beta');
    await commitAt(beta, '2026-03-03T10:00:00+08:00', 'b1', 'charsen fung', 'charsen@mac.local');

    const result = await aggregateCommitHeatmap(configOf([
      repositoryConfig('alpha', 'Alpha', alpha),
      repositoryConfig('beta', 'Beta', beta),
    ]));

    // 不归并的话这里是 3 行：charsen 1 / charsen 1 / charsen fung 1
    expect(result.byAuthor).toHaveLength(1);
    expect(result.byAuthor[0]).toMatchObject({ name: 'charsen', aliases: ['charsen fung'], commits: 3 });
  });
});

describe('修复轮（2026-10-23）：口径与缓存', () => {
  /** 距今 N 天前（本地）的 ISO 时间串，用来造「窗口内 / 窗口外」的提交。 */
  function daysAgo(days: number): { iso: string; date: string } {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return { iso: `${day}T10:00:00+08:00`, date: day };
  }

  it('窗口内没有提交的仓库仍然出现在 byRepo 里（活跃度卡要按全历史分桶）', async () => {
    const stale = await makeRepository('stale');
    const fresh = await makeRepository('fresh');
    const old = daysAgo(200).iso;
    await commitAt(stale, old, 'stale-commit');
    await commitAt(fresh, daysAgo(3).iso, 'fresh-commit');

    const result = await aggregateCommitHeatmap(
      configOf([repositoryConfig('stale', 'Stale', stale), repositoryConfig('fresh', 'Fresh', fresh)]),
      { weeks: 13 },
    );

    // 窄窗口里 stale 一次都没提交，但它必须还在——否则「91 天以上」那一档会凭空少一个
    expect(result.byRepo.map((repo) => repo.repositoryName).sort()).toEqual(['Fresh', 'Stale']);
    const staleRepo = result.byRepo.find((repo) => repo.repositoryName === 'Stale')!;
    expect(staleRepo.total).toBe(0);
    expect(staleRepo.lastCommitDate).toBe(daysAgo(200).date);
    // 提交数只算窗口内的
    expect(result.summary.totalCommits).toBe(1);
  });

  it('窄窗口下作者身份仍按全历史归并，不把一个人拆成两行', async () => {
    const repository = await makeRepository('identity-window');
    // 窗口外：另一种写法；窗口内：常用写法。同一个邮箱是合并的硬证据
    await commitAt(repository, daysAgo(400).iso, 'old', 'charsen', 'charsen@mac.local');
    await commitAt(repository, daysAgo(3).iso, 'new', 'charsen', 'charsen@mac.local');

    const result = await aggregateCommitHeatmap(configOf([repositoryConfig('i', 'I', repository)]), { weeks: 13 });

    expect(result.byAuthor).toHaveLength(1);
    expect(result.byAuthor[0].commits).toBe(1); // 计数仍只算窗口内
  });

  it('代码量按 author date 筛，不被 committer date 带偏', async () => {
    const repository = await makeRepository('author-date');
    const old = daysAgo(400);
    // 作者日期在 400 天前，提交日期是今天：`--since` 会把它捞进来，
    // 但它属于 400 天前那一天，不能算进「近一年」的代码量
    await writeFile(path.join(repository, 'old.ts'), 'line 1\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-q', '-m', 'rebase-picked'], {
      GIT_AUTHOR_DATE: old.iso,
      GIT_COMMITTER_DATE: new Date().toISOString(),
      GIT_AUTHOR_NAME: 'Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
    });
    await commitLines(repository, daysAgo(3).iso, 'fresh.ts', 7);

    const config = configOf([repositoryConfig('a', 'A', repository)]);
    const oneYear = await aggregateCommitHeatmap(config, { weeks: 52 });
    const twoYears = await aggregateCommitHeatmap(config, { weeks: 104 });

    expect(oneYear.codeVolume.additions).toBe(7); // 400 天前那笔不算
    expect(oneYear.summary.totalCommits).toBe(1);
    expect(twoYears.codeVolume.additions).toBe(8); // 放宽到两年才算进来
    expect(twoYears.summary.totalCommits).toBe(2);
  });

  it('来回切范围的结果稳定，收窄不会把基线剪坏', async () => {
    const repository = await makeRepository('range-thrash');
    for (let index = 0; index < 6; index += 1) {
      await commitLines(repository, daysAgo(index * 40 + 2).iso, `f${index}.ts`, index + 1);
    }

    const config = configOf([repositoryConfig('r', 'R', repository)]);
    const wide = await aggregateCommitHeatmap(config, { weeks: 52 });
    const narrow = await aggregateCommitHeatmap(config, { weeks: 13 });
    const wideAgain = await aggregateCommitHeatmap(config, { weeks: 52 });

    expect(narrow.codeVolume.additions).toBeLessThan(wide.codeVolume.additions);
    expect(wideAgain.codeVolume).toEqual(wide.codeVolume);
    expect(wideAgain.summary.totalCommits).toBe(wide.summary.totalCommits);
  });
});
