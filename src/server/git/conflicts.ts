import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConflictResolutionStrategy, RepositoryOperation } from '../../shared/contracts.js';
import { conflictError } from '../errors.js';
import { safeRepositoryPath } from './files.js';
import { gitStatusTimeoutMs, runGit, runGitLiteral, runGitTextLiteral } from './runner.js';
import { repositoryInternalState } from './scanner.js';
import { assertConflictFingerprint } from './conflict-preview.js';

/** porcelain v1 中表示未合并（冲突）的两字符状态码。 */
const unmergedStatusCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export interface UnmergedEntry {
  path: string;
  status: string;
}

/**
 * 解析 `git status --porcelain=v1 -z` 中的未合并条目。
 * 只接受已知的未合并状态码，因此重命名记录里的「原路径」那一条会被自然跳过。
 */
export function parseUnmergedEntries(buffer: Buffer): UnmergedEntry[] {
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  const entries: UnmergedEntry[] = [];
  for (const record of records) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    if (!unmergedStatusCodes.has(status)) continue;
    entries.push({ path: record.slice(3), status });
  }
  return entries;
}

async function unmergedEntries(cwd: string): Promise<UnmergedEntry[]> {
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], gitStatusTimeoutMs);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取工作区状态失败');
  return parseUnmergedEntries(result.stdout);
}

async function assertOperationInProgress(cwd: string): Promise<RepositoryOperation> {
  const state = await repositoryInternalState(cwd);
  if (!state.operation) throw conflictError('仓库当前没有进行中的 Git 操作');
  return state.operation;
}

export interface ConflictResolutionResult {
  action: ConflictResolutionStrategy;
  path: string;
}

/**
 * 解决单个冲突文件。只作用于当前确实处于未合并状态的文件；
 * 用户不选择策略时服务端不做任何决定。
 */
export async function resolveConflictFile(
  cwd: string,
  relativePath: string,
  strategy: ConflictResolutionStrategy,
  expectedConflictFingerprint?: string,
): Promise<ConflictResolutionResult> {
  safeRepositoryPath(cwd, relativePath);
  const entries = await unmergedEntries(cwd);
  if (!entries.some((entry) => entry.path === relativePath)) {
    throw conflictError('该文件当前没有未解决的冲突，请刷新后重试');
  }

  if (strategy === 'ours' || strategy === 'theirs') {
    if (expectedConflictFingerprint) await assertConflictFingerprint(cwd, relativePath, expectedConflictFingerprint);
    const sideLabel = `Git ${strategy}`;
    const checkout = await runGitLiteral(cwd, ['checkout', strategy === 'ours' ? '--ours' : '--theirs', '--', relativePath]);
    if (checkout.exitCode !== 0) {
      throw conflictError(
        `该文件没有「${sideLabel}版本」（可能是删除/修改冲突），请手工处理：${checkout.stderr || relativePath}`,
      );
    }
    await runGitTextLiteral(cwd, ['add', '--', relativePath]);
    return { action: strategy, path: relativePath };
  }

  if (strategy === 'mark-resolved') {
    // 二进制冲突没有文本冲突标记，`git diff --check` 也不报——但内容往往并未真正解决。
    // 先按 git 的二进制口径（内容含 NUL 字节）识别：这类文件「标记已解决」无法自动核验，
    // 要求用户改用取此版本，或先在本地处理并自行确认，避免把未解决的二进制冲突直接 add 进去。
    const absolutePath = path.resolve(cwd, relativePath);
    let content: Buffer;
    try {
      content = await readFile(absolutePath);
    } catch {
      // 删除型冲突：文件已不在工作区，交给下面的 `git add` 处理（记录删除为已解决）。
      content = Buffer.alloc(0);
    }
    if (content.includes(0)) {
      throw conflictError('这是二进制冲突，无法自动核验是否已解决：请用「取此版本」选择一侧，或在本地处理好后自行确认');
    }
    // 文本冲突：`git add` 不检查冲突标记，这里先用 `git diff --check` 拦住还留着标记的文件，
    // 避免把未编辑完的内容当成已解决提交上去。
    const check = await runGitLiteral(cwd, ['diff', '--check', '--', relativePath]);
    if (check.stdout.toString('utf8').includes('conflict marker')) {
      throw conflictError('文件里仍有冲突标记，请先手工解决再标记为已解决');
    }
    await runGitTextLiteral(cwd, ['add', '--', relativePath]);
    return { action: strategy, path: relativePath };
  }

  // restore：撤销已做的解决，重新写入冲突标记。
  const restore = await runGitLiteral(cwd, ['checkout', '--merge', '--', relativePath]);
  if (restore.exitCode !== 0) throw conflictError(`恢复冲突标记失败：${restore.stderr || relativePath}`);
  return { action: strategy, path: relativePath };
}

const continueArgs: Record<RepositoryOperation, string[] | null> = {
  merge: ['merge', '--continue'],
  rebase: ['rebase', '--continue'],
  'cherry-pick': ['cherry-pick', '--continue'],
  revert: ['revert', '--continue'],
  bisect: null,
};

