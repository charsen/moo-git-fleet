/**
 * 代码量（增删行）统计。
 *
 * 提交数回答不了「做了多少」：271 次批量提交和一次改一行 README 在排行榜上是等价的。
 * 这里用 `git log --numstat` 把窗口内的增删行捞出来，并且**剔除生成文件**——
 * 一个 `package-lock.json` 的一次依赖升级能刷出几万行，不剔除的话所有排行都会被
 * 依赖更新霸榜。
 *
 * 只统计窗口内（见 `shared/report-window.ts`）。全量跑 numstat 在最大的仓库上要
 * 4 秒，53 个仓库一起跑是分钟级；窗口化后实测整体 4 秒左右。
 *
 * 解析结果按**单个提交**保存（`CommitCodeVolume` 带 sha），而不是直接折成作者的
 * 总数：窗口内每出现一个新提交，只需要 `git log --no-walk` 补这**一个**提交的
 * diff，其余提交的账沿用上一次的。否则一次 `git fetch` 回来五个提交，就要把
 * 整个窗口的历史全部重算一遍。
 */

import { authorSampleKey } from './author-identity.js';

export interface CodeVolumeTotals {
  /** 新增行 */
  additions: number;
  /** 删除行 */
  deletions: number;
  /** 改动文件次（同一个文件在两次提交里算两次） */
  files: number;
  /** 命中生成文件规则、被剔除的文件次 */
  excludedFiles: number;
  /** 二进制改动文件次（numstat 记为 `-`），不计入行数 */
  binaryFiles: number;
}

export interface AuthorCodeVolume extends CodeVolumeTotals {
  name: string;
  email: string;
}

export interface ParsedCodeVolume {
  totals: CodeVolumeTotals;
  /** key 为 `authorSampleKey`，与提交数统计用同一套键，才能合并成同一个身份 */
  byAuthor: Map<string, AuthorCodeVolume>;
}

/**
 * 视为「生成 / 非人工」的路径。
 *
 * 规则是从这台机器上 53 个真实仓库里总结出来的，不是拍脑袋：`wisdomcity` 窗口内
 * 4,525,636 行改动里有两百万行上下是 `backup/RestoreDB` 下整库导出的 SQL 分片，
 * `light-language-engine` 的 742,357 行里前三名是 `public/css/index.css`（Sass 编译产物）、
 * `public/vendor/` 下的前端依赖、`composer.lock`。剔除后剩下的才是人写的。
 *
 * 判断顺序是先二进制、再生成文件：二进制本来就没有行数，混进「剔除」里会让
 * 「剔除了 N 个文件」这个数字失真（用户会以为自己写了一堆垃圾）。
 */
const generatedRules: RegExp[] = [
  // 依赖锁文件：一次升级几万行
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|Podfile\.lock|go\.sum)$/i,
  // 压缩产物
  /\.min\.(js|css)$/i,
  // 构建 / 依赖 / 缓存目录（含整库导出常用的 backup、RestoreDB 外层）
  /(^|\/)(dist|build|out|release|node_modules|vendor|coverage|\.next|\.nuxt|\.output|\.turbo|\.cache|backup|dumps?)\//i,
  // 导出型 SQL（Laravel 迁移是 .php，不受影响）
  /\.sql$/i,
  // 二进制与媒体资源
  /\.(map|lock|snap|woff2?|ttf|otf|eot|ico|icns|png|jpe?g|gif|webp|avif|bmp|tiff?|mp[34]|mov|avi|wav|flac|pdf|zip|gz|tgz|tar|7z|rar|exe|dll|dmg|jar|wasm)$/i,
  // 哈希命名的构建产物
  /-[0-9a-f]{8,}\.(js|css)$/i,
  // 站点根目录下的 css/js 基本是编译结果（手写页面仍是 html，不受影响）
  /(^|\/)(public|static|www|htdocs)\/(assets?|css|js|fonts?|dist|build|vendor|bower_components)\/.*\.(css|js)$/i,
];

