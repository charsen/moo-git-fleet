import { describe, expect, it } from 'vitest';
import type { FileChange } from '../shared/contracts';
import { checkedUncommittedPaths, fileExistsInWorktree, fileMenuItems } from './repository-workspace';

function file(overrides: Partial<FileChange> & Pick<FileChange, 'path'>): FileChange {
  return {
    id: overrides.path,
    originalPath: null,
    indexStatus: ' ',
    worktreeStatus: ' ',
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    ...overrides,
  };
}

/** 勾选即 `git add`：未跟踪文件被勾上后会变成索引里的 `A`，`untracked` 随之为 false。 */
const unstagedNew = (path: string) => file({ path, indexStatus: '?', worktreeStatus: '?', untracked: true });
const stagedNew = (path: string) => file({ path, indexStatus: 'A', worktreeStatus: ' ', staged: true, unstaged: false });
const stagedEdit = (path: string) => file({ path, indexStatus: 'M', worktreeStatus: ' ', staged: true, unstaged: false });

describe('file menu items', () => {
  it('groups ignore, local exclude, mark and file actions for a tracked file', () => {
    const items = fileMenuItems({ path: 'src/a b.txt', exists: true, untracked: false });
    expect(items.map((item) => item.id)).toEqual([
      'ignore-path',
      'ignore-name',
      'ignore-pattern',
      'exclude-path',
      'exclude-name',
      'exclude-pattern',
      'assume',
      'reveal',
      'editor',
      'copy-path',
    ]);
    // 每组第一项带组标题，后面的项沿用同一标题，ActionMenu 只在变化处插分隔线。
    expect(items[0]?.section).toBe(items[1]?.section);
    expect(items[2]?.section).not.toBe(items[3]?.section);
    expect(items[5]?.section).not.toBe(items[6]?.section);
    expect(items[6]?.section).not.toBe(items[7]?.section);
    expect(items.every((item) => item.disabled === null)).toBe(true);
  });

  it('hides the assume-unchanged item for untracked and conflicted files', () => {
    const forUntracked = fileMenuItems({ path: 'new.txt', exists: true, untracked: true });
    expect(forUntracked.map((item) => item.id)).not.toContain('assume');
    expect(forUntracked).toHaveLength(9);
    const forConflicted = fileMenuItems({ path: 'both.txt', exists: true, conflicted: true });
    expect(forConflicted.map((item) => item.id)).not.toContain('assume');
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

  it('offers only "cancel mark" plus file actions for a marked entry', () => {
    const items = fileMenuItems({ path: 'notes.txt', marked: true });
    expect(items.map((item) => item.id)).toEqual(['unassume', 'reveal', 'editor', 'copy-path']);
    expect(items[0]?.label).toContain('取消标记');
    expect(items[0]?.section).not.toBe(items[1]?.section);
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

describe('batch delete of uncommitted files', () => {
  it('offers nothing while no file is checked', () => {
    expect(checkedUncommittedPaths([unstagedNew('a.txt'), unstagedNew('b.txt')])).toEqual([]);
  });

  it('returns the checked files when every one of them is a new file', () => {
    // 勾选后仍是「未提交新文件」，只是状态从 `??` 变成 `A` —— 只看 untracked 会漏掉这一半。
    expect(checkedUncommittedPaths([stagedNew('a.txt'), stagedNew('b.txt'), unstagedNew('c.txt')])).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });

  it('offers nothing as soon as a tracked file is checked too', () => {
    expect(checkedUncommittedPaths([stagedNew('a.txt'), stagedEdit('b.txt')])).toEqual([]);
  });

  it('ignores conflicted files and offers nothing when only they are checked', () => {
    expect(
      checkedUncommittedPaths([
        file({ path: 'both.txt', indexStatus: 'U', worktreeStatus: 'U', staged: true, conflicted: true }),
      ]),
    ).toEqual([]);
    expect(
      checkedUncommittedPaths([
        stagedNew('a.txt'),
        file({ path: 'both.txt', indexStatus: 'U', worktreeStatus: 'U', staged: true, conflicted: true }),
      ]),
    ).toEqual(['a.txt']);
  });
});
