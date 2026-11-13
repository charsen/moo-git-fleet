import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { mergeBranchesIntoLines, mergeBranchesPlan } from './merge-branches.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface Fixture {
  root: string;
  remote: string;
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

function buildConfig(root: string, worker: string): { repository: RepositoryConfig; config: RepositoriesConfig } {
  const repository: RepositoryConfig = {
    id: 'worker-test',
    name: 'worker',
    root: 'test',
    path: path.relative(root, worker),
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
  return { repository, config };
}

/**
 * 远端有 master + dev；worker 上两条任务分支：
 * - `feature-a` 从 master 分出，加一个 `feature-a.txt`；
 * - `feature-b` 从 master 分出，改 `shared.txt`。
 * 当前停在 `feature-a`。
 *
 * `conflicting: true` 时 feature-a 也改 `shared.txt`，两条分支合进同一条线必然冲突。
 */
async function fixture(options: { conflicting?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-merge-branches-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const worker = path.join(root, 'worker');

  await execFileAsync('/usr/bin/git', ['init', '--bare', '--initial-branch=master', remote]);
  await execFileAsync('/usr/bin/git', ['clone', remote, seed]);
  await git(seed, ['config', 'user.name', 'Git Fleet Test']);
  await git(seed, ['config', 'user.email', 'git-fleet@example.test']);
  await commitFile(seed, 'README.md', 'initial\n', 'initial');
  await commitFile(seed, 'shared.txt', 'base\n', 'shared base');
  await git(seed, ['push', '-u', 'origin', 'master']);
  await git(seed, ['branch', 'dev']);
  await git(seed, ['push', '-u', 'origin', 'dev']);

  await execFileAsync('/usr/bin/git', ['clone', remote, worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);
  await git(worker, ['checkout', '-b', 'dev', '--track', 'origin/dev']);
  await git(worker, ['checkout', 'master']);

  await git(worker, ['checkout', '-b', 'feature-a']);
  await commitFile(worker, 'feature-a.txt', 'a\n', 'feature a');
  if (options.conflicting) await commitFile(worker, 'shared.txt', 'a\n', 'feature a shared');
  await git(worker, ['checkout', 'master']);
  await git(worker, ['checkout', '-b', 'feature-b']);
  await commitFile(worker, 'shared.txt', 'b\n', 'feature b');
  await git(worker, ['checkout', 'feature-a']);

  const { repository, config } = buildConfig(root, worker);
  return { root, remote, worker, repository, config };
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('mergeBranchesPlan', () => {
  it('识别双线目标，并把非双线分支按「快进 / 合并提交」分好', async () => {
    const { config, repository, worker } = await fixture();
    const plan = await mergeBranchesPlan(config, repository);

    expect(plan.blocker).toBeNull();
    // dev 在前、主分支在后；master 由远端 HEAD 识别出来。
    expect(plan.targets).toEqual(['dev', 'master']);
    // 双线自身不作为源分支出现。
    expect(plan.excluded.sort()).toEqual(['dev', 'master']);
    expect(plan.currentBranch).toBe('feature-a');
    expect(plan.sources.map((source) => source.name).sort()).toEqual(['feature-a', 'feature-b']);

    const featureA = plan.sources.find((source) => source.name === 'feature-a');
    expect(featureA?.blocker).toBeNull();
    // master 是 feature-a 的祖先 → 快进；dev 从同一个基点出发、没有新提交 → 也是快进。
    expect(featureA?.merges.map((merge) => `${merge.target}:${merge.kind}`).sort()).toEqual(['dev:fast-forward', 'master:fast-forward']);

    // 两条分支各合两条线，共 4 条。
    expect(plan.pendingMerges).toBe(4);
    expect(await git(worker, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature-a');
  });

  it('工作区不干净时整仓不参与，且不改动仓库', async () => {
    const { config, repository, worker } = await fixture();
    await writeFile(path.join(worker, 'feature-a.txt'), 'dirty\n');
    const plan = await mergeBranchesPlan(config, repository);
    expect(plan.blocker).toContain('工作区有未提交改动');
    expect(plan.sources).toHaveLength(0);
    // 预检是只读的：HEAD 没有被切走。
    await expect(mergeBranchesIntoLines(config, repository, worker, {
      sources: [{ name: 'feature-a', head: 'a'.repeat(40) }],
      targets: ['dev'],
    })).rejects.toThrow('工作区有未提交改动');
  });
});

describe('mergeBranchesIntoLines', () => {
  it('把每条源分支都合进 dev 与主分支，最后切回原分支', async () => {
    const { config, repository, worker } = await fixture();
    const plan = await mergeBranchesPlan(config, repository);
    const result = await mergeBranchesIntoLines(config, repository, worker, {
      sources: plan.sources.map((source) => ({ name: source.name, head: source.head })),
      targets: plan.targets,
    });

    expect(result.merges).toHaveLength(4);
    expect(result.merges.every((merge) => merge.state === 'merged' || merge.state === 'fast-forward')).toBe(true);
    expect(result.restoredBranch).toBe('feature-a');
    expect(await git(worker, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature-a');

    // 两条线都拿到了两条分支的内容。
    for (const line of ['dev', 'master']) {
      const tree = await git(worker, ['ls-tree', '--name-only', line]);
      expect(tree).toContain('feature-a.txt');
      // feature-b 改的是 shared.txt，合并后该行被改成 b。
      expect(await git(worker, ['show', `${line}:shared.txt`])).toBe('b');
    }
  });

  it('站在目标线上发起也能合并，结束后留在那条线', async () => {
    const { config, repository, worker } = await fixture();
    const plan = await mergeBranchesPlan(config, repository);
    const sources = plan.sources.map((source) => ({ name: source.name, head: source.head }));
    // 「活干完了，人已经在 dev 上」是最常见的姿势：源分支清单本来就排除了双线，
    // 不存在自我合并，没什么可挡的。
    await git(worker, ['checkout', 'dev']);

    const result = await mergeBranchesIntoLines(config, repository, worker, { sources, targets: ['dev'] });

    expect(result.merges.every((merge) => merge.state !== 'failed')).toBe(true);
    expect(result.restoredBranch).toBe('dev');
    expect(await git(worker, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dev');
    expect(await git(worker, ['show', 'dev:feature-a.txt'])).toBe('a');
  });

  it('冲突时停在目标线、不再继续，并且不谎报已切回', async () => {
    const { config, repository, worker } = await fixture({ conflicting: true });
    const plan = await mergeBranchesPlan(config, repository);
    const sources = plan.sources.map((source) => ({ name: source.name, head: source.head }));

    const result = await mergeBranchesIntoLines(config, repository, worker, { sources, targets: ['master'] });

    const conflict = result.merges.find((merge) => merge.state === 'conflict');
    expect(conflict?.source).toBe('feature-b');
    expect(result.restoredBranch).toBeNull();
    expect(result.summary).toContain('合并暂停在 master');
    // 仓库停在 master 且处于 merge 中途：这是冲突后的既定状态，不能偷偷切走。
    expect(await git(worker, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master');
    await expect(git(worker, ['rev-parse', '--verify', 'MERGE_HEAD'])).resolves.toMatch(/^[a-f0-9]{40}$/);
    // 冲突之前那一条已经合进去了：feature-a 的提交在 master 上。
    expect(await git(worker, ['merge-base', '--is-ancestor', 'feature-a', 'master'])).toBe('');
  });

  it('分支在预览后长出新提交时跳过那一条，不把没看过的内容合进去', async () => {
    const { config, repository, worker } = await fixture();
    const plan = await mergeBranchesPlan(config, repository);
    const sources = plan.sources.map((source) => ({ name: source.name, head: source.head }));
    // 模拟「窗口开着，用户在终端又提交了一笔」。
    const featureA = sources.find((source) => source.name === 'feature-a');
    if (!featureA) throw new Error('缺少 feature-a');
    await git(worker, ['checkout', 'feature-a']);
    await commitFile(worker, 'feature-a.txt', 'a2\n', 'feature a again');
    await git(worker, ['checkout', 'feature-a']);

    const result = await mergeBranchesIntoLines(config, repository, worker, { sources, targets: ['master'] });
    const skipped = result.merges.filter((merge) => merge.state === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.message).toContain('分支在预览后已变化');
    // 变更后的 feature-a 没有被合进 master。
    await expect(git(worker, ['show', 'master:feature-a.txt'])).rejects.toThrow();
  });

  it('可选清理：只删已完全合进每条目标线的分支，没合过去的保留', async () => {
    const { config, repository, worker } = await fixture();
    // 造一条不会合过去的孤立分支 stray：它的提交不在任何目标线上。
    await git(worker, ['checkout', 'master']);
    await git(worker, ['checkout', '-b', 'stray']);
    await commitFile(worker, 'stray.txt', 'stray\n', 'stray work');
    await git(worker, ['checkout', 'feature-a']);

    const plan = await mergeBranchesPlan(config, repository);
    // 只合 feature-a / feature-b，stray 故意不放进 sources。
    const sources = plan.sources
      .filter((source) => source.name !== 'stray')
      .map((source) => ({ name: source.name, head: source.head }));
    const result = await mergeBranchesIntoLines(config, repository, worker, {
      sources,
      targets: plan.targets,
      deleteMergedBranches: true,
    });

    expect(result.deletedBranches.sort()).toEqual(['feature-a', 'feature-b']);
    // stray 没合进目标线，绝不能被删；报告里说明原因。
    expect(result.deleteSkipped.map((item) => item.name)).toContain('stray');

    const left = (await git(worker, ['branch', '--format=%(refname:short)'])).split('\n');
    expect(left).not.toContain('feature-a');
    expect(left).not.toContain('feature-b');
    expect(left).toContain('stray');
    expect(left).toContain('dev');
    expect(left).toContain('master');
    // 原分支被删掉后，结束时会切到主分支（master），而不是一个不存在的分支。
    expect(result.restoredBranch).toBe('master');
    expect(await git(worker, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master');
    expect(result.summary).toContain('已删除 2 条已合并分支');
  });

  it('不勾清理时分支一律保留（默认安全）', async () => {
    const { config, repository, worker } = await fixture();
    const plan = await mergeBranchesPlan(config, repository);
    const result = await mergeBranchesIntoLines(config, repository, worker, {
      sources: plan.sources.map((source) => ({ name: source.name, head: source.head })),
      targets: plan.targets,
    });
    expect(result.deletedBranches).toEqual([]);
    expect(result.deleteSkipped).toEqual([]);
    const left = (await git(worker, ['branch', '--format=%(refname:short)'])).split('\n');
    expect(left).toContain('feature-a');
    expect(left).toContain('feature-b');
  });

  it('已同步、无可合并内容时也能只做清理：删已合并分支并切到主分支', async () => {
    const { config, repository, worker } = await fixture();
    const plan = await mergeBranchesPlan(config, repository);
    // 先正常合一次（不清理），让两条任务分支都进入双线。
    await mergeBranchesIntoLines(config, repository, worker, {
      sources: plan.sources.map((source) => ({ name: source.name, head: source.head })),
      targets: plan.targets,
    });
    // 再预检：已无源分支，但有可清理的已合并分支。
    const again = await mergeBranchesPlan(config, repository);
    expect(again.sources).toHaveLength(0);
    expect(again.mergedBranches.sort()).toEqual(['feature-a', 'feature-b']);

    // 只做清理：sources 传空，勾选删除。
    const result = await mergeBranchesIntoLines(config, repository, worker, {
      sources: [],
      targets: again.targets,
      deleteMergedBranches: true,
    });
    expect(result.deletedBranches.sort()).toEqual(['feature-a', 'feature-b']);
    const left = (await git(worker, ['branch', '--format=%(refname:short)'])).split('\n');
    expect(left).not.toContain('feature-a');
    expect(left).not.toContain('feature-b');
    // 没有可合并内容时，清理后应切到主分支（master），而不是留在某条任务分支上。
    expect(result.restoredBranch).toBe('master');
    expect(await git(worker, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master');
  });
});
