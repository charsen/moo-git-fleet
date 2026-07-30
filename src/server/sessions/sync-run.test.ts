import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { runGitText } from '../git/runner.js';
import { initializeBackup } from './backup-repo.js';
import { listBackupSessions, readBackupMeta, readBackupTranscript } from './backup-store.js';
import { encodeClaudeProjectPath } from './discovery.js';
import { resolveSessionSync, runSessionSync, trashLocalSession } from './sync-run.js';

const trashed: string[] = [];
vi.mock('../system/trash.js', () => ({
  movePathToTrash: async (filePath: string) => {
    trashed.push(filePath);
    await rm(filePath, { force: true });
  },
}));

let workspace = '';
let remotePath = '';

interface Machine {
  name: string;
  backupPath: string;
  claudeHome: string;
  projectPath: string;
  options: () => Record<string, unknown>;
}

/** 两台电脑上的同一个项目：本机路径不同，但 Git 远端相同，因此 projectId 相同。 */
function repositoriesFor(projectPath: string, registered: boolean): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { fixture: path.dirname(projectPath) },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 1,
      networkConcurrency: 1,
    },
    repositories: registered
      ? [{ id: 'project', name: 'project', root: 'fixture', path: 'project' } as RepositoriesConfig['repositories'][number]]
      : [],
  } as RepositoriesConfig;
}

async function makeMachine(name: string, config: { remote?: boolean; registered?: boolean } = {}): Promise<Machine> {
  const withRemote = config.remote ?? true;
  const registered = config.registered ?? true;
  const root = path.join(workspace, name);
  const claudeHome = path.join(root, 'claude');
  await mkdir(path.join(claudeHome, 'projects'), { recursive: true });
  await mkdir(path.join(root, 'project'), { recursive: true });
  // macOS 的 /var 是 /private/var 的软链，仓库注册表按 realpath 记录项目位置。
  const projectPath = await realpath(path.join(root, 'project'));
  await runGitText(projectPath, ['init', '--initial-branch=main']);
  await runGitText(projectPath, ['remote', 'add', 'origin', 'https://example.test/acme/project.git']);
  const bindingPath = path.join(root, 'config', 'session-backup.json');
  const status = await initializeBackup(
    { backupPath: path.join(root, 'backup'), remoteUrl: withRemote ? remotePath : null },
    { bindingPath, fleetRepositoryPath: path.join(workspace, 'fleet-source') },
  );
  return {
    name,
    backupPath: status.backupPath!,
    claudeHome,
    projectPath,
    options: () => ({
      bindingPath,
      fleetRepositoryPath: path.join(workspace, 'fleet-source'),
      repositories: repositoriesFor(projectPath, registered),
      claudeHome,
      codexHome: path.join(root, 'codex'),
    }),
  };
}

function claudeSessionPath(machine: Machine, sessionId: string): string {
  return path.join(machine.claudeHome, 'projects', encodeClaudeProjectPath(machine.projectPath), `${sessionId}.jsonl`);
}

