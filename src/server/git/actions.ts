import type {
  OperationSkipReason,
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
} from '../../shared/contracts.js';
import { scanRepository } from './scanner.js';
import { runGitText } from './runner.js';

function ensureCapability(repository: RepositoryConfig, capability: keyof RepositoryConfig['capabilities']): void {
  if (!repository.capabilities[capability]) throw new Error(`仓库配置禁止 ${capability} 操作`);
}

function ensureRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Git remote 名称不安全');
}

function ensureCleanForPull(status: RepositoryStatus): void {
  if (!status.available) throw new Error('仓库不可用');
  if (status.detached) throw new Error('Detached HEAD 禁止 Pull');
  if (!status.upstream) throw new Error('当前分支没有 upstream');
  if (status.conflicted > 0 || status.inProgressOperation) throw new Error('仓库存在冲突或进行中的 Git 操作');
  if (status.staged + status.modified + status.untracked + status.deleted + status.renamed > 0) {
    throw new Error('工作区不干净，安全 Pull 已阻止');
  }
}

async function configuredRemote(cwd: string, config: RepositoriesConfig): Promise<string> {
  const remotes = (await runGitText(cwd, ['remote'])).split('\n').filter(Boolean);
  const remote = config.settings.defaultRemote;
  ensureRemoteName(remote);
  if (!remotes.includes(remote)) throw new Error(`仓库缺少 remote：${remote}`);
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
  action: 'Pull' | 'Push',
): void {
  if (status.branch !== expected.branch || status.lastCommit?.hash !== expected.head) {
    throw new Error(`当前分支或 HEAD 已变化，安全 ${action} 已阻止`);
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
  if (!upstreamRef) throw new Error('当前分支没有 upstream');
  if (!upstreamRef.startsWith('refs/')) throw new Error('Upstream branch 配置无效');
  await runGitText(cwd, ['check-ref-format', upstreamRef]);
  const head = await runGitText(cwd, ['rev-parse', '--verify', `${upstreamRef}^{commit}`]);
  return { ref: upstreamRef, head };
}

async function rescanPullResult(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  upstream: { ref: string; head: string },
): Promise<{ status: RepositoryStatus; currentUpstreamHead: string }> {
  let status = await scanRepository(config, repository);
  let currentUpstreamHead = await runGitText(cwd, ['rev-parse', '--verify', `${upstream.ref}^{commit}`]).catch(() => '');

  // A concurrent Fetch can update the remote-tracking ref between the final
  // merge and the first status scan. If that scan still reports a clean
  // upstream, take a small, bounded second snapshot so the UI does not claim
  // "up to date" while a commit is already waiting remotely.
  for (let attempt = 0; attempt < 3 && currentUpstreamHead !== upstream.head && (status.behind ?? 0) === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = await scanRepository(config, repository);
    currentUpstreamHead = await runGitText(cwd, ['rev-parse', '--verify', `${upstream.ref}^{commit}`]).catch(() => '');
  }

  return { status, currentUpstreamHead };
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
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'pull');
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  ensureCleanForPull(before);
  if (!initial.branch) throw new Error('Detached HEAD 禁止 Pull');
  const expected = { branch: initial.branch, head: initial.head };
  ensureActionSnapshot(before, expected, 'Pull');
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  ensureCleanForPull(fresh);
  ensureActionSnapshot(fresh, expected, 'Pull');
  if ((fresh.ahead ?? 0) > 0 && (fresh.behind ?? 0) > 0) throw new Error('本地与远端已分叉，禁止自动 Pull');
  if ((fresh.ahead ?? 0) > 0) {
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '本地存在领先提交，无需 Pull' };
  }
  if ((fresh.behind ?? 0) === 0) {
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }

  const upstream = await upstreamSnapshot(cwd, expected.branch);
  const final = await scanRepository(config, repository);
  ensureCleanForPull(final);
  ensureActionSnapshot(final, expected, 'Pull');
  const finalIdentity = await currentBranchAndHead(cwd);
  if (finalIdentity.branch !== expected.branch || finalIdentity.head !== expected.head) {
    throw new Error('当前分支或 HEAD 已变化，安全 Pull 已阻止');
  }
  await runGitText(cwd, ['merge', '--ff-only', '--no-edit', '--', upstream.head], 300_000);
  const result = await rescanPullResult(config, repository, cwd, upstream);
  const { status, currentUpstreamHead } = result;
  if (status.branch !== expected.branch || status.lastCommit?.hash !== upstream.head) {
    throw new Error('Pull 执行期间当前分支或 HEAD 已变化，请检查仓库状态');
  }
  return {
    status,
    skipped: false,
    message:
      currentUpstreamHead && currentUpstreamHead !== upstream.head
        ? 'Fast-forward Pull 完成；Pull 期间 upstream 出现新提交，仍待拉取'
        : 'Fast-forward Pull 完成',
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
  if (before.detached || !initial.branch) throw new Error('Detached HEAD 禁止 Push');
  if (!before.branch || !before.upstream) throw new Error('当前分支没有 upstream');
  if (before.conflicted > 0 || before.inProgressOperation) throw new Error('仓库存在冲突或进行中的 Git 操作');
  const expected = { branch: initial.branch, head: initial.head };
  ensureActionSnapshot(before, expected, 'Push');
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  if (!fresh.available) throw new Error('仓库不可用');
  if (fresh.detached || !fresh.branch) throw new Error('Detached HEAD 禁止 Push');
  if (!fresh.upstream) throw new Error('当前分支没有 upstream');
  if (fresh.conflicted > 0 || fresh.inProgressOperation) throw new Error('仓库存在冲突或进行中的 Git 操作');
  ensureActionSnapshot(fresh, expected, 'Push');
  if ((fresh.behind ?? 0) > 0) throw new Error('远端存在新提交或已经分叉，禁止 Push');
  if ((fresh.ahead ?? 0) === 0) {
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '没有需要推送的 commit' };
  }

  const remote = await runGitText(cwd, ['config', '--get', `branch.${expected.branch}.remote`]);
  const mergeRef = await runGitText(cwd, ['config', '--get', `branch.${expected.branch}.merge`]);
  ensureRemoteName(remote);
  if (!mergeRef.startsWith('refs/heads/')) throw new Error('Upstream branch 配置无效');
  await runGitText(cwd, ['check-ref-format', mergeRef]);
  const final = await currentBranchAndHead(cwd);
  if (final.branch !== expected.branch || final.head !== expected.head) {
    throw new Error('当前分支或 HEAD 已变化，安全 Push 已阻止');
  }
  await runGitText(cwd, ['push', '--porcelain', remote, `${expected.head}:${mergeRef}`], 300_000);
  const status = await scanRepository(config, repository);
  const changedDuringPush = status.branch !== expected.branch || status.lastCommit?.hash !== expected.head;
  return {
    status,
    skipped: false,
    message: changedDuringPush ? 'Push 完成；推送期间本地分支或 HEAD 已变化，新 commit 未被推送' : 'Push 完成',
  };
}
