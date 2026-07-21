import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStash, createStash, dropStash, listStashes } from './stash.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('stash management', () => {
  it('creates a backup including untracked files and applies it without dropping the stash', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repository, 'tracked.txt'), 'changed\n');
    await writeFile(path.join(repository, 'untracked.txt'), 'new\n');
    const created = await createStash(repository, 'safe backup', true);

    expect(created.message).toContain('safe backup');
    expect(await git(repository, ['status', '--porcelain'])).toBe('');
    await expect(applyStash(repository, created.ref, created.hash)).resolves.toMatchObject({ hash: created.hash });
    expect(await readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(await readFile(path.join(repository, 'untracked.txt'), 'utf8')).toBe('new\n');
    expect(await listStashes(repository)).toHaveLength(1);
  });

  it('rejects a stale stash identity before changing the worktree', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-stale-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'changed\n');
    const created = await createStash(repository, 'safe backup', false);

    await expect(applyStash(repository, created.ref, '0'.repeat(40))).rejects.toThrow('Stash 列表已变化');
    expect(await git(repository, ['status', '--porcelain'])).toBe('');
  });

  it('drops only the stash entry matching the current ref and hash', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-drop-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repository, 'tracked.txt'), 'first\n');
    const first = await createStash(repository, 'first backup', false);
    await writeFile(path.join(repository, 'tracked.txt'), 'second\n');
    const second = await createStash(repository, 'second backup', false);

    await expect(dropStash(repository, second.ref, second.hash)).resolves.toMatchObject({ hash: second.hash });
    expect((await listStashes(repository)).map((entry) => entry.hash)).toEqual([first.hash]);
  });

  it('rejects a stale stash ref after the list order changes', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-drop-stale-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'first\n');
    const first = await createStash(repository, 'first backup', false);
    await writeFile(path.join(repository, 'tracked.txt'), 'second\n');
    await createStash(repository, 'second backup', false);

    await expect(dropStash(repository, first.ref, first.hash)).rejects.toThrow('Stash 列表已变化');
    expect(await listStashes(repository)).toHaveLength(2);
  });
});
