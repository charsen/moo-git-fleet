import type { ConflictResolutionStrategy, RepositoryOperation } from '../../shared/contracts.js';
import { conflictError } from '../errors.js';
import { safeRepositoryPath } from './files.js';
import { runGit, runGitText } from './runner.js';
import { repositoryInternalState } from './scanner.js';

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
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
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
): Promise<ConflictResolutionResult> {
  safeRepositoryPath(cwd, relativePath);
  const entries = await unmergedEntries(cwd);
  if (!entries.some((entry) => entry.path === relativePath)) {
    throw conflictError('该文件当前没有未解决的冲突，请刷新后重试');
  }

  if (strategy === 'ours' || strategy === 'theirs') {
    const sideLabel = strategy === 'ours' ? '我方' : '对方';
    const checkout = await runGit(cwd, ['checkout', strategy === 'ours' ? '--ours' : '--theirs', '--', relativePath]);
    if (checkout.exitCode !== 0) {
      throw conflictError(
        `该文件没有「${sideLabel}版本」（可能是删除/修改冲突），请手工处理：${checkout.stderr || relativePath}`,
      );
    }
    await runGitText(cwd, ['add', '--', relativePath]);
    return { action: strategy, path: relativePath };
  }

  if (strategy === 'mark-resolved') {
    // `git add` 不检查冲突标记，这里先用 `git diff --check` 拦住还留着标记的文件，
    // 避免把未编辑完的内容当成已解决提交上去。
    const check = await runGit(cwd, ['diff', '--check', '--', relativePath]);
    if (check.stdout.toString('utf8').includes('conflict marker')) {
      throw conflictError('文件里仍有冲突标记，请先手工解决再标记为已解决');
    }
    await runGitText(cwd, ['add', '--', relativePath]);
    return { action: strategy, path: relativePath };
  }

  // restore：撤销已做的解决，重新写入冲突标记。
  const restore = await runGit(cwd, ['checkout', '--merge', '--', relativePath]);
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

/** 终止进行中的操作，回到操作前的状态。会丢弃本地解决进度，调用方必须先确认。 */
export async function abortRepositoryOperation(cwd: string): Promise<RepositoryOperation> {
  const operation = await assertOperationInProgress(cwd);
  const result = await runGit(cwd, [...abortArgs[operation]], 300_000);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `终止 ${operation} 失败`);
  return operation;
}
