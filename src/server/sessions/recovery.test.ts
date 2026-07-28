import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { initializeSessionVault } from './vault.js';
import { captureCheckpoint } from './checkpoint.js';
import { normalizeRemoteUrl, projectIdFor } from './discovery.js';
import { captureWorkspaceSnapshot } from './checkpoint.js';
import { planSessionRecovery, type SessionRecoveryOptions } from './recovery.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

function repositoriesConfig(root: string, repositoryPath: string, id = 'synthetic-recovery'): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { synthetic: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [{
      id,
      name: 'Synthetic Recovery Project',
      root: 'synthetic',
      path: path.relative(root, repositoryPath),
      group: 'synthetic',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      aiCommitPolicy: 'disabled',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    }],
  };
}

async function fixture(): Promise<{
  root: string;
  fleetSource: string;
  vaultPath: string;
  bindingPath: string;
  mappingsPath: string;
  remotePath: string;
  sourcePath: string;
  targetPath: string;
  config: RepositoriesConfig;
  baseHead: string;
  wipCommit: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-recovery-'));
  temporaryDirectories.push(root);
  const fleetSource = path.join(root, 'fleet-source');
  const vaultPath = path.join(root, 'session-vault');
  const bindingPath = path.join(root, 'fleet-home', 'config', 'session-vault.yaml');
  const mappingsPath = path.join(root, 'fleet-home', '.data', 'session-project-mappings.json');
  const remotePath = path.join(root, 'project-remote.git');
  const sourcePath = path.join(root, 'source-project');
  const targetPath = path.join(root, "target project'; touch recovery-path-pwned; #");

  await git(root, ['init', '--initial-branch=main', fleetSource]);
  await git(fleetSource, ['config', 'user.name', 'Synthetic Fleet']);
  await git(fleetSource, ['config', 'user.email', 'fleet@example.test']);
  await writeFile(path.join(fleetSource, 'README.md'), 'synthetic fleet source\n');
  await git(fleetSource, ['add', 'README.md']);
  await git(fleetSource, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'fleet source']);

  await git(root, ['init', '--bare', remotePath]);
  await git(root, ['init', '--initial-branch=main', sourcePath]);
  await git(sourcePath, ['config', 'user.name', 'Synthetic Developer']);
  await git(sourcePath, ['config', 'user.email', 'developer@example.test']);
  await writeFile(path.join(sourcePath, 'README.md'), 'synthetic recovery base\n');
  await git(sourcePath, ['add', 'README.md']);
  await git(sourcePath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);
  await git(sourcePath, ['remote', 'add', 'origin', remotePath]);
  await git(sourcePath, ['push', '--set-upstream', 'origin', 'main:main']);
  await git(remotePath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const baseHead = await git(sourcePath, ['rev-parse', 'HEAD']);

  await writeFile(path.join(sourcePath, 'feature.txt'), 'synthetic WIP content\n');
  await git(sourcePath, ['add', 'feature.txt']);
  await git(sourcePath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'synthetic wip']);
  const wipCommit = await git(sourcePath, ['rev-parse', 'HEAD']);
  const wipRef = `refs/moo-fleet/wip/${'a'.repeat(64)}`;
  await git(sourcePath, ['push', 'origin', `${wipCommit}:${wipRef}`]);
  await git(sourcePath, ['reset', '--hard', baseHead]);

  await git(root, ['clone', '--branch', 'main', remotePath, targetPath]);
  await git(targetPath, ['config', 'user.name', 'Synthetic Receiver']);
  await git(targetPath, ['config', 'user.email', 'receiver@example.test']);

  await initializeSessionVault(
    { vaultPath, enableRemoteSync: false, remoteUrl: null, confirmationPhrase: '' },
    { fleetRepositoryPath: fleetSource, bindingPath },
  );
  const config = repositoriesConfig(root, targetPath);
  return { root, fleetSource, vaultPath, bindingPath, mappingsPath, remotePath, sourcePath, targetPath, config, baseHead, wipCommit };
}

