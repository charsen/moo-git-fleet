import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCapabilities } from '../../shared/sessions.js';
import { checkpointSchema, discoveredSessionSchema } from '../../shared/sessions.js';
import { encodeClaudeProjectPath } from './discovery.js';
import { captureNativeCapsule, type NativeProviderFileAccess } from './native-capsule.js';
import { inspectNativeRestore } from './native-restore.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function capabilities(provider: 'claude' | 'codex', version = `${provider} 9.9.9-synthetic`): ProviderCapabilities {
  return {
    schemaVersion: 1,
    provider,
    state: 'supported',
    command: provider,
    commandPath: `/synthetic/bin/${provider}`,
    realBinaryPath: `/synthetic/bin/${provider}-real`,
    shimChain: [`/synthetic/bin/${provider}`, `/synthetic/bin/${provider}-real`],
    version,
    helpSignature: 'synthetic resume help',
    nativeResume: true,
    forkResume: provider === 'claude',
    checkedAt: '2026-07-28T10:00:00.000Z',
    reason: null,
  };
}

function checkpoint(provider: 'claude' | 'codex', providerSessionId: string) {
  return checkpointSchema.parse({
    schemaVersion: 1,
    eventType: 'checkpoint',
    eventId: 'synthetic-event',
    checkpointId: 'a'.repeat(64),
    parentCheckpointIds: [],
    resumedFromCheckpointId: null,
    sessionId: 'fleet:synthetic-native',
    provider,
    providerSessionId,
    title: 'Synthetic native capsule',
    projectId: 'local:synthetic',
    repositoryId: 'synthetic-repository',
    branch: 'main',
    head: 'b'.repeat(40),
    machine: 'synthetic-source',
    createdAt: '2026-07-28T10:00:00.000Z',
    payloadPath: `objects/${'a'.repeat(64)}`,
    capabilities: {
      nativeResume: true,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync: null,
    },
  });
}

