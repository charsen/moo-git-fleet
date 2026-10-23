import { mapWithConcurrency } from '../concurrency.js';
import type { CommitHeatmapData, RepositoriesConfig } from '../../shared/contracts.js';
import { runGitText } from '../git/runner.js';
import { resolveRepositoryPath } from '../config/store.js';
import {
  analyticsRangeLabel,
  dayIndexFromIso,
  defaultAnalyticsWeeks,
  normalizeAnalyticsWeeks,
  reportWindow,
} from '../../shared/report-window.js';
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
const minutesPerDay = 1440;

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

/**
 * 一天的提交明细。
 *
 * 之所以按天存而不是直接存「全局 daily / 全局 hourly」，是因为时间段可调：
 * 缓存只能存一份（全历史），窗口却是每次请求都可能变的。按天存，换窗口就是
 * 在内存里挑一段日期求和，不用重新跑 `git log`；存成全局汇总就只能重扫。
 */
interface DayBucket {
  count: number;
  /** 24 个小时的提交数，索引是 `%aI` 里的作者本地小时 */
  hours: number[];
  /** key 为 `authorSampleKey`（名字 + 邮箱），详见 author-identity.ts */
  authors: Map<string, AuthorSample>;
}

interface ParsedLog {
  /** key 为本地日期（YYYY-MM-DD） */
  days: Map<string, DayBucket>;
  /** 每条提交的墙钟分钟（见 overtime.ts）；窗口过滤放到聚合时做 */
  minutes: number[];
  /** 全历史最近一次提交的日期。「最近一次提交距今」是绝对问题，不随窗口变。 */
  lastDate: string | null;
}

/** 解析 `%aI|%an|%ae` 行，按天存放提交数、小时分布与作者。 */
function parseLog(output: string): ParsedLog {
  const days = new Map<string, DayBucket>();
  const minutes: number[] = [];
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

    let bucket = days.get(date);
    if (!bucket) {
      bucket = { count: 0, hours: new Array<number>(hourCount).fill(0), authors: new Map() };
      days.set(date, bucket);
    }
    bucket.count += 1;
    if (!lastDate || date > lastDate) lastDate = date;

    const hour = Number(timestamp.slice(11, 13));
    if (Number.isInteger(hour) && hour >= 0 && hour < hourCount) bucket.hours[hour] += 1;

    accumulateAuthorSample(bucket.authors, { name: author, email, commits: 1, additions: 0, deletions: 0 });

    const wallClock = wallClockMinute(timestamp);
    if (wallClock !== null) minutes.push(wallClock);
  }

  return { days, minutes, lastDate };
}

/** 一个仓库在某个窗口内的全部提交派生数据。 */
interface WindowedLog {
  daily: Record<string, number>;
  hourly: number[][];
  authors: Map<string, AuthorSample>;
  minutes: number[];
  total: number;
}

/**
 * 把全历史日志裁剪到 `[start, end]`（本地日期，闭区间）。
 *
 * 日期是 `YYYY-MM-DD` 的定长串，直接比大小就是按时间比，不用建 Date。
 * 墙钟分钟则换算成「第几天」再比：两边都按 UTC 天算（见 `dayIndexFromIso`），
 * 跨午夜的段在日边界上切得开，非上班时长不会因为窗口换了起点而错位。
 */
function windowLog(log: ParsedLog, start: string, end: string): WindowedLog {
  const daily: Record<string, number> = {};
  const hourly = emptyHourly();
  const authors = new Map<string, AuthorSample>();
  let total = 0;

  for (const [date, bucket] of log.days) {
    if (date < start || date > end) continue;
    daily[date] = bucket.count;
    total += bucket.count;

    const weekday = weekdayIndex(date);
    for (let hour = 0; hour < hourCount; hour += 1) hourly[weekday][hour] += bucket.hours[hour];
    for (const sample of bucket.authors.values()) accumulateAuthorSample(authors, sample);
  }

  const startDay = dayIndexFromIso(start);
  const endDay = dayIndexFromIso(end);
  const minutes = log.minutes.filter((minute) => {
    const day = Math.floor(minute / minutesPerDay);
    return day >= startDay && day <= endDay;
  });

  return { daily, hourly, authors, minutes, total };
}

/**
 * 一个仓库这一轮读到的原始结果。
 *
 * `log` 是**全历史**（缓存单位），窗口裁剪留给聚合阶段做——时间段是可变的，
 * 缓存不能跟着变，否则每切一次时间段就要把所有仓库重扫一遍。
 */
interface RepositoryScan {
  repositoryId: string;
  repositoryName: string;
  /** 目录读不到 / 不是 Git 仓库；有提交的空仓库不算 */
  unreadable: boolean;
  log: ParsedLog | null;
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
 * 1. 全历史 log（按天存放的提交数 / 小时分布 / 作者 / 墙钟分钟）——只跟引用有关，
 *    引用没动就一直有效；时间段变了也不用重扫，从这份缓存里挑日期求和即可；
 * 2. 逐提交代码量——跟引用和窗口起点都有关；
 * 3. 由 1、2 折出来的汇总——每次现算，微秒级，不值得再存一层。
 *
 * 第 1 项以前没有缓存：它每次请求都把 23 个仓库的全部历史重扫一遍。实测
 * 冷启动 3.88s 里有 0.13s 花在这里，看着不多，但它是**每 60 秒、每次切回窗口**
 * 都要重付一次的固定开销。加了时间段开关之后更不能每次重扫：用户点一下
 * 「近 3 个月」，若要从 git 读，就得把所有仓库的历史重新拉一遍。
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

