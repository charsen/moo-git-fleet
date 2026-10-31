import os from 'node:os';
import { mapWithConcurrency } from '../concurrency.js';
import type { AnalyticsRepositoryScope, CommitHeatmapData, RepositoriesConfig } from '../../shared/contracts.js';
import { analyticsRepositoryScopeSchema } from '../../shared/schemas.js';
import { runGitText } from '../git/runner.js';
import { resolveRepositoryPath } from '../config/store.js';
import {
  dayIndexFromIso,
  resolveAnalyticsRange,
  shiftIsoDays,
  type ResolvedAnalyticsRange,
} from '../../shared/report-window.js';
import { summarizeOvertime, wallClockMinute } from './overtime.js';
import { accumulateAuthorSample, resolveAuthors, type AuthorSample } from './author-identity.js';
import {
  loadScanRecord,
  resetScanRecordQueue,
  scheduleScanRecordSave,
  type CachedScan,
  type DayBucket,
  type ParsedLog,
} from './scan-cache.js';
import {
  addCodeVolumeTotals,
  aggregateCommitVolumes,
  emptyCodeVolume,
  parseNumstatCommits,
  reconcileCommitVolumes,
  type CodeVolumeTotals,
  type CommitCodeVolume,
  type ParsedCodeVolume,
  type VolumeWindow,
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
/**
 * 同时扫描的仓库数。
 *
 * 冷启动时这条链是 CPU 密集的（每个仓库一次全历史 log + 一次 numstat diff），
 * 所以按机器核数取，而不是写死 6：这台 14 核机器上 6 → 10 让冷启动 5.24 s → 4.68 s。
 * 上限压到 10，避免在核心数更多的机器上把交互请求挤掉；下限 4，小机器上不至于退步。
 */
const repoConcurrency = Math.max(4, Math.min(10, Math.floor(os.availableParallelism() * 0.75)));

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

/** 解析 `%aI|%an|%ae` 行，按天存放提交数、小时分布与作者。 */
function parseLog(output: string): ParsedLog {
  const days = new Map<string, DayBucket>();
  const allAuthors = new Map<string, AuthorSample>();
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
    accumulateAuthorSample(allAuthors, { name: author, email, commits: 1, additions: 0, deletions: 0 });
    if (!lastDate || date > lastDate) lastDate = date;

    const hour = Number(timestamp.slice(11, 13));
    if (Number.isInteger(hour) && hour >= 0 && hour < hourCount) bucket.hours[hour] += 1;

    accumulateAuthorSample(bucket.authors, { name: author, email, commits: 1, additions: 0, deletions: 0 });

    const wallClock = wallClockMinute(timestamp);
    if (wallClock !== null) minutes.push(wallClock);
  }

  return { days, allAuthors, minutes, lastDate };
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
  /** 读不到时 git 给出的原因（第一行）；可读时为 null */
  reason: string | null;
  log: ParsedLog | null;
  /** 窗口内的增删行（已剔除生成文件） */
  volume: ParsedCodeVolume;
  /** 代码量还在后台算，`volume` 是全零占位 */
  volumePending: boolean;
}

/**
 * 从 `runGitText` 抛出的错误里取一句能直接给用户看的原因。
 *
 * `runGitText` 用 stderr 作为 message，可能有多行（`fatal:` 后面还跟着提示）。
 * 只留第一行：界面上是卡片里的一行小字，多行会把版面撑开。
 */
function gitFailureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  if (!firstLine) return 'git 命令执行失败';
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/** 出现次数最多的失败原因；并列时取先遇到的那条。 */
function pickMostCommonReason(reasons: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of reasons) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
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

/**
 * 分析结果缓存，键是仓库的绝对路径。
 *
 * 三件事都按仓库缓存，而且**失效条件各不相同**：
 * 1. 全历史 log（按天存放的提交数 / 小时分布 / 作者 / 墙钟分钟）——只跟引用有关，
 *    引用没动就一直有效；时间段变了也不用重扫，从这份缓存里挑日期求和即可；
 * 2. 逐提交代码量——跟引用有关；窗口只决定「聚合时筛哪些」，不再决定缓存存什么；
 * 3. 由 1、2 折出来的汇总——每次现算，微秒级，不值得再存一层。
 *
 * 内存这份是热的，磁盘那份（`scan-cache.ts`）管重启：进程起来第一次开分析页时，
 * 内存是空的，但签名没变的话磁盘上的答案仍然逐字有效，不必重跑那 15 秒的 numstat。
 */
