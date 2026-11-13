import type {
  PushedBranchResult,
  PushBranchCandidate,
  PushBranchesPlan,
  PushBranchesRequest,
  PushBranchesResult,
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
} from '../../shared/contracts.js';
import { safetyBlockedError } from '../errors.js';
import { listBranches } from './branches.js';
import { ensureRemoteName } from './guards.js';
import { pushableFirst } from './push-branch-selection.js';
import { runGit, runGitText } from './runner.js';
import { scanRepository } from './scanner.js';

/**
 * 一个仓库里一次推送多个分支（典型场景 dev + main / dev + master）。
 *
 * 与 `pushRepository` 的区别只在「推哪些 ref」：那条路径写死当前 HEAD 与它的 upstream，
 * 这里允许一次带上多个分支。**永不 force**，每个 refspec 都用客户端看到的那个 commit
 * 作为推送源，并且任一分支被拒不影响其他分支（刻意不加 `--atomic`）。
 */

/** `git push --porcelain` 的一行；`flag` 是行首那一个字符。 */
export interface PushPorcelainEntry {
  /** ` `=快进、`*`=新建、`=`=已最新、`!`=被拒、`+`=强制更新（本应用永不产生）。 */
  flag: string;
  /** 推送目的 ref，如 `refs/heads/dev`。 */
  destination: string;
  /** `[rejected] (non-fast-forward)` 这类说明。 */
  summary: string;
}

/**
 * 解析 `git push --porcelain` 的输出。
 *
 * 只认「tab 分隔的 `<flag>\t<from>:<to>\t<summary>`」行：`To <url>`、`Done` 以及
 * stderr 提示都没有 tab，直接跳过。**不能按退出码判成败**——多 ref 推送里只要有一个
 * 被拒，退出码就是非 0，而其余 ref 可能已经推成功，必须逐行读状态。
 */
export function parsePushPorcelain(output: string): PushPorcelainEntry[] {
  return output.split('\n').flatMap((line) => {
    if (!line) return [];
    const fields = line.split('\t');
    if (fields.length < 2) return [];
    const flag = fields[0] ?? '';
    if (flag.length !== 1) return [];
    const refspec = fields[1] ?? '';
    const separator = refspec.indexOf(':');
    if (separator < 0) return [];
    return [{
      flag,
      destination: refspec.slice(separator + 1),
      summary: fields.slice(2).join(' ').trim(),
    }];
  });
}

interface ResolvedCandidates {
  status: RepositoryStatus;
  defaultRemote: string;
  defaultBranch: string | null;
  branches: PushBranchCandidate[];
  blocker: string | null;
}

function planBlocker(repository: RepositoryConfig, status: RepositoryStatus): string | null {
  if (!repository.capabilities.push) return '仓库配置禁止推送';
  if (!status.available) return '仓库不可用';
  if (status.detached) return 'Detached HEAD 不能推送分支';
  if (status.conflicted > 0 || status.inProgressOperation) return '仓库存在冲突或进行中的 Git 操作';
  return null;
}

/**
 * upstream 的短名是 `<remote>/<branch>`，用它拆出远端与目的分支。
 *
 * 不用本地分支名做目的 ref：本地 `dev` 完全可以跟踪 `origin/main`（改名、或者在
 * 一个本地分支上跟另一条远端线），按本地名拼 refspec 会推到错误的分支上。
 */
function splitUpstream(upstream: string): { remote: string; branch: string } | null {
  const separator = upstream.indexOf('/');
  if (separator <= 0 || separator === upstream.length - 1) return null;
  return { remote: upstream.slice(0, separator), branch: upstream.slice(separator + 1) };
}

/**
 * 远端默认分支：优先读 `refs/remotes/<remote>/HEAD` 这个符号引用，
 * 没有（很多仓库 clone 后不会建立，或者从没 fetch 过）才回落到 main → master。
 * 主分支名各仓不同，所以不做成常量。
 */
