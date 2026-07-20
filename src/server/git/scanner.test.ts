import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { parsePorcelainV2, repositoryId, sanitizeRemote, scanRepositories, scanRepository } from './scanner.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('parsePorcelainV2', () => {
  it('parses branch divergence and worktree counts', () => {
    const output = Buffer.from(
      '# branch.head master\0# branch.upstream origin/master\0# branch.ab +2 -1\0' +
        '1 M. N... 100644 100644 100644 abc abc src/a.ts\0' +
        '1 .D N... 100644 100644 000000 abc abc src/b.ts\0' +
        '? notes.txt\0' +
        'u UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts\0',
    );
    expect(parsePorcelainV2(output)).toMatchObject({
      branch: 'master',
      upstream: 'origin/master',
      ahead: 2,
      behind: 1,
      staged: 1,
      modified: 1,
      deleted: 1,
      untracked: 1,
      conflicted: 1,
    });
  });
});

describe('repositoryId', () => {
  it('is stable for a canonical path', () => {
    expect(repositoryId('Wisdom City', '/Volumes/dev/wwwroot/wisdomcity')).toBe(
      repositoryId('Wisdom City', '/Volumes/dev/wwwroot/wisdomcity'),
    );
  });
});

describe('sanitizeRemote', () => {
  it('removes credentials from HTTP remotes and preserves common SSH remotes', () => {
    expect(sanitizeRemote('https://oauth-user:secret-token@gitee.com/charsen/repository.git')).toBe(
      'https://gitee.com/charsen/repository.git',
    );
    expect(sanitizeRemote('git@gitee.com:charsen/repository.git')).toBe('git@gitee.com:charsen/repository.git');
  });
});

describe('scanRepository Git identity', () => {
  it('reports the effective repository identity and warns when it is incomplete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-identity-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    const homePath = path.join(root, 'home');
    await mkdir(homePath);
    await execFileAsync('git', ['init', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    vi.stubEnv('HOME', homePath);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

    const repository: RepositoryConfig = {
      id: 'identity-repository',
      name: 'Identity Repository',
      root: 'test',
      path: 'repository',
      group: 'Tests',
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
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [repository],
    };

    const partial = await scanRepository(config, repository);
    expect(partial.gitIdentity).toEqual({ name: 'Fleet Developer', email: null, complete: false });

    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Identity Repository\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial']);
    await execFileAsync('git', ['-C', repositoryPath, 'tag', 'v1.2.3']);
    const complete = await scanRepository(config, repository);
    expect(complete.gitIdentity).toEqual({
      name: 'Fleet Developer',
      email: 'fleet@example.test',
      complete: true,
    });
    expect(complete.latestTag).toMatchObject({ name: 'v1.2.3' });
  });
});

describe('repository scan coordination', () => {
  it('reads Fetch and operation markers while preserving configured repository order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-coordination-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'available');
    await execFileAsync('git', ['init', '--initial-branch=master', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Coordination Repository\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    const { stdout: head } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD']);
    await writeFile(path.join(repositoryPath, '.git', 'FETCH_HEAD'), `${head.trim()}\n`);
    await writeFile(path.join(repositoryPath, '.git', 'MERGE_HEAD'), `${head.trim()}\n`);

    const configured = (id: string, repositoryPathName: string, order: number): RepositoryConfig => ({
      id,
      name: id,
      root: 'test',
      path: repositoryPathName,
      group: 'Tests',
      enabled: true,
      pinned: false,
      order,
      tags: [],
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    });
    const repositories = [configured('available', 'available', 10), configured('missing', 'missing', 20)];
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 2,
        networkConcurrency: 1,
      },
      repositories,
    };

    const statuses = await scanRepositories(config);
    expect(statuses.map((status) => status.config.id)).toEqual(['available', 'missing']);
    expect(statuses[0]).toMatchObject({
      available: true,
      inProgressOperation: 'merge',
      state: 'operation-in-progress',
    });
    expect(statuses[0]?.lastFetchedAt).not.toBeNull();
    expect(statuses[1]).toMatchObject({ available: false, state: 'missing' });
  });
});
