import { mapWithConcurrency } from '../concurrency.js';
import type { CommitHeatmapData, RepositoriesConfig } from '../../shared/contracts.js';
import { runGitText } from '../git/runner.js';
import { resolveRepositoryPath } from '../config/store.js';
import { reportWindow } from '../../shared/report-window.js';
import { summarizeOvertime, wallClockMinute } from './overtime.js';
import { accumulateAuthorSample, resolveAuthors, type AuthorSample } from './author-identity.js';
import {
  addCodeVolumeTotals,
  aggregateCommitVolumes,
  emptyCodeVolume,
  parseNumstatCommits,
  reconcileCommitVolumes,
  type CodeVolumeTotals,
  type CommitCodeVolume,
  type ParsedCodeVolume,
} from './code-volume.js';

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
  // 邮箱和名字一起取：只靠名字归并作者，`lee` 和 `李志伟` 这种改名会变成两个人
  '--format=%aI|%an|%ae',
  '--encoding=UTF-8',
];

/** 单个仓库的 git log 超时。超大仓库（十万级提交）冷启动也要几秒，留足余量。 */
const logTimeoutMs = 30_000;
/** numstat 要走一遍窗口内每个提交的 diff，比纯 log 慢一个数量级，超时给足。 */
const codeVolumeTimeoutMs = 60_000;
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
  /** key 为 `authorSampleKey`（名字 + 邮箱），详见 author-identity.ts */
  authors: Map<string, AuthorSample>;
  hourly: number[][];
  lastDate: string | null;
  /** 每条提交的墙钟分钟（见 overtime.ts），只在服务端用于算非上班时长 */
  minutes: number[];
}

/** 解析 `%aI|%an|%ae` 行，按日期、作者、星期×小时三个维度累加。 */
function parseLog(output: string): ParsedLog {
  const daily: Record<string, number> = {};
  const authors = new Map<string, AuthorSample>();
  const hourly = emptyHourly();
  const minutes: number[] = [];
  // 同一批提交里同一天会重复出现几十次，星期几没必要每条都算一遍
  const weekdayCache = new Map<string, number>();
  let lastDate: string | null = null;

  for (const line of output.split('\n')) {
    const pipeIndex = line.indexOf('|');
    if (pipeIndex === -1) continue;

    // `%aI` 是作者时区的 ISO 时间戳（2026-10-22T20:37:08+08:00），
    // 前 10 位是作者当时的本地日期，11–13 位是本地小时。
    const timestamp = line.slice(0, pipeIndex);
    const rest = line.slice(pipeIndex + 1);
    // 格式是「名字|邮箱」；邮箱里不会有 `|`，所以从最后一个 `|` 切
    const lastPipe = rest.lastIndexOf('|');
    const author = (lastPipe === -1 ? rest : rest.slice(0, lastPipe)).trim();
    const email = lastPipe === -1 ? '' : rest.slice(lastPipe + 1).trim();
    const date = timestamp.slice(0, 10);
    if (!author || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    daily[date] = (daily[date] ?? 0) + 1;
    accumulateAuthorSample(authors, { name: author, email, commits: 1, additions: 0, deletions: 0 });
    if (!lastDate || date > lastDate) lastDate = date;

    const wallClock = wallClockMinute(timestamp);
    if (wallClock !== null) minutes.push(wallClock);

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

  return { daily, authors, hourly, lastDate, minutes };
}

interface RepositoryDaily extends ParsedLog {
  repositoryId: string;
  repositoryName: string;
  /** 目录读不到 / 不是 Git 仓库；有提交的空仓库不算 */
  unreadable: boolean;
  /** 窗口内的增删行（已剔除生成文件） */
  volume: ParsedCodeVolume;
}

/**
 * 目录是不是一个 Git 仓库。
 *
 * 只在 `git log` 失败之后才调用：正常仓库一次都不多跑。失败的原因有两类，
 * 对用户的意义完全不同——目录没了 / 不是仓库（要去修），和一个刚 `init`
 * 过、还没有第一次提交的空仓库（正常，只是还没开始）。`git log` 对两者
 * 都返回 128，只看退出码分不开，所以再问一次 `rev-parse`。
 */
async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    await runGitText(cwd, ['rev-parse', '--git-dir'], 5_000);
    return true;
  } catch {
    return false;
  }
}

