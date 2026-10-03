import type { MergeBranchRequest, MergePreview, MergePreviewRequest, StashEntry } from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { conflictError, safetyBlockedError } from '../errors.js';
import { listBranches } from './branches.js';
import { runGit, runGitText } from './runner.js';
import { repositoryInternalState } from './scanner.js';
import { createStash } from './stash.js';

/** 只报告前若干条重叠路径，避免弹窗被长清单撑爆。 */
const maxReportedConflicts = 20;

function nulSeparated(stdout: Buffer): string[] {
  return stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * 解析 `git status --porcelain=v1 -z`：记录以 NUL 分隔，
 * 重命名/复制条目会紧跟着一条原路径记录，必须一起吃掉。
 */
function parseStatusEntries(stdout: Buffer): Array<{ path: string; untracked: boolean }> {
  const records = stdout.toString('utf8').split('\0');
  const entries: Array<{ path: string; untracked: boolean }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') index += 1;
    entries.push({ path: record.slice(3), untracked: indexStatus === '?' && worktreeStatus === '?' });
  }
  return entries;
}

function conflictBlocker(paths: string[]): string {
  return `以下本地改动会被本次合并覆盖：${paths.join('、')}。请先提交，或选择先把它们存入 Stash`;
}

/** Preview and execution both resolve exact namespace identities, never arbitrary revisions. */
export async function previewBranchMerge(cwd: string, input: MergePreviewRequest): Promise<MergePreview> {
  const snapshot = await listBranches(cwd);
  if (snapshot.currentBranch !== input.expectedBranch || snapshot.head !== input.expectedHead) {
    throw conflictError('当前分支或 HEAD 已变化，请刷新后重新选择合并');
  }
  const source = input.source.kind === 'local'
    ? snapshot.branches.find(branch => branch.name === input.source.name)
    : snapshot.remoteBranches.find(branch => branch.name === input.source.name);
  if (!source || source.head !== input.expectedSourceHead) throw conflictError('来源分支已变化，请刷新后重新选择合并');
  if (input.source.kind === 'local' && input.source.name === snapshot.currentBranch) throw safetyBlockedError('不能将当前分支合并到自身');
  const [status, internal, included, fastForward, count, commonAncestor] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    repositoryInternalState(cwd),
    runGit(cwd, ['merge-base', '--is-ancestor', source.head, snapshot.head]),
    runGit(cwd, ['merge-base', '--is-ancestor', snapshot.head, source.head]),
    runGitText(cwd, ['rev-list', '--count', `${snapshot.head}..${source.head}`]),
    runGit(cwd, ['merge-base', snapshot.head, source.head]),
  ]);
  if (status.exitCode !== 0) throw new Error(status.stderr || '无法读取工作区');
  if (included.exitCode > 1 || fastForward.exitCode > 1 || commonAncestor.exitCode > 1) throw new Error('无法读取分支提交关系');
  const hasCommonAncestor = commonAncestor.exitCode === 0;
  // Git 只在合并需要写入的文件同时有本地改动时才拒绝；这里用同一判据提前说明，
  // 未跟踪文件与无关改动都不再挡路。
  const touched = hasCommonAncestor
    ? new Set(nulSeparated((await runGit(cwd, ['diff', '--name-only', '-z', '--no-renames', commonAncestor.stdout.toString('utf8').trim(), source.head], 30_000)).stdout))
    : new Set<string>();
  const entries = parseStatusEntries(status.stdout);
  const overlaps = entries.filter(entry => touched.has(entry.path));
  const blocker = internal.operation ? `请先完成或中止当前 ${internal.operation} 操作`
    : !hasCommonAncestor ? '两个分支没有共同历史，不能合并' : null;
  return {
    source: input.source, sourceHead: source.head, targetBranch: input.expectedBranch,
    targetHead: snapshot.head, incomingCommits: Number(count),
    dirty: entries.length > 0,
    conflicting: overlaps.slice(0, maxReportedConflicts).map(entry => entry.path),
    conflictingUntracked: overlaps.some(entry => entry.untracked),
    blocker,
    kind: included.exitCode === 0 ? 'up-to-date' : fastForward.exitCode === 0 ? 'fast-forward' : 'merge-commit',
  };
}

export async function mergeBranch(cwd: string, input: MergeBranchRequest): Promise<{ skipped: boolean; stashed: StashEntry | null }> {
  const preview = await previewBranchMerge(cwd, input);
  if (preview.blocker) throw safetyBlockedError(preview.blocker);
  if (preview.kind === 'up-to-date') return { skipped: true, stashed: null };
  if (preview.conflicting.length > 0 && !input.stashFirst) throw safetyBlockedError(conflictBlocker(preview.conflicting));
  const stashed = input.stashFirst && preview.dirty
    ? await createStash(cwd, `Moo Fleet 合并前备份 ${input.expectedBranch} ← ${input.source.name}`, input.stashIncludeUntracked)
    : null;
  // Recheck after the relatively expensive history reads, immediately before writing.
  const latest = await previewBranchMerge(cwd, input);
  if (latest.blocker) throw safetyBlockedError(latest.blocker);
  if (latest.conflicting.length > 0) throw safetyBlockedError(conflictBlocker(latest.conflicting));
  const [branch, head, sourceHead] = await Promise.all([
    runGitText(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGitText(cwd, ['rev-parse', '--verify', 'HEAD']),
    runGitText(cwd, ['rev-parse', '--verify', `refs/${input.source.kind === 'local' ? 'heads' : 'remotes'}/${input.source.name}`]),
  ]);
  if (branch !== input.expectedBranch || head !== input.expectedHead || sourceHead !== input.expectedSourceHead) throw conflictError('分支状态已变化，请刷新后重新选择合并');
  const result = await runGit(cwd, [
    '-c', 'merge.autoStash=false', '-c', 'core.editor=true',
    'merge', input.noFastForward ? '--no-ff' : '--ff', '--no-autostash', '--no-squash', '--commit', '--no-edit',
    '-m', `Merge ${input.source.kind === 'remote' ? 'remote-tracking ' : ''}branch '${input.source.name}' into ${input.expectedBranch}`,
    '--', preview.sourceHead,
  ], 300_000);
  if (result.exitCode !== 0) {
    const internal = await repositoryInternalState(cwd);
    if (internal.operation === 'merge') throw conflictError(`合并已暂停，请在工作区处理后继续；也可以中止合并${result.stderr ? `。Git 提示：${result.stderr}` : ''}`, { code: mergePausedErrorCode });
    throw conflictError(result.stderr || result.stdout.toString('utf8').trim() || '合并失败');
  }
  return { skipped: false, stashed };
}
