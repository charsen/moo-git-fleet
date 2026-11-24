import type {
  BatchPullBranchMode,
  BatchPullBranchPlanItem,
  BatchPullBranchRepositoryPlan,
  LocalBranch,
  PullBranchesResult,
  PulledBranchResult,
  RepositoriesConfig,
  RepositoryConfig,
} from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { safetyBlockedError } from '../errors.js';
import { pullRepository } from './actions.js';
import { listBranches } from './branches.js';
import { remoteDefaultBranch } from './push-branches.js';
import { readRemoteNames } from './remotes.js';
import { runGit, runGitText } from './runner.js';
import { scanRepository } from './scanner.js';

/**
 * 多分支 Pull：一次把当前分支、dev、主分支都从远端更新下来。
 *
 * 和「双线合并」最大的区别是**不切分支**：
 *
 * - 当前分支走 `git pull` 那条老路（Fetch + 按仓库设置 merge / rebase），因为它本来就在
 *   工作区里，合并冲突也能当场处理；
 * - 其他分支只做 `git fetch <remote> <branch>:<branch>`：直接更新本地 ref，不碰工作区。
 *   git 只允许快进，本地有远端没有的提交时会自己拒绝——这正是我们要的语义，不需要
 *   自己写一遍祖先判断再 --force。
 *
 * 代价是「非当前分支」只能快进：分叉时必须用户自己处理。这是刻意的——批量里替几十个
 * 仓库决定「怎么合」比不更新更危险。
 */

const devBranchNames = ['dev', 'develop'] as const;
const mainBranchNames = ['main', 'master'] as const;

function isWorkspaceDirty(status: { changedFiles: number; untracked: number; conflicted: number }): boolean {
  return status.changedFiles > 0 || status.untracked > 0 || status.conflicted > 0;
}

/** 远端默认分支读不到时，退回落本地已有的 main / master。 */
async function defaultBranchName(
  cwd: string,
  remote: string,
  branches: LocalBranch[],
): Promise<string | null> {
  let preferred: string | null = null;
  try {
    preferred = await remoteDefaultBranch(cwd, remote);
  } catch {
    preferred = null;
  }
  if (preferred && branches.some((branch) => branch.name === preferred)) return preferred;
  const local = mainBranchNames.find((name) => branches.some((branch) => branch.name === name));
  return local ?? preferred;
}

/**
 * 分支实际对齐的远端 ref。
 *
 * 不能一律拼 `<remote>/<branch.name>`：远端把 master 改名成 main 后，本地 master
 * 的 upstream 往往是 `origin/main`，按同名去找会得到「远端没有 origin/master」，
 * 于是明明落后几十个提交的分支被算成 0，弹窗里就一个可拉项都列不出来。
 *
 * 当前分支允许 upstream 指向别的 remote（单仓 Pull 本来就按 upstream 走）；非当前
 * 分支只认当前远端，因为执行时只用 `defaultRemote` 做 ref 快进。
 */
function trackedRemoteRef(branch: LocalBranch, remote: string, allowForeignRemote: boolean): string {
  const prefix = `${remote}/`;
  if (branch.upstream && branch.upstream.startsWith(prefix) && branch.upstream.length > prefix.length) {
    return branch.upstream;
  }
  if (allowForeignRemote && branch.upstream) return branch.upstream;
  return `${remote}/${branch.name}`;
}

