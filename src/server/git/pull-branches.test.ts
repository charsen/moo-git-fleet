import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { pullBranches, pullBranchesPlan } from './pull-branches.js';

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

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), content);
  await git(cwd, ['add', file]);
  await git(cwd, ['-c', 'commit.gpgSign=false', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/**
 * 远端有 master 与 dev 两条线；worker 克隆后，seed 又各往两条线补了一笔并推上去，
 * worker `fetch` 后本地 master / dev 都落后 1 个提交，当前停在 dev（跟踪 origin/dev）。
 * 这正是「多分支 Pull」要处理的最常见形态：当前分支能与远端快进，主分支也能。
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-pull-branches-'));
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

  // 另一台机器往前走了两笔：worker fetch 后看到落后。
  await git(seed, ['checkout', 'master']);
  await commitFile(seed, 'master.txt', 'master work\n', 'master work');
  await git(seed, ['push', 'origin', 'master']);
  await git(seed, ['checkout', 'dev']);
  await commitFile(seed, 'dev.txt', 'dev work\n', 'dev work');
  await git(seed, ['push', 'origin', 'dev']);
  await git(worker, ['fetch', 'origin']);

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

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('pullBranchesPlan', () => {
  it('按档位挑出当前分支与主分支，分别标 pull 与 fast-forward，并算出落后数', async () => {
    const { config, repository } = await fixture();
    const plan = await pullBranchesPlan(config, repository, ['current', 'default', 'dev']);

    expect(plan.blocker).toBeNull();
    expect(plan.currentBranch).toBe('dev');
    expect(plan.branches.find((branch) => branch.name === 'dev')).toMatchObject({
      strategy: 'pull',
      behind: 1,
      blocker: null,
    });
    expect(plan.branches.find((branch) => branch.name === 'master')).toMatchObject({
      strategy: 'fast-forward',
      behind: 1,
      blocker: null,
    });
    // 两条分支都落后，都要拉。
    expect(plan.pending).toBe(2);
  });

  it('工作区不干净只挡当前分支那一条，非当前分支仍可快进', async () => {
    const { worker, config, repository } = await fixture();
    await appendFile(path.join(worker, 'README.md'), 'dirty\n');

    const plan = await pullBranchesPlan(config, repository, ['current', 'default']);
    // 当前分支走标准 Pull，脏工作区不能合并。
    expect(plan.branches.find((branch) => branch.name === 'dev')?.blocker).toContain('工作区有未提交改动');
    // 主分支只做 ref 快进、不碰工作区，不受影响。
    expect(plan.branches.find((branch) => branch.name === 'master')?.blocker).toBeNull();
    expect(plan.pending).toBe(1);
  });

  it('Detached HEAD 时当前分支档位给出跳过原因，主分支照常', async () => {
    const { worker, config, repository } = await fixture();
    await git(worker, ['checkout', '-q', '--detach']);

    const plan = await pullBranchesPlan(config, repository, ['current', 'default']);
    expect(plan.currentBranch).toBeNull();
    expect(plan.skipped.some((item) => item.name === '当前分支')).toBe(true);
    expect(plan.branches.map((branch) => branch.name)).toEqual(['master']);
  });

  it('本地与远端已分叉的非当前分支在预检里直接标阻塞', async () => {
    const { worker, config, repository } = await fixture();
    // 在 master 上补一笔本地提交再切回 dev：master 变成 ahead 1 / behind 1。
    await git(worker, ['checkout', '-q', 'master']);
    await commitFile(worker, 'local-master.txt', 'local\n', 'local master work');
    await git(worker, ['checkout', '-q', 'dev']);

    const plan = await pullBranchesPlan(config, repository, ['default']);
    expect(plan.branches.find((branch) => branch.name === 'master')?.blocker).toBe('本地与远端已分叉，需手动处理');
  });

  it('禁用 fetch 的仓库整体阻塞', async () => {
    const { config, repository } = await fixture();
    const blocked = { ...repository, capabilities: { ...repository.capabilities, fetch: false } };
    const plan = await pullBranchesPlan(config, blocked, ['current', 'default', 'dev']);
    expect(plan.blocker).toBe('仓库配置禁止 fetch 操作');
  });
});

describe('pullBranches', () => {
  it('先快进非当前分支，再拉当前分支，两条本地 ref 都追上远端', async () => {
    const { worker, remote, config, repository } = await fixture();
    const output = await pullBranches(config, repository, worker, { branches: ['dev', 'master'] });

    // 非当前分支（master）排在当前分支（dev）前面执行。
    expect(output.branches.map((branch) => [branch.name, branch.state])).toEqual([
      ['master', 'pulled'],
      ['dev', 'pulled'],
    ]);
    expect(await git(worker, ['rev-parse', 'master'])).toBe(await git(remote, ['rev-parse', 'refs/heads/master']));
    expect(await git(worker, ['rev-parse', 'dev'])).toBe(await git(remote, ['rev-parse', 'refs/heads/dev']));
    expect(output.summary).toContain('已更新');
  });

  it('分叉的非当前分支被远端拒绝，本地 ref 一步没动，其余分支照常', async () => {
    const { worker, remote, config, repository } = await fixture();
    // 让 master 分叉：本地补一笔，远端还有一笔未合入。
    await git(worker, ['checkout', '-q', 'master']);
    const localMaster = await commitFile(worker, 'local-master.txt', 'local\n', 'local master work');
    await git(worker, ['checkout', '-q', 'dev']);

    const output = await pullBranches(config, repository, worker, { branches: ['dev', 'master'] });
    expect(output.branches.find((branch) => branch.name === 'master')?.state).toBe('failed');
    expect(output.branches.find((branch) => branch.name === 'master')?.message).toContain('分叉');
    // 被拒的分支没被强制覆盖，仍是本地那笔提交。
    expect(await git(worker, ['rev-parse', 'master'])).toBe(localMaster);
    // 同一次里当前分支（dev）不受影响，仍然拉成功。
    expect(output.branches.find((branch) => branch.name === 'dev')?.state).toBe('pulled');
    expect(await git(worker, ['rev-parse', 'dev'])).toBe(await git(remote, ['rev-parse', 'refs/heads/dev']));
  });

  it('已经是最新的分支记为 up-to-date，不重复拉', async () => {
    const { worker, config, repository } = await fixture();
    await pullBranches(config, repository, worker, { branches: ['dev', 'master'] });

    const again = await pullBranches(config, repository, worker, { branches: ['dev', 'master'] });
    expect(again.branches.map((branch) => branch.state)).toEqual(['up-to-date', 'up-to-date']);
    expect(again.summary).toContain('已是最新');
  });

  it('请求里包含本地不存在的分支时记为 skipped，不抛错', async () => {
    const { worker, config, repository } = await fixture();
    const output = await pullBranches(config, repository, worker, { branches: ['release-nope'] });
    expect(output.branches[0]).toMatchObject({ name: 'release-nope', state: 'skipped' });
    expect(output.branches[0]?.message).toBe('本地没有这条分支');
  });
});
