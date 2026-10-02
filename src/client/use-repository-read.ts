import { onScopeDispose, ref, shallowRef, watch } from 'vue';

/** Shared read lifecycle: an obsolete result can never replace the current context. */
export function useRepositoryRead<T>(key: () => string | null, read: (signal: AbortSignal) => Promise<T>) {
  const data = shallowRef<T | null>(null), loading = ref(false), error = ref('');
  let sequence = 0, controller: AbortController | undefined;
  function invalidate(): void { sequence++; controller?.abort(); loading.value = false; }
  async function refresh(): Promise<void> {
    invalidate(); data.value = null; error.value = '';
    const identity = key(); if (!identity) return;
    const token = sequence; controller = new AbortController(); loading.value = true;
    try {
      const result = await read(controller.signal);
      if (token === sequence && identity === key()) data.value = result;
    } catch (cause) {
      if (token === sequence && identity === key()) error.value = cause instanceof Error ? cause.message : '读取失败，请重试';
    } finally { if (token === sequence) loading.value = false; }
  }
  watch(key, () => { void refresh(); }, { immediate: true, flush: 'post' });
  onScopeDispose(invalidate);
  return { data, loading, error, refresh, invalidate };
}
