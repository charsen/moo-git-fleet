import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readBranchComparison } from './comparison.js';
import { readHistoryPage } from './history-reader.js';

const execute = promisify(execFile);
const directories: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args])).stdout.trim();
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fleet-comparison-')); directories.push(cwd);
  await git(cwd, 'init', '-qb', 'main'); await git(cwd, 'config', 'user.name', 'Compare Test'); await git(cwd, 'config', 'user.email', 'compare@example.test');
  return cwd;
}
async function commit(cwd: string, file: string, content: string | Buffer, subject: string) {
  await writeFile(path.join(cwd, file), content); await git(cwd, 'add', '-A'); await git(cwd, '-c', 'commit.gpgSign=false', 'commit', '-qm', subject);
  return git(cwd, 'rev-parse', 'HEAD');
}

it('compares diverged tips, both exclusive histories and endpoint changes without touching dirty data', async () => {
  const cwd = await fixture(); const original = 'old\t[x]*\\name.txt', next = '中文\nnew.txt';
  await commit(cwd, original, 'base\n', 'base');
  await git(cwd, 'switch', '-qc', 'feature');
  await rename(path.join(cwd, original), path.join(cwd, next));
  const feature = await commit(cwd, 'binary.bin', Buffer.from([0, 1, 2]), 'rename and binary');
  await git(cwd, 'switch', '-q', 'main'); const main = await commit(cwd, 'main.txt', 'main only\n', 'main only');
  await writeFile(path.join(cwd, 'main.txt'), 'staged\n'); await git(cwd, 'add', '.'); await writeFile(path.join(cwd, 'main.txt'), 'dirty\n');
  const before = [await git(cwd, 'rev-parse', 'HEAD'), await git(cwd, 'status', '--porcelain=v1', '-z'), await git(cwd, 'diff', '--cached'), await readFile(path.join(cwd, 'main.txt'), 'utf8')];
  const page = await readHistoryPage(cwd, { scope: 'compare', ref: 'refs/heads/feature', baseRef: 'refs/heads/main' });
  expect(page).toMatchObject({ tip: feature, excludeTip: main, hasMore: false }); expect(page.commits.map(c => c.hash)).toEqual([feature]);
  const detail = await readBranchComparison(cwd, { tip: page.tip!, baseTip: page.excludeTip! });
  expect(detail).toMatchObject({ sourceOnly: 1, baseOnly: 1, truncated: false });
  expect(detail.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: next, originalPath: original, status: 'R', patch: expect.stringContaining('rename from') }),
    expect.objectContaining({ path: 'binary.bin', status: 'A', patch: expect.stringContaining('Binary files') }),
    expect.objectContaining({ path: 'main.txt', status: 'D', patch: expect.stringContaining('-main only') }),
  ]));
  const reverse = await readHistoryPage(cwd, { scope: 'compare', ref: 'refs/heads/main', baseRef: 'refs/heads/feature' });
  expect(reverse.commits.map(c => c.hash)).toEqual([main]);
  expect((await readHistoryPage(cwd, { scope: 'compare', ref: 'refs/heads/feature', baseRef: 'refs/heads/main', search: main.slice(0, 8), searchField: 'hash' })).commits).toEqual([]);
  expect(await readBranchComparison(cwd, { tip: main, baseTip: main })).toMatchObject({ sourceOnly: 0, baseOnly: 0, files: [] });
  expect([await git(cwd, 'rev-parse', 'HEAD'), await git(cwd, 'status', '--porcelain=v1', '-z'), await git(cwd, 'diff', '--cached'), await readFile(path.join(cwd, 'main.txt'), 'utf8')]).toEqual(before);
});