async function writeLocalSession(machine: Machine, sessionId: string, lines: string[]): Promise<void> {
  const filePath = claudeSessionPath(machine, sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join('\n')}\n`);
}

function line(text: string, at = '2026-07-30T10:00:00.000Z'): string {
  return JSON.stringify({ type: 'user', timestamp: at, cwd: '/project', message: { role: 'user', content: text } });
}

beforeEach(async () => {
  trashed.length = 0;
  workspace = await mkdtemp(path.join(os.tmpdir(), 'fleet-sync-run-'));
  await mkdir(path.join(workspace, 'fleet-source'), { recursive: true });
  await runGitText(path.join(workspace, 'fleet-source'), ['init', '--initial-branch=main']);
  remotePath = path.join(workspace, 'remote.git');
  await mkdir(remotePath, { recursive: true });
  await runGitText(remotePath, ['init', '--bare', '--initial-branch=main']);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('runSessionSync', () => {
  it('A 机备份、B 机恢复：一次点击完成，不需要用户决定', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条'), line('第二条')]);

    const first = await runSessionSync(a.options());
    expect(first.backedUp).toBe(1);
    expect(first.pending).toEqual([]);
    expect(first.pushed).toBe(true);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('第一条');

    const b = await makeMachine('b');
    const second = await runSessionSync(b.options());
    expect(second.restored).toBe(1);
    expect(second.pending).toEqual([]);
    expect(await readFile(claudeSessionPath(b, 'session-1'), 'utf8')).toContain('第二条');
  });

  it('本机继续写下去：只把新增部分推上去，不需要用户决定', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());

    await writeLocalSession(a, 'session-1', [line('第一条'), line('第二条')]);
    const result = await runSessionSync(a.options());

    expect(result.backedUp).toBe(1);
    expect(result.pending).toEqual([]);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('第二条');
  });

  it('另一台电脑写长了：自动追加到本机', async () => {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());

    await writeLocalSession(a, 'session-1', [line('第一条'), line('A 机续写')]);
    await runSessionSync(a.options());
    const result = await runSessionSync(b.options());

    expect(result.restored).toBe(1);
    expect(result.pending).toEqual([]);
    expect(await readFile(claudeSessionPath(b, 'session-1'), 'utf8')).toContain('A 机续写');
  });

  it('两边各写各的：停下来问用户，并给出三个选择', async () => {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());

    await writeLocalSession(a, 'session-1', [line('第一条'), line('A 机写的')]);
    await runSessionSync(a.options());
    await writeLocalSession(b, 'session-1', [line('第一条'), line('B 机写的')]);
    const result = await runSessionSync(b.options());

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.relation).toBe('diverged');
    expect(result.pending[0]?.commonLines).toBe(1);
    expect(result.pending[0]?.choices).toEqual(['keep-local', 'keep-backup', 'keep-both']);
  });

  it('没有变化时不产生新提交', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    const before = await runGitText(a.backupPath, ['rev-parse', 'HEAD']);

    const result = await runSessionSync(a.options());
    expect(result.skipped).toBe(1);
    expect(result.backedUp).toBe(0);
    expect(await runGitText(a.backupPath, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('只在本机备份（没有远端）也能用', async () => {
    const a = await makeMachine('a', { remote: false });
    await writeLocalSession(a, 'session-1', [line('第一条')]);

    const result = await runSessionSync(a.options());
    expect(result.backedUp).toBe(1);
    expect(result.pushed).toBe(false);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('第一条');
  });
});

describe('resolveSessionSync', () => {
  async function divergedPair(): Promise<{ a: Machine; b: Machine }> {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());
    await writeLocalSession(a, 'session-1', [line('第一条'), line('A 机写的')]);
    await runSessionSync(a.options());
    await writeLocalSession(b, 'session-1', [line('第一条'), line('B 机写的')]);
    await runSessionSync(b.options());
    return { a, b };
  }

  it('用本机：备份被本机内容覆盖', async () => {
    const { b } = await divergedPair();

    await resolveSessionSync({ provider: 'claude', providerSessionId: 'session-1', decision: 'keep-local' }, b.options());

    expect(await readBackupTranscript(b.backupPath, 'claude', 'session-1')).toContain('B 机写的');
    expect(await readFile(claudeSessionPath(b, 'session-1'), 'utf8')).toContain('B 机写的');
  });

  it('用备份：本机被另一台电脑的内容覆盖', async () => {
    const { b } = await divergedPair();

    await resolveSessionSync({ provider: 'claude', providerSessionId: 'session-1', decision: 'keep-backup' }, b.options());

    expect(await readFile(claudeSessionPath(b, 'session-1'), 'utf8')).toContain('A 机写的');
  });

  it('两份都留：本机多出一份另存的会话，备份里两份都在', async () => {
    const { b } = await divergedPair();

    await resolveSessionSync({ provider: 'claude', providerSessionId: 'session-1', decision: 'keep-both' }, b.options());

    const entries = await listBackupSessions(b.backupPath);
    expect(entries).toHaveLength(2);
    const copy = entries.find((entry) => entry.meta.providerSessionId !== 'session-1');
    expect(copy).toBeTruthy();
    expect(await readBackupTranscript(b.backupPath, 'claude', 'session-1')).toContain('B 机写的');
    expect(await readBackupTranscript(b.backupPath, 'claude', copy!.meta.providerSessionId)).toContain('A 机写的');
    expect(await readFile(claudeSessionPath(b, copy!.meta.providerSessionId), 'utf8')).toContain('A 机写的');
  });

  it('同步后再同步不会重新提出同一个冲突', async () => {
    const { b } = await divergedPair();
    await resolveSessionSync({ provider: 'claude', providerSessionId: 'session-1', decision: 'keep-local' }, b.options());

    const result = await runSessionSync(b.options());
    expect(result.pending).toEqual([]);
  });
});

describe('删除与墓碑', () => {
  it('删除本机会话时可以同时在备份里留删除记录，另一台电脑不会把它同步回来', async () => {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());

    await trashLocalSession(
      { provider: 'claude', providerSessionId: 'session-1', alsoRemoveFromBackup: true },
      a.options(),
    );
    expect(trashed).toHaveLength(1);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toBeNull();

    const result = await runSessionSync(b.options());
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.relation).toBe('backup-deleted');
    expect(result.pending[0]?.choices).toEqual(['keep-local', 'delete-local']);
  });

  it('跟随删除：本机会话进废纸篓', async () => {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());
    await trashLocalSession(
      { provider: 'claude', providerSessionId: 'session-1', alsoRemoveFromBackup: true },
      a.options(),
    );
    await runSessionSync(b.options());

    await resolveSessionSync(
      { provider: 'claude', providerSessionId: 'session-1', decision: 'delete-local' },
      b.options(),
    );

    expect(trashed).toContain(claudeSessionPath(b, 'session-1'));
    const result = await runSessionSync(b.options());
    expect(result.pending).toEqual([]);
  });

  it('保留本机：删除记录被本机内容取代，另一台电脑下次同步会拿回来', async () => {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());
    await trashLocalSession(
      { provider: 'claude', providerSessionId: 'session-1', alsoRemoveFromBackup: true },
      a.options(),
    );
    await runSessionSync(b.options());

    await resolveSessionSync(
      { provider: 'claude', providerSessionId: 'session-1', decision: 'keep-local' },
      b.options(),
    );

    const result = await runSessionSync(a.options());
    expect(result.restored).toBe(1);
    expect(await readFile(claudeSessionPath(a, 'session-1'), 'utf8')).toContain('第一条');
  });

  it('默认删除只动本机，不动备份', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());

    await trashLocalSession({ provider: 'claude', providerSessionId: 'session-1' }, a.options());

    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('第一条');
  });
});

describe('会话正在被写入时', () => {
  /** 直接写一个没有换行结尾的文件，模拟 provider 正在写最后一行。 */
  async function writePartialSession(machine: Machine, sessionId: string, lines: string[], tail: string): Promise<void> {
    const filePath = claudeSessionPath(machine, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${lines.map((entry) => `${entry}\n`).join('')}${tail}`);
  }

  it('半行不会进备份，那行写完之后也不会被误判成分叉', async () => {
    const a = await makeMachine('a');
    await writePartialSession(a, 'session-1', [line('第一条')], '{"type":"user","message":{"role":"user","con');

    const first = await runSessionSync(a.options());
    expect(first.backedUp).toBe(1);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toBe(`${line('第一条')}\n`);

    // provider 把那一行写完。
    await writeLocalSession(a, 'session-1', [line('第一条'), line('写完了')]);
    const second = await runSessionSync(a.options());

    expect(second.pending).toEqual([]);
    expect(second.backedUp).toBe(1);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('写完了');
  });

  it('只有半行的会话不会在备份里留下半截内容', async () => {
    const a = await makeMachine('a');
    await writePartialSession(a, 'session-1', [], '{"type":"user"');

    await runSessionSync(a.options());

    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toBe('');
  });
});

