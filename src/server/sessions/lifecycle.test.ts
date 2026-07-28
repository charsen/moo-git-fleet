import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureCheckpointInput } from './checkpoint.js';
import { captureCheckpoint } from './checkpoint.js';
import { listSessionVaultSessions, sessionVaultSessionDetail } from './catalog.js';
import {
  emptySessionTrash,
  mutateSessionLifecycle,
  previewSessionTrashEmpty,
  recoverLifecycleTransactions,
  SimulatedLifecycleInterruption,
  type SessionLifecycleOptions,
} from './lifecycle.js';
import {
  initializeSessionVault,
  SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
} from './vault.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

async function fixture(
  input: { remote?: boolean } = {},
): Promise<SessionLifecycleOptions & {
  root: string;
  vaultPath: string;
  sessionId: string;
  indexPath: string;
  remotePath: string | null;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-lifecycle-'));
  temporaryDirectories.push(root);
  const fleetRepositoryPath = path.join(root, 'fleet-source');
  const vaultPath = path.join(root, 'private-vault');
  const remotePath = input.remote ? path.join(root, 'private-vault-remote.git') : null;
  const sessionId = 'fleet:/synthetic/private/session-id';
  await git(root, ['init', '--initial-branch=main', fleetRepositoryPath]);
  if (remotePath) await git(root, ['init', '--bare', remotePath]);
  const options = {
    fleetRepositoryPath,
    bindingPath: path.join(root, 'fleet-home', 'config', 'session-vault.yaml'),
    statePath: path.join(root, 'fleet-home', 'config', 'session-vault-sync.json'),
    indexPath: path.join(root, 'fleet-home', 'cache', 'session-index.json'),
    auditDirectory: path.join(root, 'fleet-home', '.data', 'operations'),
    vaultPath,
    sessionId,
    machine: 'synthetic-lifecycle-machine',
  };
  await initializeSessionVault(
    remotePath
      ? {
          vaultPath,
          remoteUrl: remotePath,
          enableRemoteSync: true,
          confirmationPhrase: SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
        }
      : { vaultPath },
    options,
  );
  const checkpointInput: CaptureCheckpointInput = {
    vaultPath,
    sessionId,
    session: {
      provider: 'codex',
      providerSessionId: '99999999-9999-4999-8999-999999999999',
      projectId: 'remote:synthetic-lifecycle-project',
      repositoryId: 'synthetic-lifecycle-project',
      repositoryName: 'Synthetic Lifecycle Project',
      title: 'Synthetic lifecycle handoff',
    },
    summary: {
      goal: 'Exercise synthetic lifecycle management',
      completed: [],
      decisions: [],
      nextSteps: ['Pin and archive the synthetic session'],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: '2026-07-28T08:00:00.000Z',
    },
    workspace: {
      projectId: 'remote:synthetic-lifecycle-project',
      repositoryId: 'synthetic-lifecycle-project',
      branch: 'feature/lifecycle',
      head: '9'.repeat(40),
      dirty: false,
      changedFiles: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      untrackedFiles: 0,
    },
    machine: 'synthetic-lifecycle-machine',
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync: null,
    },
    now: new Date('2026-07-28T08:00:00.000Z'),
  };
  await captureCheckpoint(checkpointInput);
  if (remotePath) await git(vaultPath, ['push', '--set-upstream', 'origin', 'main']);
  return { ...options, root, remotePath };
}

