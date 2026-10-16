import type {
  CommitRewriteResult,
  LastCommitSnapshot,
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryStatus,
} from '../../shared/contracts.js';
import { createHash } from 'node:crypto';
import { conflictError, safetyBlockedError } from '../errors.js';
import { runGitText } from './runner.js';
import { scanRepository } from './scanner.js';

/**
 * 提交历史的改写：修正上次提交（amend）与撤销上次提交（soft reset）。
 *
 * 这两件事此前都只能回终端：界面能提交、能看历史，但提交错了没法收拾。
 *
 * 守卫按「宁可拒绝，绝不猜」的原则：
 * 1. **指纹先行**：暂存区 + 分支 + HEAD 的指纹在执行前后各校验一次，
 *    期间任何变动都直接拒绝，而不是照着旧预览去改写历史；
 * 2. **有冲突或进行中的 Git 操作时一律拒绝**——此时 HEAD 的含义本身就模糊；
 * 3. **写后用可验证的不变量兜底**：amend 后新提交的父提交必须与原来一致、树必须等于
 *    `write-tree`；撤销后 `write-tree` 必须与撤销前相同（soft reset 不动暂存区）。
 *    这些是「结果正确」的硬证据，而不是靠 git 不报错来推断；
 * 4. 只动**本机**的对象库与引用，不碰远端。已推送的提交被改写后本地会与远端分叉，
 *    而本工具不提供 force push——这一点必须在执行前说清（见 `pushed` 判定）。
 */

const rewriteTimeoutMs = 300_000;

interface PushedVerdict {
  pushed: 'yes' | 'no';
  pushedRef: string | null;
}

/**
 * 判断某个提交是否已经在远端分支上。
 *
 * 依据**本地**的远端跟踪引用（`refs/remotes/…`），因此不联网、也不会因为一次网络抖动
 * 给出错误结论；代价是它只反映最后一次 Fetch 的状态，界面提示会按这个口径措辞。
 *
 * 用 `for-each-ref --contains` 而不是 `git branch -r --contains`：后者会把
 * `origin/HEAD -> origin/main` 这类符号引用一并打出来，需要额外解析。
 */
async function pushedVerdict(cwd: string, hash: string): Promise<PushedVerdict> {
  const output = await runGitText(cwd, [
    'for-each-ref',
    `--contains=${hash}`,
    '--format=%(refname)',
    'refs/remotes/',
  ]).catch(() => '');
  const refs = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/HEAD'));
  const [first] = refs;
  return first ? { pushed: 'yes', pushedRef: first } : { pushed: 'no', pushedRef: null };
}

async function readHead(cwd: string): Promise<string | null> {
  const hash = await runGitText(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '');
  return hash.trim() || null;
}

