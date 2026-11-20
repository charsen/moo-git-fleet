import { createHash } from 'node:crypto';
import { lstat, readlink, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import type { CommitPreview, FileChange, IgnoredEntry } from '../../shared/contracts.js';
import type { DiscardAllResult } from '../../shared/contracts.js';
import { isRenamedOrCopiedFile, isUncommittedNewFile } from '../../shared/file-status.js';
import { conflictError, invalidRequestError } from '../errors.js';
import { mapWithConcurrency } from '../concurrency.js';
import { gitStatusTimeoutMs, runGit, runGitText } from './runner.js';

interface RegisteredFile {
  repositoryId: string;
  path: string;
  snapshot: string;
  expiresAt: number;
}

const fileRegistry = new Map<string, RegisteredFile>();
const fileTokenTtlMs = 10 * 60 * 1000;
/** 生成稳定文件 token 用的固定 UUIDv5 命名空间。 */
const fileTokenNamespace = '2f6a3d9e-7c41-4b8a-9f2d-6b1c0a5e8d74';
const maxPatchBytes = 120_000;
/** 已忽略清单的单次展示上限；`node_modules` 之类可能上千条，超出只提示截断。 */
const maxIgnoredEntries = 300;
const ignoredListingMaxBytes = 2_000_000;
let lastFileRegistryPruneAt = 0;

function stripFinalLineBreak(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

export interface CommitExecution {
  hash: string;
  expectedTree: string;
  actualTree: string;
  treeMatches: boolean;
}

export function safeRepositoryPath(cwd: string, relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('..')) {
    throw invalidRequestError('Git 文件路径不安全');
  }
  const absolutePath = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw invalidRequestError('Git 文件路径超出仓库');
}

function pruneExpiredFileTokens(now: number): void {
  if (now - lastFileRegistryPruneAt < 60_000) return;
  lastFileRegistryPruneAt = now;
  for (const [id, registered] of fileRegistry) {
    if (registered.expiresAt < now) fileRegistry.delete(id);
  }
}

/**
 * 文件 token 按内容寻址：内容与状态没变就复用同一个 id。
 * 否则每次列目录都换 id，后台刷新会把提交预览和「暂存 / 丢弃」的在途操作一起打乱。
 * 散列成 UUIDv5 形态是因为写接口的 schema 按 UUID 校验 fileId。
 */
function stableFileToken(repositoryId: string, relativePath: string, snapshot: string): string {
  const namespace = Buffer.from(fileTokenNamespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(namespace).update(`${repositoryId}\0${relativePath}\0${snapshot}`).digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5（命名散列）
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function registerFile(repositoryId: string, relativePath: string, snapshot: string): string {
  const now = Date.now();
  pruneExpiredFileTokens(now);
  const id = stableFileToken(repositoryId, relativePath, snapshot);
  fileRegistry.set(id, { repositoryId, path: relativePath, snapshot, expiresAt: now + fileTokenTtlMs });
  return id;
}

/**
 * 登记一个文件 token。忽略清单、assume-unchanged 清单与工作区文件列表共用同一套
 * 「浏览器只拿 token、不拿路径」的间接寻址，所以其它模块也用这个入口注册。
 */
export function registerFileToken(repositoryId: string, relativePath: string, snapshot: string): string {
  return registerFile(repositoryId, relativePath, snapshot);
}

function registeredFile(repositoryId: string, id: string): RegisteredFile {
  const registered = fileRegistry.get(id);
  if (!registered || registered.repositoryId !== repositoryId || registered.expiresAt < Date.now()) {
    throw conflictError('文件列表已过期，请刷新仓库详情');
  }
  return registered;
}

export function resolveFileIds(repositoryId: string, fileIds: string[]): string[] {
  const paths = fileIds.map((id) => registeredFile(repositoryId, id).path);
  return [...new Set(paths)];
}

async function worktreeFileIdentity(cwd: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(cwd, relativePath);
  try {
    const info = await lstat(absolutePath, { bigint: true });
    const symlinkTarget = info.isSymbolicLink() ? await readlink(absolutePath) : '';
    return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs, symlinkTarget].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function fileSnapshot(file: Omit<FileChange, 'id'>, identity: string): string {
  return [file.indexStatus, file.worktreeStatus, file.originalPath ?? '', identity].join('\0');
}

export async function listRepositoryFiles(repositoryId: string, cwd: string): Promise<FileChange[]> {
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], gitStatusTimeoutMs);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取文件状态失败');
  const records = result.stdout.toString('utf8').split('\0').filter(Boolean);
  const files: Array<Omit<FileChange, 'id'>> = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const relativePath = record.slice(3);
    safeRepositoryPath(cwd, relativePath);
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C';
    const originalPath = renamed ? (records[index + 1] ?? null) : null;
    if (originalPath) {
      safeRepositoryPath(cwd, originalPath);
      index += 1;
    }
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const conflicted = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(`${indexStatus}${worktreeStatus}`);
    files.push({
      path: relativePath,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged: !untracked && indexStatus !== ' ' && indexStatus !== '?',
      unstaged: untracked || (worktreeStatus !== ' ' && worktreeStatus !== '?'),
      untracked,
      conflicted,
    });
  }
  // 文件多时（monorepo 上万条）逐个 lstat；限并发，避免瞬间打出上万个 syscall。
  const registeredFiles = await mapWithConcurrency(files, 64, async (file) => {
    const identity = await worktreeFileIdentity(cwd, file.path);
    return { id: registerFile(repositoryId, file.path, fileSnapshot(file, identity)), ...file };
  });
  return registeredFiles.sort((a, b) => Number(b.conflicted) - Number(a.conflicted) || a.path.localeCompare(b.path));
}

export interface IgnoredEntriesResult {
  entries: IgnoredEntry[];
  truncated: boolean;
}

/**
 * 列出被 Git 忽略的条目。`--directory` 让被忽略的目录折叠成一条，避免把整个
 * `node_modules` 展开成几万行；清单只读展示，但仍然注册 token 以便「打开 / 在访达中显示」。
 */
export async function listIgnoredEntries(repositoryId: string, cwd: string): Promise<IgnoredEntriesResult> {
  const result = await runGit(
    cwd,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'],
    15_000,
    undefined,
    ignoredListingMaxBytes,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取已忽略文件失败');
  const records = result.stdout.toString('utf8').split('\0').filter(Boolean);
  // stdout 被字节上限截断时，末尾一条可能是半条路径，丢弃而不是登记。
  if (result.stdoutTruncated) records.pop();
  const truncated = result.stdoutTruncated || records.length > maxIgnoredEntries;
  const entries = records.slice(0, maxIgnoredEntries).map((record) => {
    safeRepositoryPath(cwd, record);
    return { id: registerFile(repositoryId, record, 'ignored'), path: record, directory: record.endsWith('/') };
  });
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}

export function resolveCurrentFileAction(repositoryId: string, fileId: string, currentFiles: FileChange[]): FileChange {
  const requested = registeredFile(repositoryId, fileId);
  const current = currentFiles.find((file) => file.path === requested.path);
  if (!current) throw conflictError('文件内容或状态已变化，请刷新仓库详情');
  const currentRegistration = registeredFile(repositoryId, current.id);
  if (currentRegistration.snapshot !== requested.snapshot) {
    throw conflictError('文件内容或状态已变化，请刷新仓库详情');
  }
  return current;
}

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  paths.forEach((relativePath) => safeRepositoryPath(cwd, relativePath));
  await runGitText(cwd, ['add', '--', ...paths]);
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<void> {
  paths.forEach((relativePath) => safeRepositoryPath(cwd, relativePath));
  await runGitText(cwd, ['reset', '--', ...paths]);
}

export interface DiscardFileResult {
  action: 'trash' | 'restore';
  path: string;
}

export async function discardFileChange(
  cwd: string,
  file: FileChange,
  moveToTrash: (absolutePath: string) => Promise<void>,
): Promise<DiscardFileResult> {
  safeRepositoryPath(cwd, file.path);
  if (file.conflicted) throw new Error('冲突文件必须手工处理，不能快捷删除或丢弃');
  if (file.staged) throw new Error('文件已暂存，请先取消暂存再处理');
  if (file.untracked) {
    await moveToTrash(path.resolve(cwd, file.path));
    return { action: 'trash', path: file.path };
  }
  // 已跟踪路径是目录 → 只可能是 gitlink（子模块）。移目录 + restore 会留下空目录，
  // 子模块的 checkout 和其中未提交的工作都回不来。
  const worktreeInfo = await lstat(path.resolve(cwd, file.path)).catch(() => null);
  if (worktreeInfo?.isDirectory()) throw new Error('子模块需要手工处理（请用 git submodule update）');
  if (!file.unstaged) throw new Error('文件当前没有可丢弃的工作区修改');
  if (!['M', 'D', 'T'].includes(file.worktreeStatus)) {
    throw new Error('重命名或复杂文件状态必须手工处理');
  }
  if (file.worktreeStatus !== 'D') await moveToTrash(path.resolve(cwd, file.path));
  await runGitText(cwd, ['restore', '--worktree', '--', file.path]);
  return { action: 'restore', path: file.path };
}

export interface DiscardUncommittedResult {
  trashed: string[];
  /** 索引里只有 add 记录、工作区文件已经不在：取消暂存即完事，没有可进废纸篓的东西。 */
  indexedOnly: string[];
  failed: Array<{ path: string; message: string }>;
}

/**
 * 批量删除「从未提交过的新文件」。
 *
 * 两件事一起做：勾选即 `git add`，所以已暂存的先一次性取消暂存（`git reset --`），
 * 再把工作区文件整批移进系统废纸篓。
 *
 * 顺序是刻意的——**全部校验跑完才动手**。中途才发现某一条非法，前面的文件已经进了
 * 废纸篓、索引也回不去；而按文件回报失败又必须允许部分成功，两者只能靠「校验前置」
 * 分开：非法输入整体拒绝，废纸篓运行期的失败逐条记进 `failed` 并继续处理其余文件。
 */
export async function discardUncommittedFiles(
  cwd: string,
  files: FileChange[],
  moveToTrash: (absolutePaths: string[]) => Promise<void>,
): Promise<DiscardUncommittedResult> {
  for (const file of files) {
    safeRepositoryPath(cwd, file.path);
    if (file.conflicted) throw new Error('冲突文件必须手工处理，不能快捷删除或丢弃');
    if (!isUncommittedNewFile(file)) throw new Error(`只能删除未提交的新文件：${file.path}`);
  }
  const identities = await Promise.all(files.map((file) => worktreeFileIdentity(cwd, file.path)));
  const present = files.filter((_, index) => identities[index] !== 'missing');
  const indexedOnly = files.filter((_, index) => identities[index] === 'missing').map((file) => file.path);

  const stagedPaths = files.filter((file) => file.staged).map((file) => file.path);
  if (stagedPaths.length) await unstageFiles(cwd, stagedPaths);

  let trashed: string[] = [];
  const failed: DiscardUncommittedResult['failed'] = [];
  if (present.length) {
    const absolutePaths = present.map((file) => path.resolve(cwd, file.path));
    try {
      // 整批只起一次进程：逐个文件调用时，进程启动（macOS 13/14 是一次 osascript）才是大头。
      await moveToTrash(absolutePaths);
      trashed = present.map((file) => file.path);
    } catch {
      // 一次批量调用说不清是哪个文件没删掉，按文件重来一遍才能准确回报。
      // 批量那一步可能已经删掉了一部分，仍存在的才值得再调用。
      for (const [index, file] of present.entries()) {
        if ((await worktreeFileIdentity(cwd, file.path)) === 'missing') {
          trashed.push(file.path);
          continue;
        }
        try {
          await moveToTrash([absolutePaths[index]!]);
          trashed.push(file.path);
        } catch (error) {
          failed.push({ path: file.path, message: error instanceof Error ? error.message : '移到废纸篓失败' });
        }
      }
    }
  }
  return { trashed, indexedOnly, failed };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * 找出这些路径里哪些是 gitlink（子模块）。
 *
 * status 把子模块显示成一条普通改动，但它的内容是独立仓库；按普通文件「移目录 + restore」
 * 只会留下空目录，子模块的 checkout 和其中未提交的工作都回不来。
 */
async function readGitlinkPaths(cwd: string, paths: string[]): Promise<Set<string>> {
  const gitlinks = new Set<string>();
  // 分批传路径：一次几十万个文件会撞 ARG_MAX；200 条一批也够快。
  for (let offset = 0; offset < paths.length; offset += 200) {
    const batch = paths.slice(offset, offset + 200);
    const result = await runGit(cwd, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...batch], 15_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || '读取子模块状态失败');
    for (const record of result.stdout.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      if (record.slice(0, tab).startsWith('160000 ')) gitlinks.add(record.slice(tab + 1));
    }
  }
  return gitlinks;
}

async function repositoryGitDirectory(cwd: string): Promise<string> {
  const gitDir = (await runGitText(cwd, ['rev-parse', '--git-dir'])).trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
}

/**
 * 把索引里的内容备份成文件再送进废纸篓。
 *
 * 备份放在 git 目录里：与工作区同卷（trash 仍是同卷移动）、不出现在 git status 里，
 * 也不会像「工作区旁边的副本」那样在短暂窗口内被后台扫描当成未跟踪文件。
 */
async function trashIndexCopy(
  cwd: string,
  gitDir: string,
  file: FileChange,
  index: number,
  moveToTrash: (absolutePaths: string[]) => Promise<void>,
): Promise<void> {
  const result = await runGit(cwd, ['show', `:${file.path}`], 15_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取索引内容失败');
  const baseName = path.basename(file.path).slice(0, 80);
  // 时间戳 + 序号：同一文件的多次备份不会互相覆盖，废纸篓里也能按名字认出内容。
  const backupPath = path.join(gitDir, `${baseName}.丢弃前备份索引-${Date.now()}-${index}`);
  await writeFile(backupPath, result.stdout);
  try {
    await moveToTrash([backupPath]);
  } catch (error) {
    // 失败时清掉残留副本，别把它留在 .git 里。
    await rm(backupPath, { force: true });
    throw error;
  }
}

export interface DiscardTrackedResult {
  /** 已还原到 HEAD 的文件（索引与工作区都回到上次提交）。 */
  restored: string[];
  /** 还原前进入系统废纸篓的已跟踪文件：工作区内容，或仅存在于索引里的暂存内容。 */
  backedUp: string[];
  /** 明确跳过、未处理的文件：冲突 / 未提交新文件 / 重命名 / 子模块 / 复杂状态等。 */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * 批量「还原已勾选的文件到 HEAD」——把这些**已跟踪**文件的工作区改动丢弃并取消暂存。
 *
 * 工作区里的「勾选」动作本身就是 `git add`（见 fileStageAction），所以勾选 = 已暂存。
 * 因此「还原」= `git restore --staged --worktree -- <path>`：同时清掉索引里的暂存与工作区的改动，
 * 文件整体回到上次提交。语义等同于一次「丢弃这批文件的改动」。
 *
 * 备份口径（必须覆盖 restore 会毁掉的每一份内容）：
 * - 工作区里存在的文件先移入系统废纸篓（restore 会覆盖它）；
 * - 只存在于索引的内容（纯暂存后删掉工作区文件 MD、或 MM 的暂存版本）单独 `git show :path`
 *   备份进废纸篓——只看 `unstaged` 会把这些内容直接毁掉；
 * - `D `（索引里已删除）本来就没有内容可备份。
 *
 * 安全口径：
 * - 未提交的新文件（未跟踪或已 add 的 A）跳过：A 在 HEAD 里不存在，restore 会把它从工作区删掉；
 * - 重命名 / 复制、子模块跳过：前者 restore 只能拉回新路径，后者是独立仓库；
 * - 逐个还原并容错：单个失败记入 `skipped` 继续其余，备份整批失败再逐条重试。
 */
export async function discardTrackedChanges(
  cwd: string,
  files: FileChange[],
  moveToTrash: (absolutePaths: string[]) => Promise<void>,
): Promise<DiscardTrackedResult> {
  const restored: string[] = [];
  const backedUp: string[] = [];
  const skipped: DiscardTrackedResult['skipped'] = [];
  const candidates: FileChange[] = [];
  for (const file of files) {
    safeRepositoryPath(cwd, file.path);
    if (file.conflicted) { skipped.push({ path: file.path, reason: '冲突文件必须手工处理' }); continue; }
    if (isUncommittedNewFile(file)) { skipped.push({ path: file.path, reason: '未提交的新文件请用「删除未提交文件」' }); continue; }
    if (isRenamedOrCopiedFile(file)) { skipped.push({ path: file.path, reason: '重命名需要手工处理' }); continue; }
    if (!(file.staged || file.unstaged)) { skipped.push({ path: file.path, reason: '没有可还原的改动' }); continue; }
    candidates.push(file);
  }

  const gitlinks = candidates.length ? await readGitlinkPaths(cwd, candidates.map((file) => file.path)) : new Set<string>();
  const targets = candidates.filter((file) => {
    if (!gitlinks.has(file.path)) return true;
    skipped.push({ path: file.path, reason: '子模块需要手工处理（请用 git submodule update）' });
    return false;
  });

  const identities = await Promise.all(targets.map((file) => worktreeFileIdentity(cwd, file.path)));
  const present = new Set(targets.filter((_, index) => identities[index] !== 'missing').map((file) => file.path));
  // 工作区没有或与索引不同时，索引里才可能有一份别处没有的版本。
  const needsIndexBackup = new Set(
    targets
      .filter((file, index) => file.staged && file.indexStatus.trim() !== 'D' && (identities[index] === 'missing' || file.unstaged))
      .map((file) => file.path),
  );

  // 先备份索引：这一步不碰工作区，失败时文件仍完好，可以安全跳过这个文件。
  const indexBackedUp = new Set<string>();
  if (needsIndexBackup.size) {
    try {
      const gitDir = await repositoryGitDirectory(cwd);
      let backupIndex = 0;
      for (const file of targets) {
        if (!needsIndexBackup.has(file.path)) continue;
        try {
          await trashIndexCopy(cwd, gitDir, file, backupIndex++, moveToTrash);
          indexBackedUp.add(file.path);
        } catch (error) {
          skipped.push({ path: file.path, reason: `备份索引内容失败：${errorMessage(error, '移到废纸篓失败')}` });
        }
      }
    } catch (error) {
      for (const file of targets) {
        if (needsIndexBackup.has(file.path)) {
          skipped.push({ path: file.path, reason: `备份索引内容失败：${errorMessage(error, '读取 Git 目录失败')}` });
        }
      }
    }
  }

  const backupReady = targets.filter((file) => !needsIndexBackup.has(file.path) || indexBackedUp.has(file.path));
  const toBackup = backupReady.filter((file) => present.has(file.path));
  const backupOk = new Set<string>();
  if (toBackup.length) {
    const absolutePaths = toBackup.map((file) => path.resolve(cwd, file.path));
    try {
      await moveToTrash(absolutePaths);
      toBackup.forEach((file) => backupOk.add(file.path));
    } catch {
      // 批量失败说不清是哪个，逐条重试：仅当备份没成功时再调一次。
      for (const [index, file] of toBackup.entries()) {
        if ((await worktreeFileIdentity(cwd, file.path)) === 'missing') {
          backupOk.add(file.path);
          continue;
        }
        try {
          await moveToTrash([absolutePaths[index]!]);
          backupOk.add(file.path);
        } catch (error) {
          skipped.push({ path: file.path, reason: errorMessage(error, '移到废纸篓失败') });
        }
      }
    }
  }

  for (const file of targets) {
    // 需要备份但没备份成功的，跳过（已记入 skipped）。
    if (needsIndexBackup.has(file.path) && !indexBackedUp.has(file.path)) continue;
    if (present.has(file.path) && !backupOk.has(file.path)) continue;
    try {
      // 同时取消暂存并还原工作区，文件整体回到 HEAD。
      await runGitText(cwd, ['restore', '--staged', '--worktree', '--', file.path]);
      restored.push(file.path);
      if (backupOk.has(file.path) || indexBackedUp.has(file.path)) backedUp.push(file.path);
    } catch (error) {
      // 备份已经成功时，工作区文件可能已经进了废纸篓；把这一点写进原因，别让用户以为什么都没发生。
      const note = backupOk.has(file.path) || indexBackedUp.has(file.path) ? '（内容已备份到废纸篓）' : '';
      skipped.push({ path: file.path, reason: `${errorMessage(error, '还原失败')}${note}` });
    }
  }

  return { restored, backedUp, skipped };
}

/**
 * 「丢弃全部本地改动」：把当前文件列表里的**安全子集**整体还原，其余逐条说明原因。
 *
 * 范围是服务端在写锁内自己枚举的列表（不是用户勾选），所以没有「非法输入整体拒绝」
 * 的前提——分类本身就是校验：能安全还原的做，不能的进 `skipped` 并带原因。
 * 组成：
 * - 已跟踪文件（含已暂存）→ 复用 `discardTrackedChanges`（取消暂存 + 还原到 HEAD，
 *   工作区内容与仅存在于索引的内容都先备份废纸篓）；
 * - 未提交过的新文件（未跟踪或已 add 的 `A`）→ 复用 `discardUncommittedFiles`
 *   （先取消暂存再整批进废纸篓）；
 * - 其余（冲突、重命名、子模块等复杂状态）→ `skipped`，不猜语义。
 *
 * 单个文件运行期失败只记入 `skipped` 继续其余，与两个底层函数的容错口径一致。
 */
export async function discardAllLocalChanges(
  cwd: string,
  files: FileChange[],
  moveToTrash: (absolutePaths: string[]) => Promise<void>,
): Promise<DiscardAllResult> {
  const skipped: DiscardTrackedResult['skipped'] = [];

  const tracked: FileChange[] = [];
  const newFiles: FileChange[] = [];
  for (const file of files) {
    // 新文件必须走 discardUncommittedFiles：restore 对 A 会直接删掉工作区文件且不进废纸篓。
    if (isUncommittedNewFile(file)) newFiles.push(file);
    else tracked.push(file);
  }

  // 冲突 / 重命名 / 子模块等复杂状态由 discardTrackedChanges 统一分类跳过。
  const trackedResult = tracked.length
    ? await discardTrackedChanges(cwd, tracked, moveToTrash)
    : { restored: [] as string[], backedUp: [] as string[], skipped: [] as DiscardTrackedResult['skipped'] };
  skipped.push(...trackedResult.skipped);

  // discardUncommittedFiles 对非法项整体拒绝，所以只把判据通过的新文件交给它；
  // 复杂状态（理论上极少：新文件的 rename）在进入前就落进 skipped。
  const deletable = newFiles.filter((file) => !file.conflicted);
  newFiles.filter((file) => file.conflicted).forEach((file) => {
    skipped.push({ path: file.path, reason: '冲突文件必须手工处理' });
  });
  const newResult = deletable.length
    ? await discardUncommittedFiles(cwd, deletable, moveToTrash)
    : { trashed: [] as string[], indexedOnly: [] as string[], failed: [] as Array<{ path: string; message: string }> };
  // 运行期失败逐条转成 skipped，口径与其余条目一致。
  newResult.failed.forEach((item) => skipped.push({ path: item.path, reason: item.message }));

  return {
    restored: trackedResult.restored,
    // 两个数组语义必须分开：trashed 是真被删除的新文件，backedUp 是还原前先备份了
    // 工作区/索引内容的已跟踪文件。合并在一起的话，客户端的「清理 N 个新文件」会把
    // 备份副本也算进去——真机上确实因此出现过「清理 2 个新文件」的失实消息。
    trashed: newResult.trashed,
    backedUp: trackedResult.backedUp,
    skipped,
  };
}

/**
 * 单个文件的差异。
 *
 * 超过 `maxPatchBytes` 时截断，并把结果放在 `truncated` 里返回，而不是往补丁文本尾部
 * 拼一句「… diff 已截断 …」：拼进去的那句话会被当成 diff 正文渲染成一行灰字，
 * 既不像提示，也会让调用方只能靠字符串嗅探判断截断。
 */
export async function fileDiff(
  cwd: string,
  relativePath: string,
  kind: 'staged' | 'unstaged',
): Promise<{ patch: string; truncated: boolean }> {
  safeRepositoryPath(cwd, relativePath);
  let untracked = false;
  if (kind === 'unstaged') {
    const untrackedResult = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', relativePath]);
    if (untrackedResult.exitCode !== 0) throw new Error(untrackedResult.stderr || '读取文件状态失败');
    untracked = untrackedResult.stdout.toString('utf8').split('\0').includes(relativePath);
  }
  const args = kind === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', relativePath]
    : untracked
      // 与「空文件」比较：git diff --no-index 需要一个不存在的参照路径。
      // 用 os.devNull 而非写死 /dev/null——Windows 上是 \\.\nul，/dev/null 不存在会直接报错。
      ? ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', devNull, relativePath]
      : ['diff', '--no-ext-diff', '--no-color', '--', relativePath];
  const result = await runGit(cwd, args, 15_000, undefined, maxPatchBytes);
  if (result.exitCode !== 0 && !(untracked && result.exitCode === 1)) {
    throw new Error(result.stderr || '读取文件 diff 失败');
  }
  const output = stripFinalLineBreak(result.stdout.toString('utf8'));
  return { patch: output, truncated: result.stdoutTruncated };
}

async function snapshotFingerprint(cwd: string, tree: string): Promise<string> {
  const [branch, head] = await Promise.all([
    runGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']),
    runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
  ]);
  // Exit 1 is expected for detached HEAD or an unborn branch, respectively.
  if (branch.exitCode > 1 || head.exitCode > 1 || (branch.exitCode === 1 && head.exitCode === 1))
    throw new Error(branch.stderr || head.stderr || '读取提交所在分支失败');
  return createHash('sha256').update(JSON.stringify([
    tree, branch.stdout.toString('utf8').trim(), head.stdout.toString('utf8').trim(),
  ])).digest('hex');
}

export async function stagedFingerprint(cwd: string): Promise<string> {
  const tree = await runGitText(cwd, ['write-tree']);
  return snapshotFingerprint(cwd, tree);
}

export async function commitPreview(cwd: string): Promise<CommitPreview> {
  const fingerprintBefore = await stagedFingerprint(cwd);
  const [names, stat, patchResult] = await Promise.all([
    runGitText(cwd, ['diff', '--cached', '--name-only', '-z']),
    runGitText(cwd, ['diff', '--cached', '--stat', '--stat-count=200', '--no-color']),
    runGit(cwd, ['diff', '--cached', '--no-ext-diff', '--no-color'], 15_000, undefined, maxPatchBytes),
  ]);
  const fingerprintAfter = await stagedFingerprint(cwd);
  if (fingerprintBefore !== fingerprintAfter) throw conflictError('暂存区已变化或分支/HEAD 已切换，请重新预览');
  const files = names.split('\0').filter(Boolean);
  if (files.length === 0) throw conflictError('暂存区为空，没有可提交内容');
  if (patchResult.exitCode !== 0) throw new Error(patchResult.stderr || '读取 staged diff 失败');
  const truncated = patchResult.stdoutTruncated;
  const patch = patchResult.stdout.toString('utf8');
  return { fingerprint: fingerprintAfter, files, stat, patch, truncated };
}

export async function commitStaged(cwd: string, message: string, fingerprint: string): Promise<CommitExecution> {
  const currentFingerprint = await stagedFingerprint(cwd);
  if (currentFingerprint !== fingerprint) throw conflictError('暂存区已变化或分支/HEAD 已切换，请重新预览后提交');
  if (message.includes('\0')) throw invalidRequestError('Commit 文案包含非法字符');
  const expectedTree = await runGitText(cwd, ['write-tree']);
  if ((await snapshotFingerprint(cwd, expectedTree)) !== fingerprint) throw conflictError('暂存区已变化或分支/HEAD 已切换，请重新预览后提交');
  await runGitText(cwd, ['commit', '--file=-'], 300_000, `${message.trim()}\n`);
  const [hash, actualTree] = await Promise.all([
    runGitText(cwd, ['rev-parse', 'HEAD']),
    runGitText(cwd, ['rev-parse', 'HEAD^{tree}']),
  ]);
  return { hash, expectedTree, actualTree, treeMatches: expectedTree === actualTree };
}

export function hasSensitivePath(files: string[]): boolean {
  return files.some((file) => {
    const baseName = file.split('/').at(-1) ?? file;
    return (
      /^(\.env(?:\..*)?|id_rsa|id_ed25519|credentials?|secrets?|.*\.(?:pem|key|p12|pfx))$/i.test(baseName) ||
      /(^|[._-])(token|secret|password|credentials?)([._-]|$)/i.test(baseName)
    );
  });
}

export function redactPatch(patch: string): string {
  return patch
    .replace(/(api[_-]?key|token|password|secret)(\s*[=:]\s*)[^\s"']+/gi, '$1$2[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+@/g, 'https://[REDACTED]@');
}
