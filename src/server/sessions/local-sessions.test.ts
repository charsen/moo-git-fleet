import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { initializeBackup } from './backup-repo.js';
import { writeBackupSession, writeBackupTombstone } from './backup-store.js';
import { encodeClaudeProjectPath } from './discovery.js';
import { listLocalSessions, localSessionPreview } from './local-sessions.js';

let workspace = '';
let claudeHome = '';
let projectDirectory = '';

const repositories = {
  version: 1,
  settings: { roots: {}, defaultRemote: 'origin', scanDepth: 2, localScanConcurrency: 1, networkConcurrency: 1 },
  repositories: [],
} as unknown as RepositoriesConfig;

function options() {
  return {
    bindingPath: path.join(workspace, 'config', 'session-backup.json'),
    fleetRepositoryPath: path.join(workspace, 'fleet-source'),
    repositories,
    claudeHome,
    codexHome: path.join(workspace, 'codex'),
  };
}

function line(text: string): string {
  return JSON.stringify({ type: 'user', timestamp: '2026-07-30T10:00:00.000Z', message: { role: 'user', content: text } });
}

async function writeSession(sessionId: string, lines: string[]): Promise<string> {
  const content = `${lines.join('\n')}\n`;
  await writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), content);
  return content;
}

const details = {
  title: null,
  projectId: 'remote:abc',
  projectPath: null,
  repositoryName: null,
  lastActivityAt: null,
  sourceRelativePath: null,
  messageCount: 1,
};

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'fleet-local-sessions-'));
  claudeHome = path.join(workspace, 'claude');
  const projectPath = path.join(workspace, 'project');
  projectDirectory = path.join(claudeHome, 'projects', encodeClaudeProjectPath(projectPath));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('listLocalSessions', () => {
  it('还没设置备份时也能列出本机会话', async () => {
    await writeSession('session-1', [line('第一条')]);

    const list = await listLocalSessions(options());

    expect(list.backupConfigured).toBe(false);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ providerSessionId: 'session-1', backupState: 'not-backed-up' });
  });

  it('按备份情况标出四种状态', async () => {
    const status = await initializeBackup({}, options());
    const backupPath = status.backupPath!;
    const write = (providerSessionId: string, content: string) => writeBackupSession({
      backupPath,
      provider: 'claude' as const,
      providerSessionId,
      content,
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });

    const same = await writeSession('backed-up', [line('一样的')]);
    await write('backed-up', same);
    await writeSession('changed', [line('第一条'), line('新写的')]);
    await write('changed', `${line('第一条')}\n`);
    await writeSession('fresh', [line('还没备份')]);
    await writeSession('deleted-elsewhere', [line('另一台删了')]);
    await writeBackupTombstone({
      backupPath,
      provider: 'claude',
      providerSessionId: 'deleted-elsewhere',
      device: '家里 Mac',
      now: new Date('2026-07-30T13:00:00.000Z'),
    });

    const list = await listLocalSessions(options());
    const stateOf = (id: string) => list.items.find((item) => item.providerSessionId === id)?.backupState;

    expect(list.backupConfigured).toBe(true);
    expect(stateOf('backed-up')).toBe('backed-up');
    expect(stateOf('changed')).toBe('changed');
    expect(stateOf('fresh')).toBe('not-backed-up');
    expect(stateOf('deleted-elsewhere')).toBe('deleted-in-backup');
  });

  it('数出只在备份里、本机还没有的会话', async () => {
    const status = await initializeBackup({}, options());
    await writeBackupSession({
      backupPath: status.backupPath!,
      provider: 'claude',
      providerSessionId: 'only-in-backup',
      content: `${line('来自另一台电脑')}\n`,
      device: '家里 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });

    const list = await listLocalSessions(options());

    expect(list.items).toHaveLength(0);
    expect(list.onlyInBackup).toBe(1);
  });
});

describe('localSessionPreview', () => {
  it('返回会话本身与可读对话', async () => {
    await writeSession('session-1', [line('帮我看看这个 bug')]);

    const payload = await localSessionPreview({ provider: 'claude', providerSessionId: 'session-1' }, options());

    expect(payload.session.providerSessionId).toBe('session-1');
    expect(payload.preview.items.map((item) => item.text)).toEqual(['帮我看看这个 bug']);
  });

  it('找不到会话时报 404', async () => {
    await expect(
      localSessionPreview({ provider: 'claude', providerSessionId: 'missing' }, options()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
