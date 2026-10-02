import { effectScope, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReflogEntry, ReflogPage } from '../shared/contracts';
import { reflogEntryKey, useRepositoryReflog } from './use-repository-reflog';
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
const entry = (n: number): ReflogEntry => ({ hash: 'a'.repeat(40), selector: `HEAD@{${n}}`, actor: 'Author', occurredAt: '2026-10-02T00:00:00Z', message: 'checkout' });
const page = (ref = 'HEAD', snapshot = 'fixed', entries = [entry(0)]): ReflogPage => ({ ref, snapshot, entries, hasMore: true, truncated: false });
async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }
function setup() {
  const reference = ref('HEAD'), active = ref(false);
  const read = vi.fn(async (_id: string, reference: string, _snapshot?: string, _skip?: number, _signal?: AbortSignal): Promise<ReflogPage> => page(reference));
  const scope = effectScope(); scopes.push(scope); const log = scope.run(() => useRepositoryReflog({ repositoryId: () => 'demo', reference: () => reference.value, active: () => active.value, read }))!;
  return { reference, active, read, log };
}
it('pins pagination, preserves repeated commit occurrences and reuses selection after leaving the view', async () => {
  const { active, read, log } = setup(); expect(read).not.toHaveBeenCalled(); active.value = true; await settle();
  read.mockResolvedValueOnce({ ...page('HEAD', 'fixed', [entry(1)]), hasMore: false }); await log.loadMore();
  expect(read).toHaveBeenLastCalledWith('demo', 'HEAD', 'fixed', 1, expect.any(AbortSignal));
  expect(log.entries.value).toHaveLength(2); expect(reflogEntryKey(entry(0))).not.toBe(reflogEntryKey(entry(1)));
  log.selected.value = reflogEntryKey(entry(1)); active.value = false; await settle(); active.value = true; await settle();
  expect(read).toHaveBeenCalledTimes(2); expect(log.selected.value).toBe(reflogEntryKey(entry(1)));
});
it('rejects snapshot drift and preserves the current list after an expired page', async () => {
  const { active, read, log } = setup(); active.value = true; await settle();
  read.mockResolvedValueOnce(page('HEAD', 'different', [entry(1)])); await log.loadMore();
  expect(log.error.value).toContain('身份'); expect(log.entries.value).toEqual([entry(0)]);
  read.mockRejectedValueOnce(new Error('快照已过期')); await log.loadMore(); expect(log.error.value).toContain('过期'); expect(log.entries.value).toHaveLength(1);
  read.mockResolvedValueOnce(page('HEAD', 'fresh')); await log.refresh(); expect(log.error.value).toBe('');
});
it('aborts an old reference request and ignores its late error', async () => {
  const { active, reference, read, log } = setup(); let reject!: (cause: Error) => void, signal!: AbortSignal;
  read.mockImplementationOnce((_id, _ref, _snapshot, _skip, value) => { signal = value!; return new Promise((_resolve, fail) => { reject = fail; }); });
  active.value = true; await nextTick(); reference.value = 'refs/heads/main'; await settle(); expect(signal.aborted).toBe(true);
  reject(new Error('late HEAD error')); await settle(); expect(log.error.value).toBe(''); expect(log.entries.value).toEqual([entry(0)]);
  expect(read).toHaveBeenLastCalledWith('demo', 'refs/heads/main', undefined, 0, expect.any(AbortSignal));
});
