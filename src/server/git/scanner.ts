import { createHash } from 'node:crypto';
import { mapWithConcurrency } from '../concurrency.js';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
  ScanCandidate,
} from '../../shared/contracts.js';
import { isPathInside, resolveRepositoryPath, resolveRoot } from '../config/store.js';
import { parseTagDecorations } from './commits.js';
import { runGit, runGitText } from './runner.js';

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.cache',
  '.idea',
  '.vscode',
  'storage',
]);

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'repository';
}

export function sanitizeRemote(remote: string): string {
  try {
    const url = new URL(remote);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return remote.replace(/:\/\/[^/@]+@/, '://');
  }
}

export function repositoryId(name: string, canonicalPath: string): string {
  const hash = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 10);
  return `${slugify(name)}-${hash}`;
}

async function isSessionBackupRepository(directory: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(directory, 'fleet.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && (parsed as { kind?: unknown }).kind === 'moo-fleet-session-backup';
  } catch {
    return false;
  }
}

async function isGitWorktree(candidatePath: string): Promise<boolean> {
  try {
    return (await runGitText(candidatePath, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export async function scanRoot(config: RepositoriesConfig, rootId: string): Promise<ScanCandidate[]> {
  const rootPath = await resolveRoot(config, rootId);
  const results: ScanCandidate[] = [];
  let reservedCandidates = 0;
  const addedByPath = new Map(
    await Promise.all(
      config.repositories.map(async (repository) => {
        try {
          return [await realpath(resolveRepositoryPath(config, repository)), repository.id] as const;
        } catch {
          return [resolveRepositoryPath(config, repository), repository.id] as const;
        }
      }),
    ),
  );

  async function visit(directory: string, depth: number): Promise<void> {
    if (results.length >= 500 || reservedCandidates >= 500 || depth > config.settings.scanDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGitMarker = entries.some((entry) => entry.name === '.git');
    if (hasGitMarker && (await isGitWorktree(directory))) {
      if (reservedCandidates >= 500) return;
      reservedCandidates += 1;
      const canonicalPath = await realpath(directory).catch(() => null);
      if (!canonicalPath) {
        reservedCandidates -= 1;
        return;
      }
      if (!isPathInside(rootPath, canonicalPath)) {
        reservedCandidates -= 1;
        return;
      }
      const relativePath = path.relative(rootPath, canonicalPath) || '.';
      const name = path.basename(canonicalPath);
      const [branch, remote, sessionBackup] = await Promise.all([
        runGitText(canonicalPath, ['branch', '--show-current']).catch(() => ''),
        runGitText(canonicalPath, ['remote', 'get-url', 'origin']).catch(() => ''),
        isSessionBackupRepository(canonicalPath),
      ]);
      results.push({
        rootId,
        name,
        relativePath,
        absolutePath: canonicalPath,
        branch: branch || null,
        remote: remote ? sanitizeRemote(remote) : null,
        sessionBackup,
        alreadyAdded: addedByPath.has(canonicalPath),
        repositoryId: addedByPath.get(canonicalPath) ?? null,
      });
      return;
    }

    if (depth === config.settings.scanDepth) return;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !ignoredDirectories.has(entry.name))
        .map((entry) => visit(path.join(directory, entry.name), depth + 1)),
    );
  }

  await visit(rootPath, 0);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  stashCount: number;
  changedFiles: number;
  staged: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
}

export function parsePorcelainV2(buffer: Buffer): ParsedStatus {
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  const parsed: ParsedStatus = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    stashCount: 0,
    changedFiles: 0,
    staged: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0,
  };

  for (const record of records) {
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice(14);
      parsed.detached = branch === '(detached)';
      parsed.branch = parsed.detached ? null : branch;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      parsed.upstream = record.slice(18);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+) -(\d+)/);
      if (match) {
        parsed.ahead = Number(match[1]);
        parsed.behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith('# stash ')) {
      const stashCount = Number.parseInt(record.slice(8), 10);
      parsed.stashCount = Number.isFinite(stashCount) ? stashCount : 0;
      continue;
    }
    if (record.startsWith('? ')) {
      parsed.changedFiles += 1;
      parsed.untracked += 1;
      continue;
    }
    if (record.startsWith('u ')) {
      parsed.changedFiles += 1;
      parsed.conflicted += 1;
      continue;
    }
    if (record.startsWith('1 ') || record.startsWith('2 ')) {
      parsed.changedFiles += 1;
      const xy = record.split(' ')[1] ?? '..';
      const [indexState = '.', worktreeState = '.'] = xy;
      if (indexState !== '.') parsed.staged += 1;
      if (worktreeState !== '.') parsed.modified += 1;
      if (indexState === 'D' || worktreeState === 'D') parsed.deleted += 1;
      if (indexState === 'R' || worktreeState === 'R') parsed.renamed += 1;
    }
  }
  return parsed;
}

