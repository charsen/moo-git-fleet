import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readFileBlame, readRevisionFile, readRevisionTree } from './revision-files.js';
import { readReflogPage } from './reflog.js';
const execute = promisify(execFile), roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const cwd = await mkdtemp(path.join(os.tmpdir(), 'fleet-revision-read-')); roots.push(cwd); await git(cwd, 'init', '-qb', 'main'); await git(cwd, 'config', 'user.name', 'Initial Author'); await git(cwd, 'config', 'user.email', 'initial@example.test'); return cwd; }
async function commit(cwd: string, message: string) { await git(cwd, 'add', '-A'); await git(cwd, '-c', 'commit.gpgSign=false', 'commit', '-qm', message); return git(cwd, 'rev-parse', 'HEAD'); }

it('reads the stored tree and special paths, never current content or symlink targets', async () => {
  const cwd = await fixture(), name = '中文\t[x]*\\file\n.txt'; await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src', name), 'old content\n'); await writeFile(path.join(cwd, '-option.txt'), 'option');
  await symlink('/outside/secret', path.join(cwd, 'link')); const base = await commit(cwd, 'root tree');
  await git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${base},module`); const withModule = await git(cwd, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'submodule').then(() => git(cwd, 'rev-parse', 'HEAD'));
  await writeFile(path.join(cwd, 'src', name), 'dirty\n'); await writeFile(path.join(cwd, 'new.txt'), 'untracked');
  const before = await git(cwd, 'status', '--porcelain=v1', '-z');
  expect((await readRevisionTree(cwd, { commit: withModule })).entries.map(entry => [entry.name, entry.kind])).toEqual([['src', 'directory'], ['-option.txt', 'file'], ['link', 'symlink'], ['module', 'submodule']]);
  expect((await readRevisionTree(cwd, { commit: base, path: 'src' })).entries[0]?.path).toBe(`src/${name}`);
  expect(await readRevisionFile(cwd, { commit: base, path: `src/${name}` })).toMatchObject({ content: 'old content\n', binary: false, truncated: false });
  expect(await readRevisionFile(cwd, { commit: base, path: 'link' })).toMatchObject({ kind: 'symlink', content: '/outside/secret' });
  expect(await readRevisionFile(cwd, { commit: withModule, path: 'module' })).toMatchObject({ kind: 'submodule', objectId: base, content: null });
  expect((await readRevisionFile(cwd, { commit: base, path: '-option.txt' })).content).toBe('option');
  expect(await git(cwd, 'status', '--porcelain=v1', '-z')).toBe(before); expect(await readFile(path.join(cwd, 'src', name), 'utf8')).toBe('dirty\n');
  for (const invalid of ['../secret', '/absolute', 'x/../a', 'a\0b', 'C:/absolute']) await expect(readRevisionFile(cwd, { commit: base, path: invalid })).rejects.toThrow();
  await expect(readRevisionFile(cwd, { commit: base, path: 'new.txt' })).rejects.toThrow('没有该文件');
  await expect(readRevisionTree(cwd, { commit: base, path: 'missing' })).rejects.toThrow('没有该目录');
  await expect(readRevisionTree(cwd, { commit: '--all' })).rejects.toThrow();
});

it('paginates and searches directories while preserving exact blobs and bounded text', async () => {
  const cwd = await fixture(); for (let i = 0; i < 103; i++) await writeFile(path.join(cwd, `item-${String(i).padStart(3, '0')}.txt`), String(i));
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2])); await writeFile(path.join(cwd, 'encoded.bin'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(cwd, 'huge.txt'), '中文'.repeat(70_000)); await writeFile(path.join(cwd, 'lines.txt'), 'line\n'.repeat(2100)); await writeFile(path.join(cwd, 'empty.txt'), '');
  const hash = await commit(cwd, 'many files'); const first = await readRevisionTree(cwd, { commit: hash, search: 'ITEM', limit: 100 }); const tail = await readRevisionTree(cwd, { commit: hash, search: 'ITEM', skip: 100 });
  expect(first).toMatchObject({ total: 103, hasMore: true }); expect(tail.entries).toHaveLength(3); expect(tail.hasMore).toBe(false);
  expect(new Set([...first.entries, ...tail.entries].map(entry => entry.path)).size).toBe(103);
  for (const path of ['binary.bin', 'encoded.bin']) expect(await readRevisionFile(cwd, { commit: hash, path })).toMatchObject({ content: null, binary: true });
  expect(await readRevisionFile(cwd, { commit: hash, path: 'huge.txt' })).toMatchObject({ truncated: true, binary: false });
  expect((await readRevisionFile(cwd, { commit: hash, path: 'huge.txt' })).content).not.toContain('\ufffd');
  expect((await readRevisionFile(cwd, { commit: hash, path: 'lines.txt' })).content?.split('\n')).toHaveLength(2000);
  expect((await readFileBlame(cwd, { commit: hash, path: 'empty.txt' })).lines).toEqual([]);
  await expect(readFileBlame(cwd, { commit: hash, path: 'lines.txt' })).rejects.toThrow('完整文本');
});

it('attributes historical lines across rename including original paths, UTF-8 BOM and final newline', async () => {
  const cwd = await fixture(), original = '旧\tfile\n.txt', next = 'new.txt'; await writeFile(path.join(cwd, original), '\ufefffirst\nsecond\nthird'); const base = await commit(cwd, 'initial lines');
  await rename(path.join(cwd, original), path.join(cwd, next)); await git(cwd, 'config', 'user.name', 'Second Author'); await writeFile(path.join(cwd, next), '\ufefffirst\nupdated\nthird'); const tip = await commit(cwd, 'rename and update');
  await writeFile(path.join(cwd, next), 'uncommitted'); const before = await git(cwd, 'status', '--porcelain');
  const blame = await readFileBlame(cwd, { commit: tip, path: next });
  expect(blame.lines.map(line => line.hash)).toEqual([base, tip, base]);
  expect(blame.lines[0]).toMatchObject({ author: 'Initial Author', originalPath: original, originalLine: 1, text: '\ufefffirst', boundary: true });
  expect(blame.lines[1]).toMatchObject({ author: 'Second Author', subject: 'rename and update', line: 2, text: 'updated' });
  expect(await git(cwd, 'status', '--porcelain')).toBe(before);
});

it('keeps reflog occurrence identity and a fixed page snapshot across later reference moves', async () => {
  const cwd = await fixture(); expect((await readReflogPage(cwd, {})).entries).toEqual([]);
  await writeFile(path.join(cwd, 'file.txt'), 'root'); const base = await commit(cwd, 'root');
  for (let i = 0; i < 25; i++) await git(cwd, 'update-ref', '--create-reflog', '-m', `move\tmessage ${i}`, 'refs/heads/test', base);
  // Repeated values do not create entries; explicit delete/create occurrences do.
  for (let i = 0; i < 24; i++) { await git(cwd, 'switch', '-qc', `branch-${i}`); await git(cwd, 'switch', '-q', 'main'); }
  const before = await git(cwd, 'reflog', '--format=%H%x00%gs', 'HEAD'); const first = await readReflogPage(cwd, { limit: 20 });
  expect(first.entries).toHaveLength(20); expect(first.hasMore).toBe(true); expect(first.entries[0]?.occurredAt).toMatch(/^\d{4}-/);
  await git(cwd, 'switch', '-q', 'branch-0');
  const tail = await readReflogPage(cwd, { snapshot: first.snapshot, skip: 20, limit: 100 });
  expect([...first.entries, ...tail.entries].map(entry => `${entry.hash}\0${entry.message}`).join('\n')).toBe(before);
  expect(new Set([...first.entries, ...tail.entries].map(entry => entry.selector)).size).toBe(first.entries.length + tail.entries.length);
  expect((await readReflogPage(cwd, { ref: 'refs/heads/main' })).entries[0]?.message).toContain('root');
  await expect(readReflogPage(cwd, { ref: 'refs/heads/main', snapshot: first.snapshot })).rejects.toThrow('快照');
  const other = await fixture(); await expect(readReflogPage(other, { snapshot: first.snapshot })).rejects.toThrow('快照');
  await expect(readReflogPage(cwd, { ref: '--all' })).rejects.toThrow();
  await expect(readReflogPage(cwd, { ref: 'refs/heads/missing' })).rejects.toThrow('不存在');
}, 15_000);