async function captureSyntheticCheckpoint(context: Awaited<ReturnType<typeof fixture>>, title: string) {
  const projectId = projectIdFor(normalizeRemoteUrl(context.remotePath), context.sourcePath);
  const workspace = await captureWorkspaceSnapshot(
    context.sourcePath,
    projectId,
    'synthetic-recovery',
  );
  const checkpointRef = `refs/moo-fleet/wip/${'a'.repeat(64)}`;
  const sourceSync = {
    schemaVersion: 1 as const,
    choice: 'push-wip-ref' as const,
    mode: 'pushed-wip-ref' as const,
    remote: 'origin',
    ref: checkpointRef,
    transport: 'namespace-ref' as const,
    commit: context.wipCommit,
    codeReachable: true,
    includesWorkingTree: true,
    files: { changedFiles: 1, stagedFiles: 1, modifiedFiles: 0, deletedFiles: 0, renamedFiles: 0, untrackedFiles: 0, totalBytes: 22 },
    message: 'synthetic WIP',
  };
  return captureCheckpoint({
    vaultPath: context.vaultPath,
    sessionId: 'fleet:synthetic-recovery',
    session: {
      provider: 'claude',
      providerSessionId: 'synthetic-provider-session',
      projectId: workspace.projectId,
      repositoryId: 'synthetic-recovery',
      repositoryName: 'Synthetic Recovery Project',
      title,
    },
    summary: {
      goal: title,
      completed: ['Created a synthetic recovery checkpoint'],
      decisions: [],
      nextSteps: ['Continue the synthetic task'],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: '2026-07-28T09:00:00.000Z',
    },
    workspace,
    machine: 'synthetic-source-machine',
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: sourceSync.ref,
      sourceSync,
    },
    now: new Date('2026-07-28T09:00:00.000Z'),
  });
}

async function captureReachableCheckpoint(context: Awaited<ReturnType<typeof fixture>>, title: string) {
  const projectId = projectIdFor(normalizeRemoteUrl(context.remotePath), context.sourcePath);
  const workspace = await captureWorkspaceSnapshot(
    context.sourcePath,
    projectId,
    'synthetic-recovery',
  );
  const sourceSync = {
    schemaVersion: 1 as const,
    choice: 'handoff-only' as const,
    mode: 'already-reachable' as const,
    remote: 'origin',
    ref: 'origin/main',
    transport: 'existing-remote' as const,
    commit: context.baseHead,
    codeReachable: true,
    includesWorkingTree: false,
    files: { changedFiles: 0, stagedFiles: 0, modifiedFiles: 0, deletedFiles: 0, renamedFiles: 0, untrackedFiles: 0, totalBytes: 0 },
    message: 'Synthetic HEAD already reachable',
  };
  return captureCheckpoint({
    vaultPath: context.vaultPath,
    sessionId: 'fleet:synthetic-reachable',
    session: {
      provider: 'codex',
      providerSessionId: 'synthetic-reachable-provider-session',
      projectId: workspace.projectId,
      repositoryId: 'synthetic-recovery',
      repositoryName: 'Synthetic Recovery Project',
      title,
    },
    summary: {
      goal: title,
      completed: ['Verified the branch HEAD is already on the remote'],
      decisions: [],
      nextSteps: ['Continue the synthetic task'],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: '2026-07-28T09:05:00.000Z',
    },
    workspace,
    machine: 'synthetic-source-machine',
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync,
    },
    now: new Date('2026-07-28T09:05:00.000Z'),
  });
}

