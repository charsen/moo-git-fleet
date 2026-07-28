import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCaptureProgress, DiscoveredSession, HandoffSummary } from '../../shared/sessions.js';
import { checkpointSchema } from '../../shared/sessions.js';
import {
  captureCheckpoint,
  captureWorkspaceSnapshot,
  recoverCheckpointTransactions,
  SimulatedCheckpointInterruption,
} from './checkpoint.js';
import { SecretScanError } from './secrets.js';
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

async function fixture(): Promise<{
  root: string;
  vaultPath: string;
  projectPath: string;
  session: DiscoveredSession;
  summary: HandoffSummary;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-checkpoint-'));
  temporaryDirectories.push(root);
  const fleetPath = path.join(root, 'fleet-source');
  const vaultPath = path.join(root, 'session-vault');
  const projectPath = path.join(root, 'synthetic-project');
  await Promise.all([mkdir(fleetPath, { recursive: true }), mkdir(projectPath, { recursive: true })]);
  await git(root, ['init', '--initial-branch=main', fleetPath]);
  await git(root, ['init', '--initial-branch=main', projectPath]);
  await git(projectPath, ['config', 'user.name', 'Synthetic Developer']);
  await git(projectPath, ['config', 'user.email', 'synthetic@example.test']);
  await writeFile(path.join(projectPath, 'README.md'), '# Synthetic project\n');
  await git(projectPath, ['add', 'README.md']);
  await git(projectPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
  await initializeSessionVault(
    { vaultPath },
    {
      fleetRepositoryPath: fleetPath,
      bindingPath: path.join(root, 'fleet-home', 'config', 'session-vault.yaml'),
      now: new Date('2026-07-28T03:00:00.000Z'),
    },
  );
  await writeFile(path.join(projectPath, 'README.md'), '# Synthetic project\n\nChanged.\n');
  await writeFile(path.join(projectPath, 'untracked.txt'), 'Synthetic untracked file.\n');
  const session: DiscoveredSession = {
    schemaVersion: 1,
    provider: 'claude',
    providerSessionId: '11111111-1111-4111-8111-111111111111',
    sourcePath: '/synthetic/provider/session.jsonl',
    projectPath,
    projectId: 'remote:synthetic-project',
    repositoryId: 'synthetic-project',
    repositoryName: 'Synthetic Project',
    title: 'Continue synthetic checkpoint work',
    createdAt: '2026-07-28T02:00:00.000Z',
    lastActivityAt: '2026-07-28T02:30:00.000Z',
    bytes: 200,
    messageCount: 4,
    tailTruncated: false,
    readable: true,
    error: null,
    discoveredAt: '2026-07-28T02:31:00.000Z',
  };
  const summary: HandoffSummary = {
    goal: 'Continue the synthetic checkpoint implementation',
    completed: ['Created a synthetic Vault fixture'],
    decisions: ['Keep checkpoint events append-only'],
    nextSteps: ['Verify the generated object and event'],
    blockers: [],
    commands: ['npm test'],
    risks: ['Only synthetic content is used'],
    source: 'manual',
    reviewedAt: '2026-07-28T03:01:00.000Z',
  };
  return { root, vaultPath, projectPath, session, summary };
}

describe('atomic local checkpoint capture', () => {
  it('writes a sanitized object and append-only event, then commits an exact clean Vault snapshot', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    const progress: CheckpointCaptureProgress[] = [];
    const result = await captureCheckpoint({
      vaultPath: context.vaultPath,
      sessionId: 'fleet-session-synthetic',
      session: context.session,
      summary: context.summary,
      workspace,
      machine: 'fixture-machine',
      capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
      now: new Date('2026-07-28T03:02:00.000Z'),
      onProgress: (item) => {
        progress.push(item);
      },
    });

    expect(result.durationMs).toBeLessThan(30_000);
    expect(result.commitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(result.checkpoint).toMatchObject({
      sessionId: 'fleet-session-synthetic',
      providerSessionId: context.session.providerSessionId,
      branch: 'main',
      capabilities: { codeReachable: false },
    });
    const tree = (await git(context.vaultPath, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');
    expect(tree).toEqual(expect.arrayContaining([
      '.gitignore',
      'vault.yaml',
      `objects/${result.checkpoint.checkpointId}/handoff.md`,
      `objects/${result.checkpoint.checkpointId}/workspace.json`,
      `objects/${result.checkpoint.checkpointId}/manifest.json`,
    ]));
    const eventPath = tree.find((file) => file.startsWith('events/') && file.endsWith('.json'));
    expect(eventPath).toBeDefined();
    const event = checkpointSchema.parse(JSON.parse(await readFile(path.join(context.vaultPath, eventPath!), 'utf8')));
    expect(event).toEqual(result.checkpoint);
    const workspaceContents = await readFile(
      path.join(context.vaultPath, 'objects', result.checkpoint.checkpointId, 'workspace.json'),
      'utf8',
    );
    expect(workspaceContents).not.toContain(context.projectPath);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(progress.map((item) => item.step)).toEqual([
      'preparing',
      'writing-staging',
      'secret-scan',
      'publishing-object',
      'writing-event',
      'committing',
      'complete',
    ]);
  });

  it('blocks synthetic secrets before creating a Git commit and never echoes the secret', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    const fakeKey = `AKIA${'B'.repeat(16)}`;
    const fakePrivateKey = `${'-----BEGIN '}PRIVATE KEY-----\n${'synthetic'.repeat(10)}\n-----END PRIVATE KEY-----`;
    const progress: CheckpointCaptureProgress[] = [];
    let thrown: unknown;
    try {
      await captureCheckpoint({
        vaultPath: context.vaultPath,
        sessionId: 'fleet-session-secret-fixture',
        session: context.session,
        summary: { ...context.summary, goal: `Synthetic secret ${fakeKey}`, risks: [fakePrivateKey] },
        workspace,
        machine: 'fixture-machine',
        capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
        onProgress: (item) => {
          progress.push(item);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretScanError);
    expect((thrown as Error).message).not.toContain(fakeKey);
    expect(JSON.stringify(thrown)).not.toContain(fakeKey);
    expect(JSON.stringify(thrown)).not.toContain(fakePrivateKey);
    expect(progress.at(-1)).toMatchObject({ step: 'failed', state: 'failed' });
    expect(progress.at(-1)?.message).not.toContain(fakeKey);
    expect(progress.at(-1)?.message).not.toContain(fakePrivateKey);
    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('0');
    await expect(access(path.join(context.vaultPath, 'objects'))).rejects.toThrow();
    const stagingEntries = await readdir(path.join(context.vaultPath, '.fleet', 'staging')).catch(() => []);
    expect(stagingEntries).toEqual([]);
  });

  it('recovers a staging directory left by an interruption after the final secret scan', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    await expect(
      captureCheckpoint({
        vaultPath: context.vaultPath,
        sessionId: 'fleet-session-interruption',
        session: context.session,
        summary: context.summary,
        workspace,
        machine: 'fixture-machine',
        capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
        now: new Date('2026-07-28T03:03:00.000Z'),
        testHook: (phase) => {
          if (phase === 'after-final-scan') throw new SimulatedCheckpointInterruption();
        },
      }),
    ).rejects.toBeInstanceOf(SimulatedCheckpointInterruption);

    const stagingRoot = path.join(context.vaultPath, '.fleet', 'staging');
    expect(await readdir(stagingRoot)).toHaveLength(1);
    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('0');
    const recovered = await recoverCheckpointTransactions(context.vaultPath);
    expect(recovered).toHaveLength(1);
    expect(await readdir(stagingRoot)).toEqual([]);
    await expect(access(path.join(context.vaultPath, 'objects'))).rejects.toThrow();
    expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toEqual([]);
  });

  it.each(['after-object-publish', 'after-event-publish', 'after-index-stage'] as const)(
    'rolls back an interrupted %s transaction without changing the original Vault index state',
    async (phase) => {
      const context = await fixture();
      const workspace = await captureWorkspaceSnapshot(
        context.projectPath,
        context.session.projectId,
        context.session.repositoryId,
      );
      const statusBefore = await git(context.vaultPath, ['status', '--porcelain=v1']);
      await expect(
        captureCheckpoint({
          vaultPath: context.vaultPath,
          sessionId: `fleet-session-${phase}`,
          session: context.session,
          summary: context.summary,
          workspace,
          machine: 'fixture-machine',
          capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
          testHook: (currentPhase) => {
            if (currentPhase === phase) throw new SimulatedCheckpointInterruption();
          },
        }),
      ).rejects.toBeInstanceOf(SimulatedCheckpointInterruption);

      expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toHaveLength(1);
      expect(await recoverCheckpointTransactions(context.vaultPath)).toHaveLength(1);
      expect(await git(context.vaultPath, ['status', '--porcelain=v1'])).toBe(statusBefore);
      expect(await git(context.vaultPath, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('0');
      expect(await readdir(path.join(context.vaultPath, 'objects')).catch(() => [])).toEqual([]);
      expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toEqual([]);
    },
  );

  it('immediately rolls back the Vault index and published files when capture fails after git add', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    const statusBefore = await git(context.vaultPath, ['status', '--porcelain=v1']);
    await expect(
      captureCheckpoint({
        vaultPath: context.vaultPath,
        sessionId: 'fleet-session-index-failure',
        session: context.session,
        summary: context.summary,
        workspace,
        machine: 'fixture-machine',
        capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
        testHook: (phase) => {
          if (phase === 'after-index-stage') throw new Error('Synthetic failure after staging');
        },
      }),
    ).rejects.toThrow('Synthetic failure after staging');

    expect(await git(context.vaultPath, ['status', '--porcelain=v1'])).toBe(statusBefore);
    expect(await git(context.vaultPath, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('0');
    expect(await readdir(path.join(context.vaultPath, 'objects')).catch(() => [])).toEqual([]);
    expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toEqual([]);
  });

  it('keeps a fully committed checkpoint when the process stops before returning the result', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    await expect(
      captureCheckpoint({
        vaultPath: context.vaultPath,
        sessionId: 'fleet-session-post-commit-interruption',
        session: context.session,
        summary: context.summary,
        workspace,
        machine: 'fixture-machine',
        capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
        testHook: (phase) => {
          if (phase === 'after-commit') throw new SimulatedCheckpointInterruption();
        },
      }),
    ).rejects.toBeInstanceOf(SimulatedCheckpointInterruption);

    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('1');
    expect(await git(context.vaultPath, ['status', '--porcelain=v1'])).toBe('');
    expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toHaveLength(1);
    expect(await recoverCheckpointTransactions(context.vaultPath)).toHaveLength(1);
    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('1');
    expect(await git(context.vaultPath, ['status', '--porcelain=v1'])).toBe('');
    expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toEqual([]);
  });

  it('serializes captures for one Vault so an active journal is never mistaken for a crashed transaction', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    let releaseFirst!: () => void;
    let firstReached!: () => void;
    const firstCanContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAtScan = new Promise<void>((resolve) => {
      firstReached = resolve;
    });
    const first = captureCheckpoint({
      vaultPath: context.vaultPath,
      sessionId: 'fleet-session-concurrent-first',
      session: context.session,
      summary: context.summary,
      workspace,
      machine: 'fixture-machine',
      capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
      testHook: async (phase) => {
        if (phase !== 'after-final-scan') return;
        firstReached();
        await firstCanContinue;
      },
    });
    await firstAtScan;

    let secondSettled = false;
    const second = captureCheckpoint({
      vaultPath: context.vaultPath,
      sessionId: 'fleet-session-concurrent-second',
      session: context.session,
      summary: context.summary,
      workspace,
      machine: 'fixture-machine',
      capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
    }).finally(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);

    releaseFirst();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.checkpoint.sessionId)).toEqual([
      'fleet-session-concurrent-first',
      'fleet-session-concurrent-second',
    ]);
    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('2');
    expect(await git(context.vaultPath, ['status', '--porcelain=v1'])).toBe('');
    expect(await readdir(path.join(context.vaultPath, '.fleet', 'checkpoint-journal'))).toEqual([]);
  });

  it('rejects duplicate checkpoint ids and invalid lineage before publishing another event', async () => {
    const context = await fixture();
    const workspace = await captureWorkspaceSnapshot(
      context.projectPath,
      context.session.projectId,
      context.session.repositoryId,
    );
    const base = {
      vaultPath: context.vaultPath,
      sessionId: 'fleet-session-lineage',
      session: context.session,
      summary: context.summary,
      workspace,
      machine: 'fixture-machine',
      capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
      now: new Date('2026-07-28T03:20:00.000Z'),
    } as const;
    const first = await captureCheckpoint(base);

    await expect(captureCheckpoint(base)).rejects.toThrow('相同 checkpointId 已存在');
    await expect(captureCheckpoint({
      ...base,
      now: new Date('2026-07-28T03:21:00.000Z'),
      parentCheckpointIds: ['f'.repeat(64)],
    })).rejects.toThrow('Checkpoint parent 不存在');
    await expect(captureCheckpoint({
      ...base,
      sessionId: 'fleet-session-cross-lineage',
      now: new Date('2026-07-28T03:22:00.000Z'),
      parentCheckpointIds: [first.checkpoint.checkpointId],
    })).rejects.toThrow('不属于当前逻辑会话');

    expect(await git(context.vaultPath, ['rev-list', '--all', '--count'])).toBe('1');
    expect(await git(context.vaultPath, ['status', '--porcelain=v1'])).toBe('');
  });
});
