import { ref, watch } from 'vue';
import type { BranchComparison } from '../shared/contracts';

export function useBranchComparison(options: {
  repositoryId: () => string;
  tip: () => string | null;
  baseTip: () => string | undefined;
  active: () => boolean;
  read: (id: string, tip: string, baseTip: string, signal: AbortSignal) => Promise<BranchComparison>;
}) {
  const detail = ref<BranchComparison | null>(null);
  const loading = ref(false);
  const error = ref('');
  let request = 0;
  let controller: AbortController | undefined;
  function invalidate(): void { request++; controller?.abort(); loading.value = false; }
  async function refresh(): Promise<void> {
    invalidate(); detail.value = null; error.value = '';
    const id = options.repositoryId(), tip = options.tip(), baseTip = options.baseTip();
    if (!options.active() || !tip || !baseTip) return;
    const token = request; controller = new AbortController(); loading.value = true;
    try {
      const result = await options.read(id, tip, baseTip, controller.signal);
      if (token !== request) return;
      if (result.tip !== tip || result.baseTip !== baseTip) throw new Error('对比提交身份已变化，请刷新后重试');
      detail.value = result;
    } catch (cause) {
      if (token === request) error.value = cause instanceof Error ? cause.message : '读取分支差异失败';
    } finally { if (token === request) loading.value = false; }
  }
  watch([options.repositoryId, options.tip, options.baseTip, options.active], () => { void refresh(); }, { immediate: true, flush: 'post' });
  return { detail, loading, error, refresh, invalidate };
}
