import { mapWithConcurrency } from '../concurrency.js';
import type { CommitHeatmapData, RepositoriesConfig } from '../../shared/contracts.js';
import { runGitText } from '../git/runner.js';
import { resolveRepositoryPath } from '../config/store.js';

/**
 * 统计口径用 `--branches --remotes --tags HEAD`，不用 `--all`。
 *
 * `--all` 等价于「refs/ 下所有引用 + HEAD」，会把 refs/stash 和 refs/notes 也算进来。
 * stash 提交的时间戳是「什么时候 stash 的」，混进热力图会让某一天凭空多出几条
 * 根本没落到任何分支上的提交；notes 更是纯粹的元数据提交。
 */
const logArguments = [
  'log',
  '--branches',
  '--remotes',
  '--tags',
  'HEAD',
  '--no-merges',
  '--format=%aI|%an',
  '--encoding=UTF-8',
];

/** 单个仓库的 git log 超时。超大仓库（十万级提交）冷启动也要几秒，留足余量。 */
const logTimeoutMs = 30_000;
const repoConcurrency = 6;

const weekdayCount = 7;
const hourCount = 24;

function emptyHourly(): number[][] {
  return Array.from({ length: weekdayCount }, () => new Array<number>(hourCount).fill(0));
}

/**
 * 日期对应的星期几，周一 = 0。
 * 只从字符串里取年月日再构造本地时间，不走 `new Date('2026-10-22')`——那会被当成 UTC 解析。
 */
function weekdayIndex(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return (new Date(year, month - 1, day).getDay() + 6) % 7;
}

interface ParsedLog {
  daily: Record<string, number>;
  authors: Record<string, number>;
  hourly: number[][];
  lastDate: string | null;
}

/** 解析 `%aI|%an` 行，按日期、作者、星期×小时三个维度累加。 */
function parseLog(output: string): ParsedLog {
  const daily: Record<string, number> = {};
  const authors: Record<string, number> = {};
  const hourly = emptyHourly();
  // 同一批提交里同一天会重复出现几十次，星期几没必要每条都算一遍
  const weekdayCache = new Map<string, number>();
  let lastDate: string | null = null;

  for (const line of output.split('\n')) {
    const pipeIndex = line.indexOf('|');
    if (pipeIndex === -1) continue;

    // `%aI` 是作者时区的 ISO 时间戳（2026-10-22T20:37:08+08:00），
    // 前 10 位是作者当时的本地日期，11–13 位是本地小时。
    const timestamp = line.slice(0, pipeIndex);
    const date = timestamp.slice(0, 10);
    const author = line.slice(pipeIndex + 1).trim();
    if (!author || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    daily[date] = (daily[date] ?? 0) + 1;
    authors[author] = (authors[author] ?? 0) + 1;
    if (!lastDate || date > lastDate) lastDate = date;

    const hour = Number(timestamp.slice(11, 13));
    if (Number.isInteger(hour) && hour >= 0 && hour < hourCount) {
      let weekday = weekdayCache.get(date);
      if (weekday === undefined) {
        weekday = weekdayIndex(date);
        weekdayCache.set(date, weekday);
      }
      hourly[weekday][hour] += 1;
    }
  }

  return { daily, authors, hourly, lastDate };
}

interface RepositoryDaily extends ParsedLog {
  repositoryId: string;
  repositoryName: string;
}

async function readRepositoryDaily(
  config: RepositoriesConfig,
  repository: RepositoriesConfig['repositories'][number],
): Promise<RepositoryDaily> {
  const empty: RepositoryDaily = {
    repositoryId: repository.id,
    repositoryName: repository.name,
    daily: {},
    authors: {},
    hourly: emptyHourly(),
    lastDate: null,
  };

  try {
    const cwd = resolveRepositoryPath(config, repository);
    const output = await runGitText(cwd, logArguments, logTimeoutMs);
    if (!output) return empty;
    return { ...empty, ...parseLog(output) };
  } catch {
    // 目录不存在、不是 git 仓库、没有提交（HEAD 无法解析）都走这里。
    // 单个仓库读不到不影响整体结果，统计上归为「无提交」。
    return empty;
  }
}

/**
 * 从所有启用仓库聚合 commit 热力图数据。
 *
 * 刻意**不**调用 `scanDashboardRepositories`：那套扫描会为每个仓库跑 `git status`、
 * ahead/behind 和 tag 列表，热力图一个都用不上，却要为此多花一倍以上的时间。
 * 仓库是否可用直接由 `git log` 的成败决定，语义还更准。
 */
export async function aggregateCommitHeatmap(config: RepositoriesConfig): Promise<CommitHeatmapData> {
  const repositories = config.repositories.filter((repository) => repository.enabled);

  const results = await mapWithConcurrency(
    repositories,
    repoConcurrency,
    (repository) => readRepositoryDaily(config, repository),
  );

  const daily: Record<string, number> = {};
  const hourly = emptyHourly();
  const byRepo: CommitHeatmapData['byRepo'] = [];

  /**
   * 作者按小写名归并：`%an` 是提交时手写的名字，同一个人在不同仓库 / 不同机器上
   * 很容易写成 `Charsen` 和 `charsen`，不归并的话排行榜上会并排出现两行。
   * 展示时取出现次数最多的那种写法。
   */
  const authorTallies = new Map<string, { count: number; spellings: Map<string, number> }>();

  let totalCommits = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const result of results) {
    const total = Object.values(result.daily).reduce((sum, count) => sum + count, 0);
    if (total === 0) continue;

    byRepo.push({
      repositoryId: result.repositoryId,
      repositoryName: result.repositoryName,
      total,
      lastCommitDate: result.lastDate,
    });

    totalCommits += total;

    for (const [date, count] of Object.entries(result.daily)) {
      daily[date] = (daily[date] ?? 0) + count;
      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;
    }

    for (let weekday = 0; weekday < weekdayCount; weekday += 1) {
      for (let hour = 0; hour < hourCount; hour += 1) {
        hourly[weekday][hour] += result.hourly[weekday][hour];
      }
    }

    for (const [author, count] of Object.entries(result.authors)) {
      const key = author.toLowerCase();
      let tally = authorTallies.get(key);
      if (!tally) {
        tally = { count: 0, spellings: new Map() };
        authorTallies.set(key, tally);
      }
      tally.count += count;
      tally.spellings.set(author, (tally.spellings.get(author) ?? 0) + count);
    }
  }

  byRepo.sort((a, b) => b.total - a.total || a.repositoryName.localeCompare(b.repositoryName));

  // 作者只保留前 50：前端最多展示 10 个，多传的是纯冗余。
  const rankedAuthors = [...authorTallies.values()]
    .map((tally) => ({
      name: [...tally.spellings.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      count: tally.count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 50);

  const byAuthor: Record<string, number> = {};
  for (const { name, count } of rankedAuthors) {
    byAuthor[name] = count;
  }

  return {
    daily,
    hourly,
    byRepo,
    byAuthor,
    summary: {
      totalCommits,
      totalRepos: repositories.length,
      activeRepos: byRepo.length,
      firstDate,
      lastDate,
    },
  };
}
