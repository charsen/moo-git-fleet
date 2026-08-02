import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { RepositoriesConfig, ScanCandidate } from '../../shared/contracts.js';
import { isPathInside, loadRepositories } from '../config/store.js';
import { runGit, runGitText } from '../git/runner.js';
import { scanRoot } from '../git/scanner.js';
import {
  backupStatusSchema,
  type BackupStatus,
  type SessionBackupCandidate,
} from '../../shared/session-sync.js';

/**
 * 备份仓是一个普通的私有 Git 仓库，里面只有 Fleet 写的会话文件。
 * 这里只做三件事：记住它在哪、保证它不会写进错误的地方、以及 fetch/commit/push。
 * 内容层面的合并不在 Git 里做——同步流程会先把工作树对齐到远端，再把本机会话写上去，
 * 因此推送永远是快进，不会产生冲突标记。
 */

/**
 * 备份仓跟着仓库自己的分支走：clone 一个空私仓时 git 会按远端 HEAD 把本地分支设好
 * （Gitee 默认就是 master），强行改成 main 只会在远端多出一个没人要的分支。
 * 只有 Fleet 自己新建仓库、或者读不出分支名的异常态，才用下面这个默认值。
 */
const defaultBackupBranch = 'main';
const defaultRemoteName = 'origin';
const markerFileName = 'fleet.json';
const markerKind = 'moo-fleet-session-backup';

const backupBindingSchema = z.object({
  schemaVersion: z.literal(1),
  backupPath: z.string().min(1),
  remoteName: z.string().min(1).nullable(),
  remoteUrl: z.string().min(1).nullable(),
  createdAt: z.string(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type BackupBinding = z.infer<typeof backupBindingSchema>;


/**
 * 备份仓的写操作必须一个一个来：同步、处理冲突、删除都会 reset / commit / push 同一个仓库，
 * 两个同时跑会撞上 git 的 index.lock，也可能让一次 reset 抹掉另一次正在写的文件。
 * 这里用一条简单的串行队列，后来的排队等前一个做完（同步一次只要几十毫秒）。
 */
let backupQueue: Promise<unknown> = Promise.resolve();

export function withBackupLock<T>(task: () => Promise<T>): Promise<T> {
  const run = backupQueue.then(task, task);
  backupQueue = run.then(() => undefined, () => undefined);
  return run;
}

export class BackupRepoError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'BackupRepoError';
  }
}

export interface BackupRepoOptions {
  /** 覆盖绑定文件位置，测试用。 */
  bindingPath?: string;
  /** Moo Fleet 自己的源码仓库位置，用于阻止把备份写进开源仓库。 */
  fleetRepositoryPath?: string;
  now?: Date;
}

function dataHome(): string {
  if (process.env.GIT_FLEET_HOME) return path.resolve(process.env.GIT_FLEET_HOME);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Moo Fleet');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'Moo Fleet');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'moo-fleet');
}

function resolveBindingPath(options: BackupRepoOptions = {}): string {
  return path.resolve(options.bindingPath ?? path.join(dataHome(), 'config', 'session-backup.json'));
}

export function suggestedBackupPath(options: BackupRepoOptions = {}): string {
  const configDirectory = path.dirname(resolveBindingPath(options));
  const root = path.basename(configDirectory) === 'config' ? path.dirname(configDirectory) : configDirectory;
  return path.join(root, 'session-backup');
}

/** 备份文件里记录的来源设备，用于「两份都留」时区分是哪台电脑写的。 */
export function deviceName(): string {
  return (process.env.GIT_FLEET_DEVICE_NAME ?? os.hostname() ?? 'this-mac').replace(/\.local$/i, '');
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true).catch(() => false);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function loadBackupBinding(options: BackupRepoOptions = {}): Promise<BackupBinding | null> {
  const bindingPath = resolveBindingPath(options);
  const raw = await readFile(bindingPath, 'utf8').catch(() => null);
  if (!raw) return null;
  const parsed = backupBindingSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new BackupRepoError('本机的会话备份配置无法识别。请删除后重新设置备份位置。');
  }
  return parsed.data;
}

async function writeBackupBinding(binding: BackupBinding, options: BackupRepoOptions = {}): Promise<void> {
  await writeJsonAtomic(resolveBindingPath(options), backupBindingSchema.parse(binding));
}

export async function backupStatus(options: BackupRepoOptions = {}): Promise<BackupStatus> {
  const binding = await loadBackupBinding(options);
  return backupStatusSchema.parse({
    configured: Boolean(binding),
    backupPath: binding?.backupPath ?? null,
    remoteUrl: binding?.remoteUrl ?? null,
    remoteName: binding?.remoteName ?? null,
    suggestedBackupPath: suggestedBackupPath(options),
    device: deviceName(),
    lastSyncAt: binding?.lastSyncAt ?? null,
    lastError: binding?.lastError ?? null,
  });
}

