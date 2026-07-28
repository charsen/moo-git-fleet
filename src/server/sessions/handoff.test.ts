import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import type {
  HandoffSummary,
  ProviderCapabilities,
  SourceSyncGate,
  SourceSyncResult,
  WorkspaceSnapshot,
} from '../../shared/sessions.js';
import { checkpointJob, resetCheckpointJobsForTests } from './checkpoint-jobs.js';
import { encodeClaudeProjectPath } from './discovery.js';
import {
  sessionCheckpointPreview,
  sessionCheckpointProviderSummaryPreview,
  startSessionCheckpoint,
  SessionCheckpointWorkflowError,
} from './handoff.js';
import { initializeSessionVault } from './vault.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetCheckpointJobsForTests();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

async function waitForJob(operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = checkpointJob(operationId);
    if (current && ['success', 'failed'].includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('checkpoint job timeout');
}

describe('session checkpoint preview and capture workflow', () => {
  it('redacts a risky metadata draft, requires a fresh reviewed workspace, and completes in the background', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-handoff-workflow-'));
    temporaryDirectories.push(root);
    const fleetSource = path.join(root, 'fleet-source');
    const repositoriesRoot = path.join(root, 'repositories');
    const projectPath = path.join(repositoriesRoot, 'synthetic-project');
    const claudeHome = path.join(root, '.claude');
    const codexHome = path.join(root, '.codex');
    const vaultPath = path.join(root, 'session-vault');
    const bindingPath = path.join(root, 'fleet-home', 'config', 'session-vault.yaml');
    await Promise.all([mkdir(fleetSource, { recursive: true }), mkdir(projectPath, { recursive: true })]);
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    await git(root, ['init', '--initial-branch=main', projectPath]);
    await git(projectPath, ['config', 'user.name', 'Synthetic Developer']);
    await git(projectPath, ['config', 'user.email', 'synthetic@example.test']);
    await git(projectPath, ['remote', 'add', 'origin', 'https://example.test/synthetic/project.git']);
    await writeFile(path.join(projectPath, 'README.md'), '# Synthetic project\n');
    await git(projectPath, ['add', 'README.md']);
    await git(projectPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await initializeSessionVault(
      { vaultPath },
      { fleetRepositoryPath: fleetSource, bindingPath, now: new Date('2026-07-28T04:00:00.000Z') },
    );

    const sessionId = '44444444-4444-4444-8444-444444444444';
    const fakeKey = `AKIA${'C'.repeat(16)}`;
    const claudeProject = path.join(claudeHome, 'projects', encodeClaudeProjectPath(projectPath));
    await mkdir(claudeProject, { recursive: true });
    await writeFile(
      path.join(claudeProject, `${sessionId}.jsonl`),
      `${JSON.stringify({ timestamp: '2026-07-28T03:30:00.000Z', title: `Synthetic title ${fakeKey}` })}\n`,
    );
    const repository = {
      id: 'synthetic-project',
      name: 'Synthetic Project',
      root: 'fixture',
      path: 'synthetic-project',
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 1,
      tags: [],
      aiCommitPolicy: 'disabled' as const,
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    const repositories: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { fixture: repositoriesRoot },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [repository],
    };
    const providerCapabilities = {
      schemaVersion: 1,
      provider: 'claude',
      state: 'supported',
      command: 'claude',
      commandPath: '/synthetic/bin/claude',
      realBinaryPath: '/synthetic/bin/claude-real',
      shimChain: ['/synthetic/bin/claude', '/synthetic/bin/claude-real'],
      version: '2.1.0-fixture',
      helpSignature: 'synthetic',
      nativeResume: true,
      forkResume: true,
      checkedAt: '2026-07-28T03:00:00.000Z',
      reason: null,
    } satisfies ProviderCapabilities;
    const options = {
      repositories,
      claudeHome,
      codexHome,
      providerCapabilities,
      sourceSyncInspector: async (input: { workspace: WorkspaceSnapshot; repositoryId: string }): Promise<SourceSyncGate> => ({
        schemaVersion: 1,
        fingerprint: 'f'.repeat(64),
        repositoryId: input.repositoryId,
        branch: input.workspace.branch,
        head: input.workspace.head,
        workspaceStateHash: '1'.repeat(64),
        remote: 'origin',
        upstream: 'origin/main',
        dirty: input.workspace.dirty,
        remoteChecked: true,
        headReachable: true,
        branchReachable: true,
        requiresChoice: input.workspace.dirty,
        choices: input.workspace.dirty ? ['push-wip-ref', 'handoff-only'] : ['handoff-only'],
        message: input.workspace.dirty ? 'Synthetic WIP choice required' : 'Synthetic HEAD is reachable',
      }),
      sourceSyncExecutor: async (input: { workspace: WorkspaceSnapshot }): Promise<SourceSyncResult> => ({
        schemaVersion: 1 as const,
        choice: 'handoff-only' as const,
        mode: 'already-reachable' as const,
        remote: 'origin',
        ref: 'origin/main',
        transport: 'existing-remote' as const,
        commit: input.workspace.head,
        codeReachable: true,
        includesWorkingTree: false,
        files: {
          changedFiles: input.workspace.changedFiles,
          stagedFiles: input.workspace.stagedFiles,
          modifiedFiles: input.workspace.modifiedFiles,
          deletedFiles: input.workspace.deletedFiles,
          renamedFiles: input.workspace.renamedFiles,
          untrackedFiles: input.workspace.untrackedFiles,
          totalBytes: 0,
        },
        message: 'Synthetic HEAD is already reachable',
      }),
      providerSummaryExecutor: async () => ({
        stdout: JSON.stringify({
          goal: 'Continue a provider-generated synthetic workflow',
          completed: ['Verified the same-provider summary path'],
          decisions: ['Require explicit opt-in before token use'],
          nextSteps: ['Review and save the checkpoint'],
          blockers: [],
          commands: [],
          risks: ['Synthetic provider invocation consumes tokens'],
        }),
        exitCode: 0,
        timedOut: false,
        failedToStart: false,
        outputExceeded: false,
      }),
      vault: { fleetRepositoryPath: fleetSource, bindingPath },
    };

    const preview = await sessionCheckpointPreview('claude', sessionId, options);
    expect(preview.workspaceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.secretFindings).toHaveLength(1);
    expect(preview.summary.goal).toContain('[REDACTED:aws-access-key]');
    expect(preview.session.title).not.toContain(fakeKey);
    expect(JSON.stringify(preview)).not.toContain(fakeKey);
    expect(preview.summaryGeneration).toMatchObject({
      method: 'heuristic',
      providerInvocationAvailable: true,
      providerInvocationAttempted: false,
      incursProviderTokenUsage: true,
      requiresExplicitOptIn: true,
    });

    const providerPreview = await sessionCheckpointProviderSummaryPreview('claude', sessionId, options);
    expect(providerPreview.summary).toMatchObject({
      goal: 'Continue a provider-generated synthetic workflow',
      source: 'ai-generated',
    });
    expect(providerPreview.summaryGeneration).toMatchObject({
      method: 'provider',
      providerInvocationAttempted: true,
      providerInvocationSucceeded: true,
      incursProviderTokenUsage: true,
    });

    const reviewedSummary: HandoffSummary = {
      ...preview.summary,
      goal: 'Continue a safe synthetic workflow',
      source: 'manual',
      reviewedAt: '2026-07-28T04:01:00.000Z',
    };
    const started = await startSessionCheckpoint(
      'claude',
      sessionId,
      {
        summary: reviewedSummary,
        expectedWorkspaceFingerprint: preview.workspaceFingerprint!,
        expectedSourceSyncFingerprint: preview.sourceSyncGate!.fingerprint,
        sourceSyncChoice: 'handoff-only',
        machine: 'fixture-machine',
      },
      options,
    );
    const finished = await waitForJob(started.operationId);
    expect(finished?.error).toBeNull();
    expect(finished).toMatchObject({
      state: 'success',
      result: {
        checkpoint: {
          providerSessionId: sessionId,
          capabilities: {
            nativeResume: true,
            universalHandoff: true,
            codeReachable: true,
            sourceSync: { mode: 'already-reachable' },
          },
        },
      },
    });
    expect(await git(vaultPath, ['rev-list', '--all', '--count'])).toBe('1');

    const secondPreview = await sessionCheckpointPreview('claude', sessionId, options);
    await writeFile(path.join(projectPath, 'late-change.txt'), 'Changed after preview.\n');
    await expect(
      startSessionCheckpoint(
        'claude',
        sessionId,
        {
          summary: { ...secondPreview.summary, source: 'manual', reviewedAt: '2026-07-28T04:02:00.000Z' },
          expectedWorkspaceFingerprint: secondPreview.workspaceFingerprint!,
          expectedSourceSyncFingerprint: secondPreview.sourceSyncGate!.fingerprint,
          sourceSyncChoice: 'handoff-only',
          machine: 'fixture-machine',
        },
        options,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof SessionCheckpointWorkflowError && error.message.includes('工作区已变化'),
    );
  });
});
