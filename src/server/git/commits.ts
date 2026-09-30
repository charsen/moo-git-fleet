import type { CommitDetail, CommitFileChange, CommitPage, RepositoryCommit } from '../../shared/contracts.js';
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

async function readCommits(cwd: string, limit: number, skip: number, tip: string): Promise<RepositoryCommit[]> {
  const result = await runGit(cwd, [
    'log',
    `--max-count=${limit}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    '-z',
    '--date=iso-strict',
    '--format=%H%x00%s%x00%an%x00%aI%x00%D',
    tip,
    '--',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || '读取最近提交失败');
  }
  return parseRecentCommits(result.stdout.toString('utf8'));
}

/** 提交历史分页：多取一条判断 `hasMore`，不额外发 count 查询。 */
export async function listCommitPage(cwd: string, options: { limit: number; skip: number; ref?: string; tip?: string }): Promise<CommitPage> {
  const limit = Math.min(commitPageMaxLimit, Math.max(1, Math.trunc(options.limit)));
  const skip = Math.max(0, Math.trunc(options.skip));
  const ref = options.ref ?? 'HEAD';
  if (ref !== 'HEAD') {
    if (!/^refs\/(heads|remotes)\/.+/.test(ref) || (await runGit(cwd, ['check-ref-format', ref])).exitCode !== 0)
      throw invalidRequestError('分支引用无效');
  }
  if (options.tip && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.tip)) throw invalidRequestError('分页起点无效');
  const resolved = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${options.tip ?? ref}^{commit}`]);
  if (resolved.exitCode !== 0) {
    if (ref === 'HEAD' && !options.tip) return { commits: [], hasMore: false, tip: null };
    throw notFoundError('分支或分页起点已不存在，请刷新提交历史');
  }
  const tip = resolved.stdout.toString('utf8').trim();
  const commits = await readCommits(cwd, limit + 1, skip, tip);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit, tip };
}

function trimLeadingLineBreaks(value: string): string {
  return value.replace(/^\n+/, '');
}

/**
 * 单条提交详情。`git show --format=` 会先输出一个空行再输出正文，
 * 因此补丁与 diffstat 都要去掉前导空行，否则渲染层会多出一条空行。
 */
export async function commitDetail(cwd: string, hash: string, filePath?: string): Promise<CommitDetail> {
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

  const parents = parentsRaw.split(' ').filter(Boolean);
  // 合并提交按第一父提交展示完整变化；根提交从空树展示。
  const changeArgs = parents[0] ? ['diff', parents[0], hash] : ['show', '--format=', hash];
  const filesResult = await runGit(cwd, parents[0]
      ? ['diff', '--name-status', '-z', '-M', parents[0], hash, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', hash, '--']);
  if (filesResult.exitCode !== 0 || filesResult.stdoutTruncated) throw new Error('读取 Commit 文件清单失败');
  const fieldsByPath = filesResult.stdout.toString('utf8').split('\0');
  if (fieldsByPath.at(-1) === '') fieldsByPath.pop();
  const files: CommitFileChange[] = [];
  for (let index = 0; index < fieldsByPath.length;) {
    const status = fieldsByPath[index++]!;
    const firstPath = fieldsByPath[index++];
    const renamed = /^[RC]/.test(status);
    const filePath = renamed ? fieldsByPath[index++] : firstPath;
    if (!filePath || !firstPath || !/^[AMDTRCUXB][0-9]*$/.test(status)) throw new Error('读取 Commit 文件清单失败');
    files.push({ path: filePath, originalPath: renamed ? firstPath : null, status: status[0]!, patch: null });
  }
  const selectedFiles = filePath ? files.filter(file => file.path === filePath) : files;
  const paths = filePath ? [...new Set(selectedFiles.flatMap(file => [file.path, ...(file.originalPath ? [file.originalPath] : [])]))] : [];
  const noFileChange = Boolean(filePath && !selectedFiles.length);
  const emptyDiff = { stdout: Buffer.alloc(0), stderr: '', exitCode: 0, stdoutTruncated: false };
  const [bodyResult, statResult, patchResult] = await Promise.all([
    runGit(cwd, ['show', '--no-patch', '--format=%b', hash]),
    noFileChange ? Promise.resolve(emptyDiff) : runGit(cwd, ['--literal-pathspecs', ...changeArgs, '--stat', '--no-color', '-M', '--', ...paths]),
    noFileChange ? Promise.resolve(emptyDiff) : runGit(cwd, ['--literal-pathspecs', ...changeArgs, '--patch', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--', ...paths], 15_000, undefined, maxCommitPatchBytes),
  ]);
  if (patchResult.exitCode !== 0) throw new Error(patchResult.stderr || '读取 Commit 补丁失败');
  // No matching change (e.g. a simplified merge history item) is an explicit empty result.
  const patch = filePath && !selectedFiles.length ? '' : trimLeadingLineBreaks(patchResult.stdout.toString('utf8'));
  const sections = patch.split(/(?=^diff --git )/m).filter(section => section.startsWith('diff --git '));
  selectedFiles.forEach((file, index) => {
    file.patch = patchResult.stdoutTruncated && index >= sections.length - 1 ? null : sections[index] ?? null;
  });

  return {
    hash: fullHash,
    subject,
    author,
    committedAt,
    body: bodyResult.exitCode === 0 ? bodyResult.stdout.toString('utf8').trim() : '',
    parents,
    tags: parseTagDecorations(decoration),
    stat: statResult.exitCode === 0 ? trimLeadingLineBreaks(statResult.stdout.toString('utf8')).trimEnd() : '',
    patch,
    truncated: patchResult.stdoutTruncated,
    files: selectedFiles,
  };
}
