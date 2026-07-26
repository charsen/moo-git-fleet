import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStash, createStash, dropStash, listStashes } from './stash.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('/usr/bin/git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

async function gitWrapper(
  name: string,
  hook: 'show' | 'drop' | 'push-after' = 'show',
): Promise<{ bin: string; marker: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `git-fleet-stash-wrapper-${name}-`));
  temporaryDirectories.push(root);
  const bin = path.join(root, 'bin');
  const marker = path.join(root, 'started');
  await mkdir(bin);
  const wrapper = path.join(bin, 'git');
  await writeFile(
    wrapper,
    hook === 'push-after'
      ? `#!/bin/sh\ncase " $* " in\n  *" stash push "*) /usr/bin/git "$@"; status=$?; printf '1' > "${marker}"; sleep 0.25; exit $status ;;\nesac\nexec /usr/bin/git "$@"\n`
      : `#!/bin/sh\ncase " $* " in\n  *" stash ${hook === 'drop' ? 'drop' : 'show --stat'} "*) printf '1' > "${marker}"; sleep 0.25 ;;\nesac\nexec /usr/bin/git "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  return { bin, marker };
}

async function waitForMarker(marker: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readFile(marker, 'utf8').catch(() => '')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Git wrapper marker was not created: ${marker}`);
}

