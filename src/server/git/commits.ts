import type { CommitDetail, CommitPage, RepositoryCommit } from '../../shared/contracts.js';
import { invalidRequestError, notFoundError } from '../errors.js';
import { runGit } from './runner.js';

const commitHashPattern = /^[a-f0-9]{40,64}$/;
const commitPageMaxLimit = 100;
const maxCommitPatchBytes = 200_000;
const tagDecorationPrefix = 'tag: ';

export function parseTagDecorations(decoration: string): string[] {
  return decoration
    .split(', ')
    .filter((entry) => entry.startsWith(tagDecorationPrefix))
    .map((entry) => entry.slice(tagDecorationPrefix.length))
    .filter((name) => name !== '');
}

export function parseRecentCommits(output: string): RepositoryCommit[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 5 !== 0) throw new Error('读取最近提交失败');

  const commits: RepositoryCommit[] = [];
  for (let index = 0; index < fields.length; index += 5) {
    const hash = fields[index] ?? '';
    const subject = fields[index + 1] ?? '';
    const author = fields[index + 2] ?? '';
    const committedAt = fields[index + 3] ?? '';
    if (!commitHashPattern.test(hash) || !subject || !author || !committedAt) throw new Error('读取最近提交失败');
    commits.push({ hash, subject, author, committedAt, tags: parseTagDecorations(fields[index + 4] ?? '') });
  }
  return commits;
}

async function readCommits(cwd: string, limit: number, skip: number): Promise<RepositoryCommit[]> {
  const result = await runGit(cwd, [
    'log',
    `--max-count=${limit}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    '-z',
    '--date=iso-strict',
    '--format=%H%x00%s%x00%an%x00%aI%x00%D',
  ]);
  if (result.exitCode !== 0) {
    // 空仓库（还没有首个 Commit）不是错误，按空历史处理。
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.exitCode !== 0) return [];
    throw new Error(result.stderr || '读取最近提交失败');
  }
  return parseRecentCommits(result.stdout.toString('utf8'));
}

/** 提交历史分页：多取一条判断 `hasMore`，不额外发 count 查询。 */
export async function listCommitPage(cwd: string, options: { limit: number; skip: number }): Promise<CommitPage> {
  const limit = Math.min(commitPageMaxLimit, Math.max(1, Math.trunc(options.limit)));
  const skip = Math.max(0, Math.trunc(options.skip));
  const commits = await readCommits(cwd, limit + 1, skip);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

function trimLeadingLineBreaks(value: string): string {
  return value.replace(/^\n+/, '');
}

/**
 * 单条提交详情。`git show --format=` 会先输出一个空行再输出正文，
 * 因此补丁与 diffstat 都要去掉前导空行，否则渲染层会多出一条空行。
 */
export async function commitDetail(cwd: string, hash: string): Promise<CommitDetail> {
  if (!commitHashPattern.test(hash)) throw invalidRequestError('Commit 哈希无效');

  const metaResult = await runGit(cwd, [
    'show',
    '--no-patch',
    '-z',
    '--date=iso-strict',
    '--format=%H%x00%s%x00%an%x00%aI%x00%D%x00%P',
    hash,
  ]);
  // 走到这里说明仓库本身有效，`git show` 失败基本只可能是该对象不存在
  // （例如列表打开后被 rebase 掉了）。给出可行动的中文原因，不透传英文 stderr。
  if (metaResult.exitCode !== 0) throw notFoundError(`找不到 Commit：${hash.slice(0, 12)}`);

  const fields = metaResult.stdout.toString('utf8').split('\0');
  if (fields.length < 6) throw new Error('读取 Commit 详情失败');
  const [fullHash = '', subject = '', author = '', committedAt = '', decoration = '', parentsRaw = ''] = fields;

  const [bodyResult, statResult, patchResult] = await Promise.all([
    runGit(cwd, ['show', '--no-patch', '--format=%b', hash]),
    runGit(cwd, ['show', '--stat', '--no-color', '--format=', hash]),
    runGit(cwd, ['show', '--patch', '--no-color', '--no-ext-diff', '--format=', hash], 15_000, undefined, maxCommitPatchBytes),
  ]);
  if (patchResult.exitCode !== 0) throw new Error(patchResult.stderr || '读取 Commit 补丁失败');

  return {
    hash: fullHash,
    subject,
    author,
    committedAt,
    body: bodyResult.exitCode === 0 ? bodyResult.stdout.toString('utf8').trim() : '',
    parents: parentsRaw.split(' ').filter(Boolean),
    tags: parseTagDecorations(decoration),
    stat: statResult.exitCode === 0 ? trimLeadingLineBreaks(statResult.stdout.toString('utf8')).trimEnd() : '',
    patch: trimLeadingLineBreaks(patchResult.stdout.toString('utf8')),
    truncated: patchResult.stdoutTruncated,
  };
}