const scanCache = new Map<string, CachedScan>();

/** 仓库列表可能被反复增删，缓存不设上限的话会一直长。 */
const scanCacheLimit = 256;

/**
 * 内存上限：提交时间条数与天数各一档，超了**逐条**淘汰最久没被用到的条目。
 *
 * 以前只算提交时间、超了整体清空：按天存的桶（每天 24 个计数 + 作者 map）
 * 完全没被计数，而且清空之后每个请求都要重新全量扫一遍——一次超限会引发
 * 一轮雪崩。现在两个维度都算，淘汰只丢最旧的那几个。
 */
const maxCachedMinutes = 500_000;
const maxCachedDays = 60_000;

let cachedMinuteCount = 0;
let cachedDayCount = 0;

export function resetAnalyticsCache(): void {
  scanCache.clear();
  cachedMinuteCount = 0;
  cachedDayCount = 0;
  resetScanRecordQueue();
}

/** 命中时把它挪到 Map 末尾：Map 的插入顺序就是这里的 LRU 顺序。 */
function touchScan(cwd: string, entry: CachedScan): void {
  scanCache.delete(cwd);
  scanCache.set(cwd, entry);
}

function evictOldestScan(): void {
  const oldest = scanCache.keys().next();
  if (oldest.done) return;
  const entry = scanCache.get(oldest.value);
  scanCache.delete(oldest.value);
  if (entry) {
    cachedMinuteCount -= entry.minuteCount;
    cachedDayCount -= entry.dayCount;
  }
}

function storeScan(cwd: string, entry: CachedScan): void {
  const previous = scanCache.get(cwd);
  if (previous) {
    cachedMinuteCount -= previous.minuteCount;
    cachedDayCount -= previous.dayCount;
    scanCache.delete(cwd);
  }
  scanCache.set(cwd, entry);
  cachedMinuteCount += entry.minuteCount;
  cachedDayCount += entry.dayCount;

  // 逐条淘汰，不清空：清空之后每个仓库都要重扫一遍，代价远大于多留几个条目
  while (scanCache.size > scanCacheLimit || cachedMinuteCount > maxCachedMinutes || cachedDayCount > maxCachedDays) {
    const oldest = scanCache.keys().next();
    if (oldest.done || oldest.value === cwd) break;
    evictOldestScan();
  }
}

interface VolumeScan {
  /** 已按请求窗口过滤好的汇总 */
  value: ParsedCodeVolume;
  /** 逐提交记录，作为下一次增量重算的基线（只增不减） */
  commits: Map<string, CommitCodeVolume>;
  /** 基线已经扫到的最早日期，窗口起点在 `readCodeVolume` 里现算，不必回传 */
  scannedFrom: string;
}

function emptyVolumeScan(scannedFrom: string): VolumeScan {
  return { value: emptyCodeVolume(), commits: new Map(), scannedFrom };
}

/**
 * `--since` 的容错余量（天）。
 *
 * `--since` 按 **committer date** 粗筛，而窗口按 **author date** 精确裁。
 * 两者的差通常为零，但 rebase / cherry-pick 之后可能差出很多天：一笔作者日期在
 * 窗口内、提交日期却在窗口之前的提交，会被 `--since` 直接筛掉，`aggregateCommitVolumes`
 * 的日期过滤根本没机会看到它。多扫两个月再在内存里裁，结果就不再依赖「先扫过哪段」。
 */
const scanMarginDays = 90;

