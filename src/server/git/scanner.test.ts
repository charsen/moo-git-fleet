import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { listRepositoryFiles } from './files.js';
import {
  parsePorcelainV2,
  repositoryId,
  repositoryInternalState,
  sanitizeRemote,
  scanRoot,
  scanRepositories,
  scanRepository,
} from './scanner.js';

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
        '1 MM N... 100644 100644 100644 abc abc src/both.ts\0' +
        '2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\0src/old.ts\0' +
        '? notes.txt\0' +
        'u UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts\0',
    );
    expect(parsePorcelainV2(output)).toMatchObject({
      branch: 'master',
      upstream: 'origin/master',
      ahead: 2,
      behind: 1,
      changedFiles: 6,
      staged: 3,
      modified: 2,
      deleted: 1,
      renamed: 1,
      untracked: 1,
      conflicted: 1,
    });
  });

  it('keeps newlines inside a NUL-delimited filename', () => {
    const output = Buffer.from(
      '# branch.head master\0' +
        '? notes\n? fake-status.ts\0' +
        '1 M. N... 100644 100644 100644 abc abc src/real.ts\0',
    );

    expect(parsePorcelainV2(output)).toMatchObject({
      branch: 'master',
      changedFiles: 2,
      staged: 1,
      modified: 0,
      untracked: 1,
      conflicted: 0,
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

describe('scanRepository filename boundaries', () => {
  it('matches the file list for a real repository containing newlines and status-like filename text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-filename-boundary-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Filename Boundary\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repositoryPath, 'README.md'), '# Filename Boundary\n\nStaged change.\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    const unusualPath = 'notes\n? fake-status.ts';
    await writeFile(path.join(repositoryPath, unusualPath), 'untracked\n');

    const repository: RepositoryConfig = {
      id: 'filename-boundary',
      name: 'Filename Boundary',
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

    const [status, files] = await Promise.all([
      scanRepository(config, repository),
      listRepositoryFiles(repository.id, repositoryPath),
    ]);

    expect(status).toMatchObject({
      available: true,
      changedFiles: 2,
      staged: 1,
      modified: 0,
      untracked: 1,
      state: 'dirty',
    });
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.path)).toContain(unusualPath);
  });
});

describe('repository internal state path boundaries', () => {
  it('reads Worktree markers when the common repository path contains a newline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-internal-state-'));
    temporaryDirectories.push(root);
    const mainRepository = path.join(root, 'main\nrepository');
    const linkedWorktree = path.join(root, 'linked');
    await execFileAsync('git', ['init', '--initial-branch=main', mainRepository]);
    await execFileAsync('git', ['-C', mainRepository, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', mainRepository, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(mainRepository, 'README.md'), '# Internal State\n');
    await execFileAsync('git', ['-C', mainRepository, 'add', 'README.md']);
    await execFileAsync('git', ['-C', mainRepository, '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await execFileAsync('git', ['-C', mainRepository, 'branch', 'feature']);
    await execFileAsync('git', ['-C', mainRepository, 'worktree', 'add', linkedWorktree, 'feature']);

    const { stdout: headOutput } = await execFileAsync('git', ['-C', linkedWorktree, 'rev-parse', 'HEAD']);
    const { stdout: fetchPathOutput } = await execFileAsync('git', [
      '-C',
      linkedWorktree,
      'rev-parse',
      '--git-path',
      'FETCH_HEAD',
    ]);
    const { stdout: mergePathOutput } = await execFileAsync('git', [
      '-C',
      linkedWorktree,
      'rev-parse',
      '--git-path',
      'MERGE_HEAD',
    ]);
    await writeFile(fetchPathOutput.trim(), `${headOutput.trim()}\n`);
    await writeFile(mergePathOutput.trim(), `${headOutput.trim()}\n`);

    const state = await repositoryInternalState(linkedWorktree);
    expect(state.operation).toBe('merge');
    expect(state.lastFetchedAt).not.toBeNull();
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

  it('enforces the 500 repository discovery cap under concurrent traversal', { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-scan-cap-'));
    temporaryDirectories.push(root);
    const wrapperRoot = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-scan-cap-wrapper-'));
    temporaryDirectories.push(wrapperRoot);
    const bin = path.join(wrapperRoot, 'bin');
    await mkdir(bin);
    const wrapper = path.join(bin, 'git');
    await writeFile(
      wrapper,
      '#!/bin/sh\ncase " $* " in\n  *" rev-parse --is-inside-work-tree "*) printf true ;;\n  *" branch --show-current "*) printf main ;;\n  *" remote get-url origin "*) printf https://example.test/repository.git ;;\n  *) exec /usr/bin/git "$@" ;;\nesac\n',
    );
    await chmod(wrapper, 0o755);
    await Promise.all(
      Array.from({ length: 501 }, async (_, index) => {
        await mkdir(path.join(root, `repository-${String(index).padStart(3, '0')}`, '.git'), { recursive: true });
      }),
    );

    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 1,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [],
    };
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const candidates = await scanRoot(config, 'test');
      expect(candidates).toHaveLength(500);
      expect(candidates[0]?.name).toBe('repository-000');
      expect(new Set(candidates.map((candidate) => candidate.absolutePath)).size).toBe(500);
      expect(candidates.every((candidate) => /^repository-(?:[0-4]\d\d|500)$/.test(candidate.name))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