describe('native capsule capture and dry-run', () => {
  it('captures only one Claude JSONL, removes source paths and secrets, and plans a target-path re-encode without writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-native-claude-'));
    temporaryDirectories.push(root);
    const sourceUserHome = path.join(root, 'source-home');
    const sourceProject = path.join(sourceUserHome, 'work', 'synthetic-project');
    const sourceClaudeHome = path.join(sourceUserHome, '.claude');
    const targetUserHome = path.join(root, 'target-home');
    const targetProject = path.join(targetUserHome, 'projects', 'renamed-project');
    const targetClaudeHome = path.join(targetUserHome, '.claude');
    const providerSessionId = '11111111-1111-4111-8111-111111111111';
    const sourceDirectory = path.join(sourceClaudeHome, 'projects', encodeClaudeProjectPath(sourceProject));
    const sourcePath = path.join(sourceDirectory, `${providerSessionId}.jsonl`);
    const fakeSecret = `AKIA${'D'.repeat(16)}`;
    const sqlitePath = path.join(sourceClaudeHome, 'state.sqlite');
    await Promise.all([
      mkdir(sourceProject, { recursive: true }),
      mkdir(sourceDirectory, { recursive: true }),
      mkdir(targetProject, { recursive: true }),
    ]);
    await writeFile(sqlitePath, 'must never be touched');
    await writeFile(sourcePath, [
      JSON.stringify({ timestamp: '2026-07-28T09:00:00.000Z', cwd: sourceProject, title: 'Synthetic Claude session' }),
      JSON.stringify({ message: `credential ${fakeSecret}`, providerHome: sourceClaudeHome }),
      '{"truncated":',
    ].join('\n'));
    const session = discoveredSessionSchema.parse({
      schemaVersion: 1,
      provider: 'claude',
      providerSessionId,
      sourcePath,
      projectPath: sourceProject,
      projectId: 'local:synthetic',
      repositoryId: 'synthetic-repository',
      repositoryName: 'Synthetic Repository',
      title: 'Synthetic Claude session',
      createdAt: '2026-07-28T09:00:00.000Z',
      lastActivityAt: '2026-07-28T09:01:00.000Z',
      bytes: 1,
      messageCount: 2,
      tailTruncated: true,
      readable: true,
      error: null,
      discoveredAt: '2026-07-28T10:00:00.000Z',
    });
    const accesses: NativeProviderFileAccess[] = [];
    const captured = await captureNativeCapsule({
      session,
      capabilities: capabilities('claude'),
      claudeHome: sourceClaudeHome,
      sourceUserHome,
      now: new Date('2026-07-28T10:00:00.000Z'),
      onProviderFileAccess: (item) => {
        accesses.push(item);
      },
    });

    expect(captured.manifest).toMatchObject({
      status: 'verified',
      formatVersion: 'claude-jsonl-v1',
      sourceTailTruncated: true,
      files: [{ fileName: `${providerSessionId}.jsonl`, datePath: null }],
    });
    expect(captured.recordContent).toContain('{{MOO_FLEET_PROJECT}}');
    expect(captured.recordContent).toContain('[REDACTED:aws-access-key]');
    expect(captured.recordContent).not.toContain(sourceProject);
    expect(captured.recordContent).not.toContain(fakeSecret);
    expect(accesses).toHaveLength(2);
    expect(accesses.every((item) => path.basename(item.path) === `${providerSessionId}.jsonl`)).toBe(true);
    expect(accesses.some((item) => /sqlite|wal|shm/i.test(item.path))).toBe(false);

    const targetAccesses: NativeProviderFileAccess[] = [];
    const inspected = await inspectNativeRestore({
      capsule: { checkpoint: checkpoint('claude', providerSessionId), manifest: captured.manifest, recordContent: captured.recordContent },
      localProjectPath: targetProject,
      localCapabilities: capabilities('claude'),
      claudeHome: targetClaudeHome,
      targetUserHome,
      onProviderFileAccess: (item) => {
        targetAccesses.push(item);
      },
    });
    expect(inspected.plan).toMatchObject({ status: 'verified', available: true, action: 'install', targetExists: false });
    expect(inspected.plan.targetDisplayPath).toBe(`~/.claude/projects/${encodeClaudeProjectPath(targetProject)}/${providerSessionId}.jsonl`);
    expect(inspected.target?.hydratedContent).toContain(targetProject);
    expect(inspected.target?.hydratedContent).not.toContain(sourceProject);
    expect(targetAccesses).toEqual([]);
    await expect(access(inspected.target!.absolutePath)).rejects.toThrow();
  });

  it('keeps the Codex rollout filename/date and rejects a target CLI version mismatch before touching provider files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-native-codex-'));
    temporaryDirectories.push(root);
    const sourceUserHome = path.join(root, 'source-home');
    const sourceProject = path.join(sourceUserHome, 'work', 'synthetic-codex');
    const sourceCodexHome = path.join(sourceUserHome, '.codex');
    const targetUserHome = path.join(root, 'target-home');
    const targetProject = path.join(targetUserHome, 'work', 'synthetic-codex');
    const targetCodexHome = path.join(targetUserHome, '.codex');
    const providerSessionId = '22222222-2222-4222-8222-222222222222';
    const fileName = `rollout-2026-07-21T12-34-56-${providerSessionId}.jsonl`;
    const sourceDirectory = path.join(sourceCodexHome, 'sessions', '2026', '07', '21');
    const sourcePath = path.join(sourceDirectory, fileName);
    await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(targetProject, { recursive: true })]);
    await writeFile(sourcePath, `${JSON.stringify({ timestamp: '2026-07-21T12:34:56.000Z', cwd: sourceProject })}\n`);
    const session = discoveredSessionSchema.parse({
      schemaVersion: 1,
      provider: 'codex',
      providerSessionId,
      sourcePath,
      projectPath: sourceProject,
      projectId: 'local:synthetic-codex',
      repositoryId: 'synthetic-codex',
      repositoryName: 'Synthetic Codex',
      title: 'Synthetic Codex rollout',
      createdAt: '2026-07-21T12:34:56.000Z',
      lastActivityAt: '2026-07-21T12:34:56.000Z',
      bytes: 1,
      messageCount: 1,
      tailTruncated: false,
      readable: true,
      error: null,
      discoveredAt: '2026-07-28T10:00:00.000Z',
    });
    const captured = await captureNativeCapsule({
      session,
      capabilities: capabilities('codex'),
      codexHome: sourceCodexHome,
      sourceUserHome,
      now: new Date('2026-07-28T10:00:00.000Z'),
    });
    expect(captured.manifest.files[0]).toMatchObject({ fileName, datePath: '2026/07/21' });

    const accesses: NativeProviderFileAccess[] = [];
    const inspected = await inspectNativeRestore({
      capsule: { checkpoint: checkpoint('codex', providerSessionId), manifest: captured.manifest, recordContent: captured.recordContent },
      localProjectPath: targetProject,
      localCapabilities: capabilities('codex', 'codex 10.0.0-synthetic'),
      codexHome: targetCodexHome,
      targetUserHome,
      onProviderFileAccess: (item) => {
        accesses.push(item);
      },
    });
    expect(inspected.plan).toMatchObject({ status: 'unsupported', available: false, action: 'unavailable' });
    expect(inspected.plan.message).toContain('版本不一致');
    expect(accesses).toEqual([]);
  });

  it('rejects a dry-run target whose existing parent escapes provider home through a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-native-symlink-'));
    temporaryDirectories.push(root);
    const sourceUserHome = path.join(root, 'source-home');
    const sourceProject = path.join(sourceUserHome, 'work', 'synthetic-project');
    const sourceClaudeHome = path.join(sourceUserHome, '.claude');
    const targetUserHome = path.join(root, 'target-home');
    const targetProject = path.join(targetUserHome, 'work', 'synthetic-project');
    const targetClaudeHome = path.join(targetUserHome, '.claude');
    const outsideDirectory = path.join(root, 'outside-provider-home');
    const providerSessionId = '44444444-4444-4444-8444-444444444444';
    const sourceDirectory = path.join(sourceClaudeHome, 'projects', encodeClaudeProjectPath(sourceProject));
    const sourcePath = path.join(sourceDirectory, `${providerSessionId}.jsonl`);
    await Promise.all([
      mkdir(sourceDirectory, { recursive: true }),
      mkdir(targetProject, { recursive: true }),
      mkdir(path.join(targetClaudeHome, 'projects'), { recursive: true }),
      mkdir(outsideDirectory, { recursive: true }),
    ]);
    await writeFile(sourcePath, `${JSON.stringify({ cwd: sourceProject, title: 'Synthetic symlink guard' })}\n`);
    const captured = await captureNativeCapsule({
      session: discoveredSessionSchema.parse({
        schemaVersion: 1,
        provider: 'claude',
        providerSessionId,
        sourcePath,
        projectPath: sourceProject,
        projectId: 'local:synthetic-symlink',
        repositoryId: 'synthetic-symlink',
        repositoryName: 'Synthetic Symlink',
        title: 'Synthetic symlink guard',
        createdAt: '2026-07-28T09:00:00.000Z',
        lastActivityAt: '2026-07-28T09:00:00.000Z',
        bytes: 1,
        messageCount: 1,
        tailTruncated: false,
        readable: true,
        error: null,
        discoveredAt: '2026-07-28T10:00:00.000Z',
      }),
      capabilities: capabilities('claude'),
      claudeHome: sourceClaudeHome,
      sourceUserHome,
    });
    const encodedTarget = encodeClaudeProjectPath(targetProject);
    await symlink(outsideDirectory, path.join(targetClaudeHome, 'projects', encodedTarget));
    await writeFile(path.join(outsideDirectory, `${providerSessionId}.jsonl`), '{"outside":true}\n');
    const accesses: NativeProviderFileAccess[] = [];
    const inspected = await inspectNativeRestore({
      capsule: { checkpoint: checkpoint('claude', providerSessionId), manifest: captured.manifest, recordContent: captured.recordContent },
      localProjectPath: targetProject,
      localCapabilities: capabilities('claude'),
      claudeHome: targetClaudeHome,
      targetUserHome,
      onProviderFileAccess: (item) => {
        accesses.push(item);
      },
    });

    expect(inspected.plan).toMatchObject({ status: 'unsupported', available: false });
    expect(inspected.plan.message).toContain('符号链接逃逸');
    expect(accesses).toEqual([]);
  });
});
