/**
 * 提交图泳道布局——**贯穿式泳道跟踪**（不是逐行拼碎片）。
 *
 * 每条泳道有稳定的 laneId + 颜色，在它存活期间不变；相邻两行里同一条泳道占同一列时，
 * 输出的是同一 laneId 的竖直段，前端把首尾相接的竖段合并成一条连续路径——避免「行间接缝断线」
 * 和「走到一半换色」。
 *
 * 数据模型：columns[i] 是第 i 列当前占用的泳道（含 id/color/target）；逐行（新→旧）推进：
 *   1. 记下本行开始前每列占用的泳道（这些泳道竖直穿过本行）；
 *   2. 本行提交落在「等待它的最左列」；同时等待它的其它列作为汇入边弯进节点后终止；
 *   3. 第一父继承本列泳道（保持颜色），其余父复用已在等待的列、否则新开泳道；
 *   4. 每列输出本行竖直段；节点拆成「上沿→圆心」与「圆心→下沿」，保证线接到圆心。
 *
 * 两条硬约束（前端断线/悬空线都源自违反它们）：
 *   - **汇入列只画到节点圆心（toY=0.5），不能再输出整行竖段**。否则节点下方会多出一截
 *     没有终点的短线（早期实现在合并提交处会出现「线头悬空」）。
 *   - 任何在本行下沿（toY=1）结束的段，下一行同一列必须有从 0 开始的段；否则画面会断。
 */

/** 行高与列宽：组件用同一组常量渲染，避免 CSS 与 JS 各写一份导致圆圈与行错位。 */
export const GRAPH_ROW_HEIGHT = 48;
/** 理想列宽；泳道多到放不下时按 graphLaneWidth 压缩。 */
export const GRAPH_LANE_WIDTH = 18;
/** 泳道区右侧留白（节点圆半径 + 呼吸空间）。 */
export const GRAPH_LANE_GUTTER = 10;
/** 可用的泳道色槽数量，与 repository-workspace.css 的 .graph-lane-* 一一对应。 */
export const GRAPH_LANE_COLORS = 16;

export interface GraphSegment {
  /** 本段所属泳道 id（同一条线的多段 id 相同 → 前端合并成一条连续路径）。 */
  laneId: number;
  /** 着色槽位（0..GRAPH_LANE_COLORS-1），由布局分配，保证同时存在的泳道颜色不重复。 */
  color: number;
  /** 上沿列。 */
  from: number;
  /** 下沿列。 */
  to: number;
  /** 本段属于行内第几行（用于计算 y 坐标）。 */
  row: number;
  /** 段起点在本行内的相对高度：0=行上沿，0.5=节点（行中）。 */
  fromY: number;
  /** 段终点在本行内的相对高度：0.5=节点，1=行下沿。 */
  toY: number;
  /** 是否为主干（页面第一条提交所在泳道）。 */
  primary: boolean;
}

export interface CommitGraphRow {
  lane: number;
  laneCount: number;
  merge: boolean;
}

export interface CommitGraphNode {
  /** 所在行。 */
  row: number;
  /** 所在列。 */
  lane: number;
  /** 该提交节点所在泳道的 laneId——与穿过该节点的竖线用的是同一个 laneId，保证圆圈颜色和线一致。 */
  laneId: number;
  /** 与线同色的色槽。 */
  color: number;
}

export interface CommitGraphLayout {
  rows: CommitGraphRow[];
  segments: GraphSegment[];
  /** 每行提交节点的位置与泳道 id（颜色取自同一 laneId，杜绝「圈色和线色对不上」）。 */
  nodes: CommitGraphNode[];
  laneCount: number;
}

interface Lane {
  id: number;
  color: number;
  /** 当前泳道在等哪个提交（父提交哈希）；只有达到该提交时泳道才结束或改指向。 */
  target: string;
  /** 主干泳道（页面第一条提交所在泳道），渲染时加粗。 */
  primary: boolean;
}

/**
 * 给新泳道挑一个「当前没被占用」的色槽；只要并发泳道不超过 16 条，同时存在的泳道就不会同色。
 *
 * 并发泳道超过 16 条时必然降级：新泳道只能复用已被占用的槽，此时只保证「与左邻不同色」
 * （左邻是视觉上最容易对比的位置）。已知权衡：降级期创建的泳道，在并发回落到 16 以内后
 * 仍可能和另一条泳道残留同色——16 槽的物理上限没有完美解（min-count 等着色策略实测无收益，
 * 2026-11-20 review 已验证），密集段靠 busy 压暗兜底。不要试图在降级期做完美着色。
 */
function pickColor(columns: (Lane | null)[], index: number): number {
  const used = new Set<number>();
  for (const lane of columns) if (lane) used.add(lane.color);
  for (let slot = 0; slot < GRAPH_LANE_COLORS; slot += 1) if (!used.has(slot)) return slot;
  // 泳道数超过色槽数：至少保证与左邻不同色。
  const left = columns[index - 1]?.color;
  for (let step = 0; step < GRAPH_LANE_COLORS; step += 1) {
    const slot = (index + step) % GRAPH_LANE_COLORS;
    if (slot !== left) return slot;
  }
  return index % GRAPH_LANE_COLORS;
}

