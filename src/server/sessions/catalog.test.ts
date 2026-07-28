import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checkpoint, LifecycleEvent, WorkspaceSnapshot } from '../../shared/sessions.js';
import {
  listSessionVaultSessions,
  SessionCatalogError,
  sessionVaultSessionDetail,
  type SessionCatalogOptions,
} from './catalog.js';
import { initializeSessionVault } from './vault.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

async function fixture(): Promise<SessionCatalogOptions & { root: string; vaultPath: string; indexPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-session-catalog-'));
  temporaryDirectories.push(root);
  const fleetPath = path.join(root, 'fleet-source');
  const vaultPath = path.join(root, 'private-vault');
  const indexPath = path.join(root, 'fleet-home', 'cache', 'session-vault-index.json');
  await git(root, ['init', '--initial-branch=main', fleetPath]);
  const options = {
    root,
    vaultPath,
    indexPath,
    fleetRepositoryPath: fleetPath,
    bindingPath: path.join(root, 'fleet-home', 'config', 'session-vault.yaml'),
    statePath: path.join(root, 'fleet-home', 'config', 'session-vault-sync.json'),
  };
  await initializeSessionVault({ vaultPath }, options);
  return options;
}

function syntheticWorkspace(index: number): WorkspaceSnapshot {
  return {
    projectId: `remote:synthetic-project-${index}`,
    repositoryId: `synthetic-repository-${index}`,
    branch: `feature/synthetic-${index}`,
    head: (index % 16).toString(16).repeat(40),
    dirty: false,
    changedFiles: 0,
    stagedFiles: 0,
    modifiedFiles: 0,
    deletedFiles: 0,
    renamedFiles: 0,
    untrackedFiles: 0,
  };
}