/** FNV-1a 32 位。只用来判断「引用有没有变」，不做任何安全用途。 */
function hashSignature(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * 所有分支 / 远程 / 标签的当前 sha 集合。
 *
 * 只盯 HEAD 是不够的：一次 fetch 或别人的分支更新都会改变窗口内的代码量，
 * 但 HEAD 一动不动。这里取全部引用再哈希，成本是每条几毫秒。
 */
async function refSignature(cwd: string): Promise<string | null> {
  try {
    const output = await runGitText(cwd, ['rev-parse', '--branches', '--remotes', '--tags', 'HEAD'], 5_000);
    return hashSignature(output);
  } catch {
    return null;
  }
}

interface CachedScan {
  /** 缓存时的引用签名，见 `refSignature` */
  signature: string;
  /** 全历史 log 的解析结果，与窗口无关，只要引用没动就一直有效 */
  log: ParsedLog;
  /** 逐提交代码量基线，配合 `volumeWindowStart` 做增量重算 */
  volumeCommits: Map<string, CommitCodeVolume>;
  volumeWindowStart: string;
  /** 这个条目占了多少条提交时间，用于控制总内存 */
  minuteCount: number;
}

/**
 * 分析结果缓存，键是仓库的绝对路径。
 *
 * 三件事都按仓库缓存，而且**失效条件各不相同**：
 * 1. 全历史 log（日期 / 星期×时 / 作者 / 墙钟分钟）——只跟引用有关，引用没动就一直有效；
 * 2. 逐提交代码量——跟引用和窗口起点都有关；
 * 3. 由 1、2 折出来的汇总——每次现算，微秒级，不值得再存一层。
 *
 * 只有第 1 项以前没有缓存：它每次请求都把 23 个仓库的全部历史重扫一遍。实测
 * 冷启动 3.88s 里有 0.13s 花在这里，看着不多，但它是**每 60 秒、每次切回窗口**
 * 都要重付一次的固定开销，而窗口化的界面根本不用全历史（全历史只喂排行榜的
 * 「提交数」和「一个提交都没有」的判空）。
 */
const scanCache = new Map<string, CachedScan>();

/** 仓库列表可能被反复增删，缓存不设上限的话会一直长。 */
const scanCacheLimit = 256;

/** 缓存里最多留多少条提交时间（每条约 8 字节）。超了整体清空，不做 LRU。 */
const maxCachedMinutes = 500_000;

let cachedMinuteCount = 0;

export function resetAnalyticsCache(): void {
  scanCache.clear();
  cachedMinuteCount = 0;
}

function storeScan(cwd: string, entry: CachedScan): void {
  const previous = scanCache.get(cwd);
  if (previous) {
    cachedMinuteCount -= previous.minuteCount;
    scanCache.delete(cwd);
  }
  if (scanCache.size >= scanCacheLimit || cachedMinuteCount + entry.minuteCount > maxCachedMinutes) {
    resetAnalyticsCache();
  }
  scanCache.set(cwd, entry);
  cachedMinuteCount += entry.minuteCount;
}

interface VolumeScan {
  value: ParsedCodeVolume;
  /** 逐提交记录，作为下一次增量重算的基线 */
  commits: Map<string, CommitCodeVolume>;
  windowStart: string;
}

function emptyVolumeScan(windowStart: string): VolumeScan {
  return { value: emptyCodeVolume(), commits: new Map(), windowStart };
}

/**
 * 窗口内的提交 sha。`rev-list` 只走拓扑、不产生 diff，比 numstat 快两个数量级。
 */
async function listWindowCommits(cwd: string, windowStart: string): Promise<string[]> {
  const output = await runGitText(
    cwd,
    ['rev-list', '--branches', '--remotes', '--tags', 'HEAD', '--no-merges', `--since=${windowStart}`],
    logTimeoutMs,
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 只给指定提交算 numstat。
 *
 * `--no-walk --stdin`：sha 从 stdin 灌进去，既绕开 argv 长度上限，又保证**只**输出
 * 这些提交——少了 `--no-walk`，git 会把它们的祖先一起带出来，那就等于又做了一次全量。
 */
async function numstatForCommits(cwd: string, shas: string[]): Promise<CommitCodeVolume[]> {
  const output = await runGitText(
    cwd,
    [
      'log',
      '--no-walk',
      '--stdin',
      // 与全量扫描保持同一套重命名识别，否则增量算出来的行数会和全量对不上
      '-M',
      '--numstat',
      '--format=%x01%H|%ae|%an',
      '--encoding=UTF-8',
    ],
    codeVolumeTimeoutMs,
    shas.join('\n'),
  );
  return parseNumstatCommits(output);
}

async function fullCodeVolumeScan(cwd: string, windowStart: string): Promise<VolumeScan> {
  const output = await runGitText(
    cwd,
    [
      'log',
      '--branches',
      '--remotes',
      '--tags',
      'HEAD',
      '--no-merges',
      `--since=${windowStart}`,
      // 显式打开重命名识别：默认值受用户 diff.renames 配置影响，关掉的话
      // 一次重命名会被记成「删掉 300 行又新增 300 行」的假改动
      '-M',
      '--numstat',
      '--format=%x01%H|%ae|%an',
      '--encoding=UTF-8',
    ],
    codeVolumeTimeoutMs,
  );

  const commits = new Map<string, CommitCodeVolume>();
  for (const commit of parseNumstatCommits(output)) commits.set(commit.sha, commit);
  return { value: aggregateCommitVolumes(commits.values()), commits, windowStart };
}

/**
 * 增量重算：只 diff 窗口里新出现的提交，已经算过的账原样留着。
 *
 * 契约是「返回值可信，或返回 null」。null 表示基线不可信，调用方必须退回全量扫描。
 */
async function refreshCodeVolume(
  cwd: string,
  windowStart: string,
  commits: Map<string, CommitCodeVolume>,
): Promise<Map<string, CommitCodeVolume> | null> {
  const listed = await listWindowCommits(cwd, windowStart).catch(() => null);
  if (listed === null) return null;

  const added = listed.filter((sha) => !commits.has(sha));
  const fresh = added.length === 0 ? [] : await numstatForCommits(cwd, added).catch(() => null);
  if (fresh === null) return null;

  return reconcileCommitVolumes(commits, listed, fresh);
}

async function readCodeVolume(
  cwd: string,
  windowStart: string,
  previous: CachedScan | undefined,
  refsUnchanged: boolean,
): Promise<VolumeScan> {
  if (previous && previous.volumeWindowStart === windowStart) {
    // 引用没动 = 窗口内的提交集合也没动，连 rev-list 都不用跑
    if (refsUnchanged) {
      return {
        value: aggregateCommitVolumes(previous.volumeCommits.values()),
        commits: previous.volumeCommits,
        windowStart,
      };
    }
    const refined = await refreshCodeVolume(cwd, windowStart, previous.volumeCommits).catch(() => null);
    if (refined) return { value: aggregateCommitVolumes(refined.values()), commits: refined, windowStart };
  }
  return fullCodeVolumeScan(cwd, windowStart);
}

async function readRepositoryDaily(
  config: RepositoriesConfig,
  repository: RepositoriesConfig['repositories'][number],
  windowStart: string,
): Promise<RepositoryDaily> {
  const empty: RepositoryDaily = {
    repositoryId: repository.id,
    repositoryName: repository.name,
    daily: {},
    authors: new Map(),
    hourly: emptyHourly(),
    lastDate: null,
    minutes: [],
    unreadable: false,
    volume: emptyCodeVolume(),
  };

  let cwd: string;
  try {
    cwd = resolveRepositoryPath(config, repository);
  } catch {
    // 路径本身配错了（比如 root 不存在），连 git 都跑不起来
    return { ...empty, unreadable: true };
  }

  const signature = await refSignature(cwd);
  const previous = signature ? scanCache.get(cwd) : undefined;
  // 签名是「全部引用 + HEAD」的哈希：它没变，就说明窗口内外都没有新提交，
  // 上一次的 log 结果逐字等于这一次的答案
  const refsUnchanged = Boolean(previous && signature && previous.signature === signature);

  // 两个 git 调用互不依赖，并行发出去：主 log 走全历史，numstat 只走窗口。
  // 走缓存时两者都是 Promise.resolve，实际只在冷启动那天各跑一次。
  const [log, volume] = await Promise.all([
    previous && refsUnchanged
      ? Promise.resolve(previous.log)
      : runGitText(cwd, logArguments, logTimeoutMs)
          .then(parseLog)
          .catch(() => null),
    readCodeVolume(cwd, windowStart, previous, refsUnchanged).catch(() => emptyVolumeScan(windowStart)),
  ]);

  if (log === null) {
    // 目录不存在、不是 git 仓库、没有提交（HEAD 无法解析）都走这里。
    // 单个仓库读不到不影响整体结果；但「读不到」和「没提交」要分开报，
    // 否则界面上那句「还没有提交记录」会替一个坏路径背锅。
    return { ...empty, unreadable: !(await isGitRepository(cwd)) };
  }

  if (signature) {
    storeScan(cwd, {
      signature,
      log,
      volumeCommits: volume.commits,
      volumeWindowStart: volume.windowStart,
      minuteCount: log.minutes.length,
    });
  }

  return { ...empty, ...log, volume: volume.value };
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
  // 服务端只算「近 52 周」的量，窗口定义和客户端画格子用的是同一份
  const windowStart = reportWindow(new Date()).start;

  const results = await mapWithConcurrency(
    repositories,
    repoConcurrency,
    (repository) => readRepositoryDaily(config, repository, windowStart),
  );

  const daily: Record<string, number> = {};
  const hourly = emptyHourly();
  const byRepo: CommitHeatmapData['byRepo'] = [];

  /**
   * 作者样本跨仓库合并，最后一次性归并身份。
   * 不能边合并边展示：`charsen` 和 `charsen fung` 谁排前面，取决于先读到哪个仓库，
   * 必须等所有仓库读完、拿到全量写法后再定展示名。
   */
  const authorSamples = new Map<string, AuthorSample>();
  const codeVolume: CodeVolumeTotals = {
    additions: 0,
    deletions: 0,
    files: 0,
    excludedFiles: 0,
    binaryFiles: 0,
  };

  let totalCommits = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  // 所有仓库的提交时间混在一条时间轴上切工作段：晚上先改 A 仓库、
  // 再改 B 仓库，仍然是同一个人连着干了两个小时，不该因为换了目录就断成两段。
  const allMinutes: number[] = [];
  const unreadableNames: string[] = [];

  for (const result of results) {
    if (result.unreadable) unreadableNames.push(result.repositoryName);
    // 用循环而不是 push(...arr)：单仓库十万级提交时展开参数会爆栈
    for (const minute of result.minutes) allMinutes.push(minute);
    for (const sample of result.authors.values()) accumulateAuthorSample(authorSamples, sample);
    // 代码量只统计窗口内，和主 log 的「全部历史」是两个口径，各自加各自的
    for (const author of result.volume.byAuthor.values()) {
      accumulateAuthorSample(authorSamples, {
        name: author.name,
        email: author.email,
        commits: 0,
        additions: author.additions,
        deletions: author.deletions,
      });
    }
    addCodeVolumeTotals(codeVolume, result.volume.totals);

    const total = Object.values(result.daily).reduce((sum, count) => sum + count, 0);
    if (total === 0) continue;

    byRepo.push({
      repositoryId: result.repositoryId,
      repositoryName: result.repositoryName,
      total,
      lastCommitDate: result.lastDate,
      additions: result.volume.totals.additions,
      deletions: result.volume.totals.deletions,
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
  }

  byRepo.sort((a, b) => b.total - a.total || a.repositoryName.localeCompare(b.repositoryName));

  // 作者只保留前 50：前端最多展示 10 个，多传的是纯冗余。
  const byAuthor = resolveAuthors([...authorSamples.values()]).slice(0, 50);

  return {
    daily,
    hourly,
    byRepo,
    byAuthor,
    codeVolume,
    overtime: summarizeOvertime(allMinutes),
    summary: {
      totalCommits,
      totalRepos: repositories.length,
      activeRepos: byRepo.length,
      firstDate,
      lastDate,
      unreadable: {
        count: unreadableNames.length,
        // 仓库名一般很短，53 个仓库时全列出来也就几十个字；
        // 但仓库数量没有上限，超过 10 个就只给数量，别把响应撑大。
        names: unreadableNames.slice(0, 10),
      },
    },
  };
}
