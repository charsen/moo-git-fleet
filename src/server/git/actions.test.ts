import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { pullRepository, pushRepository } from './actions.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface ActionFixture {
  root: string;
  remote: string;
  seed: string;
  worker: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), content);
  await git(cwd, ['add', file]);
  await git(cwd, ['-c', 'commit.gpgSign=false', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function fixture(): Promise<ActionFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-actions-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const worker = path.join(root, 'worker');

  await execFileAsync('/usr/bin/git', ['init', '--bare', '--initial-branch=master', remote]);
  await execFileAsync('/usr/bin/git', ['clone', remote, seed]);
  await git(seed, ['config', 'user.name', 'Git Fleet Test']);
  await git(seed, ['config', 'user.email', 'git-fleet@example.test']);
  await commitFile(seed, 'README.md', 'initial\n', 'initial');
  await git(seed, ['push', '-u', 'origin', 'master']);
  await execFileAsync('/usr/bin/git', ['clone', remote, worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);

  const repository: RepositoryConfig = {
    id: 'worker-test',
    name: 'worker',
    root: 'test',
    path: 'worker',
    group: 'tests',
    enabled: true,
    pinned: false,
    order: 10,
    tags: [],
    aiCommitPolicy: 'redacted-patch',
    capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
  };
  const config: RepositoriesConfig = {
    version: 1,
    settings: {
      roots: { test: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [repository],
  };
  return { root, remote, seed, worker, repository, config };
}

async function gitWrapper(root: string, name: string, body: string): Promise<{ bin: string; marker: string }> {
  const bin = path.join(root, `bin-${name}`);
  const marker = path.join(root, `${name}-started`);
  await mkdir(bin);
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!/bin/sh\n${body}\nexec /usr/bin/git "$@"\n`);
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('safe Git actions', () => {
  it('pulls by fast-forward and pushes with an explicit upstream ref', async () => {
    const { remote, seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote update\n', 'remote update');
    await git(seed, ['push']);

    const pull = await pullRepository(config, repository, worker);
    expect(pull.skipped).toBe(false);
    expect(pull.status.behind).toBe(0);

    await commitFile(worker, 'local.txt', 'local commit\n', 'local update');
    const push = await pushRepository(config, repository, worker);
    expect(push.skipped).toBe(false);
    expect(push.status.ahead).toBe(0);
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(await git(worker, ['rev-parse', 'HEAD']));
  });

  it('pushes only the confirmed HEAD when an external Commit appears after final validation', async () => {
    const { root, remote, worker, repository, config } = await fixture();
    const confirmedHead = await commitFile(worker, 'confirmed.txt', 'confirmed before push\n', 'confirmed push');
    const { bin, marker } = await gitWrapper(
      root,
      'push-command',
      `case " $* " in\n  *" push --porcelain "*) printf '1' > "${path.join(root, 'push-command-started')}"; sleep 0.25 ;;\nesac`,
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const pushing = pushRepository(config, repository, worker);
      await waitForMarker(marker);
      const lateHead = await commitFile(worker, 'late.txt', 'created after push validation\n', 'late external commit');

      const output = await pushing;
      expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(confirmedHead);
      expect(await git(remote, ['rev-parse', 'refs/heads/master'])).not.toBe(lateHead);
      expect(output.status.ahead).toBe(1);
      expect(output.message).toContain('新 commit 未被推送');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects Push when HEAD changes before the final validation', async () => {
    const { root, remote, worker, repository, config } = await fixture();
    const remoteBefore = await git(remote, ['rev-parse', 'refs/heads/master']);
    await commitFile(worker, 'confirmed.txt', 'confirmed before push\n', 'confirmed push');
    const { bin, marker } = await gitWrapper(
      root,
      'push-validation',
      `case " $* " in\n  *" check-ref-format refs/heads/master "*) printf '1' > "${path.join(root, 'push-validation-started')}"; sleep 0.25 ;;\nesac`,
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const pushing = pushRepository(config, repository, worker);
      await waitForMarker(marker);
      await commitFile(worker, 'later.txt', 'created before final push validation\n', 'later external commit');

      await expect(pushing).rejects.toThrow('当前分支或 HEAD 已变化');
      expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(remoteBefore);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('pulls only the confirmed upstream Commit when an external Fetch moves the tracking ref', async () => {
    const { root, seed, worker, repository, config } = await fixture();
    const confirmedUpstream = await commitFile(seed, 'confirmed.txt', 'confirmed remote update\n', 'confirmed remote update');
    await git(seed, ['push']);
    const { bin, marker } = await gitWrapper(
      root,
      'pull-merge',
      `case " $* " in\n  *" merge --ff-only "*) printf '1' > "${path.join(root, 'pull-merge-started')}"; sleep 0.25 ;;\nesac`,
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const pulling = pullRepository(config, repository, worker);
      await waitForMarker(marker);
      const lateUpstream = await commitFile(seed, 'late-remote.txt', 'late remote update\n', 'late remote update');
      await git(seed, ['push']);
      await git(worker, ['fetch', 'origin']);

      const output = await pulling;
      expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(confirmedUpstream);
      expect(await git(worker, ['rev-parse', 'HEAD'])).not.toBe(lateUpstream);
      expect(output.status.behind).toBe(1);
      expect(output.message).toContain('upstream 出现新提交');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects Pull when an external tool switches branches before final validation', async () => {
    const { root, seed, worker, repository, config } = await fixture();
    const initialHead = await git(worker, ['rev-parse', 'HEAD']);
    await git(worker, ['branch', '--track', 'other', 'origin/master']);
    await commitFile(seed, 'remote.txt', 'remote update\n', 'remote update');
    await git(seed, ['push']);
    const { bin, marker } = await gitWrapper(
      root,
      'pull-branch-validation',
      `case " $* " in\n  *" for-each-ref --count=1 --format=%(upstream) "*) printf '1' > "${path.join(root, 'pull-branch-validation-started')}"; sleep 0.25 ;;\nesac`,
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const pulling = pullRepository(config, repository, worker);
      await waitForMarker(marker);
      await git(worker, ['switch', 'other']);

      await expect(pulling).rejects.toThrow('当前分支或 HEAD 已变化');
      expect(await git(worker, ['rev-parse', 'refs/heads/master'])).toBe(initialHead);
      expect(await git(worker, ['rev-parse', 'refs/heads/other'])).toBe(initialHead);
      expect(await git(worker, ['branch', '--show-current'])).toBe('other');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects Pull when a worktree change appears before final validation', async () => {
    const { root, seed, worker, repository, config } = await fixture();
    const initialHead = await git(worker, ['rev-parse', 'HEAD']);
    await commitFile(seed, 'remote.txt', 'remote update\n', 'remote update');
    await git(seed, ['push']);
    const { bin, marker } = await gitWrapper(
      root,
      'pull-worktree-validation',
      `case " $* " in\n  *" for-each-ref --count=1 --format=%(upstream) "*) printf '1' > "${path.join(root, 'pull-worktree-validation-started')}"; sleep 0.25 ;;\nesac`,
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const pulling = pullRepository(config, repository, worker);
      await waitForMarker(marker);
      await writeFile(path.join(worker, 'late.txt'), 'created before final pull validation\n');

      await expect(pulling).rejects.toThrow('工作区不干净');
      expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(initialHead);
      expect(await git(worker, ['status', '--porcelain', '--', 'late.txt'])).toContain('?? late.txt');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
