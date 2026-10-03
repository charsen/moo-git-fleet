import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { MergeBranchRequest } from '../../shared/contracts.js';
import { previewBranchMerge, mergeBranch } from './merge.js';
import { abortRepositoryOperation, continueRepositoryOperation, resolveConflictFile } from './conflicts.js';
const exec = promisify(execFile);
const directories: string[] = [];
async function git(cwd: string, ...args: string[]) { return (await exec('git', ['-C', cwd, ...args])).stdout.trim(); }
async function fixture(diverged = false, conflict = false) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fleet-merge-')); directories.push(cwd);
  await git(cwd, 'init', '-qb', 'main'); await git(cwd, 'config', 'user.name', 'Merge Test'); await git(cwd, 'config', 'user.email', 'merge@example.test'); await git(cwd, 'config', 'commit.gpgSign', 'false');
  await writeFile(path.join(cwd, 'base.txt'), 'base\n'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'base');
  await git(cwd, 'switch', '-qc', 'feature'); await writeFile(path.join(cwd, conflict ? 'base.txt' : 'feature.txt'), 'feature\n'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'feature');
  const sourceHead = await git(cwd, 'rev-parse', 'HEAD'); await git(cwd, 'switch', '-q', 'main');
  if (diverged) { await writeFile(path.join(cwd, conflict ? 'base.txt' : 'main.txt'), 'main\n'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'main'); }
  const input: MergeBranchRequest = { source: { kind: 'local', name: 'feature' }, expectedBranch: 'main', expectedHead: await git(cwd, 'rev-parse', 'HEAD'), expectedSourceHead: sourceHead, noFastForward: false, stashFirst: false, stashIncludeUntracked: true };
  return { cwd, input };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(cwd => rm(cwd, { recursive: true, force: true }))); });
