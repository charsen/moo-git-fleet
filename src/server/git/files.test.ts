import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryConfig } from '../../shared/contracts.js';
import { suggestCommit } from '../ai/provider.js';
import {
  commitPreview,
  commitStaged,
  listRepositoryFiles,
  resolveFileIds,
  stageFiles,
} from './files.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('file staging and commit flow', () => {
  it('commits exactly the staged fingerprint with a generated message', async () => {
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-commit-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repositoryPath, 'README.md'), 'updated\n');
    await writeFile(path.join(repositoryPath, 'notes.md'), 'new notes\n');
    const files = await listRepositoryFiles('test-repository', repositoryPath);
    const paths = resolveFileIds(
      'test-repository',
      files.map((file) => file.id),
    );
    await stageFiles(repositoryPath, paths);
    const preview = await commitPreview(repositoryPath);
    expect(preview.files).toEqual(['README.md', 'notes.md']);

    const repository: RepositoryConfig = {
      id: 'test-repository',
      name: 'test-repository',
      root: 'test',
      path: '.',
      group: 'tests',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      capabilities: { fetch: true, pull: true, stage: true, commit: true, push: true },
    };
    const suggestion = await suggestCommit(repositoryPath, repository, preview, 'zh-CN');
    expect(suggestion.source).toBe('local');
    const hash = await commitStaged(repositoryPath, suggestion.message, preview.fingerprint);
    expect(hash).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(repositoryPath, ['status', '--porcelain'])).toBe('');
  });
});