async function writeSyntheticCheckpoint(
  vaultPath: string,
  index: number,
  title = `Synthetic session ${index}`,
): Promise<Checkpoint> {
  const checkpointId = index.toString(16).padStart(64, '0');
  const eventId = `synthetic-event-${index.toString().padStart(4, '0')}`;
  const createdAt = new Date(Date.parse('2026-07-28T00:00:00.000Z') + index * 1_000).toISOString();
  const workspace = syntheticWorkspace(index);
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    eventType: 'checkpoint',
    eventId,
    checkpointId,
    parentCheckpointIds: [],
    resumedFromCheckpointId: null,
    sessionId: `fleet:synthetic-session-${index}`,
    provider: index % 2 === 0 ? 'codex' : 'claude',
    providerSessionId: `synthetic-provider-session-${index}`,
    title,
    projectId: workspace.projectId,
    repositoryId: workspace.repositoryId,
    branch: workspace.branch,
    head: workspace.head,
    machine: index % 2 === 0 ? 'synthetic-home' : 'synthetic-office',
    createdAt,
    payloadPath: `objects/${checkpointId}`,
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: index % 3 !== 0,
      wipRef: null,
      sourceSync: null,
    },
  };
  const objectPath = path.join(vaultPath, checkpoint.payloadPath);
  const eventPath = path.join(vaultPath, 'events', 'synthetic-machine', `${eventId}.json`);
  await Promise.all([
    mkdir(objectPath, { recursive: true }),
    mkdir(path.dirname(eventPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(objectPath, 'handoff.md'), `# AI 会话交接\n\n## 目标\n\nContinue synthetic session ${index}\n`),
    writeFile(path.join(objectPath, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`),
    writeFile(path.join(objectPath, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, createdAt }, null, 2)}\n`),
    writeFile(eventPath, `${JSON.stringify(checkpoint, null, 2)}\n`),
  ]);
  return checkpoint;
}

async function commitCatalog(vaultPath: string): Promise<string> {
  await git(vaultPath, ['add', '--', '.gitignore', 'vault.yaml', 'events', 'objects']);
  await git(vaultPath, [
    '-c',
    'user.name=Synthetic Catalog',
    '-c',
    'user.email=synthetic@example.test',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'synthetic catalog',
  ]);
  return git(vaultPath, ['rev-parse', 'HEAD']);
}

async function writeSyntheticLifecycle(
  vaultPath: string,
  event: LifecycleEvent,
  machineDirectory: string,
): Promise<void> {
  const eventPath = path.join(vaultPath, 'events', machineDirectory, `${event.eventId}.json`);
  await mkdir(path.dirname(eventPath), { recursive: true });
  await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session Vault local catalog', () => {
  it('rebuilds a paginated index for 205 sessions and reads detail payloads from tracked Git blobs', async () => {
    const context = await fixture();
    for (let index = 1; index <= 205; index += 1) {
      await writeSyntheticCheckpoint(context.vaultPath, index);
    }
    await commitCatalog(context.vaultPath);

    const firstPage = await listSessionVaultSessions({ page: 1, pageSize: 50 }, context);
    expect(firstPage).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 205,
      totalPages: 5,
      sync: { state: 'local-only', pendingLocal: true },
    });
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items[0]).toMatchObject({
      sessionId: 'fleet:synthetic-session-205',
      checkpointCount: 1,
      forked: false,
    });
    const lastPage = await listSessionVaultSessions({ page: 5, pageSize: 50 }, context);
    expect(lastPage.items).toHaveLength(5);
    expect((await listSessionVaultSessions({ search: 'session 137' }, context)).items).toHaveLength(1);
    await expect(access(context.indexPath)).resolves.toBeUndefined();

    const detail = await sessionVaultSessionDetail(firstPage.items[0]!.sessionId, context);
    expect(detail.checkpoints).toHaveLength(1);
    expect(detail.latestHandoffMarkdown).toContain('Continue synthetic session 205');
    expect(detail.latestWorkspace).toMatchObject({ branch: 'feature/synthetic-205', dirty: false });
  }, 20_000);

  it('refuses to index a tracked remote event containing a synthetic secret without echoing it', async () => {
    const context = await fixture();
    const fakeAwsKey = `AKIA${'Z'.repeat(16)}`;
    await writeSyntheticCheckpoint(context.vaultPath, 1, `Synthetic unsafe ${fakeAwsKey}`);
    await commitCatalog(context.vaultPath);

    let thrown: unknown;
    try {
      await listSessionVaultSessions({}, context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionCatalogError);
    expect((thrown as Error).message).toContain('aws-access-key');
    expect((thrown as Error).message).not.toContain(fakeAwsKey);
  });

  it('replays lifecycle changes in Vault Git history order and rejects an invalid repeated transition', async () => {
    const context = await fixture();
    const checkpoint = await writeSyntheticCheckpoint(context.vaultPath, 1);
    await commitCatalog(context.vaultPath);
    await writeSyntheticLifecycle(context.vaultPath, {
      schemaVersion: 1,
      eventType: 'lifecycle',
      eventId: 'z-archive-event',
      sessionId: checkpoint.sessionId,
      action: 'archive',
      machine: 'synthetic-office',
      createdAt: '2026-07-28T12:00:00.000Z',
      retentionUntil: null,
      reason: null,
    }, 'z-machine');
    await commitCatalog(context.vaultPath);
    await writeSyntheticLifecycle(context.vaultPath, {
      schemaVersion: 1,
      eventType: 'lifecycle',
      eventId: 'a-restore-event',
      sessionId: checkpoint.sessionId,
      action: 'restore',
      machine: 'synthetic-home',
      createdAt: '2026-07-28T11:00:00.000Z',
      retentionUntil: null,
      reason: null,
    }, 'a-machine');
    await commitCatalog(context.vaultPath);

    const active = await listSessionVaultSessions({}, context);
    expect(active.items[0]).toMatchObject({
      lifecycleState: 'active',
      lifecycleVersion: 'a-restore-event',
    });

    await writeSyntheticLifecycle(context.vaultPath, {
      schemaVersion: 1,
      eventType: 'lifecycle',
      eventId: 'pin-event-one',
      sessionId: checkpoint.sessionId,
      action: 'pin',
      machine: 'synthetic-home',
      createdAt: '2026-07-28T13:00:00.000Z',
      retentionUntil: null,
      reason: null,
    }, 'pin-machine');
    await commitCatalog(context.vaultPath);
    await writeSyntheticLifecycle(context.vaultPath, {
      schemaVersion: 1,
      eventType: 'lifecycle',
      eventId: 'pin-event-two',
      sessionId: checkpoint.sessionId,
      action: 'pin',
      machine: 'synthetic-home',
      createdAt: '2026-07-28T14:00:00.000Z',
      retentionUntil: null,
      reason: null,
    }, 'pin-machine');
    await commitCatalog(context.vaultPath);

    await expect(listSessionVaultSessions({ lifecycle: 'all' }, context)).rejects.toThrow('生命周期事件顺序非法');
  });
});