const gitStateMarkers: Array<[RepositoryStatus['inProgressOperation'], string]> = [
  ['merge', 'MERGE_HEAD'],
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
  ['bisect', 'BISECT_LOG'],
];

/**
 * 解析 worktree 的 Git 目录，不额外起进程。
 *
 * `git rev-parse --absolute-git-dir` 实测约 9 ms，而整页扫描每个仓库都要跑一遍；
 * 这里直接读 `.git`：普通仓库它是目录，worktree 与 submodule 是内容为
 * `gitdir: <路径>` 的文件——git 自己也是这么解析的。
 *
 * 只按前缀切一次、只去掉结尾换行：路径里**可以**含换行（macOS / Linux 均合法），
 * 按行解析会把它截断成另一条不存在的路径。
 */
async function resolveGitDirectory(cwd: string): Promise<string> {
  const dotGit = path.join(cwd, '.git');
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  const contents = await readFile(dotGit, 'utf8');
  const prefix = 'gitdir: ';
  if (!contents.startsWith(prefix)) throw new Error('.git 文件里没有 gitdir');
  const target = contents.slice(prefix.length).replace(/\r?\n+$/, '');
  return path.resolve(cwd, target);
}

export async function repositoryInternalState(cwd: string): Promise<{
  operation: RepositoryStatus['inProgressOperation'];
  lastFetchedAt: string | null;
}> {
  try {
    const pathNames = ['FETCH_HEAD', ...gitStateMarkers.map(([, marker]) => marker)];
    const gitDir = await resolveGitDirectory(cwd);
    const resolvedPaths = pathNames.map((marker) => path.resolve(gitDir, marker));
    const metadata = await Promise.all(
      resolvedPaths.map(async (gitPath) => {
        try {
          return await stat(gitPath);
        } catch {
          return null;
        }
      }),
    );
    const operationIndex = metadata.slice(1).findIndex(Boolean);
    const fetchHead = metadata[0];
    return {
      operation: operationIndex >= 0 ? (gitStateMarkers[operationIndex]?.[0] ?? null) : null,
      // Git can truncate FETCH_HEAD before attempting network I/O. A failed
      // Fetch therefore leaves a freshly modified, zero-byte file behind;
      // treating that timestamp as a successful Fetch makes stale remote
      // state look current in the dashboard.
      lastFetchedAt: fetchHead?.isFile() && fetchHead.size > 0 ? fetchHead.mtime.toISOString() : null,
    };
  } catch {
    return { operation: null, lastFetchedAt: null };
  }
}

function parseGitIdentity(configOutput: string): RepositoryStatus['gitIdentity'] {
  const identity = { name: null as string | null, email: null as string | null, complete: false };
  for (const record of configOutput.split('\0')) {
    const separator = record.indexOf('\n');
    if (separator < 0) continue;
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (key === 'user.name') identity.name = value || null;
    if (key === 'user.email') identity.email = value || null;
  }
  identity.complete = Boolean(identity.name && identity.email);
  return identity;
}

function escapeGitConfigRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRepositoryConfig(
  configOutput: string,
  defaultRemote: string,
): { gitIdentity: RepositoryStatus['gitIdentity']; remoteUrl: string | null } {
  const remoteKey = `remote.${defaultRemote}.url`;
  let remoteUrl: string | null = null;
  for (const record of configOutput.split('\0')) {
    const separator = record.indexOf('\n');
    if (separator < 0) continue;
    const key = record.slice(0, separator);
    if (key === remoteKey && remoteUrl === null) remoteUrl = record.slice(separator + 1) || null;
  }
  return {
    gitIdentity: parseGitIdentity(configOutput),
    remoteUrl: remoteUrl ? sanitizeRemote(remoteUrl) : null,
  };
}

function deriveState(parsed: ParsedStatus, operation: RepositoryStatus['inProgressOperation']): RepositoryStatus['state'] {
  if (parsed.conflicted > 0) return 'conflict';
  if (operation) return 'operation-in-progress';
  if ((parsed.ahead ?? 0) > 0 && (parsed.behind ?? 0) > 0) return 'diverged';
  if (parsed.changedFiles > 0) return 'dirty';
  if ((parsed.ahead ?? 0) > 0) return 'ahead';
  if ((parsed.behind ?? 0) > 0) return 'behind';
  if (!parsed.upstream) return 'remote-unknown';
  return 'clean';
}

