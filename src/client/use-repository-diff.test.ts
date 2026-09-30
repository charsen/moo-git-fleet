import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../shared/contracts';
import { filesForScope, reconcileFileSelection, selectionKey } from './repository-workspace';
import { useRepositoryDiff } from './use-repository-diff';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));
function file(path: string, id = path, overrides: Partial<FileChange> = {}): FileChange {
  return {
    id,
    path,
    originalPath: null,
    indexStatus: ' ',
    worktreeStatus: 'M',
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function setup(filesValue = [file('a.ts'), file('b.ts')]) {
  const repositoryId = ref<string | null>('repo-a');
  const files = ref(filesValue);
  const busy = ref(false);
  const read = vi.fn(async (_repositoryId: string, fileId: string, _kind: string) => ({
    path: files.value.find((item) => item.id === fileId)!.path,
    diff: `patch:${fileId}`,
  }));
  const scope = effectScope();
  scopes.push(scope);
  const diff = scope.run(() =>
    useRepositoryDiff({
      repositoryId: () => repositoryId.value,
      files,
      busy: () => busy.value,
      read,
    }),
  )!;
  return { repositoryId, files, busy, read, diff };
}

describe('repository workbench selection', () => {
  it('lists partial staging in both scopes and keeps conflicts separate', () => {
    const partial = file('partial.ts', '1', { staged: true, indexStatus: 'M' });
    const conflict = file('conflict.ts', '2', { staged: true, conflicted: true });
    expect(filesForScope([partial, conflict], 'staged')).toEqual([partial]);
    expect(filesForScope([partial, conflict], 'unstaged')).toEqual([partial]);
  });
  it('does not confuse paths containing delimiters with scope keys', () => {
    expect(selectionKey({ path: 'a:staged\n\t', kind: 'unstaged' })).not.toBe(
      selectionKey({ path: 'a', kind: 'staged' }),
    );
  });
  it('keeps scope when available, switches scope after full stage, and clears removed paths', () => {
    const selection = { path: 'partial.ts', kind: 'unstaged' as const };
    expect(reconcileFileSelection([file('partial.ts', 'new')], selection)).toEqual(selection);
    expect(
      reconcileFileSelection(
        [file('partial.ts', 'new', { staged: true, unstaged: false })],
        selection,
      ),
    ).toEqual({ path: 'partial.ts', kind: 'staged' });
    expect(reconcileFileSelection([], selection)).toBeNull();
  });
});

describe('repository diff requests', () => {
  it('shows only the last selected file even if responses arrive out of order', async () => {
    const { diff, files, read } = setup();
    const first = deferred<{ path: string; diff: string }>();
    read.mockImplementationOnce(() => first.promise);
    const pending = diff.select(files.value[0]!);
    await diff.select(files.value[1]!);
    first.resolve({ path: 'a.ts', diff: 'old response' });
    await pending;
    expect(diff.dialog.value).toMatchObject({ path: 'b.ts', diff: 'patch:b.ts' });
    expect(diff.loading.value).toBe(false);
  });
  it('clears old content immediately and retains the selected path when a read fails', async () => {
    const { diff, files, read } = setup();
    await diff.select(files.value[0]!);
    const second = deferred<{ path: string; diff: string }>();
    read.mockImplementationOnce(() => second.promise);
    const pending = diff.select(files.value[1]!);
    expect(diff.dialog.value).toMatchObject({ path: 'b.ts', diff: '' });
    second.reject(new Error('expired file'));
    await pending;
    expect(diff.error.value).toBe('expired file');
    expect(diff.dialog.value?.diff).toBe('');
  });
  it('ignores a response after leaving and reopening the same repository', async () => {
    const { diff, repositoryId, files, read } = setup();
    const first = deferred<{ path: string; diff: string }>();
    read.mockImplementationOnce(() => first.promise);
    const pending = diff.select(files.value[0]!);
    repositoryId.value = null;
    repositoryId.value = 'repo-a';
    first.resolve({ path: 'a.ts', diff: 'late' });
    await pending;
    expect(diff.dialog.value).toBeNull();
  });
  it('uses the new file ID after a mutation and waits until the write finishes', async () => {
    const { diff, busy, files, read } = setup();
    await diff.select(files.value[0]!);
    busy.value = true;
    files.value = [file('a.ts', 'new-id')];
    await nextTick();
    expect(diff.dialog.value?.diff).toBe('');
    expect(read).toHaveBeenCalledTimes(1);
    busy.value = false;
    await nextTick();
    await nextTick();
    expect(read).toHaveBeenLastCalledWith('repo-a', 'new-id', 'unstaged');
    expect(diff.dialog.value).toMatchObject({
      path: 'a.ts',
      fileId: 'new-id',
      diff: 'patch:new-id',
    });
  });
  it('switches to staged preview when the selected file has been fully staged', async () => {
    const { diff, files, read } = setup();
    await diff.select(files.value[0]!);
    files.value = [file('a.ts', 'staged-id', { staged: true, unstaged: false })];
    await nextTick();
    await nextTick();
    expect(read).toHaveBeenLastCalledWith('repo-a', 'staged-id', 'staged');
    expect(diff.dialog.value?.kind).toBe('staged');
  });
  it('does not resurrect a preview when the file is removed during its request', async () => {
    const { diff, files, read } = setup();
    const pendingRead = deferred<{ path: string; diff: string }>();
    read.mockImplementationOnce(() => pendingRead.promise);
    const pending = diff.select(files.value[0]!);
    files.value = [];
    await nextTick();
    pendingRead.resolve({ path: 'a.ts', diff: 'late' });
    await pending;
    expect(diff.dialog.value).toBeNull();
  });
  it('resolves stale caller objects against current files instead of sending their old ID', async () => {
    const stale = file('a.ts', 'old-id');
    const { diff, read } = setup([file('a.ts', 'new-id')]);
    await diff.select(stale);
    expect(read).toHaveBeenCalledWith('repo-a', 'new-id', 'unstaged');
  });
  it('rejects a response belonging to a different path', async () => {
    const { diff, read, files } = setup();
    read.mockResolvedValueOnce({ path: 'other.ts', diff: 'wrong patch' });
    await diff.select(files.value[0]!);
    expect(diff.dialog.value?.diff).toBe('');
    expect(diff.error.value).toContain('文件身份已变化');
  });
});
