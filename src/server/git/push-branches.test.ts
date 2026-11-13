import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { parsePushPorcelain, pushBranches, pushBranchesPlan } from './push-branches.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface Fixture {
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

async function remoteRef(remote: string, branch: string): Promise<string> {
  return git(remote, ['rev-parse', `refs/heads/${branch}`]);
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), content);
  await git(cwd, ['add', file]);
  await git(cwd, ['-c', 'commit.gpgSign=false', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/**
 * 远端上有 master 与 dev 两条线，worker 两个分支各领先一笔提交。
 * `worker` 当前停在 dev，因此预选应当正好是 dev + master。
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-push-branches-'));
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
  await git(seed, ['branch', 'dev']);
  await git(seed, ['push', '-u', 'origin', 'dev']);

  await execFileAsync('/usr/bin/git', ['clone', remote, worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);
  await git(worker, ['checkout', '-b', 'dev', '--track', 'origin/dev']);
  await commitFile(worker, 'dev.txt', 'dev work\n', 'dev work');
  await git(worker, ['checkout', 'master']);
  await commitFile(worker, 'master.txt', 'master work\n', 'master work');
  await git(worker, ['checkout', 'dev']);

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

function selection(plan: Awaited<ReturnType<typeof pushBranchesPlan>>, names: string[]) {
  return names.map((name) => {
    const branch = plan.branches.find((item) => item.name === name);
    if (!branch) throw new Error(`分支不存在：${name}`);
    return { name: branch.name, head: branch.head };
  });
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('parsePushPorcelain', () => {
  it('逐行读 ref 状态，跳过 To / Done 这类非表格行', () => {
    const output = [
      'To /tmp/remote.git',
      ' \trefs/heads/dev:refs/heads/dev\tabc..def',
      '*\trefs/heads/main:refs/heads/main\t[new branch]',
      '=\trefs/heads/old:refs/heads/old\t[up to date]',
      '!\trefs/heads/behind:refs/heads/behind\t[rejected] (non-fast-forward)',
      'Done',
    ].join('\n');
    expect(parsePushPorcelain(output)).toEqual([
      { flag: ' ', destination: 'refs/heads/dev', summary: 'abc..def' },
      { flag: '*', destination: 'refs/heads/main', summary: '[new branch]' },
      { flag: '=', destination: 'refs/heads/old', summary: '[up to date]' },
      { flag: '!', destination: 'refs/heads/behind', summary: '[rejected] (non-fast-forward)' },
    ]);
  });

  it('空输出与错误文案不产出条目', () => {
    expect(parsePushPorcelain('')).toEqual([]);
    expect(parsePushPorcelain('fatal: 无法访问远端仓库\n')).toEqual([]);
  });
});

describe('pushBranchesPlan', () => {
  it('预选当前分支与远端默认分支，没有 upstream 的分支给出禁用原因', async () => {
    const { worker, config, repository } = await fixture();
    await git(worker, ['branch', 'wip']);
    const plan = await pushBranchesPlan(config, repository, worker);

    expect(plan.blocker).toBeNull();
    expect(plan.defaultRemote).toBe('origin');
    expect(plan.defaultBranch).toBe('master');
    expect(plan.suggested).toEqual(['dev', 'master']);
    expect(plan.branches.find((branch) => branch.name === 'dev')?.upstream).toBe('origin/dev');
    expect(plan.branches.find((branch) => branch.name === 'wip')?.blocker).toBe('没有 upstream');
  });

  it('站在主分支上时把 dev 一起预选，正是「dev + 主分支」的常见用法', async () => {
    const { worker, config, repository } = await fixture();
    await git(worker, ['checkout', 'master']);
    const plan = await pushBranchesPlan(config, repository, worker);
    expect(plan.suggested).toEqual(['master', 'dev']);
  });

  it('可推的分支排在前面，被挡下的垫后', async () => {
    const { worker, config, repository } = await fixture();
    // 名字故意排在字母序最前：排序失效的话它会回到第一位，挡住真正能推的那两条。
    await git(worker, ['branch', 'aaa-draft']);
    const plan = await pushBranchesPlan(config, repository, worker);
    expect(plan.branches.map((branch) => branch.name)).toEqual(['dev', 'master', 'aaa-draft']);
    expect(plan.branches.at(-1)?.blocker).toBe('没有 upstream');
    // 预选按名字匹配，不受展示顺序影响。
    expect(plan.suggested).toEqual(['dev', 'master']);
  });

  it('两条分支跟踪同一个远端分支时只留一条可推，另一条说明原因', async () => {
    const { worker, config, repository } = await fixture();
    // develop 也指向 origin/dev：一次命令里会出现两条目的相同的 refspec，
    // git 会整体报 `receives from more than one src`，连本来能推的那条也不动。
    await git(worker, ['checkout', '-b', 'develop', 'origin/dev']);
    await commitFile(worker, 'more.txt', 'more\n', 'develop work');
    await git(worker, ['branch', '--set-upstream-to=origin/dev']);
    await git(worker, ['checkout', 'dev']);

    const plan = await pushBranchesPlan(config, repository, worker);
    // 当前分支（dev）优先占用目的 ref，后到的那条被挡下。
    expect(plan.branches.find((branch) => branch.name === 'dev')?.blocker).toBeNull();
    expect(plan.branches.find((branch) => branch.name === 'develop')?.blocker).toBe('与 dev 指向同一个远端分支');
    expect(plan.suggested).not.toContain('develop');
  });

  it('禁用推送的仓库整体阻塞', async () => {
    const { worker, config, repository } = await fixture();
    const blocked = { ...repository, capabilities: { ...repository.capabilities, push: false } };
    const plan = await pushBranchesPlan(config, blocked, worker);
    expect(plan.blocker).toBe('仓库配置禁止推送');
    expect(plan.suggested).toEqual([]);
  });
});

describe('pushBranches', () => {
  it('一次推送 dev + master 两条分支', async () => {
    const { worker, remote, config, repository } = await fixture();
    const plan = await pushBranchesPlan(config, repository, worker);
    const output = await pushBranches(config, repository, worker, { branches: selection(plan, ['dev', 'master']) });

    expect(output.branches.map((branch) => branch.state)).toEqual(['pushed', 'pushed']);
    expect(output.summary).toBe('已推送 dev、master');
    expect(await remoteRef(remote, 'dev')).toBe(await git(worker, ['rev-parse', 'dev']));
    expect(await remoteRef(remote, 'master')).toBe(await git(worker, ['rev-parse', 'master']));
  });

  it('落后远端的分支被跳过，其余分支照常推送', async () => {
    const { worker, seed, remote, config, repository } = await fixture();
    await git(seed, ['checkout', 'master']);
    const incoming = await commitFile(seed, 'incoming.txt', 'from another machine\n', 'incoming');
    await git(seed, ['push', 'origin', 'master']);
    await git(worker, ['fetch', '--prune', 'origin']);

    const plan = await pushBranchesPlan(config, repository, worker);
    expect(plan.branches.find((branch) => branch.name === 'master')?.blocker).toBe('落后远端 1 个提交，需先同步');

    const output = await pushBranches(config, repository, worker, { branches: selection(plan, ['dev', 'master']) });
    expect(output.branches.map((branch) => [branch.name, branch.state])).toEqual([
      ['dev', 'pushed'],
      ['master', 'skipped'],
    ]);
    expect(output.summary).toBe('已推送 dev');
    // 落后的分支一行都没动，远端仍是另一台机器推上去的那个提交。
    expect(await remoteRef(remote, 'master')).toBe(incoming);
  });

  it('远端未被 fetch 就先行前移时按被拒处理，且绝不 force 覆盖', async () => {
    const { worker, seed, remote, config, repository } = await fixture();
    const plan = await pushBranchesPlan(config, repository, worker);
    await git(seed, ['checkout', 'master']);
    const incoming = await commitFile(seed, 'incoming.txt', 'from another machine\n', 'incoming');
    await git(seed, ['push', 'origin', 'master']);

    // 本地没有 fetch，ahead/behind 仍是旧值，于是真的会发一次 push，由远端拒绝。
    const output = await pushBranches(config, repository, worker, { branches: selection(plan, ['master']) });
    expect(output.branches[0]?.state).toBe('rejected');
    expect(output.branches[0]?.message).toContain('请先 Pull 或同步');
    expect(output.summary).toBe('master 被远端拒绝');
    expect(await remoteRef(remote, 'master')).toBe(incoming);
  });

  it('同一条命令里一条成功一条被拒：逐 ref 判状态，不被整体失败带偏', async () => {
    const { worker, seed, remote, config, repository } = await fixture();
    const plan = await pushBranchesPlan(config, repository, worker);
    // 远端 master 被别的机器推到前面去，worker 还没 fetch（ahead/behind 仍是旧值）。
    await git(seed, ['checkout', 'master']);
    const incoming = await commitFile(seed, 'incoming.txt', 'from another machine\n', 'incoming');
    await git(seed, ['push', 'origin', 'master']);

    const output = await pushBranches(config, repository, worker, { branches: selection(plan, ['dev', 'master']) });
    expect(output.branches.map((branch) => [branch.name, branch.state])).toEqual([
      ['dev', 'pushed'],
      ['master', 'rejected'],
    ]);
    expect(output.summary).toBe('已推送 dev；master 被远端拒绝');
    // 成功的那个真的上去了，被拒的那个一行没动。
    expect(await remoteRef(remote, 'dev')).toBe(await git(worker, ['rev-parse', 'dev']));
    expect(await remoteRef(remote, 'master')).toBe(incoming);
  });

  it('预览后分支又长了新提交时拒绝推送该分支，其他分支不受影响', async () => {
    const { worker, config, repository } = await fixture();
    const plan = await pushBranchesPlan(config, repository, worker);
    await commitFile(worker, 'late.txt', 'late\n', 'late commit');

    const output = await pushBranches(config, repository, worker, { branches: selection(plan, ['dev', 'master']) });
    expect(output.branches.map((branch) => [branch.name, branch.state])).toEqual([
      ['dev', 'failed'],
      ['master', 'pushed'],
    ]);
    expect(output.branches[0]?.message).toBe('分支在预览后已变化，请重新打开后重试');
  });

  it('没有新提交的分支在预检阶段就被跳过，不再发网络请求', async () => {
    const { worker, config, repository } = await fixture();
    const first = await pushBranchesPlan(config, repository, worker);
    await pushBranches(config, repository, worker, { branches: selection(first, ['dev', 'master']) });

    // push 会顺手更新 origin/* 跟踪引用，重新取的计划里两条分支都已是「没有需要推送的提交」。
    const second = await pushBranchesPlan(config, repository, worker);
    expect(second.branches.find((branch) => branch.name === 'dev')?.ahead).toBe(0);
    const output = await pushBranches(config, repository, worker, { branches: selection(second, ['dev', 'master']) });
    expect(output.branches.map((branch) => branch.state)).toEqual(['skipped', 'skipped']);
    expect(output.branches[0]?.message).toBe('没有需要推送的提交');
    expect(output.summary).toBe('没有分支需要推送');
  });

  it('禁用推送时整次拒绝', async () => {
    const { worker, config, repository } = await fixture();
    const blocked = { ...repository, capabilities: { ...repository.capabilities, push: false } };
    await expect(
      pushBranches(config, blocked, worker, { branches: [{ name: 'dev', head: await git(worker, ['rev-parse', 'dev']) }] }),
    ).rejects.toThrow('仓库配置禁止 push 操作');
  });
});
