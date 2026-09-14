import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  BranchesSnapshot,
  CheckoutRemoteBranchRequest,
  CreateBranchRequest,
  DeleteBranchRequest,
  LocalBranch,
  RemoteBranch,
  RenameBranchRequest,
  SwitchBranchRequest,
  WorktreeInfo,
} from '../../shared/contracts.js';
import { conflictError, invalidRequestError, safetyBlockedError } from '../errors.js';
import { parseRemoteRefs } from './remote-refs.js';
import { runGit, runGitLine, runGitText } from './runner.js';
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
  const commonDir = await runGitLine(cwd, ['rev-parse', '--git-common-dir']);
  return realpath(path.resolve(cwd, commonDir));
}

export async function listBranches(cwd: string): Promise<BranchesSnapshot> {
  const canonicalPath = await realpath(cwd);
  const [headResult, currentBranch, branchResult, worktreeResult, remoteResult, remoteNamesRaw] = await Promise.all([
    runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    runGitText(cwd, ['branch', '--show-current']),
    runGit(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)', 'refs/heads']),
    runGit(cwd, ['worktree', 'list', '--porcelain', '-z']),
    runGit(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes']),
    runGitText(cwd, ['remote']).catch(() => ''),
  ]);
  if (branchResult.exitCode !== 0) throw new Error(branchResult.stderr || '读取本地分支失败');
  if (worktreeResult.exitCode !== 0) throw new Error(worktreeResult.stderr || '读取 Worktree 失败');
  if (remoteResult.exitCode !== 0) throw new Error(remoteResult.stderr || '读取远端分支失败');

  const head = headResult.exitCode === 0 ? headResult.stdout.toString('utf8').trim() : '';
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
  const localNames = new Set(branches.map((branch) => branch.name));
  const remoteNames = remoteNamesRaw.split('\n').map((name) => name.trim()).filter(Boolean);
  const remoteBranches: RemoteBranch[] = parseRemoteRefs(remoteResult.stdout, remoteNames).map((ref) => ({
    name: ref.upstream,
    remote: ref.remote,
    branch: ref.branch,
    head: ref.head,
    hasLocal: localNames.has(ref.branch),
  }));

  return {
    currentBranch: currentBranch || null,
    head,
    branches,
    remoteBranches,
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
  if (refCheck.exitCode !== 0) throw conflictError('目标分支名称无效');

  const before = await listBranches(cwd);
  if (before.currentBranch !== input.expectedBranch || before.head !== input.expectedHead) {
    throw safetyBlockedError('当前分支或 HEAD 已变化，请刷新后重试');
  }
  if (before.currentBranch === input.branch) throw conflictError('目标分支已经是当前分支');

  const target = before.branches.find((branch) => branch.name === input.branch);
  if (!target) throw conflictError('目标本地分支不存在');
  if (target.worktreePath) throw conflictError('目标分支已被其他 Worktree 占用');

  const [statusResult, internalState, headResult] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z']),
    repositoryInternalState(cwd),
    runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  if (statusResult.exitCode !== 0) throw new Error(statusResult.stderr || '读取工作区状态失败');
  if (headResult.exitCode !== 0) throw new Error(headResult.stderr || '读取当前 HEAD 失败');
  const status = parsePorcelainV2(statusResult.stdout);
  const finalHead = headResult.stdout.toString('utf8').trim();
  if (status.branch !== input.expectedBranch || finalHead !== input.expectedHead) {
    throw safetyBlockedError('当前分支或 HEAD 已变化，请刷新后重试');
  }
  if (hasWorktreeChanges(status)) throw safetyBlockedError('工作区不干净，不能切换分支');
  if (internalState.operation) throw conflictError(`仓库正在进行 ${internalState.operation}，不能切换分支`);

  await runGitText(cwd, ['switch', '--no-guess', '--', input.branch]);
  return listBranches(cwd);
}

async function ensureValidBranchName(cwd: string, branch: string): Promise<void> {
  const result = await runGit(cwd, ['check-ref-format', '--branch', branch]);
  if (result.exitCode !== 0) throw conflictError('目标分支名称无效');
}

/** 读一次分支快照并复核预期的当前分支与完整 HEAD。 */
async function ensureBranchSnapshot(
  cwd: string,
  input: { expectedBranch: string | null; expectedHead: string },
  action: string,
): Promise<BranchesSnapshot> {
  const snapshot = await listBranches(cwd);
  if (snapshot.currentBranch !== input.expectedBranch || snapshot.head !== input.expectedHead) {
    throw conflictError(`当前分支或 HEAD 已变化，不能${action}`);
  }
  return snapshot;
}

/**
 * 写入前的最后一次复核：工作区、进行中操作、当前分支与完整 HEAD 都必须与预期一致。
 * `requireCleanWorktree` 只对会改动工作区的操作（切换 / 检出）开启。
 */
async function ensureBranchWritePreconditions(
  cwd: string,
  input: { expectedBranch: string | null; expectedHead: string },
  options: { action: string; requireCleanWorktree: boolean },
): Promise<void> {
  const [statusResult, internalState, headResult] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z']),
    repositoryInternalState(cwd),
    runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  if (statusResult.exitCode !== 0) throw new Error(statusResult.stderr || '读取工作区状态失败');
  if (headResult.exitCode !== 0) throw new Error(headResult.stderr || '读取当前 HEAD 失败');
  const status = parsePorcelainV2(statusResult.stdout);
  const head = headResult.stdout.toString('utf8').trim();
  if (status.branch !== input.expectedBranch || head !== input.expectedHead) {
    throw conflictError(`当前分支或 HEAD 已变化，不能${options.action}`);
  }
  if (options.requireCleanWorktree && hasWorktreeChanges(status)) {
    throw safetyBlockedError(`工作区不干净，不能${options.action}`);
  }
  if (internalState.operation) {
    throw conflictError(`仓库正在进行 ${internalState.operation}，不能${options.action}`);
  }
}

export async function createBranch(cwd: string, input: CreateBranchRequest): Promise<BranchesSnapshot> {
  await ensureValidBranchName(cwd, input.branch);
  const before = await ensureBranchSnapshot(cwd, input, '创建分支');
  if (before.branches.some((branch) => branch.name === input.branch)) {
    throw conflictError(`本地分支已存在：${input.branch}`);
  }
  // 只有「创建并切换」会改动工作区；仅创建分支不需要干净工作区。
  await ensureBranchWritePreconditions(cwd, input, {
    action: '创建分支',
    requireCleanWorktree: input.checkout,
  });

  if (input.checkout) {
    await runGitText(cwd, ['switch', '--no-guess', '--create', input.branch]);
  } else {
    await runGitText(cwd, ['branch', input.branch]);
  }
  return listBranches(cwd);
}

export async function renameBranch(cwd: string, input: RenameBranchRequest): Promise<BranchesSnapshot> {
  await ensureValidBranchName(cwd, input.nextBranch);
  const before = await ensureBranchSnapshot(cwd, input, '重命名分支');
  if (input.branch === input.nextBranch) throw conflictError('新分支名与原名相同');
  const target = before.branches.find((branch) => branch.name === input.branch);
  if (!target) throw conflictError(`本地分支不存在：${input.branch}`);
  if (before.branches.some((branch) => branch.name === input.nextBranch)) {
    throw conflictError(`本地分支已存在：${input.nextBranch}`);
  }
  if (target.worktreePath && !target.current) throw conflictError('目标分支已被其他 Worktree 占用');
  await ensureBranchWritePreconditions(cwd, input, { action: '重命名分支', requireCleanWorktree: false });

  const result = await runGit(cwd, ['branch', '--move', input.branch, input.nextBranch]);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `重命名分支失败：${input.branch}`);
  return listBranches(cwd);
}

export async function deleteBranch(cwd: string, input: DeleteBranchRequest): Promise<BranchesSnapshot> {
  const before = await ensureBranchSnapshot(cwd, input, '删除分支');
  const target = before.branches.find((branch) => branch.name === input.branch);
  if (!target) throw conflictError(`本地分支不存在：${input.branch}`);
  if (target.current) throw conflictError('不能删除当前分支');
  if (target.worktreePath) throw conflictError('目标分支已被其他 Worktree 占用');
  await ensureBranchWritePreconditions(cwd, input, { action: '删除分支', requireCleanWorktree: false });

  // 与 `git branch -d` 语义一致：已合并到当前 HEAD 或其 upstream 才允许删除；永不使用 -D。
  const mergedTargets = target.upstream ? [target.upstream, 'HEAD'] : ['HEAD'];
  const merged = await Promise.all(
    mergedTargets.map((ref) => runGit(cwd, ['merge-base', '--is-ancestor', target.head, ref])),
  );
  if (!merged.some((result) => result.exitCode === 0)) {
    throw conflictError(`分支 ${target.name} 未合并到当前 HEAD 或其 upstream，已拒绝删除`);
  }

  const result = await runGit(cwd, ['branch', '--delete', input.branch]);
  if (result.exitCode !== 0) throw conflictError(`删除分支失败：${result.stderr || input.branch}`);
  return listBranches(cwd);
}

export async function checkoutRemoteBranch(
  cwd: string,
  input: CheckoutRemoteBranchRequest,
): Promise<BranchesSnapshot> {
  if (!/^[A-Za-z0-9._-]+$/.test(input.remote)) throw invalidRequestError('Git remote 名称不安全');
  await ensureValidBranchName(cwd, input.localBranch);
  const before = await ensureBranchSnapshot(cwd, input, '检出远端分支');
  if (before.branches.some((branch) => branch.name === input.localBranch)) {
    throw conflictError(`本地分支已存在：${input.localBranch}`);
  }
  const remoteRef = before.remoteBranches.find(
    (branch) => branch.remote === input.remote && branch.branch === input.branch,
  );
  if (!remoteRef) throw conflictError(`远端分支不存在：${input.remote}/${input.branch}`);
  await ensureBranchWritePreconditions(cwd, input, { action: '检出远端分支', requireCleanWorktree: true });

  // 复核远端 ref 没有在预览之后漂移，再用显式 --track 建立跟踪关系。
  const currentHead = await runGitText(cwd, ['rev-parse', '--verify', `${remoteRef.name}^{commit}`]).catch(() => '');
  if (currentHead !== remoteRef.head) throw conflictError('远端分支已变化，请刷新后重试');

  const result = await runGit(cwd, [
    'switch',
    '--no-guess',
    '--track',
    '--create',
    input.localBranch,
    remoteRef.name,
  ]);
  if (result.exitCode !== 0) throw conflictError(result.stderr || `检出远端分支失败：${remoteRef.name}`);
  return listBranches(cwd);
}
