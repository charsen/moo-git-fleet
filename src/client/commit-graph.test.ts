import { describe, expect, it } from 'vitest';
import { GRAPH_LANE_COLORS, GRAPH_LANE_GUTTER, GRAPH_LANE_WIDTH, foldBranchLabels, foldCommitRefs, graphLaneWidth, layoutCommitGraph, type CommitGraphLayout } from './commit-graph';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

/**
 * 画面连续性：从某行下沿（toY=1）出去的段，下一行同一列必须有一条从 0 开始的段；
 * 反之任何从 0 开始的段，上一行同一列必须有一条到 1 结束的段。
 * 悬空线头（合并提交处曾出现）与断线都会被这条断言抓到。
 */
function expectContinuous(layout: CommitGraphLayout): void {
  const { segments, nodes } = layout;
  for (const segment of segments) {
    if (segment.toY === 0.5) {
      const node = nodes[segment.row];
      expect(node, '汇入段必须落在本行节点上').toBeDefined();
      expect(segment.to, '汇入段终点必须是节点所在列').toBe(node!.lane);
    }
    if (segment.toY === 1 && segment.row + 1 < nodes.length) {
      const next = segments.filter(s => s.row === segment.row + 1 && s.from === segment.to && s.fromY === 0);
      expect(next.length, '第 ' + segment.row + ' 行第 ' + segment.to + ' 列下沿出去后断线').toBeGreaterThan(0);
    }
    if (segment.fromY === 0 && segment.row > 0) {
      const previous = segments.filter(s => s.row === segment.row - 1 && s.to === segment.from && s.toY === 1);
      expect(previous.length, '第 ' + segment.row + ' 行第 ' + segment.from + ' 列上方没有来线').toBeGreaterThan(0);
    }
  }
}

function expectDistinctLaneColors(layout: CommitGraphLayout): void {
  const byLane = new Map<number, number>();
  for (const segment of layout.segments) byLane.set(segment.laneId, segment.color);
  const colors = [...byLane.values()];
  expect(new Set(colors).size).toBe(colors.length);
  for (const color of colors) {
    expect(color).toBeGreaterThanOrEqual(0);
    expect(color).toBeLessThan(GRAPH_LANE_COLORS);
  }
  for (const node of layout.nodes) expect(node.color).toBe(byLane.get(node.laneId));
}

