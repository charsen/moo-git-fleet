import { randomUUID } from 'node:crypto';
import type { CommitPage, CommitPageQuery, RepositoryCommit } from '../../shared/contracts.js';
import { commitPageQuerySchema } from '../../shared/schemas.js';
import { invalidRequestError, notFoundError } from '../errors.js';
import { listCommitPage, parseRecentCommits } from './commits.js';
import { runGit } from './runner.js';

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const snapshots = new Map<string, { cwd: string; key: string; tips: string[]; createdAt: number }>();
const snapshotLifetime = 30 * 60_000;
const maxReadBytes = 8_000_000;

async function checked(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await runGit(cwd, args, 30_000, input, maxReadBytes);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取历史失败，请刷新后重试');
  if (result.stdoutTruncated) throw new Error('历史读取结果过大，请缩小范围或搜索条件');
  return result.stdout.toString('utf8');
}

async function allTips(cwd: string): Promise<string[]> {
  const refs = await checked(cwd, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const objects = [...new Set([...refs.trim().split('\n'), head.exitCode === 0 ? head.stdout.toString('utf8').trim() : ''].filter(value => oid.test(value)))];
  if (!objects.length) return [];
  // Peel annotated (including nested) tags and ignore tags pointing at trees/blobs.
  const peeled = await checked(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], objects.map(value => `${value}^{commit}\n`).join(''));
  return [...new Set(peeled.trim().split('\n').filter(line => /^[a-f0-9]{40,64} commit$/.test(line)).map(line => line.split(' ')[0]!))];
}

/** The status arity determines path boundaries; filenames are never split on newlines. */
export function parseFileHistory(output: string, requestedPath: string, search?: { text: string; field: 'message' | 'author' }): RepositoryCommit[] {
  const fields = output.split('\0');
  const commits: RepositoryCommit[] = [];
  let index = 0;
  let currentPath = requestedPath;
  let count = 0;
  while (index < fields.length && fields[index] !== '') {
    if (++count > 100_000) throw invalidRequestError('文件历史过长，请从更近的分支或提交起点查找');
    const metadata = fields.slice(index, index + 5);
    const commit = parseRecentCommits([...metadata, ''].join('\0'))[0]!;
    index += 5;
    const email = search ? fields[index++] ?? '' : '';
    const message = search ? fields[index++] ?? '' : '';
    if (fields[index++] !== '') throw new Error('读取文件历史格式失败');
    const changes: Array<{ path: string; oldPath?: string }> = [];
    while (index < fields.length && fields[index] !== '' && !oid.test(fields[index]!)) {
      const status = fields[index++]!.replace(/^\n/, '');
      if (!/^[AMDTRCUXB][0-9]*$/.test(status)) throw new Error('读取文件历史变化失败');
      const first = fields[index++];
      const renamed = /^[RC]/.test(status);
      const next = renamed ? fields[index++] : first;
      if (!first || !next) throw new Error('读取文件历史路径失败');
      changes.push({ path: next, ...(status.startsWith('R') ? { oldPath: first } : {}) });
    }
    const change = changes.find(item => item.path === currentPath) ?? changes[0];
    commit.filePath = change?.path ?? currentPath;
    if (change?.oldPath) currentPath = change.oldPath;
    const text = search?.field === 'author' ? `${commit.author}\n${email}` : message;
    if (!search || text.toLocaleLowerCase().includes(search.text.toLocaleLowerCase())) commits.push(commit);
  }
  if (fields.slice(index).some(value => value !== '')) throw new Error('读取文件历史尾部失败');
  return commits;
}

