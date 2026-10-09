import { onScopeDispose, ref, watch, type Ref } from 'vue';

/** Observe the list's own viewport; re-arm after each page to fill short lists. */
export function useInfiniteScroll(options: {
  root: Ref<HTMLElement | null>;
  sentinel: Ref<HTMLElement | null>;
  enabled: () => boolean;
  context: () => string;
  count: () => number;
  loadMore: () => Promise<void>;
}) {
  const pending = ref(false);
  let observer: IntersectionObserver | undefined;
  let disposed = false;
  watch([options.root, options.sentinel, options.enabled, options.context, options.count, pending], () => {
    observer?.disconnect();
    observer = undefined;
    if (!options.root.value || !options.sentinel.value || !options.enabled() || pending.value) return;
    const current = new IntersectionObserver(entries => {
      if (disposed || observer !== current || pending.value || !options.enabled() || !entries.some(entry => entry.isIntersecting)) return;
      pending.value = true;
      void (async () => {
        try { await options.loadMore(); }
        finally { pending.value = false; }
      })();
    }, { root: options.root.value, rootMargin: '0px 0px 240px 0px', threshold: 0 });
    observer = current;
    current.observe(options.sentinel.value);
  }, { immediate: true, flush: 'post' });
  onScopeDispose(() => { disposed = true; observer?.disconnect(); observer = undefined; });
}
