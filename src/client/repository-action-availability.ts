import type { BatchOperationType, RepositoryStatus } from '../shared/contracts';

export interface RepositoryActionAvailability {
  available: boolean;
  detail: string;
  /**
   * 不可执行时的原因分类。
   *
   * 批量确认框要回答「为什么只有 3 个会执行」，把 50 条 `detail` 原样堆出来没法读，
   * 所以这里给一个稳定的分类，由调用方决定分组还是逐条展开。
   */
  reason?: BatchSkipReason;
}

/** 批量操作里「这个仓库为什么不做」的分类。 */
export type BatchSkipReason =
  | 'capability'
  | 'unavailable'
  | 'detached'
  | 'no-upstream'
  | 'conflict'
  | 'unknown-divergence'
  | 'ahead-only'
  | 'up-to-date'
  | 'dirty-worktree'
  | 'behind-remote'
  | 'nothing-to-push';

const batchSkipReasonLabels: Record<BatchSkipReason, string> = {
  capability: '配置不允许',
  unavailable: '仓库不可用',
  detached: 'Detached HEAD',
  'no-upstream': '没有 upstream',
  conflict: '有冲突或进行中操作',
  'unknown-divergence': '远端差异未知',
  'ahead-only': '只有本地领先提交',
  'up-to-date': '已是最新',
  'dirty-worktree': '工作区不干净',
  'behind-remote': '远端有新提交',
  'nothing-to-push': '没有待推送提交',
};

/**
 * 判定上下文。`allowsAutoStash` 区分两种使用场景：
 * 单仓操作会弹确认框让用户勾选「自动 Stash」，因此工作区脏仍可用；
 * 批量操作不提供 Stash，脏仓库实际会被服务端跳过，计数必须与之保持一致，
 * 否则会出现「提示 N 个可执行、执行后却报跳过」的自相矛盾。
 */
export interface ActionAvailabilityContext {
  allowsAutoStash?: boolean;
}

function unavailable(detail: string, reason: BatchSkipReason): RepositoryActionAvailability {
  return { available: false, detail, reason };
}

function worktreeChangeDetail(repository: RepositoryStatus): string | null {
  const parts = [
    repository.staged > 0 ? `${repository.staged} 项已暂存` : '',
    repository.modified > 0 ? `${repository.modified} 项已修改` : '',
    repository.untracked > 0 ? `${repository.untracked} 项未跟踪` : '',
    repository.deleted > 0 ? `${repository.deleted} 项删除` : '',
    repository.renamed > 0 ? `${repository.renamed} 项重命名` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('、') : null;
}

export function fetchAvailability(repository: RepositoryStatus | null): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库', 'unavailable');
  if (!repository.config.capabilities.fetch) return unavailable('仓库配置未允许 Fetch', 'capability');
  if (!repository.available) return unavailable('仓库当前不可用', 'unavailable');
  if (!repository.remoteUrl) return unavailable('仓库没有可用 remote', 'no-upstream');
  return { available: true, detail: '刷新远端跟踪分支，不修改工作区' };
}

export function pullAvailability(
  repository: RepositoryStatus | null,
  context: ActionAvailabilityContext = {},
): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库', 'unavailable');
  if (!repository.config.capabilities.pull) return unavailable('仓库配置未允许 Pull', 'capability');
  if (!repository.config.capabilities.fetch) return unavailable('Pull 需要同时允许 Fetch', 'capability');
  if (!repository.available) return unavailable('仓库当前不可用', 'unavailable');
  if (repository.detached || !repository.branch) return unavailable('Detached HEAD 不能 Pull', 'detached');
  if (!repository.upstream) return unavailable('当前分支没有 upstream', 'no-upstream');
  if (repository.conflicted > 0 || repository.inProgressOperation) {
    return unavailable('存在冲突或进行中的 Git 操作', 'conflict');
  }
  if (repository.ahead === null || repository.behind === null) {
    return unavailable('远端差异未知，请先 Fetch 后再检查', 'unknown-divergence');
  }
  if (repository.ahead > 0 && repository.behind === 0) return unavailable('本地存在领先提交，无需 Pull', 'ahead-only');
  if (repository.behind === 0) return unavailable('当前没有落后提交，无需 Pull', 'up-to-date');
  const worktreeChanges = worktreeChangeDetail(repository);
  if (worktreeChanges) {
    if (context.allowsAutoStash === false) {
      return unavailable(`工作区有 ${worktreeChanges}，批量 Pull 不自动 Stash，将被跳过`, 'dirty-worktree');
    }
    return { available: true, detail: `工作区有 ${worktreeChanges}，将自动 Stash 后 Pull（可取消勾选）` };
  }
  return { available: true, detail: '整合远端：默认 merge，可勾选 rebase；冲突会暂停处理' };
}

export function pushAvailability(repository: RepositoryStatus | null): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库', 'unavailable');
  if (!repository.config.capabilities.push) return unavailable('仓库配置未允许 Push', 'capability');
  if (!repository.config.capabilities.fetch) return unavailable('Push 需要同时允许 Fetch', 'capability');
  if (!repository.available) return unavailable('仓库当前不可用', 'unavailable');
  if (repository.detached || !repository.branch) return unavailable('Detached HEAD 不能 Push', 'detached');
  if (!repository.upstream) return unavailable('当前分支没有 upstream', 'no-upstream');
  if (repository.conflicted > 0 || repository.inProgressOperation) {
    return unavailable('存在冲突或进行中的 Git 操作', 'conflict');
  }
  if (repository.ahead === null || repository.behind === null) {
    return unavailable('远端差异未知，请先 Fetch 后再检查', 'unknown-divergence');
  }
  if (repository.behind > 0) return unavailable('远端存在新提交，请先 Pull 或同步后再推送', 'behind-remote');
  if (repository.ahead === 0) return unavailable('当前没有待推送提交', 'nothing-to-push');
  return { available: true, detail: '执行前先 Fetch 复核远端，永远不会 force push' };
}

