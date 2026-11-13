import type { BatchPushBranchMode, PushBranchCandidate, PushBranchesPlan } from '../../shared/contracts.js';

/**
 * 把「要推哪些分支」的档位解析成具体分支名。
 *
 * 不按仓库硬编码 main / master：`default` 档读的是远端默认分支（`refs/remotes/<remote>/HEAD`，
 * 无则 main → master 兜底，逻辑在 `pushBranchesPlan` 里），所以同一批次里
 * main 仓和 master 仓各自都能对上。
 */

/** `dev` 档同时认这两个名字：中文团队的集成分支两种写法都很常见。 */
const devBranchNames = ['dev', 'develop'];

export interface BranchSelection {
  /** 选中且真正可推的分支，保持清单原有顺序。 */
  targets: PushBranchCandidate[];
  /** 选中但被挡下的分支；也包含「档位指向的分支不存在」这类整档缺席。 */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * 按档位挑选分支。
 *
 * `plan.blocker` 非空的仓库不该走到这里（调用方先判整仓阻塞），
 * 这里只处理分支级阻塞，避免同一个原因同时出现在两处。
 */
export function selectBranchesForModes(
  plan: Pick<PushBranchesPlan, 'branches' | 'defaultBranch'>,
  modes: BatchPushBranchMode[],
): BranchSelection {
  const selected = new Set<string>();
  // 哪些名字是「档位要的但仓库里没有」，逐个记下来，弹窗才有话可说。
  const missing: Array<{ name: string; reason: string }> = [];
  const byName = new Map(plan.branches.map((branch) => [branch.name, branch]));

  if (modes.includes('current')) {
    const current = plan.branches.find((branch) => branch.current);
    if (current) selected.add(current.name);
    else missing.push({ name: '当前分支', reason: '处于 Detached HEAD，没有当前分支' });
  }
  if (modes.includes('default')) {
    if (plan.defaultBranch) {
      if (byName.has(plan.defaultBranch)) selected.add(plan.defaultBranch);
      else missing.push({ name: plan.defaultBranch, reason: '远端有默认分支，但本地没有同名分支' });
    } else {
      missing.push({ name: '主分支', reason: '读不到远端默认分支（没有 origin/HEAD，也没有可跟踪的 main / master）' });
    }
  }
  if (modes.includes('dev')) {
    const present = devBranchNames.filter((name) => byName.has(name));
    if (present.length > 0) {
      for (const name of present) selected.add(name);
    } else {
      missing.push({ name: 'dev', reason: '仓库没有 dev 或 develop 分支' });
    }
  }

  const targets: PushBranchCandidate[] = [];
  const skipped: Array<{ name: string; reason: string }> = [...missing];
  for (const branch of plan.branches) {
    if (!selected.has(branch.name)) continue;
    if (branch.blocker) skipped.push({ name: branch.name, reason: branch.blocker });
    else targets.push(branch);
  }
  return { targets, skipped };
}

/**
 * 把真正能推的条目排到前面，两组内部各自保持原有顺序。
 *
 * 只影响预览清单的展示顺序：单仓弹窗的分支列表、批量弹窗的仓库列表都可能几十行，
 * 按原顺序（分支名字母序 / 仓库配置顺序）把「没什么可推」的混在中间时，能点的那几行
 * 得先滚动才找得到。执行顺序、勾选状态和结果列表都不依赖这里的顺序。
 *
 * `Array.prototype.sort` 自 ES2019 起保证稳定，同组内不会被打乱。
 */
export function pushableFirst<T>(items: readonly T[], isPushable: (item: T) => boolean): T[] {
  return [...items].sort((left, right) => Number(isPushable(right)) - Number(isPushable(left)));
}

/** 一个仓库里选不出任何可推分支时写给用户看的那句话。 */
export function selectionSkipMessage(selection: BranchSelection): string {
  if (selection.skipped.length === 0) return '没有需要推送的分支';
  const reasons = selection.skipped.map((item) => (item.name === item.reason ? item.name : `${item.name}：${item.reason}`));
  return `已跳过（${reasons.join('；')}）`;
}
