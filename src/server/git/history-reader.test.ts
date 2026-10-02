import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { commitDetail } from './commits.js';
import { readHistoryPage } from './history-reader.js';

const execute = promisify(execFile);
const directories: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fleet-history-query-')); directories.push(cwd);
  await git(cwd, 'init', '-q', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'History Reader'); await git(cwd, 'config', 'user.email', 'reader@example.test');
  return cwd;
}
async function commit(cwd: string, file: string, contents: string, subject: string, body = '') {
  await writeFile(path.join(cwd, file), contents); await git(cwd, 'add', '--', file);
  await git(cwd, '-c', 'commit.gpgSign=false', 'commit', '-qm', subject, '-m', body);
  return git(cwd, 'rev-parse', 'HEAD');
}
describe('history query against real Git', () => {
  it('unions local, remote, tag and detached tips, excludes stash and fixes the pagination snapshot', async () => {
    const cwd = await fixture(); const base = await commit(cwd, 'a.txt', 'base', 'base');
    await git(cwd, 'switch', '-qc', 'feature'); const feature = await commit(cwd, 'a.txt', 'feature', 'feature only');
    await git(cwd, 'switch', '-q', 'main'); const main = await commit(cwd, 'a.txt', 'main', 'main only');
    await git(cwd, 'update-ref', 'refs/remotes/origin/feature', feature);
    await git(cwd, 'switch', '-q', '--detach', base); const tagged = await commit(cwd, 'a.txt', 'tag', 'tag only');
    await git(cwd, '-c', 'tag.gpgSign=false', 'tag', '-a', 'v1', '-m', 'release');
    await git(cwd, 'switch', '-q', '--detach', main); const detached = await commit(cwd, 'a.txt', 'detached', 'detached only');
    await writeFile(path.join(cwd, 'a.txt'), 'stash'); await git(cwd, 'stash', 'push', '-qm', 'stash only');
    const first = await readHistoryPage(cwd, { scope: 'all', limit: 2 });
    expect(first.snapshot).toBeTruthy();
    const later = await commit(cwd, 'a.txt', 'later', 'later');
    await git(cwd, 'update-ref', 'refs/heads/feature', later);
    const tail = await readHistoryPage(cwd, { scope: 'all', limit: 100, skip: 2, snapshot: first.snapshot });
    expect([...first.commits, ...tail.commits].map(c => c.hash).sort()).toEqual([base, feature, main, tagged, detached].sort());
    expect(new Set([...first.commits, ...tail.commits].map(c => c.hash)).size).toBe(5);
    const refreshed = await readHistoryPage(cwd, { scope: 'all' }); expect(refreshed.commits.some(c => c.hash === later)).toBe(true);
  });
  it('searches old message bodies and author email, treats patterns literally and returns reachable SHA prefixes', async () => {
    const cwd = await fixture(); const first = await commit(cwd, 'a.txt', '0', 'first', 'needle.[old]');
    for (let i = 1; i <= 22; i++) await commit(cwd, 'a.txt', String(i), `new ${i}`);
    expect((await readHistoryPage(cwd, { limit: 20 })).commits.some(c => c.hash === first)).toBe(false);
    expect((await readHistoryPage(cwd, { search: 'needle.[old]' })).commits.map(c => c.hash)).toEqual([first]);
    expect((await readHistoryPage(cwd, { search: 'reader@example.test', searchField: 'author', limit: 100 })).commits).toHaveLength(23);
    expect((await readHistoryPage(cwd, { search: first.slice(0, 8), searchField: 'hash' })).commits.map(c => c.hash)).toEqual([first]);
    await git(cwd, 'switch', '-qc', 'other'); const other = await commit(cwd, 'a.txt', 'other', 'other'); await git(cwd, 'switch', '-q', 'main');
    expect((await readHistoryPage(cwd, { search: other.slice(0, 8), searchField: 'hash' })).commits).toEqual([]);
    expect((await readHistoryPage(cwd, { scope: 'all', search: other.slice(0, 8), searchField: 'hash' })).commits.map(c => c.hash)).toEqual([other]);
  }, 20_000);
  it('follows renames across pages and displays only the historical file including root and rename diffs', async () => {
    const cwd = await fixture(); const old = 'old\t[x]*\\name.txt'; const next = '中文\nnew.txt';
    const first = await commit(cwd, old, 'base\n', 'first', 'needle');
    await rename(path.join(cwd, old), path.join(cwd, next)); await git(cwd, 'add', '-A'); await git(cwd, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'rename');
    const renamed = await git(cwd, 'rev-parse', 'HEAD');
    await commit(cwd, 'unrelated.txt', 'other', 'unrelated'); const last = await commit(cwd, next, 'base\nlast\n', 'last', 'needle');
    const page = await readHistoryPage(cwd, { filePath: next, limit: 1 });
    const tail = await readHistoryPage(cwd, { filePath: next, limit: 20, skip: 1, tip: page.tip! });
    expect([...page.commits, ...tail.commits].map(c => [c.hash, c.filePath])).toEqual([[last, next], [renamed, next], [first, old]]);
    expect((await readHistoryPage(cwd, { filePath: next, search: 'needle' })).commits.map(c => c.filePath)).toEqual([next, old]);
    expect((await readHistoryPage(cwd, { filePath: next, search: first.slice(0, 8), searchField: 'hash' })).commits.map(c => c.filePath)).toEqual([old]);
    expect((await commitDetail(cwd, renamed, next)).files).toEqual([expect.objectContaining({ path: next, originalPath: old, status: 'R', patch: expect.stringContaining('rename from') })]);
    expect((await commitDetail(cwd, first, old)).patch).toContain('+base');
    expect((await commitDetail(cwd, last, next)).files).toHaveLength(1);
    expect(await commitDetail(cwd, last, 'unchanged.txt')).toMatchObject({ files: [], patch: '', stat: '' });
    expect((await readHistoryPage(cwd, { filePath: 'never-committed.txt' })).commits).toEqual([]);
  });
  it('keeps worktree, index and HEAD intact and rejects unsafe paths or mismatched snapshots', async () => {
    const cwd = await fixture(); await commit(cwd, 'a.txt', 'base', 'base');
    await writeFile(path.join(cwd, 'a.txt'), 'staged'); await git(cwd, 'add', '.'); await writeFile(path.join(cwd, 'a.txt'), 'dirty');
    const before = [await git(cwd, 'rev-parse', 'HEAD'), await git(cwd, 'status', '--porcelain=v1'), await git(cwd, 'diff', '--cached')];
    const page = await readHistoryPage(cwd, { scope: 'all' }); await readHistoryPage(cwd, { filePath: 'a.txt', search: 'base' });
    expect([await git(cwd, 'rev-parse', 'HEAD'), await git(cwd, 'status', '--porcelain=v1'), await git(cwd, 'diff', '--cached')]).toEqual(before);
    await expect(readHistoryPage(cwd, { scope: 'all', search: 'changed', snapshot: page.snapshot })).rejects.toThrow('快照');
    await expect(readHistoryPage(await fixture(), { scope: 'all', snapshot: page.snapshot })).rejects.toThrow('快照');
    await expect(readHistoryPage(cwd, { filePath: '../outside' })).rejects.toThrow();
    await expect(readHistoryPage(cwd, { filePath: ':(glob)**' })).resolves.toMatchObject({ commits: [] });
    await expect(readHistoryPage(cwd, { search: '--all', searchField: 'hash' })).rejects.toThrow('SHA');
    await expect(readHistoryPage(cwd, { scope: 'all', filePath: 'a.txt' })).rejects.toThrow('单文件');
  });
  it('returns empty all-history for an unborn repository', async () => {
    expect(await readHistoryPage(await fixture(), { scope: 'all' })).toMatchObject({ commits: [], tip: null, hasMore: false });
  });
  it('follows a file introduced through a merge while presenting details relative to the real first parent', async () => {
    const cwd = await fixture(); const base = await commit(cwd, 'a.txt', 'base\n', 'base');
    await git(cwd, 'switch', '-qc', 'feature'); const feature = await commit(cwd, 'a.txt', 'base\nfeature\n', 'feature edit');
    await git(cwd, 'switch', '-q', 'main'); await commit(cwd, 'other.txt', 'other', 'main edit');
    await git(cwd, '-c', 'commit.gpgSign=false', 'merge', '--no-ff', 'feature', '-m', 'merge');
    const page = await readHistoryPage(cwd, { filePath: 'a.txt' });
    expect(page.commits.map(c => c.hash)).toEqual([feature, base]);
    expect((await commitDetail(cwd, feature, 'a.txt')).patch).toContain('+feature');
  });
  it('pins both ends of outgoing pagination and excludes upstream commits from message and SHA searches', async () => {
    const cwd = await fixture(); const base = await commit(cwd, 'a.txt', 'base', 'base');
    await git(cwd, 'remote', 'add', 'origin', '/fixture/offline.git');
    await git(cwd, 'update-ref', 'refs/remotes/origin/main', base);
    await git(cwd, 'config', 'branch.main.remote', 'origin'); await git(cwd, 'config', 'branch.main.merge', 'refs/heads/main');
    const commits = [];
    for (let i = 0; i < 23; i++) commits.push(await commit(cwd, 'a.txt', String(i), `outgoing ${i}`));
    const before = [await git(cwd, 'rev-parse', 'HEAD'), await git(cwd, 'status', '--porcelain')];
    const first = await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main', limit: 20 });
    expect(first.excludeTip).toBe(base); expect(first.hasMore).toBe(true);
    await git(cwd, 'update-ref', 'refs/remotes/origin/main', commits[20]!);
    const later = await commit(cwd, 'a.txt', 'later', 'later');
    const tail = await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main', tip: first.tip!, excludeTip: first.excludeTip, skip: 20 });
    expect([...first.commits, ...tail.commits].map(c => c.hash)).toEqual([...commits].reverse());
    const fresh = await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main' });
    expect(fresh.commits.map(c => c.hash)).toEqual([later, commits[22], commits[21]]);
    expect((await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main', search: base.slice(0, 8), searchField: 'hash' })).commits).toEqual([]);
    expect((await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main', search: commits[22]!.slice(0, 8), searchField: 'hash' })).commits.map(c => c.hash)).toEqual([commits[22]]);
    expect((await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main', search: 'outgoing' })).commits.map(c => c.hash)).toEqual([commits[22], commits[21]]);
    expect(before[1]).toBe(await git(cwd, 'status', '--porcelain')); expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(later);
    await git(cwd, 'update-ref', 'refs/remotes/origin/main', later);
    expect((await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main' })).commits).toEqual([]);
    await git(cwd, 'update-ref', '-d', 'refs/remotes/origin/main');
    await expect(readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main' })).rejects.toThrow('upstream');
    await git(cwd, 'config', '--unset', 'branch.main.remote');
    await expect(readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main' })).rejects.toThrow('upstream');
    await expect(readHistoryPage(cwd, { scope: 'outgoing', ref: 'HEAD' })).rejects.toThrow('本地分支');
    await expect(readHistoryPage(cwd, { scope: 'ref', excludeTip: base })).rejects.toThrow('两端');
  }, 20_000);
  it('uses configured local upstream and handles divergent branches without including incoming commits', async () => {
    const cwd = await fixture(); const base = await commit(cwd, 'a.txt', 'base', 'base');
    await git(cwd, 'switch', '-qc', 'dev'); const incoming = await commit(cwd, 'a.txt', 'dev', 'dev');
    await git(cwd, 'switch', '-q', 'main'); const outgoing = await commit(cwd, 'a.txt', 'main', 'main');
    await git(cwd, 'branch', '--set-upstream-to=dev', 'main');
    const page = await readHistoryPage(cwd, { scope: 'outgoing', ref: 'refs/heads/main' });
    expect(page.commits.map(c => c.hash)).toEqual([outgoing]); expect(page.excludeTip).toBe(incoming);
    expect(page.commits.some(c => c.hash === base || c.hash === incoming)).toBe(false);
  });

});
