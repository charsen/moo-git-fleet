import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureWorkspaceSnapshot } from './checkpoint.js';
import { executeSourceSync, inspectSourceSyncGate, SourceSyncError } from './source-sync.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

async function readOnlyStatus(cwd: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v2', '-z'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}

async function repositoryState(repositoryPath: string): Promise<{
  branch: string;
  head: string | null;
  status: string;
  indexPath: string;
  indexBytes: Buffer | null;
  indexMtimeNs: bigint | null;
  readme: string;
  untracked: string | null;
}> {
  const indexOutput = await git(repositoryPath, ['rev-parse', '--git-path', 'index']);
  const indexPath = path.isAbsolute(indexOutput) ? indexOutput : path.resolve(repositoryPath, indexOutput);
  const status = await readOnlyStatus(repositoryPath);
  const [indexBytes, indexStat, readme, untracked] = await Promise.all([
    readFile(indexPath).catch(() => null),
    stat(indexPath, { bigint: true }).catch(() => null),
    readFile(path.join(repositoryPath, 'README.md'), 'utf8'),
    readFile(path.join(repositoryPath, 'untracked.txt'), 'utf8').catch(() => null),
  ]);
  return {
    branch: await git(repositoryPath, ['branch', '--show-current']),
    head: await git(repositoryPath, ['rev-parse', 'HEAD']).catch(() => null),
    status,
    indexPath,
    indexBytes,
    indexMtimeNs: indexStat?.mtimeNs ?? null,
    readme,
    untracked,
  };
}

async function fixture(options: { pushInitial?: boolean; initialCommit?: boolean } = {}): Promise<{
  root: string;
  remotePath: string;
  projectPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-source-sync-'));
  temporaryDirectories.push(root);
  const remotePath = path.join(root, 'remote.git');
  const projectPath = path.join(root, 'synthetic-project');
  await git(root, ['init', '--bare', remotePath]);
  await git(root, ['init', '--initial-branch=main', projectPath]);
  await git(projectPath, ['config', 'user.name', 'Synthetic Developer']);
  await git(projectPath, ['config', 'user.email', 'synthetic@example.test']);
  if (options.initialCommit !== false) {
    await writeFile(path.join(projectPath, 'README.md'), '# Synthetic source sync\n');
    await writeFile(path.join(projectPath, 'rename-me.txt'), 'Synthetic rename source.\n');
    await git(projectPath, ['add', 'README.md', 'rename-me.txt']);
    await git(projectPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
  }
  await git(projectPath, ['remote', 'add', 'origin', remotePath]);
  if (options.initialCommit !== false && options.pushInitial !== false) {
    await git(projectPath, ['push', '--set-upstream', 'origin', 'main:main']);
  }
  return { root, remotePath, projectPath };
}

async function makeDirty(projectPath: string): Promise<void> {
  await writeFile(path.join(projectPath, 'README.md'), '# Synthetic staged version\n');
  await git(projectPath, ['add', 'README.md']);
  await writeFile(path.join(projectPath, 'README.md'), '# Synthetic final worktree version\n');
  await rename(path.join(projectPath, 'rename-me.txt'), path.join(projectPath, 'renamed.txt'));
  await writeFile(path.join(projectPath, 'untracked.txt'), 'Synthetic untracked source.\n');
}

async function installWipRejectingHook(remotePath: string, rejectFallback: boolean): Promise<void> {
  const hookPath = path.join(remotePath, 'hooks', 'pre-receive');
  const fallbackRule = rejectFallback ? '|refs/heads/wip/*' : '';
  await writeFile(
    hookPath,
    `#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/moo-fleet/wip/*${fallbackRule}) exit 1 ;; esac\ndone\nexit 0\n`,
    { mode: 0o700 },
  );
  await chmod(hookPath, 0o700);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('session source synchronization gate', () => {
  it('pushes a WIP namespace ref containing staged, unstaged, renamed, and untracked files without touching user state', async () => {
    const context = await fixture();
    await makeDirty(context.projectPath);
    const beforePreview = await repositoryState(context.projectPath);
    const workspace = await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source');
    const gate = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });
    expect(await repositoryState(context.projectPath)).toEqual(beforePreview);
    expect(gate).toMatchObject({
      dirty: true,
      headReachable: true,
      branchReachable: true,
      requiresChoice: true,
      choices: ['push-wip-ref', 'handoff-only'],
    });
    const before = await repositoryState(context.projectPath);
    const checkpointId = 'a'.repeat(64);
    const result = await executeSourceSync({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
      choice: 'push-wip-ref',
      expectedFingerprint: gate.fingerprint,
      checkpointId,
      now: new Date('2026-07-28T07:00:00.000Z'),
    });
    const after = await repositoryState(context.projectPath);

    expect(result).toMatchObject({
      mode: 'pushed-wip-ref',
      ref: `refs/moo-fleet/wip/${checkpointId}`,
      transport: 'namespace-ref',
      codeReachable: true,
      includesWorkingTree: true,
      files: { untrackedFiles: 2 },
    });
    expect(result.files.totalBytes).toBeGreaterThan(0);
    expect(after).toEqual(before);
    const sourceRef = `refs/moo-fleet/wip/${checkpointId}`;
    expect(await git(context.remotePath, ['rev-parse', sourceRef])).toBe(result.commit);
    const receiverPath = path.join(context.root, 'synthetic-receiver');
    await git(context.root, ['init', receiverPath]);
    await git(receiverPath, ['fetch', '--no-tags', context.remotePath, sourceRef]);
    expect(await git(receiverPath, ['rev-parse', 'FETCH_HEAD'])).toBe(result.commit);
    const treeFiles = (await git(receiverPath, ['ls-tree', '-r', '--name-only', 'FETCH_HEAD'])).split('\n');
    expect(treeFiles).toEqual(expect.arrayContaining(['README.md', 'renamed.txt', 'untracked.txt']));
    expect(treeFiles).not.toContain('rename-me.txt');
    expect(await git(receiverPath, ['show', 'FETCH_HEAD:README.md'])).toBe('# Synthetic final worktree version');
  });

  it('rejects a stale preview when the same dirty file changes content without changing workspace counts', async () => {
    const context = await fixture();
    await makeDirty(context.projectPath);
    const workspace = await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source');
    const gate = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });

    await writeFile(path.join(context.projectPath, 'README.md'), '# Synthetic stale worktree version\n');
    expect(await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source')).toEqual(workspace);

    await expect(executeSourceSync({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
      choice: 'push-wip-ref',
      expectedFingerprint: gate.fingerprint,
      checkpointId: '9'.repeat(64),
    })).rejects.toThrow('源码同步门状态已变化，请重新预览后再保存');
    await expect(git(context.remotePath, ['rev-parse', `refs/moo-fleet/wip/${'9'.repeat(64)}`])).rejects.toThrow();
  });

  it('offers only viable choices for an unborn repository and pushes dirty files as a root WIP commit', async () => {
    const context = await fixture({ initialCommit: false });
    await writeFile(path.join(context.projectPath, 'README.md'), '# Synthetic unborn repository\n');
    const before = await repositoryState(context.projectPath);
    const workspace = await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source');
    const gate = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });

    expect(gate).toMatchObject({
      head: null,
      dirty: true,
      choices: ['push-wip-ref', 'handoff-only'],
    });
    expect(gate.message).toContain('尚无首个 Commit');

    const checkpointId = '8'.repeat(64);
    const result = await executeSourceSync({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
      choice: 'push-wip-ref',
      expectedFingerprint: gate.fingerprint,
      checkpointId,
    });

    expect(result).toMatchObject({
      mode: 'pushed-wip-ref',
      ref: `refs/moo-fleet/wip/${checkpointId}`,
      codeReachable: true,
      includesWorkingTree: true,
    });
    expect(await git(context.projectPath, ['rev-list', '--parents', '-n', '1', result.commit!])).toBe(result.commit);
    expect(await git(context.projectPath, ['show', `${result.commit}:README.md`])).toBe('# Synthetic unborn repository');
    expect(await repositoryState(context.projectPath)).toEqual(before);
  });

  it('offers the three-way gate for an unpushed clean branch and records an explicit handoff-only choice honestly', async () => {
    const context = await fixture({ pushInitial: false });
    const workspace = await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source');
    const gate = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });
    expect(gate).toMatchObject({
      dirty: false,
      headReachable: false,
      branchReachable: false,
      choices: ['push-branch', 'push-wip-ref', 'handoff-only'],
    });

    const handoffOnly = await executeSourceSync({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
      choice: 'handoff-only',
      expectedFingerprint: gate.fingerprint,
      checkpointId: 'b'.repeat(64),
    });
    expect(handoffOnly).toMatchObject({ mode: 'handoff-only', codeReachable: false, ref: null });

    const refreshed = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });
    const pushed = await executeSourceSync({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
      choice: 'push-branch',
      expectedFingerprint: refreshed.fingerprint,
      checkpointId: 'c'.repeat(64),
    });
    expect(pushed).toMatchObject({ mode: 'pushed-branch', codeReachable: true, ref: 'refs/heads/main' });
    expect(await git(context.remotePath, ['rev-parse', 'refs/heads/main'])).toBe(workspace.head);
  });

  it('falls back to a normal wip branch when the remote rejects the custom namespace', async () => {
    const context = await fixture();
    await installWipRejectingHook(context.remotePath, false);
    await makeDirty(context.projectPath);
    const workspace = await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source');
    const gate = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });
    const checkpointId = 'd'.repeat(64);
    const result = await executeSourceSync({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
      choice: 'push-wip-ref',
      expectedFingerprint: gate.fingerprint,
      checkpointId,
    });

    expect(result).toMatchObject({
      mode: 'pushed-wip-ref',
      transport: 'fallback-branch',
      ref: `refs/heads/wip/${checkpointId}`,
      codeReachable: true,
    });
    expect(await git(context.remotePath, ['rev-parse', `refs/heads/wip/${checkpointId}`])).toBe(result.commit);
  });

  it('keeps the repository untouched and asks for handoff-only when both WIP transports are rejected', async () => {
    const context = await fixture();
    await installWipRejectingHook(context.remotePath, true);
    await makeDirty(context.projectPath);
    const workspace = await captureWorkspaceSnapshot(context.projectPath, 'remote:synthetic-source', 'synthetic-source');
    const gate = await inspectSourceSyncGate({
      repositoryPath: context.projectPath,
      repositoryId: 'synthetic-source',
      workspace,
      remoteName: 'origin',
    });
    const before = await repositoryState(context.projectPath);
    let thrown: unknown;
    try {
      await executeSourceSync({
        repositoryPath: context.projectPath,
        repositoryId: 'synthetic-source',
        workspace,
        remoteName: 'origin',
        choice: 'push-wip-ref',
        expectedFingerprint: gate.fingerprint,
        checkpointId: 'e'.repeat(64),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceSyncError);
    expect((thrown as Error).message).toContain('仍然只存交接');
    expect(await repositoryState(context.projectPath)).toEqual(before);
  });
});
