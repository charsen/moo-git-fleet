import type { OperationRecord, RepositoryState, UpstreamCandidate } from '../shared/contracts';

/** 仓库状态在列表与抽屉里的展示文案与色调。 */
export const statusMeta: Record<RepositoryState, { label: string; tone: string }> = {
  conflict: { label: '冲突', tone: 'red' },
  'operation-in-progress': { label: '操作进行中', tone: 'red' },
  diverged: { label: '已分叉', tone: 'red' },
  dirty: { label: '有改动', tone: 'yellow' },
  ahead: { label: '待推送', tone: 'blue' },
  behind: { label: '待拉取', tone: 'cyan' },
  clean: { label: '已同步', tone: 'green' },
  'remote-unknown': { label: '未关联', tone: 'muted' },
  missing: { label: '路径缺失', tone: 'muted' },
  invalid: { label: '无效仓库', tone: 'red' },
};

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}

export function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || 'GF';
}

const operationTypeLabels: Partial<Record<OperationRecord['type'], string>> = {
  commit: 'COMMIT',
  'switch-branch': '切换分支',
  branch: '分支管理',
  conflict: '冲突处理',
  tag: '标签管理',
  'set-upstream': '关联 upstream',
};

export function operationTypeLabel(type: OperationRecord['type']): string {
  return operationTypeLabels[type] ?? type.toUpperCase();
}

const operationStateLabels: Record<OperationRecord['state'], string> = {
  queued: '等待',
  running: '执行中',
  success: '成功',
  skipped: '跳过',
  failed: '失败',
};

export function operationStateLabel(state: OperationRecord['state']): string {
  return operationStateLabels[state];
}

export function upstreamCandidateReason(candidate: Pick<UpstreamCandidate, 'reason'>): string {
  return candidate.reason === 'same-name' ? '当前分支同名' : '与当前 HEAD 相同';
}

export function upstreamCandidateDivergence(
  candidate: Pick<UpstreamCandidate, 'ahead' | 'behind'>,
): string {
  if (candidate.ahead === null || candidate.behind === null) return '提交关系待关联后确认';
  if (candidate.ahead === 0 && candidate.behind === 0) return '提交已对齐';
  return `待推送 ${candidate.ahead} · 待拉取 ${candidate.behind}`;
}
