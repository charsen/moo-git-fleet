import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuthorSample } from './author-identity.js';
import type { CommitCodeVolume } from './code-volume.js';

/**
 * 热力图扫描结果的**磁盘**缓存。
 *
 * 为什么要落盘：一次全量扫描要跑两遍 git——全历史 log（58 个真实仓库合计 1.6 s）
 * 与逐提交 numstat（合计 15.1 s，最慢的一个仓库独占 4.1 s）。这些结果只跟「引用」
 * 有关，引用没动就逐字等于上一次的答案，可它以前只活在内存里：每次重启应用、
 * 或者条目被 LRU 挤掉，都要重付一遍，实测冷启动 5.3 s。
 *
 * 不变量：**签名一致才可用**。签名是 `refs + HEAD` 的哈希（见 heatmap 的
 * `refSignature`），任何一个分支、tag、远端引用变动都会让它变，于是缓存自动失效。
 * 工作区改动不影响统计口径（`--no-merges` 的提交集合），所以不必进签名。
 *
 * 磁盘格式是一份带版本号的 JSON；读失败、版本不符、路径不符、签名不符、字段形状
 * 不对，一律当作没有缓存——宁可多扫一遍，也不能把坏数据当答案。
 */
export interface DayBucket {
  count: number;
  /** 24 个小时的提交数，索引是 `%aI` 里的作者本地小时 */
  hours: number[];
  /** key 为 `authorSampleKey`（名字 + 邮箱），详见 author-identity.ts */
  authors: Map<string, AuthorSample>;
}

export interface ParsedLog {
  /** key 为本地日期（YYYY-MM-DD） */
  days: Map<string, DayBucket>;
  /**
   * 全历史的作者样本（提交数按全历史计）。
   *
   * 用途只有一个：**身份归并**。时间段可调之后，如果只用窗口内的样本去归并，
   * 一个人的另一种写法（`charsen` / `charsen fung`）只要窗口外才出现过，窄窗口下
   * 就会拆成两行、`含别名` 也会少一个。计数仍然走窗口内的样本。
   */
  allAuthors: Map<string, AuthorSample>;
  /** 每条提交的墙钟分钟（见 overtime.ts）；窗口过滤放到聚合时做 */
  minutes: number[];
  /** 全历史最近一次提交的日期。「最近一次提交距今」是绝对问题，不随窗口变。 */
  lastDate: string | null;
}

export interface CachedScan {
  /** 缓存时的引用签名，见 heatmap 的 `refSignature` */
  signature: string;
  /** 全历史 log 的解析结果，与窗口无关，只要引用没动就一直有效 */
  log: ParsedLog;
  /**
   * 逐提交代码量基线，只增不减。
   *
   * `volumeScannedFrom` 是这份基线**已经扫到的最早日期**：基线覆盖
   * `[scannedFrom, 今天]`。用户把窗口收窄时不再裁剪基线（裁剪会让下次放宽
   * 重新 diff，实测多付 2.8 秒），只有在窗口比它更早时才需要重新扫一段。
   */
  volumeCommits: Map<string, CommitCodeVolume>;
  volumeScannedFrom: string;
  /** 这个条目占了多少条提交时间，用于控制总内存 */
  minuteCount: number;
  /** 这个条目占了多少天（按天存的桶也要计入内存） */
  dayCount: number;
}

/** 格式变了就把版本 +1，旧文件自然失效，不用写迁移。 */
const cacheVersion = 1;
/**
 * 目录现算，不在模块顶层定死：`GIT_FLEET_HOME` 是进程级配置，测试要在导入之后
 * 才 stub 环境变量，顶层捕获会让它们全部写进仓库目录。
 */
function cacheDirectory(): string {
  return path.join(path.resolve(process.env.GIT_FLEET_HOME ?? process.cwd()), '.data', 'analytics-scan');
}
/**
 * 单条记录的上限。58 个真实仓库里最大的一条约 3 MB；设 48 MB 是为了拦住
 * 「某个仓库有几十万提交」这种极端情况——那种记录读回来的解析开销比重新扫还大。
 */
const maxRecordBytes = 48 * 1024 * 1024;
/** 合并短时间内的多次写入：一次冷启动会连续存 58 个仓库，逐个落盘会互相打断。 */
const writeDelayMs = 500;

interface ScanRecord {
  version: number;
  cwd: string;
  signature: string;
  log: {
    days: [string, number, number[], [string, AuthorSample][]][];
    allAuthors: [string, AuthorSample][];
    minutes: number[];
    lastDate: string | null;
  };
  volumeCommits: [string, CommitCodeVolume][];
  volumeScannedFrom: string;
}

const pendingWrites = new Map<string, CachedScan>();
const writeTimers = new Map<string, NodeJS.Timeout>();

function recordPath(cwd: string): string {
  // 用路径哈希当文件名：路径本身可能带分隔符与中文，直接拼不安全，也容易超长
  return path.join(cacheDirectory(), `${createHash('sha1').update(cwd).digest('hex')}.json`);
}

