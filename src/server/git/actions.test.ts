import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { pullRepository, pushRepository } from './actions.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('safe Git actions', () => {
  it('pulls by fast-forward and pushes with an explicit upstream ref', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-actions-'));
    temporaryDirectories.push(root);
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
      id: 'worker-test',
      name: 'worker',
      root: 'test',
      path: 'worker',
      group: 'tests',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      capabilities: { fetch: true, pull: true, stage: true, commit: true, push: true },
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

    await writeFile(path.join(seed, 'README.md'), 'remote update\n');
    await git(seed, ['add', 'README.md']);
    await git(seed, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'remote update']);
    await git(seed, ['push']);

    const pull = await pullRepository(config, repository, worker);
    expect(pull.skipped).toBe(false);
    expect(pull.status.behind).toBe(0);

    await writeFile(path.join(worker, 'local.txt'), 'local commit\n');
    await git(worker, ['add', 'local.txt']);
    await git(worker, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'local update']);
    const push = await pushRepository(config, repository, worker);
    expect(push.skipped).toBe(false);
    expect(push.status.ahead).toBe(0);
    expect(await git(remote, ['rev-parse', 'refs/heads/master'])).toBe(await git(worker, ['rev-parse', 'HEAD']));
  });
});