async function hashCandidates(cwd: string, search: string, tips: string[], excludeTip?: string): Promise<string[]> {
  if (!/^[a-f0-9]{4,64}$/i.test(search)) throw invalidRequestError('SHA 前缀至少需要 4 位十六进制字符');
  const objects = (await checked(cwd, ['rev-parse', `--disambiguate=${search.toLowerCase()}`])).trim().split('\n').filter(value => oid.test(value));
  if (objects.length > 64) throw invalidRequestError('SHA 前缀匹配过多，请输入更多字符');
  if (!objects.length) return [];
  const types = await checked(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${objects.join('\n')}\n`);
  const reachable: string[] = [];
  for (const line of types.trim().split('\n')) {
    if (!line.endsWith(' commit')) continue;
    const hash = line.split(' ')[0]!;
    // Subtract the pinned history union: empty output means this commit is reachable.
    const excluded = await checked(cwd, ['rev-list', '--max-count=1', '--stdin'], `${hash}\n${tips.map(tip => `^${tip}\n`).join('')}`);
    if (!excluded.trim()) {
      if (excludeTip) {
        const ancestor = await runGit(cwd, ['merge-base', '--is-ancestor', hash, excludeTip]);
        if (ancestor.exitCode === 0) continue;
        if (ancestor.exitCode !== 1) throw new Error('读取历史范围失败');
      }
      reachable.push(hash);
    }
  }
  return reachable;
}

export async function readHistoryPage(cwd: string, query: CommitPageQuery): Promise<CommitPage> {
  const options = commitPageQuerySchema.parse(query);
  const range = ['outgoing', 'incoming', 'compare'].includes(options.scope ?? '');
  if (options.excludeTip && (!range || !options.tip)) throw invalidRequestError('范围分页需同时指定两端提交');
  if (range && (Boolean(options.tip) !== Boolean(options.excludeTip))) throw invalidRequestError('范围分页需同时指定两端提交');
  if (range && (options.filePath || options.snapshot)) throw invalidRequestError('范围历史不能使用文件路径或全仓快照');
  if (['outgoing', 'incoming'].includes(options.scope ?? '') && !options.ref?.startsWith('refs/heads/')) throw invalidRequestError('待推送或待拉取历史需指定本地分支');
  if (options.scope === 'compare') {
    if (!options.ref?.startsWith('refs/') || !options.baseRef || (await runGit(cwd, ['check-ref-format', options.baseRef])).exitCode !== 0) throw invalidRequestError('对比需指定有效的来源与基准分支');
  } else if (options.baseRef) throw invalidRequestError('只有分支对比允许指定基准');
  if (options.scope === 'all' && options.filePath) throw invalidRequestError('单文件历史需指定分支或提交起点');
  if (options.scope !== 'all' && !range && !options.search && !options.filePath && !options.snapshot)
    return listCommitPage(cwd, options);
  const key = JSON.stringify([options.scope ?? 'ref', options.ref ?? 'HEAD', options.search ?? '', options.searchField ?? 'message', options.filePath ?? '']);
  let tips: string[];
  let snapshot: string | undefined;
  let excludeTip: string | undefined;
  if (options.scope === 'all') {
    const now = Date.now();
    for (const [id, value] of snapshots) if (now - value.createdAt > snapshotLifetime) snapshots.delete(id);
    if (options.snapshot) {
      const stored = snapshots.get(options.snapshot);
      if (!stored || stored.cwd !== cwd || stored.key !== key) throw notFoundError('历史快照已过期，请刷新后重试');
      tips = stored.tips;
      snapshot = options.snapshot;
    } else {
      tips = await allTips(cwd);
      snapshot = randomUUID();
      if (snapshots.size >= 128) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(snapshot, { cwd, key, tips, createdAt: now });
    }
  } else {
    if (options.snapshot) throw invalidRequestError('历史范围与快照不匹配');
    const page = await listCommitPage(cwd, { ref: options.ref, tip: options.tip, limit: 1, skip: 0 });
    tips = page.tip ? [page.tip] : [];
    if (range) {
      if (options.excludeTip) {
        const verified = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${options.excludeTip}^{commit}`]);
        if (verified.exitCode !== 0) throw notFoundError('范围快照已失效，请刷新后重试');
        excludeTip = verified.stdout.toString('utf8').trim();
      } else {
        const baseRef = options.scope === 'compare' ? options.baseRef! : (await checked(cwd, ['for-each-ref', '--format=%(upstream)', '--', options.ref!])).trim();
        if (!baseRef) throw invalidRequestError('该分支未关联 upstream，无法确定待推送或待拉取范围');
        const verified = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`]);
        if (verified.exitCode !== 0) throw notFoundError('基准或 upstream 引用不可用，请刷新或 Fetch 后重试');
        excludeTip = verified.stdout.toString('utf8').trim();
        if (options.scope === 'incoming') [tips, excludeTip] = [[excludeTip], tips[0]];
      }
    }
  }
  const result = (commits: RepositoryCommit[], hasMore: boolean): CommitPage => ({ commits, hasMore, tip: options.scope === 'all' ? null : tips[0] ?? null, ...(snapshot ? { snapshot } : {}), ...(excludeTip ? { excludeTip } : {}) });
  if (!tips.length) return result([], false);

  const isHash = options.search && options.searchField === 'hash';
  const candidates = isHash ? await hashCandidates(cwd, options.search!, tips, excludeTip) : null;
  if (candidates && !candidates.length) return result([], false);
  // Git --grep/--author can hide a rename before --follow discovers the old path.
  // Walk the file chain first, then apply search on the server, preserving rename continuity.
  const fileFilter = Boolean(options.search && options.filePath);
  const fileSearch = fileFilter && !isHash ? { text: options.search!, field: options.searchField === 'author' ? 'author' as const : 'message' as const } : undefined;
  const args = ['--literal-pathspecs', 'log', '--no-color', '--no-ext-diff', '--no-textconv', '--date-order', '-z',
    `--max-count=${fileFilter ? 100_001 : options.limit + 1}`,
    ...(!fileFilter && options.skip ? [`--skip=${options.skip}`] : []),
    ...(options.search && !isHash && !options.filePath ? ['--regexp-ignore-case', '--fixed-strings', `${options.searchField === 'author' ? '--author' : '--grep'}=${options.search}`] : []),
    ...(options.filePath ? ['--follow', '--name-status', '-M', `--format=%H%x00%s%x00%an%x00%aI%x00%D%x00${fileSearch ? '%ae%x00%B%x00' : ''}`] : ['--format=%H%x00%s%x00%an%x00%aI%x00%D']),
    ...(candidates && !options.filePath ? ['--no-walk=sorted'] : []), '--stdin', '--', ...(options.filePath ? [options.filePath] : [])];
  const raw = await checked(cwd, args, `${(candidates && !options.filePath ? candidates : tips).join('\n')}\n${excludeTip && !candidates ? `^${excludeTip}\n` : ''}`);
  let commits = options.filePath ? parseFileHistory(raw, options.filePath, fileSearch) : parseRecentCommits(raw);
  if (fileFilter) {
    if (candidates) commits = commits.filter(commit => candidates.includes(commit.hash));
    commits = commits.slice(options.skip);
  }
  return result(commits.slice(0, options.limit), commits.length > options.limit);
}
