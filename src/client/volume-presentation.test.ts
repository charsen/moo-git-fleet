import { describe, expect, it } from 'vitest';
import type { CommitCodeVolumeSummary } from '../shared/contracts';
import { formatLines, totalLines, volumeBreakdown, volumeParts } from './volume-presentation';

function volume(patch: Partial<CommitCodeVolumeSummary> = {}): CommitCodeVolumeSummary {
  return { additions: 0, deletions: 0, files: 0, excludedFiles: 0, binaryFiles: 0, ...patch };
}

describe('formatLines', () => {
  it('一万以下给原数，带千分位', () => {
    expect(formatLines(0)).toBe('0');
    expect(formatLines(1)).toBe('1');
    expect(formatLines(9_999)).toBe('9,999');
  });

  it('过万用「万」，一位小数；整数不留 .0', () => {
    expect(formatLines(10_000)).toBe('1 万');
    expect(formatLines(123_456)).toBe('12.3 万');
    expect(formatLines(2_439_000)).toBe('243.9 万');
  });

  it('过亿切到「亿」', () => {
    expect(formatLines(240_000_000)).toBe('2.4 亿');
    expect(formatLines(1_000_000_000)).toBe('10 亿');
  });

  it('负数与非数不显示成 NaN', () => {
    expect(formatLines(-5)).toBe('0');
    expect(formatLines(Number.NaN)).toBe('0');
    expect(formatLines(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('volumeParts', () => {
  it('新增在前、删除在后，占比之和 100%', () => {
    const parts = volumeParts(volume({ additions: 1_200, deletions: 400 }));
    const total = parts.reduce((sum, part) => sum + part.share, 0);

    expect(parts.map((part) => part.key)).toEqual(['additions', 'deletions']);
    expect(total).toBeCloseTo(100, 10);
    expect(parts[0].share).toBe(75);
  });

  it('总量为零时不给宽度，也不会算出 NaN', () => {
    const parts = volumeParts(volume());

    expect(parts.every((part) => part.share === 0)).toBe(true);
    expect(parts.every((part) => Number.isFinite(part.share))).toBe(true);
  });

  it('只有新增时它独占整条（新建文件不产生删除行）', () => {
    const parts = volumeParts(volume({ additions: 500 }));

    expect(parts[0].share).toBe(100);
    expect(parts[1].share).toBe(0);
  });
});

describe('totalLines', () => {
  it('大数字是增删之和', () => {
    expect(totalLines(volume({ additions: 7, deletions: 3 }))).toBe(10);
  });
});

describe('volumeBreakdown', () => {
  it('带正负号，方便和条形图例对读', () => {
    expect(volumeBreakdown(volume({ additions: 12_000, deletions: 300 }))).toBe('+1.2 万 / −300');
  });
});
