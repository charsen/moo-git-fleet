import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryConfig } from '../../shared/contracts.js';
import { suggestCommit } from '../ai/provider.js';
import {
  commitPreview,
  commitStaged,
  discardFileChange,
  fileDiff,
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
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    const suggestion = await suggestCommit(repositoryPath, repository, preview, 'zh-CN');
    expect(suggestion.source).toBe('local');
    const execution = await commitStaged(repositoryPath, suggestion.message, preview.fingerprint);
    expect(execution.hash).toMatch(/^[a-f0-9]{40}$/);
    expect(execution.treeMatches).toBe(true);
    expect(await git(repositoryPath, ['status', '--porcelain'])).toBe('');
  });

  it('detects when a pre-commit hook changes the committed tree', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-hook-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repositoryPath, 'notes.md'), 'previewed\n');
    await git(repositoryPath, ['add', 'notes.md']);
    const preview = await commitPreview(repositoryPath);
    const hookPath = path.join(repositoryPath, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\nprintf "hooked\\n" >> README.md\ngit add README.md\n');
    await chmod(hookPath, 0o755);

    const execution = await commitStaged(repositoryPath, 'test: hook mutation', preview.fingerprint);

    expect(execution.treeMatches).toBe(false);
    expect(await git(repositoryPath, ['show', '--format=', '--name-only', 'HEAD'])).toContain('README.md');
  });

  it('bounds large diff previews while fingerprinting the complete staged tree', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-large-diff-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'large.txt'), 'initial\n');
    await git(repositoryPath, ['add', 'large.txt']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repositoryPath, 'large.txt'), `${'large diff line\n'.repeat(20_000)}`);
    await git(repositoryPath, ['add', 'large.txt']);

    const preview = await commitPreview(repositoryPath);
    const diff = await fileDiff(repositoryPath, 'large.txt', 'staged');

    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.patch)).toBeLessThanOrEqual(120_000);
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(diff).toContain('… diff 已截断 …');
    expect(Buffer.byteLength(diff)).toBeLessThan(121_000);
  });

  it('restores a tracked worktree change without touching the Trash', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-discard-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'changed\n');

    const file = (await listRepositoryFiles('discard-repository', repositoryPath)).find((item) => item.path === 'README.md');
    expect(file).toBeDefined();
    const moveToTrash = vi.fn(async () => undefined);
    const result = await discardFileChange(repositoryPath, file!, moveToTrash);

    expect(result).toEqual({ action: 'restore', path: 'README.md' });
    expect(moveToTrash).not.toHaveBeenCalled();
    expect(await readFile(path.join(repositoryPath, 'README.md'), 'utf8')).toBe('initial\n');
  });

  it('moves an untracked file through the injected Trash handler and blocks staged files', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-trash-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await writeFile(path.join(repositoryPath, 'scratch.txt'), 'temporary\n');

    const untracked = (await listRepositoryFiles('trash-repository', repositoryPath)).find((item) => item.path === 'scratch.txt');
    expect(untracked).toBeDefined();
    const moveToTrash = vi.fn(async (absolutePath: string) => rm(absolutePath));
    await expect(discardFileChange(repositoryPath, untracked!, moveToTrash)).resolves.toEqual({
      action: 'trash',
      path: 'scratch.txt',
    });
    expect(moveToTrash).toHaveBeenCalledWith(path.join(repositoryPath, 'scratch.txt'));
    await expect(readFile(path.join(repositoryPath, 'scratch.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(path.join(repositoryPath, 'staged.txt'), 'staged\n');
    await git(repositoryPath, ['add', 'staged.txt']);
    const staged = (await listRepositoryFiles('trash-repository', repositoryPath)).find((item) => item.path === 'staged.txt');
    await expect(discardFileChange(repositoryPath, staged!, moveToTrash)).rejects.toThrow('请先取消暂存');
  });
});
