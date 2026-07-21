import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BranchesSnapshot, LocalBranch, SwitchBranchRequest, WorktreeInfo } from '../../shared/contracts.js';
import { runGit, runGitText } from './runner.js';
import { parsePorcelainV2, repositoryInternalState } from './scanner.js';

interface BranchRef {
  name: string;
  head: string;
  upstream: string | null;
}

export function parseBranchRefs(buffer: Buffer): BranchRef[] {
  return buffer
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((record) => {
      const [ref = '', head = '', upstream = ''] = record.split('\0');
      if (!ref.startsWith('refs/heads/') || !head) throw new Error('本地分支数据无效');
      return {
        name: ref.slice('refs/heads/'.length),
        head,
        upstream: upstream || null,
      };
    });
}

export function parseWorktreePorcelain(buffer: Buffer, currentPath: string): WorktreeInfo[] {
  return buffer
    .toString('utf8')
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      let worktreePath = '';
      let head = '';
      let branch: string | null = null;
      let prunable = false;
      for (const field of record.split('\0').filter(Boolean)) {
        if (field.startsWith('worktree ')) worktreePath = field.slice('worktree '.length);
        else if (field.startsWith('HEAD ')) head = field.slice('HEAD '.length);
        else if (field.startsWith('branch refs/heads/')) branch = field.slice('branch refs/heads/'.length);
        else if (field === 'detached') branch = null;
        else if (field === 'prunable' || field.startsWith('prunable ')) prunable = true;
      }
      if (!worktreePath || !head) throw new Error('Worktree 数据无效');
      return {
        path: worktreePath,
        head,
        branch,
        current: path.resolve(worktreePath) === path.resolve(currentPath),
        prunable,
      };
    });
}

async function branchDivergence(
  cwd: string,
  branch: Pick<BranchRef, 'name' | 'upstream'>,
): Promise<{ ahead: number | null; behind: number | null }> {
  if (!branch.upstream) return { ahead: null, behind: null };
  try {
    const output = await runGitText(cwd, [
      'rev-list',
      '--left-right',
      '--count',
      `${branch.name}...${branch.upstream}`,
    ]);
    const [ahead, behind] = output.split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('分支差异数据无效');
    return { ahead: ahead ?? null, behind: behind ?? null };
  } catch {
    return { ahead: null, behind: null };
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function repositoryCommonDir(cwd: string): Promise<string> {
  const commonDir = await runGitText(cwd, ['rev-parse', '--git-common-dir']);
  return realpath(path.resolve(cwd, commonDir));
}

export async function listBranches(cwd: string): Promise<BranchesSnapshot> {
  const canonicalPath = await realpath(cwd);
  const [head, currentBranch, branchResult, worktreeResult] = await Promise.all([
    runGitText(cwd, ['rev-parse', 'HEAD']),
    runGitText(cwd, ['branch', '--show-current']),
    runGit(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)', 'refs/heads']),
    runGit(cwd, ['worktree', 'list', '--porcelain', '-z']),
  ]);
  if (branchResult.exitCode !== 0) throw new Error(branchResult.stderr || '读取本地分支失败');
  if (worktreeResult.exitCode !== 0) throw new Error(worktreeResult.stderr || '读取 Worktree 失败');

  const branchRefs = parseBranchRefs(branchResult.stdout);
  const worktrees = parseWorktreePorcelain(worktreeResult.stdout, canonicalPath);
  const divergence = await mapWithConcurrency(branchRefs, 4, (branch) => branchDivergence(cwd, branch));
  const worktreeByBranch = new Map(
    worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch as string, worktree.path]),
  );
  const branches: LocalBranch[] = branchRefs.map((branch, index) => ({
    ...branch,
    current: branch.name === currentBranch,
    ahead: divergence[index]?.ahead ?? null,
    behind: divergence[index]?.behind ?? null,
    worktreePath: worktreeByBranch.get(branch.name) ?? null,
  }));

  return {
    currentBranch: currentBranch || null,
    head,
    branches,
    worktrees,
  };
}

function hasWorktreeChanges(status: ReturnType<typeof parsePorcelainV2>): boolean {
  return (
    status.staged +
      status.modified +
      status.deleted +
      status.renamed +
      status.untracked +
      status.conflicted >
    0
  );
}

export async function switchBranch(cwd: string, input: SwitchBranchRequest): Promise<BranchesSnapshot> {
  const refCheck = await runGit(cwd, ['check-ref-format', '--branch', input.branch]);
  if (refCheck.exitCode !== 0) throw new Error('目标分支名称无效');

  const [before, statusResult, internalState] = await Promise.all([
    listBranches(cwd),
    runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z']),
    repositoryInternalState(cwd),
  ]);
  if (statusResult.exitCode !== 0) throw new Error(statusResult.stderr || '读取工作区状态失败');
  if (before.currentBranch !== input.expectedBranch || before.head !== input.expectedHead) {
    throw new Error('当前分支或 HEAD 已变化，请刷新后重试');
  }
  if (before.currentBranch === input.branch) throw new Error('目标分支已经是当前分支');

  const target = before.branches.find((branch) => branch.name === input.branch);
  if (!target) throw new Error('目标本地分支不存在');
  if (target.worktreePath) throw new Error('目标分支已被其他 Worktree 占用');

  const status = parsePorcelainV2(statusResult.stdout);
  if (hasWorktreeChanges(status)) throw new Error('工作区不干净，不能切换分支');
  if (internalState.operation) throw new Error(`仓库正在进行 ${internalState.operation}，不能切换分支`);

  await runGitText(cwd, ['switch', '--no-guess', '--', input.branch]);
  return listBranches(cwd);
}
