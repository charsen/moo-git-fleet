import type { RepositoriesConfig, RepositoryConfig, RepositoryStatus } from '../../shared/contracts.js';
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
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string }> {
  ensureCapability(repository, 'pull');
  const before = await scanRepository(config, repository);
  ensureCleanForPull(before);
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  ensureCleanForPull(fresh);
  if ((fresh.ahead ?? 0) > 0 && (fresh.behind ?? 0) > 0) throw new Error('本地与远端已分叉，禁止自动 Pull');
  if ((fresh.ahead ?? 0) > 0) return { status: fresh, skipped: true, message: '本地存在领先提交，无需 Pull' };
  if ((fresh.behind ?? 0) === 0) return { status: fresh, skipped: true, message: '已经是最新状态' };
  await runGitText(cwd, ['merge', '--ff-only', '--no-edit', '--', '@{upstream}'], 300_000);
  return { status: await scanRepository(config, repository), skipped: false, message: 'Fast-forward Pull 完成' };
}

export async function pushRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string }> {
  ensureCapability(repository, 'push');
  const before = await scanRepository(config, repository);
  if (!before.available) throw new Error('仓库不可用');
  if (before.detached) throw new Error('Detached HEAD 禁止 Push');
  if (!before.branch || !before.upstream) throw new Error('当前分支没有 upstream');
  if (before.conflicted > 0 || before.inProgressOperation) throw new Error('仓库存在冲突或进行中的 Git 操作');
  await fetchRepository(config, repository, cwd);
  const fresh = await scanRepository(config, repository);
  if ((fresh.behind ?? 0) > 0) throw new Error('远端存在新提交或已经分叉，禁止 Push');
  if ((fresh.ahead ?? 0) === 0) return { status: fresh, skipped: true, message: '没有需要推送的 commit' };

  const remote = await runGitText(cwd, ['config', '--get', `branch.${fresh.branch}.remote`]);
  const mergeRef = await runGitText(cwd, ['config', '--get', `branch.${fresh.branch}.merge`]);
  ensureRemoteName(remote);
  if (!mergeRef.startsWith('refs/heads/')) throw new Error('Upstream branch 配置无效');
  await runGitText(cwd, ['check-ref-format', mergeRef]);
  await runGitText(cwd, ['push', '--porcelain', remote, `HEAD:${mergeRef}`], 300_000);
  return { status: await scanRepository(config, repository), skipped: false, message: 'Push 完成' };
}