describe('项目身份', () => {
  it('本机没注册这个项目时，不会把备份里已有的 projectId 覆盖成未识别', async () => {
    const a = await makeMachine('a');
    // B 机不登记任何仓库，且项目目录不存在 —— 它认不出这条会话属于哪个项目。
    const b = await makeMachine('b', { registered: false });
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    const original = await readBackupMeta(a.backupPath, 'claude', 'session-1');
    expect(original?.projectId).toMatch(/^remote:/);

    await runSessionSync(b.options());
    // B 机接着往这条会话里写。
    await writeLocalSession(b, 'session-1', [line('第一条'), line('B 机续写')]);
    await runSessionSync(b.options());

    expect((await readBackupMeta(b.backupPath, 'claude', 'session-1'))?.projectId).toBe(original?.projectId);
  });
});

describe('并发保护', () => {
  it('同时点多次同步会排队执行，不会撞在同一个 git 仓上', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);

    const results = await Promise.all([
      runSessionSync(a.options()),
      runSessionSync(a.options()),
      runSessionSync(a.options()),
    ]);

    // 只有第一轮真的写了备份，后面两轮发现没变化。
    expect(results.map((result) => result.backedUp)).toEqual([1, 0, 0]);
    expect(results.every((result) => result.pending.length === 0)).toBe(true);
    expect((await runGitText(a.backupPath, ['log', '--oneline'])).split('\n')).toHaveLength(1);
  });

  it('同步与删除同时发生时也串行，备份仓不会留下半截状态', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await writeLocalSession(a, 'session-2', [line('另一条')]);
    await runSessionSync(a.options());

    await Promise.all([
      runSessionSync(a.options()),
      trashLocalSession(
        { provider: 'claude', providerSessionId: 'session-2', alsoRemoveFromBackup: true },
        a.options(),
      ),
    ]);

    expect(await runGitText(a.backupPath, ['status', '--porcelain'])).toBe('');
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('第一条');
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-2')).toBeNull();
  });
});

