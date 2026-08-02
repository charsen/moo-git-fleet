import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BackupStatus,
  LocalSessionList,
  SessionBackupCandidateList,
  SessionSyncResult,
} from '../shared/session-sync.js';
import type { SessionContentPreview, DiscoveredSession } from '../shared/sessions.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const trashed: string[] = [];

// 不要在测试里真的往系统废纸篓丢文件。
vi.mock('./system/trash.js', () => ({
  movePathToTrash: async (filePath: string) => {
    trashed.push(filePath);
    await rm(filePath, { force: true });
  },
}));
const hostHeaders = { host: '127.0.0.1:8787' };

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

async function jsonRequest<T>(
  app: FastifyInstance,
  options: Omit<InjectOptions, 'headers' | 'payload'> & { payload?: unknown },
  token?: string,
): Promise<{ statusCode: number; body: T }> {
  const response = await app.inject({
    ...options,
    headers: {
      ...hostHeaders,
      ...(token ? { 'x-git-fleet-token': token } : {}),
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: options.payload === undefined ? undefined : JSON.stringify(options.payload),
  });
  return { statusCode: response.statusCode, body: response.json<T>() };
}

function transcript(lines: string[]): string {
  return `${lines
    .map((text) => JSON.stringify({
      type: 'user',
      timestamp: '2026-07-30T10:00:00.000Z',
      message: { role: 'user', content: text },
    }))
    .join('\n')}\n`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('会话同步 API', () => {
  it('走完设置备份 → 列表 → 预览 → 同步 → 删除的完整流程', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-sessions-api-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const claudeHome = path.join(root, 'claude');
    const projectPath = path.join(root, 'project');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionDirectory = path.join(claudeHome, 'projects', path.resolve(projectPath).replaceAll('/', '-'));
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await git(root, ['init', '--initial-branch=main', projectPath]);
    await writeFile(path.join(sessionDirectory, `${sessionId}.jsonl`), transcript(['第一条', '第二条']));

    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.stubEnv('GIT_FLEET_CLAUDE_HOME', claudeHome);
    vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', path.join(root, 'fleet-source'));
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    try {
      const unauthorized = await jsonRequest<{ error: string }>(app, {
        method: 'POST',
        url: '/api/session-sync',
      });
      expect(unauthorized.statusCode).toBe(403);

      const session = await jsonRequest<{ token: string }>(app, { method: 'GET', url: '/api/session' });
      const token = session.body.token;

      const initialStatus = await jsonRequest<BackupStatus>(app, { method: 'GET', url: '/api/session-backup' });
      expect(initialStatus).toMatchObject({ statusCode: 200, body: { configured: false } });

      const beforeSetup = await jsonRequest<LocalSessionList>(app, { method: 'GET', url: '/api/local-sessions' });
      expect(beforeSetup.statusCode).toBe(200);
      expect(beforeSetup.body.backupConfigured).toBe(false);
      expect(beforeSetup.body.items.map((item) => item.providerSessionId)).toContain(sessionId);
      expect(beforeSetup.body.items[0]?.backupState).toBe('not-backed-up');

      const preview = await jsonRequest<{ session: DiscoveredSession; preview: SessionContentPreview }>(app, {
        method: 'GET',
        url: `/api/local-sessions/claude/${sessionId}`,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.body.preview.items.map((item) => item.text)).toEqual(['第一条', '第二条']);

      const missing = await jsonRequest<{ error: string }>(app, {
        method: 'GET',
        url: '/api/local-sessions/claude/does-not-exist',
      });
      expect(missing.statusCode).toBe(404);

      const beforeInitialize = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/session-sync' },
        token,
      );
      expect(beforeInitialize.statusCode).toBe(409);

      const candidates = await jsonRequest<SessionBackupCandidateList>(app, {
        method: 'GET',
        url: '/api/session-backup/candidates',
      });
      expect(candidates.statusCode).toBe(200);
      expect(Array.isArray(candidates.body.candidates)).toBe(true);

      const initialized = await jsonRequest<BackupStatus>(
        app,
        { method: 'POST', url: '/api/session-backup/initialize', payload: { backupPath: null } },
        token,
      );
      expect(initialized).toMatchObject({ statusCode: 200, body: { configured: true, remoteUrl: null } });
      const backupPath = initialized.body.backupPath!;

      const synced = await jsonRequest<SessionSyncResult>(app, { method: 'POST', url: '/api/session-sync' }, token);
      expect(synced.statusCode).toBe(200);
      expect(synced.body).toMatchObject({ backedUp: 1, restored: 0, pending: [], pushed: false });
      expect(await readFile(path.join(backupPath, 'sessions', 'claude', `${sessionId}.jsonl`), 'utf8')).toContain('第二条');

      const afterSync = await jsonRequest<LocalSessionList>(app, { method: 'GET', url: '/api/local-sessions' });
      expect(afterSync.body.items[0]).toMatchObject({ backupState: 'backed-up' });

      const again = await jsonRequest<SessionSyncResult>(app, { method: 'POST', url: '/api/session-sync' }, token);
      expect(again.body).toMatchObject({ backedUp: 0, skipped: 1 });

      const badDecision = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: '/api/session-sync/resolve',
          payload: { provider: 'claude', providerSessionId: sessionId, decision: 'keep-everything' },
        },
        token,
      );
      expect(badDecision.statusCode).toBe(400);

      const trashResult = await jsonRequest<{ trashed: boolean; backupRemoved: boolean }>(
        app,
        {
          method: 'POST',
          url: `/api/local-sessions/claude/${sessionId}/trash`,
          payload: { alsoRemoveFromBackup: true },
        },
        token,
      );
      expect(trashResult).toMatchObject({ statusCode: 200, body: { trashed: true, backupRemoved: true } });
      expect(trashed).toHaveLength(1);
      await expect(
        readFile(path.join(backupPath, 'sessions', 'claude', `${sessionId}.jsonl`), 'utf8'),
      ).rejects.toThrow();
      expect(JSON.parse(await readFile(path.join(backupPath, 'sessions', 'claude', `${sessionId}.json`), 'utf8')))
        .toMatchObject({ deleted: true });
    } finally {
      await app.close();
    }
  }, 30_000);

  it('选中旧版备份仓时用 409 + legacy-vault 退回，确认后就地升级', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-legacy-vault-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const vault = path.join(root, 'old-vault');
    await mkdir(path.join(vault, 'events'), { recursive: true });
    await git(root, ['init', '--initial-branch=main', vault]);
    await writeFile(path.join(vault, 'vault.yaml'), 'schemaVersion: 3\n');
    await writeFile(path.join(vault, 'events', '0001.json'), '{"type":"checkpoint"}\n');
    await git(vault, ['add', '-A']);
    await git(vault, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'checkpoint: 旧版会话']);

    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(root, 'claude'));
    vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(root, 'codex'));
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', path.join(root, 'fleet-source'));
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    try {
      const token = (await jsonRequest<{ token: string }>(app, { method: 'GET', url: '/api/session' })).body.token;

      const rejected = await jsonRequest<{ error: string; code?: string }>(
        app,
        { method: 'POST', url: '/api/session-backup/initialize', payload: { backupPath: vault } },
        token,
      );
      expect(rejected.statusCode).toBe(409);
      expect(rejected.body.code).toBe('legacy-vault');
      expect(rejected.body.error).toContain('旧版 Moo Fleet');
      expect(await readFile(path.join(vault, 'vault.yaml'), 'utf8')).toBe('schemaVersion: 3\n');

      const upgraded = await jsonRequest<BackupStatus>(
        app,
        { method: 'POST', url: '/api/session-backup/initialize', payload: { backupPath: vault, upgradeLegacy: true } },
        token,
      );
      expect(upgraded).toMatchObject({ statusCode: 200, body: { configured: true } });
      await expect(readFile(path.join(vault, 'vault.yaml'), 'utf8')).rejects.toThrow();
      expect(JSON.parse(await readFile(path.join(vault, 'fleet.json'), 'utf8')))
        .toMatchObject({ kind: 'moo-fleet-session-backup' });
      expect(await git(vault, ['log', '--format=%s'])).toContain('checkpoint: 旧版会话');
    } finally {
      await app.close();
    }
  }, 30_000);
});
