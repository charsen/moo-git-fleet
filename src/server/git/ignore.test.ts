import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { appendIgnoreRule, classifyIgnoreLine, deriveIgnorePattern, escapeIgnorePatternSegment, ignoreSourceTarget, locateIgnoreRule, readIgnoreFiles, removeIgnoreRule, resolveIgnoreFile } from './ignore.js';
import { listIgnoredEntries, listRepositoryFiles } from './files.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

async function repositoryFixture(): Promise<string> {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-ignore-'));
  temporaryDirectories.push(repositoryPath);
  await git(repositoryPath, ['init', '--initial-branch=master']);
  await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
  await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'initial']);
  return repositoryPath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ignore pattern derivation', () => {
  it('anchors a path rule to the repository root', () => {
    expect(deriveIgnorePattern('a/b/c.txt', 'path')).toBe('/a/b/c.txt');
    expect(deriveIgnorePattern('dist', 'path', true)).toBe('/dist/');
  });

  it('keeps only the file name for a same-name rule so it matches every folder', () => {
    expect(deriveIgnorePattern('a/b/c.txt', 'name')).toBe('c.txt');
    expect(deriveIgnorePattern('node_modules/', 'name', true)).toBe('node_modules/');
  });

  it('escapes gitignore metacharacters and leading markers', () => {
    expect(escapeIgnorePatternSegment('a b')).toBe('a\\ b');
    expect(escapeIgnorePatternSegment('*.[x]')).toBe('\\*.\\[x\\]');
    expect(escapeIgnorePatternSegment('!important.txt')).toBe('\\!important.txt');
    expect(escapeIgnorePatternSegment('#notes')).toBe('\\#notes');
  });
});

describe('appendIgnoreRule', () => {
  it('creates .gitignore when it does not exist yet', async () => {
    const cwd = await repositoryFixture();
    const result = await appendIgnoreRule(cwd, 'gitignore', '/notes.txt');
    expect(result).toEqual({ target: 'gitignore', pattern: '/notes.txt', created: true });
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('/notes.txt\n');
  });

  it('keeps the existing content, trailing newline and reports a duplicate without writing', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), 'node_modules\n/a b\n');
    await appendIgnoreRule(cwd, 'gitignore', 'dist/');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('node_modules\n/a b\ndist/\n');
    const duplicate = await appendIgnoreRule(cwd, 'gitignore', 'dist/');
    expect(duplicate.created).toBe(false);
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('node_modules\n/a b\ndist/\n');
  });

  it('adds a missing final newline before appending', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), 'node_modules');
    await appendIgnoreRule(cwd, 'gitignore', 'dist');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n');
  });

  it('rejects empty and multi-line patterns', async () => {
    const cwd = await repositoryFixture();
    expect((await rejectionOf(appendIgnoreRule(cwd, 'gitignore', '   '))).message).toContain('不能为空');
    expect((await rejectionOf(appendIgnoreRule(cwd, 'gitignore', 'a\nb'))).message).toContain('单行');
  });

  it('writes local-only rules to the path Git reports for info/exclude', async () => {
    const cwd = await repositoryFixture();
    expect(await resolveIgnoreFile(cwd, 'exclude')).toBe(path.join(cwd, '.git', 'info', 'exclude'));
    await appendIgnoreRule(cwd, 'exclude', 'local.txt');
    expect(await readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('local.txt');
    await writeFile(path.join(cwd, 'local.txt'), 'secret\n');
    expect(await git(cwd, ['check-ignore', '-v', 'local.txt'])).toContain('.git/info/exclude');
  });
});

describe('ignored entries', () => {
  it('drops an ignored file from the working list and lists it as ignored', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, 'draft.log'), 'noise\n');
    expect((await listRepositoryFiles('repo', cwd)).map((file) => file.path)).toContain('draft.log');

    await appendIgnoreRule(cwd, 'gitignore', deriveIgnorePattern('draft.log', 'name'));
    expect((await listRepositoryFiles('repo', cwd)).map((file) => file.path)).not.toContain('draft.log');
    expect((await listRepositoryFiles('repo', cwd)).map((file) => file.path)).toContain('.gitignore');

    const ignored = await listIgnoredEntries('repo', cwd);
    expect(ignored.truncated).toBe(false);
    expect(ignored.entries.map((entry) => entry.path)).toEqual(['draft.log']);
    expect(ignored.entries[0]?.directory).toBe(false);
    expect(ignored.entries[0]?.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('collapses a fully ignored directory into one entry', async () => {
    const cwd = await repositoryFixture();
    await mkdir(path.join(cwd, 'dist'));
    await writeFile(path.join(cwd, 'dist', 'a.js'), 'a\n');
    await writeFile(path.join(cwd, 'dist', 'b.js'), 'b\n');
    await appendIgnoreRule(cwd, 'gitignore', '/dist/');
    const ignored = await listIgnoredEntries('repo', cwd);
    expect(ignored.entries.map((entry) => entry.path)).toEqual(['dist/']);
    expect(ignored.entries[0]?.directory).toBe(true);
  });

  it('caps the listing and reports truncation', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), '*.log\n');
    await Promise.all(
      Array.from({ length: 305 }, (_, index) => writeFile(path.join(cwd, `f${index}.log`), 'x\n')),
    );
    const ignored = await listIgnoredEntries('repo', cwd);
    expect(ignored.truncated).toBe(true);
    expect(ignored.entries).toHaveLength(300);
  });
});