async function publishRemoteChange(
  context: Awaited<ReturnType<typeof fixture>>,
  name: string,
): Promise<void> {
  if (!context.remotePath) throw new Error('Synthetic remote fixture is not configured');
  const writerPath = path.join(context.root, `remote-writer-${name}`);
  await git(context.root, ['clone', '--branch', 'main', context.remotePath, writerPath]);
  await git(writerPath, ['config', 'user.name', 'Synthetic Remote Writer']);
  await git(writerPath, ['config', 'user.email', 'synthetic-remote@example.test']);
  await writeFile(path.join(writerPath, `${name}.txt`), `synthetic remote change: ${name}\n`);
  await git(writerPath, ['add', '--', `${name}.txt`]);
  await git(writerPath, ['commit', '-m', `synthetic remote change: ${name}`]);
  await git(writerPath, ['push', 'origin', 'main']);
  await git(context.vaultPath, ['fetch', 'origin']);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session Vault lifecycle mutations', () => {
  it('pins, archives and restores through immutable events with stale-state protection', async () => {
    const context = await fixture();
    const pinned = await mutateSessionLifecycle(context.sessionId, 'pin', null, {
      ...context,
      now: new Date('2026-07-28T09:00:00.000Z'),
    });
    expect(pinned).toMatchObject({ event: { action: 'pin', reason: null, retentionUntil: null } });
    await expect(
      mutateSessionLifecycle(context.sessionId, 'archive', null, context),
    ).rejects.toMatchObject({ code: 'stale-lifecycle-state' });
    await expect(
      mutateSessionLifecycle(context.sessionId, 'pin', pinned.event.eventId, context),
    ).rejects.toMatchObject({ code: 'invalid-transition' });

    const archived = await mutateSessionLifecycle(context.sessionId, 'archive', pinned.event.eventId, {
      ...context,
      now: new Date('2026-07-28T10:00:00.000Z'),
    });
    const activeList = await listSessionVaultSessions({}, context);
    expect(activeList).toMatchObject({ total: 0, counts: { active: 0, archived: 1, all: 1 } });
    const archivedList = await listSessionVaultSessions({ lifecycle: 'archived' }, context);
    expect(archivedList.items[0]).toMatchObject({
      sessionId: context.sessionId,
      pinned: true,
      lifecycleState: 'archived',
      lifecycleVersion: archived.event.eventId,
    });
    expect((await listSessionVaultSessions({ lifecycle: 'all' }, context)).total).toBe(1);

    await mutateSessionLifecycle(context.sessionId, 'restore', archived.event.eventId, {
      ...context,
      now: new Date('2026-07-28T11:00:00.000Z'),
    });
    expect((await listSessionVaultSessions({}, context)).items[0]).toMatchObject({
      pinned: true,
      lifecycleState: 'active',
    });
  });

  it('moves active or archived sessions to a 30-day trash state and restores the prior lifecycle state', async () => {
    const context = await fixture();
    const archived = await mutateSessionLifecycle(context.sessionId, 'archive', null, {
      ...context,
      now: new Date('2026-07-28T09:00:00.000Z'),
    });
    const trashed = await mutateSessionLifecycle(context.sessionId, 'trash', archived.event.eventId, {
      ...context,
      now: new Date('2026-07-28T10:00:00.000Z'),
    });
    expect(trashed.event).toMatchObject({
      action: 'trash',
      retentionUntil: '2026-08-27T10:00:00.000Z',
      reason: '用户手动移入废纸篓',
    });
    expect(await listSessionVaultSessions({}, context)).toMatchObject({
      total: 0,
      counts: { active: 0, archived: 0, trashed: 1, all: 1 },
    });
    const trash = await listSessionVaultSessions({ lifecycle: 'trashed' }, context);
    expect(trash.items[0]).toMatchObject({
      lifecycleState: 'trashed',
      retentionUntil: trashed.event.retentionUntil,
      payloadState: 'available',
    });
    expect(trash.items[0]!.payloadBytes).toBeGreaterThan(0);

    const restored = await mutateSessionLifecycle(context.sessionId, 'untrash', trashed.event.eventId, {
      ...context,
      now: new Date('2026-07-28T11:00:00.000Z'),
    });
    expect(restored.event).toMatchObject({ action: 'untrash', retentionUntil: null });
    expect((await listSessionVaultSessions({ lifecycle: 'archived' }, context)).items[0]).toMatchObject({
      lifecycleState: 'archived',
      retentionUntil: null,
    });
  });

  it('previews and atomically removes only expired trash payloads while keeping lifecycle metadata', async () => {
    const context = await fixture();
    const trashed = await mutateSessionLifecycle(context.sessionId, 'trash', null, {
      ...context,
      trashRetentionDays: 1,
      now: new Date('2026-07-01T08:00:00.000Z'),
    });
    const cleanupOptions = { ...context, now: new Date('2026-07-03T08:00:00.000Z') };
    const preview = await previewSessionTrashEmpty(cleanupOptions);
    expect(preview).toMatchObject({
      totalTrashed: 1,
      eligibleSessions: 1,
      removableObjects: 1,
      canEmpty: true,
      blockers: [],
    });
    expect(preview.removableBytes).toBeGreaterThan(0);
    const objectPath = path.join(
      context.vaultPath,
      'objects',
      (await listSessionVaultSessions({ lifecycle: 'trashed' }, context)).items[0]!.latestCheckpointId,
    );

    const result = await emptySessionTrash({
      expectedFingerprint: preview.fingerprint,
      acknowledgeGitHistoryRetention: true,
    }, cleanupOptions);
    expect(result).toMatchObject({ removedSessions: 1, removedObjects: 1, auditRecorded: true });
    await expect(access(objectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const trash = await listSessionVaultSessions({ lifecycle: 'trashed' }, context);
    expect(trash.items[0]).toMatchObject({
      lifecycleState: 'trashed',
      lifecycleVersion: trashed.event.eventId,
      payloadState: 'purged',
      payloadBytes: 0,
    });
    const detail = await sessionVaultSessionDetail(context.sessionId, context);
    expect(detail).toMatchObject({ latestHandoffMarkdown: null, latestWorkspace: null });
    await expect(
      mutateSessionLifecycle(context.sessionId, 'untrash', trashed.event.eventId, context),
    ).rejects.toMatchObject({ code: 'invalid-transition', message: expect.stringContaining('已经清理') });
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
  });

  it('restores removed payloads and HEAD when an empty-trash transaction fails before commit', async () => {
    const context = await fixture();
    await mutateSessionLifecycle(context.sessionId, 'trash', null, {
      ...context,
      trashRetentionDays: 1,
      now: new Date('2026-07-01T08:00:00.000Z'),
    });
    const cleanupOptions = { ...context, now: new Date('2026-07-03T08:00:00.000Z') };
    const preview = await previewSessionTrashEmpty(cleanupOptions);
    const originalHead = await git(context.vaultPath, ['rev-parse', 'HEAD']);
    await expect(emptySessionTrash({
      expectedFingerprint: preview.fingerprint,
      acknowledgeGitHistoryRetention: true,
    }, {
      ...cleanupOptions,
      testHook: (phase) => {
        if (phase === 'after-trash-index-stage') throw new Error('Synthetic trash empty failure');
      },
    })).rejects.toThrow('Synthetic trash empty failure');
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
    expect((await listSessionVaultSessions({ lifecycle: 'trashed' }, context)).items[0]).toMatchObject({
      payloadState: 'available',
    });
  });

  it('recovers an interrupted empty-trash transaction after restart without losing payloads', async () => {
    const context = await fixture();
    await mutateSessionLifecycle(context.sessionId, 'trash', null, {
      ...context,
      trashRetentionDays: 1,
      now: new Date('2026-07-01T08:00:00.000Z'),
    });
    const cleanupOptions = { ...context, now: new Date('2026-07-03T08:00:00.000Z') };
    const preview = await previewSessionTrashEmpty(cleanupOptions);
    const originalHead = await git(context.vaultPath, ['rev-parse', 'HEAD']);

    await expect(emptySessionTrash({
      expectedFingerprint: preview.fingerprint,
      acknowledgeGitHistoryRetention: true,
    }, {
      ...cleanupOptions,
      testHook: (phase) => {
        if (phase === 'after-trash-index-stage') throw new SimulatedLifecycleInterruption();
      },
    })).rejects.toBeInstanceOf(SimulatedLifecycleInterruption);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).not.toBe('');
    expect(await recoverLifecycleTransactions(context.vaultPath)).toHaveLength(1);
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
    expect((await listSessionVaultSessions({ lifecycle: 'trashed' }, context)).items[0]).toMatchObject({
      payloadState: 'available',
    });
  });

  it('blocks emptying remote-backed trash until its deletion event is pushed', async () => {
    const context = await fixture({ remote: true });
    await mutateSessionLifecycle(context.sessionId, 'trash', null, {
      ...context,
      trashRetentionDays: 1,
      now: new Date('2026-07-01T08:00:00.000Z'),
    });
    const preview = await previewSessionTrashEmpty({ ...context, now: new Date('2026-07-03T08:00:00.000Z') });
    expect(preview).toMatchObject({ canEmpty: false, eligibleSessions: 1 });
    expect(preview.blockers.join('\n')).toContain('尚未 Push');
  });

  it('rolls back a normal write failure and recovers an interrupted staged event without moving HEAD', async () => {
    const context = await fixture();
    const originalHead = await git(context.vaultPath, ['rev-parse', 'HEAD']);
    await expect(mutateSessionLifecycle(context.sessionId, 'archive', null, {
      ...context,
      testHook: (phase) => {
        if (phase === 'after-index-stage') throw new Error('Synthetic lifecycle write failure');
      },
    })).rejects.toThrow('Synthetic lifecycle write failure');
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
    expect((await listSessionVaultSessions({}, context)).total).toBe(1);

    await expect(mutateSessionLifecycle(context.sessionId, 'archive', null, {
      ...context,
      testHook: (phase) => {
        if (phase === 'after-index-stage') throw new SimulatedLifecycleInterruption();
      },
    })).rejects.toBeInstanceOf(SimulatedLifecycleInterruption);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).not.toBe('');
    expect(await recoverLifecycleTransactions(context.vaultPath)).toHaveLength(1);
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
  });

  it('writes only hashed session identity and bounded technical results to the local audit log', async () => {
    const context = await fixture();
    await mutateSessionLifecycle(context.sessionId, 'archive', null, context);
    const files = await readdir(context.auditDirectory!);
    const contents = (await Promise.all(files.map((file) => readFile(path.join(context.auditDirectory!, file), 'utf8')))).join('\n');
    expect(contents).toContain('session-lifecycle');
    expect(contents).toContain('"result":"success"');
    expect(contents).toContain('"action":"archive"');
    expect(contents).not.toContain(context.sessionId);
    expect(contents).not.toContain('Synthetic lifecycle handoff');
    expect(contents).not.toContain('Exercise synthetic lifecycle management');
    expect(contents).not.toContain(context.vaultPath);
  });

  it('returns a committed warning instead of a retryable failure when the audit log cannot be written', async () => {
    const context = await fixture();
    const auditBlocker = path.join(context.root, 'audit-blocker');
    await writeFile(auditBlocker, 'not a directory\n');

    const result = await mutateSessionLifecycle(context.sessionId, 'pin', null, {
      ...context,
      auditDirectory: auditBlocker,
    });
    expect(result).toMatchObject({
      auditRecorded: false,
      event: { action: 'pin' },
      message: expect.stringContaining('生命周期事件已保存到本机 Vault；但本地审计日志写入失败'),
    });
    expect((await listSessionVaultSessions({}, context)).items[0]).toMatchObject({
      pinned: true,
      lifecycleVersion: result.event.eventId,
    });
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(result.commitHash);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
  });

  it('rejects a lifecycle write when the known remote-tracking branch is ahead', async () => {
    const context = await fixture({ remote: true });
    const originalHead = await git(context.vaultPath, ['rev-parse', 'HEAD']);
    await publishRemoteChange(context, 'remote-ahead');

    await expect(
      mutateSessionLifecycle(context.sessionId, 'pin', null, context),
    ).rejects.toMatchObject({
      code: 'remote-update-required',
      message: 'Session Vault 已知远端有新提交，请先拉取更新后再管理会话',
    });
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
  });

  it('rejects a lifecycle write when local and known remote-tracking history have diverged', async () => {
    const context = await fixture({ remote: true });
    const pinned = await mutateSessionLifecycle(context.sessionId, 'pin', null, context);
    const localHead = await git(context.vaultPath, ['rev-parse', 'HEAD']);
    await publishRemoteChange(context, 'diverged');

    await expect(
      mutateSessionLifecycle(context.sessionId, 'archive', pinned.event.eventId, context),
    ).rejects.toMatchObject({
      code: 'remote-update-required',
      message: 'Session Vault 本机与已知远端已经分叉，请先解决同步状态后再管理会话',
    });
    expect(await git(context.vaultPath, ['rev-parse', 'HEAD'])).toBe(localHead);
    expect(await git(context.vaultPath, ['status', '--porcelain'])).toBe('');
  });
});
