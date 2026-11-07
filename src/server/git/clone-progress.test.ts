import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloneProgress } from '../../shared/contracts.js';
import {
  beginCloneProgress,
  CloneProgressParser,
  initialCloneProgress,
  readCloneProgress,
  resetCloneProgress,
} from './clone-progress.js';

/** 把若干片段喂给解析器，收集所有上报的快照。 */
function collect(chunks: string[]): CloneProgress[] {
  const reported: CloneProgress[] = [];
  const parser = new CloneProgressParser((progress) => reported.push(progress));
  for (const chunk of chunks) parser.push(chunk);
  return reported;
}

afterEach(() => {
  resetCloneProgress();
  vi.useRealTimers();
});

describe('CloneProgressParser', () => {
  it('按 \\r 刷新切分，逐条报出接收阶段的百分比', () => {
    const reported = collect([
      "Cloning into 'demo'...\n",
      'Receiving objects:  10% (10/100), 1.00 MiB | 2.00 MiB/s\r',
      'Receiving objects:  55% (55/100), 5.50 MiB | 2.75 MiB/s\r',
      'Receiving objects: 100% (100/100), 10.00 MiB | 2.50 MiB/s, done.\r',
    ]);

    expect(reported.map((item) => [item.phase, item.percent])).toEqual([
      ['connecting', null],
      ['receiving', 10],
      ['receiving', 55],
      ['receiving', 100],
    ]);
    expect(reported[2]).toEqual({
      phase: 'receiving',
      percent: 55,
      current: 55,
      total: 100,
      size: '5.50 MiB',
      speed: '2.75 MiB/s',
    });
  });

  it('半行被拆到两个 chunk 里也能拼回来', () => {
    // 真实场景：管道一次读到的字节数不按行对齐。
    const reported = collect([
      'Receiving obj',
      'ects:  45% (45/100), 1.20 MiB\r',
    ]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.percent).toBe(45);
    expect(reported[0]?.size).toBe('1.20 MiB');
    // 没有速率时不该编一个出来
    expect(reported[0]?.speed).toBeNull();
  });

  it('小仓库的 `100% (5/5), done.` 没有体积与速率，照样解析', () => {
    const [progress] = collect(['Receiving objects: 100% (5/5), done.\r']);
    expect(progress).toEqual({
      phase: 'receiving',
      percent: 100,
      current: 5,
      total: 5,
      size: null,
      speed: null,
    });
  });

  it('识别远端阶段、解析增量与检出', () => {
    const reported = collect([
      'remote: Enumerating objects: 5, done.\n',
      'remote: Counting objects: 100% (5/5), done.\n',
      'remote: Compressing objects:  50% (1/2)\r',
      'Resolving deltas: 100% (2/2), done.\n',
      'Updating files:  60% (3/5)\r',
      'Updating files: 100% (5/5), done.\n',
    ]);
    expect(reported.map((item) => [item.phase, item.percent])).toEqual([
      ['counting', 100],
      ['compressing', 50],
      ['resolving', 100],
      ['checkout', 60],
      ['checkout', 100],
    ]);
    // `remote: Enumerating` 不单独成阶段：它后面紧跟 Counting，报出来只会闪一下。
    expect(reported.some((item) => item.phase === 'connecting')).toBe(false);
  });

  it('同一阶段的同一百分比只报一次（git 每 1% 刷一行，不必逐行推给客户端）', () => {
    const reported = collect([
      'Receiving objects:  45% (45/100), 1.00 MiB\r',
      'Receiving objects:  45% (45/100), 1.01 MiB\r',
      'Receiving objects:  46% (46/100), 1.02 MiB\r',
    ]);
    expect(reported.map((item) => item.percent)).toEqual([45, 46]);
  });

  it('进度行没有换行时缓冲不会无限增长，之后仍能对齐到完整行', () => {
    const reported: CloneProgress[] = [];
    const parser = new CloneProgressParser((progress) => reported.push(progress));
    // 5 KB 一个换行都没有：缓冲要自我截断，否则一个畸形输出就能把内存吃满。
    parser.push('x'.repeat(5000));
    parser.push('\rReceiving objects:  20% (2/10)\r');
    expect(reported.map((item) => item.percent)).toEqual([20]);
  });
});

describe('克隆进度表', () => {
  it('开槽后立刻可读到一个「正在连接」的快照', () => {
    const id = 'clone-00000000-0000-4000-8000-000000000000';
    beginCloneProgress(id);
    expect(readCloneProgress(id)).toEqual(initialCloneProgress());
    expect(readCloneProgress('clone-unknown')).toBeNull();
  });

  it('上报会覆盖快照，不同 id 互不干扰', () => {
    const first = beginCloneProgress('clone-aaaaaaaa');
    const second = beginCloneProgress('clone-bbbbbbbb');
    first({ phase: 'receiving', percent: 30, current: 3, total: 10, size: null, speed: null });
    second({ phase: 'checkout', percent: 90, current: 9, total: 10, size: null, speed: null });

    expect(readCloneProgress('clone-aaaaaaaa')?.percent).toBe(30);
    expect(readCloneProgress('clone-bbbbbbbb')?.phase).toBe('checkout');
  });

  it('一分钟没有更新就清掉，避免克隆结束后残留一条过期进度', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    beginCloneProgress('clone-stale');
    expect(readCloneProgress('clone-stale')).not.toBeNull();

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
    expect(readCloneProgress('clone-stale')).toBeNull();
  });
});
