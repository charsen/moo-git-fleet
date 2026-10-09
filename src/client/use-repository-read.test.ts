import { effectScope, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useRepositoryRead } from './use-repository-read';
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }
it('aborts obsolete contexts and does not display their late successes or errors', async () => {
  const key = ref<string | null>(null), old = deferred<string>(), failed = deferred<string>(), signals: AbortSignal[] = [];
  const read = vi.fn((signal: AbortSignal) => { signals.push(signal); return Promise.resolve('current'); }).mockImplementationOnce(signal => { signals.push(signal); return old.promise; }).mockImplementationOnce(signal => { signals.push(signal); return failed.promise; });
  const scope = effectScope(); scopes.push(scope); const result = scope.run(() => useRepositoryRead(() => key.value, read))!;
  expect(read).not.toHaveBeenCalled(); key.value = 'old'; await nextTick(); key.value = 'failed'; await nextTick(); key.value = 'current'; await settle();
  old.resolve('obsolete'); failed.reject(new Error('obsolete error')); await settle();
  expect(signals.slice(0, 2).every(signal => signal.aborted)).toBe(true); expect(result.data.value).toBe('current'); expect(result.error.value).toBe('');
  key.value = null; await settle(); expect(result.data.value).toBeNull(); expect(result.loading.value).toBe(false);
});
it('clears stale content on retry and aborts a pending read on disposal', async () => {
  const pending = deferred<string>(); let signal!: AbortSignal;
  const read = vi.fn(async (_signal: AbortSignal): Promise<string> => { throw new Error('read failed'); });
  const scope = effectScope(); scopes.push(scope); const result = scope.run(() => useRepositoryRead(() => 'repo:file', read))!; await settle();
  expect(result.error.value).toBe('read failed'); read.mockResolvedValueOnce('recovered'); await result.refresh(); expect(result.data.value).toBe('recovered'); expect(result.error.value).toBe('');
  read.mockImplementationOnce(value => { signal = value; return pending.promise; }); const work = result.refresh(); expect(result.data.value).toBeNull(); scope.stop(); expect(signal.aborted).toBe(true);
  pending.resolve('disposed content'); await work; expect(result.data.value).toBeNull();
});
it('keeps the new preview loading when a closed preview fails late, including reopening the same identity', async () => {
  const key = ref<string | null>('session-a'), old = deferred<string>(), current = deferred<string>();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const scope = effectScope(); scopes.push(scope);
  const result = scope.run(() => useRepositoryRead(() => key.value, read))!;
  key.value = null; await settle(); key.value = 'session-a'; await settle();
  old.reject(new Error('old session failed')); await settle();
  expect(result.loading.value).toBe(true); expect(result.error.value).toBe(''); expect(result.data.value).toBeNull();
  current.resolve('new session content'); await settle();
  expect(result.loading.value).toBe(false); expect(result.data.value).toBe('new session content');
});
