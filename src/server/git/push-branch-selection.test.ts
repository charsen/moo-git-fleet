import { describe, expect, it } from 'vitest';
import type { PushBranchCandidate } from '../../shared/contracts.js';
import { pushableFirst, selectBranchesForModes, selectionSkipMessage } from './push-branch-selection.js';

function candidate(name: string, update: Partial<PushBranchCandidate> = {}): PushBranchCandidate {
  return {
    name,
    head: 'a'.repeat(40),
    upstream: `origin/${name}`,
    remote: 'origin',
    remoteRef: `refs/heads/${name}`,
    ahead: 1,
    behind: 0,
    current: false,
    blocker: null,
    ...update,
  };
}

describe('批量多分支的档位解析', () => {
  it('当前分支 + 主分支 + dev 一起命中三条分支', () => {
    const selection = selectBranchesForModes(
      {
        branches: [candidate('dev'), candidate('main', { current: true }), candidate('feature')],
        defaultBranch: 'main',
      },
      ['current', 'default', 'dev'],
    );
    expect(selection.targets.map((branch) => branch.name)).toEqual(['dev', 'main']);
    expect(selection.skipped).toEqual([]);
  });

  it('当前分支与主分支重合时不重复列出', () => {
    const selection = selectBranchesForModes(
      { branches: [candidate('main', { current: true })], defaultBranch: 'main' },
      ['current', 'default'],
    );
    expect(selection.targets.map((branch) => branch.name)).toEqual(['main']);
  });

  it('dev 档同时认 develop', () => {
    const selection = selectBranchesForModes(
      { branches: [candidate('develop'), candidate('main')], defaultBranch: 'main' },
      ['dev'],
    );
    expect(selection.targets.map((branch) => branch.name)).toEqual(['develop']);
  });

  it('仓库没有 dev 时说明缺席原因，而不是静默少推一条', () => {
    const selection = selectBranchesForModes(
      { branches: [candidate('main', { current: true })], defaultBranch: 'main' },
      ['current', 'dev'],
    );
    expect(selection.targets.map((branch) => branch.name)).toEqual(['main']);
    expect(selection.skipped).toEqual([{ name: 'dev', reason: '仓库没有 dev 或 develop 分支' }]);
  });

  it('分支级阻塞转为跳过原因，不进 targets', () => {
    const selection = selectBranchesForModes(
      {
        branches: [candidate('main', { current: true }), candidate('dev', { behind: 3, blocker: '落后远端 3 个提交，需先同步' })],
        defaultBranch: 'main',
      },
      ['current', 'default', 'dev'],
    );
    expect(selection.targets.map((branch) => branch.name)).toEqual(['main']);
    expect(selection.skipped).toEqual([{ name: 'dev', reason: '落后远端 3 个提交，需先同步' }]);
  });

  it('读不到远端默认分支时把这一档记成缺席', () => {
    const selection = selectBranchesForModes(
      { branches: [candidate('work', { current: true })], defaultBranch: null },
      ['current', 'default'],
    );
    expect(selection.targets.map((branch) => branch.name)).toEqual(['work']);
    expect(selection.skipped).toEqual([
      { name: '主分支', reason: '读不到远端默认分支（没有 origin/HEAD，也没有可跟踪的 main / master）' },
    ]);
  });

  it('Detached HEAD 下当前分支档缺席', () => {
    const selection = selectBranchesForModes(
      { branches: [candidate('main')], defaultBranch: 'main' },
      ['current'],
    );
    expect(selection.targets).toEqual([]);
    expect(selection.skipped).toEqual([{ name: '当前分支', reason: '处于 Detached HEAD，没有当前分支' }]);
  });
});

describe('整仓跳过的说明文案', () => {
  it('把每个缺席原因串成一句', () => {
    expect(
      selectionSkipMessage({
        targets: [],
        skipped: [
          { name: 'dev', reason: '没有 upstream' },
          { name: 'main', reason: '没有需要推送的提交' },
        ],
      }),
    ).toBe('已跳过（dev：没有 upstream；main：没有需要推送的提交）');
  });

  it('没有选中任何分支时给出中性说法', () => {
    expect(selectionSkipMessage({ targets: [], skipped: [] })).toBe('没有需要推送的分支');
  });
});

describe('预览清单的排序', () => {
  it('可推的排前面，同组内保持原顺序', () => {
    const rows = [
      { name: 'idle-a', pushable: false },
      { name: 'busy-1', pushable: true },
      { name: 'idle-b', pushable: false },
      { name: 'busy-2', pushable: true },
    ];
    expect(pushableFirst(rows, (row) => row.pushable).map((row) => row.name)).toEqual([
      'busy-1',
      'busy-2',
      'idle-a',
      'idle-b',
    ]);
  });

  it('不改动传入的数组', () => {
    const rows = [{ pushable: false }, { pushable: true }];
    pushableFirst(rows, (row) => row.pushable);
    expect(rows.map((row) => row.pushable)).toEqual([false, true]);
  });
});
