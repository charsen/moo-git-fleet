import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureCheckpointInput } from './checkpoint.js';
import { captureCheckpoint } from './checkpoint.js';
import {
  listSessionVaultSessions,
  sessionVaultCheckpointPayload,
  sessionVaultSessionDetail,
} from './catalog.js';
import {
  pullSessionVault,
  pushSessionVault,
  sessionVaultSyncStatus,
  SessionVaultSyncError,
  type SessionVaultSyncOptions,
} from './sync.js';
import {
  initializeSessionVault,
  SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
} from './vault.js';
import { mutateSessionLifecycle, previewSessionTrashEmpty } from './lifecycle.js';
import { mergeSessionFork, selectSessionForkHead, splitSessionFork } from './fork.js';
import { saveSessionDeletionConflictAsNew } from './deletion-conflict.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  remotePath: string;
  fleetPath: string;
  machineA: SessionVaultSyncOptions & { vaultPath: string };
  machineB: SessionVaultSyncOptions & { vaultPath: string };
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-sync-'));
  temporaryDirectories.push(root);
  const remotePath = path.join(root, 'session-vault-remote.git');
  const fleetPath = path.join(root, 'fleet-source');
  await git(root, ['init', '--bare', remotePath]);
  await git(root, ['init', '--initial-branch=main', fleetPath]);
  const machine = (name: string) => ({
    fleetRepositoryPath: fleetPath,
    bindingPath: path.join(root, name, 'config', 'session-vault.yaml'),
    statePath: path.join(root, name, 'config', 'session-vault-sync.json'),
    vaultPath: path.join(root, name, 'vault'),
  });
  return {
    root,
    remotePath,
    fleetPath,
    machineA: machine('machine-a'),
    machineB: machine('machine-b'),
  };
}

async function initializeMachine(
  machine: SessionVaultSyncOptions & { vaultPath: string },
  remotePath: string,
): Promise<void> {
  await initializeSessionVault(
    {
      vaultPath: machine.vaultPath,
      remoteUrl: remotePath,
      enableRemoteSync: true,
      confirmationPhrase: SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
    },
    machine,
  );
}