export async function remoteDefaultBranch(cwd: string, remote: string): Promise<string | null> {  const symbolic = await runGit(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
  if (symbolic.exitCode === 0) {
    const prefix = `refs/remotes/${remote}/`;
    const ref = symbolic.stdout.toString('utf8').trim();
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  for (const candidate of ['main', 'master']) {
    const exists = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`]);
    if (exists.exitCode === 0) return candidate;
  }
  return null;
}

function branchBlocker(candidate: {
  upstream: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
}, knownRemotes: Set<string>): string | null {
  if (!candidate.upstream) return '没有 upstream';
  if (!candidate.remote) return `upstream ${candidate.upstream} 不是远端分支`;
  if (!knownRemotes.has(candidate.remote)) return `仓库缺少 remote：${candidate.remote}`;
  if ((candidate.behind ?? 0) > 0) return `落后远端 ${candidate.behind} 个提交，需先同步`;
  // `ahead` 为 null 表示算不出差异（upstream ref 本地不存在、仓库还没 fetch 过）。
  // 这时不知道该推多少，交给 `git push` 自己判断，不能当成「已是最新」提前挡掉。
  if (candidate.ahead === null) return null;
  if (candidate.ahead === 0) return '没有需要推送的提交';
  return null;
}

/**
 * 同一个远端分支只能有一个推送源。
 *
 * 两条本地分支完全可能都跟踪 `origin/dev`（克隆后改名、或手动 `--set-upstream`）。
 * 此时一次命令里会出现两条目的相同的 refspec，git 直接整体失败并报
 * `dst ref refs/heads/dev receives from more than one src`——连本来能推的那条也不动。
 * 与其到推送时把一句 stderr 丢给用户，不如在预检阶段就把后来者标成阻塞。
 */
function blockDuplicateRemoteRefs(candidates: PushBranchCandidate[]): void {
  const owner = new Map<string, string>();
  // 当前分支优先占用目的 ref；已经被其他规则挡下的分支不占位，否则「当前分支落后远端」
  // 会把另一条本可推的分支一起拖下水。
  const preferred = [...candidates].sort((left, right) => Number(right.current) - Number(left.current));
  for (const candidate of preferred) {
    if (!candidate.remoteRef || candidate.blocker) continue;
    if (!owner.has(candidate.remoteRef)) owner.set(candidate.remoteRef, candidate.name);
  }
  for (const candidate of candidates) {
    if (!candidate.remoteRef || candidate.blocker) continue;
    const name = owner.get(candidate.remoteRef);
    if (name && name !== candidate.name) candidate.blocker = `与 ${name} 指向同一个远端分支`;
  }
}

async function resolveCandidates(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<ResolvedCandidates> {
  const defaultRemote = config.settings.defaultRemote;
  ensureRemoteName(defaultRemote);
  const status = await scanRepository(config, repository);
  const blocker = planBlocker(repository, status);
  const knownRemotes = new Set(
    (await runGitText(cwd, ['remote']).catch(() => '')).split('\n').map((name) => name.trim()).filter(Boolean),
  );
  const namesBlocked = blocker ?? (!knownRemotes.has(defaultRemote) ? `仓库没有配置 ${defaultRemote} 远端` : null);
  if (namesBlocked) {
    return { status, defaultRemote, defaultBranch: null, branches: [], blocker: namesBlocked };
  }

  const snapshot = await listBranches(cwd);
  const defaultBranch = await remoteDefaultBranch(cwd, defaultRemote);
  const branches = snapshot.branches.map((branch): PushBranchCandidate => {
    const parsed = branch.upstream ? splitUpstream(branch.upstream) : null;
    const remote = parsed?.remote ?? null;
    if (remote) {
      try {
        ensureRemoteName(remote);
      } catch {
        // 本地分支可以把 upstream 指向本地分支（短名里没有 remote），这里按「不是远端」处理。
        return {
          name: branch.name,
          head: branch.head,
          upstream: branch.upstream,
          remote: null,
          remoteRef: null,
          ahead: branch.ahead,
          behind: branch.behind,
          current: branch.current,
          blocker: `upstream ${branch.upstream} 不是远端分支`,
        };
      }
    }
    const remoteRef = parsed ? `refs/heads/${parsed.branch}` : null;
    return {
      name: branch.name,
      head: branch.head,
      upstream: branch.upstream,
      remote,
      remoteRef,
      ahead: branch.ahead,
      behind: branch.behind,
      current: branch.current,
      blocker: branchBlocker({ upstream: branch.upstream, remote, ahead: branch.ahead, behind: branch.behind }, knownRemotes),
    };
  });

  blockDuplicateRemoteRefs(branches);

  return { status, defaultRemote, defaultBranch, branches, blocker: null };
}

/**
 * 预选：当前分支 + 远端默认分支 + `dev` / `develop`。
 *
 * 最后那一条是从实际用法反推的：这个入口存在的理由就是「同一个任务分支分别合进
 * dev 和主分支」之后要推两条线，而用户当时往往站在主分支上。不预选 dev，
 * 每次都得手动多勾一次。它仍然只是个预选——清单里每个分支都能改，确认按钮写的是
 * 「推送 N 个分支」，不会悄悄推用户没看见的东西。
 */
function suggestedBranches(branches: PushBranchCandidate[], current: string | null, defaultBranch: string | null): string[] {
  const pushable = new Set(branches.filter((branch) => !branch.blocker).map((branch) => branch.name));
  const suggested: string[] = [];
  for (const name of [current, defaultBranch, 'dev', 'develop']) {
    if (name && pushable.has(name) && !suggested.includes(name)) suggested.push(name);
  }
  return suggested;
}

export async function pushBranchesPlan(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<PushBranchesPlan> {
  const resolved = await resolveCandidates(config, repository, cwd);
  const current = resolved.branches.find((branch) => branch.current)?.name ?? null;
  return {
    defaultRemote: resolved.defaultRemote,
    defaultBranch: resolved.defaultBranch,
    suggested: resolved.blocker ? [] : suggestedBranches(resolved.branches, current, resolved.defaultBranch),
    // 能推的排前面：一个仓库动辄十几条分支，被「没有 upstream」「落后远端」挡住的
    // 排在中间时，弹窗第一屏全是勾不动的行。`suggested` 按名字匹配，排序不影响它。
    branches: pushableFirst(resolved.branches, (branch) => !branch.blocker),
    blocker: resolved.blocker,
  };
}

/**
 * `git push --porcelain` 的状态位翻译成人话。
 *
 * 文案带上 upstream 而不是只说「已推送」：结果列表里每行前面已经有「已推送」这个
 * 状态标签，消息再重复一遍等于没给信息。
 */
function stateForFlag(
  flag: string,
  entry: PushPorcelainEntry,
  upstream: string,
): { state: PushedBranchResult['state']; message: string } {
  if (flag === '=') return { state: 'up-to-date', message: `${upstream} 已是最新` };
  if (flag === '*') return { state: 'pushed', message: `远端新建了 ${upstream}` };
  if (flag === ' ') return { state: 'pushed', message: `${upstream} 已更新` };
  if (flag === '!') {
    return {
      state: 'rejected',
      message: entry.summary
        ? `被远端拒绝（${entry.summary}），请先 Pull 或同步后再推`
        : '被远端拒绝，请先 Pull 或同步后再推',
    };
  }
  // `+`（强制更新）在前面的 refspec 里不可能出现；真出现就说明前提被破坏，按失败报出来。
  return { state: 'failed', message: entry.summary || `未知的推送状态：${flag}` };
}

export async function pushBranches(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: PushBranchesRequest,
): Promise<PushBranchesResult> {
  if (!repository.capabilities.push) throw safetyBlockedError('仓库配置禁止 push 操作');
  const requested = input.branches;
  const resolved = await resolveCandidates(config, repository, cwd);
  if (resolved.blocker) throw safetyBlockedError(resolved.blocker);

  const byName = new Map(resolved.branches.map((branch) => [branch.name, branch]));
  const results = new Map<string, PushedBranchResult>();
  const groups = new Map<string, Array<{ candidate: PushBranchCandidate; refspec: string }>>();

  for (const item of requested) {
    const candidate = byName.get(item.name);
    if (!candidate) {
      results.set(item.name, {
        name: item.name,
        upstream: null,
        remote: null,
        state: 'skipped',
        message: '分支已不存在',
        ahead: null,
      });
      continue;
    }
    const base = { name: candidate.name, upstream: candidate.upstream, remote: candidate.remote, ahead: candidate.ahead };
    if (candidate.blocker || !candidate.remote || !candidate.remoteRef) {
      results.set(item.name, { ...base, state: 'skipped', message: candidate.blocker ?? '没有可用的 upstream' });
      continue;
    }
    // 复核分支 tip：用户可能在这个窗口打开后切过分支，或在终端里又加了一笔提交。
    // 推送源用客户端看到的 hash，保证推上去的正是清单里那一版。
    if (candidate.head !== item.head) {
      results.set(item.name, { ...base, state: 'failed', message: '分支在预览后已变化，请重新打开后重试' });
      continue;
    }
    const valid = await runGit(cwd, ['check-ref-format', candidate.remoteRef]);
    if (valid.exitCode !== 0) {
      results.set(item.name, { ...base, state: 'failed', message: `推送目的 ref 无效：${candidate.remoteRef}` });
      continue;
    }
    const queued = groups.get(candidate.remote) ?? [];
    queued.push({ candidate, refspec: `${item.head}:${candidate.remoteRef}` });
    groups.set(candidate.remote, queued);
  }

  for (const [remote, queued] of groups) {
    // 一次命令推多个 ref：省掉每个分支一个网络往返。不加 `--atomic`——dev 与 main 是
    // 两件独立的事，一个被拒不该把另一个也扣住。
    const outcome = await runGit(cwd, ['push', '--porcelain', remote, ...queued.map((item) => item.refspec)], 300_000);
    const entries = parsePushPorcelain(outcome.stdout.toString('utf8'));
    for (const { candidate } of queued) {
      const base = { name: candidate.name, upstream: candidate.upstream, remote: candidate.remote, ahead: candidate.ahead };
      const entry = entries.find((item) => item.destination === candidate.remoteRef);
      if (!entry) {
        results.set(candidate.name, {
          ...base,
          state: 'failed',
          message: outcome.stderr || `推送失败（退出码 ${outcome.exitCode}）`,
        });
        continue;
      }
      results.set(candidate.name, { ...base, ...stateForFlag(entry.flag, entry, candidate.upstream ?? remote) });
    }
  }

  const ordered = requested
    .map((item) => results.get(item.name))
    .filter((item): item is PushedBranchResult => item !== undefined);

  const pushed = ordered.filter((item) => item.state === 'pushed').map((item) => item.name);
  const rejected = ordered.filter((item) => item.state === 'rejected').map((item) => item.name);
  const failed = ordered.filter((item) => item.state === 'failed').map((item) => item.name);
  const parts: string[] = [];
  if (pushed.length) parts.push(`已推送 ${pushed.join('、')}`);
  if (rejected.length) parts.push(`${rejected.join('、')} 被远端拒绝`);
  if (failed.length) parts.push(`${failed.join('、')} 推送失败`);
  if (!parts.length) parts.push('没有分支需要推送');

  return {
    branches: ordered,
    status: await scanRepository(config, repository),
    summary: parts.join('；'),
  };
}
