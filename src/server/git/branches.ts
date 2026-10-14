import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  BranchDeletionPreview,
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
  if (status.conflicted) throw safetyBlockedError('工作区存在未解决的冲突，不能切换分支');
  if (internalState.operation) throw conflictError(`仓库正在进行 ${internalState.operation}，不能切换分支`);

  // Git carries compatible staged/unstaged changes and refuses overwrites itself.
  // Never force, merge the worktree, or automatically stash as part of a switch.
  const result = await runGit(cwd, ['switch', '--no-guess', '--', input.branch]);
  if (result.exitCode !== 0) {
    if (/would be overwritten|not uptodate|needs merge/i.test(result.stderr)) {
      throw safetyBlockedError('切换会覆盖本地修改或未跟踪文件，请先处理这些文件后重试');
    }
    throw conflictError(result.stderr || '切换分支失败');
  }
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
 * `requireCleanWorktree` 用于创建并切换、检出远端分支。
 * 已有本地分支由 switchBranch 交给 Git 判断是否可以保留本地修改。
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

/** 预览里最多列出的「会失去引用」的提交条数。 */
const maxLostCommits = 20;

type DeletableBranch = BranchesSnapshot['branches'][number];

/** 「已合并」判据：既不指向当前 HEAD 的祖先，也不指向自己 upstream 的祖先。 */
async function isBranchMerged(cwd: string, head: string, upstream: string | null): Promise<boolean> {
  const refs = upstream ? [upstream, 'HEAD'] : ['HEAD'];
  const results = await Promise.all(refs.map((ref) => runGit(cwd, ['merge-base', '--is-ancestor', head, ref])));
  return results.some((result) => result.exitCode === 0);
}

/** 删除前共用的前置校验；强制删除也必须全部通过（能被强制的只有「未合并」这一条）。 */
async function ensureDeletableBranch(cwd: string, input: DeleteBranchRequest): Promise<DeletableBranch> {
  const before = await ensureBranchSnapshot(cwd, input, '删除分支');
  const target = before.branches.find((branch) => branch.name === input.branch);
  if (!target) throw conflictError(`本地分支不存在：${input.branch}`);
  if (target.current) throw conflictError('不能删除当前分支');
  if (target.worktreePath) throw conflictError('目标分支已被其他 Worktree 占用');
  await ensureBranchWritePreconditions(cwd, input, { action: '删除分支', requireCleanWorktree: false });
  return target;
}

/**
 * 删除后不再被任何 ref 引用的提交。
 *
 * 口径是 `rev-list <branch> --not --exclude=refs/heads/<branch> --all`：以该分支为起点，
 * 用 `--all` 取反并排除它自己的本地 ref。已经推到远端（remote-tracking ref 还在）或已合并到
 * 其他分支的提交因此**不算丢失**——这是实测确认过的语义（见 PLAN 第 184 节）。
 */
async function lostCommitsOf(
  cwd: string,
  branch: string,
  limit: number,
): Promise<{ commits: BranchDeletionPreview['lostCommits']; count: number }> {
  const list = await runGit(cwd, ['rev-list', branch, '--not', `--exclude=refs/heads/${branch}`, '--all']);
  if (list.exitCode !== 0) throw conflictError(list.stderr || `读取分支 ${branch} 的独有提交失败`);
  const hashes = list.stdout.toString('utf8').split('\n').filter(Boolean);
  if (!hashes.length) return { commits: [], count: 0 };
  const shown = hashes.slice(0, limit);
  // --no-walk=unsorted 保持 rev-list 的顺序，不要按提交时间重排。
  const details = await runGit(cwd, ['log', '--no-walk=unsorted', '--format=%H%x00%s', ...shown]);
  if (details.exitCode !== 0) throw conflictError(details.stderr || '读取提交标题失败');
  const commits = details.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = ''] = line.split('\0');
      return { hash, subject };
    });
  return { commits, count: hashes.length };
}

/** 只读：删除这个分支会失去哪些引用，以及普通删除是否会被拒绝。 */
export async function branchDeletionPreview(cwd: string, input: DeleteBranchRequest): Promise<BranchDeletionPreview> {
  const before = await ensureBranchSnapshot(cwd, input, '预览删除分支');
  const target = before.branches.find((branch) => branch.name === input.branch);
  if (!target) throw conflictError(`本地分支不存在：${input.branch}`);
  const merged = await isBranchMerged(cwd, target.head, target.upstream);
  const { commits, count } = await lostCommitsOf(cwd, target.name, maxLostCommits);
  return {
    branch: target.name,
    head: target.head,
    unmerged: !merged,
    lostCommits: commits,
    lostCount: count,
    lostTruncated: count > commits.length,
  };
}

/** 备份标签名：`fleet-backup/<branch>-<本地时间戳>`，只在本仓创建，不推送。 */
function backupTagName(branch: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, '').replace('T', '-').replace(/:/g, '');
  return `fleet-backup/${branch}-${stamp}`;
}

export async function deleteBranch(
  cwd: string,
  input: DeleteBranchRequest,
): Promise<{ snapshot: BranchesSnapshot; backupTag: string | null }> {
  const target = await ensureDeletableBranch(cwd, input);
  const merged = await isBranchMerged(cwd, target.head, target.upstream);

  if (!merged && !input.force) {
    throw conflictError(`分支 ${target.name} 未合并到当前 HEAD 或其 upstream；如需强制删除，请先预览影响再确认`);
  }
  if (input.force) {
    // 强制删除不允许拿过期预览：分支可能在预览之后被人推进过，静默丢掉新提交是不可接受的。
    // 注意比较对象是**目标分支自己的 head**（`input.expectedHead` 是请求时的仓库 HEAD，由
    // ensureDeletableBranch 复核，不是这个分支的 head），且必须来自客户端预览过的那次快照。
    if (!input.expectedBranchHead) throw invalidRequestError('强制删除必须带上预览里的分支 head');
    const current = await runGitLine(cwd, ['rev-parse', '--verify', `refs/heads/${input.branch}`]).catch(() => '');
    if (current !== input.expectedBranchHead) throw conflictError('分支已变化，请重新预览后重试');
  }

  let backupTag: string | null = null;
  if (input.force && input.backupTag) {
    backupTag = backupTagName(input.branch, new Date());
    const checked = await runGit(cwd, ['check-ref-format', `refs/tags/${backupTag}`]);
    if (checked.exitCode !== 0) throw invalidRequestError('备份标签名无效');
    const created = await runGit(cwd, ['tag', backupTag, target.head]);
    // 备份失败就不删：用户明确要求先备份，静默跳过等于骗人。
    if (created.exitCode !== 0) throw conflictError(`创建备份标签失败：${created.stderr || backupTag}`);
  }

  // 普通删除与 `git branch -d` 语义一致；强制删除用 -D，且上面的护栏必须全部通过。
  const result = await runGit(cwd, ['branch', input.force ? '-D' : '--delete', input.branch]);
  if (result.exitCode !== 0) throw conflictError(`删除分支失败：${result.stderr || input.branch}`);
  return { snapshot: await listBranches(cwd), backupTag };
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
