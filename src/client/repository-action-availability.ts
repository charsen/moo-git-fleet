import type { BatchOperationType, RepositoryStatus } from '../shared/contracts';

export interface RepositoryActionAvailability {
  available: boolean;
  detail: string;
}

function unavailable(detail: string): RepositoryActionAvailability {
  return { available: false, detail };
}

function worktreeChangeDetail(repository: RepositoryStatus): string | null {
  const parts = [
    repository.staged > 0 ? `${repository.staged} 项已暂存` : '',
    repository.modified > 0 ? `${repository.modified} 项已修改` : '',
    repository.untracked > 0 ? `${repository.untracked} 项未跟踪` : '',
    repository.deleted > 0 ? `${repository.deleted} 项删除` : '',
    repository.renamed > 0 ? `${repository.renamed} 项重命名` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('、') : null;
}

export function fetchAvailability(repository: RepositoryStatus | null): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库');
  if (!repository.config.capabilities.fetch) return unavailable('仓库配置未允许 Fetch');
  if (!repository.available) return unavailable('仓库当前不可用');
  if (!repository.remoteUrl) return unavailable('仓库没有可用 remote');
  return { available: true, detail: '刷新远端跟踪分支，不修改工作区' };
}

export function pullAvailability(repository: RepositoryStatus | null): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库');
  if (!repository.config.capabilities.pull) return unavailable('仓库配置未允许 Pull');
  if (!repository.config.capabilities.fetch) return unavailable('安全 Pull 需要同时允许 Fetch');
  if (!repository.available) return unavailable('仓库当前不可用');
  if (repository.detached || !repository.branch) return unavailable('Detached HEAD 不能 Pull');
  if (!repository.upstream) return unavailable('当前分支没有 upstream');
  if (repository.conflicted > 0 || repository.inProgressOperation) {
    return unavailable('存在冲突或进行中的 Git 操作');
  }
  const worktreeChanges = worktreeChangeDetail(repository);
  if (worktreeChanges) return unavailable(`工作区有 ${worktreeChanges}，清理或 Stash 后可 Pull`);
  if (repository.ahead === null || repository.behind === null) {
    return unavailable('远端差异未知，请先 Fetch 后再检查');
  }
  if (repository.ahead > 0 && repository.behind > 0) return unavailable('本地与远端已分叉，不能安全 Pull');
  if (repository.ahead > 0) return unavailable('本地存在领先提交，无需 Pull');
  if (repository.behind === 0) return unavailable('当前没有落后提交，无需 Pull');
  return { available: true, detail: '只允许 fast-forward' };
}

export function pushAvailability(repository: RepositoryStatus | null): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库');
  if (!repository.config.capabilities.push) return unavailable('仓库配置未允许 Push');
  if (!repository.config.capabilities.fetch) return unavailable('安全 Push 需要同时允许 Fetch');
  if (!repository.available) return unavailable('仓库当前不可用');
  if (repository.detached || !repository.branch) return unavailable('Detached HEAD 不能 Push');
  if (!repository.upstream) return unavailable('当前分支没有 upstream');
  if (repository.conflicted > 0 || repository.inProgressOperation) {
    return unavailable('存在冲突或进行中的 Git 操作');
  }
  if (repository.ahead === null || repository.behind === null) {
    return unavailable('远端差异未知，请先 Fetch 后再检查');
  }
  if (repository.behind > 0) return unavailable('远端存在新提交，请先安全 Pull；分叉状态需手动处理');
  if (repository.ahead === 0) return unavailable('当前没有待推送提交');
  return { available: true, detail: '执行前先 Fetch 复核远端，永远不会 force push' };
}

export function batchActionAvailability(
  repository: RepositoryStatus,
  type: BatchOperationType,
): RepositoryActionAvailability {
  if (type === 'fetch') return fetchAvailability(repository);
  if (type === 'pull') return pullAvailability(repository);
  return pushAvailability(repository);
}

export function batchEligibleRepositoryCount(
  repositories: RepositoryStatus[],
  type: BatchOperationType,
): number {
  return repositories.filter((repository) => batchActionAvailability(repository, type).available).length;
}
