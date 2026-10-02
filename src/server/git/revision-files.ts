import type { FileBlame, GitTextContent, RevisionFile, RevisionTreeEntry, RevisionTreePage } from '../../shared/contracts.js';
import { commitHashParamsSchema, revisionFileQuerySchema, revisionTreeQuerySchema } from '../../shared/schemas.js';
import { invalidRequestError, notFoundError } from '../errors.js';
import { runGit } from './runner.js';

export const textPreviewBytes = 200_000;
const textPreviewLines = 2000;

export async function verifyRevision(cwd: string, commit: string): Promise<string> {
  commitHashParamsSchema.parse({ hash: commit });
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`]);
  if (result.exitCode !== 0 || result.stdout.toString('utf8').trim() !== commit) throw notFoundError('该提交已不可用，可能已被 Git 回收，请刷新后重试');
  return commit;
}

/** Only stored blob bytes, never textconv, a working file, or a symlink target. */
export async function readBlobText(cwd: string, objectId: string): Promise<GitTextContent> {
  commitHashParamsSchema.parse({ hash: objectId });
  const sizeResult = await runGit(cwd, ['cat-file', '-s', objectId]);
  if (sizeResult.exitCode !== 0 || !/^\d+$/.test(sizeResult.stdout.toString('utf8').trim())) throw notFoundError('文件对象已不可用，请刷新后重试');
  const size = Number(sizeResult.stdout.toString('utf8').trim());
  const result = await runGit(cwd, ['cat-file', 'blob', objectId], 15_000, undefined, textPreviewBytes);
  if (result.exitCode !== 0) throw notFoundError('该对象不是可读取的文件');
  // Remove an incomplete UTF-8 suffix when the byte cap cuts through a character.
  let bytes = result.stdout;
  if (result.stdoutTruncated) {
    let end = bytes.length;
    let start = end - 1;
    while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
    if (start >= 0) {
      const first = bytes[start]!;
      const count = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      if (end - start < count) end = start;
    }
    bytes = bytes.subarray(0, end);
  }
  let content: string | null;
  try { content = bytes.includes(0) ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { content = null; }
  let truncated = result.stdoutTruncated;
  if (content !== null) {
    const lines = content.split('\n');
    if (lines.length > textPreviewLines + 1 || (lines.length === textPreviewLines + 1 && lines.at(-1) !== '')) {
      content = lines.slice(0, textPreviewLines).join('\n'); truncated = true;
    }
  }
  return { objectId, content, size, binary: content === null, truncated };
}

function treeEntries(buffer: Buffer, directory: string): RevisionTreeEntry[] {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const match = record.slice(0, tab).match(/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\s+(\d+|-)$/);
    if (tab < 0 || !match) throw new Error('读取版本文件树失败');
    const name = record.slice(tab + 1), mode = match[1]!;
    const kind = match[2] === 'tree' ? 'directory' : match[2] === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
    return { name, path: directory ? `${directory}/${name}` : name, mode, kind, objectId: match[3]!, size: match[4] === '-' ? null : Number(match[4]) };
  });
}

export async function readRevisionTree(cwd: string, input: { commit: string; path?: string; skip?: number; limit?: number; search?: string }): Promise<RevisionTreePage> {
  const query = revisionTreeQuerySchema.parse(input);
  await verifyRevision(cwd, query.commit);
  const result = await runGit(cwd, ['ls-tree', '-z', '-l', query.path ? `${query.commit}:${query.path}` : query.commit, '--'], 15_000, undefined, 8_000_000);
  if (result.exitCode !== 0) throw notFoundError('这个提交中没有该目录');
  if (result.stdoutTruncated) throw invalidRequestError('该目录过大，无法完整读取，请在本地 Git 中查看');
  const entries = treeEntries(result.stdout, query.path)
    .filter(entry => !query.search || entry.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  return { commit: query.commit, path: query.path, entries: entries.slice(query.skip, query.skip + query.limit), total: entries.length, hasMore: query.skip + query.limit < entries.length };
}

export async function readRevisionFile(cwd: string, input: { commit: string; path: string }): Promise<RevisionFile> {
  const query = revisionFileQuerySchema.parse(input); await verifyRevision(cwd, query.commit);
  const result = await runGit(cwd, ['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', query.commit, '--', query.path]);
  if (result.exitCode !== 0) throw new Error('读取版本文件失败');
  const entry = treeEntries(result.stdout, '').find(entry => entry.path === query.path);
  if (!entry || entry.kind === 'directory') throw notFoundError('这个提交中没有该文件');
  const text = entry.kind === 'submodule'
    ? { objectId: entry.objectId, content: null, size: 0, binary: false, truncated: false }
    : await readBlobText(cwd, entry.objectId);
  return { ...text, commit: query.commit, path: query.path, kind: entry.kind };
}

/** Git's C-quoted path can include octal UTF-8 bytes, tabs and line breaks. */
function blamePath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const escaped: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length;) {
    if (body[i] !== '\\') {
      const point = body.codePointAt(i)!; const char = String.fromCodePoint(point); bytes.push(...Buffer.from(char)); i += char.length;
    } else {
      i++; const octal = body.slice(i).match(/^[0-7]{1,3}/)?.[0];
      if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length; }
      else { bytes.push(escaped[body[i]!] ?? body.charCodeAt(i)); i++; }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export async function readFileBlame(cwd: string, input: { commit: string; path: string }): Promise<FileBlame> {
  const file = await readRevisionFile(cwd, input);
  if (file.kind !== 'file' || file.binary || file.truncated) throw invalidRequestError('Blame 只支持预览范围内的完整文本文件');
  if (file.size === 0) return { commit: file.commit, path: file.path, lines: [] };
  const result = await runGit(cwd, ['-c', 'core.quotePath=true', 'blame', '--line-porcelain', '--no-textconv', file.commit, '--', file.path], 30_000, undefined, 8_000_000);
  if (result.exitCode !== 0 || result.stdoutTruncated) throw new Error('读取行归属失败，历史可能已变化或过大');
  const lines: FileBlame['lines'] = [];
  let current: FileBlame['lines'][number] | null = null;
  for (const row of result.stdout.toString('utf8').split('\n')) {
    const header = row.match(/^([a-f0-9]{40}|[a-f0-9]{64}) (\d+) (\d+)(?: \d+)?$/);
    if (header) current = { hash: header[1]!, originalLine: Number(header[2]), line: Number(header[3]), author: '', authoredAt: '', subject: '', originalPath: '', text: '', boundary: false };
    else if (current) {
      if (row.startsWith('\t')) { current.text = row.slice(1); lines.push(current); current = null; }
      else if (row.startsWith('author ')) current.author = row.slice(7);
      else if (row.startsWith('author-time ')) current.authoredAt = new Date(Number(row.slice(12)) * 1000).toISOString();
      else if (row.startsWith('summary ')) current.subject = row.slice(8);
      else if (row.startsWith('filename ')) current.originalPath = blamePath(row.slice(9));
      else if (row === 'boundary') current.boundary = true;
    }
  }
  const expected = file.content!.split('\n'); if (expected.at(-1) === '') expected.pop();
  if (lines.length !== expected.length || lines.some((line, index) => line.line !== index + 1 || line.text !== expected[index])) throw new Error('行归属与版本内容不匹配，请刷新后重试');
  return { commit: file.commit, path: file.path, lines };
}