/** 从 `coarseFrom` 起的提交 sha。`rev-list` 只走拓扑、不产生 diff，比 numstat 快两个数量级。 */
async function listWindowCommits(cwd: string, coarseFrom: string): Promise<string[]> {
  const output = await runGitText(
    cwd,
    ['rev-list', '--branches', '--remotes', '--tags', 'HEAD', '--no-merges', `--since=${coarseFrom}`],
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
      // `%aI` 是作者日期：窗口判据用它，不能用 `--since` 的 committer date，
      // 否则 rebase / cherry-pick 过的提交会和热力图算在不同的日子里
      '--format=%x01%H|%aI|%ae|%an',
      '--encoding=UTF-8',
    ],
    codeVolumeTimeoutMs,
    shas.join('\n'),
  );
  return parseNumstatCommits(output);
}

/**
 * 从 `scanFrom` 起全量扫一遍 numstat。
 *
 * `--since` 只用来把 diff 的量降下来（按 committer date 粗筛），最终窗口由
 * `aggregateCommitVolumes(commits, window)` 按 **author date** 精确裁——
 * 两个数（热力图与代码量）必须落在同一批提交上。
 */
async function fullCodeVolumeScan(cwd: string, scanFrom: string, window: VolumeWindow): Promise<VolumeScan> {
  const output = await runGitText(
    cwd,
    [
      'log',
      '--branches',
      '--remotes',
      '--tags',
      'HEAD',
      '--no-merges',
      `--since=${scanFrom}`,
      // 显式打开重命名识别：默认值受用户 diff.renames 配置影响，关掉的话
      // 一次重命名会被记成「删掉 300 行又新增 300 行」的假改动
      '-M',
      '--numstat',
      '--format=%x01%H|%aI|%ae|%an',
      '--encoding=UTF-8',
    ],
    codeVolumeTimeoutMs,
  );

  const commits = new Map<string, CommitCodeVolume>();
  for (const commit of parseNumstatCommits(output)) commits.set(commit.sha, commit);
  return {
    value: aggregateCommitVolumes(commits.values(), window),
    commits,
    scannedFrom: scanFrom,
  };
}

/**
 * 增量重算：只 diff 这次窗口里新出现的提交，窗口外的旧账原样留着。
 *
 * 契约是「返回值可信，或返回 null」。null 表示基线不可信，调用方必须退回全量扫描。
 * `keepBefore = windowStart` 让 `reconcileCommitVolumes` 只裁窗口内的账——
 * 收窄窗口时不再把更早的提交从基线里删掉，下次放宽就不用重新 diff。
 */
async function refreshCodeVolume(
  cwd: string,
  windowStart: string,
  commits: Map<string, CommitCodeVolume>,
): Promise<Map<string, CommitCodeVolume> | null> {
  const listed = await listWindowCommits(cwd, shiftIsoDays(windowStart, -scanMarginDays)).catch(() => null);
  if (listed === null) return null;

  const added = listed.filter((sha) => !commits.has(sha));
  const fresh = added.length === 0 ? [] : await numstatForCommits(cwd, added).catch(() => null);
  if (fresh === null) return null;

  return reconcileCommitVolumes(commits, listed, fresh, windowStart);
}

async function readCodeVolume(
  cwd: string,
  window: VolumeWindow,
  previous: CachedScan | undefined,
  refsUnchanged: boolean,
): Promise<VolumeScan> {
  const windowStart = window.start;
  // 粗筛起点比窗口再早一点，用来兜住 author / committer 分叉的提交
  const coarseFrom = shiftIsoDays(windowStart, -scanMarginDays);

  // 基线已经扫到这个粗筛起点（或更早）
  if (previous && previous.volumeScannedFrom <= coarseFrom) {
    if (refsUnchanged) {
      // 引用没动：连 rev-list 都不用跑，直接从基线里按日期筛
      return {
        value: aggregateCommitVolumes(previous.volumeCommits.values(), window),
        commits: previous.volumeCommits,
        scannedFrom: previous.volumeScannedFrom,
      };
    }
    const refined = await refreshCodeVolume(cwd, windowStart, previous.volumeCommits).catch(() => null);
    if (refined) {
      return {
        value: aggregateCommitVolumes(refined.values(), window),
        commits: refined,
        scannedFrom: previous.volumeScannedFrom,
      };
    }
  }

  // 需要更早的历史：从「已有基线起点」与「本次粗筛起点」里更早的那个扫起，
  // 一次扫宽之后，之后所有更窄的窗口都是纯内存筛选。
  const scanFrom = previous && previous.volumeScannedFrom < coarseFrom ? previous.volumeScannedFrom : coarseFrom;
  return fullCodeVolumeScan(cwd, scanFrom, window);
}

