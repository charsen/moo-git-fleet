import type { LocalBranch } from '../shared/contracts.js';

/** 阅读顺序固定，不随当前检出分支或异步刷新跳动。 */
export function compareBranchNames(a: string, b: string, primary = 'main'): number {
  const priority = (name: string) => name === primary ? 0 : name === 'dev' ? 1 : ['main', 'master'].includes(name) ? 2 : 3;
  return priority(a) - priority(b) || a.localeCompare(b, 'en', { numeric: true });
}

export function branchDivergenceLabel(branch: Pick<LocalBranch, 'ahead' | 'behind'> & { upstream?: string | null }): string {
  // ahead/behind 为 null 通常意味着「这个分支没有 upstream」，而不是接口没取到；
  // 说清原因比只写「未知」更有用。
  if (branch.ahead === null || branch.behind === null) {
    return branch.upstream ? '待推送 / 待拉取数量未知（upstream 暂不可比对）' : '未关联 upstream，无法确定待推送或待拉取数量';
  }
  return `待推送 ${branch.ahead}，待拉取 ${branch.behind}`;
}
