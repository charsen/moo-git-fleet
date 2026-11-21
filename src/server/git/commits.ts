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

/**
 * 从 `%D` 装饰里抽出指向该提交的分支名，用于「分支数」展示。
 * `git log --format=%D` 把同一个提交上的所有引用拼在一起，形如：
 *   `HEAD -> main, origin/main, origin/HEAD, tag: v1.0, dev`
 * 这里只保留本地/远端分支：去掉 `HEAD -> ` 前缀（保留被指向的分支名），
 * 丢掉 `tag: ` 与只表示符号引用的 `origin/HEAD`。远端分支保留 `origin/main` 原样，
 * 便于用户区分本地与远端。
 */
export function parseBranchDecorations(decoration: string): string[] {
  const branches = new Set<string>();
  for (const raw of decoration.split(', ')) {
    const entry = raw.trim();
    if (!entry || entry.startsWith(tagDecorationPrefix)) continue;
    // `HEAD -> main`：HEAD 只是指向当前分支的符号引用，这里记下真正的分支名。
    const name = entry.startsWith('HEAD -> ') ? entry.slice('HEAD -> '.length) : entry;
    if (!name || name === 'HEAD') continue;
    // `origin/HEAD` 是远端默认分支的符号引用，不是真实可检出的分支，跳过以免误计分支数。
    if (name.endsWith('/HEAD')) continue;
    branches.add(name);
  }
  return [...branches];
}

export function parseRecentCommits(output: string): RepositoryCommit[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  // 每条提交 6 个字段：hash / subject / author / committedAt / decoration / parents。
  if (fields.length % 6 !== 0) throw new Error('读取最近提交失败');

  const commits: RepositoryCommit[] = [];
  for (let index = 0; index < fields.length; index += 6) {
    const hash = fields[index] ?? '';
    const subject = fields[index + 1] ?? '';
    const author = fields[index + 2] ?? '';
    const committedAt = fields[index + 3] ?? '';
    // subject 允许为空（git commit --allow-empty-message）；空标题不能拖垮整段历史。
    if (!commitHashPattern.test(hash) || !author || !committedAt) throw new Error('读取最近提交失败');
    const decoration = fields[index + 4] ?? '';
    const parentsRaw = fields[index + 5] ?? '';
    commits.push({
      hash,
      subject,
      author,
      committedAt,
      tags: parseTagDecorations(decoration),
      branches: parseBranchDecorations(decoration),
      parents: parentsRaw.split(' ').filter(Boolean),
    });
  }
  return commits;
}

async function readCommits(cwd: string, limit: number, skip: number, tip: string, order?: 'date' | 'topo'): Promise<RepositoryCommit[]> {
  const result = await runGit(cwd, [
    'log',
    `--max-count=${limit}`,
    // 时间序必须显式用 --date-order：默认的 log 顺序允许父提交先于某个子提交输出（时钟偏斜时），
    // 提交图会为已经出现过的父提交再开一条永不闭合的泳道。搜索路径一直用 --date-order，这里对齐。
    ...(order === 'topo' ? ['--topo-order'] : order === 'date' ? ['--date-order'] : []),
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    '-z',
    '--date=iso-strict',
    '--format=%H%x00%s%x00%an%x00%aI%x00%D%x00%P',
    tip,
    '--',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || '读取最近提交失败');
  }
  return parseRecentCommits(result.stdout.toString('utf8'));
}

/** 浅克隆检测：浅克隆的历史只到 `.git/shallow` 记录的新边界，不能当完整历史展示。 */
export async function isShallowRepository(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['rev-parse', '--is-shallow-repository'], 10_000);
  return result.exitCode === 0 && result.stdout.toString('utf8').trim() === 'true';
}

/** 提交历史分页：多取一条判断 `hasMore`，不额外发 count 查询。 */
export async function listCommitPage(cwd: string, options: { limit: number; skip: number; ref?: string; tip?: string; order?: 'date' | 'topo' }): Promise<CommitPage> {
  const shallow = await isShallowRepository(cwd);
  const limit = Math.min(commitPageMaxLimit, Math.max(1, Math.trunc(options.limit)));
  const skip = Math.max(0, Math.trunc(options.skip));
  const ref = options.ref ?? 'HEAD';
  if (ref !== 'HEAD') {
    // 允许直接传提交哈希：任意两个提交对比用它作为端点，不再强迫先造临时引用。
    const isObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref);
    if (!isObjectId && (!/^refs\/(heads|remotes|tags)\/.+/.test(ref) || (await runGit(cwd, ['check-ref-format', ref])).exitCode !== 0))
      throw invalidRequestError('引用无效');
  }
  if (options.tip && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.tip)) throw invalidRequestError('分页起点无效');
  const resolved = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${options.tip ?? ref}^{commit}`]);
  if (resolved.exitCode !== 0) {
    if (ref === 'HEAD' && !options.tip) return { commits: [], hasMore: false, tip: null, ...(shallow ? { shallow } : {}) };
    // 空仓库（unborn HEAD）里分支名存在但还没有提交：按分支请求会解析失败，
    // 这是「暂无提交」而不是「分支被删了」。只有仓库已有 HEAD 时才算真的找不到。
    const unborn = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (unborn.exitCode !== 0 && !options.tip) return { commits: [], hasMore: false, tip: null, ...(shallow ? { shallow } : {}) };
    throw notFoundError('分支或分页起点已不存在，请刷新提交历史');
  }
  const tip = resolved.stdout.toString('utf8').trim();
  const commits = await readCommits(cwd, limit + 1, skip, tip, options.order);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit, tip, ...(shallow ? { shallow } : {}) };
}

function trimLeadingLineBreaks(value: string): string {
  return value.replace(/^\n+/, '');
}

/** Shared endpoint change reader: paths use NUL fields, patches have a bounded preview. */
export async function readRevisionChanges(cwd: string, base: string | null, tip: string, filePath?: string): Promise<Pick<CommitDetail, 'files' | 'patch' | 'stat' | 'truncated'>> {
  const changeArgs = base ? ['diff', base, tip] : ['show', '--format=', tip];
  const filesResult = await runGit(cwd, base
      ? ['diff', '--name-status', '-z', '-M', base, tip, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', tip, '--']);
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
  const [statResult, patchResult] = await Promise.all([
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

  return { files: selectedFiles, patch, stat: statResult.exitCode === 0 ? trimLeadingLineBreaks(statResult.stdout.toString('utf8')).trimEnd() : '', truncated: patchResult.stdoutTruncated };
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
  const [changes, bodyResult] = await Promise.all([
    readRevisionChanges(cwd, parents[0] ?? null, hash, filePath),
    runGit(cwd, ['show', '--no-patch', '--format=%b', hash]),
  ]);
  return {
    hash: fullHash,
    subject,
    author,
    committedAt,
    body: bodyResult.exitCode === 0 ? bodyResult.stdout.toString('utf8').trim() : '',
    parents,
    tags: parseTagDecorations(decoration),
    ...changes,
  };
}
