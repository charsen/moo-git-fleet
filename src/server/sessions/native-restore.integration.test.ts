import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import type { ProviderCapabilities } from '../../shared/sessions.js';
import { captureCheckpoint, captureWorkspaceSnapshot } from './checkpoint.js';
import { encodeClaudeProjectPath, normalizeRemoteUrl, projectIdFor } from './discovery.js';
import { captureNativeCapsule, type NativeProviderFileAccess } from './native-capsule.js';
import {
  executeSessionNativeRestore,
  planSessionRecovery,
  rollbackSessionNativeRestore,
  type SessionRecoveryOptions,
} from './recovery.js';
import { initializeSessionVault } from './vault.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

function capabilities(): ProviderCapabilities {
  return {
    schemaVersion: 1,
    provider: 'claude',
    state: 'supported',
    command: 'claude',
    commandPath: '/synthetic/bin/claude',
    realBinaryPath: '/synthetic/bin/claude-real',
    shimChain: ['/synthetic/bin/claude', '/synthetic/bin/claude-real'],
    version: 'Claude Code 2.1.7-synthetic',
    helpSignature: '--resume --fork-session --session-id',
    nativeResume: true,
    forkResume: true,
    checkedAt: '2026-07-28T11:00:00.000Z',
    reason: null,
  };
}