/**
 * 后台跑代码量扫描，跑完自己写缓存。
 *
 * 键是「仓库 + 窗口起点」：同一个仓库被两个不同窗口同时点名时，两次基线不同，
 * 不能让后一次直接复用前一次的 promise。同一个键已经在跑就不重复起进程。
 */
const backgroundVolumeScans = new Map<string, Promise<void>>();

function scheduleBackgroundVolume(
  cwd: string,
  window: VolumeWindow,
  previous: CachedScan | undefined,
  refsUnchanged: boolean,
  signature: string | null,
  log: ParsedLog,
): void {
  const key = `${cwd}\u0000${window.start}`;
  if (backgroundVolumeScans.has(key)) return;
  const task = (async () => {
    const volume = await readCodeVolume(cwd, window, previous, refsUnchanged).catch(() => null);
    if (!volume || !signature) return;
    const entry: CachedScan = {
      signature,
      log,
      volumeCommits: volume.commits,
      volumeScannedFrom: volume.scannedFrom,
      minuteCount: log.minutes.length,
      dayCount: log.days.size,
    };
    storeScan(cwd, entry);
    scheduleScanRecordSave(cwd, entry);
  })()
    .catch(() => undefined)
    .finally(() => backgroundVolumeScans.delete(key));
  backgroundVolumeScans.set(key, task);
}

/** 等所有后台代码量扫描跑完。测试用；生产路径不等，正是它存在的意义。 */
export async function flushBackgroundVolumeScans(): Promise<void> {
  while (backgroundVolumeScans.size > 0) {
    await Promise.all([...backgroundVolumeScans.values()]);
  }
}

