import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorSample } from './author-identity.js';
import type { CommitCodeVolume } from './code-volume.js';
import {
  cacheVersion,
  flushScanRecords,
  loadScanRecord,
  resetScanRecordQueue,
  scheduleScanRecordSave,
  type CachedScan,
} from './scan-cache.js';

const temporaryDirectories: string[] = [];
let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'mf-scan-cache-'));
  temporaryDirectories.push(home);
  process.env.GIT_FLEET_HOME = home;
  resetScanRecordQueue();
});

afterEach(async () => {
  resetScanRecordQueue();
  delete process.env.GIT_FLEET_HOME;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 与 scan-cache 内部同一套命名：路径 sha1 + .json。 */
function recordPathFor(cwd: string): string {
  return path.join(home, '.data', 'analytics-scan', `${createHash('sha1').update(cwd).digest('hex')}.json`);
}

const author = (name: string, email: string, commits: number): AuthorSample => ({
  name,
  email,
  commits,
  additions: 120,
  deletions: 40,
});

const commitVolume = (sha: string): CommitCodeVolume => ({
  sha,
  authorDate: '2026-10-30',
  name: 'Charsen',
  email: 'charsen@example.test',
  totals: { additions: 120, deletions: 40, files: 3, excludedFiles: 1, binaryFiles: 0 },
});

function sampleScan(signature: string): CachedScan {
  const sha = 'a'.repeat(40);
  const days = new Map([
    [
      '2026-10-30',
      {
        count: 2,
        hours: Array.from({ length: 24 }, (_, hour) => (hour === 21 ? 2 : 0)),
        authors: new Map([['charsen\u0000charsen@example.test', author('Charsen', 'charsen@example.test', 2)]]),
      },
    ],
    [
      '2026-10-31',
      {
        count: 1,
        hours: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 1 : 0)),
        authors: new Map([['charsen\u0000charsen@example.test', author('Charsen', 'charsen@example.test', 1)]]),
      },
    ],
  ]);
  return {
    signature,
    log: {
      days,
      allAuthors: new Map([['charsen\u0000charsen@example.test', author('Charsen', 'charsen@example.test', 3)]]),
      minutes: [1290, 1291, 540],
      lastDate: '2026-10-31',
    },
    volumeCommits: new Map([[sha, commitVolume(sha)]]),
    volumeScannedFrom: '2026-08-01',
    minuteCount: 3,
    dayCount: 2,
  };
}

describe('scan cache 落盘', () => {
  it('写完读回来逐字段相同', async () => {
    const cwd = path.join(home, 'repository');
    const entry = sampleScan('sig-1');
    scheduleScanRecordSave(cwd, entry);
    await flushScanRecords();

    const loaded = await loadScanRecord(cwd, 'sig-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.signature).toBe('sig-1');
    expect(loaded?.volumeScannedFrom).toBe('2026-08-01');
    expect(loaded?.minuteCount).toBe(3);
    expect(loaded?.dayCount).toBe(2);
    expect(loaded?.log.minutes).toEqual([1290, 1291, 540]);
    expect(loaded?.log.lastDate).toBe('2026-10-31');
    expect([...(loaded?.log.days.keys() ?? [])]).toEqual(['2026-10-30', '2026-10-31']);
    expect(loaded?.log.days.get('2026-10-30')?.count).toBe(2);
    expect(loaded?.log.days.get('2026-10-30')?.hours[21]).toBe(2);
    expect(loaded?.log.days.get('2026-10-30')?.authors.get('charsen\u0000charsen@example.test')).toEqual(
      author('Charsen', 'charsen@example.test', 2),
    );
    expect(loaded?.log.allAuthors.size).toBe(1);
    expect(loaded?.volumeCommits.get('a'.repeat(40))?.totals.additions).toBe(120);
  });

  it('签名变了就当没有缓存', async () => {
    const cwd = path.join(home, 'repository');
    scheduleScanRecordSave(cwd, sampleScan('sig-1'));
    await flushScanRecords();

    expect(await loadScanRecord(cwd, 'sig-2')).toBeNull();
  });

  it('同一个仓库重复保存只留最后一份', async () => {
    const cwd = path.join(home, 'repository');
    scheduleScanRecordSave(cwd, sampleScan('sig-old'));
    scheduleScanRecordSave(cwd, sampleScan('sig-new'));
    await flushScanRecords();

    expect(await loadScanRecord(cwd, 'sig-old')).toBeNull();
    expect(await loadScanRecord(cwd, 'sig-new')).not.toBeNull();
  });

  it('文件坏了返回 null，不抛异常', async () => {
    const cwd = path.join(home, 'repository');
    scheduleScanRecordSave(cwd, sampleScan('sig-1'));
    await flushScanRecords();
    await writeFile(recordPathFor(cwd), '{"version":1,"cwd":', 'utf8');

    expect(await loadScanRecord(cwd, 'sig-1')).toBeNull();
  });

  it('版本号不符返回 null', async () => {
    const cwd = path.join(home, 'repository');
    scheduleScanRecordSave(cwd, sampleScan('sig-1'));
    await flushScanRecords();
    const raw = JSON.parse(await readFile(recordPathFor(cwd), 'utf8')) as Record<string, unknown>;
    await writeFile(recordPathFor(cwd), JSON.stringify({ ...raw, version: cacheVersion + 1 }), 'utf8');

    expect(await loadScanRecord(cwd, 'sig-1')).toBeNull();
  });

  it('字段形状不对（天数与小时数对不上）返回 null', async () => {
    const cwd = path.join(home, 'repository');
    scheduleScanRecordSave(cwd, sampleScan('sig-1'));
    await flushScanRecords();
    const raw = JSON.parse(await readFile(recordPathFor(cwd), 'utf8')) as { log: { days: unknown[] } };
    // 少一个字段的桶：半份缓存比没有缓存更危险，必须整条丢掉
    raw.log.days = [['2026-10-30', 2, [1, 2], []]];
    await writeFile(recordPathFor(cwd), JSON.stringify(raw), 'utf8');

    expect(await loadScanRecord(cwd, 'sig-1')).toBeNull();
  });

  it('记录里的 cwd 与请求不符返回 null', async () => {
    const cwd = path.join(home, 'repository');
    scheduleScanRecordSave(cwd, sampleScan('sig-1'));
    await flushScanRecords();
    const raw = JSON.parse(await readFile(recordPathFor(cwd), 'utf8')) as Record<string, unknown>;
    await writeFile(recordPathFor(cwd), JSON.stringify({ ...raw, cwd: path.join(home, 'other') }), 'utf8');

    expect(await loadScanRecord(cwd, 'sig-1')).toBeNull();
  });

  it('没有写过缓存时返回 null', async () => {
    expect(await loadScanRecord(path.join(home, 'never-scanned'), 'sig-1')).toBeNull();
  });
});