  // 窗口变了（用户切了时间段）也先走增量：`rev-list --since` 拿到新窗口的 sha 集合，
  // 只 diff 新进入窗口的那些提交。窗口收窄时一条都不用 diff（全部命中基线），
  // 只有放宽时才补算多出来的老提交——比一刀切重跑全量省得多。
  if (previous) {
    const refined = await refreshCodeVolume(cwd, windowStart, previous.volumeCommits).catch(() => null);
    if (refined) return { value: aggregateCommitVolumes(refined.values()), commits: refined, windowStart };
  }

  return fullCodeVolumeScan(cwd, windowStart);
}

async function readRepositoryDaily(
  config: RepositoriesConfig,
  repository: RepositoriesConfig['repositories'][number],
  windowStart: string,
): Promise<RepositoryScan> {
  const empty: RepositoryScan = {
    repositoryId: repository.id,
    repositoryName: repository.name,
    unreadable: false,
    log: null,
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

  return { ...empty, log, volume: volume.value };
}

/**
 * 从所有启用仓库聚合 commit 热力图数据。
 *
 * 刻意**不**调用 `scanDashboardRepositories`：那套扫描会为每个仓库跑 `git status`、
 * ahead/behind 和 tag 列表，热力图一个都用不上，却要为此多花一倍以上的时间。
 * 仓库是否可用直接由 `git log` 的成败决定，语义还更准。
 */
export interface CommitHeatmapOptions {
  /** 统计最近多少周；非法值回落到默认（近一年）。 */
  weeks?: unknown;
}

export async function aggregateCommitHeatmap(
  config: RepositoriesConfig,
  options: CommitHeatmapOptions = {},
): Promise<CommitHeatmapData> {
  const repositories = config.repositories.filter((repository) => repository.enabled);
  const weeks = normalizeAnalyticsWeeks(options.weeks ?? defaultAnalyticsWeeks);
  // 窗口定义和客户端画格子用的是同一份（shared/report-window.ts），
  // 客户端按 weeks 自己算一遍起止日期，服务端把算出来的结果回传一份用于对账
  const range = reportWindow(new Date(), weeks);
  const windowStart = range.start;

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
  let activeRepos = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  // 所有仓库的提交时间混在一条时间轴上切工作段：晚上先改 A 仓库、
  // 再改 B 仓库，仍然是同一个人连着干了两个小时，不该因为换了目录就断成两段。
  const allMinutes: number[] = [];
  const unreadableNames: string[] = [];

  for (const result of results) {
    if (result.unreadable) unreadableNames.push(result.repositoryName);
    if (!result.log) continue;

    // 「有提交记录的仓库数」按全历史算：它只用来判断「有没有东西可看」，
    // 若也跟着窗口走，用户把时间段收窄到没提交的一周，整页会退化成「暂无数据」。
    if (result.log.lastDate !== null) activeRepos += 1;

    const windowed = windowLog(result.log, range.start, range.end);
    // 用循环而不是 push(...arr)：单仓库十万级提交时展开参数会爆栈
    for (const minute of windowed.minutes) allMinutes.push(minute);
    for (const sample of windowed.authors.values()) accumulateAuthorSample(authorSamples, sample);
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

    if (windowed.total === 0) continue;

    byRepo.push({
      repositoryId: result.repositoryId,
      repositoryName: result.repositoryName,
      total: windowed.total,
      // 最近一次提交是绝对时间，不随窗口变；活跃度卡与「窗口内活跃仓库」都靠它
      lastCommitDate: result.log.lastDate,
      additions: result.volume.totals.additions,
      deletions: result.volume.totals.deletions,
    });

    totalCommits += windowed.total;

    for (const [date, count] of Object.entries(windowed.daily)) {
      daily[date] = (daily[date] ?? 0) + count;
      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;
    }

    for (let weekday = 0; weekday < weekdayCount; weekday += 1) {
      for (let hour = 0; hour < hourCount; hour += 1) {
        hourly[weekday][hour] += windowed.hourly[weekday][hour];
      }
    }
  }

  byRepo.sort((a, b) => b.total - a.total || a.repositoryName.localeCompare(b.repositoryName));

  // 作者只保留前 50：前端最多展示 10 个，多传的是纯冗余。
  const byAuthor = resolveAuthors([...authorSamples.values()]).slice(0, 50);

  return {
    range: { weeks, label: analyticsRangeLabel(weeks), start: range.start, end: range.end },
    daily,
    hourly,
    byRepo,
    byAuthor,
    codeVolume,
    overtime: summarizeOvertime(allMinutes),
    summary: {
      totalCommits,
      totalRepos: repositories.length,
      activeRepos,
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