/** 路径是否属于「生成的、不该算作人工产出」的文件。 */
export function isGeneratedFile(filePath: string): boolean {
  return generatedRules.some((rule) => rule.test(filePath));
}

/** 提交头行（`%x01` 开头）与 numstat 行的分隔符。 */
const commitMarker = '\u0001';

function emptyTotals(): CodeVolumeTotals {
  return { additions: 0, deletions: 0, files: 0, excludedFiles: 0, binaryFiles: 0 };
}

function addInto(target: CodeVolumeTotals, source: CodeVolumeTotals): void {
  target.additions += source.additions;
  target.deletions += source.deletions;
  target.files += source.files;
  target.excludedFiles += source.excludedFiles;
  target.binaryFiles += source.binaryFiles;
}

/** 把 `source` 累加进 `target`（就地修改）。跨仓库汇总用。 */
export function addCodeVolumeTotals(target: CodeVolumeTotals, source: CodeVolumeTotals): void {
  addInto(target, source);
}

/**
 * 单个提交的代码量。增量缓存的最小单位——`sha` 是它的身份，重算时按 sha 比对。
 */
export interface CommitCodeVolume {
  sha: string;
  /**
   * 作者本地日期（`%aI` 的前 10 位，YYYY-MM-DD）。
   *
   * 存它是为了让「按窗口过滤」不依赖 git：`--since` 看的是 **committer date**，
   * 而热力图、非上班时长看的都是 **author date**，rebase / cherry-pick 之后两者会分叉。
   * 有了这个字段，聚合时可以按与热力图同一个日期把提交筛出来。
   */
  authorDate: string;
  name: string;
  email: string;
  totals: CodeVolumeTotals;
}

/** 统计窗口（闭区间，YYYY-MM-DD）。不传表示不过滤。 */
export interface VolumeWindow {
  start: string;
  end: string;
}

/**
 * 解析 `git log --numstat --format=%x01%H|%aI|%ae|%an` 的输出，一个提交一条记录。
 *
 * 结构是「头行 → 空行 → 若干 numstat 行」，头行以 `\u0001` 开头，
 * 所以不用管空行和其它噪声，只认这两种行就够。
 * 文件名可能含 `\t`（git 会转义），所以按**前两个** tab 切分；
 * 作者名可能含 `|`，所以头行只按**前三个**竖线切。
 */
export function parseNumstatCommits(output: string): CommitCodeVolume[] {
  const commits: CommitCodeVolume[] = [];
  let current: CommitCodeVolume | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith(commitMarker)) {
      const header = line.slice(1);
      const firstPipe = header.indexOf('|');
      const secondPipe = firstPipe === -1 ? -1 : header.indexOf('|', firstPipe + 1);
      const thirdPipe = secondPipe === -1 ? -1 : header.indexOf('|', secondPipe + 1);
      const sha = (firstPipe === -1 ? '' : header.slice(0, firstPipe)).trim();
      const authorDate = (secondPipe === -1 ? '' : header.slice(firstPipe + 1, secondPipe)).trim().slice(0, 10);
      const email = (thirdPipe === -1 ? '' : header.slice(secondPipe + 1, thirdPipe)).trim();
      const name = (thirdPipe === -1 ? email : header.slice(thirdPipe + 1)).trim() || email;
      current = { sha, authorDate, name, email, totals: emptyTotals() };
      commits.push(current);
      continue;
    }

    if (!current || line.length === 0) continue;

    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;

    const filePath = line.slice(secondTab + 1);
    const additions = Number(line.slice(0, firstTab));
    const deletions = Number(line.slice(firstTab + 1, secondTab));

    // 二进制：`-\t-\tpath`，Number('-') 是 NaN，这里单列出来
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      current.totals.binaryFiles += 1;
      continue;
    }

    if (isGeneratedFile(filePath)) {
      current.totals.excludedFiles += 1;
      continue;
    }

    current.totals.additions += additions;
    current.totals.deletions += deletions;
    current.totals.files += 1;
  }

  return commits;
}

