import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { pullRepository, pushRepository, syncRepository } from './actions.js';

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

  it('integrates a diverged branch on Pull (merge commit)', async () => {
    const { seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote change\n', 'remote change');
    await git(seed, ['push']);
    await commitFile(worker, 'local.txt', 'local change\n', 'local change');

    const pull = await pullRepository(config, repository, worker);
    expect(pull.skipped).toBe(false);
    expect(pull.status.behind).toBe(0);
    // 分叉 Pull 产生 merge commit（两个父）
    const parents = (await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(/\s+/);
    expect(parents).toHaveLength(3);
  });

  it('rebase integrates a diverged branch on Pull without a merge commit', async () => {
    const { seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote change\n', 'remote change');
    await git(seed, ['push']);
    await commitFile(worker, 'local.txt', 'local change\n', 'local change');

    const pull = await pullRepository(config, repository, worker, { rebase: true });
    expect(pull.skipped).toBe(false);
    expect(pull.status.behind).toBe(0);
    const parents = (await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(/\s+/);
    expect(parents).toHaveLength(2); // 线性，无 merge commit
    expect(await git(worker, ['show', 'HEAD:local.txt'])).toBe('local change');
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
      `case " $* " in\n  *" merge --no-edit "*) printf '1' > "${path.join(root, 'pull-merge-started')}"; sleep 0.25 ;;\nesac`,
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

describe('syncRepository', () => {
  it('fast-forwards when only behind', async () => {
    const { seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote update\n', 'remote update');
    await git(seed, ['push']);

    const sync = await syncRepository(config, repository, worker);
    expect(sync.skipped).toBe(false);
    expect(sync.status.behind).toBe(0);
    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(await git(seed, ['rev-parse', 'HEAD']));
  });

  it('merges a diverged branch and auto-pushes the result', async () => {
    const { remote, seed, worker, repository, config } = await fixture();
    // 远端领先：seed 改了 README
    await commitFile(seed, 'README.md', 'remote change\n', 'remote change');
    await git(seed, ['push']);
    // 本地领先：worker 改了另一个文件
    const localHead = await commitFile(worker, 'local.txt', 'local change\n', 'local change');

    const sync = await syncRepository(config, repository, worker);
    expect(sync.skipped).toBe(false);
    expect(sync.status.behind).toBe(0);
    // merge 后自动 push，本地不再领先
    expect(sync.status.ahead).toBe(0);
    // 分叉合并后应产生一个 merge commit（两个父提交）
    const parents = (await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(/\s+/);
    expect(parents).toHaveLength(3); // HEAD + 两个父
    // 本地提交仍在历史里
    expect(await git(worker, ['merge-base', '--is-ancestor', localHead, 'HEAD'])).toBe('');
    // 远端已被推送，包含 merge commit
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(await git(worker, ['rev-parse', 'HEAD']));
  });

  it('auto-pushes when only ahead', async () => {
    const { remote, worker, repository, config } = await fixture();
    const localHead = await commitFile(worker, 'local.txt', 'local only\n', 'local only');

    const sync = await syncRepository(config, repository, worker);
    expect(sync.skipped).toBe(false);
    expect(sync.status.ahead).toBe(0);
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(localHead);
  });

  it('pauses with merge-paused code on conflict', async () => {
    const { seed, worker, repository, config } = await fixture();
    // 两边改同一文件同一位置，制造冲突
    await writeFile(path.join(seed, 'conflict.txt'), 'remote\n');
    await git(seed, ['add', 'conflict.txt']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'remote conflict']);
    await git(seed, ['push']);
    await writeFile(path.join(worker, 'conflict.txt'), 'local\n');
    await git(worker, ['add', 'conflict.txt']);
    await git(worker, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'local conflict']);

    const error = await syncRepository(config, repository, worker).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const code = (error as { code?: string }).code;
    expect(code).toBe('merge-paused');
  });

  it('skips when up to date', async () => {
    const { worker, repository, config } = await fixture();
    const sync = await syncRepository(config, repository, worker);
    expect(sync.skipped).toBe(true);
    expect(sync.skipReason).toBe('not-needed');
  });

  it('rejects when worktree is dirty', async () => {
    const { seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote update\n', 'remote update');
    await git(seed, ['push']);
    await writeFile(path.join(worker, 'dirty.txt'), 'uncommitted\n');

    await expect(syncRepository(config, repository, worker)).rejects.toThrow('工作区不干净');
  });

  it('auto-stashes and restores local changes around a pull', async () => {
    const { seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote update\n', 'remote update');
    await git(seed, ['push']);
    // 本地未提交改动
    await writeFile(path.join(worker, 'wip.txt'), 'work in progress\n');

    const pull = await pullRepository(config, repository, worker, { stashFirst: true });
    expect(pull.skipped).toBe(false);
    expect(pull.status.behind).toBe(0);
    // 拉取完成后，本地改动被自动恢复
    expect(await git(worker, ['status', '--porcelain', '--', 'wip.txt'])).toContain('?? wip.txt');
    // stash 列表应已清空（pop 恢复后无残留）
    const stashes = await git(worker, ['stash', 'list']);
    expect(stashes).toBe('');
  });

  it('auto-stashes around a diverged sync', async () => {
    const { seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote change\n', 'remote change');
    await git(seed, ['push']);
    await commitFile(worker, 'local.txt', 'local change\n', 'local change');
    await writeFile(path.join(worker, 'wip.txt'), 'work in progress\n');

    const sync = await syncRepository(config, repository, worker, { stashFirst: true });
    expect(sync.skipped).toBe(false);
    expect(sync.status.ahead).toBe(0);
    // 改动被恢复
    expect(await git(worker, ['status', '--porcelain', '--', 'wip.txt'])).toContain('?? wip.txt');
    expect(await git(worker, ['stash', 'list'])).toBe('');
  });

  it('rebase produces a linear history without a merge commit', async () => {
    const { remote, seed, worker, repository, config } = await fixture();
    await commitFile(seed, 'README.md', 'remote change\n', 'remote change');
    await git(seed, ['push']);
    const localHead = await commitFile(worker, 'local.txt', 'local change\n', 'local change');

    const sync = await syncRepository(config, repository, worker, { rebase: true });
    expect(sync.skipped).toBe(false);
    expect(sync.status.ahead).toBe(0);
    // rebase 后 HEAD 只有一个父提交（线性历史，无 merge commit）
    const parents = (await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(/\s+/);
    expect(parents).toHaveLength(2); // HEAD + 一个父
    // 本地提交内容仍在（rebase 重放后 hash 变化，但内容保留）
    expect(await git(worker, ['show', 'HEAD:local.txt'])).toBe('local change');
    // 远端已推送
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(await git(worker, ['rev-parse', 'HEAD']));
    expect(localHead).not.toBe(await git(worker, ['rev-parse', 'HEAD']));
  });

  it('restores the auto-stash even when integration pauses on conflict', async () => {
    const { seed, worker, repository, config } = await fixture();
    // 制造冲突：两边改同一文件同一位置
    await writeFile(path.join(seed, 'conflict.txt'), 'remote\n');
    await git(seed, ['add', 'conflict.txt']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'remote conflict']);
    await git(seed, ['push']);
    await writeFile(path.join(worker, 'conflict.txt'), 'local\n');
    await git(worker, ['add', 'conflict.txt']);
    await git(worker, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'local conflict']);
    // 另有未提交改动，勾选 Auto Stash
    await writeFile(path.join(worker, 'wip.txt'), 'work in progress\n');

    const error = await pullRepository(config, repository, worker, { stashFirst: true }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe('merge-paused');
    // 关键：冲突暂停时，用户的未提交改动仍被恢复到工作区（在 stash 列表，非丢失）
    expect(await git(worker, ['stash', 'list'])).not.toBe('');
  });
});
