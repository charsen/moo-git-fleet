import { describe, expect, it } from 'vitest';
import { fileExistsInWorktree, fileMenuItems } from './repository-workspace';

describe('file menu items', () => {
  it('groups ignore, local exclude and file actions for a tracked-eligible file', () => {
    const items = fileMenuItems({ path: 'src/a b.txt', exists: true });
    expect(items.map((item) => item.id)).toEqual([
      'ignore-path',
      'ignore-name',
      'ignore-pattern',
      'exclude-path',
      'exclude-name',
      'exclude-pattern',
      'reveal',
      'editor',
      'copy-path',
    ]);
    // 每组第一项带组标题，后面的项沿用同一标题，ActionMenu 只在变化处插分隔线。
    expect(items[0]?.section).toBe(items[1]?.section);
    expect(items[2]?.section).not.toBe(items[3]?.section);
    expect(items[5]?.section).not.toBe(items[6]?.section);
    expect(items.every((item) => item.disabled === null)).toBe(true);
  });

  it('uses the file name in the same-name rule and trims a directory slash', () => {
    const items = fileMenuItems({ path: 'node_modules/', exists: true });
    const sameName = items.find((item) => item.id === 'ignore-name');
    expect(sameName?.label).toContain('node_modules');
    expect(sameName?.label).not.toContain('/）');
  });

  it('replaces the ignore section with "no longer ignore" for an already ignored entry', () => {
    const items = fileMenuItems({ path: 'dist/', ignored: true });
    expect(items.map((item) => item.id)).toEqual(['unignore', 'reveal', 'editor', 'copy-path']);
    expect(items[0]?.label).toBe('不再忽略');
    expect(items.every((item) => item.disabled === null)).toBe(true);
    expect(items[1]?.section).not.toBe(items[0]?.section);
  });

  it('disables opening when the file is no longer in the worktree', () => {
    const items = fileMenuItems({ path: 'gone.txt', exists: false });
    expect(items.find((item) => item.id === 'reveal')?.disabled).toBe('文件已不在工作区');
    expect(items.find((item) => item.id === 'editor')?.disabled).toBe('文件已不在工作区');
    expect(items.find((item) => item.id === 'copy-path')?.disabled).toBeNull();
  });
});

describe('worktree file existence', () => {
  it('treats deleted index or worktree states as missing', () => {
    expect(fileExistsInWorktree({ indexStatus: ' ', worktreeStatus: 'M' })).toBe(true);
    expect(fileExistsInWorktree({ indexStatus: '?', worktreeStatus: '?' })).toBe(true);
    expect(fileExistsInWorktree({ indexStatus: 'D', worktreeStatus: ' ' })).toBe(false);
    expect(fileExistsInWorktree({ indexStatus: ' ', worktreeStatus: 'D' })).toBe(false);
  });
});