export function layoutCommitGraph(commits: { hash: string; parents?: string[] }[]): CommitGraphLayout {
  const columns: (Lane | null)[] = [];
  const rows: CommitGraphRow[] = [];
  const segments: GraphSegment[] = [];
  const nodes: CommitGraphNode[] = [];
  let laneSeq = 0;
  let maxColumns = 1;

  const ensure = (index: number) => { while (columns.length <= index) columns.push(null); };
  const createLane = (target: string, index: number, primary: boolean): Lane => {
    ensure(index);
    const lane: Lane = { id: laneSeq++, color: pickColor(columns, index), target, primary };
    columns[index] = lane;
    return lane;
  };
  const push = (lane: Lane, from: number, to: number, row: number, fromY: number, toY: number) => {
    segments.push({ laneId: lane.id, color: lane.color, from, to, row, fromY, toY, primary: lane.primary });
  };

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row]!;
    const parents = commit.parents ?? [];
    // before：本行开始前每列占用的泳道；这些泳道都要竖直穿过本行（汇入列除外）。
    const before = columns.slice();

    // 1) 本行提交所在列：最左那个「泳道 target === 本提交哈希」的列；没有则新开一列并建泳道。
    let laneCol = before.findIndex(lane => lane?.target === commit.hash);
    if (laneCol === -1) {
      laneCol = columns.findIndex(lane => lane === null);
      if (laneCol === -1) laneCol = columns.length;
      createLane(commit.hash, laneCol, row === 0);
    }
    const nodeLane = columns[laneCol]!;

    // 2) 其它也在等这个提交的列：本行把它们「汇入」nodeLane，作为独立颜色段弯到节点后终止。
    //    注意这些列不能再画整行竖段，否则节点下方会留一截无终点的线头。
    const converging = new Set<number>();
    for (let i = 0; i < before.length; i += 1) {
      if (i === laneCol || before[i]?.target !== commit.hash) continue;
      const lane = before[i]!;
      converging.add(i);
      push(lane, i, laneCol, row, 0, 0.5);
      columns[i] = null;
    }

    // 3) 输出本行被占用的竖直穿行段（节点列与汇入列除外）。
    for (let i = 0; i < before.length; i += 1) {
      if (!before[i] || i === laneCol || converging.has(i)) continue;
      push(before[i]!, i, i, row, 0, 1);
    }

    // 4) 节点入线：只有本行之前该列已被占用（上方确有来线）时才画，避免分支头悬出一截空线。
    if (before[laneCol]) push(nodeLane, laneCol, laneCol, row, 0, 0.5);

    // 5) 父边：第一父继承本列泳道；其余父复用已在等待的列，否则新开一列。
    if (parents.length === 0) {
      columns[laneCol] = null;
    } else {
      const [firstParent, ...rest] = parents;
      nodeLane.target = firstParent ?? commit.hash;
      push(nodeLane, laneCol, laneCol, row, 0.5, 1);
      for (const parent of rest) {
        let col = columns.findIndex((lane, index) => index !== laneCol && lane?.target === parent);
        if (col === -1) {
          col = columns.findIndex((lane, index) => index !== laneCol && lane === null);
          if (col === -1) col = columns.length;
          createLane(parent, col, false);
        }
        // 曲线用目标泳道的颜色：它代表「父提交所在分支」的那条线。
        push(columns[col]!, laneCol, col, row, 0.5, 1);
      }
    }

    // 6) 裁剪尾部空列，记录本行宽度。
    while (columns.length > 0 && columns.at(-1) === null) columns.pop();
    const rowColumns = Math.max(columns.length, laneCol + 1);
    maxColumns = Math.max(maxColumns, rowColumns);
    rows.push({ lane: laneCol, laneCount: Math.max(1, rowColumns), merge: parents.length > 1 });
    nodes.push({ row, lane: laneCol, laneId: nodeLane.id, color: nodeLane.color });
  }

  return { rows, segments, nodes, laneCount: Math.max(1, maxColumns) };
}

export function foldBranchLabels(branches: string[], max = 3): { visible: string[]; hidden: number } {
  const unique = [...new Set(branches.filter(Boolean))];
  if (unique.length <= max) return { visible: unique, hidden: 0 };
  return { visible: unique.slice(0, max), hidden: unique.length - max };
}

/**
 * 提交图行内的引用折叠：先合并「本地 + 同名远端」的重复标签（同一提交上 「main」 与 「origin/main」
 * 同时出现只是噪音），再按上限截断，其余用 +N 表示。
 * 只合并无路径的同名分支：带斜杠的远端分支（origin/fix/x）与本地 fix/x 无法在这里可靠区分，
 * 宁可多显示一个标签，也不能把真实的本地分支误删。
 */
export function foldCommitRefs(branches: string[], max = 3): { visible: string[]; hidden: number } {
  const unique = [...new Set(branches.filter(Boolean))];
  const bare = new Set(unique.filter((name) => !name.includes('/')));
  const kept = unique.filter((name) => {
    const slash = name.indexOf('/');
    return slash === -1 || !bare.has(name.slice(slash + 1));
  });
  return foldBranchLabels(kept, max);
}

/** 泳道过密时压缩列宽：提交正文永远要留有可读宽度，图不能把标题挤没。
 *  panelWidth 是提交图面板的可用宽度；返回每列像素宽度（4..18）。 */
export function graphLaneWidth(laneCount: number, panelWidth: number): number {
  const maxGutter = Math.max(140, Math.min(460, Math.round(panelWidth * 0.36)));
  const natural = Math.max(1, laneCount) * GRAPH_LANE_WIDTH + GRAPH_LANE_GUTTER;
  if (natural <= maxGutter) return GRAPH_LANE_WIDTH;
  // 不设最小列宽：几十条泳道时还能保持可分辨；上百条时列宽会细到 1px 左右，
  // 但图列宽度必须严格服从上限，否则 master 那种 200+ 泳道会把提交标题再次挤没。
  return Math.max(0, (maxGutter - GRAPH_LANE_GUTTER) / Math.max(1, laneCount));
}