/** 按档位挑出要拉的分支名；同一条分支被多个档位选中只算一次。 */
function pickBranchNames(
  branches: LocalBranch[],
  currentBranch: string | null,
  modes: BatchPullBranchMode[],
  defaultName: string | null,
  remote: string,
): { names: string[]; skipped: Array<{ name: string; reason: string }> } {
  const names: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  if (modes.includes('current')) {
    if (currentBranch) add(currentBranch);
    else skipped.push({ name: '当前分支', reason: '处于 Detached HEAD，没有当前分支' });
  }
  if (modes.includes('default')) {
    if (!defaultName) {
      skipped.push({ name: '主分支', reason: '读不到远端默认分支（没有 origin/HEAD，本地也没有 main / master）' });
    } else if (branches.some((branch) => branch.name === defaultName)) {
      add(defaultName);
    } else {
      // 本地主分支可能叫 master，但跟踪的是远端 main：这也是「主分支」，不能因为
      // 本地没有同名分支就跳过（否则改名过的仓库永远拉不到主分支）。
      const tracking = branches.filter((branch) => branch.upstream === `${remote}/${defaultName}`);
      if (tracking.length > 0) tracking.forEach((branch) => add(branch.name));
      else skipped.push({ name: '主分支', reason: `本地没有 ${defaultName}，也没有分支跟踪 ${remote}/${defaultName}` });
    }
  }
  if (modes.includes('dev')) {
    const present = devBranchNames.filter((name) => branches.some((branch) => branch.name === name));
    if (present.length > 0) present.forEach(add);
    else skipped.push({ name: 'dev', reason: '本地没有 dev 或 develop 分支' });
  }
  return { names, skipped };
}

/**
 * 一条本地分支相对它实际跟踪的远端 ref 的领先 / 落后。
 * 远端没有这个 ref 时两者都是 0，交给调用方标阻塞。
 */
async function divergenceFromRemote(
  cwd: string,
  name: string,
  remoteRef: string,
): Promise<{ behind: number; ahead: number; remoteHead: string | null }> {
  const remoteHead = await runGitText(cwd, ['rev-parse', '--verify', `refs/remotes/${remoteRef}^{commit}`]).catch(() => '');
  if (!remoteHead) return { behind: 0, ahead: 0, remoteHead: null };
  const count = async (range: string): Promise<number> => {
    const value = await runGitText(cwd, ['rev-list', '--count', range]).catch(() => '0');
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    behind: await count(`refs/heads/${name}..refs/remotes/${remoteRef}`),
    ahead: await count(`refs/remotes/${remoteRef}..refs/heads/${name}`),
    remoteHead,
  };
}

async function evaluateBranch(
  cwd: string,
  remote: string,
  branch: LocalBranch,
  isCurrent: boolean,
  dirty: boolean,
): Promise<BatchPullBranchPlanItem> {
  const remoteRef = trackedRemoteRef(branch, remote, isCurrent);
  const { behind, ahead, remoteHead } = await divergenceFromRemote(cwd, branch.name, remoteRef);
  const base: BatchPullBranchPlanItem = {
    name: branch.name,
    strategy: isCurrent ? 'pull' : 'fast-forward',
    behind,
    ahead,
    // 非当前分支靠 fetch 的快进保护，失败原因在执行时才具体；能提前判的只有这几条。
    blocker: null,
  };
  if (!remoteHead) return { ...base, blocker: `远端没有 ${remoteRef}` };
  if (isCurrent) {
    // 当前分支要切回「单仓 Pull」那条路：它按 upstream 找远端，且不能在工作区有改动时合并。
    if (!branch.upstream) return { ...base, blocker: `当前分支没有 upstream，先用单仓 Pull 建立跟踪` };
    if (dirty) return { ...base, blocker: '工作区有未提交改动，先提交或收起后再拉取' };
    return base;
  }
  if (branch.worktreePath) return { ...base, blocker: `已在其他 worktree 检出（${branch.worktreePath}）` };
  if (ahead > 0 && behind > 0) return { ...base, blocker: '本地与远端已分叉，需手动处理' };
  return base;
}

/**
 * 单仓预检。
 *
 * 远端状态取本机已有的远端跟踪 ref：优先该分支的 upstream（本地 master 跟踪
 * origin/main 时也能算对），没有才退回 `<remote>/<同名分支>`。不单独打网络：
 * 批量范围几十个仓库时，预检多一轮 Fetch 会让弹窗空转十几秒。执行时会重新
 * Fetch，所以预览只会偏保守。
 */
