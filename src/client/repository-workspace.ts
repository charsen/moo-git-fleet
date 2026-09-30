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
