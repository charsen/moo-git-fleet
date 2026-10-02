import type { MergeBranchRequest, MergePreview, MergePreviewRequest } from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { conflictError, safetyBlockedError } from '../errors.js';
import { listBranches } from './branches.js';
import { runGit, runGitText } from './runner.js';
import { repositoryInternalState } from './scanner.js';

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
  const blocker = internal.operation ? `请先完成或中止当前 ${internal.operation} 操作`
    : status.stdout.length ? '工作区有改动，请先提交或使用 Stash 保存改动'
    : commonAncestor.exitCode !== 0 ? '两个分支没有共同历史，不能合并' : null;
  return {
    source: input.source, sourceHead: source.head, targetBranch: input.expectedBranch,
    targetHead: snapshot.head, incomingCommits: Number(count), blocker,
    kind: included.exitCode === 0 ? 'up-to-date' : fastForward.exitCode === 0 ? 'fast-forward' : 'merge-commit',
  };
}

export async function mergeBranch(cwd: string, input: MergeBranchRequest): Promise<{ skipped: boolean }> {
  const preview = await previewBranchMerge(cwd, input);
  if (preview.blocker) throw safetyBlockedError(preview.blocker);
  if (preview.kind === 'up-to-date') return { skipped: true };
  // Recheck after the relatively expensive history reads, immediately before writing.
  const latest = await previewBranchMerge(cwd, input);
  if (latest.blocker) throw safetyBlockedError(latest.blocker);
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
  return { skipped: false };
}
