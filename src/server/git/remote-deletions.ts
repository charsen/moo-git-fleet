import type { DeleteRemoteBranchRequest, TagEntry } from '../../shared/contracts.js';
import { ensureRequestedRemoteName } from './guards.js';
import { conflictError, notFoundError } from '../errors.js';
import { runGit, runGitText } from './runner.js';
import { listTags } from './tags.js';

/**
 * 远端引用的删除。这是本项目唯一会改远端数据的操作，所以护栏是刚性的：
 *
 * 1. remote 名与 ref 名先做格式校验，remote 必须真实存在；
 * 2. 删除前用 `ls-remote` 取远端当前 sha 并比对预期值，不一致就直接拒绝（先给出可读原因）；
 * 3. 真正推送时仍带 `--force-with-lease=<ref>:<sha>`——第 2 步与推送之间的竞态由它兜底，
 *    远端 ref 若被他人动过，Git 会用 `(stale info)` 拒绝，绝不硬删；
 * 4. 显式 delete refspec，不使用任何形式的全量 force。
 */

const pushTimeoutMs = 300_000;
const lsRemoteTimeoutMs = 60_000;

async function ensureRemoteExists(cwd: string, remote: string): Promise<void> {
  const remotes = (await runGitText(cwd, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.includes(remote)) throw conflictError(`仓库缺少 remote：${remote}`);
}

/** 远端 ref 当前的 sha；不存在返回 null，网络/权限失败直接抛出。 */
async function remoteRefHash(cwd: string, remote: string, ref: string): Promise<string | null> {
  const result = await runGit(cwd, ['ls-remote', remote, ref], lsRemoteTimeoutMs);
  if (result.exitCode !== 0) {
    throw conflictError(`无法读取远端 ${remote} 的引用：${result.stderr || '请检查网络与凭据'}`);
  }
  // 远端已有该 ref 时输出 `<sha>\t<ref>`；被删除过的对象会额外出现 `^{}` 剥离行，只取精确匹配。
  const line = result.stdout
    .toString('utf8')
    .split('\n')
    .find((record) => record.split('\t')[1] === ref);
  return line ? line.split('\t')[0] ?? null : null;
}

export interface RemoteBranchDeletion {
  remote: string;
  branch: string;
  head: string;
}

export async function deleteRemoteBranch(cwd: string, input: DeleteRemoteBranchRequest): Promise<RemoteBranchDeletion> {
  ensureRequestedRemoteName(input.remote);
  await ensureRemoteExists(cwd, input.remote);
  await runGitText(cwd, ['check-ref-format', `refs/heads/${input.branch}`]);
  // main/master 一律要求显式确认：删错远端主分支的影响面比其他分支大得多。
  if (['main', 'master'].includes(input.branch) && !input.confirmPrimary) {
    throw conflictError(`refs/heads/${input.branch} 是该远端的主分支，需要显式确认后才能删除`);
  }

  const ref = `refs/heads/${input.branch}`;
  const current = await remoteRefHash(cwd, input.remote, ref);
  if (!current) throw conflictError(`远端 ${input.remote} 上没有分支 ${input.branch}`);
  if (current !== input.expectedHead) throw conflictError('远端分支已变化，请先 Fetch 后重试');

  const result = await runGit(
    cwd,
    ['push', '--porcelain', '--delete', `--force-with-lease=${ref}:${input.expectedHead}`, input.remote, ref],
    pushTimeoutMs,
  );
  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString('utf8');
    const detail = `${stdout}\n${result.stderr}`;
    if (/stale info/i.test(detail)) {
      throw conflictError('远端引用在确认后被改动，已拒绝删除，请重新 Fetch 后重试');
    }
    // 远端自己会保护它的默认/当前分支：这是 Git 侧的最后一道锁，如实翻译而不是透传英文。
    if (/denyDeleteCurrent|deleting the current branch is denied/i.test(detail)) {
      throw conflictError(
        `远端 ${input.remote} 拒绝删除它当前指向的分支 refs/heads/${input.branch}；请先在远端把默认分支切到别的分支`,
      );
    }
    throw conflictError(`删除远端分支 ${input.remote}/${input.branch} 失败：${result.stderr || stdout.trim() || '请检查远端状态'}`);
  }
  // `push --delete` 正常会同时清掉本地 remote-tracking ref；仍在时再兜底 prune 一次。
  if ((await runGit(cwd, ['rev-parse', '--verify', `refs/remotes/${input.remote}/${input.branch}`])).exitCode === 0) {
    await runGit(cwd, ['remote', 'prune', input.remote], lsRemoteTimeoutMs);
  }
  return { remote: input.remote, branch: input.branch, head: input.expectedHead };
}

export async function deleteRemoteTag(cwd: string, name: string, remote: string, expectedHash: string): Promise<TagEntry> {
  ensureRequestedRemoteName(remote);
  await ensureRemoteExists(cwd, remote);
  await runGitText(cwd, ['check-ref-format', `refs/tags/${name}`]);
  const entry = (await listTags(cwd)).find((item) => item.name === name);
  if (!entry) throw notFoundError(`Tag 不存在：${name}`);
  if (entry.hash !== expectedHash) throw conflictError('Tag 已变化，请刷新后重试');

  const ref = `refs/tags/${name}`;
  const current = await remoteRefHash(cwd, remote, ref);
  if (!current) throw conflictError(`远端 ${remote} 上没有标签 ${name}`);
  if (current !== expectedHash) throw conflictError('远端标签已变化，请先 Fetch 后重试');

  const result = await runGit(
    cwd,
    ['push', '--porcelain', '--delete', `--force-with-lease=${ref}:${expectedHash}`, remote, ref],
    pushTimeoutMs,
  );
  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString('utf8');
    if (/stale info/i.test(stdout) || /stale info/i.test(result.stderr)) {
      throw conflictError('远端引用在确认后被改动，已拒绝删除，请重新 Fetch 后重试');
    }
    throw conflictError(`删除远端标签 ${name} 失败：${result.stderr || stdout.trim() || '请检查远端状态'}`);
  }
  return entry;
}
