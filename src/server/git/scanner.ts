import { createHash } from 'node:crypto';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
  ScanCandidate,
} from '../../shared/contracts.js';
import { isPathInside, resolveRepositoryPath, resolveRoot } from '../config/store.js';
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
    if (results.length >= 500 || depth > config.settings.scanDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGitMarker = entries.some((entry) => entry.name === '.git');
    if (hasGitMarker && (await isGitWorktree(directory))) {
      const canonicalPath = await realpath(directory);
      if (!isPathInside(rootPath, canonicalPath)) return;
      const relativePath = path.relative(rootPath, canonicalPath) || '.';
      const name = path.basename(canonicalPath);
      const [branch, remote] = await Promise.all([
        runGitText(canonicalPath, ['branch', '--show-current']).catch(() => ''),
        runGitText(canonicalPath, ['remote', 'get-url', 'origin']).catch(() => ''),
      ]);
      results.push({
        rootId,
        name,
        relativePath,
        absolutePath: canonicalPath,
        branch: branch || null,
        remote: remote ? sanitizeRemote(remote) : null,
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
  staged: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
}

export function parsePorcelainV2(buffer: Buffer): ParsedStatus {
  const records = buffer.toString('utf8').replaceAll('\0', '\n').split('\n').filter(Boolean);
  const parsed: ParsedStatus = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
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
    if (record.startsWith('? ')) {
      parsed.untracked += 1;
      continue;
    }
    if (record.startsWith('u ')) {
      parsed.conflicted += 1;
      continue;
    }
    if (record.startsWith('1 ') || record.startsWith('2 ')) {
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

async function repositoryInternalState(cwd: string): Promise<{
  operation: RepositoryStatus['inProgressOperation'];
  lastFetchedAt: string | null;
}> {
  try {
    const pathNames = ['FETCH_HEAD', ...gitStateMarkers.map(([, marker]) => marker)];
    const gitPaths = await runGitText(cwd, [
      'rev-parse',
      ...pathNames.flatMap((marker) => ['--git-path', marker]),
    ]);
    const resolvedPaths = gitPaths.split('\n').map((gitPath) => path.resolve(cwd, gitPath));
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
    return {
      operation: operationIndex >= 0 ? (gitStateMarkers[operationIndex]?.[0] ?? null) : null,
      lastFetchedAt: metadata[0]?.mtime.toISOString() ?? null,
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

function deriveState(parsed: ParsedStatus, operation: RepositoryStatus['inProgressOperation']): RepositoryStatus['state'] {
  if (parsed.conflicted > 0) return 'conflict';
  if (operation) return 'operation-in-progress';
  if ((parsed.ahead ?? 0) > 0 && (parsed.behind ?? 0) > 0) return 'diverged';
  if (parsed.staged + parsed.modified + parsed.untracked + parsed.deleted + parsed.renamed > 0) return 'dirty';
  if ((parsed.ahead ?? 0) > 0) return 'ahead';
  if ((parsed.behind ?? 0) > 0) return 'behind';
  if (!parsed.upstream) return 'remote-unknown';
  return 'clean';
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
    const statusResult = await runGit(absolutePath, ['status', '--porcelain=v2', '--branch', '-z']);
    if (statusResult.exitCode !== 0) {
      return { ...base, state: 'invalid', error: statusResult.stderr || '不是有效的 Git worktree' };
    }
    const parsed = parsePorcelainV2(statusResult.stdout);
    const [lastCommitRaw, latestTagRaw, stashRaw, internalState, remoteUrl, identityRaw] = await Promise.all([
      runGitText(absolutePath, ['log', '-1', '--format=%H%x00%s%x00%an%x00%aI']).catch(() => ''),
      runGitText(absolutePath, [
        'for-each-ref',
        '--sort=-creatordate',
        '--count=1',
        '--format=%(refname:short)%00%(creatordate:iso-strict)',
        'refs/tags',
      ]).catch(() => ''),
      runGitText(absolutePath, ['stash', 'list', '--format=%gd']).catch(() => ''),
      repositoryInternalState(absolutePath),
      runGitText(absolutePath, ['remote', 'get-url', config.settings.defaultRemote]).catch(() => ''),
      runGitText(absolutePath, ['config', '--null', '--get-regexp', '^(user\\.name|user\\.email)$']).catch(() => ''),
    ]);
    const lastCommitParts = lastCommitRaw.split('\0');
    const latestTagParts = latestTagRaw.split('\0');
    return {
      ...base,
      ...parsed,
      available: true,
      stashCount: stashRaw ? stashRaw.split('\n').filter(Boolean).length : 0,
      inProgressOperation: internalState.operation,
      lastFetchedAt: internalState.lastFetchedAt,
      remoteUrl: remoteUrl ? sanitizeRemote(remoteUrl) : null,
      gitIdentity: parseGitIdentity(identityRaw),
      state: deriveState(parsed, internalState.operation),
      latestTag: latestTagParts[0]
        ? {
            name: latestTagParts[0],
            createdAt: latestTagParts[1] || null,
          }
        : null,
      lastCommit:
        lastCommitParts.length >= 4
          ? {
              hash: lastCommitParts[0] ?? '',
              subject: lastCommitParts[1] ?? '',
              author: lastCommitParts[2] ?? '',
              committedAt: lastCommitParts[3] ?? '',
            }
          : null,
    };
  } catch (error) {
    return { ...base, state: 'invalid', error: error instanceof Error ? error.message : 'Git 扫描失败' };
  }
}

export async function scanRepositories(config: RepositoriesConfig): Promise<RepositoryStatus[]> {
  const repositories = config.repositories.filter((repository) => repository.enabled);
  const results: Array<RepositoryStatus | undefined> = new Array(repositories.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(config.settings.localScanConcurrency, repositories.length) }, async () => {
    while (cursor < repositories.length) {
      const index = cursor++;
      const repository = repositories[index];
      if (repository) results[index] = await scanRepository(config, repository);
    }
  });
  await Promise.all(workers);
  return results.map((result, index) => {
    if (!result) throw new Error(`仓库扫描结果缺失：${repositories[index]?.name ?? index}`);
    return result;
  });
}