describe('reading ignore rules', () => {
  it('classifies rule, comment and blank lines', () => {
    expect(classifyIgnoreLine('dist/')).toBe('rule');
    expect(classifyIgnoreLine('   ')).toBe('blank');
    expect(classifyIgnoreLine('')).toBe('blank');
    expect(classifyIgnoreLine('# 说明')).toBe('comment');
    expect(classifyIgnoreLine('   # 缩进的注释')).toBe('comment');
    expect(classifyIgnoreLine('\\#转义后是规则')).toBe('rule');
  });

  it('numbers lines exactly as they appear in the file', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), '# 注释\ndist/\n\n/a b\n');
    const [gitignore, exclude] = await readIgnoreFiles(cwd);
    expect(gitignore).toEqual({
      target: 'gitignore',
      displayPath: '.gitignore',
      exists: true,
      lines: [
        { line: 1, text: '# 注释', kind: 'comment' },
        { line: 2, text: 'dist/', kind: 'rule' },
        { line: 3, text: '', kind: 'blank' },
        { line: 4, text: '/a b', kind: 'rule' },
      ],
    });
    // `git init` 会写入带注释模板的 info/exclude，所以是「存在但没有规则」。
    expect(exclude?.exists).toBe(true);
    expect(exclude?.lines.every((line) => line.kind !== 'rule')).toBe(true);
    expect(exclude?.displayPath).toBe(path.join('.git', 'info', 'exclude'));
  });

  it('reports an existing info/exclude with its own line numbers', async () => {
    const cwd = await repositoryFixture();
    await appendIgnoreRule(cwd, 'exclude', 'local-only.txt');
    const [, exclude] = await readIgnoreFiles(cwd);
    expect(exclude?.exists).toBe(true);
    const last = exclude?.lines.at(-1);
    expect(last?.kind).toBe('rule');
    expect(last?.text).toBe('local-only.txt');
    expect(last?.line).toBe(exclude?.lines.length);
  });
});

describe('removing ignore rules', () => {
  it('removes the addressed line and keeps the rest', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), 'first\nsecond\nthird\n');
    const result = await removeIgnoreRule(cwd, 'gitignore', 2, 'second');
    expect(result).toEqual({ target: 'gitignore', line: 2, pattern: 'second', displayPath: '.gitignore' });
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('first\nthird\n');
  });

  it('keeps a trailing newline when removing the last line and keeps an empty file when nothing is left', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), 'only\n');
    await removeIgnoreRule(cwd, 'gitignore', 1, 'only');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('');
  });

  it('refuses when the addressed line no longer matches', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), 'first\nsecond\n');
    expect((await rejectionOf(removeIgnoreRule(cwd, 'gitignore', 1, 'second'))).message).toContain('已变化');
    expect((await rejectionOf(removeIgnoreRule(cwd, 'gitignore', 9, 'second'))).message).toContain('已变化');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('first\nsecond\n');
  });

  it('never deletes comments or blank lines as rules', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), '# keep\ndist/\n');
    expect((await rejectionOf(removeIgnoreRule(cwd, 'gitignore', 1, '# keep'))).message).toContain('不能作为规则删除');
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe('# keep\ndist/\n');
  });

  it('removes a local-only rule from info/exclude', async () => {
    const cwd = await repositoryFixture();
    await appendIgnoreRule(cwd, 'exclude', 'secret.txt');
    await writeFile(path.join(cwd, 'secret.txt'), 's\n');
    const [, exclude] = await readIgnoreFiles(cwd);
    const rule = exclude!.lines.find((line) => line.text === 'secret.txt')!;
    await removeIgnoreRule(cwd, 'exclude', rule.line, rule.text);
    expect(await readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8')).not.toContain('secret.txt');
    expect((await listIgnoredEntries('repo', cwd)).entries.map((entry) => entry.path)).toEqual([]);
  });
});

describe('locating the rule that ignores a path', () => {
  it('points at the root .gitignore rule', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, '.gitignore'), '# note\ndraft.log\n');
    await writeFile(path.join(cwd, 'draft.log'), 'x\n');
    const located = await locateIgnoreRule(cwd, 'draft.log');
    expect(located).toEqual({ source: '.gitignore', line: 2, pattern: 'draft.log' });
    expect(await ignoreSourceTarget(cwd, located.source)).toBe('gitignore');
  });

  it('points at info/exclude for a local-only rule', async () => {
    const cwd = await repositoryFixture();
    await appendIgnoreRule(cwd, 'exclude', 'local.txt');
    await writeFile(path.join(cwd, 'local.txt'), 'x\n');
    const located = await locateIgnoreRule(cwd, 'local.txt');
    expect(located.pattern).toBe('local.txt');
    expect(await ignoreSourceTarget(cwd, located.source)).toBe('exclude');
  });

  it('reports a nested .gitignore as an unsupported source instead of guessing', async () => {
    const cwd = await repositoryFixture();
    await mkdir(path.join(cwd, 'sub'));
    await writeFile(path.join(cwd, 'sub', '.gitignore'), 'inner.txt\n');
    await writeFile(path.join(cwd, 'sub', 'inner.txt'), 'x\n');
    const located = await locateIgnoreRule(cwd, 'sub/inner.txt');
    expect(located.pattern).toBe('inner.txt');
    expect(await ignoreSourceTarget(cwd, located.source)).toBeNull();
  });

  it('throws for a path that is not ignored at all', async () => {
    const cwd = await repositoryFixture();
    expect((await rejectionOf(locateIgnoreRule(cwd, 'README.md'))).message).toContain('没有被忽略');
  });
});
