import type {
  OperationSkipReason,
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
  StashEntry,
} from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { ensureRemoteName } from './guards.js';
import { conflictError, safetyBlockedError } from '../errors.js';
import { repositoryInternalState } from './scanner.js';
import { scanRepository } from './scanner.js';
import { runGit, runGitStreaming, runGitText } from './runner.js';
import { TransferProgressParser } from './transfer-progress.js';
import { createStash, popStash } from './stash.js';
import { classifyGitAuthFailure } from '../../shared/git-failure.js';

function ensureCapability(repository: RepositoryConfig, capability: keyof RepositoryConfig['capabilities']): void {
  if (!repository.capabilities[capability]) throw safetyBlockedError(`仓库配置禁止 ${capability} 操作`);
}

/** 会走「取远端 → 整合」这条路的动作。两者的守卫与报错文案共用一套。 */
type IntegrationAction = 'Pull' | '同步';

/**
 * 动作开始前的硬前置条件。刻意**不含**「工作区是否干净」——
 * 那一条由 Auto Stash 处理，或由整合前的完整校验兜住。
 */
function ensureActionPreconditions(status: RepositoryStatus, action: IntegrationAction): void {
  if (!status.available) throw new Error('仓库不可用');
  if (status.detached) throw safetyBlockedError(`Detached HEAD 禁止 ${action}`);
  if (!status.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (status.conflicted > 0 || status.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
}

/**
 * 整合前的完整校验：在前置条件之上，工作区必须干净。
 * 勾了 Auto Stash 时，暂存之后的快照即可满足；没勾则在这里拒绝。
 */
function ensureReadyToIntegrate(status: RepositoryStatus, action: IntegrationAction): void {
  ensureActionPreconditions(status, action);
  if (hasWorktreeChanges(status)) throw safetyBlockedError(`工作区不干净，${action} 已阻止`);
}

function hasWorktreeChanges(status: RepositoryStatus): boolean {
  return status.staged + status.modified + status.untracked + status.deleted + status.renamed > 0;
}

/**
 * Auto Stash（对齐 Tower）：工作区不干净时，若请求了 stashFirst 则先暂存，
 * 操作结束后自动 pop 恢复。pop 冲突时保留 stash 并给出提示，绝不静默丢弃改动。
 */
async function stashIfRequested(
  cwd: string,
  action: IntegrationAction,
  status: RepositoryStatus,
  stashFirst: boolean,
): Promise<StashEntry | null> {
  if (!stashFirst || !hasWorktreeChanges(status)) return null;
  return createStash(cwd, `Moo Fleet ${action}前自动备份`, true);
}

async function restoreStashIfAny(cwd: string, stashed: StashEntry | null, action: IntegrationAction): Promise<string | null> {
  if (!stashed) return null;
  try {
    await popStash(cwd, stashed.ref, stashed.hash);
    return null;
  } catch (error) {
    return `${action} 完成，但自动恢复 Stash 失败（改动仍安全保留在 Stash 列表）：${error instanceof Error ? error.message : '请手动处理'}`;
  }
}

/**
 * 失败路径上的还原：这次操作没做成，但 Auto Stash 必须回到工作区。
 *
 * 少了这一步，用户勾了「自动 Stash」再遇到 Fetch 断网，看到的是「Fetch 失败」，
 * 而工作区是空的、改动躺在 `Moo Fleet Pull前自动备份` 里——报错既没说改动去哪了，
 * 也没提 stash 名字。pop 失败时同样要把这句话拼进错误里再抛。
 */
async function restoreStashAndRethrow(
  cwd: string,
  stashed: StashEntry | null,
  action: IntegrationAction,
  error: unknown,
): Promise<never> {
  const note = await restoreStashIfAny(cwd, stashed, action);
  if (!note) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    error.message = `${message}；${note}`;
    throw error;
  }
  throw new Error(`${message}；${note}`);
}

async function configuredRemote(cwd: string, config: RepositoriesConfig): Promise<string> {
  const remotes = (await runGitText(cwd, ['remote'])).split('\n').filter(Boolean);
  const remote = config.settings.defaultRemote;
  ensureRemoteName(remote);
  if (!remotes.includes(remote)) throw conflictError(`仓库缺少 remote：${remote}`);
  return remote;
}

async function currentBranchAndHead(cwd: string): Promise<{ branch: string | null; head: string }> {
  const [branch, head] = await Promise.all([
    runGitText(cwd, ['branch', '--show-current']),
    runGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  return { branch: branch || null, head };
}

function ensureActionSnapshot(
  status: RepositoryStatus,
  expected: { branch: string; head: string },
  action: 'Pull' | 'Push' | '同步',
): void {
  if (status.branch !== expected.branch || status.lastCommit?.hash !== expected.head) {
    throw safetyBlockedError(`当前分支或 HEAD 已变化，${action} 已阻止`);
  }
}

/** 当前分支的 upstream 绑定关系；`readUpstreamBinding` 的唯一产出。 */
interface UpstreamBinding {
  /** 远端跟踪引用，如 `refs/remotes/origin/main`。 */
  trackingRef: string;
  /** remote 名，如 `origin`。 */
  remoteName: string;
  /** 远端目标分支，如 `refs/heads/main`——即 push 的目的 ref。 */
  remoteRef: string;
}

/**
 * 一处读取 upstream 绑定，供「取 tracking 提交来整合」与「取 push 目的 ref」共用。
 *
 * 此前是两套写法（整合用 `for-each-ref %(upstream)`，推送用 `git config branch.x.remote/merge`），
 * 并存意味着两处各有一套格式校验，漏改一处就是缺口。`%(upstream:remoteref)` 与
 * `branch.<name>.merge` 解析到同一个值，因此合并成一次调用不改变语义，
 * 顺带把三处 git 调用压成一次。
 */
async function readUpstreamBinding(cwd: string, branch: string): Promise<UpstreamBinding> {
  const format = '%(upstream)\t%(upstream:remotename)\t%(upstream:remoteref)';
  const line = await runGitText(cwd, [
    'for-each-ref',
    '--count=1',
    `--format=${format}`,
    '--',
    `refs/heads/${branch}`,
  ]);
  const [trackingRef = '', remoteName = '', remoteRef = ''] = line.split('\t');
  if (!trackingRef) throw safetyBlockedError('当前分支没有 upstream');
  for (const ref of [trackingRef, remoteRef]) {
    if (!ref.startsWith('refs/')) throw new Error('Upstream branch 配置无效');
    await runGitText(cwd, ['check-ref-format', ref]);
  }
  ensureRemoteName(remoteName);
  return { trackingRef, remoteName, remoteRef };
}

/**
 * Fetch 某个远端。
 *
 * `options.remote` 必须传「当前分支真正跟踪的那个远端」：多远端仓库（fork 工作流）里
 * 默认远端往往不是 upstream 所在，按默认远端 fetch 会让 Pull 拿一个永远不更新的
 * tracking ref 去比对，最后报「已经是最新状态」而远端其实已经前进了几个提交。
 * 批量 Fetch 没有分支上下文，仍按仓库默认远端。
 */
/**
 * 读 upstream 跟踪引用的提交。
 *
 * Fetch 之后这个引用仍不存在，只有两种原因：远端分支已被删除，或本地从未成功
 * fetch 过这个远端。两者都不该把 git 的 `fatal: Needed a single revision` 直接抛给用户。
 */
async function resolveUpstreamHead(cwd: string, upstream: UpstreamBinding): Promise<string> {
  try {
    return await runGitText(cwd, ['rev-parse', '--verify', `${upstream.trackingRef}^{commit}`]);
  } catch {
    throw upstreamGoneError(upstream);
  }
}

function upstreamGoneError(upstream: UpstreamBinding): Error {
  return safetyBlockedError(
    `当前分支跟踪的远端分支 ${upstream.trackingRef} 不存在（可能已在远端删除）；请先 Fetch，或在「修复 upstream」里重新关联`,
  );
}

/**
 * Fetch 之后仍算不出 ahead/behind，说明 upstream 引用不可用。
 *
 * 必须在「已经是最新状态」判定之前拦住：否则悬空的 upstream 会被当成 0/0，
 * 用户看到「已是最新」，实际远端引用根本不存在。
 */
function assertUpstreamUsable(status: RepositoryStatus, upstream: UpstreamBinding): void {
  if (status.upstream && status.ahead === null && status.behind === null) throw upstreamGoneError(upstream);
}

export async function fetchRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  onProgress?: (message: string) => void,
  options: { remote?: string } = {},
): Promise<RepositoryStatus> {
  ensureCapability(repository, 'fetch');
  if (options.remote) ensureRemoteName(options.remote);
  const remote = options.remote ?? (await configuredRemote(cwd, config));
  const parser = onProgress ? new TransferProgressParser(onProgress) : null;
  const args = ['fetch', '--prune', ...(parser ? ['--progress'] : []), remote];
  if (!parser) {
    await runGitText(cwd, args, 300_000);
  } else {
    const result = await runGitStreaming(cwd, args, {
      timeoutMs: 300_000,
      onStderr: (chunk) => parser.push(chunk),
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Fetch 失败');
  }
  return scanRepository(config, repository);
}

interface IntegrationPreparation {
  /** 动作开始时的分支与 HEAD，后续每一步都拿它复核，防并发改动。 */
  expected: { branch: string; head: string };
  /** Fetch 之后的最新状态（ahead / behind 以它为准）。 */
  fresh: RepositoryStatus;
  /** 本次自动暂存的记录；未暂存时为 null，调用方据此决定是否扫描第二次。 */
  stashed: StashEntry | null;
  /** 当前分支的 upstream 绑定：Fetch 的目标远端与后续整合/推送共用同一份。 */
  upstream: UpstreamBinding;
}

/**
 * Pull 与「同步」共用的前置流程：
 * 取基准 → 校验前置条件 → （按需）自动 Stash → 复校快照 → Fetch → 再复校一次。
 *
 * Fetch 之后两者分岔（是否自动推送、哪些情况直接跳过），因此只做到这里为止。
 * 基准会在正式整合前再复核一次（见 `ensureStillOnSameHead`），
 * 因为 Fetch 是唯一可能被外部改动插进来的窗口。
 */
async function prepareIntegration(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  action: IntegrationAction,
  options: { stashFirst?: boolean; onProgress?: (message: string) => void },
): Promise<IntegrationPreparation> {
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  ensureActionPreconditions(before, action);
  // 先确认拿到了分支名再暂存：否则可能在 detached 竞态下留下一个没人认领的 stash。
  if (!initial.branch) throw safetyBlockedError(`Detached HEAD 禁止 ${action}`);
  // 在 Fetch 之前读出 upstream：Fetch 必须打「这个分支真正跟踪的远端」，
  // 否则多远端仓库会去更新另一个远端的 tracking ref，Pull 永远停在旧提交上。
  const upstream = await readUpstreamBinding(cwd, initial.branch);
  const stashed = await stashIfRequested(cwd, action, before, options.stashFirst === true);
  const expected = { branch: initial.branch, head: initial.head };
  try {
    // 只有真的 stash 过才可能改变状态；否则复用 before，省一次扫描（每次约 4 个 git 进程）。
    const snapshot = stashed ? await scanRepository(config, repository) : before;
    ensureReadyToIntegrate(snapshot, action);
    ensureActionSnapshot(snapshot, expected, action);
    // fetchRepository 结束时会扫一次仓库并返回，那已经是 Fetch 之后的状态；
    // 紧接着再扫一遍等于把同样几个 git 进程重跑一次，语义完全一样。
    const fresh = await fetchRepository(config, repository, cwd, options.onProgress, { remote: upstream.remoteName });
    ensureReadyToIntegrate(fresh, action);
    ensureActionSnapshot(fresh, expected, action);
    return { expected, fresh, stashed, upstream };
  } catch (error) {
    // 从这里往下都可能失败（Fetch 断网、复校发现工作区被改过），一旦失败就把 Stash 还回去。
    return restoreStashAndRethrow(cwd, stashed, action, error);
  }
}

/**
 * 整合前的最后一道复核：Fetch 之后到真正写工作区之间，分支与 HEAD 必须没变过。
 * 任一不符就把 Auto Stash 恢复掉再拒绝，绝不带着半套前置状态往下走。
 */
async function ensureStillOnSameHead(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  expected: { branch: string; head: string },
  stashed: StashEntry | null,
  action: IntegrationAction,
): Promise<void> {
  const status = await scanRepository(config, repository);
  try {
    ensureReadyToIntegrate(status, action);
    ensureActionSnapshot(status, expected, action);
  } catch (error) {
    // 复校不通过同样要还原：此时 stash 已经在，工作区是空的。
    return restoreStashAndRethrow(cwd, stashed, action, error);
  }
  const identity = await currentBranchAndHead(cwd);
  if (identity.branch !== expected.branch || identity.head !== expected.head) {
    await restoreStashIfAny(cwd, stashed, action);
    throw safetyBlockedError(`当前分支或 HEAD 已变化，${action} 已阻止`);
  }
}

export async function pullRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  options: { stashFirst?: boolean; rebase?: boolean; ffOnly?: boolean; onProgress?: (message: string) => void } = {},
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason; warning?: string | null }> {
  ensureCapability(repository, 'pull');
  const { expected, fresh, stashed, upstream } = await prepareIntegration(config, repository, cwd, 'Pull', options);
  assertUpstreamUsable(fresh, upstream);
  if ((fresh.ahead ?? 0) > 0 && (fresh.behind ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '本地存在领先提交，无需 Pull' };
  }
  if ((fresh.behind ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }

  const upstreamHead = await resolveUpstreamHead(cwd, upstream);
  await ensureStillOnSameHead(config, repository, cwd, expected, stashed, 'Pull');
  // 整合远端：默认 merge（分叉时产生 merge commit），可选 rebase（线性历史）。
  // 用 try/catch 确保无论整合成功、冲突暂停还是失败，Auto Stash 都会被恢复。
  try {
    await integrateUpstream(cwd, upstreamHead, options.rebase === true, options.ffOnly === true, 'Pull');
  } catch (error) {
    // 冲突暂停时 auto-stash 是 pop 不回去的（索引进冲突态），必须把「改动仍在 stash@{n}」
    // 拼进错误里，否则用户只看到冲突、不知道自己的改动去哪了。
    return restoreStashAndRethrow(cwd, stashed, 'Pull', error);
  }
  const restoreNote = await restoreStashIfAny(cwd, stashed, 'Pull');
  const status = await scanRepository(config, repository);
  // 恢复失败单独进 warning，让界面高亮出「改动仍在 Stash」；message 保持一句干净的结论。
  return {
    status,
    skipped: false,
    message: 'Pull 完成',
    warning: restoreNote,
  };
}

/**
 * 把 upstream 整合进当前分支：默认 `git merge`（分叉时产生 merge commit），
 * 可选 `git rebase`（把本地提交重放到远端之上，产生线性历史）。
 * merge 与 rebase 冲突都抛 `merge-paused`（conflicts.ts 已支持两者 continue）。
 */
async function integrateUpstream(cwd: string, upstreamHead: string, rebase: boolean, ffOnly: boolean, action: 'Pull' | '同步'): Promise<void> {
  if (ffOnly) {
    // 「只允许快进」：分叉时 git 会直接拒绝，不会留下 merge 状态或合并提交。
    const fastForward = await runGit(cwd, ['merge', '--ff-only', '--', upstreamHead], 300_000);
    if (fastForward.exitCode !== 0) {
      throw safetyBlockedError('本地与远端已分叉，已按「只允许快进」停止；请改用 Merge 或 Rebase 后重试');
    }
    return;
  }
  const result = rebase
    ? await runGit(cwd, ['rebase', '--', upstreamHead], 300_000)
    : await runGit(cwd, ['merge', '--no-edit', '--', upstreamHead], 300_000);
  if (result.exitCode !== 0) {
    const internal = await repositoryInternalState(cwd);
    if (internal.operation === 'merge' || internal.operation === 'rebase') {
      const mode = internal.operation === 'rebase' ? 'rebase' : '合并';
      throw conflictError(
        `${action}遇到冲突，${mode}已暂停，请在工作区处理后继续或中止${result.stderr ? `。Git 提示：${result.stderr}` : ''}`,
        { code: mergePausedErrorCode },
      );
    }
    throw conflictError(result.stderr || result.stdout.toString('utf8').trim() || `${action}整合失败`);
  }
}

/**
 * 同步：对齐 Tower 的 Sync —— Pull（Fetch + 整合）+ 自动 Push，
 * 一个动作完成双向同步。整合默认 merge（可选 rebase），冲突才暂停。
 *
 * `push` 能力关闭时**不整体拒绝**：拉取那一半照做，只是不推。用户关掉 push
 * 往往就是「这个仓库不许我推上去」，此时连拉都不让做没有道理，而且报错
 * 「仓库配置禁止 push 操作」也没说清为什么点了「同步」却被拒。
 */
export async function syncRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  options: { stashFirst?: boolean; rebase?: boolean; ffOnly?: boolean; onProgress?: (message: string) => void } = {},
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason; warning?: string | null }> {
  ensureCapability(repository, 'pull');
  ensureCapability(repository, 'fetch');
  const canPush = repository.capabilities.push;
  const { expected, fresh, stashed, upstream } = await prepareIntegration(config, repository, cwd, '同步', options);
  assertUpstreamUsable(fresh, upstream);
  // 无落后且无领先：完全一致，无需同步。
  if ((fresh.behind ?? 0) === 0 && (fresh.ahead ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, '同步');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }
  // 只有领先（ahead>0 且 behind==0）：无需 merge，直接推送。
  if ((fresh.behind ?? 0) === 0) {
    if (!canPush) {
      await restoreStashIfAny(cwd, stashed, '同步');
      return {
        status: fresh,
        skipped: true,
        skipReason: 'disabled',
        message: '本仓库已禁用推送，本地领先提交未推送；如需推送，请在此仓库配置里开启「推送」能力',
      };
    }
    try {
      const pushed = await pushCurrentHead(config, repository, cwd, expected, '同步', options.onProgress);
      const restoreNote = await restoreStashIfAny(cwd, stashed, '同步');
      return { ...pushed, message: '同步完成；本地领先提交已推送', warning: restoreNote };
    } catch (error) {
      return restoreStashAndRethrow(cwd, stashed, '同步', error);
    }
  }

  const upstreamHead = await resolveUpstreamHead(cwd, upstream);
  await ensureStillOnSameHead(config, repository, cwd, expected, stashed, '同步');
  // 整合远端（默认 merge / 可选 rebase），与 Pull 共用同一整合逻辑。
  // try/catch 确保冲突暂停或失败时 Auto Stash 仍被恢复。
  try {
    await integrateUpstream(cwd, upstreamHead, options.rebase === true, options.ffOnly === true, '同步');
  } catch (error) {
    return restoreStashAndRethrow(cwd, stashed, '同步', error);
  }
  // 整合成功（merge 产生 merge commit / rebase 产生线性提交），HEAD 已前移，
  // 重新取当前 HEAD 作为推送快照，随后自动推送本地领先提交。
  const mergedHead = await runGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const mergedExpected = { branch: expected.branch, head: mergedHead };
  const mergedStatus = await scanRepository(config, repository);
  if (mergedStatus.branch !== expected.branch) {
    return restoreStashAndRethrow(cwd, stashed, '同步', safetyBlockedError('同步执行期间当前分支已变化，请检查仓库状态'));
  }
  if ((mergedStatus.ahead ?? 0) > 0 && canPush) {
    try {
      await pushCurrentHead(config, repository, cwd, mergedExpected, '同步', options.onProgress);
    } catch (error) {
      // 合并已经落库、Stash 还在：推送失败（断网、凭证过期）不能让用户以为整件事都没发生。
      return restoreStashAndRethrow(cwd, stashed, '同步', error);
    }
  }
  const status = await scanRepository(config, repository);
  const restoreNote = await restoreStashIfAny(cwd, stashed, '同步');
  const base = !canPush
    ? '同步完成（已拉取）；本仓库已禁用推送，领先提交未推送'
    : (status.ahead ?? 0) > 0
      ? '同步完成；仍存在本地领先提交待推送'
      : '同步完成；已推送全部领先提交';
  return {
    status,
    skipped: false,
    message: base,
    warning: restoreNote,
  };
}

export async function pushRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  onProgress?: (message: string) => void,
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'push');
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  if (!before.available) throw new Error('仓库不可用');
  if (before.detached || !initial.branch) throw safetyBlockedError('Detached HEAD 禁止 Push');
  if (!before.branch || !before.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (before.conflicted > 0 || before.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  const expected = { branch: initial.branch, head: initial.head };
  ensureActionSnapshot(before, expected, 'Push');
  // 这里刻意**不**先 fetch。此前每次推送都要先跑一次 `git fetch --prune` 才能判断
  // behind，等于两个网络往返；仓库越大，fetch 那一段越明显，用户看到的就是「推送很慢」。
  // 远端如果已经前移，`git push` 自己会拒绝（non-fast-forward），`pushCurrentHead`
  // 把 `--porcelain` 的 `!` 状态翻译成同一句提示——语义与「推之前先查 behind」一致，
  // 而且本地永远不会被改写（永不 force）。
  // 用上次 fetch 留下的 behind 做一次快速预判：已知落后就不必白跑一趟网络。
  if ((before.behind ?? 0) > 0) throw safetyBlockedError('远端存在新提交或已经分叉，禁止 Push');
  if ((before.ahead ?? 0) === 0) {
    return { status: before, skipped: true, skipReason: 'not-needed', message: '没有需要推送的 commit' };
  }
  return pushCurrentHead(config, repository, cwd, expected, 'Push', onProgress);
}

/**
 * `git push --porcelain` 的机器可读状态：以 `!` 开头的行表示该 ref 被远端拒绝。
 *
 * 只认这个标志，不匹配 stderr 里的英文/本地化文案——`[rejected]` 后面的原因
 * （`fetch first` / `non-fast-forward`）会随 locale 变，标志位不会。
 */
function pushWasRejected(stdout: Buffer): boolean {
  return stdout.toString('utf8').split('\n').some((line) => line.startsWith('!'));
}

/**
 * 被拒时把「为什么被拒」翻译成用户能行动的一步。
 *
 * `!` 只说明「这个 ref 没推上去」，但原因天差地别：非快进（该先 Pull）、
 * 受保护分支、权限不足、hook 拒绝。此前一律回「远端已有新提交，请先 Pull」，
 * 会让受保护分支/权限问题的人白跑一趟 Pull 仍失败。这里按 porcelain 行的
 * 原因片段与 git 失败分类区分，只有真·非快进才引导 Pull。
 */
function describePushRejection(stdout: Buffer): { message: string; kind: 'non-fast-forward' | 'other' } {
  const lines = stdout.toString('utf8').split('\n').filter((line) => line.startsWith('!'));
  const detail = lines.join('\n');
  const reason = lines.map((line) => line.replace(/^!\s*\S+\s*/, '')).join(' ');
  // porcelain 的拒绝行形如：`!\trefs/heads/x:refs/heads/x\t[rejected] (non-fast-forward)`
  // 或 `[remote rejected] (pre-receive hook declined)` / `[remote failure]`。
  const isNonFastForward = /non-fast-forward|fetch first|[rejected]/.test(detail) && !/hook declined|pre-receive|protected/i.test(detail);
  if (isNonFastForward) {
    return { message: '推送被拒绝：远端已有新提交，请先 Pull 或同步后再推送', kind: 'non-fast-forward' };
  }
  // 其余原因：优先按认证/权限分类给出可行动提示。
  const auth = classifyGitAuthFailure(detail);
  if (auth) return { message: `推送被拒绝：${auth.hint}`, kind: 'other' };
  if (/hook declined|pre-receive|protected/i.test(detail)) {
    return { message: '推送被拒绝：远端分支受保护或有提交钩子拦截，请联系仓库管理员检查分支保护规则', kind: 'other' };
  }
  return { message: `推送被拒绝：${reason.trim() || '请检查远端分支权限或保护规则'}`, kind: 'other' };
}

/**
 * 把当前 HEAD 推送到其 upstream 分支（明确 refspec，永不 force push）。
 * `syncRepository` 在 merge 成功后复用此逻辑，实现「拉 + 自动推」。
 */
export interface PushForcePreview {
  branch: string;
  remoteName: string;
  remoteRef: string;
  localHead: string;
  remoteHead: string;
  ahead: Array<{ hash: string; subject: string; author: string; committedAt: string }>;
  behind: Array<{ hash: string; subject: string; author: string; committedAt: string }>;
}

async function readCommitRange(cwd: string, range: string, limit: number): Promise<PushForcePreview['ahead']> {
  const result = await runGit(cwd, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x00%s%x00%an%x00%aI',
    '-z',
    range,
    '--',
  ], 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取提交列表失败');
  const fields = result.stdout.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const commits: PushForcePreview['ahead'] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    commits.push({ hash: fields[index]!, subject: fields[index + 1]!, author: fields[index + 2]!, committedAt: fields[index + 3]! });
  }
  return commits;
}

/**
 * 强制推送的只读预览：本地与远端各自独有的提交。
 *
 * 远端 head 取自**本地 tracking ref**（最近一次 Fetch 的快照），不联网；真正执行时
 * 用 `--force-with-lease=<ref>:<expected>` 原子复核，远端在预览之后变了就会被拒。
 */
export async function pushForcePreview(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<PushForcePreview> {
  ensureCapability(repository, 'push');
  const initial = await currentBranchAndHead(cwd);
  if (!initial.branch) throw safetyBlockedError('Detached HEAD 不能强制推送');
  const upstream = await readUpstreamBinding(cwd, initial.branch);
  const remoteHead = await runGitText(cwd, ['rev-parse', '--verify', `${upstream.trackingRef}^{commit}`]).catch(() => '');
  if (!remoteHead) throw safetyBlockedError('远端跟踪引用不可用，请先 Fetch 后再试');
  const [ahead, behind] = await Promise.all([
    readCommitRange(cwd, `${remoteHead}..${initial.head}`, 50),
    readCommitRange(cwd, `${initial.head}..${remoteHead}`, 50),
  ]);
  return {
    branch: initial.branch,
    remoteName: upstream.remoteName,
    remoteRef: upstream.remoteRef,
    localHead: initial.head,
    remoteHead,
    ahead,
    behind,
  };
}

/**
 * 强制推送当前分支，覆盖远端历史。
 *
 * 必须由用户显式确认（客户端会把「远端将被覆盖的提交」列出来）。安全边界：
 * - `--force-with-lease` 绑定 `expectedRemoteHead`：远端在确认后发生任何变化都会被拒；
 * - 写入前复核分支与 HEAD 未变；
 * - 只推当前分支到它自己的 upstream，不做多分支/批量强推。
 */
export async function forcePushRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  expectedRemoteHead: string,
  onProgress?: (message: string) => void,
): Promise<{ status: RepositoryStatus; message: string }> {
  ensureCapability(repository, 'push');
  const initial = await currentBranchAndHead(cwd);
  if (!initial.branch) throw safetyBlockedError('Detached HEAD 不能强制推送');
  const upstream = await readUpstreamBinding(cwd, initial.branch);
  const parser = onProgress ? new TransferProgressParser(onProgress) : null;
  const pushArgs = [
    'push',
    '--porcelain',
    ...(parser ? ['--progress'] : []),
    `--force-with-lease=${upstream.remoteRef}:${expectedRemoteHead}`,
    upstream.remoteName,
    `${initial.head}:${upstream.remoteRef}`,
  ];
  const result = parser
    ? await runGitStreaming(cwd, pushArgs, { timeoutMs: 300_000, onStderr: (chunk) => parser.push(chunk) })
    : await runGit(cwd, pushArgs, 300_000);
  if (result.exitCode !== 0) {
    const detail = `${result.stdout.toString('utf8')}\n${result.stderr}`;
    if (/stale info|failed to push some refs/i.test(detail) && /rejected/.test(detail)) {
      throw conflictError('远端分支在确认后已变化，强制推送被拒绝，请重新 Fetch 后确认');
    }
    throw new Error(result.stderr.trim() || '强制推送失败');
  }
  const status = await scanRepository(config, repository);
  return { status, message: '强制推送完成，远端分支已被本地历史覆盖' };
}

async function pushCurrentHead(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  expected: { branch: string; head: string },
  action: 'Push' | '同步',
  onProgress?: (message: string) => void,
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  // 与整合侧同一个读取入口：push 目的 ref 不再是另一套 `git config` 解析。
  const upstream = await readUpstreamBinding(cwd, expected.branch);
  const final = await currentBranchAndHead(cwd);
  if (final.branch !== expected.branch || final.head !== expected.head) {
    throw safetyBlockedError(`当前分支或 HEAD 已变化，${action} 已阻止`);
  }
  const parser = onProgress ? new TransferProgressParser(onProgress) : null;
  const pushArgs = ['push', '--porcelain', ...(parser ? ['--progress'] : []), upstream.remoteName, `${expected.head}:${upstream.remoteRef}`];
  const result = parser
    ? await runGitStreaming(cwd, pushArgs, { timeoutMs: 300_000, onStderr: (chunk) => parser.push(chunk) })
    : await runGit(cwd, pushArgs, 300_000);
  if (result.exitCode !== 0) {
    if (pushWasRejected(result.stdout)) {
      throw conflictError(`${action}被拒绝：${describePushRejection(result.stdout).message.replace(/^推送被拒绝：/, '')}`);
    }
    throw new Error(result.stderr.trim() || `${action} 失败（退出码 ${result.exitCode}）`);
  }
  const status = await scanRepository(config, repository);
  const changedDuringPush = status.branch !== expected.branch || status.lastCommit?.hash !== expected.head;
  return {
    status,
    skipped: false,
    message: changedDuringPush ? `${action} 完成；推送期间本地分支或 HEAD 已变化，新 commit 未被推送` : `${action} 完成`,
  };
}
