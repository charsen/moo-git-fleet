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