export async function pullBranchesPlan(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  modes: BatchPullBranchMode[],
): Promise<BatchPullBranchRepositoryPlan> {
  const status = await scanRepository(config, repository);
  const empty = (blocker: string): BatchPullBranchRepositoryPlan => ({
    repositoryId: repository.id,
    repositoryName: repository.name,
    blocker,
    currentBranch: status.branch,
    branches: [],
    skipped: [],
    pending: 0,
  });

  if (!status.available) return empty('仓库不可用');
  if (status.conflicted > 0 || status.inProgressOperation) return empty('仓库存在冲突或进行中的 Git 操作');
  if (!repository.capabilities.fetch) return empty('仓库配置禁止 fetch 操作');

  const cwd = status.absolutePath;
  const remote = config.settings.defaultRemote;
  const remotes = await readRemoteNames(cwd);
  if (!remotes.includes(remote)) return empty(`仓库没有配置 ${remote} 远端`);

  const snapshot = await listBranches(cwd, { divergence: false });
  const defaultName = await defaultBranchName(cwd, remote, snapshot.branches);
  const { names, skipped } = pickBranchNames(snapshot.branches, snapshot.currentBranch, modes, defaultName, remote);
  if (names.length === 0) {
    return {
      repositoryId: repository.id,
      repositoryName: repository.name,
      blocker: null,
      currentBranch: snapshot.currentBranch,
      branches: [],
      skipped,
      pending: 0,
    };
  }

  const dirty = isWorkspaceDirty(status);
  const items: BatchPullBranchPlanItem[] = [];
  for (const name of names) {
    const branch = snapshot.branches.find((item) => item.name === name);
    if (!branch) {
      // 远端默认分支在本地不存在时不替用户建分支：建分支是另一件事，藏在「拉取」后面
      // 会让人某天发现本地凭空多了一条 main。
      skipped.push({ name, reason: '本地没有这条分支' });
      continue;
    }
    items.push(await evaluateBranch(cwd, remote, branch, name === snapshot.currentBranch, dirty));
  }

  return {
    repositoryId: repository.id,
    repositoryName: repository.name,
    blocker: null,
    currentBranch: snapshot.currentBranch,
    branches: items,
    skipped,
    pending: items.filter((item) => item.blocker === null && item.behind > 0).length,
  };
}

