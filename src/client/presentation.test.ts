import { describe, expect, it } from 'vitest';
import type { OperationState, OperationType, RepositoryState } from '../shared/contracts';
import {
  formatDuration,
  initials,
  operationStateLabel,
  operationTypeLabel,
  statusMeta,
  upstreamCandidateDivergence,
  upstreamCandidateReason,
} from './presentation';

describe('statusMeta', () => {
  it('为每个 RepositoryState 提供文案与色调', () => {
    const allStates: Record<RepositoryState, true> = {
      missing: true,
      invalid: true,
      conflict: true,
      'operation-in-progress': true,
      diverged: true,
      dirty: true,
      ahead: true,
      behind: true,
      clean: true,
      'remote-unknown': true,
    };
    for (const state of Object.keys(allStates) as RepositoryState[]) {
      expect(statusMeta[state].label.length).toBeGreaterThan(0);
      expect(statusMeta[state].tone.length).toBeGreaterThan(0);
    }
  });
});

describe('operation labels', () => {
  it('为每个 OperationType 给出非空标签，未显式配置的退化为大写', () => {
    const allTypes: Record<OperationType, true> = {
      fetch: true,
      pull: true,
      push: true,
      commit: true,
      stash: true,
      'switch-branch': true,
      'set-upstream': true,
      branch: true,
      conflict: true,
      tag: true,
    };
    for (const type of Object.keys(allTypes) as OperationType[]) {
      expect(operationTypeLabel(type).length).toBeGreaterThan(0);
    }
    expect(operationTypeLabel('fetch')).toBe('FETCH');
    expect(operationTypeLabel('branch')).toBe('分支管理');
    expect(operationTypeLabel('conflict')).toBe('冲突处理');
  });

  it('为每个 OperationState 给出中文标签', () => {
    const allStates: Record<OperationState, string> = {
      queued: '等待',
      running: '执行中',
      success: '成功',
      skipped: '跳过',
      failed: '失败',
    };
    for (const [state, label] of Object.entries(allStates) as Array<[OperationState, string]>) {
      expect(operationStateLabel(state)).toBe(label);
    }
  });
});

describe('formatDuration', () => {
  it('毫秒与秒分别格式化，秒级按量级选精度', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1.00s');
    expect(formatDuration(9_999)).toBe('10.00s');
    expect(formatDuration(10_000)).toBe('10.0s');
    expect(formatDuration(65_432)).toBe('65.4s');
  });
});

describe('initials', () => {
  it('取前两个字符并大写，空名称有兜底', () => {
    expect(initials('charsen')).toBe('CH');
    expect(initials('  moo  ')).toBe('MO');
    expect(initials('张')).toBe('张');
    expect(initials('')).toBe('GF');
    expect(initials('   ')).toBe('GF');
  });
});

describe('upstream candidate presentation', () => {
  it('区分同名与同 HEAD 两种候选来源', () => {
    expect(upstreamCandidateReason({ reason: 'same-name' })).toBe('当前分支同名');
    expect(upstreamCandidateReason({ reason: 'same-head' })).toBe('与当前 HEAD 相同');
  });

  it('差异未知、对齐与分叉三种状态各有明确说法', () => {
    expect(upstreamCandidateDivergence({ ahead: null, behind: null })).toBe('提交关系待关联后确认');
    expect(upstreamCandidateDivergence({ ahead: 0, behind: 0 })).toBe('提交已对齐');
    expect(upstreamCandidateDivergence({ ahead: 2, behind: 3 })).toBe('待推送 2 · 待拉取 3');
    expect(upstreamCandidateDivergence({ ahead: 0, behind: 5 })).toBe('待推送 0 · 待拉取 5');
  });
});
