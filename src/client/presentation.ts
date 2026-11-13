import type { BatchOperationType, OperationRecord, RepositoryState, UpstreamCandidate } from '../shared/contracts';

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
  merge: '合并分支',
  'merge-branches': '双线合并',
  conflict: '冲突处理',
  tag: '标签管理',
  'set-upstream': '关联 upstream',
  'push-branches': '多分支推送',
  'pull-branches': '多分支拉取',
  sync: '同步',
    'remote-protocol': '切换远端协议',
    remote: '远端管理',
    'undo-commit': '撤销提交',
    revert: '回退提交',
    'cherry-pick': '拣选提交',
  };

export function operationTypeLabel(type: OperationRecord['type']): string {
  return operationTypeLabels[type] ?? type.toUpperCase();
}

/**
 * 批量操作的类型名。
 *
 * 不能直接 `type.toUpperCase()`：`push-branches` 会被拼成「PUSH-BRANCHES」，
 * 出现在完成提示和批次抽屉里都是内部代号。
 */
export function batchTypeLabel(type: BatchOperationType, background = false): string {
  // 联网类沿用大写短名（与按钮和既有提示一致），只有新增的复合类型需要中文，
  // 否则会出现「PUSH-BRANCHES 批量任务」这种内部代号。
  const label = type === 'push-branches'
    ? '多分支推送'
    : type === 'pull-branches'
      ? '多分支拉取'
      : type === 'merge-branches'
        ? '双线合并'
        : type.toUpperCase();
  // 自动 Fetch 会让路给用户操作，抽屉里得能一眼看出这轮是谁发起的。
  return background ? `${label}（自动）` : label;
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
