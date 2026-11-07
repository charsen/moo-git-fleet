import type { ClonePhase, CloneProgress } from '../../shared/contracts.js';

/**
 * 把 `git clone --progress` 的 stderr 翻译成进度快照，并提供一张供 HTTP 读取的进度表。
 *
 * 为什么要单独成模块：克隆一个远程仓库可能跑几分钟（`cloneTimeoutMs` 给到 900 秒），
 * 期间 `runGit` 只会把 stderr 攒着，界面上只有一个 spinner 和「已用 N 秒」。
 * git 其实一直在报进度，只是它把进度写在 stderr 上、用 `\r` 原地刷新——
 * 有管道时默认还会关掉，必须显式 `--progress` 才会吐出来。
 *
 * 这里只管「解析」与「暂存」，不认识 HTTP，也不认识 git 进程；
 * 传输由 app.ts 的进度路由负责，这样解析规则可以脱离服务端单独测。
 */

interface PhasePattern {
  phase: ClonePhase;
  pattern: RegExp;
}

/**
 * 顺序有意义：`Receiving` 与 `Resolving` 可能出现在同一段缓冲里，
 * 逐条匹配时先命中的阶段就是这一行的阶段。
 *
 * `remote:` 前缀（服务端算出来的阶段）与本地阶段共用一套模式——
 * 前三个阶段（Counting / Compressing / Enumerating）本来就带 `remote:`。
 */
const phasePatterns: PhasePattern[] = [
  { phase: 'counting', pattern: /Counting objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)/ },
  { phase: 'compressing', pattern: /Compressing objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)/ },
  {
    phase: 'receiving',
    // `Receiving objects:  45% (450/1000), 12.30 MiB | 1.50 MiB/s`
    // 最后两段都是可选的：小仓库直接 `100% (5/5), done.`，没有体积与速率。
    pattern: /Receiving objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*([\d.]+\s*[KMGTP]i?B))?(?:\s*\|\s*([\d.]+\s*[KMGTP]i?B\/s))?/,
  },
  { phase: 'resolving', pattern: /Resolving deltas:\s+(\d+)%\s+\((\d+)\/(\d+)\)/ },
  { phase: 'checkout', pattern: /Updating files:\s+(\d+)%\s+\((\d+)\/(\d+)\)/ },
];

/** 刚起步、还没有任何阶段数字可报时的快照。 */
export function initialCloneProgress(): CloneProgress {
  return { phase: 'connecting', percent: null, current: null, total: null, size: null, speed: null };
}

/**
 * 增量解析 stderr 片段。
 *
 * `push` 的入参是**任意切分**的文本（见 `runGitStreaming`）：可能是半行，
 * 也可能一行里挤了好几个 `\r` 刷新。所以这里自己攒缓冲，只在遇到
 * `\r` / `\n` 时才把完整的一段交给解析。
 */
export class CloneProgressParser {
  private pending = '';
  private last: CloneProgress | null = null;

  constructor(private readonly report: (progress: CloneProgress) => void) {}

  push(chunk: string): void {
    // git 用 `\r` 原地刷新同一行，所以两种换行都要切。
    const text = this.pending + chunk;
    const segments = text.split(/[\r\n]/);
    this.pending = segments.pop() ?? '';
    // 兜底：真有实现只写 `\r` 之外的东西（或干脆不换行），别让缓冲无限长。
    // 进度行的有效信息都在尾部，留最后 1 KB 足够重新对齐到下一个完整行。
    if (this.pending.length > 4096) this.pending = this.pending.slice(-1024);
    for (const segment of segments) this.consume(segment);
  }

  private consume(line: string): void {
    if (!line) return;
    for (const { phase, pattern } of phasePatterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      this.emit({
        phase,
        percent: Number(match[1]),
        current: Number(match[2]),
        total: Number(match[3]),
        size: match[4]?.trim() ?? null,
        speed: match[5]?.trim() ?? null,
      });
      return;
    }
    // 连上之后 git 先给一句 `Cloning into 'x'...`：在它和第一个百分比之间
    // 可能隔好几秒（远端在数对象），界面这时候不该还停在「正在连接」。
    if (/Cloning into\b/.test(line)) this.emit(initialCloneProgress());
  }

  private emit(progress: CloneProgress): void {
    // git 每 1% 刷一行，几十毫秒一条。同一个阶段的同一个百分比再推一次没有意义，
    // 反而会让客户端多画几十次 DOM。体积与速率随百分比一起更新，不用单独比。
    const last = this.last;
    if (last && last.phase === progress.phase && last.percent === progress.percent) return;
    this.last = progress;
    this.report(progress);
  }
}

interface ProgressEntry {
  progress: CloneProgress;
  updatedAt: number;
}

/** 进度只在克隆进行时有用；结束后留一分钟足够客户端收尾轮询。 */
const entryTtlMs = 60_000;

const entries = new Map<string, ProgressEntry>();

function pruneExpired(now = Date.now()): void {
  for (const [id, entry] of entries) {
    if (now - entry.updatedAt > entryTtlMs) entries.delete(id);
  }
}

/**
 * 开一个进度槽，返回用于上报的回调。
 *
 * 为什么用「客户端给的 id」而不是仓库 id：克隆时目标仓库还不存在，
 * 配置里没有它，`publishOperations()` 那条 SSE 通道也无处归属
 * （见 app.ts 里克隆路由的说明）。让客户端带一个一次性 id，
 * 服务端就只做「按 id 存最新快照」，不牵动操作记录与批次。
 */
export function beginCloneProgress(id: string): (progress: CloneProgress) => void {
  pruneExpired();
  const entry: ProgressEntry = { progress: initialCloneProgress(), updatedAt: Date.now() };
  entries.set(id, entry);
  return (progress) => {
    entry.progress = progress;
    entry.updatedAt = Date.now();
  };
}

/** 读最新快照；没有这个 id（或已过期）时返回 `null`。 */
export function readCloneProgress(id: string): CloneProgress | null {
  pruneExpired();
  return entries.get(id)?.progress ?? null;
}

/** 只给测试用：清空进度表，避免用例之间互相看见。 */
export function resetCloneProgress(): void {
  entries.clear();
}