function recoveryOptions(
  context: Awaited<ReturnType<typeof fixture>>,
  repositories = context.config,
): SessionRecoveryOptions {
  return {
    repositories,
    bindingPath: context.bindingPath,
    mappingsPath: context.mappingsPath,
    indexPath: path.join(context.root, 'index.json'),
    statePath: path.join(context.root, 'sync.json'),
    launchOptions: {
      configPath: path.join(context.root, 'cmux.yaml'),
      promptDirectory: path.join(context.root, 'recovery-prompts'),
      cmuxCapability: {
        schemaVersion: 1,
        state: 'unavailable',
        command: 'cmux',
        executablePath: null,
        version: null,
        detectedAt: '2026-07-28T09:00:00.000Z',
        message: 'synthetic cmux unavailable',
      },
      providerCapability: null,
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('session recovery preflight', () => {
  it('does not treat an already-reachable branch ref as a WIP ref', async () => {
    const context = await fixture();
    await captureReachableCheckpoint(context, 'Synthetic reachable checkpoint');
    const plan = await planSessionRecovery(
      'fleet:synthetic-reachable',
      { permissionMode: 'dangerous-bypass', refreshRemote: true },
      recoveryOptions(context),
    );
    expect(plan.wip).toMatchObject({ present: false, ref: null });
    expect(plan.structuredContext).toMatchObject({ wipRef: null, wipCommit: null });
    expect(plan.blockers).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'wip-unreachable' })]));
    expect(plan.canStartUniversal).toBe(true);
    expect(plan.launch).toMatchObject({
      permissionMode: 'dangerous-bypass',
      permissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    });
    expect(plan.launch?.shellCommand).toContain("'--dangerously-bypass-approvals-and-sandbox'");
  });

  it('maps a registered repository, fetches WIP, and exposes a read-only diff', async () => {
    const context = await fixture();
    const captured = await captureSyntheticCheckpoint(context, 'Synthetic recovery checkpoint');
    const beforeHead = await git(context.targetPath, ['rev-parse', 'HEAD']);
    const beforeStatus = await git(context.targetPath, ['status', '--porcelain=v2']);
    const plan = await planSessionRecovery(
      'fleet:synthetic-recovery',
      { refreshRemote: true },
      recoveryOptions(context),
    );
    expect(plan.mapping).toMatchObject({ state: 'matched-registered', repositoryId: 'synthetic-recovery' });
    expect(plan.workspace).toMatchObject({ dirty: false, branch: 'main', head: context.baseHead, headMatchesCheckpoint: true });
    expect(plan.wip).toMatchObject({ present: true, reachable: true, fetched: true, commit: context.wipCommit });
    expect(plan.wip.files).toEqual(expect.arrayContaining([{ path: 'feature.txt', status: 'A' }]));
    expect(plan.wip.diff).toContain('synthetic WIP content');
    expect(plan.canStartUniversal).toBe(true);
    expect(plan.command?.command).toContain("cd '");
    expect(plan.structuredContextJson).toContain('synthetic-recovery');
    expect(await git(context.targetPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await git(context.targetPath, ['status', '--porcelain=v2'])).toBe(beforeStatus);
    expect(captured.checkpoint.checkpointId).not.toBe('');
  });

  it('stops at preflight when the local worktree is dirty and saves a manual mapping once', async () => {
    const context = await fixture();
    const captured = await captureSyntheticCheckpoint(context, 'Dirty recovery checkpoint');
    const noRegistry = { ...context.config, repositories: [] };
    const missing = await planSessionRecovery(
      'fleet:synthetic-recovery',
      {},
      recoveryOptions(context, noRegistry),
    );
    expect(missing.mapping.state).toBe('needs-selection');

    const selected = await planSessionRecovery(
      'fleet:synthetic-recovery',
      { localPath: context.targetPath, refreshRemote: false },
      recoveryOptions(context, noRegistry),
    );
    expect(selected.mapping).toMatchObject({ state: 'matched-manual', source: 'request-manual' });
    const savedBefore = await readFile(context.mappingsPath, 'utf8');
    await writeFile(path.join(context.targetPath, 'local-change.txt'), 'local dirty change\n');
    const dirty = await planSessionRecovery(
      'fleet:synthetic-recovery',
      { refreshRemote: false },
      recoveryOptions(context, noRegistry),
    );
    expect(dirty.mapping).toMatchObject({ state: 'matched-manual', source: 'saved-manual' });
    expect(dirty.workspace).toMatchObject({ dirty: true });
    expect(dirty.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'workspace-dirty', severity: 'blocking' })]));
    expect(dirty.canStartUniversal).toBe(false);
    expect(dirty.workspace?.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'local-change.txt', status: '??' })]));
    expect(await readFile(context.mappingsPath, 'utf8')).toBe(savedBefore);
    expect(captured.checkpoint.checkpointId).not.toBe('');
  });

  it('shell-quotes malicious title, path, and prompt without changing command structure', async () => {
    const context = await fixture();
    const marker = path.join(context.root, 'recovery-path-pwned');
    const captured = await captureSyntheticCheckpoint(context, `Synthetic "; touch ${marker}; #`);
    const bin = path.join(context.root, 'bin');
    const argsPath = path.join(context.root, 'args.txt');
    const cwdPath = path.join(context.root, 'cwd.txt');
    await mkdir(bin);
    await writeFile(path.join(bin, 'claude'), '#!/bin/sh\npwd > "$RECOVERY_CWD_FILE"\nprintf "%s\\n" "$@" > "$RECOVERY_ARGS_FILE"\n', { mode: 0o700 });
    await chmod(path.join(bin, 'claude'), 0o700);
    const plan = await planSessionRecovery(
      'fleet:synthetic-recovery',
      { refreshRemote: false },
      recoveryOptions(context),
    );
    expect(plan.command?.command).toContain("'\\''");
    await execFileAsync('/bin/sh', ['-c', plan.command!.command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, RECOVERY_ARGS_FILE: argsPath, RECOVERY_CWD_FILE: cwdPath } });
    expect(await readFile(cwdPath, 'utf8')).toContain("target project'; touch recovery-path-pwned; #");
    expect(await readFile(argsPath, 'utf8')).toContain('touch');
    await expect(readFile(marker)).rejects.toThrow();
    expect(captured.checkpoint.checkpointId).not.toBe('');
  });
});
