import { access } from 'node:fs/promises';
import path from 'node:path';
import { conflictError } from '../errors.js';
import { safeRepositoryPath } from './files.js';
import { runGit, runGitLiteral } from './runner.js';

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
 * **`diff` 必须是字节一一映射的字符串**（用 `buffer.toString('latin1')` 解出来），
 * 不能用 UTF-8 解。原因见 `applyFileHunks`：补丁最终要原样喂回 `git apply`，
 * 而 `git apply` 是按字节比对的。用 UTF-8 解会把非 UTF-8 文件（GBK / Shift-JIS /
 * Latin-1）里的每个非法字节换成 U+FFFD，上下文行随之对不上，补丁必然被拒。
 * latin1 的每个字符恰好对应一个字节，`Buffer.from(text, 'latin1')` 能无损还原。
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

/**
 * 用选中的 hunk 重建 patch；行号偏移交给 `git apply --recount` 处理。
 *
 * 返回的字符串与 `parseFileDiff` 的入参同源（字节一一映射），调用方必须用
 * `Buffer.from(patch, 'latin1')` 写回 git，不能当 UTF-8 发出去。
 */
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
  kind: 'staged' | 'unstaged' | 'discard';
  applied: number[];
  /** kind 为 `discard` 时为真：apply 前已把文件当前内容以副本形式备份进系统废纸篓。 */
  backedUp?: boolean;
}

export interface HunksDiscardOptions {
  /**
   * 把一个绝对路径整批移进系统废纸篓（按块丢弃时用来备份文件副本）。
   *
   * 注入是为了测试：单测传一个直接删除的实现，不真进废纸篓。
   */
  moveToTrash?: (absolutePaths: string[]) => Promise<void>;
  /** 把文件当前内容复制成副本送进废纸篓（见 `trashCopyOfFile`）；与 `moveToTrash` 必须成对提供。 */
  trashCopy?: (absolutePath: string, moveToTrash: (absolutePaths: string[]) => Promise<void>) => Promise<void>;
}

/**
 * 按块暂存（`kind: 'unstaged'`）、取消暂存（`kind: 'staged'`）或丢弃（`kind: 'discard'`）
 * 单个文件的选中 hunk。
 *
 * 暂存 / 取消暂存的实现方式是「重建部分 patch + `git apply --cached`」：`--cached` 只改
 * 索引、不动工作区文件；丢弃则走 `git apply --reverse`（不带 `--cached`），只改工作区
 * 不动索引——这正是「撤销这一块的未暂存改动」的 Git 语义。
 * `--recount` 让 Git 重算 hunk 行数，因此保留原 header 的行号是安全的。
 * patch 不合法时 `git apply` 会整体失败且不改动任何东西，不会留下半截状态。
 */
export async function applyFileHunks(
  cwd: string,
  relativePath: string,
  kind: 'staged' | 'unstaged' | 'discard',
  hunkIndexes: number[],
  options: HunksDiscardOptions = {},
): Promise<AppliedHunks> {
  safeRepositoryPath(cwd, relativePath);

  // discard 与 unstaged 看的是同一份「工作区 vs 索引」的未暂存 diff。
  const diffArgs = kind === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', relativePath]
    : ['diff', '--no-ext-diff', '--no-color', '--', relativePath];
  const diffResult = await runGitLiteral(cwd, diffArgs, 15_000, undefined, maxHunkPatchBytes);
  if (diffResult.exitCode !== 0) throw new Error(diffResult.stderr || '读取文件 diff 失败');
  if (diffResult.stdoutTruncated) throw conflictError('文件差异过大已截断，无法按块操作');

  // 按字节解析，不要 `toString('utf8')`：补丁要原样喂回 `git apply`，而它是按字节
  // 比对的。UTF-8 解码会把非 UTF-8 文件（GBK / Shift-JIS / Latin-1）的非法字节换成
  // U+FFFD，上下文行对不上，`git apply` 直接拒绝——用户看到的是「文件差异可能已变化」，
  // 于是反复重开 diff，而真正的原因是编码。latin1 每个字符对应一个字节，可无损还原。
  const parsed = parseFileDiff(diffResult.stdout.toString('latin1'));
  if (!parsed) throw conflictError('该文件没有可按块操作的差异（可能是二进制、重命名或仅权限变更）');

  const selected = [...new Set(hunkIndexes)].sort((a, b) => a - b);
  if (selected.length === 0) throw conflictError('没有选中任何差异块');
  if (selected.some((index) => !parsed.hunks.some((hunk) => hunk.index === index))) {
    throw conflictError('文件差异已变化，请重新打开 Diff 后重试');
  }

  // 按块丢弃会覆盖工作区内容，必须先把当前内容备份进废纸篓（可恢复承诺与整文件丢弃一致）。
  // 已删除的文件（status D）没有盘上内容可备份，反向 apply 也无从谈起——整文件还原才是它的入口。
  let backedUp = false;
  if (kind === 'discard') {
    const { moveToTrash, trashCopy } = options;
    if (!moveToTrash || !trashCopy) throw new Error('按块丢弃需要废纸篓备份能力');
    const absolutePath = path.resolve(cwd, relativePath);
    try {
      await access(absolutePath);
    } catch {
      throw conflictError('文件当前已被删除，请用整文件「还原到上次提交」恢复');
    }
    // 备份失败即中止：宁可让用户重试，也不能在没有备份的情况下覆盖工作区内容。
    await trashCopy(absolutePath, moveToTrash);
    backedUp = true;
  }

  const args = ['apply', '--recount', '--whitespace=nowarn'];
  // staged：反向 + 只改索引（取消暂存）；discard：反向 + 只改工作区（丢弃改动）。
  if (kind !== 'unstaged') args.push('--reverse');
  if (kind !== 'discard') args.push('--cached');
  args.push('-');
  const patch = Buffer.from(buildPartialPatch(parsed, selected), 'latin1');
  const result = await runGit(cwd, args, 30_000, patch);
  if (result.exitCode !== 0) {
    throw conflictError(`按块操作失败，文件差异可能已变化：${result.stderr || relativePath}`);
  }

  return { path: relativePath, kind, applied: selected, ...(kind === 'discard' ? { backedUp } : {}) };
}