function checkpointInput(
  vaultPath: string,
  index: number,
  parentCheckpointIds: string[] = [],
): CaptureCheckpointInput {
  return {
    vaultPath,
    sessionId: 'fleet:synthetic-session-sync',
    session: {
      provider: 'claude',
      providerSessionId: '77777777-7777-4777-8777-777777777777',
      projectId: 'remote:synthetic-project',
      repositoryId: 'synthetic-project',
      repositoryName: 'Synthetic Project',
      title: `Synthetic handoff ${index}`,
    },
    summary: {
      goal: `Continue synthetic checkpoint ${index}`,
      completed: [`Completed synthetic step ${index}`],
      decisions: [],
      nextSteps: [`Run synthetic step ${index + 1}`],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: `2026-07-28T0${index}:00:00.000Z`,
    },
    workspace: {
      projectId: 'remote:synthetic-project',
      repositoryId: 'synthetic-project',
      branch: 'feature/session-sync',
      head: String(index).repeat(40),
      dirty: false,
      changedFiles: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      untrackedFiles: 0,
    },
    parentCheckpointIds,
    machine: 'synthetic-machine-a',
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync: null,
    },
    now: new Date(`2026-07-28T0${index}:00:00.000Z`),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session Vault remote synchronization', { timeout: 15_000 }, () => {
  it('pushes on machine A and bootstraps an empty machine B Vault with a fast-forward Pull', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const captured = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    expect(await sessionVaultSyncStatus(context.machineA)).toMatchObject({
      state: 'local-ahead',
      pendingLocal: true,
      ahead: 1,
    });

    const pushed = await pushSessionVault(context.machineA);
    expect(pushed).toMatchObject({ state: 'synced', pendingLocal: false, ahead: 0, behind: 0 });
    expect(await git(context.remotePath, ['rev-parse', 'refs/heads/main'])).toBe(captured.commitHash);

    await initializeMachine(context.machineB, context.remotePath);
    expect(await sessionVaultSyncStatus(context.machineB)).toMatchObject({
      state: 'remote-unknown',
      remoteChecked: false,
      localHead: null,
      remoteHead: null,
    });
    const pulled = await pullSessionVault(context.machineB);
    expect(pulled).toMatchObject({
      state: 'synced',
      localHead: captured.commitHash,
      remoteHead: captured.commitHash,
      pendingLocal: false,
    });
    expect(await git(context.machineB.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(await git(context.machineB.vaultPath, ['rev-parse', 'HEAD'])).toBe(captured.commitHash);
    const sessions = await listSessionVaultSessions({}, context.machineB);
    expect(sessions).toMatchObject({
      total: 1,
      items: [{
        sessionId: 'fleet:synthetic-session-sync',
        provider: 'claude',
        title: 'Synthetic handoff 1',
        projectId: 'remote:synthetic-project',
        machine: 'synthetic-machine-a',
        checkpointCount: 1,
        forked: false,
        capabilities: { codeReachable: true },
      }],
      sync: { state: 'synced' },
    });
    const detail = await sessionVaultSessionDetail('fleet:synthetic-session-sync', context.machineB);
    expect(detail.latestHandoffMarkdown).toContain('Continue synthetic checkpoint 1');
    expect(detail.latestWorkspace).toMatchObject({ branch: 'feature/session-sync', dirty: false });
  });

  it('keeps a local checkpoint after an offline Push failure and succeeds on retry', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const first = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    const second = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 2, [first.checkpoint.checkpointId]));
    const offlinePath = `${context.remotePath}.offline`;
    await rename(context.remotePath, offlinePath);

    await expect(pushSessionVault(context.machineA)).rejects.toMatchObject({
      code: 'vault-remote-unavailable',
      statusCode: 502,
    } satisfies Partial<SessionVaultSyncError>);
    expect(await git(context.machineA.vaultPath, ['rev-parse', 'HEAD'])).toBe(second.commitHash);
    expect(await git(context.machineA.vaultPath, ['status', '--porcelain'])).toBe('');
    const failed = await sessionVaultSyncStatus(context.machineA);
    expect(failed).toMatchObject({
      state: 'sync-failed',
      pendingLocal: true,
      ahead: 1,
      localHead: second.commitHash,
      remoteHead: first.commitHash,
    });
    expect(failed.lastError).not.toContain(context.root);

    await rename(offlinePath, context.remotePath);
    const retried = await pushSessionVault(context.machineA);
    expect(retried).toMatchObject({ state: 'synced', pendingLocal: false, lastError: null });
    expect(await git(context.remotePath, ['rev-parse', 'refs/heads/main'])).toBe(second.commitHash);
  });

  it('rebases concurrent append-only checkpoint commits and exposes the logical session fork without Git conflicts', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const rootCheckpoint = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const machineAHead = await captureCheckpoint(
      checkpointInput(context.machineA.vaultPath, 2, [rootCheckpoint.checkpoint.checkpointId]),
    );
    const machineBHead = await captureCheckpoint(
      checkpointInput(context.machineB.vaultPath, 3, [rootCheckpoint.checkpoint.checkpointId]),
    );
    await pushSessionVault(context.machineA);

    const synchronizedB = await pushSessionVault(context.machineB);
    expect(synchronizedB).toMatchObject({ state: 'synced', ahead: 0, behind: 0, pendingLocal: false });
    expect(await git(context.machineB.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(await git(context.machineB.vaultPath, ['ls-files', '-u'])).toBe('');

    await pullSessionVault(context.machineA);
    expect(await git(context.machineA.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(await git(context.machineA.vaultPath, ['ls-files', '-u'])).toBe('');
    const list = await listSessionVaultSessions({}, context.machineA);
    expect(list.items[0]).toMatchObject({
      sessionId: 'fleet:synthetic-session-sync',
      checkpointCount: 3,
      forked: true,
    });
    expect(new Set(list.items[0]!.headCheckpointIds)).toEqual(new Set([
      machineAHead.checkpoint.checkpointId,
      machineBHead.checkpoint.checkpointId,
    ]));
    await expect(
      sessionVaultCheckpointPayload('fleet:synthetic-session-sync', null, context.machineA),
    ).rejects.toThrow('先明确选择一个 head checkpoint');
    expect((await sessionVaultSessionDetail('fleet:synthetic-session-sync', context.machineA)).checkpoints).toHaveLength(3);

    const merged = await mergeSessionFork(
      'fleet:synthetic-session-sync',
      {
        expectedHeadCheckpointIds: list.items[0]!.headCheckpointIds,
        baseCheckpointId: machineAHead.checkpoint.checkpointId,
        summary: {
          goal: 'Merge the two synthetic offline branches',
          completed: ['Reviewed both synthetic handoff branches'],
          decisions: ['Use machine A as the synthetic recovery baseline'],
          nextSteps: ['Continue from the merged synthetic checkpoint'],
          blockers: [],
          commands: [],
          risks: ['This synthetic merge combines handoff context, not source code'],
          source: 'manual',
          reviewedAt: '2026-07-28T04:00:00.000Z',
        },
      },
      {
        ...context.machineA,
        machine: 'synthetic-merge-machine',
        now: new Date('2026-07-28T04:00:00.000Z'),
      },
    );
    expect(new Set(merged.checkpoint.parentCheckpointIds)).toEqual(new Set([
      machineAHead.checkpoint.checkpointId,
      machineBHead.checkpoint.checkpointId,
    ]));
    expect((await listSessionVaultSessions({}, context.machineA)).items[0]).toMatchObject({
      checkpointCount: 4,
      forked: false,
      headCheckpointIds: [merged.checkpoint.checkpointId],
    });
    await pushSessionVault(context.machineA);
    await pullSessionVault(context.machineB);
    expect((await listSessionVaultSessions({}, context.machineB)).items[0]).toMatchObject({
      checkpointCount: 4,
      forked: false,
      headCheckpointIds: [merged.checkpoint.checkpointId],
    });
  });

  it('aborts an unexpected Git path conflict and restores the original clean Vault state', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const collisionPathA = path.join(context.machineA.vaultPath, 'synthetic-collision.txt');
    const collisionPathB = path.join(context.machineB.vaultPath, 'synthetic-collision.txt');
    await writeFile(collisionPathA, 'synthetic machine A\n');
    await writeFile(collisionPathB, 'synthetic machine B\n');
    for (const machine of [context.machineA, context.machineB]) {
      await git(machine.vaultPath, ['add', '--', 'synthetic-collision.txt']);
      await git(machine.vaultPath, [
        '-c',
        'user.name=Synthetic Sync',
        '-c',
        'user.email=synthetic-sync@example.test',
        'commit',
        '-m',
        'synthetic collision',
      ]);
    }
    const machineBHeadBefore = await git(context.machineB.vaultPath, ['rev-parse', 'HEAD']);
    await pushSessionVault(context.machineA);

    await expect(pushSessionVault(context.machineB)).rejects.toMatchObject({
      code: 'vault-diverged',
      statusCode: 409,
      message: expect.stringContaining('未留下冲突标记'),
    } satisfies Partial<SessionVaultSyncError>);
    expect(await git(context.machineB.vaultPath, ['rev-parse', 'HEAD'])).toBe(machineBHeadBefore);
    expect(await git(context.machineB.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(await git(context.machineB.vaultPath, ['ls-files', '-u'])).toBe('');
    expect(await readFile(collisionPathB, 'utf8')).toBe('synthetic machine B\n');
  });

  it('persists a selected head, reopens the fork when an old device extends a discarded head, and splits it safely', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const rootCheckpoint = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const keptHead = await captureCheckpoint(
      checkpointInput(context.machineA.vaultPath, 2, [rootCheckpoint.checkpoint.checkpointId]),
    );
    const discardedHead = await captureCheckpoint(
      checkpointInput(context.machineB.vaultPath, 3, [rootCheckpoint.checkpoint.checkpointId]),
    );
    await pushSessionVault(context.machineA);
    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    const forked = (await listSessionVaultSessions({}, context.machineA)).items[0]!;
    expect(forked.forked).toBe(true);

    await selectSessionForkHead(
      forked.sessionId,
      {
        expectedHeadCheckpointIds: forked.headCheckpointIds,
        selectedHeadCheckpointId: keptHead.checkpoint.checkpointId,
      },
      { ...context.machineA, machine: 'synthetic-machine-a', now: new Date('2026-07-28T03:30:00.000Z') },
    );
    expect((await listSessionVaultSessions({}, context.machineA)).items[0]).toMatchObject({
      forked: false,
      headCheckpointIds: [keptHead.checkpoint.checkpointId],
    });
    await pushSessionVault(context.machineA);

    const revivedHead = await captureCheckpoint(
      checkpointInput(context.machineB.vaultPath, 4, [discardedHead.checkpoint.checkpointId]),
    );
    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    const revivedFork = (await listSessionVaultSessions({}, context.machineA)).items[0]!;
    expect(revivedFork.forked).toBe(true);
    expect(new Set(revivedFork.headCheckpointIds)).toEqual(new Set([
      keptHead.checkpoint.checkpointId,
      revivedHead.checkpoint.checkpointId,
    ]));

    const split = await splitSessionFork(
      revivedFork.sessionId,
      {
        expectedHeadCheckpointIds: revivedFork.headCheckpointIds,
        selectedHeadCheckpointId: keptHead.checkpoint.checkpointId,
        splitHeadCheckpointId: revivedHead.checkpoint.checkpointId,
        newSessionSummary: {
          goal: 'Continue the revived synthetic branch separately',
          completed: ['Separated the old-device synthetic continuation'],
          decisions: ['Keep the machine A branch in the original logical session'],
          nextSteps: ['Continue the revived branch as its own synthetic session'],
          blockers: [],
          commands: [],
          risks: [],
          source: 'manual',
          reviewedAt: '2026-07-28T05:00:00.000Z',
        },
      },
      { ...context.machineA, machine: 'synthetic-split-machine', now: new Date('2026-07-28T05:00:00.000Z') },
    );
    const splitList = await listSessionVaultSessions({}, context.machineA);
    expect(splitList.total).toBe(2);
    expect(splitList.items.find((item) => item.sessionId === revivedFork.sessionId)).toMatchObject({
      forked: false,
      headCheckpointIds: [keptHead.checkpoint.checkpointId],
    });
    expect(splitList.items.find((item) => item.sessionId === split.newSessionId)).toMatchObject({
      forked: false,
      headCheckpointIds: [split.checkpoint.checkpointId],
    });
    expect(split.checkpoint.splitFromCheckpointId).toBe(revivedHead.checkpoint.checkpointId);

    await pushSessionVault(context.machineA);
    await pullSessionVault(context.machineB);
    const synchronizedSplit = await listSessionVaultSessions({}, context.machineB);
    expect(synchronizedSplit.total).toBe(2);
    expect(synchronizedSplit.items.every((item) => !item.forked)).toBe(true);
    expect(await git(context.machineB.vaultPath, ['status', '--porcelain'])).toBe('');
  });

  it('surfaces concurrent opposite head selections as a fork and lets a later resolution converge both machines', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const rootCheckpoint = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const machineAHead = await captureCheckpoint(
      checkpointInput(context.machineA.vaultPath, 2, [rootCheckpoint.checkpoint.checkpointId]),
    );
    const machineBHead = await captureCheckpoint(
      checkpointInput(context.machineB.vaultPath, 3, [rootCheckpoint.checkpoint.checkpointId]),
    );
    await pushSessionVault(context.machineA);
    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);

    const forkOnA = (await listSessionVaultSessions({}, context.machineA)).items[0]!;
    const forkOnB = (await listSessionVaultSessions({}, context.machineB)).items[0]!;
    expect(new Set(forkOnA.headCheckpointIds)).toEqual(new Set(forkOnB.headCheckpointIds));

    const resolutionA = await selectSessionForkHead(
      forkOnA.sessionId,
      {
        expectedHeadCheckpointIds: forkOnA.headCheckpointIds,
        selectedHeadCheckpointId: machineAHead.checkpoint.checkpointId,
      },
      { ...context.machineA, machine: 'synthetic-resolution-a' },
    );
    const resolutionB = await selectSessionForkHead(
      forkOnB.sessionId,
      {
        expectedHeadCheckpointIds: forkOnB.headCheckpointIds,
        selectedHeadCheckpointId: machineBHead.checkpoint.checkpointId,
      },
      { ...context.machineB, machine: 'synthetic-resolution-b' },
    );
    expect(resolutionA.event.expectedResolutionVersion).toBeNull();
    expect(resolutionB.event.expectedResolutionVersion).toBeNull();
    expect((await listSessionVaultSessions({}, context.machineA)).items[0]!.headCheckpointIds).toEqual([
      machineAHead.checkpoint.checkpointId,
    ]);
    expect((await listSessionVaultSessions({}, context.machineB)).items[0]!.headCheckpointIds).toEqual([
      machineBHead.checkpoint.checkpointId,
    ]);

    await pushSessionVault(context.machineA);
    await pushSessionVault(context.machineB);
    const conflictedOnB = (await listSessionVaultSessions({}, context.machineB)).items[0]!;
    expect(conflictedOnB.forked).toBe(true);
    expect(new Set(conflictedOnB.headCheckpointIds)).toEqual(new Set([
      machineAHead.checkpoint.checkpointId,
      machineBHead.checkpoint.checkpointId,
    ]));
    await expect(sessionVaultCheckpointPayload(conflictedOnB.sessionId, null, context.machineB)).rejects.toThrow(
      '先明确选择一个 head checkpoint',
    );
    expect(await git(context.machineB.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(await git(context.machineB.vaultPath, ['ls-files', '-u'])).toBe('');

    await pullSessionVault(context.machineA);
    const conflictedOnA = (await listSessionVaultSessions({}, context.machineA)).items[0]!;
    expect(new Set(conflictedOnA.headCheckpointIds)).toEqual(new Set(conflictedOnB.headCheckpointIds));

    const converged = await selectSessionForkHead(
      conflictedOnB.sessionId,
      {
        expectedHeadCheckpointIds: conflictedOnB.headCheckpointIds,
        selectedHeadCheckpointId: machineAHead.checkpoint.checkpointId,
      },
      { ...context.machineB, machine: 'synthetic-resolution-final' },
    );
    expect(converged.event.expectedResolutionVersion).toBe(resolutionB.event.eventId);
    expect((await listSessionVaultSessions({}, context.machineB)).items[0]).toMatchObject({
      forked: false,
      headCheckpointIds: [machineAHead.checkpoint.checkpointId],
    });
    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    expect((await listSessionVaultSessions({}, context.machineA)).items[0]).toMatchObject({
      forked: false,
      headCheckpointIds: [machineAHead.checkpoint.checkpointId],
    });
  });

  it('keeps pin, archive, trash, and restore lifecycle state identical across two isolated Vaults', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const pinned = await mutateSessionLifecycle('fleet:synthetic-session-sync', 'pin', null, {
      ...context.machineA,
      machine: 'synthetic-machine-a',
      auditDirectory: path.join(context.root, 'machine-a', 'operations'),
      now: new Date('2026-07-28T10:00:00.000Z'),
    });
    await pushSessionVault(context.machineA);
    await pullSessionVault(context.machineB);
    expect((await listSessionVaultSessions({}, context.machineB)).items[0]).toMatchObject({
      pinned: true,
      lifecycleState: 'active',
      lifecycleVersion: pinned.event.eventId,
    });

    const archived = await mutateSessionLifecycle('fleet:synthetic-session-sync', 'archive', pinned.event.eventId, {
      ...context.machineB,
      machine: 'synthetic-machine-b',
      auditDirectory: path.join(context.root, 'machine-b', 'operations'),
      now: new Date('2026-07-28T11:00:00.000Z'),
    });
    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    expect(await listSessionVaultSessions({}, context.machineA)).toMatchObject({
      total: 0,
      counts: { active: 0, archived: 1, all: 1 },
    });
    expect((await listSessionVaultSessions({ lifecycle: 'all' }, context.machineA)).items[0]).toMatchObject({
      pinned: true,
      lifecycleState: 'archived',
      lifecycleVersion: archived.event.eventId,
    });

    const trashed = await mutateSessionLifecycle('fleet:synthetic-session-sync', 'trash', archived.event.eventId, {
      ...context.machineA,
      machine: 'synthetic-machine-a',
      auditDirectory: path.join(context.root, 'machine-a', 'operations'),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    await pushSessionVault(context.machineA);
    await pullSessionVault(context.machineB);
    expect(await listSessionVaultSessions({ lifecycle: 'trashed' }, context.machineB)).toMatchObject({
      total: 1,
      counts: { active: 0, archived: 0, trashed: 1, all: 1 },
      items: [{
        pinned: true,
        lifecycleState: 'trashed',
        lifecycleVersion: trashed.event.eventId,
        retentionUntil: '2026-08-27T12:00:00.000Z',
        payloadState: 'available',
      }],
    });

    const restored = await mutateSessionLifecycle('fleet:synthetic-session-sync', 'untrash', trashed.event.eventId, {
      ...context.machineB,
      machine: 'synthetic-machine-b',
      auditDirectory: path.join(context.root, 'machine-b', 'operations'),
      now: new Date('2026-07-28T13:00:00.000Z'),
    });
    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    expect((await listSessionVaultSessions({ lifecycle: 'archived' }, context.machineA)).items[0]).toMatchObject({
      pinned: true,
      lifecycleState: 'archived',
      lifecycleVersion: restored.event.eventId,
      retentionUntil: null,
      payloadState: 'available',
    });
  });

  it('surfaces an old-device checkpoint after trash and lets the user save it as a new synchronized session', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const root = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const trashed = await mutateSessionLifecycle('fleet:synthetic-session-sync', 'trash', null, {
      ...context.machineB,
      machine: 'synthetic-machine-b',
      trashRetentionDays: 1,
      now: new Date('2026-07-01T08:00:00.000Z'),
    });
    await pushSessionVault(context.machineB);

    const oldDeviceCheckpoint = await captureCheckpoint(
      checkpointInput(context.machineA.vaultPath, 2, [root.checkpoint.checkpointId]),
    );
    await pushSessionVault(context.machineA);
    await pullSessionVault(context.machineB);

    const conflicted = (await listSessionVaultSessions({ lifecycle: 'trashed' }, context.machineB)).items[0]!;
    expect(conflicted).toMatchObject({
      lifecycleState: 'trashed',
      lifecycleVersion: trashed.event.eventId,
      deletionConflict: true,
      deletionConflictCheckpointIds: [oldDeviceCheckpoint.checkpoint.checkpointId],
      payloadState: 'available',
    });
    const blockedCleanup = await previewSessionTrashEmpty({
      ...context.machineB,
      now: new Date('2026-07-03T08:00:00.000Z'),
    });
    expect(blockedCleanup).toMatchObject({
      canEmpty: false,
      deletionConflictSessions: 1,
      eligibleSessions: 0,
      removableObjects: 0,
    });
    expect(blockedCleanup.blockers.join('\n')).toContain('已删除会话产生了新内容');

    const saved = await saveSessionDeletionConflictAsNew(
      conflicted.sessionId,
      {
        expectedLifecycleVersion: conflicted.lifecycleVersion!,
        expectedConflictCheckpointIds: conflicted.deletionConflictCheckpointIds,
        sourceCheckpointId: oldDeviceCheckpoint.checkpoint.checkpointId,
        summary: {
          goal: 'Continue the synthetic old-device work as a new session',
          completed: ['Reviewed the deletion conflict'],
          decisions: ['Keep the original logical session in trash'],
          nextSteps: ['Continue the copied synthetic checkpoint independently'],
          blockers: [],
          commands: [],
          risks: [],
          source: 'manual',
          reviewedAt: '2026-07-28T03:00:00.000Z',
        },
      },
      {
        ...context.machineB,
        machine: 'synthetic-conflict-resolver',
        auditDirectory: path.join(context.root, 'machine-b', 'operations'),
        now: new Date('2026-07-28T03:00:00.000Z'),
      },
    );
    expect(saved).toMatchObject({
      checkpoint: { splitFromCheckpointId: oldDeviceCheckpoint.checkpoint.checkpointId },
      resolution: { event: { action: 'resolve-trash-conflict' }, auditRecorded: true },
    });
    expect((await listSessionVaultSessions({ lifecycle: 'trashed' }, context.machineB)).items[0]).toMatchObject({
      lifecycleState: 'trashed',
      deletionConflict: false,
      deletionConflictCheckpointIds: [],
      lifecycleVersion: saved.resolution.event.eventId,
    });
    expect((await listSessionVaultSessions({}, context.machineB)).items[0]).toMatchObject({
      sessionId: saved.newSessionId,
      lifecycleState: 'active',
      forked: false,
      headCheckpointIds: [saved.checkpoint.checkpointId],
    });

    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    const synchronized = await listSessionVaultSessions({ lifecycle: 'all' }, context.machineA);
    expect(synchronized.total).toBe(2);
    expect(synchronized.items.find((item) => item.sessionId === conflicted.sessionId)).toMatchObject({
      lifecycleState: 'trashed',
      deletionConflict: false,
    });
    expect(synchronized.items.find((item) => item.sessionId === saved.newSessionId)).toMatchObject({
      lifecycleState: 'active',
      latestCheckpointId: saved.checkpoint.checkpointId,
    });
    expect(await previewSessionTrashEmpty({
      ...context.machineA,
      now: new Date('2026-07-03T08:00:00.000Z'),
    })).toMatchObject({ canEmpty: true, deletionConflictSessions: 0, eligibleSessions: 1 });
  });

  it('lets the user explicitly restore a trashed session after an old device adds a checkpoint and converges both machines', async () => {
    const context = await fixture();
    await initializeMachine(context.machineA, context.remotePath);
    const root = await captureCheckpoint(checkpointInput(context.machineA.vaultPath, 1));
    await pushSessionVault(context.machineA);
    await initializeMachine(context.machineB, context.remotePath);
    await pullSessionVault(context.machineB);

    const trashed = await mutateSessionLifecycle('fleet:synthetic-session-sync', 'trash', null, {
      ...context.machineB,
      machine: 'synthetic-machine-b',
      now: new Date('2026-07-28T08:00:00.000Z'),
    });
    await pushSessionVault(context.machineB);
    const oldDeviceCheckpoint = await captureCheckpoint(
      checkpointInput(context.machineA.vaultPath, 2, [root.checkpoint.checkpointId]),
    );
    await pushSessionVault(context.machineA);
    await pullSessionVault(context.machineB);

    expect((await listSessionVaultSessions({ lifecycle: 'trashed' }, context.machineB)).items[0]).toMatchObject({
      lifecycleState: 'trashed',
      deletionConflict: true,
      deletionConflictCheckpointIds: [oldDeviceCheckpoint.checkpoint.checkpointId],
    });
    const restored = await mutateSessionLifecycle(
      'fleet:synthetic-session-sync',
      'untrash',
      trashed.event.eventId,
      {
        ...context.machineB,
        machine: 'synthetic-machine-b',
        auditDirectory: path.join(context.root, 'machine-b', 'operations'),
        now: new Date('2026-07-28T09:00:00.000Z'),
      },
    );
    expect((await listSessionVaultSessions({}, context.machineB)).items[0]).toMatchObject({
      lifecycleState: 'active',
      lifecycleVersion: restored.event.eventId,
      deletionConflict: false,
      deletionConflictCheckpointIds: [],
      latestCheckpointId: oldDeviceCheckpoint.checkpoint.checkpointId,
    });

    await pushSessionVault(context.machineB);
    await pullSessionVault(context.machineA);
    expect((await listSessionVaultSessions({}, context.machineA)).items[0]).toMatchObject({
      lifecycleState: 'active',
      lifecycleVersion: restored.event.eventId,
      deletionConflict: false,
      latestCheckpointId: oldDeviceCheckpoint.checkpoint.checkpointId,
    });
    expect(await git(context.machineA.vaultPath, ['status', '--porcelain'])).toBe('');
    expect(await git(context.machineB.vaultPath, ['status', '--porcelain'])).toBe('');
  });
});