function toRecord(cwd: string, entry: CachedScan): ScanRecord {
  return {
    version: cacheVersion,
    cwd,
    signature: entry.signature,
    log: {
      days: [...entry.log.days].map(([date, bucket]) => [
        date,
        bucket.count,
        bucket.hours,
        [...bucket.authors],
      ]),
      allAuthors: [...entry.log.allAuthors],
      minutes: entry.log.minutes,
      lastDate: entry.log.lastDate,
    },
    volumeCommits: [...entry.volumeCommits],
    volumeScannedFrom: entry.volumeScannedFrom,
  };
}

/** 一天固定 24 个小时槽。必须与 heatmap 的 `hourCount` 一致，否则小时热力图会错位。 */
const hourSlots = 24;

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number');

const isAuthorSample = (value: unknown): value is AuthorSample => {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Partial<AuthorSample>;
  return (
    typeof sample.name === 'string' &&
    typeof sample.email === 'string' &&
    typeof sample.commits === 'number' &&
    typeof sample.additions === 'number' &&
    typeof sample.deletions === 'number'
  );
};

/**
 * 反序列化。任何一处形状不对就整条丢弃——半份缓存比没有缓存更危险，
 * 它会让某几天的提交数悄悄少掉，而界面上看不出来。
 */
function fromRecord(record: ScanRecord): CachedScan | null {
  if (!record.log || !Array.isArray(record.log.days) || !Array.isArray(record.log.allAuthors)) return null;
  if (!isNumberArray(record.log.minutes)) return null;
  if (!Array.isArray(record.volumeCommits)) return null;
  if (typeof record.volumeScannedFrom !== 'string' || record.volumeScannedFrom === '') return null;

  const days = new Map<string, DayBucket>();
  for (const item of record.log.days) {
    if (!Array.isArray(item) || item.length !== 4) return null;
    const [date, count, hours, authors] = item;
    if (typeof date !== 'string' || typeof count !== 'number') return null;
    if (!isNumberArray(hours) || hours.length !== hourSlots || !Array.isArray(authors)) return null;
    const authorMap = new Map<string, AuthorSample>();
    for (const author of authors) {
      if (!Array.isArray(author) || author.length !== 2) return null;
      if (typeof author[0] !== 'string' || !isAuthorSample(author[1])) return null;
      authorMap.set(author[0], author[1]);
    }
    days.set(date, { count, hours, authors: authorMap });
  }

  const allAuthors = new Map<string, AuthorSample>();
  for (const author of record.log.allAuthors) {
    if (!Array.isArray(author) || author.length !== 2) return null;
    if (typeof author[0] !== 'string' || !isAuthorSample(author[1])) return null;
    allAuthors.set(author[0], author[1]);
  }

  const volumeCommits = new Map<string, CommitCodeVolume>();
  for (const item of record.volumeCommits) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [sha, volume] = item;
    if (typeof sha !== 'string' || !volume || typeof volume !== 'object') return null;
    if (typeof volume.authorDate !== 'string' || !volume.totals) return null;
    volumeCommits.set(sha, volume);
  }

  return {
    signature: record.signature,
    log: { days, allAuthors, minutes: record.log.minutes, lastDate: record.log.lastDate ?? null },
    volumeCommits,
    volumeScannedFrom: record.volumeScannedFrom,
    minuteCount: record.log.minutes.length,
    dayCount: days.size,
  };
}

/** 读一条缓存。签名不符、文件不存在、文件坏了都返回 null。 */
export async function loadScanRecord(cwd: string, signature: string): Promise<CachedScan | null> {
  try {
    const raw = await readFile(recordPath(cwd), 'utf8');
    if (raw.length > maxRecordBytes) return null;
    const record = JSON.parse(raw) as ScanRecord;
    if (record.version !== cacheVersion || record.cwd !== cwd || record.signature !== signature) return null;
    return fromRecord(record);
  } catch {
    return null;
  }
}

async function writeRecord(cwd: string): Promise<void> {
  const entry = pendingWrites.get(cwd);
  pendingWrites.delete(cwd);
  writeTimers.delete(cwd);
  if (!entry) return;

  try {
    const payload = JSON.stringify(toRecord(cwd, entry));
    if (payload.length > maxRecordBytes) return;
    const target = recordPath(cwd);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(cacheDirectory(), { recursive: true });
    await writeFile(temporary, payload, 'utf8');
    // 先写临时文件再改名：中途被杀不会留下半个 JSON 让下次读崩
    await rename(temporary, target);
  } catch {
    // 缓存写不进去只影响下次快慢，不影响正确性，静默失败
  }
}

/** 排一次落盘。同一个仓库在 `writeDelayMs` 内多次调用只写最后一次。 */
export function scheduleScanRecordSave(cwd: string, entry: CachedScan): void {
  pendingWrites.set(cwd, entry);
  const timer = writeTimers.get(cwd);
  if (timer) clearTimeout(timer);
  writeTimers.set(
    cwd,
    setTimeout(() => {
      void writeRecord(cwd);
    }, writeDelayMs),
  );
}

/** 立刻把所有待写的记录写下去。测试与进程退出前用。 */
export async function flushScanRecords(): Promise<void> {
  const paths = [...pendingWrites.keys()];
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  await Promise.all(paths.map((cwd) => writeRecord(cwd)));
}

/** 测试用：丢掉待写队列（不影响已落盘的文件）。 */
export function resetScanRecordQueue(): void {
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  pendingWrites.clear();
}

export { cacheVersion };
