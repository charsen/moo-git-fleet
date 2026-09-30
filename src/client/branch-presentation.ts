import type { LocalBranch } from '../shared/contracts.js';

/** 阅读顺序固定，不随当前检出分支或异步刷新跳动。 */
export function compareBranchNames(a: string, b: string, primary = 'main'): number {
  const priority = (name: string) => name === primary ? 0 : name === 'dev' ? 1 : ['main', 'master'].includes(name) ? 2 : 3;
  return priority(a) - priority(b) || a.localeCompare(b, 'en', { numeric: true });
}

export function branchDivergenceLabel(branch: Pick<LocalBranch, 'ahead' | 'behind'>): string {
  return `待推送 ${branch.ahead ?? '未知'}，待拉取 ${branch.behind ?? '未知'}`;
}
