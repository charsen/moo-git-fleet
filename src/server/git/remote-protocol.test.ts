import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { switchRemoteProtocol, type RemoteProbe } from './remote-protocol.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

/** 测试里不联网：默认探活永远成功，需要别的结论时显式注入。 */
const reachable: RemoteProbe = async () => 'reachable';

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

interface Fixture {
  root: string;
  worker: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
}

async function fixture(remoteUrl: string, remoteName = 'origin'): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-remote-protocol-'));
  temporaryDirectories.push(root);
  const worker = path.join(root, 'worker');
  await execFileAsync('/usr/bin/git', ['init', '--initial-branch=master', worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);
  await git(worker, ['remote', 'add', remoteName, remoteUrl]);

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
    aiCommitPolicy: 'disabled',
    capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
  };
  const config: RepositoriesConfig = {
    version: 1,
    settings: {
      roots: { test: root },
      defaultRemote: remoteName,
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [repository],
  };
  return { root, worker, repository, config };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('switchRemoteProtocol', () => {
  it('switches the default remote from ssh to https and persists it', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    const output = await switchRemoteProtocol(config, repository, worker, 'https', { probe: reachable });

    expect(output.from).toBe('git@gitee.com:charsen/moo-like.git');
    expect(output.to).toBe('https://gitee.com/charsen/moo-like.git');
    expect(output.verification).toBe('reachable');
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('https://gitee.com/charsen/moo-like.git');
    // 状态里的 remoteUrl 也应立即反映新地址
    expect(output.status.remoteUrl).toBe('https://gitee.com/charsen/moo-like.git');
  });

  it('switches back from https to ssh', async () => {
    const { worker, repository, config } = await fixture('https://gitee.com/charsen/moo-like.git');
    const output = await switchRemoteProtocol(config, repository, worker, 'ssh', { probe: reachable });
    expect(output.to).toBe('git@gitee.com:charsen/moo-like.git');
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('git@gitee.com:charsen/moo-like.git');
  });

  it('leaves the working tree and history untouched', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    const headBefore = await git(worker, ['rev-parse', 'HEAD']).catch(() => '');
    await switchRemoteProtocol(config, repository, worker, 'https', { probe: reachable });
    const headAfter = await git(worker, ['rev-parse', 'HEAD']).catch(() => '');
    expect(headAfter).toBe(headBefore);
  });

  it('rejects a remote that is already at the target protocol', async () => {
    const { worker, repository, config } = await fixture('https://gitee.com/charsen/moo-like.git');
    await expect(switchRemoteProtocol(config, repository, worker, 'https', { probe: reachable })).rejects.toThrow(
      '已经是 HTTPS',
    );
  });

  it('rejects a remote with a custom port rather than guessing', async () => {
    const { worker, repository, config } = await fixture('ssh://git@gitee.com:2222/charsen/moo-like.git');
    await expect(switchRemoteProtocol(config, repository, worker, 'https', { probe: reachable })).rejects.toThrow(
      '自定义端口',
    );
  });

  it('rejects when the configured remote is missing', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    // 仓库只有 origin，但配置指向一个不存在的 remote。
    const missingRemoteConfig: RepositoriesConfig = {
      ...config,
      settings: { ...config.settings, defaultRemote: 'missing' },
    };
    await expect(
      switchRemoteProtocol(missingRemoteConfig, repository, worker, 'https', { probe: reachable }),
    ).rejects.toThrow('missing');
  });

  it('keeps the switch when the probe reports a credential problem', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    const output = await switchRemoteProtocol(config, repository, worker, 'https', {
      probe: async () => 'needs-credential',
    });
    expect(output.verification).toBe('needs-credential');
    expect(output.note).toContain('凭证');
    // 地址是对的，必须保留
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('https://gitee.com/charsen/moo-like.git');
  });

  it('keeps the switch but flags it when the probe could not confirm', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    const output = await switchRemoteProtocol(config, repository, worker, 'https', {
      probe: async () => 'unverified',
    });
    expect(output.verification).toBe('unverified');
    expect(output.note).toBeTruthy();
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('https://gitee.com/charsen/moo-like.git');
  });

  it('rolls back to the original address when the probe says the repository is missing', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    await expect(
      switchRemoteProtocol(config, repository, worker, 'https', { probe: async () => 'address-missing' }),
    ).rejects.toThrow('已回滚');
    // 关键：地址必须回到原值，不能留下一个坏 remote
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('git@gitee.com:charsen/moo-like.git');
  });

  it('skips the probe when verification is disabled', async () => {
    const { worker, repository, config } = await fixture('git@gitee.com:charsen/moo-like.git');
    let probed = false;
    const output = await switchRemoteProtocol(config, repository, worker, 'https', {
      verify: false,
      probe: async () => {
        probed = true;
        return 'reachable';
      },
    });
    expect(probed).toBe(false);
    expect(output.verification).toBe('unverified');
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('https://gitee.com/charsen/moo-like.git');
  });
});
