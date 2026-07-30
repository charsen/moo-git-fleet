import { describe, expect, it } from 'vitest';
import {
  autoActionFor,
  completeContent,
  commonPrefixLength,
  sessionRelation,
  splitTranscript,
  transcriptSnapshot,
} from './compare.js';

const a = '{"type":"user","text":"a"}';
const b = '{"type":"assistant","text":"b"}';
const c = '{"type":"user","text":"c"}';

describe('splitTranscript', () => {
  it('去掉行尾 CR 与结尾空行', () => {
    expect(splitTranscript(`${a}\r\n${b}\n\n\n`)).toEqual([a, b]);
  });

  it('空内容得到空数组', () => {
    expect(splitTranscript('')).toEqual([]);
    expect(splitTranscript('\n')).toEqual([]);
  });
});

describe('completeContent', () => {
  it('去掉还没写完的最后一行', () => {
    expect(completeContent(`${a}\n${b}\n{"type":"user"`)).toBe(`${a}\n${b}\n`);
  });

  it('以换行结尾的内容原样保留', () => {
    expect(completeContent(`${a}\n${b}\n`)).toBe(`${a}\n${b}\n`);
    expect(completeContent('')).toBe('');
  });

  it('整个文件只有半行时得到空内容', () => {
    expect(completeContent('{"type":')).toBe('');
  });
});

describe('sessionRelation', () => {
  it('内容一致时为 same，行尾差异不算分叉', () => {
    expect(sessionRelation({ local: [a, b], backup: [a, b] })).toBe('same');
    expect(sessionRelation({
      local: splitTranscript(`${a}\n${b}\n`),
      backup: splitTranscript(`${a}\r\n${b}`),
    })).toBe('same');
  });

  it('只有一边有内容', () => {
    expect(sessionRelation({ local: [a], backup: null })).toBe('local-only');
    expect(sessionRelation({ local: null, backup: [a] })).toBe('backup-only');
    expect(sessionRelation({ local: null, backup: null })).toBe('same');
  });

  it('一边是另一边的前缀时判为追加方向', () => {
    expect(sessionRelation({ local: [a, b, c], backup: [a, b] })).toBe('local-ahead');
    expect(sessionRelation({ local: [a], backup: [a, b] })).toBe('backup-ahead');
  });

  it('同长度但内容不同判为分叉', () => {
    expect(sessionRelation({ local: [a, b], backup: [a, c] })).toBe('diverged');
  });

  it('从同一处各写各的判为分叉', () => {
    expect(sessionRelation({ local: [a, b, c], backup: [a, c] })).toBe('diverged');
  });

  it('墓碑：本机还在时要问用户，本机也没有时无需处理', () => {
    expect(sessionRelation({ local: [a], backup: null, backupDeleted: true })).toBe('backup-deleted');
    expect(sessionRelation({ local: null, backup: null, backupDeleted: true })).toBe('same');
  });

  it('墓碑优先于内容比对，不会把已删除的会话同步回来', () => {
    expect(sessionRelation({ local: [a, b], backup: [a, b], backupDeleted: true })).toBe('backup-deleted');
  });
});

describe('autoActionFor', () => {
  it('只有分叉与墓碑需要用户决定', () => {
    expect(autoActionFor('same')).toBe('skip');
    expect(autoActionFor('local-only')).toBe('write-backup');
    expect(autoActionFor('local-ahead')).toBe('write-backup');
    expect(autoActionFor('backup-only')).toBe('write-local');
    expect(autoActionFor('backup-ahead')).toBe('write-local');
    expect(autoActionFor('diverged')).toBe('ask');
    expect(autoActionFor('backup-deleted')).toBe('ask');
  });
});

describe('transcriptSnapshot', () => {
  it('同样内容得到同样摘要，不同内容摘要不同', () => {
    const content = `${a}\n${b}\n`;
    expect(transcriptSnapshot(content).sha256).toBe(transcriptSnapshot(content).sha256);
    expect(transcriptSnapshot(content).sha256).not.toBe(transcriptSnapshot(`${a}\n${c}\n`).sha256);
    expect(transcriptSnapshot(content).bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(transcriptSnapshot(content).lines).toEqual([a, b]);
  });
});

describe('commonPrefixLength', () => {
  it('给出从第几条开始各写各的', () => {
    expect(commonPrefixLength([a, b, c], [a, b])).toBe(2);
    expect(commonPrefixLength([a, b], [c])).toBe(0);
    expect(commonPrefixLength([], [a])).toBe(0);
  });
});