it('pins incoming and comparison pages across ref changes and constrains all search fields to the range', async () => {
  const cwd = await fixture(); const base = await commit(cwd, 'base.txt', 'base', 'base');
  await git(cwd, 'remote', 'add', 'origin', '/fixture/offline.git');
  await git(cwd, 'config', 'branch.main.remote', 'origin'); await git(cwd, 'config', 'branch.main.merge', 'refs/heads/main');
  await git(cwd, 'switch', '-qc', 'remote-work'); const incoming: string[] = [];
  for (let i = 0; i < 23; i++) incoming.push(await commit(cwd, 'remote.txt', String(i), `incoming ${i}`));
  await git(cwd, 'update-ref', 'refs/remotes/origin/main', incoming[22]!);
  await git(cwd, 'switch', '-q', 'main'); const local = await commit(cwd, 'local.txt', 'local', 'local only');
  for (const scope of ['incoming', 'compare'] as const) {
    const query = { scope, ref: scope === 'incoming' ? 'refs/heads/main' : 'refs/remotes/origin/main', ...(scope === 'compare' ? { baseRef: 'refs/heads/main' } : {}) };
    const first = await readHistoryPage(cwd, { ...query, limit: 20 });
    expect(first).toMatchObject({ tip: incoming[22], excludeTip: local, hasMore: true });
    await git(cwd, 'update-ref', 'refs/remotes/origin/main', base); await git(cwd, 'update-ref', 'refs/heads/main', base);
    const tail = await readHistoryPage(cwd, { ...query, tip: first.tip!, excludeTip: first.excludeTip, skip: 20 });
    expect([...first.commits, ...tail.commits].map(c => c.hash)).toEqual([...incoming].reverse());
    expect(await readBranchComparison(cwd, { tip: first.tip!, baseTip: first.excludeTip! })).toMatchObject({ sourceOnly: 23, baseOnly: 1 });
    await git(cwd, 'update-ref', 'refs/remotes/origin/main', incoming[22]!); await git(cwd, 'update-ref', 'refs/heads/main', local);
    expect((await readHistoryPage(cwd, { ...query, search: 'incoming 0' })).commits.map(c => c.hash)).toEqual([incoming[0]]);
    expect((await readHistoryPage(cwd, { ...query, search: 'compare@example.test', searchField: 'author', limit: 100 })).commits).toHaveLength(23);
    expect((await readHistoryPage(cwd, { ...query, search: base.slice(0, 8), searchField: 'hash' })).commits).toEqual([]);
  }
  await git(cwd, 'update-ref', 'refs/remotes/origin/main', local);
  expect((await readHistoryPage(cwd, { scope: 'incoming', ref: 'refs/heads/main' })).commits).toEqual([]);
}, 20_000);

it('rejects invalid ranges and missing refs, accepts unrelated histories and bounds large patches', async () => {
  const cwd = await fixture(); const base = await commit(cwd, 'base.txt', 'base', 'base');
  await expect(readHistoryPage(cwd, { scope: 'incoming', ref: 'refs/heads/main' })).rejects.toThrow('upstream');
  await expect(readHistoryPage(cwd, { scope: 'incoming', ref: 'HEAD' })).rejects.toThrow('本地分支');
  await expect(readHistoryPage(cwd, { scope: 'compare', ref: 'refs/heads/main' })).rejects.toThrow('基准');
  await expect(readHistoryPage(cwd, { scope: 'compare', ref: 'refs/heads/main', baseRef: 'refs/heads/missing' })).rejects.toThrow('引用不可用');
  await expect(readHistoryPage(cwd, { scope: 'incoming', ref: 'refs/heads/main', tip: base })).rejects.toThrow('两端');
  await expect(readBranchComparison(cwd, { tip: '--all', baseTip: base })).rejects.toThrow();
  await expect(readBranchComparison(cwd, { tip: '0'.repeat(40), baseTip: base })).rejects.toThrow('不可用');
  await git(cwd, 'checkout', '--orphan', 'unrelated'); await git(cwd, 'rm', '-q', '--cached', '--', 'base.txt'); await rm(path.join(cwd, 'base.txt'));
  const tip = await commit(cwd, 'large.txt', 'large line\n'.repeat(30_000), 'unrelated');
  const page = await readHistoryPage(cwd, { scope: 'compare', ref: 'refs/heads/unrelated', baseRef: 'refs/heads/main' }); expect(page.commits.map(c => c.hash)).toEqual([tip]);
  const detail = await readBranchComparison(cwd, { tip, baseTip: base }); expect(detail).toMatchObject({ sourceOnly: 1, baseOnly: 1, truncated: true });
  expect(detail.files.find(file => file.path === 'large.txt')?.patch).toBeNull();
});
