import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { fetchRepository, pullRepository, pushRepository } from './actions.js';
import { listBranches, switchBranch } from './branches.js';
import { commitPreview, commitStaged, stageFiles } from './files.js';
import { applyStash, createStash } from './stash.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('branch switch compatibility workflow', () => {
  // This is an intentionally broad real-Git workflow. Keep the assertion
  // timeout above the default so a busy runner does not turn subprocess load
  // into a false regression.
  it('preserves Fetch, Stage, Commit, Push, fast-forward Pull and Stash behavior after switching', { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-branch-workflow-'));
    temporaryDirectories.push(root);
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const worker = path.join(root, 'worker');
    await execFileAsync('git', ['init', '--bare', '--initial-branch=master', remote]);
    await execFileAsync('git', ['clone', remote, seed]);
    await configureIdentity(seed);
    await writeFile(path.join(seed, 'README.md'), 'initial\n');
    await git(seed, ['add', 'README.md']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(seed, ['push', '-u', 'origin', 'master']);
    await git(seed, ['switch', '-c', 'feature/workflow']);
    await writeFile(path.join(seed, 'feature.txt'), 'feature\n');
    await git(seed, ['add', 'feature.txt']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'feature']);
    await git(seed, ['push', '-u', 'origin', 'feature/workflow']);

    await execFileAsync('git', ['clone', remote, worker]);
    await configureIdentity(worker);
    await git(worker, ['branch', '--track', 'feature/workflow', 'origin/feature/workflow']);

    const repository: RepositoryConfig = {
      id: 'branch-workflow',
      name: 'Branch Workflow',
      root: 'test',
      path: 'worker',
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 1,
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
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [repository],
    };

    const before = await listBranches(worker);
    await switchBranch(worker, {
      branch: 'feature/workflow',
      expectedBranch: 'master',
      expectedHead: before.head,
    });
    await fetchRepository(config, repository, worker);

    await writeFile(path.join(worker, 'local.txt'), 'local\n');
    await stageFiles(worker, ['local.txt']);
    const preview = await commitPreview(worker);
    const commit = await commitStaged(worker, 'test: switched branch commit', preview.fingerprint);
    expect(commit.treeMatches).toBe(true);
    await expect(pushRepository(config, repository, worker)).resolves.toMatchObject({ skipped: false });

    await git(seed, ['pull', '--ff-only']);
    await writeFile(path.join(seed, 'remote.txt'), 'remote\n');
    await git(seed, ['add', 'remote.txt']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'remote update']);
    await git(seed, ['push']);
    await expect(pullRepository(config, repository, worker)).resolves.toMatchObject({ skipped: false });
    expect(await git(worker, ['show', '-1', '--no-patch', '--format=%s'])).toBe('remote update');

    await writeFile(path.join(worker, 'notes.txt'), 'stash me\n');
    const stash = await createStash(worker, 'after switch', true);
    expect(await git(worker, ['status', '--porcelain'])).toBe('');
    await applyStash(worker, stash.ref, stash.hash);
    expect(await git(worker, ['status', '--porcelain'])).toContain('notes.txt');
  });
});
