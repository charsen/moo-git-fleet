import { computed, ref, watch } from 'vue';
import type { CommitDetail, CommitPage, CommitPageQuery, RepositoryCommit } from '../shared/contracts';

interface HistoryState {
  commits: RepositoryCommit[];
  tip: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  selectedHash: string | null;
  detail: CommitDetail | null;
  detailLoading: boolean;
  detailError: string;
  revision: string | null;
}
const emptyState = (): HistoryState => ({ commits: [], tip: null, hasMore: false, loading: false, loadingMore: false, error: '', selectedHash: null, detail: null, detailLoading: false, detailError: '', revision: null });

/** 按浏览引用隔离历史、选择和异步请求，Git HEAD 与浏览分支互不影响。 */
export function useRepositoryHistory(options: {
  repositoryId: () => string;
  reference: () => string | undefined;
  revision: () => string;
  active: () => boolean;
  readPage: (id: string, options: CommitPageQuery) => Promise<CommitPage>;
  readDetail: (id: string, hash: string) => Promise<CommitDetail>;
}) {
  const state = ref<HistoryState>(emptyState());
  const contextKey = computed(() => `${options.repositoryId()}\0${options.reference() ?? 'HEAD'}`);
  const cache = new Map<string, HistoryState>();
  let previousKey = '';
  let pageRequest = 0;
  let detailRequest = 0;

  function invalidate(): void {
    pageRequest += 1;
    detailRequest += 1;
    state.value.loading = false;
    state.value.loadingMore = false;
    state.value.detailLoading = false;
  }

  async function select(hash: string): Promise<void> {
    if (!state.value.commits.some((commit) => commit.hash === hash)) return;
    state.value.selectedHash = hash;
    if (state.value.detail?.hash === hash) return;
    const token = ++detailRequest;
    const key = contextKey.value;
    state.value.detail = null;
    state.value.detailLoading = true;
    state.value.detailError = '';
    try {
      const detail = await options.readDetail(options.repositoryId(), hash);
      if (token !== detailRequest || key !== contextKey.value) return;
      if (detail.hash !== hash) throw new Error('提交身份已变化，请重试');
      state.value.detail = detail;
    } catch (cause) {
      if (token === detailRequest && key === contextKey.value)
        state.value.detailError = cause instanceof Error ? cause.message : '读取提交详情失败';
    } finally {
      if (token === detailRequest && key === contextKey.value) state.value.detailLoading = false;
    }
  }

  async function refresh(): Promise<void> {
    invalidate();
    const token = pageRequest;
    const key = contextKey.value;
    const revision = options.revision();
    state.value.loading = true;
    state.value.error = '';
    try {
      const page = await options.readPage(options.repositoryId(), { ref: options.reference(), limit: Math.max(20, Math.min(100, state.value.commits.length)), skip: 0 });
      if (token !== pageRequest || key !== contextKey.value) return;
      state.value.commits = page.commits;
      state.value.tip = page.tip ?? page.commits[0]?.hash ?? null;
      state.value.hasMore = page.hasMore;
      state.value.revision = revision;
      const selection = page.commits.find((commit) => commit.hash === state.value.selectedHash) ?? page.commits[0];
      if (selection) void select(selection.hash);
      else {
        state.value.selectedHash = null;
        state.value.detail = null;
        state.value.detailError = '';
      }
    } catch (cause) {
      if (token === pageRequest && key === contextKey.value) {
        state.value.commits = [];
        state.value.hasMore = false;
        state.value.selectedHash = null;
        state.value.detail = null;
        state.value.error = cause instanceof Error ? cause.message : '读取提交历史失败';
      }
    } finally {
      if (token === pageRequest && key === contextKey.value) state.value.loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (state.value.loading || state.value.loadingMore || !state.value.hasMore) return;
    const token = pageRequest;
    const key = contextKey.value;
    state.value.loadingMore = true;
    state.value.error = '';
    try {
      const page = await options.readPage(options.repositoryId(), { ref: options.reference(), tip: state.value.tip ?? undefined, limit: 20, skip: state.value.commits.length });
      if (token !== pageRequest || key !== contextKey.value) return;
      const seen = new Set(state.value.commits.map((commit) => commit.hash));
      state.value.commits.push(...page.commits.filter((commit) => !seen.has(commit.hash)));
      state.value.hasMore = page.hasMore;
    } catch (cause) {
      if (token === pageRequest && key === contextKey.value)
        state.value.error = cause instanceof Error ? cause.message : '读取更多提交失败';
    } finally {
      if (token === pageRequest && key === contextKey.value) state.value.loadingMore = false;
    }
  }

  watch([contextKey, options.revision, options.active], () => {
    const key = contextKey.value;
    if (key !== previousKey) {
      invalidate();
      if (previousKey) cache.set(previousKey, state.value);
      state.value = cache.get(key) ?? emptyState();
      previousKey = key;
    }
    if (options.active() && !state.value.loading && state.value.revision !== options.revision()) void refresh();
    else if (options.active() && state.value.selectedHash && !state.value.detail && !state.value.detailLoading) void select(state.value.selectedHash);
  // 父组件会同时更新 reference/revision/active，等整组 props 更新后再读取。
  }, { immediate: true, flush: 'post' });

  return { state, contextKey, select, refresh, loadMore, invalidate };
}