describe('layoutCommitGraph (lane tracking)', () => {
  it('keeps a linear history on one lane with continuous verticals', () => {
    const { rows, segments, nodes, laneCount } = layoutCommitGraph([c('a', 'b'), c('b', 'c'), c('c')]);
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0]);
    expect(segments.every(s => s.from === 0)).toBe(true);
    expect(new Set(segments.map(s => s.laneId)).size).toBe(1);
    expect(nodes.map(n => n.laneId)).toEqual([0, 0, 0]);
    expectContinuous({ rows, segments, nodes, laneCount });
  });

  it('splits a merge into a primary lane (same id) and a branch lane (new id)', () => {
    // a 合并：父 b（主线）与 d（旁支）
    const { rows, segments } = layoutCommitGraph([c('a', 'b', 'd'), c('b'), c('d')]);
    expect(rows[0]!.merge).toBe(true);
    const row0 = segments.filter(s => s.row === 0);
    expect(row0.some(s => s.from !== s.to)).toBe(true);
    const primaryIds = new Set(row0.filter(s => s.primary).map(s => s.laneId));
    expect(primaryIds.size).toBe(1);
  });

  it('gives a long-running branch a stable laneId so its color never changes', () => {
    const { segments } = layoutCommitGraph([c('a', 'b', 'd'), c('b1', 'b2'), c('b2', 'd'), c('d')]);
    const byLane = new Map<number, number[]>();
    for (const s of segments) { const arr = byLane.get(s.laneId) ?? []; if (!arr.includes(s.row)) arr.push(s.row); byLane.set(s.laneId, arr); }
    for (const [id, rowsCovered] of byLane) {
      const sorted = [...rowsCovered].sort((x, y) => x - y);
      const contiguous = sorted.every((r, i) => i === 0 || r === sorted[i - 1]! + 1);
      expect(contiguous, 'lane ' + id + ' 覆盖行 ' + sorted + ' 必须连续').toBe(true);
    }
  });

  it('gives each node the same laneId as the vertical line through it (circle color == line color)', () => {
    const commits = [
      c('m', 'm2', 'devtip'), c('m2', 'base'),
      c('devtip', 'f4', 'devA'), c('devA', 'f3', 'devB'), c('devB', 'f2', 'devC'), c('devC', 'f1', 'base'),
      c('f4', 'fb4'), c('f3', 'fb3'), c('f2', 'fb2'), c('f1', 'fb1'),
      c('base'), c('fb4'), c('fb3'), c('fb2'), c('fb1'),
    ];
    const { segments, nodes, rows, laneCount } = layoutCommitGraph(commits);
    for (const node of nodes) {
      const through = segments.filter(s => s.row === node.row && s.from === node.lane && s.to === node.lane);
      if (through.length === 0) continue;
      expect(through.map(s => s.laneId)).toContain(node.laneId);
    }
    expectContinuous({ segments, nodes, rows, laneCount });
  });

  it('folds a shared parent back into the node without a stub below it', () => {
    // 复刻真实仓库的形状：merge 的第二父与 x 的第一父是同一个 base，两个分支先后入队，最后汇入 base。
    const commits = [
      c('tip', 'merge'), c('merge', 'x', 'base'), c('x', 'side'), c('side', 'base'), c('base', 'older'), c('older'),
    ];
    const layout = layoutCommitGraph(commits);
    expectContinuous(layout);
    const base = layout.nodes.find(node => node.row === 4)!;
    // base 行只有一条竖线穿过节点；节点下方是它的第一父（older）那条主干，不应该再有第二列留在原地。
    const below = layout.segments.filter(s => s.row > base.row && s.from === s.to);
    expect(new Set(below.map(s => s.from)).size).toBe(1);
  });

  it('keeps a merge-heavy dev shape continuous and compact', () => {
    const commits = [
      c('8cbe', '2543'), c('4bc4', 'c3f8', '2543'), c('2543', '8b3e'), c('c3f8', '25d6', '8b3e'),
      c('8b3e', 'de45'), c('de45', '33e3', '9b4c'), c('25d6', '219d', '9b4c'), c('33e3', '06e8', '2768'),
      c('219d', '9f33', '2768'), c('9f33', '4a4c', '06e8'), c('2768', '6374'), c('06e8', '6374'),
      c('4a4c', 'b52b', '6374'), c('6374', '96a4'), c('b52b', '5c52', '96a4'), c('96a4', 'b798'), c('9b4c', '719f'),
      c('5c52', 'b798'), c('b798', 'c7f5'), c('719f', '904b'), c('c7f5'), c('904b'),
    ];
    const layout = layoutCommitGraph(commits);
    expectContinuous(layout);
    expectDistinctLaneColors(layout);
    // 6374 落在第 13 行；汇入它的那一列在本行结束，不应再有竖直段穿到下一行。
    const node = layout.nodes[13]!;
    expect(layout.segments.filter(s => s.row > 13 && s.from === s.to && s.from === 3)).toHaveLength(0);
    expect(node.lane).toBeGreaterThanOrEqual(0);
  });

  it('assigns distinct colors to concurrent lanes and avoids palette collisions', () => {
    const commits = [c('a', 'b', 'c'), c('b', 'd'), c('c', 'd'), c('d')];
    expectDistinctLaneColors(layoutCommitGraph(commits));
  });

  it('超出色槽数时仍保证相邻泳道不同色（降级期的硬保证）', () => {
    // 造一个稳定产生 17+ 并发泳道的形状：每条提交都合并一条新旁支，泳道只增不减。
    const commits: Array<{ hash: string; parents: string[] }> = [];
    const branches: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const hash = 'c' + i;
      const parents = ['p' + i];
      if (i % 2 === 0) { branches.push('b' + i); parents.push('b' + i); }
      commits.push({ hash, parents });
      // 每条旁支两行后就汇回，保持「主干 + 一批并行旁支」的密集形态。
      commits.push({ hash: 'b' + i, parents: ['p' + (i + 1)] });
    }
    commits.push({ hash: 'p30', parents: [] });
    const layout = layoutCommitGraph(commits);
    expect(layout.laneCount).toBeGreaterThan(16);
    for (const segment of layout.segments) {
      if (segment.from !== segment.to) continue;
      const neighbor = layout.segments.find(
        (other) => other.row === segment.row && other.from === segment.to + 1 && other.from === other.to,
      );
      if (neighbor) expect(neighbor.color, '行 ' + segment.row + ' 列 ' + segment.to + ' 与右邻同色').not.toBe(segment.color);
    }
    expectContinuous(layout);
  });

  it('tolerates out-of-page parents without throwing', () => {
    const { rows, segments } = layoutCommitGraph([c('a', 'missing-parent')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lane).toBe(0);
    expect(segments.length).toBeGreaterThan(0);
  });

  it('handles an empty history and commits without parents', () => {
    expect(layoutCommitGraph([])).toEqual({ rows: [], segments: [], nodes: [], laneCount: 1 });
    expect(layoutCommitGraph([c('root')]).segments).toEqual([]);
  });

  it('does not mutate the input commit list', () => {
    const commits = [c('a', 'b', 'c'), c('b'), c('c')];
    const snapshot = JSON.stringify(commits);
    layoutCommitGraph(commits);
    expect(JSON.stringify(commits)).toBe(snapshot);
  });
});

