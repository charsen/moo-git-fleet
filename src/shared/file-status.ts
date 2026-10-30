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