describe('native restore transaction', () => {
  it('reads a verified Vault capsule, backs up and installs it, rolls back in one step, and auto-rolls back a failed retry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-native-restore-'));
    temporaryDirectories.push(root);
    const fleetSource = path.join(root, 'fleet-source');
    const remotePath = path.join(root, 'project.git');
    const sourceProject = path.join(root, 'source-project');
    const targetProject = path.join(root, 'target-project');
    const sourceUserHome = path.join(root, 'source-home');
    const targetUserHome = path.join(root, 'target-home');
    const sourceClaudeHome = path.join(sourceUserHome, '.claude');
    const targetClaudeHome = path.join(targetUserHome, '.claude');
    const vaultPath = path.join(root, 'session-vault');
    const bindingPath = path.join(root, 'fleet-home', 'config', 'session-vault.yaml');
    const backupDirectory = path.join(root, 'fleet-home', '.data', 'native-backups');
    const providerSessionId = '33333333-3333-4333-8333-333333333333';
    const logicalSessionId = 'fleet:synthetic-native-restore';

    await git(root, ['init', '--initial-branch=main', fleetSource]);
    await git(root, ['init', '--bare', remotePath]);
    await git(root, ['init', '--initial-branch=main', sourceProject]);
    await git(sourceProject, ['config', 'user.name', 'Synthetic Source']);
    await git(sourceProject, ['config', 'user.email', 'source@example.test']);
    await writeFile(path.join(sourceProject, 'README.md'), 'synthetic native restore\n');
    await git(sourceProject, ['add', 'README.md']);
    await git(sourceProject, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(sourceProject, ['remote', 'add', 'origin', remotePath]);
    await git(sourceProject, ['push', '--set-upstream', 'origin', 'main:main']);
    await git(root, ['clone', '--branch', 'main', remotePath, targetProject]);
    const canonicalTargetProject = await realpath(targetProject);
    await initializeSessionVault({ vaultPath }, { fleetRepositoryPath: fleetSource, bindingPath });

    const sourceDirectory = path.join(sourceClaudeHome, 'projects', encodeClaudeProjectPath(sourceProject));
    const sourcePath = path.join(sourceDirectory, `${providerSessionId}.jsonl`);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, `${JSON.stringify({
      timestamp: '2026-07-28T10:30:00.000Z',
      cwd: sourceProject,
      title: 'Synthetic native restore session',
    })}\n`);
    const nativeCapsule = await captureNativeCapsule({
      session: {
        schemaVersion: 1,
        provider: 'claude',
        providerSessionId,
        sourcePath,
        projectPath: sourceProject,
        projectId: 'temporary',
        repositoryId: 'synthetic-native',
        repositoryName: 'Synthetic Native',
        title: 'Synthetic native restore session',
        createdAt: '2026-07-28T10:30:00.000Z',
        lastActivityAt: '2026-07-28T10:30:00.000Z',
        bytes: 1,
        messageCount: 1,
        tailTruncated: false,
        readable: true,
        error: null,
        discoveredAt: '2026-07-28T11:00:00.000Z',
      },
      capabilities: capabilities(),
      claudeHome: sourceClaudeHome,
      sourceUserHome,
      now: new Date('2026-07-28T11:00:00.000Z'),
    });
    expect(nativeCapsule.manifest.status).toBe('verified');

    const projectId = projectIdFor(normalizeRemoteUrl(remotePath), sourceProject);
    const workspace = await captureWorkspaceSnapshot(sourceProject, projectId, 'synthetic-native');
    const captured = await captureCheckpoint({
      vaultPath,
      sessionId: logicalSessionId,
      session: {
        provider: 'claude',
        providerSessionId,
        projectId,
        repositoryId: 'synthetic-native',
        repositoryName: 'Synthetic Native',
        title: 'Synthetic native restore session',
      },
      summary: {
        goal: 'Continue the synthetic native restore session',
        completed: ['Captured one synthetic Claude JSONL'],
        decisions: ['Keep SQLite outside the capsule'],
        nextSteps: ['Restore on the synthetic target home'],
        blockers: [],
        commands: [],
        risks: [],
        source: 'manual',
        reviewedAt: '2026-07-28T11:00:00.000Z',
      },
      workspace,
      machine: 'synthetic-source',
      capabilities: {
        nativeResume: true,
        universalHandoff: true,
        codeReachable: true,
        wipRef: null,
        sourceSync: null,
      },
      nativeCapsule,
      now: new Date('2026-07-28T11:00:00.000Z'),
    });
    expect(captured.checkpoint.capabilities.nativeResume).toBe(true);

    const repositories: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { synthetic: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [{
        id: 'synthetic-native',
        name: 'Synthetic Native',
        root: 'synthetic',
        path: path.relative(root, targetProject),
        group: 'Tests',
        enabled: true,
        pinned: false,
        order: 1,
        tags: [],
        aiCommitPolicy: 'disabled',
        capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
      }],
    };
    const targetDirectory = path.join(targetClaudeHome, 'projects', encodeClaudeProjectPath(canonicalTargetProject));
    const targetPath = path.join(targetDirectory, `${providerSessionId}.jsonl`);
    const sqlitePath = path.join(targetClaudeHome, 'state.sqlite');
    const originalContent = `${JSON.stringify({ title: 'Existing local provider session' })}\n`;
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(targetPath, originalContent);
    await writeFile(sqlitePath, 'must remain unread');
    await chmod(sqlitePath, 0o000);

    const accesses: NativeProviderFileAccess[] = [];
    const options: SessionRecoveryOptions = {
      repositories,
      bindingPath,
      indexPath: path.join(root, 'index.json'),
      statePath: path.join(root, 'sync.json'),
      mappingsPath: path.join(root, 'fleet-home', '.data', 'mappings.json'),
      providerCapabilities: capabilities(),
      claudeHome: targetClaudeHome,
      targetUserHome,
      nativeBackupDirectory: backupDirectory,
      onProviderFileAccess: (item) => {
        accesses.push(item);
      },
      launchOptions: {
        configPath: path.join(root, 'cmux.yaml'),
        promptDirectory: path.join(root, 'prompts'),
        cmuxCapability: {
          schemaVersion: 1,
          state: 'unavailable',
          command: 'cmux',
          executablePath: null,
          version: null,
          detectedAt: '2026-07-28T11:00:00.000Z',
          message: 'synthetic cmux unavailable',
        },
        providerCapability: capabilities(),
      },
    };

    const plan = await planSessionRecovery(logicalSessionId, { refreshRemote: false }, options);
    expect(plan.native).toMatchObject({ status: 'verified', available: true, action: 'replace-with-backup', backupRequired: true });
    const restored = await executeSessionNativeRestore(logicalSessionId, {
      checkpointId: captured.checkpoint.checkpointId,
      expectedNativeFingerprint: plan.native.fingerprint!,
      confirmNativeRestore: true,
    }, options);
    expect(restored).toMatchObject({ status: 'verified', action: 'replaced', backupExists: true, rollbackAvailable: true });
    expect(await readFile(targetPath, 'utf8')).toContain(canonicalTargetProject);
    expect(await readFile(targetPath, 'utf8')).not.toContain(sourceProject);
    await access(path.join(backupDirectory, restored.backupId!, 'original.jsonl'));

    const rolledBack = await rollbackSessionNativeRestore(logicalSessionId, {
      backupId: restored.backupId!,
      expectedInstalledSha256: restored.installedSha256!,
      confirmRollback: true,
    }, options);
    expect(rolledBack).toMatchObject({ restoredOriginal: true, removedInstalledFile: false });
    expect(await readFile(targetPath, 'utf8')).toBe(originalContent);

    const retryPlan = await planSessionRecovery(logicalSessionId, { refreshRemote: false }, options);
    const failed = await executeSessionNativeRestore(logicalSessionId, {
      checkpointId: captured.checkpoint.checkpointId,
      expectedNativeFingerprint: retryPlan.native.fingerprint!,
      confirmNativeRestore: true,
    }, {
      ...options,
      nativeTestHook: (phase) => {
        if (phase === 'after-target-write') throw new Error('Synthetic post-write failure');
      },
    });
    expect(failed).toMatchObject({ status: 'restore-failed', action: 'failed', automaticallyRolledBack: true });
    expect(await readFile(targetPath, 'utf8')).toBe(originalContent);
    expect(accesses.some((item) => /sqlite|wal|shm/i.test(item.path))).toBe(false);
    await chmod(sqlitePath, 0o600);
  });
});