function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
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
    expect(created.stat).toContain('untracked.txt');
    expect(created.stat).toContain('2 files changed');
    expect(await git(repository, ['status', '--porcelain'])).toBe('');
    await expect(applyStash(repository, created.ref, created.hash)).resolves.toMatchObject({ hash: created.hash });
    expect(await readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(await readFile(path.join(repository, 'untracked.txt'), 'utf8')).toBe('new\n');
    expect(await listStashes(repository)).toHaveLength(1);
  });

  it('returns the Stash it created when an external Stash is added before the result scan', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-create-race-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'selected stash\n');
    const { bin, marker } = await gitWrapper('create-post-race', 'push-after');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const creating = createStash(repository, 'selected backup', false);
      await waitForMarker(marker);
      await writeFile(path.join(repository, 'tracked.txt'), 'external stash\n');
      await git(repository, ['stash', 'push', '-m', 'external backup']);

      const created = await creating;
      const entries = await listStashes(repository);
      const selected = entries.find((entry) => entry.message.endsWith(': selected backup'));
      expect(selected).toBeDefined();
      expect(created.hash).toBe(selected?.hash);
      expect(created.message).toContain('selected backup');
      expect(entries).toHaveLength(2);
    } finally {
      process.env.PATH = originalPath;
    }
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

  // This fixture intentionally creates, lists and drops several real Git
  // stashes. On a busy macOS runner those subprocesses can exceed Vitest's
  // default 5s timeout even though the operation itself remains bounded.
  it('drops one selected entry when the same Stash hash appears more than once', { timeout: 15_000 }, async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-drop-duplicate-hash-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'duplicate stash\n');
    const created = await createStash(repository, 'duplicate backup', false);
    await writeFile(path.join(repository, 'tracked.txt'), 'different stash\n');
    await createStash(repository, 'different backup', false);
    await git(repository, ['stash', 'store', '-m', 'duplicate backup copy', created.hash]);
    expect((await listStashes(repository)).filter((entry) => entry.hash === created.hash)).toHaveLength(2);
    const selected = (await listStashes(repository))[0];
    if (!selected) throw new Error('expected a duplicate Stash entry');

    await expect(dropStash(repository, selected.ref, selected.hash)).resolves.toMatchObject({ hash: created.hash });
    const remaining = await listStashes(repository);
    expect(remaining).toHaveLength(2);
    expect(remaining.filter((entry) => entry.hash === created.hash)).toHaveLength(1);
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

  it('keeps control separators inside an externally created stash subject', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-control-separators-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repository, 'tracked.txt'), 'changed\n');
    const unusualSubject = 'edge\x1erecord\x1ffield';
    await git(repository, ['stash', 'push', '-m', unusualSubject]);

    const entries = await listStashes(repository);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toContain(unusualSubject);
  });

  it('applies the selected Stash hash when an external Stash reorders the list', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-apply-race-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'selected stash\n');
    const selected = await createStash(repository, 'selected backup', false);
    const { bin, marker } = await gitWrapper('apply-reorder');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const applying = applyStash(repository, selected.ref, selected.hash);
      await waitForMarker(marker);
      await writeFile(path.join(repository, 'tracked.txt'), 'external stash\n');
      await git(repository, ['stash', 'push', '-m', 'external backup']);

      await expect(applying).resolves.toMatchObject({ hash: selected.hash });
      expect(await readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('selected stash\n');
      expect(await listStashes(repository)).toHaveLength(2);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects a worktree change created after the initial Apply clean check', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-apply-worktree-race-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'selected stash\n');
    const selected = await createStash(repository, 'selected backup', false);
    const { bin, marker } = await gitWrapper('apply-worktree');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const applying = applyStash(repository, selected.ref, selected.hash);
      const applyingError = rejectionOf(applying);
      await waitForMarker(marker);
      await writeFile(path.join(repository, 'late.txt'), 'created during Apply validation\n');

      expect((await applyingError).message).toContain('工作区不干净');
      expect(await git(repository, ['status', '--porcelain', '--', 'late.txt'])).toContain('?? late.txt');
      expect(await readFile(path.join(repository, 'tracked.txt'), 'utf8')).toBe('initial\n');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects Drop when an external Stash changes the selected ref before deletion', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-drop-race-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'first stash\n');
    await createStash(repository, 'first backup', false);
    await writeFile(path.join(repository, 'tracked.txt'), 'second stash\n');
    await createStash(repository, 'second backup', false);
    const selected = (await listStashes(repository))[1];
    if (!selected) throw new Error('expected a second Stash entry');
    const hashesBefore = (await listStashes(repository)).map((entry) => entry.hash);
    const { bin, marker } = await gitWrapper('drop-reorder');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const dropping = dropStash(repository, selected.ref, selected.hash);
      const droppingError = rejectionOf(dropping);
      await waitForMarker(marker);
      await writeFile(path.join(repository, 'tracked.txt'), 'external stash\n');
      await git(repository, ['stash', 'push', '-m', 'external backup']);
      const externalHash = (await listStashes(repository))[0]?.hash;

      expect((await droppingError).message).toContain('Stash 列表已变化');
      expect((await listStashes(repository)).map((entry) => entry.hash)).toEqual([externalHash, ...hashesBefore]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('restores a different Stash if the ref changes during Drop itself', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stash-drop-post-race-'));
    temporaryDirectories.push(repository);
    await git(repository, ['init', '--initial-branch=master']);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    await git(repository, ['add', 'tracked.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repository, 'tracked.txt'), 'first stash\n');
    const first = await createStash(repository, 'first backup', false);
    await writeFile(path.join(repository, 'tracked.txt'), 'second stash\n');
    const second = await createStash(repository, 'second backup', false);
    const selected = (await listStashes(repository))[1];
    if (!selected) throw new Error('expected a second Stash entry');
    const { bin, marker } = await gitWrapper('drop-post-race', 'drop');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const dropping = dropStash(repository, selected.ref, selected.hash);
      const droppingError = rejectionOf(dropping);
      await waitForMarker(marker);
      await writeFile(path.join(repository, 'tracked.txt'), 'external stash\n');
      await git(repository, ['stash', 'push', '-m', 'external backup']);

      expect((await droppingError).message).toContain('已恢复误删条目');
      const hashes = (await listStashes(repository)).map((entry) => entry.hash);
      expect(hashes).toHaveLength(3);
      expect(hashes).toEqual(expect.arrayContaining([first.hash, second.hash]));
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