/** 一个仓库里「只跟引用 / config 有关」的那部分状态。 */
interface RepositoryMetadata {
  lastCommit: RepositoryStatus['lastCommit'];
  latestTag: RepositoryStatus['latestTag'];
  gitIdentity: RepositoryStatus['gitIdentity'];
  remoteUrl: string | null;
}

/**
 * 元数据缓存：按「文件指纹」复用，而不是按时间。
 *
 * 为什么需要它：整页扫描的成本几乎全是**进程启动**，不是 git 干活。这台机器上一次
 * `git --version` 就要 2.6 ms，58 个仓库 × 4 条命令 = 232 次 spawn 约 613 ms，与实测
 * 扫描 563 ms 基本相等——把命令数降下来，扫描时间就近似线性下降。
 *
 * 四条命令里只有 `status` 必须每次都跑：工作区改动不触碰 `.git`，没法用文件状态判断。
 * 其余三条只跟引用与 config 有关，而它们的任何变动都会改文件 mtime，所以指纹变了才重跑。
 * 稳态下每个仓库只剩一次 `status`（实测 563 ms → 约 180 ms）。
 *
 * 两种情况不缓存，宁可多起进程也不猜：`.git` 是文件（worktree / submodule，它的
 * packed-refs 与 config 在 common dir，路径规则不同）；指纹读不出来（权限、目录消失）。
 */
const metadataCache = new Map<string, { fingerprint: string; value: RepositoryMetadata }>();
const metadataCacheLimit = 512;

/**
 * 键里必须带默认远端名：`remoteUrl` / `gitIdentity` 是按它筛出来的，而它是用户可改的设置，
 * 改它不会碰 `.git/config`，指纹不会失效。只按路径缓存会继续返回旧远端的地址。
 */
function metadataCacheKey(cwd: string, defaultRemote: string): string {
  return `${cwd}\u0000${defaultRemote}`;
}

