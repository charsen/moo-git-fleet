import { effectScope, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { BranchComparison } from '../shared/contracts';
import { useBranchComparison } from './use-branch-comparison';
const hash = (n: number) => String(n).padStart(40, '0');
const detail = (tip: string, baseTip: string): BranchComparison => ({ tip, baseTip, sourceOnly: 1, baseOnly: 2, files: [], truncated: false });
async function settled() { await nextTick(); await Promise.resolve(); await nextTick(); }
it('cancels stale comparisons, rejects wrong identities and retries errors against the current tips', async () => {
  const scope = effectScope(), tip = ref(hash(1)), base = ref(hash(2)), active = ref(false);
  let finish!: (value: BranchComparison) => void;
  let oldSignal: AbortSignal | undefined;
  const read = vi.fn(async (_id: string, t: string, b: string, _signal: AbortSignal) => detail(t, b));
  const comparison = scope.run(() => useBranchComparison({ repositoryId: () => 'repo', tip: () => tip.value, baseTip: () => base.value, active: () => active.value, read }))!;
  try {
    expect(read).not.toHaveBeenCalled();
    read.mockImplementationOnce((_id, _tip, _base, signal) => { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); });
    active.value = true; await nextTick(); tip.value = hash(3); await settled();
    expect(oldSignal?.aborted).toBe(true); finish(detail(hash(1), hash(2))); await settled();
    expect(comparison.detail.value?.tip).toBe(hash(3));
    read.mockResolvedValueOnce(detail(hash(99), hash(2))); await comparison.refresh();
    expect(comparison.detail.value).toBeNull(); expect(comparison.error.value).toContain('身份');
    await comparison.refresh(); expect(comparison.error.value).toBe(''); expect(comparison.detail.value?.tip).toBe(hash(3));
    read.mockRejectedValueOnce(new Error('read failed')); await comparison.refresh(); expect(comparison.error.value).toBe('read failed');
    active.value = false; await settled(); expect(comparison.loading.value).toBe(false);
  } finally { comparison.invalidate(); scope.stop(); }
});