describe('graphLaneWidth', () => {
  it('keeps the ideal width when the graph fits', () => {
    expect(graphLaneWidth(3, 1165)).toBe(GRAPH_LANE_WIDTH);
  });
  it('compresses lanes so the commit text keeps room on a dense branch tree', () => {
    // 合并密集的仓库在 100 条提交里会开出 60+ 条并行泳道；按 18px 排会把标题挤出面板。
    const width = graphLaneWidth(66, 1165);
    expect(width).toBeLessThan(9);
    expect(66 * width + GRAPH_LANE_GUTTER).toBeLessThanOrEqual(Math.round(1165 * 0.36));
    expect(width).toBeGreaterThan(1);
  });
  it('never lets the graph column exceed its width cap, even with hundreds of lanes', () => {
    // 不再有最小列宽兜底：227 条泳道时列宽约 1.8px，图列严格卡在 36% 上限内，标题不会被挤没。
    for (const panel of [740, 1024, 1165, 1600]) {
      const maxGutter = Math.max(140, Math.min(460, Math.round(panel * 0.36)));
      for (const count of [1, 8, 66, 227, 500, 1000]) {
        const width = graphLaneWidth(count, panel);
        expect(count * width + GRAPH_LANE_GUTTER, 'panel ' + panel + ' lanes ' + count).toBeLessThanOrEqual(maxGutter + 1e-9);
      }
    }
  });
  it('is monotonic in lane count', () => {
    let previous = graphLaneWidth(1, 900);
    for (let count = 2; count <= 200; count += 7) {
      const width = graphLaneWidth(count, 900);
      expect(width).toBeLessThanOrEqual(previous);
      previous = width;
    }
  });
});

describe('foldBranchLabels', () => {
  it('returns all labels when within the limit', () => {
    expect(foldBranchLabels(['main', 'origin/main'], 3)).toEqual({ visible: ['main', 'origin/main'], hidden: 0 });
  });
  it('folds the overflow into a hidden count', () => {
    expect(foldBranchLabels(['main', 'dev', 'origin/main', 'origin/dev', 'feat'], 3)).toEqual({ visible: ['main', 'dev', 'origin/main'], hidden: 2 });
  });
  it('deduplicates and drops blanks', () => {
    expect(foldBranchLabels(['main', '', 'main'], 5)).toEqual({ visible: ['main'], hidden: 0 });
  });
});

describe('foldCommitRefs', () => {
  it('drops a remote tracking branch when the local branch is shown too', () => {
    expect(foldCommitRefs(['main', 'origin/main', 'dev'], 3)).toEqual({ visible: ['main', 'dev'], hidden: 0 });
    expect(foldCommitRefs(['main', 'upstream/main'], 3)).toEqual({ visible: ['main'], hidden: 0 });
  });
  it('keeps a remote branch that has no local counterpart', () => {
    expect(foldCommitRefs(['origin/release', 'main'], 3)).toEqual({ visible: ['origin/release', 'main'], hidden: 0 });
  });
  it('folds the overflow after deduplication', () => {
    expect(foldCommitRefs(['a', 'origin/a', 'b', 'origin/b', 'c', 'd'], 3)).toEqual({ visible: ['a', 'b', 'c'], hidden: 1 });
  });
});
