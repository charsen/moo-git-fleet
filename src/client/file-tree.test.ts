import { describe, expect, it } from 'vitest';
import { buildFileTree, directoryAncestors, expandAncestorsOf, flattenTree } from './file-tree';

describe('buildFileTree', () => {
  it('nests paths and puts directories before files at every level', () => {
    const tree = buildFileTree(['src/b.ts', 'src/a.ts', 'docs/readme.md', 'root.txt']);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      'directory:docs',
      'directory:src',
      'file:root.txt',
    ]);
    expect(tree[1]?.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts']);
    expect(tree[1]?.path).toBe('src');
    expect(tree[1]?.children[0]?.path).toBe('src/a.ts');
  });

  it('counts files recursively and marks files with 1', () => {
    const tree = buildFileTree(['src/a/b/c.ts', 'src/a/d.ts', 'src/e.ts']);
    const src = tree[0]!;
    const a = src.children[0]!;
    expect(src.fileCount).toBe(3);
    expect(a.fileCount).toBe(2);
    expect(a.children[0]?.fileCount).toBe(1);
  });

  it('ignores duplicates and empty paths', () => {
    const tree = buildFileTree(['src/a.ts', 'src/a.ts', '', '/']);
    expect(tree.map((node) => node.path)).toEqual(['src']);
    expect(tree[0]?.fileCount).toBe(1);
  });

  it('returns an empty tree for no paths', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('flattenTree', () => {
  const tree = buildFileTree(['src/a.ts', 'src/deep/b.ts', 'top.txt']);

  it('expands everything when nothing is collapsed', () => {
    expect(flattenTree(tree, new Set()).map((row) => [row.depth, row.node.name])).toEqual([
      [0, 'src'],
      [1, 'deep'],
      [2, 'b.ts'],
      [1, 'a.ts'],
      [0, 'top.txt'],
    ]);
  });

  it('hides the children of a collapsed directory but keeps the row itself', () => {
    expect(flattenTree(tree, new Set(['src'])).map((row) => row.node.name)).toEqual(['src', 'top.txt']);
    expect(flattenTree(tree, new Set(['src', 'src/deep'])).map((row) => row.node.name)).toEqual(['src', 'top.txt']);
    expect(flattenTree(tree, new Set(['src/deep'])).map((row) => [row.depth, row.node.name])).toEqual([
      [0, 'src'],
      [1, 'deep'],
      [1, 'a.ts'],
      [0, 'top.txt'],
    ]);
  });
});

describe('directoryAncestors', () => {
  it('lists every ancestor from the shallowest down', () => {
    expect(directoryAncestors('a/b/c/d.txt')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(directoryAncestors('a.txt')).toEqual([]);
  });
});

describe('expandAncestorsOf', () => {
  it('reopens every ancestor of the given files and leaves unrelated directories collapsed', () => {
    const collapsed = new Set(['src', 'src/deep', 'docs']);
    // 命中文件在 src/deep 下，两层祖先都要展开；docs 与它无关，保持折叠。
    expect(expandAncestorsOf(collapsed, ['src/deep/b.ts'])).toEqual(new Set(['docs']));
    expect(expandAncestorsOf(collapsed, ['src/a.ts'])).toEqual(new Set(['docs', 'src/deep']));
    expect(expandAncestorsOf(collapsed, ['top.txt'])).toEqual(new Set(['docs', 'src', 'src/deep']));
  });

  it('returns an equivalent empty set when nothing is collapsed', () => {
    expect([...expandAncestorsOf(new Set(), ['src/a.ts'])]).toEqual([]);
  });
});
