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
import { runGit, runGitText } from './runner.js';
import { createStash, popStash } from './stash.js';

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

export async function fetchRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<RepositoryStatus> {
  ensureCapability(repository, 'fetch');
  const remote = await configuredRemote(cwd, config);
  await runGitText(cwd, ['fetch', '--prune', remote], 300_000);
  return scanRepository(config, repository);
}

interface IntegrationPreparation {
  /** 动作开始时的分支与 HEAD，后续每一步都拿它复核，防并发改动。 */
  expected: { branch: string; head: string };
  /** Fetch 之后的最新状态（ahead / behind 以它为准）。 */
  fresh: RepositoryStatus;
  /** 本次自动暂存的记录；未暂存时为 null，调用方据此决定是否扫描第二次。 */
  stashed: StashEntry | null;
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
  options: { stashFirst?: boolean },
): Promise<IntegrationPreparation> {
  const initial = await currentBranchAndHead(cwd);
  const before = await scanRepository(config, repository);
  ensureActionPreconditions(before, action);
  // 先确认拿到了分支名再暂存：否则可能在 detached 竞态下留下一个没人认领的 stash。
  if (!initial.branch) throw safetyBlockedError(`Detached HEAD 禁止 ${action}`);
  const stashed = await stashIfRequested(cwd, action, before, options.stashFirst === true);
  const expected = { branch: initial.branch, head: initial.head };
  try {
    // 只有真的 stash 过才可能改变状态；否则复用 before，省一次扫描（每次约 4 个 git 进程）。
    const snapshot = stashed ? await scanRepository(config, repository) : before;
    ensureReadyToIntegrate(snapshot, action);
    ensureActionSnapshot(snapshot, expected, action);
    // fetchRepository 结束时会扫一次仓库并返回，那已经是 Fetch 之后的状态；
    // 紧接着再扫一遍等于把同样几个 git 进程重跑一次，语义完全一样。
    const fresh = await fetchRepository(config, repository, cwd);
    ensureReadyToIntegrate(fresh, action);
    ensureActionSnapshot(fresh, expected, action);
    return { expected, fresh, stashed };
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
  options: { stashFirst?: boolean; rebase?: boolean } = {},
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'pull');
  const { expected, fresh, stashed } = await prepareIntegration(config, repository, cwd, 'Pull', options);
  if ((fresh.ahead ?? 0) > 0 && (fresh.behind ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '本地存在领先提交，无需 Pull' };
  }
  if ((fresh.behind ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }

  const upstream = await readUpstreamBinding(cwd, expected.branch);
  const upstreamHead = await runGitText(cwd, ['rev-parse', '--verify', `${upstream.trackingRef}^{commit}`]);
  await ensureStillOnSameHead(config, repository, cwd, expected, stashed, 'Pull');
  // 整合远端：默认 merge（分叉时产生 merge commit），可选 rebase（线性历史）。
  // 用 try/catch 确保无论整合成功、冲突暂停还是失败，Auto Stash 都会被恢复。
  try {
    await integrateUpstream(cwd, upstreamHead, options.rebase === true, 'Pull');
  } catch (error) {
    await restoreStashIfAny(cwd, stashed, 'Pull');
    throw error;
  }
  const restoreNote = await restoreStashIfAny(cwd, stashed, 'Pull');
  const status = await scanRepository(config, repository);
  return {
    status,
    skipped: false,
    message: restoreNote ? `Pull 完成；${restoreNote}` : 'Pull 完成',
  };
}

/**
 * 把 upstream 整合进当前分支：默认 `git merge`（分叉时产生 merge commit），
 * 可选 `git rebase`（把本地提交重放到远端之上，产生线性历史）。
 * merge 与 rebase 冲突都抛 `merge-paused`（conflicts.ts 已支持两者 continue）。
 */
async function integrateUpstream(cwd: string, upstreamHead: string, rebase: boolean, action: 'Pull' | '同步'): Promise<void> {
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
 */
export async function syncRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  options: { stashFirst?: boolean; rebase?: boolean } = {},
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  ensureCapability(repository, 'pull');
  ensureCapability(repository, 'fetch');
  ensureCapability(repository, 'push');
  const { expected, fresh, stashed } = await prepareIntegration(config, repository, cwd, '同步', options);
  // 无落后且无领先：完全一致，无需同步。
  if ((fresh.behind ?? 0) === 0 && (fresh.ahead ?? 0) === 0) {
    await restoreStashIfAny(cwd, stashed, '同步');
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '已经是最新状态' };
  }
  // 只有领先（ahead>0 且 behind==0）：无需 merge，直接推送。
  if ((fresh.behind ?? 0) === 0) {
    try {
      const pushed = await pushCurrentHead(config, repository, cwd, expected, '同步');
      const restoreNote = await restoreStashIfAny(cwd, stashed, '同步');
      return { ...pushed, message: restoreNote ? `同步完成；${restoreNote}` : '同步完成；本地领先提交已推送' };
    } catch (error) {
      await restoreStashIfAny(cwd, stashed, '同步');
      throw error;
    }
  }

  const upstream = await readUpstreamBinding(cwd, expected.branch);
  const upstreamHead = await runGitText(cwd, ['rev-parse', '--verify', `${upstream.trackingRef}^{commit}`]);
  await ensureStillOnSameHead(config, repository, cwd, expected, stashed, '同步');
  // 整合远端（默认 merge / 可选 rebase），与 Pull 共用同一整合逻辑。
  // try/catch 确保冲突暂停或失败时 Auto Stash 仍被恢复。
  try {
    await integrateUpstream(cwd, upstreamHead, options.rebase === true, '同步');
  } catch (error) {
    await restoreStashIfAny(cwd, stashed, '同步');
    throw error;
  }
  // 整合成功（merge 产生 merge commit / rebase 产生线性提交），HEAD 已前移，
  // 重新取当前 HEAD 作为推送快照，随后自动推送本地领先提交。
  const mergedHead = await runGitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const mergedExpected = { branch: expected.branch, head: mergedHead };
  const mergedStatus = await scanRepository(config, repository);
  if (mergedStatus.branch !== expected.branch) {
    await restoreStashIfAny(cwd, stashed, '同步');
    throw safetyBlockedError('同步执行期间当前分支已变化，请检查仓库状态');
  }
  if ((mergedStatus.ahead ?? 0) > 0) {
    try {
      await pushCurrentHead(config, repository, cwd, mergedExpected, '同步');
    } catch (error) {
      // 合并已经落库、Stash 还在：推送失败（断网、凭证过期）不能让用户以为整件事都没发生。
      return restoreStashAndRethrow(cwd, stashed, '同步', error);
    }
  }
  const status = await scanRepository(config, repository);
  const restoreNote = await restoreStashIfAny(cwd, stashed, '同步');
  const base = (status.ahead ?? 0) > 0 ? '同步完成；仍存在本地领先提交待推送' : '同步完成；已推送全部领先提交';
  return {
    status,
    skipped: false,
    message: restoreNote ? `${base}；${restoreNote}` : base,
  };
}

