import type {
  BatchMergeRepositoryPlan,
  BranchesSnapshot,
  LocalBranch,
  MergeBranchesResult,
  MergedIntoLineResult,
  MergeIntoLinePreview,
  RepositoriesConfig,
  RepositoryConfig,
} from '../../shared/contracts.js';
import { maxMergeSourceSelection, mergePausedErrorCode } from '../../shared/contracts.js';
import { safetyBlockedError } from '../errors.js';
import { listBranches } from './branches.js';
import { mergeBranch } from './merge.js';
import { remoteDefaultBranch } from './push-branches.js';
import { runGit, runGitText } from './runner.js';
import { scanRepository } from './scanner.js';

/**
 * 双线合并：把仓库里所有非双线分支合回 dev（或 develop）与主分支（main / master）。
 *
 * 三个前提决定了这里的写法：
 *
 * 1. **合并必须在目标分支上进行**，所以要切分支。切分支的前提是工作区干净——脏工作区
 *    整仓不参与，绝不替用户 stash：批量里自动 stash 几十个仓库，出问题时没法逐个解释。
 * 2. **冲突必须就地停下**。合并冲突后仓库停在目标线上（`MERGE_HEAD` 存在），此时既不能
 *    继续合下一条线，也不能切回原分支。所以冲突是「这一仓到此为止」，而不是跳过继续。
 * 3. **合的是用户看到的那一版**。预检记录每个源分支的 head，执行时逐个复核；分支在
 *    窗口打开后又长出新提交，就跳过那条，不顺手带上去。
 *
 * 目标线只看**本地分支**：没有本地 dev / main 就整仓跳过并说明，不自动建跟踪分支——
 * 建分支是另一件事，不该藏在「合并」按钮后面。
 */

/** dev 线的候选名，按优先级排列。 */
const devLineNames = ['dev', 'develop'] as const;
/** 主分支的兜底名；真正的首选是远端默认分支。 */
const mainLineNames = ['main', 'master'] as const;

function isWorkspaceDirty(status: { changedFiles: number; untracked: number; conflicted: number }): boolean {
  return status.changedFiles > 0 || status.untracked > 0 || status.conflicted > 0;
}

/**
 * 解析目标线：dev 线在前、主分支在后。
 *
 * 主分支优先认远端默认分支（`refs/remotes/<remote>/HEAD`），读不到才回落到 main → master。
 * 两段都只从**本地已有分支**里挑：本地没有的那条线不会凭空出现。
 */
async function resolveTargetLines(
  cwd: string,
  branches: LocalBranch[],
  defaultRemote: string,
): Promise<string[]> {
  const names = new Set(branches.map((branch) => branch.name));
  const lines: string[] = [];
  const dev = devLineNames.find((name) => names.has(name));
  if (dev) lines.push(dev);
  let preferred: string | null;
  try {
    preferred = await remoteDefaultBranch(cwd, defaultRemote);
  } catch {
    // remote 名非法或读不到 remote HEAD：直接走 main → master 兜底。
    preferred = null;
  }
  const main = [preferred, ...mainLineNames]
    .filter((name): name is string => Boolean(name))
    .find((name) => names.has(name) && !lines.includes(name));
  if (main) lines.push(main);
  return lines;
}

/** `git branch --merged <target>` 的结果：已经包含在目标线里的本地分支。 */
async function branchesMergedInto(cwd: string, target: string): Promise<Set<string>> {
  const output = await runGitText(cwd, ['branch', '--merged', `refs/heads/${target}`, '--format=%(refname:short)']);
  return new Set(output.split('\n').map((line) => line.trim()).filter(Boolean));
}

/**
 * 预判一条源分支合进一条目标线会是什么形态。
 *
 * `up-to-date` 由调用方用 `branchesMergedInto` 批量判掉，这里只处理真正要动的两种：
 * 目标线是源分支的祖先就是快进，否则产生合并提交。
 */