/**
 * 把「窗口里当前应有的提交」合并进上一次的逐提交基线。
 *
 * 三件事一起做，缺一件数字就会长期错下去：
 * 1. 撤账——基线里有、但窗口里已经没有的提交（`reset --hard`、force-push、rebase
 *    之后的老提交）必须删掉，否则那部分工作量会永远挂着；
 * 2. 补齐——窗口里有、基线里没有的提交，由调用方先 diff 出来再传进来；
 * 3. 对账——补出来的条数必须和该补的条数一致。少一条就说明这次增量没拿全
 *    （输出被截断、解析规则和 git 输出格式脱节），返回 `null` 让调用方退回全量扫描。
 *    宁可多花几秒，也不能交一个悄悄偏低、界面上又完全看不出来的数字。
 *
 * `keepBefore` 是「窗口之外但基线里已经有」的分界：`listed` 只覆盖当前窗口，
 * 更早的提交这次根本没列出来，不能因为「没在 listed 里」就撤账——那是把基线
 * 剪短，下次放宽窗口又得重新 diff 一遍（实测来回切一次窗口多付 2.8 秒）。
 * 传了它就只裁窗口内的账，窗口外原样保留。
 */
export function reconcileCommitVolumes(
  cached: Map<string, CommitCodeVolume>,
  listed: string[],
  fresh: CommitCodeVolume[],
  keepBefore?: string,
): Map<string, CommitCodeVolume> | null {
  const listedSet = new Set(listed);
  const merged = new Map<string, CommitCodeVolume>();
  for (const [sha, commit] of cached) {
    if (listedSet.has(sha)) merged.set(sha, commit);
    else if (keepBefore !== undefined && commit.authorDate < keepBefore) merged.set(sha, commit);
  }

  const added = listed.filter((sha) => !merged.has(sha));
  if (fresh.length !== added.length) return null;

  for (const commit of fresh) merged.set(commit.sha, commit);
  return merged;
}

/**
 * 把「每提交一条」的记录折成总数 + 按作者分组。
 *
 * 每次聚合都要重新跑一遍（增量缓存里存的是逐提交记录），所以这里刻意不做任何
 * 记忆化：几千条记录的加法是微秒级的，加一层缓存只会多一个失效点。
 *
 * 传 `window` 时只统计 `authorDate` 落在窗口内的提交——和热力图、非上班时长
 * 用同一个日期口径，不再受 `--since`（committer date）的影响。
 */
export function aggregateCommitVolumes(
  commits: Iterable<CommitCodeVolume>,
  window?: VolumeWindow,
): ParsedCodeVolume {
  const totals = emptyTotals();
  const byAuthor = new Map<string, AuthorCodeVolume>();

  for (const commit of commits) {
    if (window && (commit.authorDate < window.start || commit.authorDate > window.end)) continue;
    const key = authorSampleKey(commit.name, commit.email);
    let author = byAuthor.get(key);
    if (!author) {
      author = { name: commit.name, email: commit.email, ...emptyTotals() };
      byAuthor.set(key, author);
    }
    addInto(author, commit.totals);
  }

  for (const author of byAuthor.values()) addInto(totals, author);

  return { totals, byAuthor };
}

/**
 * 解析整段 numstat 输出。等价于 `aggregateCommitVolumes(parseNumstatCommits(...))`，
 * 保留这个名字是因为「一次全量扫描」是它唯一的用途，调用方读起来更直白。
 */
export function parseCodeVolumeLog(output: string): ParsedCodeVolume {
  return aggregateCommitVolumes(parseNumstatCommits(output));
}

/** 空结果，仓库读不到时用。 */
export function emptyCodeVolume(): ParsedCodeVolume {
  return { totals: emptyTotals(), byAuthor: new Map() };
}