describe('离线与未推送的删除', () => {
  /** 把远端仓库挪走来模拟断网。 */
  async function goOffline(): Promise<void> {
    await rm(`${remotePath}.away`, { recursive: true, force: true });
    await rename(remotePath, `${remotePath}.away`);
  }

  async function goOnline(): Promise<void> {
    await rename(`${remotePath}.away`, remotePath);
  }

  it('连不上私有 Git 时照样在本机备份，只是如实说一声', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await goOffline();

    const result = await runSessionSync(a.options());

    expect(result.backedUp).toBe(1);
    expect(result.pushed).toBe(false);
    expect(result.notes.join()).toContain('只在本机备份');
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toContain('第一条');
  });

  it('恢复联网后把落下的提交一起带上去', async () => {
    const a = await makeMachine('a');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await goOffline();
    await runSessionSync(a.options());
    await goOnline();

    const result = await runSessionSync(a.options());

    expect(result.pushed).toBe(true);
    const b = await makeMachine('b');
    expect((await runSessionSync(b.options())).restored).toBe(1);
  });

  it('离线时做的删除不会在下次同步被悄悄撤销', async () => {
    const a = await makeMachine('a');
    const b = await makeMachine('b');
    await writeLocalSession(a, 'session-1', [line('第一条')]);
    await runSessionSync(a.options());
    await runSessionSync(b.options());

    // A 机断网时删掉这条会话，墓碑只存在本机。
    await goOffline();
    await trashLocalSession(
      { provider: 'claude', providerSessionId: 'session-1', alsoRemoveFromBackup: true },
      a.options(),
    );
    await goOnline();

    // 恢复联网后同步：对齐远端会丢掉本机提交，墓碑必须被补回去。
    const result = await runSessionSync(a.options());

    expect(result.restored).toBe(0);
    expect(await readBackupTranscript(a.backupPath, 'claude', 'session-1')).toBeNull();
    expect(await readBackupMeta(a.backupPath, 'claude', 'session-1')).toMatchObject({ deleted: true });
    // B 机随后会看到这条删除，而不是继续持有一条"复活"的会话。
    expect((await runSessionSync(b.options())).pending[0]?.relation).toBe('backup-deleted');
  });
});
