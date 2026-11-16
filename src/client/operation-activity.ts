import type { BatchOperationType, BatchRecord, OperationRecord, OperationType } from '../shared/contracts';

/**
 * 仓库行上要显示的「正在处理」信息。
 *
 * 只关心「此刻真的在做」，所以只保留 queued / running 两个状态；成功、失败、跳过都不算。
 */
export interface RepositoryActivity {
  type: OperationType;
  state: 'queued' | 'running';
}

/**
 * 单仓操作没有批次可依，孤儿记录（上一次进程重启前留下的 running）不能永远当作「处理中」。
 * 10 分钟足够覆盖任何真实的 fetch / push；超过就认为已失效。
 */
const ORPHAN_OPERATION_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * 从实时操作流里挑出「此刻确实在跑」的仓库，key 是仓库 id。
 *
 * 为什么不用仓库的 state === 'operation-in-progress'：那个状态来自 dashboard 全量扫描，
 * 15 秒才刷新一次；一次本地 batch 常常几百毫秒就结束，界面上根本来不及出现。
 * 操作流（SSE）是实时的，逐仓 queued / running 都在里面，所以行内提示从这里取。
 *
 * 后台自动 Fetch 故意排除：它按周期反复跑，若让每行跟着闪「拉取中」，会把仓库列表变成
 * 噪声；这类进度仍由顶栏的历史图标表达（与「后台批次不占批量按钮」的既有口径一致）。
 */
export function activeRepositoryActivities(
  operations: OperationRecord[],
  batches: BatchRecord[],
  now: number = Date.now(),
): Map<string, RepositoryActivity> {
  const foregroundRunningBatchIds = new Set(
    batches
      .filter((batch) => batch.state === 'running' && batch.background !== true)
      .map((batch) => batch.id),
  );
  const activities = new Map<string, RepositoryActivity>();
  for (const operation of operations) {
    if (operation.state !== 'queued' && operation.state !== 'running') continue;
    if (operation.batchId) {
      // 批次内的过程项：只有该批次此刻确在前台执行才算，避免重启遗留的 running 记录冒充进行中。
      if (!foregroundRunningBatchIds.has(operation.batchId)) continue;
    } else {
      if (operation.state !== 'running') continue;
      const startedAt = operation.startedAt ? Date.parse(operation.startedAt) : Number.NaN;
      if (!Number.isFinite(startedAt) || now - startedAt > ORPHAN_OPERATION_MAX_AGE_MS) continue;
    }
    // 同一个仓库只显示一条：批次的下一项已排队时，先到的那条更接近真相。
    if (!activities.has(operation.repositoryId)) {
      activities.set(operation.repositoryId, { type: operation.type, state: operation.state });
    }
  }
  return activities;
}

/** 各动作的短动词。认不出的类型退回「处理」。 */
const activityVerbs: Partial<Record<OperationType, string>> = {
  fetch: '拉取',
  pull: '拉取',
  'pull-branches': '拉取',
  push: '推送',
  'push-branches': '推送',
  sync: '同步',
  merge: '合并',
  'merge-branches': '合并',
  commit: '提交',
  stash: '暂存',
  'switch-branch': '切换分支',
  tag: '标签处理',
  'set-upstream': '关联',
};

/**
 * 仓库行上的一句话状态。
 *
 * 排队项还没轮到执行，写「拉取中」会骗人；批次的并发有限，40 个仓库里同时真正在跑的只有几个，
 * 所以排队统一叫「排队中」，只有 running 才说「拉取中 / 推送中 / 合并中」。
 */
export function repositoryActivityLabel(
  type: OperationType | undefined,
  state: 'queued' | 'running' = 'running',
): string {
  if (state === 'queued') return '排队中';
  const verb = (type && activityVerbs[type]) || '处理';
  return `${verb}中`;
}

/** 批量按钮此刻该显示成什么：null=空闲，starting=正在起步，running=批次执行中。 */
export type BatchButtonActivity =
  | { phase: 'starting' }
  | { phase: 'running'; completed: number; total: number };

/**
 * 把「某个批量类型 + 正在起的类型 + 当前批次」翻译成按钮要显示的状态。
 *
 * 与 foregroundBatchRunning 的口径一致：后台自动 Fetch 不占批量按钮。
 */
export function batchButtonActivity(
  type: BatchOperationType,
  batchStarting: BatchOperationType | null,
  activeBatch: BatchRecord | null,
): BatchButtonActivity | null {
  if (batchStarting === type) return { phase: 'starting' };
  if (
    activeBatch
    && activeBatch.state === 'running'
    && activeBatch.background !== true
    && activeBatch.type === type
  ) {
    return { phase: 'running', completed: activeBatch.completed, total: activeBatch.total };
  }
  return null;
}
