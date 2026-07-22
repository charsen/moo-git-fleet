import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { appendRepositoryConfig } from './service.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('repository configuration service', () => {
  it('adds a validated worktree once and rejects duplicate paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-repository-service-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'demo-repository');
    await mkdir(repositoryPath);
    await execFileAsync('git', ['init', repositoryPath]);
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 2,
        networkConcurrency: 1,
      },
      repositories: [],
    };

    const repository = await appendRepositoryConfig(config, {
      rootId: 'test',
      relativePath: 'demo-repository',
      name: 'Demo Repository',
      group: 'Tests',
    });

    expect(repository).toMatchObject({ name: 'Demo Repository', path: 'demo-repository', group: 'Tests', order: 10 });
    expect(config.repositories).toHaveLength(1);
    await expect(
      appendRepositoryConfig(config, {
        rootId: 'test',
        relativePath: 'demo-repository',
        name: 'Duplicate',
        group: 'Tests',
      }),
    ).rejects.toThrow('已经在列表中');
  });

  it('preserves a valid repository path that ends with a space', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-repository-space-'));
    temporaryDirectories.push(root);
    const relativePath = 'repository-with-space ';
    const repositoryPath = path.join(root, relativePath);
    await mkdir(repositoryPath);
    await execFileAsync('git', ['init', repositoryPath]);
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 2,
        networkConcurrency: 1,
      },
      repositories: [],
    };

    const repository = await appendRepositoryConfig(config, {
      rootId: 'test',
      relativePath,
      name: 'Trailing Space Repository',
      group: 'Tests',
    });

    expect(repository.path).toBe(relativePath);
    expect(config.repositories).toHaveLength(1);
  });
});
