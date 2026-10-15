import type {
  OperationSkipReason,
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
  StashEntry,
} from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { conflictError, safetyBlockedError } from '../errors.js';
import { repositoryInternalState } from './scanner.js';
import { scanRepository } from './scanner.js';
import { runGit, runGitText } from './runner.js';
import { createStash, popStash } from './stash.js';

function ensureCapability(repository: RepositoryConfig, capability: keyof RepositoryConfig['capabilities']): void {
  if (!repository.capabilities[capability]) throw safetyBlockedError(`仓库配置禁止 ${capability} 操作`);
}

function ensureRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Git remote 名称不安全');
}

function ensureCleanForPull(status: RepositoryStatus): void {
  if (!status.available) throw new Error('仓库不可用');
  if (status.detached) throw safetyBlockedError('Detached HEAD 禁止 Pull');
  if (!status.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (status.conflicted > 0 || status.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  if (status.staged + status.modified + status.untracked + status.deleted + status.renamed > 0) {
    throw safetyBlockedError('工作区不干净，Pull 已阻止');
  }
}

function hasWorktreeChanges(status: RepositoryStatus): boolean {
  return status.staged + status.modified + status.untracked + status.deleted + status.renamed > 0;
}

/**
 * Auto Stash（对齐 Tower）：工作区不干净时，若请求了 stashFirst 则先暂存，
 * 操作结束后自动 pop 恢复。pop 冲突时保留 stash 并给出提示，绝不静默丢弃改动。
 */
async function stashIfRequested(
  cwd: string,
  action: 'Pull' | '同步',
  status: RepositoryStatus,
  stashFirst: boolean,
): Promise<StashEntry | null> {
  if (!stashFirst || !hasWorktreeChanges(status)) return null;
  return createStash(cwd, `Moo Fleet ${action}前自动备份`, true);
}

async function restoreStashIfAny(cwd: string, stashed: StashEntry | null, action: 'Pull' | '同步'): Promise<string | null> {
  if (!stashed) return null;
  try {
    await popStash(cwd, stashed.ref, stashed.hash);
    return null;
  } catch (error) {
    return `${action} 完成，但自动恢复 Stash 失败（改动仍安全保留在 Stash 列表）：${error instanceof Error ? error.message : '请手动处理'}`;
  }
}

async function configuredRemote(cwd: string, config: RepositoriesConfig): Promise<string> {
  const remotes = (await runGitText(cwd, ['remote'])).split('\n').filter(Boolean);
  const remote = config.settings.defaultRemote;
  ensureRemoteName(remote);
  if (!remotes.includes(remote)) throw conflictError(`仓库缺少 remote：${remote}`);
  return remote;
}

async function currentBranchAndHead(cwd: string): Promise<{ branch: string | null; head: string }> {
  const [branch, head] = await Promise.all([
    runGitText(cwd, ['branch', '--show-current']),
    runGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  return { branch: branch || null, head };
}

function ensureActionSnapshot(
  status: RepositoryStatus,
  expected: { branch: string; head: string },
  action: 'Pull' | 'Push' | '同步',
): void {
  if (status.branch !== expected.branch || status.lastCommit?.hash !== expected.head) {
    throw safetyBlockedError(`当前分支或 HEAD 已变化，${action} 已阻止`);
  }
}

async function upstreamSnapshot(cwd: string, branch: string): Promise<{ ref: string; head: string }> {
  const branchRef = `refs/heads/${branch}`;
  const upstreamRef = await runGitText(cwd, [
    'for-each-ref',
    '--count=1',
    '--format=%(upstream)',
    '--',
    branchRef,
  ]);
  if (!upstreamRef) throw safetyBlockedError('当前分支没有 upstream');
  if (!upstreamRef.startsWith('refs/')) throw new Error('Upstream branch 配置无效');
  await runGitText(cwd, ['check-ref-format', upstreamRef]);
  const head = await runGitText(cwd, ['rev-parse', '--verify', `${upstreamRef}^{commit}`]);
  return { ref: upstreamRef, head };
}

export async function fetchRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<RepositoryStatus> {
  ensureCapability(repository, 'fetch');
  const remote = await configuredRemote(cwd, config);
  await runGitText(cwd, ['fetch', '--prune', remote], 300_000);
  return scanRepository(config, repository);
}

export async function pullRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  options: { stashFirst?: boolean; rebase?: boolean } = {},
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'pull');
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  if (!before.available) throw new Error('仓库不可用');
  if (before.detached) throw safetyBlockedError('Detached HEAD 禁止 Pull');
  if (!before.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (before.conflicted > 0 || before.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  const stashed = await stashIfRequested(cwd, 'Pull', before, options.stashFirst === true);
  if (!initial.branch) throw safetyBlockedError('Detached HEAD 禁止 Pull');
  const expected = { branch: initial.branch, head: initial.head };
  const snapshot = await scanRepository(config, repository);
  ensureCleanForPull(snapshot);
  ensureActionSnapshot(snapshot, expected, 'Pull');
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  ensureCleanForPull(fresh);
  ensureActionSnapshot(fresh, expected, 'Pull');
  if ((fresh.ahead ?? 0) > 0 && (fresh.behind ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '本地存在领先提交，无需 Pull' };
  }
  if ((fresh.behind ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }

  const upstream = await upstreamSnapshot(cwd, expected.branch);
  const final = await scanRepository(config, repository);
  ensureCleanForPull(final);
  ensureActionSnapshot(final, expected, 'Pull');
  const finalIdentity = await currentBranchAndHead(cwd);
  if (finalIdentity.branch !== expected.branch || finalIdentity.head !== expected.head) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    throw safetyBlockedError('当前分支或 HEAD 已变化，Pull 已阻止');
  }
  // 整合远端：默认 merge（分叉时产生 merge commit），可选 rebase（线性历史）。
  // 用 try/catch 确保无论整合成功、冲突暂停还是失败，Auto Stash 都会被恢复。
  try {
    await integrateUpstream(cwd, upstream.head, options.rebase === true, 'Pull');
  } catch (error) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    throw error;
  }
  const restoreNote = await restoreStashIfAny(cwd, stashed, 'Pull');
  const status = await scanRepository(config, repository);
  return {
    status,
    skipped: false,
    message: restoreNote ? `Pull 完成；${restoreNote}` : 'Pull 完成',
  };
}

/**
 * 把 upstream 整合进当前分支：默认 `git merge`（分叉时产生 merge commit），
 * 可选 `git rebase`（把本地提交重放到远端之上，产生线性历史）。
 * merge 与 rebase 冲突都抛 `merge-paused`（conflicts.ts 已支持两者 continue）。
 */
async function integrateUpstream(cwd: string, upstreamHead: string, rebase: boolean, action: 'Pull' | '同步'): Promise<void> {
  const result = rebase
    ? await runGit(cwd, ['rebase', '--', upstreamHead], 300_000)
    : await runGit(cwd, ['merge', '--no-edit', '--', upstreamHead], 300_000);
  if (result.exitCode !== 0) {
    const internal = await repositoryInternalState(cwd);
    if (internal.operation === 'merge' || internal.operation === 'rebase') {
      const mode = internal.operation === 'rebase' ? 'rebase' : '合并';
      throw conflictError(
        `${action}遇到冲突，${mode}已暂停，请在工作区处理后继续或中止${result.stderr ? `。Git 提示：${result.stderr}` : ''}`,
        { code: mergePausedErrorCode },
      );
    }
    throw conflictError(result.stderr || result.stdout.toString('utf8').trim() || `${action}整合失败`);
  }
}

/**
 * 同步：对齐 Tower 的 Sync —— Pull（Fetch + 整合）+ 自动 Push，
 * 一个动作完成双向同步。整合默认 merge（可选 rebase），冲突才暂停。
 */
export async function syncRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  options: { stashFirst?: boolean; rebase?: boolean } = {},
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'pull');
  ensureCapability(repository, 'fetch');
  ensureCapability(repository, 'push');
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  if (!before.available) throw new Error('仓库不可用');
  if (before.detached) throw safetyBlockedError('Detached HEAD 禁止同步');
  if (!before.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (before.conflicted > 0 || before.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  const stashed = await stashIfRequested(cwd, '同步', before, options.stashFirst === true);
  if (!initial.branch) throw safetyBlockedError('Detached HEAD 禁止同步');
  const expected = { branch: initial.branch, head: initial.head };
  const snapshot = await scanRepository(config, repository);
  ensureCleanForPull(snapshot);
  ensureActionSnapshot(snapshot, expected, '同步');
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  ensureCleanForPull(fresh);
  ensureActionSnapshot(fresh, expected, '同步');
  // 无落后且无领先：完全一致，无需同步。
  if ((fresh.behind ?? 0) === 0 && (fresh.ahead ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, '同步');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }
  // 只有领先（ahead>0 且 behind==0）：无需 merge，直接推送。
  if ((fresh.behind ?? 0) === 0) {
    try {
      const pushed = await pushCurrentHead(config, repository, cwd, expected, '同步');
      const restoreNote = await restoreStashIfAny(cwd, stashed, '同步');
      return { ...pushed, message: restoreNote ? `同步完成；${restoreNote}` : '同步完成；本地领先提交已推送' };
    } catch (error) {
      await restoreStashIfAny(cwd, stashed, '同步');
      throw error;
    }
  }

  const upstream = await upstreamSnapshot(cwd, expected.branch);
  const final = await scanRepository(config, repository);
  ensureCleanForPull(final);
  ensureActionSnapshot(final, expected, '同步');
  const finalIdentity = await currentBranchAndHead(cwd);
  if (finalIdentity.branch !== expected.branch || finalIdentity.head !== expected.head) {
    await restoreStashIfAny(cwd, stashed, '同步');
    throw safetyBlockedError('当前分支或 HEAD 已变化，同步已阻止');
  }
  // 整合远端（默认 merge / 可选 rebase），与 Pull 共用同一整合逻辑。
  // try/catch 确保冲突暂停或失败时 Auto Stash 仍被恢复。
  try {
    await integrateUpstream(cwd, upstream.head, options.rebase === true, '同步');
  } catch (error) {
    await restoreStashIfAny(cwd, stashed, '同步');
    throw error;
  }
  // 整合成功（merge 产生 merge commit / rebase 产生线性提交），HEAD 已前移，
  // 重新取当前 HEAD 作为推送快照，随后自动推送本地领先提交。
  const mergedHead = await runGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const mergedExpected = { branch: expected.branch, head: mergedHead };
  const mergedStatus = await scanRepository(config, repository);
  if (mergedStatus.branch !== expected.branch) {
    await restoreStashIfAny(cwd, stashed, '同步');
    throw safetyBlockedError('同步执行期间当前分支已变化，请检查仓库状态');
  }
  if ((mergedStatus.ahead ?? 0) > 0) {
    await pushCurrentHead(config, repository, cwd, mergedExpected, '同步');
  }
  const status = await scanRepository(config, repository);
  const restoreNote = await restoreStashIfAny(cwd, stashed, '同步');
  const base = (status.ahead ?? 0) > 0 ? '同步完成；仍存在本地领先提交待推送' : '同步完成；已推送全部领先提交';
  return {
    status,
    skipped: false,
    message: restoreNote ? `${base}；${restoreNote}` : base,
  };
}

export async function pushRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'push');
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  if (!before.available) throw new Error('仓库不可用');
  if (before.detached || !initial.branch) throw safetyBlockedError('Detached HEAD 禁止 Push');
  if (!before.branch || !before.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (before.conflicted > 0 || before.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  const expected = { branch: initial.branch, head: initial.head };
  ensureActionSnapshot(before, expected, 'Push');
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  if (!fresh.available) throw new Error('仓库不可用');
  if (fresh.detached || !fresh.branch) throw safetyBlockedError('Detached HEAD 禁止 Push');
  if (!fresh.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (fresh.conflicted > 0 || fresh.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  ensureActionSnapshot(fresh, expected, 'Push');
  if ((fresh.behind ?? 0) > 0) throw safetyBlockedError('远端存在新提交或已经分叉，禁止 Push');
  if ((fresh.ahead ?? 0) === 0) {
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '没有需要推送的 commit' };
  }
  return pushCurrentHead(config, repository, cwd, expected, 'Push');
}

/**
 * 把当前 HEAD 推送到其 upstream 分支（明确 refspec，永不 force push）。
 * `syncRepository` 在 merge 成功后复用此逻辑，实现「拉 + 自动推」。
 */
async function pushCurrentHead(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  expected: { branch: string; head: string },
  action: 'Push' | '同步',
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  const remote = await runGitText(cwd, ['config', '--get', `branch.${expected.branch}.remote`]);
  const mergeRef = await runGitText(cwd, ['config', '--get', `branch.${expected.branch}.merge`]);
  ensureRemoteName(remote);
  if (!mergeRef.startsWith('refs/heads/')) throw new Error('Upstream branch 配置无效');
  await runGitText(cwd, ['check-ref-format', mergeRef]);
  const final = await currentBranchAndHead(cwd);
  if (final.branch !== expected.branch || final.head !== expected.head) {
    throw safetyBlockedError(`当前分支或 HEAD 已变化，${action} 已阻止`);
  }
  await runGitText(cwd, ['push', '--porcelain', remote, `${expected.head}:${mergeRef}`], 300_000);
  const status = await scanRepository(config, repository);
  const changedDuringPush = status.branch !== expected.branch || status.lastCommit?.hash !== expected.head;
  return {
    status,
    skipped: false,
    message: changedDuringPush ? `${action} 完成；推送期间本地分支或 HEAD 已变化，新 commit 未被推送` : `${action} 完成`,
  };
}