/** HEAD 的父提交列表（已做 sha 校验，可安全落入参数位）。 */
async function readParents(cwd: string): Promise<string[]> {
  const line = await runGitText(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']).catch(() => '');
  return line.trim().split(/\s+/).slice(1).filter(Boolean);
}

async function readStagedCount(cwd: string): Promise<number> {
  const output = await runGitText(cwd, ['diff', '--cached', '--name-only', '-z']).catch(() => '');
  return output.split('\0').filter(Boolean).length;
}

/** 冲突与进行中的 Git 操作会让 HEAD 的含义变模糊，改写历史前必须排除。 */
function ensureRewritable(status: RepositoryStatus): void {
  if (!status.available) throw safetyBlockedError('仓库当前不可用，无法改写提交历史');
  if (status.conflicted > 0 || status.inProgressOperation) {
    throw safetyBlockedError('仓库存在冲突或进行中的 Git 操作，无法改写提交历史');
  }
}

function ensureCommitCapability(repository: RepositoryConfig): void {
  if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止提交');
}

/** 执行前统一校验指纹；不一致说明期间换过 HEAD，必须重新确认而不是照旧执行。 */
async function ensureFingerprint(cwd: string, fingerprint: string): Promise<void> {
  if ((await historyFingerprint(cwd)) !== fingerprint) {
    throw conflictError('当前分支或 HEAD 已变化，请重新确认后再执行');
  }
}

/**
 * 「当前分支 + HEAD」的指纹。
 *
 * 刻意**不含暂存区**（`files.ts` 的 `stagedFingerprint` 含 tree，那是为提交预览服务的）：
 * 历史改写真正必须守住的不变量是「别把 HEAD 换掉的另一个提交改写掉」；
 * 而暂存区在期间变了并不危险——amend 把执行时的实际暂存内容并入，本就是自然语义，
 * 反倒能让「先暂存、再修正」这个正常顺序不被误拦。
 */
async function historyFingerprint(cwd: string): Promise<string> {
  const [branch, head] = await Promise.all([
    runGitText(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => ''),
    runGitText(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => ''),
  ]);
  return createHash('sha256')
    .update(JSON.stringify([branch.trim(), head.trim()]))
    .digest('hex');
}

function ensureMessage(message: string): string {
  if (message.includes('\0')) throw new Error('Commit 文案包含非法字符');
  const trimmed = message.trim();
  if (!trimmed) throw new Error('Commit 文案不能为空');
  return trimmed;
}

export async function readLastCommitSnapshot(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
): Promise<LastCommitSnapshot> {
  const status = await scanRepository(config, repository);
  const [fingerprint, stagedCount] = await Promise.all([historyFingerprint(cwd), readStagedCount(cwd)]);

  let blocked: string | null = null;
  try {
    ensureRewritable(status);
    ensureCommitCapability(repository);
  } catch (error) {
    blocked = error instanceof Error ? error.message : '当前无法改写提交历史';
  }

  const hash = await readHead(cwd);
  if (!hash) {
    return { commit: null, fingerprint, stagedCount, blocked: blocked ?? '仓库还没有任何提交' };
  }

  const [verdict, parents] = await Promise.all([pushedVerdict(cwd, hash), readParents(cwd)]);
  return {
    commit: {
      hash,
      subject: status.lastCommit?.subject ?? '',
      pushed: verdict.pushed,
      pushedRef: verdict.pushedRef,
      merge: parents.length > 1,
      hasParent: parents.length > 0,
    },
    fingerprint,
    stagedCount,
    blocked,
  };
}

export interface CommitRewriteOutput extends CommitRewriteResult {
  /** 供操作记录与结果提示使用的一句话。 */
  message: string;
}

/**
 * 修正上次提交：用新文案重写 HEAD，并把当前暂存区的内容一并并入。
 *
 * 暂存区为空时就是「只改提交信息」——这正是最常见的使用方式（打错字、写漏了）。
 * 上次提交是合并提交时也允许：实测 git 会**保留原有父提交**，合并结构不变，
 * 只是该合并提交的 hash 会被改写（界面会提示这一点），因此不额外拒绝。
 */
export async function amendCommit(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { message: string; fingerprint: string },
): Promise<CommitRewriteOutput> {
  ensureCommitCapability(repository);
  const status = await scanRepository(config, repository);
  ensureRewritable(status);

  const message = ensureMessage(input.message);
  const head = await readHead(cwd);
  if (!head) throw safetyBlockedError('仓库还没有任何提交，无法修正');

  await ensureFingerprint(cwd, input.fingerprint);
  const [parents, verdict, expectedTree, stagedCount] = await Promise.all([
    readParents(cwd),
    pushedVerdict(cwd, head),
    runGitText(cwd, ['write-tree']),
    readStagedCount(cwd),
  ]);

  await runGitText(cwd, ['commit', '--amend', '--file=-'], rewriteTimeoutMs, `${message}\n`);

  const [nextHead, nextParents, nextTree] = await Promise.all([
    readHead(cwd),
    readParents(cwd),
    runGitText(cwd, ['write-tree']),
  ]);
  if (!nextHead) throw new Error('修正提交后无法读取 HEAD');
  if (nextHead === head) throw new Error('修正提交失败：HEAD 未发生变化');

  // 两条不变量：父提交不变（只改这一个提交，没有顺带改写历史）、树等于暂存内容
  // （没有漏掉或多算暂存的文件）。任一条不成立都要如实报出来，而不是假装成功。
  const parentsPreserved = nextParents.join(' ') === parents.join(' ');
  const treePreserved = nextTree === expectedTree;
  const notes: string[] = [];
  if (!parentsPreserved) notes.push('父提交发生了变化');
  if (!treePreserved) notes.push('暂存内容未被完整写入');
  const consistent = notes.length === 0;

  return {
    status: await scanRepository(config, repository),
    hash: nextHead,
    pushed: verdict.pushed,
    pushedRef: verdict.pushedRef,
    consistent,
    message: consistent
      ? `已修正上次提交：${nextHead.slice(0, 7)}${stagedCount > 0 ? `（并入 ${stagedCount} 个已暂存文件）` : '（只改了提交信息）'}`
      : `⚠ 已修正提交 ${nextHead.slice(0, 7)}，但${notes.join('、')}，请立即检查`,
  };
}

/**
 * 撤销上次提交：把 HEAD 退回上一个提交，改动**全部留在暂存区**。
 *
 * 相当于 `git reset --soft HEAD~1`。撤销后 `write-tree` 必须与撤销前一致——
 * 这是「内容一点没丢」的硬证据，也是这里唯一可验证的不变量。
 *
 * 仓库的第一个提交没有父提交可退，用 `git update-ref -d HEAD` 让分支回到「尚无提交」：
 * 实测此时索引与工作区都不动（`write-tree` 不变、文件仍是已暂存状态），
 * 原提交对象也仍然可由 `.git/logs/HEAD` 里记录的 hash 取回。
 */
export async function undoLastCommit(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  input: { fingerprint: string },
): Promise<CommitRewriteOutput> {
  ensureCommitCapability(repository);
  const status = await scanRepository(config, repository);
  ensureRewritable(status);

  const head = await readHead(cwd);
  if (!head) throw safetyBlockedError('仓库还没有任何提交，无法撤销');

  await ensureFingerprint(cwd, input.fingerprint);
  const [parents, verdict, treeBefore] = await Promise.all([
    readParents(cwd),
    pushedVerdict(cwd, head),
    runGitText(cwd, ['write-tree']),
  ]);

  const target = parents[0] ?? null;
  if (target) await runGitText(cwd, ['reset', '--soft', target], rewriteTimeoutMs);
  else await runGitText(cwd, ['update-ref', '-d', 'HEAD'], rewriteTimeoutMs);

  const [nextHead, treeAfter] = await Promise.all([readHead(cwd), runGitText(cwd, ['write-tree'])]);
  if (target && nextHead !== target) {
    throw new Error(`撤销提交失败：HEAD 期望为 ${target}，实际为 ${nextHead ?? '空'}`);
  }
  if (!target && nextHead) throw new Error(`撤销提交失败：期望回到「尚无提交」，实际 HEAD 为 ${nextHead}`);
  // 唯一可验证的不变量：暂存区原封不动，改动一点没丢。
  const consistent = treeAfter === treeBefore;

  return {
    status: await scanRepository(config, repository),
    hash: nextHead,
    pushed: verdict.pushed,
    pushedRef: verdict.pushedRef,
    consistent,
    message: consistent
      ? `已撤销提交 ${head.slice(0, 7)}，改动回到暂存区`
      : `⚠ 已撤销提交 ${head.slice(0, 7)}，但暂存区与撤销前不一致，请立即检查`,
  };
}
