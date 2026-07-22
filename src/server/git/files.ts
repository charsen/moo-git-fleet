import { createHash, randomUUID } from 'node:crypto';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { CommitPreview, FileChange } from '../../shared/contracts.js';
import { runGit, runGitText } from './runner.js';

interface RegisteredFile {
  repositoryId: string;
  path: string;
  snapshot: string;
  expiresAt: number;
}

const fileRegistry = new Map<string, RegisteredFile>();
const fileTokenTtlMs = 10 * 60 * 1000;
const maxPatchBytes = 120_000;
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

function safeRepositoryPath(cwd: string, relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('..')) {
    throw new Error('Git 文件路径不安全');
  }
  const absolutePath = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Git 文件路径超出仓库');
}

function pruneExpiredFileTokens(now: number): void {
  if (now - lastFileRegistryPruneAt < 60_000) return;
  lastFileRegistryPruneAt = now;
  for (const [id, registered] of fileRegistry) {
    if (registered.expiresAt < now) fileRegistry.delete(id);
  }
}

function registerFile(repositoryId: string, relativePath: string, snapshot: string): string {
  const now = Date.now();
  pruneExpiredFileTokens(now);
  const id = randomUUID();
  fileRegistry.set(id, { repositoryId, path: relativePath, snapshot, expiresAt: now + fileTokenTtlMs });
  return id;
}

function registeredFile(repositoryId: string, id: string): RegisteredFile {
  const registered = fileRegistry.get(id);
  if (!registered || registered.repositoryId !== repositoryId || registered.expiresAt < Date.now()) {
    throw new Error('文件列表已过期，请刷新仓库详情');
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
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
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
  const registeredFiles = await Promise.all(files.map(async (file) => {
    const identity = await worktreeFileIdentity(cwd, file.path);
    return { id: registerFile(repositoryId, file.path, fileSnapshot(file, identity)), ...file };
  }));
  return registeredFiles.sort((a, b) => Number(b.conflicted) - Number(a.conflicted) || a.path.localeCompare(b.path));
}

export function resolveCurrentFileAction(repositoryId: string, fileId: string, currentFiles: FileChange[]): FileChange {
  const requested = registeredFile(repositoryId, fileId);
  const current = currentFiles.find((file) => file.path === requested.path);
  if (!current) throw new Error('文件内容或状态已变化，请刷新仓库详情');
  const currentRegistration = registeredFile(repositoryId, current.id);
  if (currentRegistration.snapshot !== requested.snapshot) {
    throw new Error('文件内容或状态已变化，请刷新仓库详情');
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
  if (!file.unstaged) throw new Error('文件当前没有可丢弃的工作区修改');
  if (!['M', 'D', 'T'].includes(file.worktreeStatus)) {
    throw new Error('重命名或复杂文件状态必须手工处理');
  }
  if (file.worktreeStatus !== 'D') await moveToTrash(path.resolve(cwd, file.path));
  await runGitText(cwd, ['restore', '--worktree', '--', file.path]);
  return { action: 'restore', path: file.path };
}

export async function fileDiff(cwd: string, relativePath: string, kind: 'staged' | 'unstaged'): Promise<string> {
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
      ? ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', relativePath]
      : ['diff', '--no-ext-diff', '--no-color', '--', relativePath];
  const result = await runGit(cwd, args, 15_000, undefined, maxPatchBytes);
  if (result.exitCode !== 0 && !(untracked && result.exitCode === 1)) {
    throw new Error(result.stderr || '读取文件 diff 失败');
  }
  const output = stripFinalLineBreak(result.stdout.toString('utf8'));
  return result.stdoutTruncated ? `${output}\n\n… diff 已截断 …` : output;
}

function treeFingerprint(tree: string): string {
  return createHash('sha256').update(tree).digest('hex');
}

export async function stagedFingerprint(cwd: string): Promise<string> {
  const tree = await runGitText(cwd, ['write-tree']);
  return treeFingerprint(tree);
}

export async function commitPreview(cwd: string): Promise<CommitPreview> {
  const fingerprintBefore = await stagedFingerprint(cwd);
  const [names, stat, patchResult] = await Promise.all([
    runGitText(cwd, ['diff', '--cached', '--name-only', '-z']),
    runGitText(cwd, ['diff', '--cached', '--stat', '--stat-count=200', '--no-color']),
    runGit(cwd, ['diff', '--cached', '--no-ext-diff', '--no-color'], 15_000, undefined, maxPatchBytes),
  ]);
  const fingerprintAfter = await stagedFingerprint(cwd);
  if (fingerprintBefore !== fingerprintAfter) throw new Error('暂存区已变化，请重新预览');
  const files = names.split('\0').filter(Boolean);
  if (files.length === 0) throw new Error('暂存区为空，没有可提交内容');
  if (patchResult.exitCode !== 0) throw new Error(patchResult.stderr || '读取 staged diff 失败');
  const truncated = patchResult.stdoutTruncated;
  const patch = patchResult.stdout.toString('utf8');
  return { fingerprint: fingerprintAfter, files, stat, patch, truncated };
}

export async function commitStaged(cwd: string, message: string, fingerprint: string): Promise<CommitExecution> {
  const currentFingerprint = await stagedFingerprint(cwd);
  if (currentFingerprint !== fingerprint) throw new Error('暂存区已变化，请重新预览后提交');
  if (message.includes('\0')) throw new Error('Commit 文案包含非法字符');
  const expectedTree = await runGitText(cwd, ['write-tree']);
  if (treeFingerprint(expectedTree) !== fingerprint) throw new Error('暂存区已变化，请重新预览后提交');
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
