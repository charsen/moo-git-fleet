import { describe, expect, it } from 'vitest';
import { branchDivergenceLabel } from './branch-presentation.js';

describe('branchDivergenceLabel', () => {
  it('distinguishes ahead and behind values', () => {
    expect(branchDivergenceLabel({ ahead: 2, behind: 5 })).toBe('待推送 2，待拉取 5');
  });

  it('labels missing upstream divergence as unknown in both directions', () => {
    expect(branchDivergenceLabel({ ahead: null, behind: null })).toBe('待推送 未知，待拉取 未知');
  });
});
