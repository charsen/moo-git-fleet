import { describe, expect, it } from 'vitest';
import { branchDivergenceLabel } from './branch-presentation.js';

describe('branchDivergenceLabel', () => {
  it('distinguishes ahead and behind values', () => {
    expect(branchDivergenceLabel({ ahead: 2, behind: 5 })).toBe('待推送 2，待拉取 5');
  });

  it('explains missing divergence: no upstream vs upstream temporarily unavailable', () => {
    expect(branchDivergenceLabel({ ahead: null, behind: null, upstream: null })).toBe('未关联 upstream，无法确定待推送或待拉取数量');
    expect(branchDivergenceLabel({ ahead: null, behind: null, upstream: 'origin/main' })).toBe('待推送 / 待拉取数量未知（upstream 暂不可比对）');
  });
});

describe('branch reading order', () => {
  it('puts release branches before dev and sorts remaining names without mutating HEAD priority', async () => {
    const { compareBranchNames } = await import('./branch-presentation');
    expect(['z-last', 'dev', 'feature/10', 'master', 'main', 'feature/2'].sort((a, b) => compareBranchNames(a, b))).toEqual(['main', 'dev', 'master', 'feature/2', 'feature/10', 'z-last']);
    expect(['feature', 'dev', 'master'].sort((a, b) => compareBranchNames(a, b, 'master'))).toEqual(['master', 'dev', 'feature']);
  });
});