async function readRepositoryDaily(
  config: RepositoriesConfig,
  repository: RepositoriesConfig['repositories'][number],
  window: VolumeWindow,
  deferVolume: boolean,
): Promise<RepositoryScan> {
  const empty: RepositoryScan = {
    repositoryId: repository.id,
    repositoryName: repository.name,
    unreadable: false,
    reason: null,
    log: null,
    volume: emptyCodeVolume(),
    volumePending: false,
  };

  let cwd: string;
  try {
    cwd = resolveRepositoryPath(config, repository);
  } catch {
    // 路径本身配错了（比如 root 不存在），连 git 都跑不起来
    return { ...empty, unreadable: true };
  }

  const signature = await refSignature(cwd);
  let previous = signature ? scanCache.get(cwd) : undefined;
  if (signature && !previous) {
    // 内存里没有，但磁盘上可能有上一次进程算好的答案。签名一致就直接拿来用：
    // 这一步把「重启后第一次开分析页」从重跑 15 秒 numstat 变成读一个文件。
    const persisted = await loadScanRecord(cwd, signature);
    if (persisted) {
      storeScan(cwd, persisted);
      previous = persisted;
    }
  }
  // 签名是「全部引用 + HEAD」的哈希：它没变，就说明窗口内外都没有新提交，
  // 上一次的 log 结果逐字等于这一次的答案
  const refsUnchanged = Boolean(previous && signature && previous.signature === signature);
  // 命中就挪到 LRU 末尾；没命中也没关系（下面会重新写进去）
  if (previous) touchScan(cwd, previous);

  // 两个 git 调用互不依赖，并行发出去：主 log 走全历史，numstat 走「基线起点」。
  // 走缓存时两者都是 Promise.resolve，实际只在冷启动那天各跑一次。
  // 代码量要不要等：基线已经覆盖粗筛起点就不用等（内存或磁盘缓存命中）；
  // 需要重新 diff 时，只有首屏请求（deferVolume）才把它推到后台。
  const coarseFrom = shiftIsoDays(window.start, -scanMarginDays);
  const volumeReady = Boolean(previous && previous.volumeScannedFrom <= coarseFrom);
  const defer = deferVolume && !volumeReady;

  let failure: string | null = null;
  const [log, volume] = await Promise.all([
    previous && refsUnchanged
      ? Promise.resolve(previous.log)
      : runGitText(cwd, logArguments, logTimeoutMs)
          .then(parseLog)
          .catch((error: unknown) => {
            // 顺手留下 stderr：下面判定「不可读」之后要把它交给界面，
            // 否则界面只能猜原因（「目录不可访问」），猜错了会把人引到错的地方。
            failure = gitFailureReason(error);
            return null;
          }),
    // 失败时给一份「从窗口起点起、零提交」的空基线：`scannedFrom` 落在窗口内，
    // 下一次请求必然判为「基线不够早」而走全量重扫，不会把空结果当成完整答案缓存下来。
    defer
      ? Promise.resolve(emptyVolumeScan(window.start))
      : readCodeVolume(cwd, window, previous, refsUnchanged).catch(() => emptyVolumeScan(window.start)),
  ]);

  if (log === null) {
    // 目录不存在、不是 git 仓库、没有提交（HEAD 无法解析）都走这里。
    // 单个仓库读不到不影响整体结果；但「读不到」和「没提交」要分开报，
    // 否则界面上那句「还没有提交记录」会替一个坏路径背锅。
    //
    // 只有真的不可读才带原因：空仓库的 `git log` 也会失败（`ambiguous argument
    // 'HEAD'`），把那句话显示出来只会让人以为仓库坏了。
    const readable = await isGitRepository(cwd);
    return { ...empty, unreadable: !readable, reason: readable ? null : failure };
  }

  if (defer) {
    // 后台算完自己会写缓存，这里只负责把任务发出去。不能先存一份空基线：
    // `volumeScannedFrom` 若落在窗口内，下一次请求会把它当成「这段已经算过」，
    // 于是永远返回 0 行。
    scheduleBackgroundVolume(cwd, window, previous, refsUnchanged, signature, log);
    return { ...empty, log, volumePending: true };
  }

  if (signature) {
    const entry: CachedScan = {
      signature,
      log,
      volumeCommits: volume.commits,
      volumeScannedFrom: volume.scannedFrom,
      minuteCount: log.minutes.length,
      dayCount: log.days.size,
    };
    storeScan(cwd, entry);
    scheduleScanRecordSave(cwd, entry);
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
  /** 自定义时间段的起止日期（本地 `YYYY-MM-DD`，闭区间）；两个都给才生效。 */
  start?: unknown;
  end?: unknown;
  repositoryIds?: AnalyticsRepositoryScope;
  /**
   * 首屏只要提交数：代码量没缓存时推到后台算，本次返回全零 + `volumePending`。
   * 缺省为 false（等算完再返回），因为只有页面首屏值得这么做。
   */
  deferVolume?: unknown;
}

export async function aggregateCommitHeatmap(
  config: RepositoriesConfig,
  options: CommitHeatmapOptions = {},
): Promise<CommitHeatmapData> {
  const repositoryScope = analyticsRepositoryScopeSchema.parse(options.repositoryIds ?? null);
  const selectedIds = repositoryScope === null ? null : new Set(repositoryScope);
  const repositories = config.repositories.filter((repository) => repository.enabled
    && (selectedIds === null || selectedIds.has(repository.id)));
  const range = resolveAnalyticsRange(options);

  // 同一时刻只跑一次：60 秒轮询 + 手动刷新 + 多开一个窗口，会同时来三份同样的请求，
  // 缓存能兜住「结果」，兜不住「同时进行的重复扫描」。
  // 键用解析后的起止日期：预设和自定义最终都落到同一对日期上，同一天的两个入口
  // （比如「近一年」与手选 364 天）本来就该共用一次扫描。
  // 键里带上 deferVolume：首屏请求（不等代码量）与完整请求的返回值不同，不能共用一次执行
  const flightKey = JSON.stringify([
    range.start,
    range.end,
    repositoryScope,
    Boolean(options.deferVolume),
    repositories.map((repository) => repository.id),
  ]);
  const running = inFlightScans.get(flightKey);
  if (running) return running;

  const deferVolume = Boolean(options.deferVolume);
  const task = runAggregate(config, repositories, range, repositoryScope, deferVolume).finally(() =>
    inFlightScans.delete(flightKey),
  );
  inFlightScans.set(flightKey, task);
  return task;
}

/** 正在跑的聚合请求，键是「窗口 + 仓库集合」。 */
const inFlightScans = new Map<string, Promise<CommitHeatmapData>>();

async function runAggregate(
  config: RepositoriesConfig,
  repositories: RepositoriesConfig['repositories'],
  range: ResolvedAnalyticsRange,
  repositoryScope: AnalyticsRepositoryScope,
  deferVolume: boolean,
): Promise<CommitHeatmapData> {
  // 窗口已经由 `resolveAnalyticsRange` 定好（预设走整周，自定义精确到天），
  // 客户端照回传的 start/end 画格子，两边不算第二遍。
  const results = await mapWithConcurrency(
    repositories,
    repoConcurrency,
    (repository) => readRepositoryDaily(config, repository, range, deferVolume),
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
  /** 失败原因 → 出现次数。53 个仓库全挂时通常只有一种原因，去重后只说一句。 */
  const unreadableReasons = new Map<string, number>();

  for (const result of results) {
    if (result.unreadable) {
      unreadableNames.push(result.repositoryName);
      if (result.reason) unreadableReasons.set(result.reason, (unreadableReasons.get(result.reason) ?? 0) + 1);
    }
    if (!result.log) continue;

    // 「有提交记录的仓库数」按全历史算：它只用来判断「有没有东西可看」，
    // 若也跟着窗口走，用户把时间段收窄到没提交的一周，整页会退化成「暂无数据」。
    if (result.log.lastDate !== null) activeRepos += 1;

    // 身份归并看全历史：窗口外的写法也要能认出来，否则窄窗口下同一个人会拆成两行。
    // 只加集合、不加计数（commits/additions 记 0），数字仍由窗口内的样本决定。
    for (const sample of result.log.allAuthors.values()) {
      accumulateAuthorSample(authorSamples, {
        name: sample.name,
        email: sample.email,
        commits: 0,
        additions: 0,
        deletions: 0,
      });
    }

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

    // 有历史提交的仓库一律进 byRepo，窗口内 0 提交的也进（total = 0）。
    // 活跃度卡是「最近一次提交距今」，按全历史分桶；把这些仓库漏掉，
    // 选窄窗口时「91 天以上」那一档就会凭空变少。
    byRepo.push({
      repositoryId: result.repositoryId,
      repositoryName: result.repositoryName,
      total: windowed.total,
      // 最近一次提交是绝对时间，不随窗口变；活跃度卡与「窗口内活跃仓库」都靠它
      lastCommitDate: result.log.lastDate,
      additions: result.volume.totals.additions,
      deletions: result.volume.totals.deletions,
    });

    if (windowed.total === 0) continue;

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
  // 先滤掉「全历史有过、这个窗口里没有」的人：他们的计数全是 0，只会占位。
  const byAuthor = resolveAuthors([...authorSamples.values()])
    .filter((author) => author.commits > 0 || author.additions > 0 || author.deletions > 0)
    .slice(0, 50);

  return {
    repositoryScope,
    range: { kind: range.kind, weeks: range.weeks, label: range.label, start: range.start, end: range.end },
    daily,
    hourly,
    byRepo,
    byAuthor,
    codeVolume,
    // 有任何一个仓库的代码量还在后台算，整份数字就不可信，得让客户端回来再取一次
    volumePending: results.some((result) => result.volumePending),
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
        // 取出现次数最多的那条：多个仓库同因失败时，界面上说一句就够；
        // 并列时取先遇到的（Map 保序），结果稳定。
        reason: pickMostCommonReason(unreadableReasons),
      },
    },
  };
}