const abortArgs: Record<RepositoryOperation, string[]> = {
  merge: ['merge', '--abort'],
  rebase: ['rebase', '--abort'],
  'cherry-pick': ['cherry-pick', '--abort'],
  revert: ['revert', '--abort'],
  bisect: ['bisect', 'reset'],
};

/**
 * 「跳过当前提交」：rebase / cherry-pick / revert 独有。
 *
 * 没有它时，一个空提交（补丁已被上游包含、拣选空提交、回退空提交）会让操作停在
 * 「0 个冲突但不能继续」的死角：`--continue` 永远失败，用户只能 `--abort` 丢掉
 * 前面已完成的解决进度。
 */
const skipArgs: Record<RepositoryOperation, string[] | null> = {
  merge: null,
  rebase: ['rebase', '--skip'],
  'cherry-pick': ['cherry-pick', '--skip'],
  revert: ['revert', '--skip'],
  bisect: null,
};

/** 继续被冲突中断的操作；仍有未解决冲突时拒绝。 */
export async function continueRepositoryOperation(cwd: string): Promise<RepositoryOperation> {
  const operation = await assertOperationInProgress(cwd);
  const args = continueArgs[operation];
  if (!args) throw conflictError(`${operation} 没有「继续」操作，请使用「终止」结束`);

  const pending = await unmergedEntries(cwd);
  if (pending.length > 0) {
    throw conflictError(`还有 ${pending.length} 个文件未解决冲突，请先全部解决再继续`);
  }

  // `core.editor=true` 让 Git 直接采用默认提交信息，避免弹出编辑器阻塞子进程。
  const result = await runGit(cwd, ['-c', 'core.editor=true', ...args], 300_000);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `继续 ${operation} 失败`);
  return operation;
}

export interface ResolveConflictsBulkResult {
  strategy: 'ours' | 'theirs';
  resolved: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * 批量解决冲突：对当前所有未合并文件逐个执行「取当前侧 / 取合入侧」。
 *
 * 单个文件失败（二进制、删除/修改冲突、该侧不存在）只记入 skipped 并继续其余——
 * 批量按钮的价值就是把文本冲突一次处理完，不能因为一个二进制冲突整批中止。
 */
export async function resolveConflictsBulk(
  cwd: string,
  strategy: 'ours' | 'theirs',
): Promise<ResolveConflictsBulkResult> {
  const entries = await unmergedEntries(cwd);
  const resolved: string[] = [];
  const skipped: ResolveConflictsBulkResult['skipped'] = [];
  for (const entry of entries) {
    try {
      await resolveConflictFile(cwd, entry.path, strategy);
      resolved.push(entry.path);
    } catch (error) {
      skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : '解决失败' });
    }
  }
  return { strategy, resolved, skipped };
}

/**
 * 撤销「已解决」：把文件恢复成带冲突标记的未合并状态。
 *
 * 只允许在同一个进行中操作里对**当前不是冲突**的文件执行；`checkout --merge`
 * 会依据 MERGE_HEAD/REBASE_HEAD 重建冲突标记，若该文件本就不在本次操作的冲突范围内，
 * 执行后仍是干净文件，这里直接报错而不是假装成功。
 */
export async function unresolveConflictFile(cwd: string, relativePath: string): Promise<{ action: 'restore'; path: string }> {
  safeRepositoryPath(cwd, relativePath);
  await assertOperationInProgress(cwd);
  const before = await unmergedEntries(cwd);
  if (before.some((entry) => entry.path === relativePath)) throw conflictError('该文件仍在冲突中，不需要撤销解决');
  const restore = await runGitLiteral(cwd, ['checkout', '--merge', '--', relativePath]);
  if (restore.exitCode !== 0) throw conflictError(`恢复冲突标记失败：${restore.stderr || relativePath}`);
  const after = await unmergedEntries(cwd);
  if (!after.some((entry) => entry.path === relativePath)) {
    throw conflictError('该文件不在本次操作的冲突范围内，无法撤销解决');
  }
  return { action: 'restore', path: relativePath };
}

/** 跳过当前提交（rebase / cherry-pick / revert）。会丢弃这次提交带来的改动，调用方必须先确认。 */
export async function skipRepositoryOperation(cwd: string): Promise<RepositoryOperation> {
  const operation = await assertOperationInProgress(cwd);
  const args = skipArgs[operation];
  if (!args) throw conflictError(`${operation} 没有「跳过」操作，请使用「继续」或「终止」`);
  const result = await runGit(cwd, ['-c', 'core.editor=true', ...args], 300_000);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `跳过 ${operation} 当前提交失败`);
  return operation;
}

/** 终止进行中的操作，回到操作前的状态。会丢弃本地解决进度，调用方必须先确认。 */
export async function abortRepositoryOperation(cwd: string): Promise<RepositoryOperation> {
  const operation = await assertOperationInProgress(cwd);
  const result = await runGit(cwd, [...abortArgs[operation]], 300_000);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `终止 ${operation} 失败`);
  return operation;
}
