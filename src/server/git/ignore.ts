import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IgnoreFileRules, IgnoreRuleResult, IgnoreTarget, RemoveIgnoreRuleResult } from '../../shared/contracts.js';
import { conflictError, invalidRequestError } from '../errors.js';
import { runGit, runGitLine } from './runner.js';

const maxPatternLength = 200;
const ignoreTargets = ['gitignore', 'exclude'] as const;

/** gitignore 里对单个路径片段转义：反斜杠、通配符、方括号、空格，以及行首的 `#` / `!`。 */
export function escapeIgnorePatternSegment(segment: string): string {
  const escaped = segment
    .replace(/[\\*?[\]]/g, (character) => `\\${character}`)
    .replace(/ /g, '\\ ');
  return escaped.startsWith('#') || escaped.startsWith('!') ? `\\${escaped}` : escaped;
}

/**
 * `path` 锚定仓库根，只覆盖当前这一条路径；`name` 只用文件名，命中仓库内所有同名项。
 * 目录带结尾 `/`，只匹配目录。
 */
export function deriveIgnorePattern(
  relativePath: string,
  scope: 'path' | 'name',
  directory = false,
): string {
  const trimmed = relativePath.replace(/\/+$/, '');
  const suffix = directory ? '/' : '';
  if (scope === 'name') return `${escapeIgnorePatternSegment(path.posix.basename(trimmed))}${suffix}`;
  const segments = trimmed.split('/').filter(Boolean).map(escapeIgnorePatternSegment);
  return `/${segments.join('/')}${suffix}`;
}

function assertValidPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) throw invalidRequestError('忽略模式不能为空');
  if (trimmed.length > maxPatternLength) throw invalidRequestError('忽略模式过长');
  if (/[\0\r\n]/.test(trimmed)) throw invalidRequestError('忽略模式必须为单行文本');
  return trimmed;
}

/**
 * `.gitignore` 固定在 worktree 根；`.git/info/exclude` 必须问 Git 要路径——
 * linked worktree 的 exclude 不在 `.git/info/` 下。
 */
export async function resolveIgnoreFile(cwd: string, target: IgnoreTarget): Promise<string> {
  if (target === 'gitignore') return path.join(cwd, '.gitignore');
  return path.resolve(cwd, await runGitLine(cwd, ['rev-parse', '--git-path', 'info/exclude']));
}

/** 按文件里的真实行拆分：结尾换行产生的空元素不是一行，否则行号会整体错位。 */
function splitIgnoreLines(content: string): string[] {
  if (!content.length) return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function ignoreDisplayPath(cwd: string, target: IgnoreTarget, file: string): string {
  return target === 'gitignore' ? '.gitignore' : path.relative(cwd, file);
}

function lineEndingOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function classifyIgnoreLine(text: string): 'rule' | 'comment' | 'blank' {
  if (!text.trim()) return 'blank';
  return text.trimStart().startsWith('#') ? 'comment' : 'rule';
}

/** 规则列表只覆盖仓库根 `.gitignore` 与本机 `info/exclude` 两个文件。 */
export async function readIgnoreFiles(cwd: string): Promise<IgnoreFileRules[]> {
  return Promise.all(ignoreTargets.map(async (target) => {
    const file = await resolveIgnoreFile(cwd, target);
    const displayPath = ignoreDisplayPath(cwd, target, file);
    let content: string | null = null;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (content === null) return { target, displayPath, exists: false, lines: [] };
    return {
      target,
      displayPath,
      exists: true,
      lines: splitIgnoreLines(content).map((text, index) => ({ line: index + 1, text, kind: classifyIgnoreLine(text) })),
    };
  }));
}

/**
 * 删除一条规则。`line` + 该行内容双条件校验：列表过期或被别处改动时直接 409，不做模糊匹配。
 * 文件删空后保留空文件，避免跟踪中的 `.gitignore` 变成一次删除变更。
 */
export async function removeIgnoreRule(
  cwd: string,
  target: IgnoreTarget,
  line: number,
  pattern: string,
): Promise<RemoveIgnoreRuleResult> {
  const rule = pattern.trim();
  if (!rule || /[\0\r\n]/.test(pattern)) throw invalidRequestError('忽略模式无效');
  const file = await resolveIgnoreFile(cwd, target);
  const displayPath = ignoreDisplayPath(cwd, target, file);
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw conflictError('忽略规则文件已不存在，请刷新后重试');
    throw error;
  }
  const lines = splitIgnoreLines(content);
  const current = lines[line - 1];
  if (current === undefined || current.trim() !== rule) throw conflictError('忽略规则已变化，请刷新后重试');
  if (classifyIgnoreLine(current) !== 'rule') throw invalidRequestError('注释和空行不能作为规则删除');
  lines.splice(line - 1, 1);
  await writeFile(file, lines.length ? `${lines.join(lineEndingOf(content))}${lineEndingOf(content)}` : '', 'utf8');
  return { target, line, pattern: rule, displayPath };
}

export interface LocatedIgnoreRule {
  /** `git check-ignore -v` 报告的规则来源文件（可能是嵌套 `.gitignore` 或全局 excludes）。 */
  source: string;
  line: number | null;
  pattern: string;
}

/** 用 Git 自己判定是「哪一条规则」在忽略这个路径，不猜模式。 */
export async function locateIgnoreRule(cwd: string, relativePath: string): Promise<LocatedIgnoreRule> {
  const result = await runGit(cwd, ['check-ignore', '--no-index', '-v', '--', relativePath]);
  if (result.exitCode === 1) throw invalidRequestError('这个文件当前没有被忽略');
  if (result.exitCode !== 0) throw new Error(result.stderr || '查询忽略规则失败');
  const [spec = ''] = result.stdout.toString('utf8').split('\t');
  // 来源路径与模式都可能含 `:`，所以取最后一段 `:<数字>:` 作为分隔。
  const match = /^(.*):(\d+):(.*)$/.exec(spec);
  if (!match) return { source: spec, line: null, pattern: '' };
  return { source: match[1] ?? '', line: Number(match[2]), pattern: match[3] ?? '' };
}

/** 把规则来源收敛到本轮支持的两个文件；嵌套 `.gitignore`、全局 excludes 返回 null。 */
export async function ignoreSourceTarget(cwd: string, source: string): Promise<IgnoreTarget | null> {
  const resolved = path.resolve(cwd, source);
  const [gitignore, exclude] = await Promise.all(ignoreTargets.map((target) => resolveIgnoreFile(cwd, target)));
  if (resolved === gitignore) return 'gitignore';
  if (resolved === exclude) return 'exclude';
  return null;
}

/** 追加一条规则；规则已存在时保持文件原样，返回 `created: false`。 */
export async function appendIgnoreRule(
  cwd: string,
  target: IgnoreTarget,
  pattern: string,
): Promise<IgnoreRuleResult> {
  const rule = assertValidPattern(pattern);
  const file = await resolveIgnoreFile(cwd, target);
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (splitIgnoreLines(existing).some((line) => line.trim() === rule)) {
    return { target, pattern: rule, created: false };
  }
  const lineEnding = lineEndingOf(existing);
  let next = existing;
  if (next.length && !next.endsWith('\n')) next += lineEnding;
  await writeFile(file, `${next}${rule}${lineEnding}`, 'utf8');
  return { target, pattern: rule, created: true };
}
