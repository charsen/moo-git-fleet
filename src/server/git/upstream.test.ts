import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import {
  parseRemoteRefs,
  publishCurrentBranch,
  trackExistingUpstream,
  upstreamRepairPlan,
} from './upstream.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

function config(root: string, repository: RepositoryConfig): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { test: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 2,
    },
    repositories: [repository],
  };
}

function repository(pathName: string): RepositoryConfig {
  return {
    id: 'upstream-test',
    name: 'Upstream Test',
    root: 'test',
    path: pathName,
    group: 'Tests',
    enabled: true,
    pinned: false,
    order: 0,
    tags: [],
    aiCommitPolicy: 'disabled',
    capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
  };
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), content);
  await git(cwd, ['add', '--', file]);
  await git(cwd, ['-c', 'commit.gpgSign=false', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function trackingFixture(): Promise<{
  root: string;
  worker: string;
  remote: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
  localHead: string;
  remoteHead: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-upstream-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const worker = path.join(root, 'worker');
  await git(root, ['init', '--bare', remote]);
  await git(root, ['init', '--initial-branch=master', seed]);
  await git(seed, ['config', 'user.name', 'Upstream Test']);
  await git(seed, ['config', 'user.email', 'upstream@example.test']);
  await commitFile(seed, 'README.md', 'initial\n', 'initial');
  await git(seed, ['remote', 'add', 'origin', remote]);
  await git(seed, ['push', 'origin', 'master:master']);
  await git(root, ['clone', '--branch', 'master', remote, worker]);
  await git(worker, ['config', 'user.name', 'Upstream Test']);
  await git(worker, ['config', 'user.email', 'upstream@example.test']);
  await git(worker, ['branch', '--unset-upstream']);
  const localHead = await git(worker, ['rev-parse', 'HEAD']);
  const remoteHead = await commitFile(seed, 'remote.txt', 'remote\n', 'remote update');
  await git(seed, ['push', 'origin', 'master:master']);
  await git(worker, ['fetch', '--prune', 'origin']);
  const repositoryConfig = repository('worker');
  return {
    root,
    worker,
    remote,
    repository: repositoryConfig,
    config: config(root, repositoryConfig),
    localHead,
    remoteHead,
  };
}

async function publishFixture(): Promise<{
  root: string;
  worker: string;
  remote: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
  head: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-upstream-publish-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const worker = path.join(root, 'worker');
  await git(root, ['init', '--bare', remote]);
  await git(root, ['init', '--initial-branch=master', worker]);
  await git(worker, ['config', 'user.name', 'Upstream Test']);
  await git(worker, ['config', 'user.email', 'upstream@example.test']);
  const head = await commitFile(worker, 'README.md', 'initial\n', 'initial');
  await git(worker, ['remote', 'add', 'origin', remote]);
  const repositoryConfig = repository('worker');
  return { root, worker, remote, repository: repositoryConfig, config: config(root, repositoryConfig), head };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('upstream repair planning', () => {
  it('parses remote refs without treating symbolic remote HEAD entries as candidates', () => {
    const output = Buffer.from(
      'refs/remotes/origin/HEAD\0aaa\n' +
        'refs/remotes/origin/master\0bbb\n' +
        'refs/remotes/backup/feature/test\0ccc\n',
    );
    expect(parseRemoteRefs(output, ['origin', 'backup'])).toEqual([
      { upstream: 'origin/master', remote: 'origin', branch: 'master', head: 'bbb' },
      { upstream: 'backup/feature/test', remote: 'backup', branch: 'feature/test', head: 'ccc' },
    ]);
  });

  it('recommends one same-name tracking ref and exposes the real divergence', async () => {
    const fixture = await trackingFixture();
    const plan = await upstreamRepairPlan(fixture.config, fixture.repository, fixture.worker);

    expect(plan).toMatchObject({
      branch: 'master',
      head: fixture.localHead,
      upstream: null,
      recommendedUpstream: 'origin/master',
      canPublish: true,
      candidates: [
        {
          upstream: 'origin/master',
          remote: 'origin',
          branch: 'master',
          head: fixture.remoteHead,
          reason: 'same-name',
          ahead: 0,
          behind: 1,
        },
      ],
    });
  });

  it('requires a choice when more than one safe candidate exists', async () => {
    const fixture = await trackingFixture();
    await git(fixture.worker, ['remote', 'add', 'backup', fixture.remote]);
    await git(fixture.worker, ['fetch', '--prune', 'backup']);

    const plan = await upstreamRepairPlan(fixture.config, fixture.repository, fixture.worker);
    expect(plan.recommendedUpstream).toBeNull();
    expect(plan.candidates.map((candidate) => candidate.upstream)).toEqual(['origin/master', 'backup/master']);
  });

  it('rejects detached HEAD before offering a repair', async () => {
    const fixture = await trackingFixture();
    await git(fixture.worker, ['checkout', '--detach']);
    await expect(upstreamRepairPlan(fixture.config, fixture.repository, fixture.worker)).rejects.toThrow(
      'Detached HEAD 不能设置 upstream',
    );
  });
});

describe('upstream repair execution', () => {
  it('tracks an existing candidate after stale-state checks and rescans divergence', async () => {
    const fixture = await trackingFixture();
    await expect(
      trackExistingUpstream(fixture.config, fixture.repository, fixture.worker, {
        upstream: 'origin/master',
        expectedBranch: 'master',
        expectedHead: '0'.repeat(40),
      }),
    ).rejects.toThrow('分支或 HEAD 已变化');

    const result = await trackExistingUpstream(fixture.config, fixture.repository, fixture.worker, {
      upstream: 'origin/master',
      expectedBranch: 'master',
      expectedHead: fixture.localHead,
    });
    expect(result.status).toMatchObject({ upstream: 'origin/master', ahead: 0, behind: 1, state: 'behind' });
    expect(result.branches.branches).toContainEqual(
      expect.objectContaining({ name: 'master', current: true, upstream: 'origin/master', behind: 1 }),
    );
    expect(await git(fixture.worker, ['config', '--get', 'branch.master.remote'])).toBe('origin');
    expect(await git(fixture.worker, ['config', '--get', 'branch.master.merge'])).toBe('refs/heads/master');
    await expect(
      trackExistingUpstream(fixture.config, fixture.repository, fixture.worker, {
        upstream: 'origin/master',
        expectedBranch: 'master',
        expectedHead: fixture.localHead,
      }),
    ).rejects.toThrow('已有 upstream');
  });

  it('publishes an absent same-name branch with an explicit non-force refspec and then tracks it', async () => {
    const fixture = await publishFixture();
    const plan = await upstreamRepairPlan(fixture.config, fixture.repository, fixture.worker);
    expect(plan).toMatchObject({ candidates: [], recommendedUpstream: null, canPublish: true });

    const output = await publishCurrentBranch(fixture.config, fixture.repository, fixture.worker, {
      remote: 'origin',
      expectedBranch: 'master',
      expectedHead: fixture.head,
    });
    expect(output.changedDuringPush).toBe(false);
    expect(output.result.status).toMatchObject({ upstream: 'origin/master', ahead: 0, behind: 0, state: 'clean' });
    expect(await git(fixture.remote, ['rev-parse', 'refs/heads/master'])).toBe(fixture.head);
  });

  it('refuses first publish when Fetch discovers that the target branch already exists', async () => {
    const fixture = await publishFixture();
    await git(fixture.worker, ['push', 'origin', `${fixture.head}:refs/heads/master`]);

    await expect(
      publishCurrentBranch(fixture.config, fixture.repository, fixture.worker, {
        remote: 'origin',
        expectedBranch: 'master',
        expectedHead: fixture.head,
      }),
    ).rejects.toThrow('远端分支 origin/master 已出现');
    await expect(git(fixture.worker, ['config', '--get', 'branch.master.remote'])).rejects.toThrow();
  });
});
