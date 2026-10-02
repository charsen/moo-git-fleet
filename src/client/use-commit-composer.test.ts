import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommitPreview, CommitSuggestion } from '../shared/contracts';
import { useCommitComposer } from './use-commit-composer';
import { commitSelection, fileStageAction } from './repository-workspace';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
const preview = (fingerprint = 'a'): CommitPreview => ({ fingerprint, files: ['a.ts'], stat: '', patch: '', truncated: false });
const suggestion = (fingerprint = 'a'): CommitSuggestion => ({ fingerprint, message: 'feat: generated', subject: 'feat: generated', body: [], summary: '', source: 'local', aiPolicy: { mode: 'local-disabled', label: '本地', detail: '本地生成' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}
async function setup() {
  const key = ref('repo\0main');
  const revision = ref('a');
  const paused = ref(false);
  const staged = ref(true);
  const read = vi.fn(async () => preview(revision.value));
  const suggest = vi.fn(async () => suggestion(revision.value));
  const scope = effectScope(); scopes.push(scope);
  const composer = scope.run(() => useCommitComposer({ repositoryId: () => key.value ? key.value.split('\0')[0] : null, draftKey: () => key.value, revision: () => revision.value, paused: () => paused.value, hasStaged: () => staged.value, readPreview: read, suggest }))!;
  await nextTick(); await nextTick();
  return { composer, key, revision, paused, staged, read, suggest };
}

describe('inline commit drafts and snapshots', () => {
  it('isolates repository drafts and ignores AI responses from the previous project', async () => {
    const { composer, key, suggest, read } = await setup();
    composer.updateMessage('first project draft');
    const pending = deferred<CommitSuggestion>();
    suggest.mockImplementationOnce(() => pending.promise);
    const generation = composer.generate();
    key.value = 'another-repo\0main'; await nextTick(); await nextTick();
    expect(composer.message.value).toBe('');
    composer.updateMessage('second project draft');
    pending.resolve(suggestion()); await generation;
    expect(composer.message.value).toBe('second project draft');
    expect(read).toHaveBeenLastCalledWith('another-repo');
    key.value = 'repo\0main'; await nextTick(); await nextTick();
    expect(composer.message.value).toBe('first project draft');
    key.value = 'another-repo\0main'; await nextTick(); await nextTick();
    expect(composer.message.value).toBe('second project draft');
  });
  it('keeps separate branch drafts across navigation and clears only the committed draft', async () => {
    const { composer, key } = await setup();
    composer.updateMessage('main draft\n\nbody');
    key.value = 'repo\0dev'; await nextTick();
    expect(composer.message.value).toBe('');
    composer.updateMessage('dev draft');
    key.value = ''; await nextTick();
    key.value = 'repo\0main'; await nextTick();
    expect(composer.message.value).toBe('main draft\n\nbody');
    composer.clearDraft();
    key.value = 'repo\0dev'; await nextTick();
    expect(composer.message.value).toBe('dev draft');
    key.value = 'repo\0main'; await nextTick();
    expect(composer.message.value).toBe('');
  });
  it('rejects a late preview after leaving and reopening the same branch', async () => {
    const { composer, key, read } = await setup();
    const pending = deferred<CommitPreview>(); read.mockImplementationOnce(() => pending.promise);
    const refresh = composer.refresh(); await nextTick();
    key.value = ''; key.value = 'repo\0main'; await nextTick();
    pending.resolve(preview('late')); await refresh; await nextTick();
    expect(composer.preview.value?.fingerprint).toBe('a');
  });
  it('disables commit during writes and preview failures while retaining the draft', async () => {
    const { composer, paused, read } = await setup();
    composer.updateMessage('keep me'); paused.value = true; await nextTick();
    expect(composer.ready.value).toBe(false);
    read.mockRejectedValueOnce(new Error('stale index'));
    paused.value = false; await nextTick(); await nextTick();
    expect(composer.ready.value).toBe(false);
    expect(composer.error.value).toBe('stale index');
    expect(composer.message.value).toBe('keep me');
    await composer.refresh(); expect(composer.ready.value).toBe(true);
  });
  it('serializes preview reads across rapid navigation and keeps writes blocked until old reads finish', async () => {
    const { composer, read, key } = await setup();
    const pending = deferred<CommitPreview>(); read.mockImplementationOnce(() => pending.promise);
    const oldRead = composer.refresh(); await nextTick();
    key.value = ''; key.value = 'repo\0main'; await nextTick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(composer.reading.value).toBe(true);
    expect(composer.ready.value).toBe(false);
    pending.resolve(preview('obsolete')); await oldRead; await nextTick(); await nextTick();
    expect(read).toHaveBeenCalledTimes(3);
    expect(composer.preview.value?.fingerprint).toBe('a');
    expect(composer.reading.value).toBe(false);
  });
  it('never replaces text typed while AI is generating', async () => {
    const { composer, suggest } = await setup();
    const pending = deferred<CommitSuggestion>(); suggest.mockImplementationOnce(() => pending.promise);
    const generation = composer.generate(); composer.updateMessage('my own title');
    pending.resolve(suggestion()); await generation;
    expect(composer.message.value).toBe('my own title');
    expect(composer.suggestion.value).toBeNull();
  });
  it('aborts obsolete AI requests when the selected content changes', async () => {
    const { composer, suggest, revision } = await setup();
    const pending = deferred<CommitSuggestion>(); suggest.mockImplementationOnce(() => pending.promise);
    const generation = composer.generate();
    revision.value = 'b'; await nextTick(); await nextTick();
    pending.resolve(suggestion('a')); await generation;
    expect(composer.message.value).toBe('');
    expect(composer.preview.value?.fingerprint).toBe('b');
  });
  it('flags AI text when its content changes, including restored branch drafts', async () => {
    const { composer, revision, key } = await setup();
    await composer.generate();
    key.value = 'repo\0dev'; await nextTick();
    revision.value = 'b'; key.value = 'repo\0main'; await nextTick(); await nextTick();
    expect(composer.message.value).toBe('feat: generated');
    expect(composer.needsReview.value).toBe(true);
    composer.updateMessage('reviewed'); expect(composer.needsReview.value).toBe(false);
  });
  it('allows manual commit after AI failure and rejects mismatched AI fingerprints', async () => {
    const { composer, suggest } = await setup();
    suggest.mockRejectedValueOnce(new Error('provider unavailable'));
    await composer.generate(); expect(composer.ready.value).toBe(true);
    expect(composer.suggestionError.value).toBe('provider unavailable');
    suggest.mockResolvedValueOnce(suggestion('wrong'));
    await composer.generate(); expect(composer.message.value).toBe('');
    expect(composer.suggestionError.value).toContain('内容已变化');
  });
  it('removes the preview when nothing is staged, preserving the typed draft', async () => {
    const { composer, staged, revision } = await setup();
    composer.updateMessage('next commit'); staged.value = false; revision.value = 'none'; await nextTick();
    expect(composer.preview.value).toBeNull(); expect(composer.ready.value).toBe(false);
    expect(composer.message.value).toBe('next commit');
  });
});

describe('Git-backed checkbox state', () => {
  const file = (staged: boolean, unstaged: boolean, conflicted = false) => ({ id: '1', path: 'a.ts', originalPath: null, indexStatus: 'M', worktreeStatus: 'M', staged, unstaged, conflicted, untracked: false });
  it('shows mixed/partial staging and treats half-check click as stage all content', () => {
    expect(commitSelection([file(true, false), file(false, true)])).toEqual({ all: false, partial: true });
    expect(commitSelection([file(true, true)])).toEqual({ all: false, partial: true });
    expect(fileStageAction(file(true, true))).toBe('stage');
    expect(fileStageAction(file(true, false))).toBe('unstage');
  });
  it('excludes conflicts and never checks an empty list', () => {
    expect(commitSelection([file(true, false), file(false, true, true)])).toEqual({ all: true, partial: false });
    expect(commitSelection([file(true, true, true)])).toEqual({ all: false, partial: false });
  });
});
