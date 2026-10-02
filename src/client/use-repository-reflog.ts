import { onScopeDispose, ref, watch } from 'vue';
import type { ReflogEntry, ReflogPage } from '../shared/contracts';
export const reflogEntryKey = (entry: ReflogEntry) => JSON.stringify([entry.selector, entry.hash, entry.occurredAt, entry.message]);

export function useRepositoryReflog(options: { repositoryId: () => string; reference: () => string; active: () => boolean; read: (id: string, ref: string, snapshot?: string, skip?: number, signal?: AbortSignal) => Promise<ReflogPage> }) {
  const entries = ref<ReflogEntry[]>([]), snapshot = ref<string>(), hasMore = ref(false), truncated = ref(false), selected = ref<string | null>(null), loading = ref(false), loadingMore = ref(false), error = ref('');
  let sequence = 0, controller: AbortController | undefined;
  const context = () => JSON.stringify([options.repositoryId(), options.reference()]);
  function invalidate(): void { sequence++; controller?.abort(); loading.value = false; loadingMore.value = false; }
  async function load(more = false): Promise<void> {
    if (more && (loading.value || loadingMore.value || !hasMore.value)) return;
    if (!more) invalidate();
    const token = sequence, key = context(); controller = new AbortController();
    if (more) loadingMore.value = true; else loading.value = true;
    error.value = '';
    try {
      const page = await options.read(options.repositoryId(), options.reference(), more ? snapshot.value : undefined, more ? entries.value.length : 0, controller.signal);
      if (token !== sequence || key !== context() || !options.active()) return;
      if (page.ref !== options.reference() || (more && page.snapshot !== snapshot.value)) throw new Error('Reflog 快照身份已变化，请刷新');
      entries.value = more ? [...entries.value, ...page.entries] : page.entries;
      snapshot.value = page.snapshot; hasMore.value = page.hasMore; truncated.value = page.truncated;
      if (!entries.value.some(entry => reflogEntryKey(entry) === selected.value)) selected.value = entries.value[0] ? reflogEntryKey(entries.value[0]) : null;
    } catch (cause) { if (token === sequence && key === context()) error.value = cause instanceof Error ? cause.message : '读取 Reflog 失败'; }
    finally { if (token === sequence) { loading.value = false; loadingMore.value = false; } }
  }
  let previousContext = '';
  watch([options.repositoryId, options.reference, options.active], () => {
    invalidate();
    const next = context();
    if (next !== previousContext) { entries.value = []; snapshot.value = undefined; hasMore.value = false; selected.value = null; error.value = ''; }
    previousContext = next;
    if (options.active() && !snapshot.value) void load();
  }, { immediate: true, flush: 'post' });
  onScopeDispose(invalidate);
  return { entries, selected, hasMore, truncated, loading, loadingMore, error, refresh: () => load(), loadMore: () => load(true), invalidate };
}