it('previews without changing Git and fast-forwards only the current target', async () => {
  const { cwd, input } = await fixture();
  expect(await previewBranchMerge(cwd, input)).toMatchObject({ kind: 'fast-forward', incomingCommits: 1, blocker: null });
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedHead);
  await mergeBranch(cwd, input); expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedSourceHead); expect(await git(cwd, 'branch', '--show-current')).toBe('main');
  expect(await git(cwd, 'rev-parse', 'feature')).toBe(input.expectedSourceHead);
  const updated = { ...input, expectedHead: input.expectedSourceHead }; expect(await mergeBranch(cwd, updated)).toEqual({ skipped: true, stashed: null });
});
it.each([false, true])('records two parents for divergent or explicitly non-FF merges (%s)', async (noFastForward) => {
  const { cwd, input } = await fixture(!noFastForward);
  await git(cwd, 'config', 'branch.main.mergeOptions', '--squash --no-commit --autostash');
  await mergeBranch(cwd, { ...input, noFastForward });
  expect((await git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(3);
  expect(await git(cwd, 'status', '--porcelain')).toBe('');
});
it.each(['untracked', 'staged', 'unstaged'])('merges past unrelated %s changes and keeps them', async (mode) => {
  const { cwd, input } = await fixture(); const name = mode === 'untracked' ? 'scratch.txt' : 'base.txt';
  await writeFile(path.join(cwd, name), 'keep me\n'); if (mode === 'staged') await git(cwd, 'add', name);
  expect(await previewBranchMerge(cwd, input)).toMatchObject({ dirty: true, conflicting: [], conflictingUntracked: false, blocker: null });
  await mergeBranch(cwd, input);
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedSourceHead);
  expect(await readFile(path.join(cwd, name), 'utf8')).toBe('keep me\n');
});
it('blocks overlapping local edits without a stash and stashes them on request', async () => {
  const { cwd, input } = await fixture(false, true);
  await writeFile(path.join(cwd, 'base.txt'), 'local\n');
  expect(await previewBranchMerge(cwd, input)).toMatchObject({ dirty: true, conflicting: ['base.txt'], conflictingUntracked: false, blocker: null });
  await expect(mergeBranch(cwd, input)).rejects.toThrow('会被本次合并覆盖');
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedHead);
  expect(await readFile(path.join(cwd, 'base.txt'), 'utf8')).toBe('local\n');
  const outcome = await mergeBranch(cwd, { ...input, stashFirst: true, stashIncludeUntracked: true });
  expect(outcome.stashed?.ref).toBe('stash@{0}');
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedSourceHead);
  expect(await git(cwd, 'status', '--porcelain')).toBe('');
  expect(await git(cwd, 'stash', 'list')).toContain('Moo Fleet 合并前备份');
  expect(await git(cwd, 'stash', 'show', '--stat')).toContain('base.txt');
});
it('flags untracked files the merge would overwrite', async () => {
  const { cwd, input } = await fixture();
  await writeFile(path.join(cwd, 'feature.txt'), 'mine\n');
  expect(await previewBranchMerge(cwd, input)).toMatchObject({ conflicting: ['feature.txt'], conflictingUntracked: true });
  await expect(mergeBranch(cwd, input)).rejects.toThrow('会被本次合并覆盖');
  const outcome = await mergeBranch(cwd, { ...input, stashFirst: true, stashIncludeUntracked: true });
  expect(outcome.stashed?.ref).toBe('stash@{0}');
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedSourceHead);
  expect(await git(cwd, 'status', '--porcelain')).toBe('');
});
it('does not stash when the target already contains the source', async () => {
  const { cwd, input } = await fixture();
  await mergeBranch(cwd, input);
  await writeFile(path.join(cwd, 'extra.txt'), 'keep\n');
  const updated = { ...input, expectedHead: input.expectedSourceHead };
  expect(await previewBranchMerge(cwd, updated)).toMatchObject({ kind: 'up-to-date', dirty: true });
  expect(await mergeBranch(cwd, { ...updated, stashFirst: true })).toEqual({ skipped: true, stashed: null });
  expect(await git(cwd, 'stash', 'list')).toBe('');
  expect(await readFile(path.join(cwd, 'extra.txt'), 'utf8')).toBe('keep\n');
});
it('rejects stale target, stale source, arbitrary revision and merging itself', async () => {
  const { cwd, input } = await fixture();
  await expect(mergeBranch(cwd, { ...input, expectedHead: input.expectedSourceHead })).rejects.toThrow('HEAD 已变化');
  await expect(mergeBranch(cwd, { ...input, expectedSourceHead: input.expectedHead })).rejects.toThrow('来源分支已变化');
  await expect(mergeBranch(cwd, { ...input, source: { kind: 'local', name: 'HEAD~1' } })).rejects.toThrow('来源分支已变化');
  await expect(mergeBranch(cwd, { ...input, source: { kind: 'local', name: 'main' }, expectedSourceHead: input.expectedHead })).rejects.toThrow('自身');
  await git(cwd, 'switch', '-q', 'feature'); await expect(mergeBranch(cwd, input)).rejects.toThrow('当前分支');
});
it('distinguishes identically named local and remote refs', async () => {
  const { cwd, input } = await fixture(); await git(cwd, 'remote', 'add', 'origin', cwd); await git(cwd, 'update-ref', 'refs/remotes/origin/feature', input.expectedSourceHead); await git(cwd, 'branch', 'origin/feature', input.expectedHead);
  expect((await previewBranchMerge(cwd, { ...input, source: { kind: 'local', name: 'origin/feature' }, expectedSourceHead: input.expectedHead })).kind).toBe('up-to-date');
  const remote = { ...input, source: { kind: 'remote' as const, name: 'origin/feature' } }; expect((await previewBranchMerge(cwd, remote)).incomingCommits).toBe(1); await mergeBranch(cwd, remote); expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedSourceHead);
});
it.each(['continue', 'abort'])('leaves conflicts visible for existing %s flow', async (mode) => {
  const { cwd, input } = await fixture(true, true);
  await expect(mergeBranch(cwd, input)).rejects.toMatchObject({ code: 'merge-paused' });
  expect(await git(cwd, 'rev-parse', 'MERGE_HEAD')).toBe(input.expectedSourceHead);
  await expect(mergeBranch(cwd, input)).rejects.toThrow('当前 merge');
  if (mode === 'abort') { await abortRepositoryOperation(cwd); expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedHead); expect(await readFile(path.join(cwd, 'base.txt'), 'utf8')).toBe('main\n'); }
  else { await resolveConflictFile(cwd, 'base.txt', 'ours'); await continueRepositoryOperation(cwd); expect((await git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(3); }
  expect(await git(cwd, 'status', '--porcelain')).toBe('');
});
it('preserves a stopped merge when a user hook rejects the commit', async () => {
  const { cwd, input } = await fixture(true); const hook = path.join(cwd, '.git/hooks/pre-merge-commit'); await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
  await expect(mergeBranch(cwd, input)).rejects.toMatchObject({ code: 'merge-paused' });
  expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(input.expectedHead); expect(await git(cwd, 'rev-parse', 'MERGE_HEAD')).toBe(input.expectedSourceHead); await abortRepositoryOperation(cwd);
});