export async function recordSyncResult(
  result: { at: string; error: string | null },
  options: BackupRepoOptions = {},
): Promise<void> {
  const binding = await loadBackupBinding(options);
  if (!binding) return;
  await writeBackupBinding(
    { ...binding, lastSyncAt: result.error ? binding.lastSyncAt : result.at, lastError: result.error },
    options,
  );
}

async function gitTopLevel(candidate: string): Promise<string | null> {
  const topLevel = await runGitText(candidate, ['rev-parse', '--show-toplevel']).catch(() => '');
  return topLevel ? realpath(topLevel).catch(() => path.resolve(topLevel)) : null;
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new BackupRepoError('无法访问这个备份位置，请换一个本机目录。');
    current = parent;
  }
  return realpath(current).catch(() => current);
}

function assertCredentialFreeRemote(remoteUrl: string): void {
  if (!remoteUrl.includes('://')) return;
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password || url.search || url.hash) {
      throw new BackupRepoError(
        '这个仓库的远端地址里带着用户名、密码或 Token。请用不带账号密码的地址重新 clone，或改用 SSH。',
      );
    }
  } catch (error) {
    if (error instanceof BackupRepoError) throw error;
  }
}

/** Fleet 自己的源码仓库位置；取不到就当作没有（只影响候选列表的排除，不影响写入守卫）。 */
async function fleetSourceRoot(options: BackupRepoOptions): Promise<string | null> {
  try {
    return await gitTopLevel(
      await nearestExistingAncestor(options.fleetRepositoryPath ?? process.env.GIT_FLEET_SOURCE_ROOT ?? process.cwd()),
    );
  } catch {
    return null;
  }
}

/** 备份仓不能落在 Fleet 自己的源码仓库里，也不能嵌套在别的 Git 仓库里。 */
async function assertSafeLocation(backupPath: string, options: BackupRepoOptions): Promise<void> {
  const fleetRoot = await gitTopLevel(
    await nearestExistingAncestor(options.fleetRepositoryPath ?? process.env.GIT_FLEET_SOURCE_ROOT ?? process.cwd()),
  );
  if (fleetRoot && (fleetRoot === backupPath || isPathInside(fleetRoot, backupPath) || isPathInside(backupPath, fleetRoot))) {
    throw new BackupRepoError('备份目录不能放在 Moo Fleet 的源码仓库里。请换一个独立目录。');
  }
  const containing = await gitTopLevel(await nearestExistingAncestor(backupPath));
  if (containing && containing !== backupPath && isPathInside(containing, backupPath)) {
    throw new BackupRepoError('备份目录不能放在另一个 Git 仓库里。请换一个独立目录。');
  }
}

/** 这个仓库是不是 Fleet 自己建的会话备份仓。 */
async function isFleetBackupRepository(repositoryPath: string): Promise<boolean> {
  const raw = await readFile(path.join(repositoryPath, markerFileName), 'utf8').catch(() => null);
  if (raw) {
    try {
      return (JSON.parse(raw) as { kind?: string }).kind === markerKind;
    } catch {
      return false;
    }
  }
  // 工作树可能刚被清空过，历史里有标记也算数。
  const tracked = await runGitText(repositoryPath, ['log', '-1', '--format=%H', '--', markerFileName]).catch(() => '');
  return Boolean(tracked);
}

/** 仓库里除了 .git 之外什么都没有，也没有任何提交。 */
export async function isPristineRepository(repositoryPath: string): Promise<boolean> {
  const entries = (await readdir(repositoryPath)).filter((name) => name !== '.git');
  if (entries.length > 0) return false;
  return !(await runGitText(repositoryPath, ['rev-parse', '--verify', 'HEAD']).catch(() => ''));
}

async function ensureRepository(backupPath: string): Promise<string> {
  if (!(await exists(backupPath))) {
    await mkdir(backupPath, { recursive: true, mode: 0o700 });
  }
  const info = await stat(backupPath);
  if (!info.isDirectory()) throw new BackupRepoError('备份位置必须是一个目录。');
  const resolved = await realpath(backupPath);
  const topLevel = await gitTopLevel(resolved);
  if (topLevel && topLevel !== resolved) {
    throw new BackupRepoError('这个位置属于另一个 Git 仓库。请选择仓库根目录或一个空目录。');
  }
  if (topLevel === resolved) {
    // 同步时会把工作树对齐到远端（reset --hard + clean），所以绝不能落在一个还有别的内容的仓库上。
    if (!(await isFleetBackupRepository(resolved)) && !(await isPristineRepository(resolved))) {
      throw new BackupRepoError(
        '这个 Git 仓库里已经有别的内容。会话同步会把备份目录整体对齐到远端，可能覆盖你的文件——请改用空目录或专门的会话备份仓库。',
      );
    }
    await ensureBackupBranch(resolved);
    return resolved;
  }
  if ((await readdir(resolved)).length > 0) {
    throw new BackupRepoError('备份目录需要是空目录或已有的 Git 仓库。请清空后重试。');
  }
  await chmod(resolved, 0o700);
  await runGitText(resolved, ['init', `--initial-branch=${defaultBackupBranch}`]);
  return resolved;
}