/** 一个路径的「内容可能变了」判据；不存在时用 `-`，与「存在但为空」区分开。 */
async function fileSignature(target: string): Promise<string> {
  try {
    const info = await stat(target);
    return `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return '-';
  }
}

/**
 * 元数据指纹：HEAD 指向的引用、tag 集合、config 任一变动都会改变它。
 *
 * 只盯目录 mtime 不够——`git tag -f` 改写的是已有文件，目录 mtime 不动，所以逐个
 * tag 引用文件取 mtime。全局 gitconfig 也算进去：改 user.name 不该只在一分钟后才生效。
 */
async function metadataFingerprint(cwd: string): Promise<string | null> {
  const dotGit = path.join(cwd, '.git');
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  if (!info.isDirectory()) return null;

  let head: string;
  try {
    head = (await readFile(path.join(dotGit, 'HEAD'), 'utf8')).trim();
  } catch {
    return null;
  }

  const home = process.env.HOME ?? '';
  const parts = [
    head,
    await fileSignature(path.join(dotGit, 'HEAD')),
    await fileSignature(path.join(dotGit, 'packed-refs')),
    await fileSignature(path.join(dotGit, 'config')),
    await fileSignature(path.join(home, '.gitconfig')),
    await fileSignature(path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'git', 'config')),
  ];

  const refPrefix = 'ref: ';
  if (head.startsWith(refPrefix)) parts.push(await fileSignature(path.join(dotGit, head.slice(refPrefix.length))));

  const tagsDir = path.join(dotGit, 'refs', 'tags');
  parts.push(await fileSignature(tagsDir));
  try {
    const names = (await readdir(tagsDir)).sort();
    parts.push(names.join(','));
    for (const name of names) parts.push(await fileSignature(path.join(tagsDir, name)));
  } catch {
    parts.push('-');
  }

  return parts.join('|');
}

function rememberMetadata(key: string, fingerprint: string, value: RepositoryMetadata): void {
  if (!metadataCache.has(key) && metadataCache.size >= metadataCacheLimit) {
    const oldest = metadataCache.keys().next().value;
    if (oldest !== undefined) metadataCache.delete(oldest);
  }
  metadataCache.delete(key);
  metadataCache.set(key, { fingerprint, value });
}

/** 三条命令并行发出去；它们互不依赖，也不依赖 `status`。 */
async function readRepositoryMetadata(cwd: string, defaultRemote: string): Promise<RepositoryMetadata> {
  const defaultRemotePattern = escapeGitConfigRegex(defaultRemote);
  const [lastCommitRaw, latestTagRaw, repositoryConfigRaw] = await Promise.all([
    runGitText(cwd, ['log', '-1', '--format=%H%x00%s%x00%an%x00%aI%x00%D']).catch(() => ''),
    runGitText(cwd, [
      'for-each-ref',
      '--sort=-creatordate',
      '--count=1',
      '--format=%(refname:short)%00%(creatordate:iso-strict)',
      'refs/tags',
    ]).catch(() => ''),
    runGitText(cwd, [
      'config',
      '--null',
      '--get-regexp',
      `^(user\\.name|user\\.email|remote\\.${defaultRemotePattern}\\.url)$`,
    ]).catch(() => ''),
  ]);

  const lastCommitParts = lastCommitRaw.split('\0');
  const latestTagParts = latestTagRaw.split('\0');
  const parsedRepositoryConfig = parseRepositoryConfig(repositoryConfigRaw, defaultRemote);
  return {
    remoteUrl: parsedRepositoryConfig.remoteUrl,
    gitIdentity: parsedRepositoryConfig.gitIdentity,
    latestTag: latestTagParts[0]
      ? {
          name: latestTagParts[0],
          createdAt: latestTagParts[1] || null,
        }
      : null,
    lastCommit: lastCommitParts.length >= 5
      ? {
          hash: lastCommitParts[0] ?? '',
          subject: lastCommitParts[1] ?? '',
          author: lastCommitParts[2] ?? '',
          committedAt: lastCommitParts[3] ?? '',
          tags: parseTagDecorations(lastCommitParts[4] ?? ''),
        }
      : null,
  };
}

export async function scanRepository(config: RepositoriesConfig, repository: RepositoryConfig): Promise<RepositoryStatus> {
  const absolutePath = resolveRepositoryPath(config, repository);
  const base: RepositoryStatus = {
    config: repository,
    absolutePath,
    available: false,
    branch: null,
    detached: false,
    upstream: null,
    remoteUrl: null,
    ahead: null,
    behind: null,
    changedFiles: 0,
    staged: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0,
    stashCount: 0,
    inProgressOperation: null,
    lastFetchedAt: null,
    state: 'missing',
    lastCommit: null,
    latestTag: null,
    gitIdentity: {
      name: null,
      email: null,
      complete: false,
    },
    scannedAt: new Date().toISOString(),
    error: null,
  };
  try {
    await access(absolutePath);
  } catch {
    return { ...base, error: '本地目录不存在' };
  }

  try {
    /**
     * 三条并行：`status`（每次都要跑）、指纹（只读文件，约 1 ms）、Git 目录内部状态。
     * 指纹先回来，命中缓存就完全不碰 git；没命中才补三条元数据命令，此时它们与
     * `status` 同时在飞，单仓墙钟仍是一次进程启动的量级。
     */
    const fingerprintPromise = metadataFingerprint(absolutePath);
    const statusPromise = runGit(absolutePath, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z']);
    const internalPromise = repositoryInternalState(absolutePath);

    const fingerprint = await fingerprintPromise;
    const cacheKey = fingerprint ? metadataCacheKey(absolutePath, config.settings.defaultRemote) : null;
    const cached = cacheKey ? metadataCache.get(cacheKey) : undefined;
    const reusable = cached && cached.fingerprint === fingerprint ? cached.value : null;
    const metadataPromise = reusable
      ? Promise.resolve(reusable)
      : readRepositoryMetadata(absolutePath, config.settings.defaultRemote);

    const [statusResult, metadata, internalState] = await Promise.all([
      statusPromise,
      metadataPromise,
      internalPromise,
    ]);
    if (!reusable && cacheKey && fingerprint) rememberMetadata(cacheKey, fingerprint, metadata);
    if (statusResult.exitCode !== 0) {
      return { ...base, state: 'invalid', error: statusResult.stderr || '不是有效的 Git worktree' };
    }
    const parsed = parsePorcelainV2(statusResult.stdout);
    return {
      ...base,
      ...parsed,
      available: true,
      inProgressOperation: internalState.operation,
      lastFetchedAt: internalState.lastFetchedAt,
      remoteUrl: metadata.remoteUrl,
      gitIdentity: metadata.gitIdentity,
      state: deriveState(parsed, internalState.operation),
      latestTag: metadata.latestTag,
      lastCommit: metadata.lastCommit,
    };
  } catch (error) {
    return { ...base, state: 'invalid', error: error instanceof Error ? error.message : 'Git 扫描失败' };
  }
}

export async function scanRepositories(config: RepositoriesConfig): Promise<RepositoryStatus[]> {
  const repositories = config.repositories.filter((repository) => repository.enabled);
  const results = await mapWithConcurrency(repositories, config.settings.localScanConcurrency, (repository) =>
    scanRepository(config, repository),
  );
  return results.map((result, index) => {
    if (!result) throw new Error(`仓库扫描结果缺失：${repositories[index]?.name ?? index}`);
    return result;
  });
}
