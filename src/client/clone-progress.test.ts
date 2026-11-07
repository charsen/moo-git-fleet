import { describe, expect, it } from 'vitest';
import type { CloneProgress } from '../shared/contracts';
import { clonePhaseLabel, cloneProgressText, cloneProgressWidth } from './clone-progress';

function progress(overrides: Partial<CloneProgress> = {}): CloneProgress {
  return { phase: 'receiving', percent: 45, current: 450, total: 1000, size: null, speed: null, ...overrides };
}

describe('cloneProgressText', () => {
  it('把阶段、百分比、数量、体积与速率拼成一行', () => {
    expect(cloneProgressText(progress({ size: '12.30 MiB', speed: '1.50 MiB/s' }))).toBe(
      '接收对象 45%（450/1000） · 12.30 MiB · 1.50 MiB/s',
    );
  });

  it('没有体积与速率时只给阶段与百分比', () => {
    expect(cloneProgressText(progress({ size: null, speed: null }))).toBe('接收对象 45%（450/1000）');
  });

  it('没有百分比时只给阶段名——这时给 0% 是假的', () => {
    expect(cloneProgressText({ phase: 'connecting', percent: null, current: null, total: null, size: null, speed: null })).toBe(
      '正在连接远端',
    );
  });

  it('每个阶段都有中文名（英文原文对用户没有意义）', () => {
    expect(clonePhaseLabel('counting')).toBe('远端统计对象');
    expect(clonePhaseLabel('resolving')).toBe('解析增量');
    expect(clonePhaseLabel('checkout')).toBe('检出文件');
  });
});

describe('cloneProgressWidth', () => {
  it('没有进度或没有百分比时不画条', () => {
    expect(cloneProgressWidth(null)).toBeNull();
    expect(cloneProgressWidth(progress({ percent: null }))).toBeNull();
  });

  it('把百分比夹在 0–100，越界值不会把条撑出容器', () => {
    expect(cloneProgressWidth(progress({ percent: 45 }))).toBe(45);
    expect(cloneProgressWidth(progress({ percent: 140 }))).toBe(100);
    expect(cloneProgressWidth(progress({ percent: -5 }))).toBe(0);
  });
});