/** 仓库当前所在的分支；读不出来（detached 之类的异常态）就退回默认分支。 */
async function currentBackupBranch(repositoryPath: string): Promise<string> {
  const branch = await runGitText(repositoryPath, ['symbolic-ref', '--short', 'HEAD']).catch(() => '');
  return branch || defaultBackupBranch;
}

/**
 * 还没有提交的空仓库保持它自己的分支（clone 空私仓时 git 已经按远端 HEAD 设好了）；
 * 只有连分支名都读不出来时才落到默认分支，免得推送时本地分支和远端对不上。
 */
async function ensureBackupBranch(repositoryPath: string): Promise<void> {
  if (await runGitText(repositoryPath, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) return;
  if (await runGitText(repositoryPath, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')) return;
  await runGitText(repositoryPath, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBackupBranch}`]).catch(() => undefined);
}

export interface InitializeBackupInput {
  /** 留空则用建议位置（只备份在本机）。 */
  backupPath?: string | null;
}

/**
 * 跨电脑同步不再需要任何 URL 配置：用户自己 clone 一个空的私有仓库，
 * 在设置里选中那个文件夹，remote 直接从仓库自身的 origin 读出来。
 */
export async function initializeBackup(
  input: InitializeBackupInput,
  options: BackupRepoOptions = {},
): Promise<BackupStatus> {
  const now = options.now ?? new Date();

  const requestedPath = path.resolve(input.backupPath?.trim() || suggestedBackupPath(options));
  await assertSafeLocation(requestedPath, options);
  const backupPath = await ensureRepository(requestedPath);
  await assertSafeLocation(backupPath, options);

  // 没有 origin 就是「只备份在本机」，这是完全正常的一种用法。
  const detectedRemote = (await runGitText(backupPath, ['remote', 'get-url', defaultRemoteName]).catch(() => '')).trim();
  const remoteUrl = detectedRemote || null;
  if (remoteUrl) assertCredentialFreeRemote(remoteUrl);

  const markerPath = path.join(backupPath, markerFileName);
  if (!(await exists(markerPath))) {
    await writeJsonAtomic(markerPath, { schemaVersion: 1, kind: markerKind });
  }

  const previous = await loadBackupBinding(options);
  await writeBackupBinding(
    {
      schemaVersion: 1,
      backupPath,
      remoteName: remoteUrl ? defaultRemoteName : null,
      remoteUrl,
      createdAt: previous?.createdAt ?? now.toISOString(),
      lastSyncAt: previous?.lastSyncAt ?? null,
      lastError: null,
    },
    options,
  );
  return backupStatus(options);
}

export interface ListBackupCandidatesOptions extends BackupRepoOptions {
  /** 直接给一份仓库配置（测试用）；默认读本机配置。 */
  config?: RepositoriesConfig;
}

/**
 * 在已配置的扫描根目录里找出「可以拿来当备份仓」的文件夹：
 * Fleet 自己建过的会话备份仓，或者一个还没有任何提交的空仓库（典型是刚 clone 下来的空私仓）。
 * 其余仓库都不列出来——同步会把工作树整体对齐到远端，落在用户自己的仓库上会抹掉东西。
 */
export async function listBackupCandidates(
  options: ListBackupCandidatesOptions = {},
): Promise<SessionBackupCandidate[]> {
  const config = options.config ?? (await loadRepositories());
  const fleetRoot = await fleetSourceRoot(options);
  const scanned = await Promise.all(
    Object.keys(config.settings.roots).map((rootId) =>
      scanRoot(config, rootId).catch(() => [] as ScanCandidate[]),
    ),
  );

  const byPath = new Map<string, SessionBackupCandidate>();
  for (const candidate of scanned.flat()) {
    if (byPath.has(candidate.absolutePath)) continue;
    if (fleetRoot && (candidate.absolutePath === fleetRoot || isPathInside(fleetRoot, candidate.absolutePath))) continue;
    const pristine = candidate.sessionBackup
      ? false
      : await isPristineRepository(candidate.absolutePath).catch(() => false);
    if (!candidate.sessionBackup && !pristine) continue;
    byPath.set(candidate.absolutePath, {
      path: candidate.absolutePath,
      name: candidate.name,
      kind: candidate.sessionBackup ? 'session-backup' : 'empty-repo',
      remoteUrl: candidate.remote,
    });
  }
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function requireBackupBinding(options: BackupRepoOptions = {}): Promise<BackupBinding> {
  const binding = await loadBackupBinding(options);
  if (!binding) throw new BackupRepoError('还没有设置会话备份位置。请先完成一次设置。');
  if (!(await exists(binding.backupPath))) {
    throw new BackupRepoError(`找不到备份目录 ${binding.backupPath}。请重新设置备份位置。`);
  }
  // 目录还在但仓库没了（被手动删过 .git、或者目录被别的东西替换了）。
  if ((await gitTopLevel(binding.backupPath)) !== (await realpath(binding.backupPath).catch(() => binding.backupPath))) {
    throw new BackupRepoError(
      `备份目录 ${binding.backupPath} 已经不是一个 Git 仓库了。请在设置里重新连接备份位置；本机会话不受影响。`,
    );
  }
  return binding;
}

export async function localHead(backupPath: string): Promise<string | null> {
  return (await runGitText(backupPath, ['rev-parse', 'HEAD']).catch(() => '')) || null;
}

export async function remoteHead(backupPath: string, remoteName: string): Promise<string | null> {
  const branch = await currentBackupBranch(backupPath);
  return (
    (await runGitText(backupPath, ['rev-parse', `refs/remotes/${remoteName}/${branch}`]).catch(() => '')) || null
  );
}

/**
 * 取回另一台电脑的备份。连不上私有 Git（离线、断网、临时故障）不算失败——
 * 本机备份才是这次同步的主要目的，远端拿不到就先只在本机做。
 * 返回连不上的原因，交给上层如实告诉用户。
 */
export async function fetchBackupRemote(backupPath: string, remoteName: string): Promise<string | null> {
  const branch = await currentBackupBranch(backupPath);
  const result = await runGit(
    backupPath,
    ['fetch', '--prune', remoteName, `+refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`],
    300_000,
  );
  if (result.exitCode === 0) return null;
  // 远端还是空仓库：正常的首次同步情形，不用提示。
  if (/couldn't find remote ref/i.test(result.stderr)) return null;
  return result.stderr.trim().split('\n').at(-1) ?? '未知错误';
}

/**
 * 把工作树对齐到远端最新状态。本机备份仓里的内容都能从本机会话重新生成，
 * 因此这里可以直接跟随远端，同步流程随后会把本机会话重新写上去。
 */
export async function alignToRemote(backupPath: string, head: string): Promise<void> {
  const result = await runGit(backupPath, ['reset', '--hard', head], 120_000);
  if (result.exitCode !== 0) throw new BackupRepoError('无法对齐到另一台电脑的备份，请稍后重试。');
  await runGit(backupPath, ['clean', '-fd'], 120_000);
}

/** 提交工作树里的全部改动；没有改动时返回 false。 */
export async function commitAll(backupPath: string, message: string): Promise<boolean> {
  await runGitText(backupPath, ['add', '-A']);
  const staged = await runGitText(backupPath, ['diff', '--cached', '--name-only']).catch(() => '');
  if (!staged.trim()) return false;
  const result = await runGit(
    backupPath,
    ['-c', 'user.name=Moo Fleet', '-c', 'user.email=fleet@localhost', 'commit', '-m', message],
    120_000,
  );
  if (result.exitCode !== 0) throw new BackupRepoError('保存备份提交失败，请检查备份目录状态。');
  return true;
}

/**
 * 上传到私有 Git。失败不抛错——本机备份已经写好了，这里只把原因带回去，
 * 让界面显示「已在本机备份，但没能上传」，下次同步会把落下的提交一起带上。
 */
export async function pushBackup(backupPath: string, remoteName: string): Promise<string | null> {
  const head = await localHead(backupPath);
  if (!head) return null;
  // 远端已经有这个提交时不用再推一次（离线且无改动的场景下就不会白报错）。
  if ((await remoteHead(backupPath, remoteName)) === head) return null;
  const branch = await currentBackupBranch(backupPath);
  const result = await runGit(
    backupPath,
    ['push', remoteName, `${head}:refs/heads/${branch}`],
    300_000,
  );
  if (result.exitCode === 0) {
    await runGit(backupPath, ['update-ref', `refs/remotes/${remoteName}/${branch}`, head], 30_000);
    return null;
  }
  return result.stderr.trim().split('\n').at(-1) ?? '未知错误';
}