/** 把 fetch 的报错翻译成用户能照着做的一句话。 */
function explainFetchFailure(name: string, stderr: string, remoteBranch = name): string {
  const text = stderr.trim();
  if (/non-fast-forward|rejected/i.test(text)) return `${name} 有远端没有的提交，与远端分叉，需手动处理`;
  if (/refusing to fetch into branch/i.test(text)) return `${name} 已在其他 worktree 检出，无法更新`;
  // 找的是远端 ref，说的是远端分支名：master 跟踪 origin/main 时不能报「远端没有 master」。
  if (/couldn't find remote ref|not found/i.test(text)) return `远端没有 ${remoteBranch} 分支`;
  return text || `${name} 更新失败`;
}

/**
 * 执行多分支 Pull。
 *
 * 先更新非当前分支（不碰工作区），最后再拉当前分支：当前分支一旦冲突，仓库会停在
 * merge / rebase 中途，此时其余分支也拉不动了，所以把最容易出事的那一步放在最后。
 */
export async function pullBranches(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { branches: string[]; ffOnly?: boolean; rebase?: boolean },
): Promise<PullBranchesResult> {
  const status = await scanRepository(config, repository);
  if (!status.available) throw safetyBlockedError('仓库不可用');
  if (status.conflicted > 0 || status.inProgressOperation) {
    throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  }

  const remote = config.settings.defaultRemote;
  if (!(await readRemoteNames(cwd)).includes(remote)) {
    throw safetyBlockedError(`仓库没有配置 ${remote} 远端`);
  }

  const snapshot = await listBranches(cwd, { divergence: false });
  const current = snapshot.currentBranch;
  const known = new Set(snapshot.branches.map((branch) => branch.name));
  const results: PulledBranchResult[] = [];
  const ordered = [
    ...input.branches.filter((name) => name !== current),
    ...input.branches.filter((name) => name === current),
  ];

  for (const name of ordered) {
    if (!known.has(name)) {
      results.push({ name, strategy: 'fast-forward', state: 'skipped', behind: null, message: '本地没有这条分支' });
      continue;
    }
    if (name !== current) {
      // 远端分支名不一定等于本地分支名（master 跟踪 origin/main 的仓库很常见）。
      // 预检按 upstream 算落后数，执行也必须拉到同一个 ref，否则会出现「弹窗说落后
      // 62 个提交、执行时却报远端没有这条分支」。
      const branch = snapshot.branches.find((item) => item.name === name);
      const trackedRef = branch ? trackedRemoteRef(branch, remote, false) : `${remote}/${name}`;
      const remoteBranch = trackedRef.startsWith(`${remote}/`) ? trackedRef.slice(remote.length + 1) : name;
      const before = await runGitText(cwd, ['rev-parse', '--verify', `refs/heads/${name}`]);
      const fetched = await runGit(
        cwd,
        ['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${name}`],
        300_000,
      );
      if (fetched.exitCode !== 0) {
        results.push({
          name,
          strategy: 'fast-forward',
          state: 'failed',
          behind: null,
          message: explainFetchFailure(name, fetched.stderr, remoteBranch),
        });
        continue;
      }
      const after = await runGitText(cwd, ['rev-parse', '--verify', `refs/heads/${name}`]);
      if (after === before) {
        results.push({ name, strategy: 'fast-forward', state: 'up-to-date', behind: 0, message: `${name} 已是最新` });
        continue;
      }
      const incoming = Number(await runGitText(cwd, ['rev-list', '--count', `${before}..${after}`]).catch(() => '1'));
      results.push({
        name,
        strategy: 'fast-forward',
        state: 'pulled',
        behind: Number.isFinite(incoming) ? incoming : null,
        message: `${name} 快进 ${Number.isFinite(incoming) ? incoming : ''} 个提交`.replace('  ', ' '),
      });
      continue;
    }

    // 当前分支：走单仓 Pull 那条路（含仓库自己的 merge / rebase 设置与安全复核）。
    try {
      const pulled = await pullRepository(config, repository, cwd, {
        ffOnly: input.ffOnly === true,
        rebase: input.rebase === true,
      });
      results.push({
        name,
        strategy: 'pull',
        state: pulled.skipped ? 'up-to-date' : 'pulled',
        behind: pulled.skipped ? 0 : null,
        message: pulled.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '当前分支拉取失败';
      const paused = (error as { code?: string }).code === mergePausedErrorCode || message.includes('合并已暂停') || message.includes('已暂停');
      results.push({ name, strategy: 'pull', state: 'failed', behind: null, message });
      // 冲突后仓库处于 merge / rebase 中途，后面的分支不能再动。
      if (paused) break;
    }
  }

  const finalStatus = await scanRepository(config, repository);
  return { branches: results, status: finalStatus, summary: summarizePull(results) };
}

function summarizePull(results: PulledBranchResult[]): string {
  const pulled = results.filter((result) => result.state === 'pulled');
  const upToDate = results.filter((result) => result.state === 'up-to-date');
  const failed = results.filter((result) => result.state === 'failed' || result.state === 'skipped');
  const parts: string[] = [];
  if (pulled.length > 0) parts.push(`${pulled.map((result) => result.name).join('、')} 已更新`);
  if (upToDate.length > 0) parts.push(`${upToDate.length} 条已是最新`);
  if (failed.length > 0) parts.push(failed.map((result) => `${result.name}：${result.message}`).join('；'));
  if (parts.length === 0) parts.push('没有需要拉取的分支');
  return parts.join('；');
}