async function previewIntoLine(
  cwd: string,
  sourceHead: string,
  target: string,
): Promise<{ preview: MergeIntoLinePreview | null; blocker: string | null }> {
  const common = await runGit(cwd, ['merge-base', `refs/heads/${target}`, sourceHead]);
  if (common.exitCode !== 0) return { preview: null, blocker: `与 ${target} 没有共同历史，不能合并` };
  const targetHead = await runGitText(cwd, ['rev-parse', '--verify', `refs/heads/${target}`]);
  const forward = await runGit(cwd, ['merge-base', '--is-ancestor', targetHead, sourceHead]);
  if (forward.exitCode > 1) return { preview: null, blocker: '无法读取分支提交关系' };
  const count = Number(await runGitText(cwd, ['rev-list', '--count', `${targetHead}..${sourceHead}`]).catch(() => '0'));
  return {
    preview: {
      target,
      kind: forward.exitCode === 0 ? 'fast-forward' : 'merge-commit',
      incomingCommits: Number.isFinite(count) ? count : 0,
    },
    blocker: null,
  };
}

function emptyPlan(
  repository: RepositoryConfig,
  status: { branch: string | null },
  blocker: string,
): BatchMergeRepositoryPlan {
  return {
    repositoryId: repository.id,
    repositoryName: repository.name,
    blocker,
    currentBranch: status.branch,
    targets: [],
    sources: [],
    excluded: [],
    mergedBranches: [],
    worktreeDirty: false,
    cleanupBlockedReason: null,
    pendingMerges: 0,
  };
}

/**
 * 单仓预检。
 *
 * 结果里 `up-to-date` 的线仍然保留：弹窗要能回答「为什么这个分支合过去什么也没发生」，
 * 只留能动的那些反而让人以为漏了分支。
 */
export async function mergeBranchesPlan(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
): Promise<BatchMergeRepositoryPlan> {
  const status = await scanRepository(config, repository);
  if (!status.available) return emptyPlan(repository, status, '仓库不可用');
  if (status.detached) return emptyPlan(repository, status, 'Detached HEAD 没有可合并的分支');
  if (status.conflicted > 0 || status.inProgressOperation) {
    return emptyPlan(repository, status, '仓库存在冲突或进行中的 Git 操作');
  }
  // 工作区脏不再整仓挡掉：合并要切分支（不能带脏改动），但「删除已完全合进各条线的分支」
  // 不碰工作区，非当前分支照样能清理。这里继续算 mergedBranches，拿不到合并的源就标阻塞。
  const dirty = isWorkspaceDirty(status);

  const cwd = status.absolutePath;
  const snapshot: BranchesSnapshot = await listBranches(cwd);
  const targets = await resolveTargetLines(cwd, snapshot.branches, config.settings.defaultRemote);
  if (targets.length === 0) {
    return emptyPlan(repository, status, '本机没有 dev（develop）或 main（master）分支');
  }
  // 目标线被别的 worktree 占用时无法 checkout。当前分支的 worktreePath 就是本仓，
  // 所以「有 worktreePath 且不是当前分支」才是真的被别处占用。
  const occupied = targets.filter((name) => {
    const branch = snapshot.branches.find((item) => item.name === name);
    return Boolean(branch?.worktreePath) && !branch?.current;
  });
  if (occupied.length > 0) {
    return emptyPlan(repository, status, `${occupied.join('、')} 已在其他 worktree 检出，无法切换`);
  }

  const lineNames = new Set<string>([...devLineNames, ...mainLineNames, ...targets]);
  const candidates = snapshot.branches.filter((branch) => !lineNames.has(branch.name));
  if (candidates.length > maxMergeSourceSelection) {
    return emptyPlan(
      repository,
      status,
      `非双线分支有 ${candidates.length} 个，超过一次合并上限 ${maxMergeSourceSelection} 个，请先清理分支`,
    );
  }

  const mergedByTarget = new Map<string, Set<string>>();
  for (const target of targets) mergedByTarget.set(target, await branchesMergedInto(cwd, target));

  const sources: BatchMergeRepositoryPlan['sources'] = [];
  const mergedBranches: string[] = [];
  let cleanupBlockedReason: string | null = null;
  let pendingMerges = 0;
  for (const branch of candidates) {
    // 每条目标线都已包含它：没有可合并内容，但可以清理（勾选清理时删除）。
    const fullyMerged = targets.every((target) => mergedByTarget.get(target)?.has(branch.name));
    if (fullyMerged) {
      // 脏工作区下「当前分支」不能安全切走再删（会把未提交改动挪到别的分支），单独说明。
      if (dirty && branch.name === snapshot.currentBranch) {
        cleanupBlockedReason = `当前分支 ${branch.name} 已合并，但工作区有未提交改动，先提交或收起后再清理`;
      } else {
        mergedBranches.push(branch.name);
      }
      continue;
    }
    if (dirty) {
      // 脏工作区不能合并（要切分支会带脏改动）；作为被挡下的源分支列出，说清原因。
      sources.push({ name: branch.name, head: branch.head, merges: [], blocker: '工作区有未提交改动，先提交或收起后再合并' });
      continue;
    }
    const merges: MergeIntoLinePreview[] = [];
    let blocker: string | null = null;
    for (const target of targets) {
      const outcome = await previewIntoLine(cwd, branch.head, target);
      if (!outcome.preview) {
        blocker = outcome.blocker;
        break;
      }
      merges.push(outcome.preview);
      pendingMerges += 1;
    }
    if (blocker) {
      // 一条线合不了就整条源分支不参与：另一半合了过去、这一半失败，用户会得到
      // 一个「dev 有、main 没有」的半成品状态，比整条跳过更难收拾。
      pendingMerges -= merges.filter((merge) => merge.kind !== 'up-to-date').length;
      sources.push({ name: branch.name, head: branch.head, merges: [], blocker });
      continue;
    }
    sources.push({ name: branch.name, head: branch.head, merges, blocker: null });
  }

  return {
    repositoryId: repository.id,
    repositoryName: repository.name,
    blocker: null,
    currentBranch: snapshot.currentBranch,
    targets,
    sources,
    excluded: snapshot.branches.filter((branch) => lineNames.has(branch.name)).map((branch) => branch.name),
    mergedBranches,
    worktreeDirty: dirty,
    cleanupBlockedReason,
    pendingMerges,
  };
}

