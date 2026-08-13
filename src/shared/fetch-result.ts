import type { RepositoryStatus } from './contracts.js';

export function fetchResultMessage(status: Pick<RepositoryStatus, 'ahead' | 'behind'>): string {
  if (status.behind === null) return 'Fetch 完成：当前分支远端差异未知';
  if (status.behind === 0) return 'Fetch 完成：未发现当前分支的新提交';
  if ((status.ahead ?? 0) > 0) {
    return `Fetch 完成：远端有 ${status.behind} 个新提交，本地与远端已分叉`;
  }
  return `Fetch 完成：发现远端 ${status.behind} 个新提交`;
}

export function fetchBatchResultMessage(repositories: Array<Pick<RepositoryStatus, 'behind'>>): string {
  const behind = repositories.filter((repository) => (repository.behind ?? 0) > 0).length;
  return behind > 0
    ? `成功 Fetch 的仓库中，有 ${behind} 个存在远端新提交`
    : '成功 Fetch 的仓库均未落后于远端';
}
