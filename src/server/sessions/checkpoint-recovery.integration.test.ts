import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredSession, HandoffSummary } from '../../shared/sessions.js';
import { captureCheckpoint, captureWorkspaceSnapshot, SimulatedCheckpointInterruption } from './checkpoint.js';
import { initializeSessionVault } from './vault.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session checkpoint startup recovery', () => {
  it('cleans an interrupted publish transaction when the application starts again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-checkpoint-restart-'));
    temporaryDirectories.push(root);
    const fleetHome = path.join(root, 'fleet-home');
    const fleetSource = path.join(root, 'fleet-source');
    const vaultPath = path.join(root, 'session-vault');
    const projectPath = path.join(root, 'synthetic-project');
    const bindingPath = path.join(fleetHome, 'config', 'session-vault.yaml');
    await Promise.all([mkdir(fleetSource, { recursive: true }), mkdir(projectPath, { recursive: true })]);
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    await git(root, ['init', '--initial-branch=main', projectPath]);
    await git(projectPath, ['config', 'user.name', 'Synthetic Developer']);
    await git(projectPath, ['config', 'user.email', 'synthetic@example.test']);
    await writeFile(path.join(projectPath, 'README.md'), '# Synthetic restart recovery\n');
    await git(projectPath, ['add', 'README.md']);
    await git(projectPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await initializeSessionVault(
      { vaultPath },
      { fleetRepositoryPath: fleetSource, bindingPath, now: new Date('2026-07-28T06:00:00.000Z') },
    );
    const session: DiscoveredSession = {
      schemaVersion: 1,
      provider: 'codex',
      providerSessionId: '66666666-6666-4666-8666-666666666666',
      sourcePath: '/synthetic/provider/rollout.jsonl',
      projectPath,
      projectId: 'local:synthetic-restart',
      repositoryId: 'synthetic-restart',
      repositoryName: 'Synthetic Restart',
      title: 'Verify synthetic restart recovery',
      createdAt: '2026-07-28T05:00:00.000Z',
      lastActivityAt: '2026-07-28T05:30:00.000Z',
      bytes: 100,
      messageCount: 2,
      tailTruncated: false,
      readable: true,
      error: null,
      discoveredAt: '2026-07-28T05:31:00.000Z',
    };
    const summary: HandoffSummary = {
      goal: 'Verify synthetic restart recovery',
      completed: [],
      decisions: ['Use a durable checkpoint journal'],
      nextSteps: ['Restart the application'],
      blockers: [],
      commands: [],
      risks: [],
      source: 'manual',
      reviewedAt: '2026-07-28T06:01:00.000Z',
    };
    const workspace = await captureWorkspaceSnapshot(projectPath, session.projectId, session.repositoryId);
    const statusBefore = await git(vaultPath, ['status', '--porcelain=v1']);
    await expect(
      captureCheckpoint({
        vaultPath,
        sessionId: 'fleet-session-restart-recovery',
        session,
        summary,
        workspace,
        machine: 'fixture-machine',
        capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
        testHook: (phase) => {
          if (phase === 'after-event-publish') throw new SimulatedCheckpointInterruption();
        },
      }),
    ).rejects.toBeInstanceOf(SimulatedCheckpointInterruption);
    expect(await readdir(path.join(vaultPath, '.fleet', 'checkpoint-journal'))).toHaveLength(1);

    vi.stubEnv('GIT_FLEET_HOME', fleetHome);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetSource);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();
    try {
      expect(await readdir(path.join(vaultPath, '.fleet', 'checkpoint-journal'))).toEqual([]);
      expect(await readdir(path.join(vaultPath, 'objects')).catch(() => [])).toEqual([]);
      expect(await git(vaultPath, ['status', '--porcelain=v1'])).toBe(statusBefore);
      expect(await git(vaultPath, ['rev-list', '--all', '--count'])).toBe('0');
    } finally {
      await app.close();
    }
  });
});