export async function pushRepository(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
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
  // 同 pull：fetchRepository 的返回值就是 Fetch 之后的状态，不必再扫一次。
  const fresh = await fetchRepository(config, repository, cwd);
  if (!fresh.available) throw new Error('仓库不可用');
  if (fresh.detached || !fresh.branch) throw safetyBlockedError('Detached HEAD 禁止 Push');
  if (!fresh.upstream) throw safetyBlockedError('当前分支没有 upstream');
  if (fresh.conflicted > 0 || fresh.inProgressOperation) throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作');
  ensureActionSnapshot(fresh, expected, 'Push');
  if ((fresh.behind ?? 0) > 0) throw safetyBlockedError('远端存在新提交或已经分叉，禁止 Push');
  if ((fresh.ahead ?? 0) === 0) {
    return { status: fresh, skipped: true, skipReason: 'not-needed', message: '没有需要推送的 commit' };
  }
  return pushCurrentHead(config, repository, cwd, expected, 'Push');
}

/**
 * 把当前 HEAD 推送到其 upstream 分支（明确 refspec，永不 force push）。
 * `syncRepository` 在 merge 成功后复用此逻辑，实现「拉 + 自动推」。
 */
async function pushCurrentHead(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  expected: { branch: string; head: string },
  action: 'Push' | '同步',
): Promise<{ status: RepositoryStatus; skipped: boolean; message: string; skipReason?: OperationSkipReason }> {
  // 与整合侧同一个读取入口：push 目的 ref 不再是另一套 `git config` 解析。
  const upstream = await readUpstreamBinding(cwd, expected.branch);
  const final = await currentBranchAndHead(cwd);
  if (final.branch !== expected.branch || final.head !== expected.head) {
    throw safetyBlockedError(`当前分支或 HEAD 已变化，${action} 已阻止`);
  }
  await runGitText(cwd, ['push', '--porcelain', upstream.remoteName, `${expected.head}:${upstream.remoteRef}`], 300_000);
  const status = await scanRepository(config, repository);
  const changedDuringPush = status.branch !== expected.branch || status.lastCommit?.hash !== expected.head;
  return {
    status,
    skipped: false,
    message: changedDuringPush ? `${action} 完成；推送期间本地分支或 HEAD 已变化，新 commit 未被推送` : `${action} 完成`,
  };
}
