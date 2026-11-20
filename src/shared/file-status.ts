import type { FileChange } from './contracts.js';

/**
 * 「从未提交过的新文件」的唯一判据。
 *
 * 两种形态都要认：未跟踪（`??`）和已 `git add` 但 HEAD 里没有（`A`）。
 * 只看 `untracked` 会漏掉 `A`——而工作区的勾选正是 `git add`，
 * 用户一勾，`untracked` 立刻变 false，入口就没了。
 *
 * 客户端（哪些文件可以批量删除）和服务端（拒绝非法删除请求）共用这一份，
 * 两边各写一遍迟早会分叉。
 */
export function isUncommittedNewFile(
  file: Pick<FileChange, 'untracked' | 'indexStatus' | 'conflicted'>,
): boolean {
  return !file.conflicted && (file.untracked || file.indexStatus === 'A');
}

/**
 * 重命名 / 复制条目：`git restore` 只能拉回「新路径」（HEAD 里没有新路径），旧路径的
 * 删除也不会被撤销，结果是两个路径都从工作区消失的半还原。客户端计数与服务端跳过
 * 必须用同一判据，否则确认框会说「将还原 N 个」而实际少还原。
 */
export function isRenamedOrCopiedFile(
  file: Pick<FileChange, 'originalPath' | 'indexStatus' | 'worktreeStatus'>,
): boolean {
  return file.originalPath !== null
    || ['R', 'C'].includes(file.indexStatus)
    || ['R', 'C'].includes(file.worktreeStatus);
}
