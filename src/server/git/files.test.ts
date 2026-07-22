import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  resolveCurrentFileAction,
  resolveFileIds,
  stageFiles,
} from './files.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

async function waitForFileValue(file: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readFile(file, 'utf8').catch(() => '')) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file} to contain ${expected}`);
}

function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
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

  it('rejects an index change between fingerprint validation and the expected tree snapshot', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-commit-index-race-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repositoryPath, 'previewed.txt'), 'previewed\n');
    await git(repositoryPath, ['add', 'previewed.txt']);
    const preview = await commitPreview(repositoryPath);
    await writeFile(path.join(repositoryPath, 'unexpected.txt'), 'staged during validation\n');

    const fakeBin = path.join(repositoryPath, '.git-fleet-test-bin');
    const counterPath = path.join(repositoryPath, '.git', 'write-tree-count');
    await mkdir(fakeBin);
    const gitWrapper = path.join(fakeBin, 'git');
    await writeFile(
      gitWrapper,
      `#!/bin/sh\ncase " $* " in\n  *" write-tree "*)\n    count=0\n    if [ -f "${counterPath}" ]; then count=$(cat "${counterPath}"); fi\n    count=$((count + 1))\n    printf '%s' "$count" > "${counterPath}"\n    if [ "$count" -eq 2 ]; then sleep 0.25; fi\n    ;;\nesac\nexec /usr/bin/git "$@"\n`,
    );
    await chmod(gitWrapper, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
      const committing = commitStaged(repositoryPath, 'test: guarded commit', preview.fingerprint);
      const committingError = rejectionOf(committing);
      await waitForFileValue(counterPath, '2');
      await execFileAsync('/usr/bin/git', ['-C', repositoryPath, 'add', 'unexpected.txt']);

      expect((await committingError).message).toContain('暂存区已变化');
      expect(await git(repositoryPath, ['show', '-1', '--no-patch', '--format=%s'])).toBe('initial');
      expect(await git(repositoryPath, ['diff', '--cached', '--name-only'])).toContain('unexpected.txt');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects an index change while assembling the commit preview', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-preview-index-race-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repositoryPath, 'previewed.txt'), 'previewed\n');
    await git(repositoryPath, ['add', 'previewed.txt']);
    await writeFile(path.join(repositoryPath, 'unexpected.txt'), 'staged during preview\n');

    const fakeBin = path.join(repositoryPath, '.git-fleet-preview-bin');
    const fingerprintReady = path.join(repositoryPath, '.git', 'preview-fingerprint-ready');
    const diffDelayed = path.join(repositoryPath, '.git', 'preview-diff-delayed');
    await mkdir(fakeBin);
    const gitWrapper = path.join(fakeBin, 'git');
    await writeFile(
      gitWrapper,
      `#!/bin/sh\ncase " $* " in\n  *" write-tree "*)\n    output=$(/usr/bin/git "$@") || exit $?\n    printf '1' > "${fingerprintReady}"\n    printf '%s\\n' "$output"\n    exit 0\n    ;;\n  *" diff --cached --stat "*)\n    while [ ! -f "${fingerprintReady}" ]; do sleep 0.01; done\n    printf '1' > "${diffDelayed}"\n    sleep 0.25\n    ;;\nesac\nexec /usr/bin/git "$@"\n`,
    );
    await chmod(gitWrapper, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
      const previewing = commitPreview(repositoryPath);
      const previewingError = rejectionOf(previewing);
      await waitForFileValue(diffDelayed, '1');
      await execFileAsync('/usr/bin/git', ['-C', repositoryPath, 'add', 'unexpected.txt']);

      expect((await previewingError).message).toContain('暂存区已变化');
      expect(await git(repositoryPath, ['diff', '--cached', '--name-only'])).toContain('unexpected.txt');
    } finally {
      process.env.PATH = originalPath;
    }
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

  it('preserves trailing whitespace on the final changed line of a diff', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-diff-whitespace-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'space.txt'), 'before\n');
    await git(repositoryPath, ['add', 'space.txt']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repositoryPath, 'space.txt'), 'after  \n');

    const diff = await fileDiff(repositoryPath, 'space.txt', 'unstaged');

    expect(diff.endsWith('+after  ')).toBe(true);
    expect(diff.endsWith('\n')).toBe(false);
  });

  it('keeps staged and unstaged diff layers independently readable', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-layered-diff-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'layered.txt'), 'base\n');
    await git(repositoryPath, ['add', 'layered.txt']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repositoryPath, 'layered.txt'), 'staged change\n');
    await git(repositoryPath, ['add', 'layered.txt']);
    await writeFile(path.join(repositoryPath, 'layered.txt'), 'worktree change\n');

    const staged = await fileDiff(repositoryPath, 'layered.txt', 'staged');
    const unstaged = await fileDiff(repositoryPath, 'layered.txt', 'unstaged');

    expect(staged).toContain('-base');
    expect(staged).toContain('+staged change');
    expect(staged).not.toContain('worktree change');
    expect(unstaged).toContain('-staged change');
    expect(unstaged).toContain('+worktree change');
    expect(unstaged).not.toContain('+staged change');
  });

  it('shows an untracked file with a special path as an all-additions diff', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-untracked-diff-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    const relativePath = 'draft notes\nv2.ts';
    await writeFile(path.join(repositoryPath, relativePath), 'const draft = true;\nexport { draft };\n');

    const diff = await fileDiff(repositoryPath, relativePath, 'unstaged');

    expect(diff).toContain('new file mode');
    expect(diff).toContain('+const draft = true;');
    expect(diff).toContain('+export { draft };');
  });

  it('keeps Git binary detection for an untracked file', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-untracked-binary-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await writeFile(path.join(repositoryPath, 'preview.bin'), Buffer.from([0, 1, 2, 3, 255]));

    const diff = await fileDiff(repositoryPath, 'preview.bin', 'unstaged');

    expect(diff).toContain('Binary files');
    expect(diff).toContain('differ');
    expect(diff).not.toContain('\u0000');
  });

  it('backs up a tracked worktree change through Trash before restoring it', async () => {
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
    const moveToTrash = vi.fn(async (absolutePath: string) => rm(absolutePath));
    const result = await discardFileChange(repositoryPath, file!, moveToTrash);

    expect(result).toEqual({ action: 'restore', path: 'README.md' });
    expect(moveToTrash).toHaveBeenCalledWith(path.join(repositoryPath, 'README.md'));
    expect(await readFile(path.join(repositoryPath, 'README.md'), 'utf8')).toBe('initial\n');
  });

  it('rejects a stale discard token when external editing changes the file without changing its Git status', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-stale-discard-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=master']);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet Test']);
    await git(repositoryPath, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'first edit\n');
    const listed = (await listRepositoryFiles('stale-discard-repository', repositoryPath)).find((item) => item.path === 'README.md');
    expect(listed).toBeDefined();

    await writeFile(path.join(repositoryPath, 'README.md'), 'second external edit with a different size\n');
    const currentFiles = await listRepositoryFiles('stale-discard-repository', repositoryPath);

    expect(() => resolveCurrentFileAction('stale-discard-repository', listed!.id, currentFiles)).toThrow(
      '文件内容或状态已变化',
    );
    expect(await readFile(path.join(repositoryPath, 'README.md'), 'utf8')).toBe('second external edit with a different size\n');
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
