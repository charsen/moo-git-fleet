import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupStoreError,
  assertSafeSessionId,
  listBackupSessions,
  readBackupMeta,
  readBackupTranscript,
  transcriptPath,
  writeBackupSession,
  writeBackupTombstone,
} from './backup-store.js';

const details = {
  title: '重构分支切换流程',
  projectId: 'remote:abc',
  projectPath: '/work/moo-git-fleet',
  repositoryName: 'moo-git-fleet',
  lastActivityAt: '2026-07-30T10:00:00.000Z',
  sourceRelativePath: 'projects/-work-moo-git-fleet/session-a.jsonl',
  messageCount: 2,
};

let backupPath = '';

beforeEach(async () => {
  backupPath = await mkdtemp(path.join(os.tmpdir(), 'fleet-backup-store-'));
});

afterEach(async () => {
  await rm(backupPath, { recursive: true, force: true });
});

describe('assertSafeSessionId', () => {
  it('拒绝会跳出备份目录的会话 ID', () => {
    expect(() => assertSafeSessionId('../../etc/passwd')).toThrow(BackupStoreError);
    expect(() => assertSafeSessionId('a/b')).toThrow(BackupStoreError);
    expect(() => assertSafeSessionId('')).toThrow(BackupStoreError);
    expect(assertSafeSessionId('0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33')).toBe('0f2b1c84-6d3a-4e91-b7c5-2ad9e6f10b33');
  });
});

describe('writeBackupSession', () => {
  it('写出会话原文与说明，摘要与内容一致', async () => {
    const content = '{"a":1}\n{"b":2}\n';
    const meta = await writeBackupSession({
      backupPath,
      provider: 'claude',
      providerSessionId: 'session-a',
      content,
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });

    expect(meta.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(meta.deleted).toBe(false);
    expect(meta.device).toBe('公司 Mac');
    expect(await readBackupTranscript(backupPath, 'claude', 'session-a')).toBe(content);
    expect(await readBackupMeta(backupPath, 'claude', 'session-a')).toEqual(meta);
    expect(await readFile(transcriptPath(backupPath, 'claude', 'session-a'), 'utf8')).toBe(content);
  });

  it('从源文件拷贝时摘要与内容一致，结果和写字符串一样', async () => {
    const sourcePath = path.join(backupPath, 'source.jsonl');
    const content = '{"a":1}\n{"b":2}\n';
    await writeFile(sourcePath, content);

    const copied = await writeBackupSession({
      backupPath,
      provider: 'claude',
      providerSessionId: 'from-file',
      sourcePath,
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });
    const written = await writeBackupSession({
      backupPath,
      provider: 'claude',
      providerSessionId: 'from-string',
      content,
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });

    expect(copied.sha256).toBe(written.sha256);
    expect(copied.bytes).toBe(written.bytes);
    expect(await readBackupTranscript(backupPath, 'claude', 'from-file')).toBe(content);
  });

  it('重复写入是覆盖，不留副本', async () => {
    const write = (content: string) => writeBackupSession({
      backupPath,
      provider: 'claude',
      providerSessionId: 'session-a',
      content,
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });
    await write('{"a":1}\n');
    await write('{"a":1}\n{"b":2}\n');

    expect(await readBackupTranscript(backupPath, 'claude', 'session-a')).toBe('{"a":1}\n{"b":2}\n');
    expect(await listBackupSessions(backupPath)).toHaveLength(1);
  });
});

describe('writeBackupTombstone', () => {
  it('删掉原文只留墓碑，保留标题与项目信息', async () => {
    const previous = await writeBackupSession({
      backupPath,
      provider: 'codex',
      providerSessionId: 'session-b',
      content: '{"a":1}\n',
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });

    const tombstone = await writeBackupTombstone({
      backupPath,
      provider: 'codex',
      providerSessionId: 'session-b',
      device: '家里 Mac',
      now: new Date('2026-07-30T13:00:00.000Z'),
      previous,
    });

    expect(tombstone.deleted).toBe(true);
    expect(tombstone.deletedAt).toBe('2026-07-30T13:00:00.000Z');
    expect(tombstone.title).toBe(details.title);
    expect(await readBackupTranscript(backupPath, 'codex', 'session-b')).toBeNull();
  });

  it('备份里原本就没有这条会话时也能写墓碑', async () => {
    const tombstone = await writeBackupTombstone({
      backupPath,
      provider: 'claude',
      providerSessionId: 'session-c',
      device: '家里 Mac',
      now: new Date('2026-07-30T13:00:00.000Z'),
    });
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.projectId).toBe('unknown');
  });
});

describe('listBackupSessions', () => {
  it('备份仓为空或不存在时返回空数组', async () => {
    expect(await listBackupSessions(backupPath)).toEqual([]);
    expect(await listBackupSessions(path.join(backupPath, 'missing'))).toEqual([]);
  });

  it('列出两个 provider 的会话，按最后写入时间倒序，并标出是否有原文', async () => {
    await writeBackupSession({
      backupPath,
      provider: 'claude',
      providerSessionId: 'session-a',
      content: '{"a":1}\n',
      device: '公司 Mac',
      now: new Date('2026-07-30T12:00:00.000Z'),
      details,
    });
    await writeBackupSession({
      backupPath,
      provider: 'codex',
      providerSessionId: 'session-b',
      content: '{"b":2}\n',
      device: '家里 Mac',
      now: new Date('2026-07-30T14:00:00.000Z'),
      details,
    });
    await writeBackupTombstone({
      backupPath,
      provider: 'claude',
      providerSessionId: 'session-d',
      device: '家里 Mac',
      now: new Date('2026-07-30T13:00:00.000Z'),
    });

    const entries = await listBackupSessions(backupPath);
    expect(entries.map((entry) => entry.meta.providerSessionId)).toEqual(['session-b', 'session-d', 'session-a']);
    expect(entries.map((entry) => entry.hasTranscript)).toEqual([true, false, true]);
  });
});