/**
 * 同步（Sync）= Pull + Push，对齐 Tower 的双向同步：整合远端后自动推送本地提交。
 */
export function syncAvailability(
  repository: RepositoryStatus | null,
  context: ActionAvailabilityContext = {},
): RepositoryActionAvailability {
  if (!repository) return unavailable('请先选择仓库', 'unavailable');
  if (!repository.config.capabilities.pull) return unavailable('仓库配置未允许 Pull', 'capability');
  if (!repository.config.capabilities.fetch) return unavailable('同步需要同时允许 Fetch 与 Pull', 'capability');
  if (!repository.config.capabilities.push) return unavailable('同步需要同时允许 Push', 'capability');
  if (!repository.available) return unavailable('仓库当前不可用', 'unavailable');
  if (repository.detached || !repository.branch) return unavailable('Detached HEAD 不能同步', 'detached');
  if (!repository.upstream) return unavailable('当前分支没有 upstream', 'no-upstream');
  if (repository.conflicted > 0 || repository.inProgressOperation) {
    return unavailable('存在冲突或进行中的 Git 操作', 'conflict');
  }
  if (repository.ahead === null || repository.behind === null) {
    return unavailable('远端差异未知，请先 Fetch 后再检查', 'unknown-divergence');
  }
  if (repository.behind === 0 && repository.ahead === 0) return unavailable('已经是最新状态，无需同步', 'up-to-date');
  const worktreeChanges = worktreeChangeDetail(repository);
  if (worktreeChanges) {
    if (context.allowsAutoStash === false) {
      return unavailable(`工作区有 ${worktreeChanges}，批量同步不自动 Stash，将被跳过`, 'dirty-worktree');
    }
    return { available: true, detail: `工作区有 ${worktreeChanges}，将自动 Stash 后同步（可取消勾选）` };
  }
  return { available: true, detail: '整合远端后自动推送；默认 merge，可勾选 rebase；冲突会暂停处理' };
}

export function batchActionAvailability(
  repository: RepositoryStatus,
  type: BatchOperationType,
): RepositoryActionAvailability {
  // 批量不提供 Auto Stash：工作区脏的仓库在服务端会被跳过，这里的口径必须一致。
  const context: ActionAvailabilityContext = { allowsAutoStash: false };
  if (type === 'fetch') return fetchAvailability(repository);
  if (type === 'pull') return pullAvailability(repository, context);
  return pushAvailability(repository);
}

export function batchEligibleRepositoryCount(
  repositories: RepositoryStatus[],
  type: BatchOperationType,
): number {
  return repositories.filter((repository) => batchActionAvailability(repository, type).available).length;
}

export interface BatchPlanSummary {
  eligible: string[];
  skipped: { name: string; reason: BatchSkipReason; label: string }[];
}

/** 确认框里最多点几个名字；再多就只给数量，否则一行名字能顶掉半屏。 */
const planNameLimit = 4;
/** 跳过项不超过这个数时逐条点名，超过就按原因归类计数。 */
const planDetailSkipLimit = 4;

export function summarizeBatchPlan(
  repositories: RepositoryStatus[],
  type: BatchOperationType,
): BatchPlanSummary {
  const eligible: string[] = [];
  const skipped: BatchPlanSummary['skipped'] = [];
  for (const repository of repositories) {
    const availability = batchActionAvailability(repository, type);
    if (availability.available) {
      eligible.push(repository.config.name);
      continue;
    }
    const reason = availability.reason ?? 'unavailable';
    skipped.push({ name: repository.config.name, reason, label: batchSkipReasonLabels[reason] });
  }
  return { eligible, skipped };
}

function joinPlanNames(names: string[]): string {
  if (names.length <= planNameLimit) return names.join('、');
  return `${names.slice(0, planNameLimit).join('、')} 等 ${names.length} 个`;
}

/**
 * 批量确认框的两行明细：谁会被执行、其余为什么不做。
 *
 * 之前的确认框只有「1 个将执行 · 5 个跳过」这样的数字，用户没法知道动的是哪个仓库，
 * 也看不出剩下 5 个是「已经最新」还是「有本地改动」——后者正是最需要停下来看的。
 * 判定逻辑和批量按钮上的计数共用 `batchActionAvailability`，不会两边口径不一。
 */
export function batchPlanDetails(
  repositories: RepositoryStatus[],
  type: BatchOperationType,
): string[] {
  const { eligible, skipped } = summarizeBatchPlan(repositories, type);
  const lines: string[] = [];
  if (eligible.length > 0) lines.push(`将执行：${joinPlanNames(eligible)}`);
  if (skipped.length === 0) return lines;
  if (skipped.length <= planDetailSkipLimit) {
    lines.push(`跳过：${skipped.map((item) => `${item.name}（${item.label}）`).join('、')}`);
    return lines;
  }
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
  lines.push(`跳过：${ordered.map(([label, count]) => `${label} ×${count}`).join('、')}`);
  return lines;
}
