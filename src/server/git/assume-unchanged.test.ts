import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listMarkedFiles, setAssumeUnchanged } from './assume-unchanged.js';
import { listRepositoryFiles } from './files.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-assume-'));
  temporaryDirectories.push(cwd);
  await mkdir(path.join(cwd, 'sub'));
  await git(cwd, ['init', '--initial-branch=master']);
  await git(cwd, ['config', 'user.name', 'Git Fleet Test']);
  await git(cwd, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await writeFile(path.join(cwd, 'notes.txt'), 'v1\n');
  await writeFile(path.join(cwd, 'sub', 'held.txt'), 'v1\n');
  await git(cwd, ['add', '.']);
  await git(cwd, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);
  return cwd;
}

async function statusPaths(cwd: string): Promise<string[]> {
  return (await listRepositoryFiles('repo', cwd)).map((file) => `${file.path}:${file.worktreeStatus.trim() || file.indexStatus}`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('assume-unchanged marking', () => {
  it('reads the flag from ls-files -v and ignores skip-worktree', async () => {
    const cwd = await repositoryFixture();
    await git(cwd, ['update-index', '--assume-unchanged', '--', 'notes.txt']);
    await git(cwd, ['update-index', '--skip-worktree', '--', 'sub/held.txt']);
    // 原始口径：H 普通、h 带 assume-unchanged、S 是 skip-worktree。
    expect(await git(cwd, ['ls-files', '-v'])).toBe('H README.md\nh notes.txt\nS sub/held.txt');
    const marked = await listMarkedFiles('repo', cwd);
    expect(marked.map((file) => file.path)).toEqual(['notes.txt']);
    expect(marked[0]?.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('hides the local modification of a marked file from the working list and restores it after unmarking', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, 'notes.txt'), 'v2\n');
    expect(await statusPaths(cwd)).toEqual(['notes.txt:M']);

    await setAssumeUnchanged(cwd, 'notes.txt', true);
    expect(await git(cwd, ['status', '--porcelain'])).toBe('');
    expect(await statusPaths(cwd)).toEqual([]);
    expect((await listMarkedFiles('repo', cwd)).map((file) => file.path)).toEqual(['notes.txt']);

    await setAssumeUnchanged(cwd, 'notes.txt', false);
    expect(await statusPaths(cwd)).toEqual(['notes.txt:M']);
    expect(await listMarkedFiles('repo', cwd)).toEqual([]);
  });

  it('refuses to mark an untracked file instead of leaking the raw Git error', async () => {
    const cwd = await repositoryFixture();
    await writeFile(path.join(cwd, 'draft.txt'), 'x\n');
    const error = await rejectionOf(setAssumeUnchanged(cwd, 'draft.txt', true));
    expect(error.message).toContain('不在版本控制里');
    expect(await listMarkedFiles('repo', cwd)).toEqual([]);
  });

  it('rejects unsafe paths before touching the index', async () => {
    const cwd = await repositoryFixture();
    expect((await rejectionOf(setAssumeUnchanged(cwd, '../outside.txt', true))).message).toContain('路径');
  });
});
