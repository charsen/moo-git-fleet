import type {
  ReplayKind,
  ReplayResult,
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
} from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { conflictError, invalidRequestError, safetyBlockedError } from '../errors.js';
import { repositoryInternalState, scanRepository } from './scanner.js';
import { runGit, runGitText } from './runner.js';

/**
 * 应用单个提交到当前分支：`revert`（反向应用）与 `cherry-pick`（正向应用）。
 *
 * 为什么需要它：这两个操作在项目里早就「能善后」——`conflicts.ts` 有完整的
 * continue / abort 映射，`conflict-preview.ts` 也能预览它们的冲突。
 * 但**没有发起入口**：用户在应用内只会看到一个「进行中的 revert」，
 * 却无法开始一个。于是「回退一个坏提交」这种高频需求只能回终端。
 *
 * 冲突处理复用既有链路：失败且 Git 留下 REVERT_HEAD / CHERRY_PICK_HEAD 时，
 * 抛带 `mergePausedErrorCode` 的冲突错误，界面据此切到工作区，
 * 之后由既有的「继续 / 中止」处理，**不另造一套暂停态的表示**。
 */

const replayTimeoutMs = 300_000;
/**
 * 动作文案。
 *
 * 用中文名（与界面上的「回退此提交 / 拣选到当前分支」按钮对齐），
 * 但**暂停提示里会再带上 git 的操作名**：界面在仓库状态里显示的是
 * `正在进行 cherry-pick` 这类原始名（这是既有约定），两种叫法出现在同一流程里
 * 会让人以为是两件事。
 */
const replayLabels = { revert: '回退提交', 'cherry-pick': '拣选提交' } as const;

/**
 * 前置校验。
 *
 * 工作区要求：**已跟踪的改动必须为空**（暂存 / 已改 / 已删 / 已改名），
 * 因为 git 在这几种情况下会拒绝或产生难以预料的合并结果；
 * 而**未跟踪文件不拦**——git 自己能处理，拦掉反而把「本地有几个没加入版本管理的文件」
 * 这种常见状态变成硬门槛（Pull 那边拦它是为了对齐远端，场景不同）。
 */
async function ensureReplayable(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<RepositoryStatus> {
  if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止提交');
  const status = await scanRepository(config, repository);
  if (!status.available) throw safetyBlockedError('仓库当前不可用，无法应用提交');
  if (status.conflicted > 0 || status.inProgressOperation) {
    throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作，请先处理后再应用提交');
  }
  if (status.staged + status.modified + status.deleted + status.renamed > 0) {
    throw safetyBlockedError('工作区有未提交的改动：请先提交或暂存后再执行');
  }
  if (!(await headCommit(cwd))) throw safetyBlockedError('仓库还没有任何提交，无法应用提交');
  return status;
}

async function headCommit(cwd: string): Promise<string | null> {
  const hash = await runGitText(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '');
  return hash.trim() || null;
}

/** 校验来源提交标识并解析成完整 sha；只接受十六进制，避免任何值落进参数位。 */
async function resolveSource(cwd: string, hash: string): Promise<string> {
  const value = hash.trim();
  if (!/^[0-9a-fA-F]{7,64}$/.test(value)) throw invalidRequestError('提交标识无效');
  const resolved = await runGitText(cwd, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]).catch(() => '');
  if (!resolved) throw invalidRequestError('仓库里找不到这个提交');
  return resolved;
}

async function replay(
  kind: ReplayKind,
  cwd: string,
  source: string,
): Promise<ReplayResult> {
  const label = replayLabels[kind];
  const before = await headCommit(cwd);
  // `-c core.editor=true` 是第二道保险：`--no-edit` 已经避免打开编辑器，
  // 万一某个 git 版本或配置走另一条路，也不会因为等编辑器而卡住。
  const args =
    kind === 'revert'
      ? ['-c', 'core.editor=true', 'revert', '--no-edit', '--', source]
      : ['cherry-pick', '--', source];
  const result = await runGit(cwd, args, replayTimeoutMs);

  if (result.exitCode !== 0) {
    const internal = await repositoryInternalState(cwd);
    // 只有在 Git 确实留下了该操作的进行中标记时才说「已暂停」——
    // 否则（例如地址冲突导致直接失败）应当照原样把 git 的话给用户。
    if (internal.operation === kind) {
      const detail = result.stderr || result.stdout.toString('utf8').trim();
      throw conflictError(
        `${label}（${kind}）已暂停，请在工作区处理后继续，也可以中止${detail ? `。Git 提示：${detail}` : ''}`,
        { code: mergePausedErrorCode },
      );
    }
    throw conflictError(result.stderr || result.stdout.toString('utf8').trim() || `${label}失败`);
  }

  const after = await headCommit(cwd);
  // 成功却看不到新提交，说明我们对结果的理解与事实不符，必须报出来而不是假装成功。
  if (!after || after === before) throw new Error(`${label}结束但 HEAD 未发生变化`);
  return { kind, source, hash: after, message: `${label}完成：${after.slice(0, 7)}` };
}

/** 反向应用某个提交（`git revert`）：产生一个新提交来抵消它的改动。 */
export async function revertCommit(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { hash: string },
): Promise<ReplayResult> {
  await ensureReplayable(config, repository, cwd);
  const source = await resolveSource(cwd, input.hash);
  return replay('revert', cwd, source);
}

/** 正向应用某个提交（`git cherry-pick`）：把它的改动搬到当前分支。 */
export async function cherryPickCommit(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { hash: string },
): Promise<ReplayResult> {
  await ensureReplayable(config, repository, cwd);
  const source = await resolveSource(cwd, input.hash);
  return replay('cherry-pick', cwd, source);
}
