import { conflictError } from '../errors.js';
import { safeRepositoryPath } from './files.js';
import { runGit } from './runner.js';

const maxHunkPatchBytes = 120_000;

export interface DiffHunk {
  /** 在文件 diff 中的序号（从 0 开始），同时作为稳定的 hunk ID 使用。 */
  index: number;
  /** `@@ -a,b +c,d @@` 这一行。 */
  header: string;
  /** hunk 的内容行，含前导的 `+` / `-` / 空格，以及 `\ No newline at end of file`。 */
  lines: string[];
}

export interface ParsedFileDiff {
  /** `diff --git` / `index` / `---` / `+++` 等前置行。 */
  header: string[];
  hunks: DiffHunk[];
}

/**
 * 把单文件 diff 拆成「前置行 + 若干 hunk」。
 *
 * 二进制文件、纯重命名、仅权限变更等没有 `@@` 的 diff 返回 `null`，
 * 调用方应据此拒绝按块操作，而不是猜一个空 patch 出来。
 */
export function parseFileDiff(diff: string): ParsedFileDiff | null {
  const lines = diff.split('\n');
  // `git diff` 通常以换行结尾，split 会多出一个空串——那是分隔符，不是内容。
  if (lines.at(-1) === '') lines.pop();

  const header: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = { index: hunks.length, header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }

  if (hunks.length === 0) return null;
  return { header, hunks };
}

/** 用选中的 hunk 重建 patch；行号偏移交给 `git apply --recount` 处理。 */
export function buildPartialPatch(parsed: ParsedFileDiff, indexes: number[]): string {
  const selected = new Set(indexes);
  const chunks = [...parsed.header];
  for (const hunk of parsed.hunks) {
    if (!selected.has(hunk.index)) continue;
    chunks.push(hunk.header, ...hunk.lines);
  }
  return `${chunks.join('\n')}\n`;
}

export interface AppliedHunks {
  path: string;
  kind: 'staged' | 'unstaged';
  applied: number[];
}

/**
 * 按块暂存（`kind: 'unstaged'`）或取消暂存（`kind: 'staged'`）单个文件的选中 hunk。
 *
 * 实现方式是「重建部分 patch + `git apply --cached`」：`--cached` 只改索引、
 * 不动工作区文件；`--recount` 让 Git 重算 hunk 行数，因此保留原 header 的行号是安全的。
 * patch 不合法时 `git apply` 会整体失败且不改动任何东西，不会留下半截状态。
 */
export async function applyFileHunks(
  cwd: string,
  relativePath: string,
  kind: 'staged' | 'unstaged',
  hunkIndexes: number[],
): Promise<AppliedHunks> {
  safeRepositoryPath(cwd, relativePath);

  const diffArgs = kind === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', relativePath]
    : ['diff', '--no-ext-diff', '--no-color', '--', relativePath];
  const diffResult = await runGit(cwd, diffArgs, 15_000, undefined, maxHunkPatchBytes);
  if (diffResult.exitCode !== 0) throw new Error(diffResult.stderr || '读取文件 diff 失败');
  if (diffResult.stdoutTruncated) throw conflictError('文件差异过大已截断，无法按块操作');

  const parsed = parseFileDiff(diffResult.stdout.toString('utf8'));
  if (!parsed) throw conflictError('该文件没有可按块操作的差异（可能是二进制、重命名或仅权限变更）');

  const selected = [...new Set(hunkIndexes)].sort((a, b) => a - b);
  if (selected.length === 0) throw conflictError('没有选中任何差异块');
  if (selected.some((index) => !parsed.hunks.some((hunk) => hunk.index === index))) {
    throw conflictError('文件差异已变化，请重新打开 Diff 后重试');
  }

  const args = ['apply', '--cached', '--recount', '--whitespace=nowarn'];
  if (kind === 'staged') args.push('--reverse');
  args.push('-');
  const result = await runGit(cwd, args, 30_000, buildPartialPatch(parsed, selected));
  if (result.exitCode !== 0) {
    throw conflictError(`按块操作失败，文件差异可能已变化：${result.stderr || relativePath}`);
  }

  return { path: relativePath, kind, applied: selected };
}