/** 把一条合并结果转成人话；结果列表里每行都有状态标签，这里只说发生了什么。 */
function describeMerged(state: MergedIntoLineResult['state'], source: string, target: string, incoming: number): string {
  if (state === 'fast-forward') return `${target} 快进到 ${source}（${incoming} 个提交）`;
  if (state === 'merged') return `${target} 生成合并提交（${incoming} 个提交）`;
  if (state === 'up-to-date') return `${target} 已包含 ${source}`;
  return `${target} 未合并 ${source}`;
}

async function currentBranchName(cwd: string): Promise<string | null> {
  const name = await runGitText(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  return name || null;
}

/**
 * 合并成功后清理「已完全合进所有目标线」的非双线本地分支（可选项）。
 *
 * 只删**已经合并过去**的：对每条候选分支用 `merge-base --is-ancestor` 逐条目标线复核，
 * 只要有一条线还没包含它，就保留——否则会把还没合到另一条线的成果删掉。
 *
 * 复核通过后一律用 `branch -D`：此时分支的每个提交都已在每一条目标线上可达，强制删除
 * 不会丢任何提交；反而 `-d` 会被「上游 / 当前 HEAD」的判定误拦（比如上游还没 fetch 到）。
 *
 * 若当前正检出某条待删分支，先切到第一条存在的目标线（删不掉检出中的分支），
 * 调用方据此更新「合并结束后停在哪」。
 */
async function cleanupMergedBranches(
  cwd: string,
  targets: string[],
  dirty: boolean,
): Promise<{ deleted: string[]; skipped: Array<{ name: string; reason: string }>; landedOn: string | null; switchedAway: boolean }> {
  const snapshot = await listBranches(cwd, { divergence: false });
  const lineNames = new Set<string>([...devLineNames, ...mainLineNames, ...targets]);
  const current = snapshot.currentBranch;
  const deleted: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let landedOn = current;
  let switchedAway = false;

  // 先算出「所有目标线都包含它」的候选；不合条件的一律保留并说明。
  const deletable: string[] = [];
  for (const branch of snapshot.branches) {
    if (lineNames.has(branch.name)) continue;
    if (dirty && branch.name === current) {
      // 脏工作区下切不走当前分支；强行切会把未提交改动挪到别的分支，必须拒绝。
      skipped.push({ name: branch.name, reason: '当前分支有未提交改动，先提交或收起后再清理' });
      continue;
    }
    if (branch.worktreePath && !branch.current) {
      skipped.push({ name: branch.name, reason: '已在其他 worktree 检出' });
      continue;
    }
    let mergedIntoAll = true;
    for (const target of targets) {
      const check = await runGit(cwd, ['merge-base', '--is-ancestor', `refs/heads/${branch.name}`, `refs/heads/${target}`]);
      if (check.exitCode !== 0) {
        mergedIntoAll = false;
        break;
      }
    }
    if (mergedIntoAll) deletable.push(branch.name);
    else skipped.push({ name: branch.name, reason: '尚未完全合进所有目标线' });
  }
  if (deletable.length === 0) return { deleted, skipped, landedOn: current, switchedAway };

  // 当前检出的分支删不掉：先切到主分支（main / master）再删；没有主分支才退到第一条目标线。
  if (current && deletable.includes(current)) {
    const exists = (name: string): boolean => snapshot.branches.some((branch) => branch.name === name);
    const landing = targets.find((target) => (mainLineNames as readonly string[]).includes(target) && exists(target))
      ?? targets.find((target) => exists(target));
    if (!landing) {
      return {
        deleted,
        skipped: [...skipped, { name: current, reason: '它是当前分支，且没有可切换的目标线' }],
        landedOn: current,
        switchedAway,
      };
    }
    const switched = await runGit(cwd, ['switch', '--quiet', landing], 60_000);
    if (switched.exitCode !== 0) {
      return {
        deleted,
        skipped: [...skipped, { name: current, reason: `当前分支切不走：${switched.stderr || switched.exitCode}` }],
        landedOn: current,
        switchedAway,
      };
    }
    landedOn = landing;
    switchedAway = true;
  }

  for (const name of deletable) {
    // landedOn 一定是目标线、不在 deletable 里，这里只是防御。
    if (name === landedOn) continue;
    const result = await runGit(cwd, ['branch', '-D', name]);
    if (result.exitCode === 0) deleted.push(name);
    else skipped.push({ name, reason: result.stderr.trim() || '删除失败' });
  }
  return { deleted, skipped, landedOn, switchedAway };
}

/**
 * 执行双线合并。
 *
 * 顺序上先切到目标线、把它的所有源分支依次合完，再切下一条线：同一条线上的多次合并
 * 天然线性，跨线切换次数降到最少（每条线一次）。
 */
export async function mergeBranchesIntoLines(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { sources: Array<{ name: string; head: string }>; targets: string[]; deleteMergedBranches?: boolean },
): Promise<MergeBranchesResult> {
  const status = await scanRepository(config, repository);
  if (!status.available) throw safetyBlockedError('仓库不可用');
  if (status.detached) throw safetyBlockedError('Detached HEAD 不能合并分支');
  if (status.conflicted > 0 || status.inProgressOperation) {
    throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  }
  const dirty = isWorkspaceDirty(status);
  // 脏工作区不能做「合并」（要切分支会带走未提交改动）；但只做清理（sources 为空 + 删分支）允许。
  if (dirty && input.sources.length > 0) {
    throw safetyBlockedError('工作区有未提交改动，先提交或收起后再合并');
  }

  const originalBranch = await currentBranchName(cwd);
  if (!originalBranch) throw safetyBlockedError('当前不在任何分支上');
  // 允许站在目标线上发起（「活干完了，我人在 dev 上顺手合一版」）：源分支清单本来就
  // 排除了双线，不存在自我合并；切到 dev 是 no-op，最后也会切回这里。

  const snapshot = await listBranches(cwd);
  const byName = new Map(snapshot.branches.map((branch) => [branch.name, branch]));
  const results: MergedIntoLineResult[] = [];
  const restore = async (): Promise<string | null> => {
    const switched = await runGit(cwd, ['switch', '--quiet', originalBranch], 60_000);
    return switched.exitCode === 0 ? originalBranch : null;
  };

  try {
    // 没有源分支（只做清理）时不要遍历目标线：脏工作区下切分支会带走改动。
    for (const target of input.sources.length > 0 ? input.targets : []) {
      if (!byName.has(target)) {
        for (const source of input.sources) {
          results.push({ source: source.name, target, state: 'skipped', message: `目标线 ${target} 已不存在` });
        }
        continue;
      }
      if ((await currentBranchName(cwd)) !== target) {
        const switched = await runGit(cwd, ['switch', '--quiet', target], 60_000);
        if (switched.exitCode !== 0) {
          throw safetyBlockedError(`切换到 ${target} 失败：${switched.stderr || switched.exitCode}`);
        }
      }
      for (const source of input.sources) {
        const head = await runGitText(cwd, ['rev-parse', '--verify', `refs/heads/${source.name}`]).catch(() => '');
        if (!head) {
          results.push({ source: source.name, target, state: 'skipped', message: '分支已不存在' });
          continue;
        }
        if (head !== source.head) {
          results.push({
            source: source.name,
            target,
            state: 'skipped',
            message: '分支在预览后已变化，请重新打开后重试',
          });
          continue;
        }
        const targetHead = await runGitText(cwd, ['rev-parse', '--verify', 'HEAD']);
        try {
          const outcome = await mergeBranch(cwd, {
            source: { kind: 'local', name: source.name },
            expectedBranch: target,
            expectedHead: targetHead,
            expectedSourceHead: head,
            noFastForward: false,
            stashFirst: false,
            stashIncludeUntracked: false,
          });
          if (outcome.skipped) {
            results.push({ source: source.name, target, state: 'up-to-date', message: `${target} 已包含 ${source.name}` });
            continue;
          }
          const after = await runGitText(cwd, ['rev-parse', '--verify', 'HEAD']);
          const state: MergedIntoLineResult['state'] = after === head ? 'fast-forward' : 'merged';
          const incoming = Number(
            await runGitText(cwd, ['rev-list', '--count', `${targetHead}..${after}`]).catch(() => '1') || '1',
          );
          results.push({
            source: source.name,
            target,
            state,
            message: describeMerged(state, source.name, target, Number.isFinite(incoming) ? incoming : 1),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '合并失败';
          const paused = (error as { code?: string }).code === mergePausedErrorCode || message.includes('合并已暂停');
          results.push({
            source: source.name,
            target,
            state: paused ? 'conflict' : 'failed',
            message: paused
              ? `${target} 合并 ${source.name} 时冲突，仓库已停在该分支，请处理后继续`
              : message,
          });
          if (paused) {
            // 冲突时仓库处于 merge 中途：既不能继续合下一条线，也不能切回原分支。
            return {
              merges: results,
              restoredBranch: null,
              deletedBranches: [],
              deleteSkipped: [],
              status: await scanRepository(config, repository),
              summary: summarize(results, null, originalBranch),
            };
          }
        }
      }
    }
  } catch (error) {
    // 非冲突错误（切分支失败等）：能切回就切回，再如实抛出，批量层记 failed。
    await restore();
    throw error;
  }

  let restored = await restore();
  let deletedBranches: string[] = [];
  let deleteSkipped: Array<{ name: string; reason: string }> = [];
  if (input.deleteMergedBranches) {
    const cleanup = await cleanupMergedBranches(cwd, input.targets, dirty);
    deletedBranches = cleanup.deleted;
    deleteSkipped = cleanup.skipped;
    // 原分支被清理时，结束时停在切过去的目标线上（而不是一个已经不存在的分支）。
    if (originalBranch && cleanup.deleted.includes(originalBranch)) restored = cleanup.landedOn;
    else if (cleanup.switchedAway) restored = cleanup.landedOn;
  }
  const finalStatus = await scanRepository(config, repository);
  return {
    merges: results,
    restoredBranch: restored,
    deletedBranches,
    deleteSkipped,
    status: finalStatus,
    summary: summarize(results, restored, originalBranch, deletedBranches),
  };
}

function summarize(
  merges: MergedIntoLineResult[],
  restoredBranch: string | null,
  originalBranch: string,
  deletedBranches: string[] = [],
): string {
  const conflicts = merges.filter((merge) => merge.state === 'conflict');
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    return `合并暂停在 ${first.target}（${first.source} 冲突），请在工作区处理后继续`;
  }
  const failed = merges.filter((merge) => merge.state === 'failed');
  const merged = merges.filter((merge) => merge.state === 'merged' || merge.state === 'fast-forward');
  const skipped = merges.filter((merge) => merge.state === 'up-to-date');
  const parts: string[] = [];
  if (merged.length > 0) parts.push(`${merged.length} 条合并已完成`);
  if (skipped.length > 0) parts.push(`${skipped.length} 条已是最新`);
  if (failed.length > 0) parts.push(`${failed[0]!.target} 合并 ${failed[0]!.source} 失败：${failed[0]!.message}`);
  if (parts.length === 0) parts.push('没有需要合并的分支');
  if (deletedBranches.length > 0) parts.push(`已删除 ${deletedBranches.length} 条已合并分支`);
  if (restoredBranch) parts.push(`已切回 ${restoredBranch}`);
  else parts.push(`未能切回 ${originalBranch}，请检查当前分支`);
  return parts.join('；');
}
