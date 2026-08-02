import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { runGitText } from '../git/runner.js';
import {
  BackupRepoError,
  alignToRemote,
  backupStatus,
  commitAll,
  deviceName,
  fetchBackupRemote,
  initializeBackup,
  listBackupCandidates,
  localHead,
  loadBackupBinding,
  pushBackup,
  recordSyncResult,
  remoteHead,
  requireBackupBinding,
} from './backup-repo.js';

let workspace = '';
let bindingPath = '';

function options(overrides: { fleetRepositoryPath?: string } = {}) {
  return { bindingPath, fleetRepositoryPath: overrides.fleetRepositoryPath ?? path.join(workspace, 'fleet-source') };
}

/** 造一个已经配好 origin 的空仓库，模拟「用户自己 clone 下来的空私仓」。 */
async function repositoryWithOrigin(directory: string, remoteUrl: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await runGitText(directory, ['init', '--initial-branch=main']);
  await runGitText(directory, ['remote', 'add', 'origin', remoteUrl]);
  return directory;
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'fleet-backup-repo-'));
  bindingPath = path.join(workspace, 'config', 'session-backup.json');
  await mkdir(path.join(workspace, 'fleet-source'), { recursive: true });
  await runGitText(path.join(workspace, 'fleet-source'), ['init', '--initial-branch=main']);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('initializeBackup', () => {
  it('在空目录里建好备份仓并记住位置', async () => {
    const status = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());

    expect(status.configured).toBe(true);
    expect(status.remoteUrl).toBeNull();
    expect(status.device).toBe(deviceName());
    expect(await runGitText(status.backupPath!, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect((await loadBackupBinding(options()))?.backupPath).toBe(status.backupPath);
  });

  it('没填位置时用建议位置', async () => {
    const status = await initializeBackup({}, options());
    expect(status.suggestedBackupPath).toBe(path.join(workspace, 'session-backup'));
    expect(status.backupPath).toBe(await realpath(path.join(workspace, 'session-backup')));
  });

  it('拒绝写进 Moo Fleet 自己的源码仓库', async () => {
    await expect(
      initializeBackup({ backupPath: path.join(workspace, 'fleet-source', 'sessions') }, options()),
    ).rejects.toThrow(BackupRepoError);
  });

  it('拒绝嵌套在别的 Git 仓库里', async () => {
    const outer = path.join(workspace, 'outer');
    await mkdir(outer, { recursive: true });
    await runGitText(outer, ['init', '--initial-branch=main']);

    await expect(initializeBackup({ backupPath: path.join(outer, 'backup') }, options())).rejects.toThrow(
      BackupRepoError,
    );
  });

  it('拒绝非空的普通目录', async () => {
    const dirty = path.join(workspace, 'dirty');
    await mkdir(dirty, { recursive: true });
    await writeFile(path.join(dirty, 'note.txt'), 'hi');

    await expect(initializeBackup({ backupPath: dirty }, options())).rejects.toThrow(BackupRepoError);
  });

  it('拒绝一个已经装着别的内容的 Git 仓库（同步会 reset --hard 抹掉它）', async () => {
    const notes = path.join(workspace, 'my-notes');
    await mkdir(notes, { recursive: true });
    await runGitText(notes, ['init', '--initial-branch=main']);
    await writeFile(path.join(notes, 'note.md'), '别删我\n');
    await runGitText(notes, ['add', '-A']);
    await runGitText(notes, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'my notes']);

    await expect(initializeBackup({ backupPath: notes }, options())).rejects.toThrow(/已经有别的内容/);
    expect(await readFile(path.join(notes, 'note.md'), 'utf8')).toBe('别删我\n');
  });

  it('接受还没有任何提交的空仓库，并把分支统一到 main', async () => {
    const empty = path.join(workspace, 'empty-repo');
    await mkdir(empty, { recursive: true });
    await runGitText(empty, ['init', '--initial-branch=master']);

    const status = await initializeBackup({ backupPath: empty }, options());

    expect(status.configured).toBe(true);
    expect(await runGitText(empty, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });

  it('重新连接自己建过的备份仓不会被拦下', async () => {
    const first = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    await commitAll(first.backupPath!, '首次备份');

    const again = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    expect(again.configured).toBe(true);
  });

  it('从刚 clone 下来的空仓库里自动读出 origin', async () => {
    const remotePath = path.join(workspace, 'remote.git');
    await mkdir(remotePath, { recursive: true });
    await runGitText(remotePath, ['init', '--bare', '--initial-branch=main']);
    const clone = path.join(workspace, 'clone');
    await runGitText(workspace, ['clone', remotePath, clone]);

    const status = await initializeBackup({ backupPath: clone }, options());

    expect(status.configured).toBe(true);
    expect(status.remoteName).toBe('origin');
    expect(status.remoteUrl).toBe(remotePath);
  });

  it('没有 origin 的空目录只备份在本机', async () => {
    const status = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    expect(status.remoteUrl).toBeNull();
    expect(status.remoteName).toBeNull();
  });

  it('拒绝 origin 里内嵌账号密码的仓库', async () => {
    const withCredentials = await repositoryWithOrigin(
      path.join(workspace, 'credentials'),
      'https://user:token@example.com/sessions.git',
    );

    await expect(initializeBackup({ backupPath: withCredentials }, options())).rejects.toThrow(/不带账号密码/);
    expect(await loadBackupBinding(options())).toBeNull();
  });

  it('重复设置跟着仓库自己的 origin 走，且保留创建时间', async () => {
    const backup = path.join(workspace, 'backup');
    const first = await initializeBackup({ backupPath: backup }, options());
    expect(first.remoteUrl).toBeNull();
    const createdAt = (await loadBackupBinding(options()))?.createdAt;

    await runGitText(first.backupPath!, ['remote', 'add', 'origin', 'https://example.com/b.git']);
    const second = await initializeBackup({ backupPath: backup }, options());

    expect(second.remoteUrl).toBe('https://example.com/b.git');
    expect(second.remoteName).toBe('origin');
    expect((await loadBackupBinding(options()))?.createdAt).toBe(createdAt);
    expect(first.backupPath).toBe(second.backupPath);
  });
});

describe('listBackupCandidates', () => {
  function repositoriesConfig(rootPath: string): RepositoriesConfig {
    return {
      version: 1,
      settings: {
        roots: { fixture: rootPath },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [],
    };
  }

  it('只列出会话备份仓和空仓库，普通仓库不出现', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-backup-candidates-')));
    try {
      const backupRepository = path.join(root, 'ai-sessions');
      await repositoryWithOrigin(backupRepository, 'https://example.test/you/ai-sessions.git');
      await writeFile(
        path.join(backupRepository, 'fleet.json'),
        '{"schemaVersion":1,"kind":"moo-fleet-session-backup"}\n',
      );

      const emptyClone = path.join(root, 'empty-clone');
      await repositoryWithOrigin(emptyClone, 'https://example.test/you/empty.git');

      const ordinary = path.join(root, 'my-notes');
      await mkdir(ordinary, { recursive: true });
      await runGitText(ordinary, ['init', '--initial-branch=main']);
      await writeFile(path.join(ordinary, 'note.md'), '别删我\n');
      await runGitText(ordinary, ['add', '-A']);
      await runGitText(ordinary, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'notes']);

      const candidates = await listBackupCandidates({ ...options(), config: repositoriesConfig(root) });

      expect(candidates.map((candidate) => candidate.name)).toEqual(['ai-sessions', 'empty-clone']);
      expect(candidates[0]).toMatchObject({
        path: backupRepository,
        kind: 'session-backup',
        remoteUrl: 'https://example.test/you/ai-sessions.git',
      });
      expect(candidates[1]).toMatchObject({ path: emptyClone, kind: 'empty-repo' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('没有远端的空仓库 remoteUrl 为 null', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-backup-candidates-')));
    try {
      const bare = path.join(root, 'no-remote');
      await mkdir(bare, { recursive: true });
      await runGitText(bare, ['init', '--initial-branch=main']);

      const candidates = await listBackupCandidates({ ...options(), config: repositoriesConfig(root) });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ name: 'no-remote', kind: 'empty-repo', remoteUrl: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('requireBackupBinding', () => {
  it('没设置过就报错', async () => {
    await expect(requireBackupBinding(options())).rejects.toThrow(BackupRepoError);
  });

  it('备份目录还在但 .git 被删掉时给出能看懂的提示', async () => {
    const status = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    await rm(path.join(status.backupPath!, '.git'), { recursive: true, force: true });

    await expect(requireBackupBinding(options())).rejects.toThrow(/已经不是一个 Git 仓库/);
  });

  it('备份目录被移走后报错', async () => {
    const status = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    await rm(status.backupPath!, { recursive: true, force: true });
    await expect(requireBackupBinding(options())).rejects.toThrow(BackupRepoError);
  });
});

describe('commitAll', () => {
  it('没有改动时不产生提交', async () => {
    const status = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    expect(await commitAll(status.backupPath!, '首次备份')).toBe(true);
    expect(await commitAll(status.backupPath!, '再来一次')).toBe(false);
  });

  it('有新会话文件时提交一次', async () => {
    const status = await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());
    await commitAll(status.backupPath!, '首次备份');
    await mkdir(path.join(status.backupPath!, 'sessions', 'claude'), { recursive: true });
    await writeFile(path.join(status.backupPath!, 'sessions', 'claude', 'a.jsonl'), '{"a":1}\n');

    expect(await commitAll(status.backupPath!, '备份 1 条会话')).toBe(true);
    expect(await runGitText(status.backupPath!, ['log', '--oneline'])).toContain('备份 1 条会话');
  });
});

describe('跨电脑往返', () => {
  it('A 机推送后 B 机 fetch 并对齐到同一内容', async () => {
    const remotePath = path.join(workspace, 'remote.git');
    await mkdir(remotePath, { recursive: true });
    await runGitText(remotePath, ['init', '--bare', '--initial-branch=main']);

    const machineA = await initializeBackup(
      { backupPath: await repositoryWithOrigin(path.join(workspace, 'a'), remotePath) },
      options(),
    );
    await mkdir(path.join(machineA.backupPath!, 'sessions', 'claude'), { recursive: true });
    await writeFile(path.join(machineA.backupPath!, 'sessions', 'claude', 'a.jsonl'), '{"a":1}\n');
    await commitAll(machineA.backupPath!, '备份来自 A 机');
    await pushBackup(machineA.backupPath!, 'origin');

    const bindingB = path.join(workspace, 'config-b', 'session-backup.json');
    const machineB = await initializeBackup(
      { backupPath: await repositoryWithOrigin(path.join(workspace, 'b'), remotePath) },
      { ...options(), bindingPath: bindingB },
    );
    await fetchBackupRemote(machineB.backupPath!, 'origin');
    const head = await remoteHead(machineB.backupPath!, 'origin');
    expect(head).toBeTruthy();
    await alignToRemote(machineB.backupPath!, head!);

    expect(await localHead(machineB.backupPath!)).toBe(head);
    expect(await runGitText(machineB.backupPath!, ['show', '--stat', '--format=%s', 'HEAD'])).toContain('备份来自 A 机');
  });

  it('连不上远端时返回原因而不是抛错，让本机备份照常进行', async () => {
    const status = await initializeBackup(
      {
        backupPath: await repositoryWithOrigin(
          path.join(workspace, 'offline'),
          path.join(workspace, 'does-not-exist.git'),
        ),
      },
      options(),
    );

    const failure = await fetchBackupRemote(status.backupPath!, 'origin');
    expect(failure).toBeTruthy();
    expect(await pushBackup(status.backupPath!, 'origin')).toBeNull(); // 空仓库没东西可推
  });

  it('远端还是空仓库时 fetch 不报错', async () => {
    const remotePath = path.join(workspace, 'empty.git');
    await mkdir(remotePath, { recursive: true });
    await runGitText(remotePath, ['init', '--bare', '--initial-branch=main']);
    const status = await initializeBackup(
      { backupPath: await repositoryWithOrigin(path.join(workspace, 'backup'), remotePath) },
      options(),
    );

    expect(await fetchBackupRemote(status.backupPath!, 'origin')).toBeNull();
    expect(await remoteHead(status.backupPath!, 'origin')).toBeNull();
  });
});

describe('recordSyncResult', () => {
  it('成功时记录时间，失败时记录原因且不更新成功时间', async () => {
    await initializeBackup({ backupPath: path.join(workspace, 'backup') }, options());

    await recordSyncResult({ at: '2026-07-30T12:00:00.000Z', error: null }, options());
    expect((await backupStatus(options())).lastSyncAt).toBe('2026-07-30T12:00:00.000Z');

    await recordSyncResult({ at: '2026-07-30T13:00:00.000Z', error: '网络不通' }, options());
    const status = await backupStatus(options());
    expect(status.lastSyncAt).toBe('2026-07-30T12:00:00.000Z');
    expect(status.lastError).toBe('网络不通');
  });
});
