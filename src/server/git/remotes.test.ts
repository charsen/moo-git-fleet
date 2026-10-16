import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { applyRemoteChange, listRemotes } from './remotes.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

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

/** 默认给一个 gitee 远端；传 `[]` 可造出「没有任何远端」的仓库（这正是本模块要救的场景）。 */
async function fixture(remotes: Array<[string, string]> = [['origin', 'git@gitee.com:charsen/moo-like.git']]): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-remotes-'));
  temporaryDirectories.push(root);
  const worker = path.join(root, 'worker');
  await execFileAsync('/usr/bin/git', ['init', '--initial-branch=master', worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);
  for (const [name, url] of remotes) await git(worker, ['remote', 'add', name, url]);

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
      defaultRemote: 'origin',
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

describe('listRemotes', () => {
  it('解析地址并标出默认远端，且默认远端排在最前', async () => {
    const { worker } = await fixture([
      ['upstream', 'git@gitee.com:other/moo-like.git'],
      ['origin', 'git@gitee.com:charsen/moo-like.git'],
    ]);
    const remotes = await listRemotes(worker, 'origin');

    expect(remotes.map((remote) => remote.name)).toEqual(['origin', 'upstream']);
    expect(remotes[0]).toMatchObject({
      name: 'origin',
      url: 'git@gitee.com:charsen/moo-like.git',
      protocol: 'ssh',
      host: 'gitee.com',
      isDefault: true,
      pushUrl: null,
    });
    expect(remotes[1]?.isDefault).toBe(false);
  });

  it('没有远端时返回空列表', async () => {
    const { worker } = await fixture([]);
    expect(await listRemotes(worker, 'origin')).toEqual([]);
  });

  it('只在推送地址确实不同时才报出 pushUrl', async () => {
    const { worker } = await fixture();
    await git(worker, ['remote', 'set-url', '--push', 'origin', 'https://gitee.com/charsen/moo-like.git']);

    const [remote] = await listRemotes(worker, 'origin');
    expect(remote?.url).toBe('git@gitee.com:charsen/moo-like.git');
    expect(remote?.pushUrl).toBe('https://gitee.com/charsen/moo-like.git');
  });

  it('无法解析的地址标记为 other，而不是当成 https', async () => {
    const { worker } = await fixture([['origin', '/srv/git/local.git']]);
    const [remote] = await listRemotes(worker, 'origin');
    expect(remote).toMatchObject({ protocol: 'other', host: null });
  });
});

describe('applyRemoteChange', () => {
  it('没有远端的仓库现在能补上原点（本模块要解决的核心场景）', async () => {
    const { worker, repository, config } = await fixture([]);
    const output = await applyRemoteChange(config, repository, worker, {
      kind: 'add',
      name: 'origin',
      url: 'git@gitee.com:charsen/moo-like.git',
    });

    expect(output.message).toBe('已添加远端 origin');
    expect(output.warning).toBeNull();
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('git@gitee.com:charsen/moo-like.git');
    expect(output.remotes).toHaveLength(1);
    // 状态里的 remoteUrl 必须同步刷新，界面才不会继续显示「未配置」
    expect(output.status.remoteUrl).toBe('git@gitee.com:charsen/moo-like.git');
  });

  it('拒绝同名远端', async () => {
    const { worker, repository, config } = await fixture();
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'add', name: 'origin', url: 'https://gitee.com/a/b.git' }),
    ).rejects.toThrow('已存在名为 origin 的远端');
  });

  it('拒绝会执行本地命令的 ext:: 地址', async () => {
    const { worker, repository, config } = await fixture([]);
    // 带空格的形式同时命中「空格」与「远程助手」两条规则，必须报出真正的理由。
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'add', name: 'evil', url: 'ext::sh -c whoami' }),
    ).rejects.toThrow('远程助手');
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'add', name: 'evil', url: 'ext::whoami' }),
    ).rejects.toThrow('远程助手');
    expect(await git(worker, ['remote'])).toBe('');
  });

  it('拒绝以 - 开头的远端名（会被 git 当成选项）', async () => {
    const { worker, repository, config } = await fixture([]);
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'add', name: '-o', url: 'https://gitee.com/a/b.git' }),
    ).rejects.toThrow('Git remote 名称不安全');
  });

  it('改地址只动 fetch 地址，并如实报出仍然不同的是推送地址', async () => {
    const { worker, repository, config } = await fixture();
    await git(worker, ['remote', 'set-url', '--push', 'origin', 'ssh://git@gitee.com:2222/charsen/moo-like.git']);

    const output = await applyRemoteChange(config, repository, worker, {
      kind: 'url',
      name: 'origin',
      url: 'https://gitee.com/charsen/moo-like.git',
    });

    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('https://gitee.com/charsen/moo-like.git');
    expect(output.remotes[0]?.pushUrl).toBe('ssh://git@gitee.com:2222/charsen/moo-like.git');
    expect(output.status.remoteUrl).toBe('https://gitee.com/charsen/moo-like.git');
  });

  it('新地址与当前相同时直接拒绝，不做无意义的写盘', async () => {
    const { worker, repository, config } = await fixture();
    await expect(
      applyRemoteChange(config, repository, worker, {
        kind: 'url',
        name: 'origin',
        url: 'git@gitee.com:charsen/moo-like.git',
      }),
    ).rejects.toThrow('新地址与当前地址相同');
  });

  it('拒绝不支持的协议，且不动任何已有配置', async () => {
    const { worker, repository, config } = await fixture();
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'url', name: 'origin', url: 'ftp://gitee.com/a/b.git' }),
    ).rejects.toThrow('不支持的协议');
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('git@gitee.com:charsen/moo-like.git');
  });

  it('重命名保留地址，并提醒默认远端被改名', async () => {
    const { worker, repository, config } = await fixture();
    const output = await applyRemoteChange(config, repository, worker, {
      kind: 'rename',
      name: 'origin',
      nextName: 'upstream',
    });

    expect(await git(worker, ['remote'])).toBe('upstream');
    expect(await git(worker, ['remote', 'get-url', 'upstream'])).toBe('git@gitee.com:charsen/moo-like.git');
    expect(output.message).toBe('远端 origin 已重命名为 upstream');
    // 改名后该仓库不再有名为 origin 的默认远端——必须明说，而不是留到下次 Pull 才发现
    expect(output.warning).toContain('舰队默认远端');
    expect(output.warning).toContain('upstream');
  });

  it('重命名非默认远端时不产生警告', async () => {
    const { worker, repository, config } = await fixture([
      ['origin', 'git@gitee.com:charsen/moo-like.git'],
      ['backup', 'git@gitee.com:charsen/moo-like-backup.git'],
    ]);
    const output = await applyRemoteChange(config, repository, worker, {
      kind: 'rename',
      name: 'backup',
      nextName: 'mirror',
    });
    expect(output.warning).toBeNull();
  });

  it('拒绝重命名到已存在的名字', async () => {
    const { worker, repository, config } = await fixture([
      ['origin', 'git@gitee.com:charsen/moo-like.git'],
      ['backup', 'git@gitee.com:charsen/moo-like-backup.git'],
    ]);
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'rename', name: 'backup', nextName: 'origin' }),
    ).rejects.toThrow('已存在名为 origin 的远端');
    expect(await git(worker, ['remote'])).toBe('backup\norigin');
  });

  it('删除远端并提醒默认远端被删掉', async () => {
    const { worker, repository, config } = await fixture();
    const output = await applyRemoteChange(config, repository, worker, { kind: 'remove', name: 'origin' });

    expect(await git(worker, ['remote'])).toBe('');
    expect(output.remotes).toEqual([]);
    expect(output.warning).toContain('舰队默认远端');
    // 默认远端没了，状态里的 remoteUrl 应随之变空
    expect(output.status.remoteUrl).toBeNull();
  });

  it('对不存在的远端操作时给出 404 语义而不是让 git 报错', async () => {
    const { worker, repository, config } = await fixture();
    await expect(
      applyRemoteChange(config, repository, worker, { kind: 'remove', name: 'nope' }),
    ).rejects.toThrow('仓库没有名为 nope 的远端');
    // 原有远端不受影响
    expect(await git(worker, ['remote', 'get-url', 'origin'])).toBe('git@gitee.com:charsen/moo-like.git');
  });
});
