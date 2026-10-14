import type { FileChange } from '../shared/contracts';

export type DiffKind = 'staged' | 'unstaged';
export type FileSelection = { path: string; kind: DiffKind };

// UI selections use paths and scopes; only the latest server-issued ID is sent to Git actions.
export function selectionKey(selection: FileSelection): string {
  return JSON.stringify([selection.path, selection.kind]);
}

export function filesForScope(files: FileChange[], kind: DiffKind): FileChange[] {
  return files.filter(
    (file) => !file.conflicted && (kind === 'staged' ? file.staged : file.unstaged),
  );
}

export function commitSelection(files: FileChange[]): { all: boolean; partial: boolean } {
  const available = files.filter(file => !file.conflicted);
  const all = available.length > 0 && available.every(file => file.staged && !file.unstaged);
  return { all, partial: !all && available.some(file => file.staged) };
}

/** A half-selected file becomes fully included; removing its staged part stays explicit. */
export function fileStageAction(file: FileChange): 'stage' | 'unstage' {
  return file.staged && !file.unstaged ? 'unstage' : 'stage';
}

export function reconcileFileSelection(
  files: FileChange[],
  selection: FileSelection | null,
): FileSelection | null {
  if (!selection) return null;
  const file = files.find((item) => item.path === selection.path);
  if (!file) return null;
  if (file[selection.kind]) return selection;
  const kind = selection.kind === 'staged' ? 'unstaged' : 'staged';
  return file[kind] ? { path: file.path, kind } : null;
}

export type FileMenuAction =
  | 'ignore-path'
  | 'ignore-name'
  | 'ignore-pattern'
  | 'exclude-path'
  | 'exclude-name'
  | 'exclude-pattern'
  | 'unignore'
  | 'assume'
  | 'unassume'
  | 'reveal'
  | 'editor'
  | 'copy-path';

export interface FileMenuItem {
  id: FileMenuAction;
  label: string;
  disabled: string | null;
  section: string;
}

const fileMenuSections = {
  ignore: '忽略 · 随仓库提交',
  exclude: '仅在本机排除 · 不提交',
  unignore: '已忽略',
  mark: '标记 · 只在本机，不进提交',
  file: '文件',
} as const;

/**
 * 文件行右键菜单项。
 * - 已忽略的条目：只给「不再忽略」+ 文件段。
 * - 被标记 assume-unchanged 的条目：只给「取消标记」+ 文件段。
 * - 普通文件：忽略 / 本机排除各三档；已跟踪且非冲突的文件再给「设为 assume-unchanged」。
 * `exists` 为 false（例如只剩删除记录）时禁用「打开 / 在访达中显示」。
 */
export function fileMenuItems(file: {
  path: string;
  ignored?: boolean;
  marked?: boolean;
  untracked?: boolean;
  conflicted?: boolean;
  exists?: boolean;
}): FileMenuItem[] {
  const baseName = file.path.replace(/\/+$/, '').split('/').at(-1) ?? file.path;
  const fileItems: FileMenuItem[] = [
    { id: 'reveal', label: '在访达中显示', disabled: file.exists === false ? '文件已不在工作区' : null, section: fileMenuSections.file },
    { id: 'editor', label: '在编辑器中打开', disabled: file.exists === false ? '文件已不在工作区' : null, section: fileMenuSections.file },
    { id: 'copy-path', label: '复制相对路径', disabled: null, section: fileMenuSections.file },
  ];
  if (file.ignored) {
    return [
      { id: 'unignore', label: '不再忽略', disabled: null, section: fileMenuSections.unignore },
      ...fileItems,
    ];
  }
  if (file.marked) {
    return [
      { id: 'unassume', label: '取消标记（assume-unchanged）', disabled: null, section: fileMenuSections.mark },
      ...fileItems,
    ];
  }
  const items: FileMenuItem[] = [
    { id: 'ignore-path', label: '忽略此项', disabled: null, section: fileMenuSections.ignore },
    { id: 'ignore-name', label: `忽略所有同名项（${baseName}）`, disabled: null, section: fileMenuSections.ignore },
    { id: 'ignore-pattern', label: '按模式忽略…', disabled: null, section: fileMenuSections.ignore },
    { id: 'exclude-path', label: '仅在本机排除此项', disabled: null, section: fileMenuSections.exclude },
    { id: 'exclude-name', label: `仅在本机排除所有同名项（${baseName}）`, disabled: null, section: fileMenuSections.exclude },
    { id: 'exclude-pattern', label: '按模式仅在本机排除…', disabled: null, section: fileMenuSections.exclude },
  ];
  // 只有索引里的已跟踪文件能被标记；未跟踪与冲突文件不展示这一段。
  if (!file.untracked && !file.conflicted) {
    items.push({
      id: 'assume',
      label: '设为 assume-unchanged（本地修改不进提交）',
      disabled: null,
      section: fileMenuSections.mark,
    });
  }
  return [...items, ...fileItems];
}

/** 只有删除记录没有工作区文件时不提供「打开」类动作。 */
export function fileExistsInWorktree(file: Pick<FileChange, 'indexStatus' | 'worktreeStatus'>): boolean {
  return file.indexStatus.trim() !== 'D' && file.worktreeStatus.trim() !== 'D';
}
