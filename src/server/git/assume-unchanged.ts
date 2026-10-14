import type { MarkedFile } from '../../shared/contracts.js';
import { conflictError } from '../errors.js';
import { registerFileToken, safeRepositoryPath } from './files.js';
import { runGit } from './runner.js';

/**
 * assume-unchanged 是**索引里的本机标记**：不进提交、不随远端共享，只是让 Git 忽略这个
 * 文件的本地修改。代价是文件一旦被提交，标记会被清除。要「忽略本地修改」又想避开这个
 * 副作用，Git 推荐 skip-worktree（`ls-files -v` 里的 `S`/`s`），本轮只识别、不提供操作。
 *
 * 因为 `git status` 不再显示被标记文件的修改，界面必须另有一个清单入口，否则用户无法取消标记。
 */

const listingMaxBytes = 2_000_000;

/**
 * 列出被标记的文件。`ls-files -v -z` 的每条记录是 `<tag><空格><path>`：
 * `H` 普通缓存文件，`h` 缓存 + assume-unchanged，`S`/`s` 是 skip-worktree —— 只取 `h`。
 */
export async function listMarkedFiles(repositoryId: string, cwd: string): Promise<MarkedFile[]> {
  const result = await runGit(cwd, ['ls-files', '-v', '-z'], 15_000, undefined, listingMaxBytes);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取已标记文件失败');
  const records = result.stdout.toString('utf8').split('\0').filter(Boolean);
  // 被字节上限截断时末尾可能是半条记录，丢弃而不是登记。
  if (result.stdoutTruncated) records.pop();
  return records
    .filter((record) => record.startsWith('h '))
    .map((record) => {
      const relativePath = record.slice(2);
      safeRepositoryPath(cwd, relativePath);
      return { id: registerFileToken(repositoryId, relativePath, 'assume-unchanged'), path: relativePath };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 标记或取消标记单个文件；只有索引里的已跟踪文件可以被标记。 */
export async function setAssumeUnchanged(cwd: string, relativePath: string, assumed: boolean): Promise<void> {
  safeRepositoryPath(cwd, relativePath);
  if (assumed) {
    // 先自己判断是否已跟踪，避免把 Git 的英文 fatal 直接抛给界面。
    const tracked = await runGit(cwd, ['ls-files', '--error-unmatch', '--', relativePath]);
    if (tracked.exitCode !== 0) throw conflictError('这个文件不在版本控制里，无法标记 assume-unchanged');
  }
  const result = await runGit(cwd, [
    'update-index',
    assumed ? '--assume-unchanged' : '--no-assume-unchanged',
    '--',
    relativePath,
  ]);
  if (result.exitCode !== 0) {
    throw conflictError(result.stderr || `${assumed ? '标记' : '取消标记'} ${relativePath} 失败`);
  }
}
