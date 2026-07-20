import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  remote: string;
  seed: string;
  worker: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-commit-push-'));
  temporaryDirectories.push(root);
  vi.stubEnv('GIT_FLEET_HOME', root);
  vi.resetModules();
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const worker = path.join(root, 'worker');

  await execFileAsync('git', ['init', '--bare', '--initial-branch=master', remote]);
  await execFileAsync('git', ['clone', remote, seed]);
  await git(seed, ['config', 'user.name', 'Git Fleet Test']);
  await git(seed, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(seed, 'README.md'), 'initial\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
  await git(seed, ['push', '-u', 'origin', 'master']);
  await execFileAsync('git', ['clone', remote, worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);

  const repository: RepositoryConfig = {
    id: `commit-push-${path.basename(root)}`,
    name: 'commit-push-worker',
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

async function commitChange(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  worker: string,
  pushAfterCommit: boolean,
) {
  const [{ commitWithOptionalPush }, { commitPreview, commitStaged }, { scanRepository }] = await Promise.all([
    import('./commit-push.js'),
    import('./files.js'),
    import('./scanner.js'),
  ]);
  await writeFile(path.join(worker, 'local.txt'), 'local change\n');
  await git(worker, ['add', 'local.txt']);
  const preview = await commitPreview(worker);
  return commitWithOptionalPush(config, repository, worker, pushAfterCommit, async () => {
    const commit = await commitStaged(worker, 'feat: local change', preview.fingerprint);
    return {
      result: { ...commit, status: await scanRepository(config, repository) },
      message: `Commit ${commit.hash.slice(0, 7)} 完成`,
    };
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Commit followed by optional safe Push', () => {
  it('does not Push unless explicitly enabled', async () => {
    const { remote, worker, repository, config } = await fixture();
    const remoteBefore = await git(remote, ['rev-parse', 'refs/heads/master']);
    const output = await commitChange(config, repository, worker, false);

    expect(output.pushOperation).toBeNull();
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(remoteBefore);
    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(output.result.hash);
  });

  it('reuses the safe Push checks and records a separate Push operation', async () => {
    const { remote, worker, repository, config } = await fixture();
    const output = await commitChange(config, repository, worker, true);

    expect(output.pushOperation).toMatchObject({ type: 'push', state: 'success', message: 'Push 完成' });
    expect(output.message).toContain('Push 完成');
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(await git(worker, ['rev-parse', 'HEAD']));
  });

  it('rejects the combined request before Commit when Push capability is disabled', async () => {
    const { worker, repository, config } = await fixture();
    repository.capabilities.push = false;
    const headBefore = await git(worker, ['rev-parse', 'HEAD']);

    await expect(commitChange(config, repository, worker, true)).rejects.toThrow('仓库配置禁止 Push，未执行 Commit');

    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await git(worker, ['diff', '--cached', '--name-only'])).toBe('local.txt');
  });

  it('cancels Push when a Git hook changes the previewed tree', async () => {
    const { remote, worker, repository, config } = await fixture();
    const remoteBefore = await git(remote, ['rev-parse', 'refs/heads/master']);
    const hookPath = path.join(worker, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\nprintf "hooked\\n" >> README.md\ngit add README.md\n');
    await chmod(hookPath, 0o755);

    const output = await commitChange(config, repository, worker, true);

    expect(output.result.treeMatches).toBe(false);
    expect(output.pushOperation).toBeNull();
    expect(output.message).toContain('安全 Push 已取消');
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(remoteBefore);
  });

  it('keeps the local Commit and reports the failed Push when the remote moved', async () => {
    const { remote, seed, worker, repository, config } = await fixture();
    await writeFile(path.join(seed, 'remote.txt'), 'remote change\n');
    await git(seed, ['add', 'remote.txt']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'feat: remote change']);
    await git(seed, ['push']);
    const remoteHead = await git(remote, ['rev-parse', 'refs/heads/master']);

    const output = await commitChange(config, repository, worker, true);

    expect(output.operation.state).toBe('success');
    expect(output.pushOperation).toMatchObject({ type: 'push', state: 'failed' });
    expect(output.message).toContain('Commit 已保留在本地');
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(remoteHead);
    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(output.result.hash);
    expect(output.result.hash).not.toBe(remoteHead);
  });
});
