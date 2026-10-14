/**
 * 文件清单的树形结构。
 *
 * 展开状态用「被折叠的目录集合」表达，而不是「被展开的集合」——默认全展开（空集合），
 * 用户折叠过的目录才进集合。用一个集合同时表达「默认展开」和「逐个折叠」，
 * 避免再加一个 defaultOpen 开关来兜底。
 */

export interface FileTreeNode {
  kind: 'directory' | 'file';
  /** 只显示这一层名字；完整路径在 `path`。 */
  name: string;
  /** 目录是 `a/b`，文件是 `a/b/c.txt`。 */
  path: string;
  children: FileTreeNode[];
  /** 目录下递归的文件数；文件恒为 1。 */
  fileCount: number;
}

export interface FileTreeRow {
  node: FileTreeNode;
  depth: number;
}

interface DraftNode {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  children: Map<string, DraftNode>;
}

function toNodes(level: Map<string, DraftNode>): FileTreeNode[] {
  return [...level.values()]
    .map((draft): FileTreeNode => {
      if (draft.kind === 'file') {
        return { kind: 'file', name: draft.name, path: draft.path, children: [], fileCount: 1 };
      }
      const children = toNodes(draft.children);
      return {
        kind: 'directory',
        name: draft.name,
        path: draft.path,
        children,
        fileCount: children.reduce((sum, child) => sum + child.fileCount, 0),
      };
    })
    // 目录在前，同类按名称排序；排序只看本层 name，所以同一份输入顺序稳定。
    .sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name));
}

/** 从文件路径建树。重复路径只保留一条；空路径跳过。 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root = new Map<string, DraftNode>();
  for (const fullPath of paths) {
    const segments = fullPath.split('/').filter(Boolean);
    if (!segments.length) continue;
    let level = root;
    let prefix = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let node = level.get(segment);
      if (!node) {
        node = { kind: isLeaf ? 'file' : 'directory', name: segment, path: prefix, children: new Map() };
        level.set(segment, node);
      }
      level = node.children;
    }
  }
  return toNodes(root);
}

/** 按「已折叠目录」集合把树摊平成可见行，带 depth，供渲染与键盘导航共用。 */
export function flattenTree(
  nodes: FileTreeNode[],
  collapsed: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const walk = (list: FileTreeNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth });
      if (node.kind === 'directory' && node.children.length && !collapsed.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return rows;
}

/** 文件路径的所有祖先目录（由浅到深）；顶层文件返回空数组。 */
export function directoryAncestors(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  let prefix = '';
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]!;
    ancestors.push(prefix);
  }
  return ancestors;
}

/** 搜索时把命中文件的祖先目录全部展开，返回新的折叠集合。 */
export function expandAncestorsOf(
  collapsed: ReadonlySet<string>,
  paths: string[],
): Set<string> {
  if (!collapsed.size) return new Set(collapsed);
  const next = new Set(collapsed);
  for (const path of paths) {
    for (const ancestor of directoryAncestors(path)) next.delete(ancestor);
  }
  return next;
}
