import type { LocalBranch } from '../shared/contracts.js';

export function branchDivergenceLabel(branch: Pick<LocalBranch, 'ahead' | 'behind'>): string {
  return `待推送 ${branch.ahead ?? '未知'}，待拉取 ${branch.behind ?? '未知'}`;
}
