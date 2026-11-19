import { computed, ref, watch } from 'vue';
import type { CommitDetail, CommitPage, CommitPageQuery, RepositoryCommit } from '../shared/contracts';

interface HistoryState {
  commits: RepositoryCommit[];
  tip: string | null;
  snapshot?: string;
  excludeTip?: string;
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
  query?: () => CommitPageQuery;
  /** 返回 false 时只维护列表、不自动选中/读取提交详情（提交图只用列表）。 */
  selectDetail?: () => boolean;
  readPage: (id: string, options: CommitPageQuery, signal?: AbortSignal) => Promise<CommitPage>;
  readDetail: (id: string, hash: string, filePath?: string, signal?: AbortSignal) => Promise<CommitDetail>;
}) {
  const state = ref<HistoryState>(emptyState());
  const contextKey = computed(() => `${options.repositoryId()}\0${options.reference() ?? 'HEAD'}\0${JSON.stringify(options.query?.() ?? {})}`);
  const cache = new Map<string, HistoryState>();
  let previousKey = '';
  let pageRequest = 0;
  let detailRequest = 0;
  let pageController: AbortController | undefined;
  let detailController: AbortController | undefined;

  function invalidate(): void {
    pageRequest += 1;
    detailRequest += 1;
    pageController?.abort();
    detailController?.abort();
    state.value.loading = false;
    state.value.loadingMore = false;
    state.value.detailLoading = false;
  }

  async function select(hash: string): Promise<void> {
    if (options.selectDetail?.() === false) return;
    if (!state.value.commits.some((commit) => commit.hash === hash)) return;
    state.value.selectedHash = hash;
    if (state.value.detail?.hash === hash) return;
    const token = ++detailRequest;
    detailController?.abort();
    detailController = new AbortController();
    const key = contextKey.value;
    state.value.detail = null;
    state.value.detailLoading = true;
    state.value.detailError = '';
    try {
      const filePath = options.query?.().filePath ? state.value.commits.find(commit => commit.hash === hash)?.filePath ?? options.query().filePath : undefined;
      const detail = await options.readDetail(options.repositoryId(), hash, filePath, detailController.signal);
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
    // 刷新（含后台 Fetch 触发的 revision 变化）保留已经加载的行数：深读时不再缩回 100 行、滚动位置跳走。
    const restore = Math.min(1000, state.value.commits.length);
    invalidate();
    const token = pageRequest;
    const key = contextKey.value;
    const revision = options.revision();
    state.value.loading = true;
    state.value.error = '';
    pageController = new AbortController();
    const signal = pageController.signal;
    try {
      const page = await options.readPage(options.repositoryId(), { ref: options.reference(), ...options.query?.(), limit: Math.min(100, Math.max(20, restore)), skip: 0 }, signal);
      if (token !== pageRequest || key !== contextKey.value) return;
      let commits = [...page.commits];
      let hasMore = page.hasMore;
      let tip = page.tip;
      let snapshot = page.snapshot;
      let excludeTip = page.excludeTip;
      // 接口单页上限 100：按页补到刷新前的数量（最多 1000，避免一次刷新打太多请求）。
      while (hasMore && commits.length < restore && token === pageRequest && key === contextKey.value) {
        const next = await options.readPage(options.repositoryId(), {
          ref: options.reference(),
          ...options.query?.(),
          ...(tip ? { tip } : {}),
          ...(snapshot ? { snapshot } : {}),
          ...(excludeTip ? { excludeTip } : {}),
          limit: Math.min(100, restore - commits.length),
          skip: commits.length,
        }, signal);
        if (token !== pageRequest || key !== contextKey.value) return;
        const seen = new Set(commits.map((commit) => commit.hash));
        const fresh = next.commits.filter((commit) => !seen.has(commit.hash));
        if (fresh.length === 0) { hasMore = false; break; }
        commits = commits.concat(fresh);
        hasMore = next.hasMore;
        tip = next.tip ?? tip;
        snapshot = next.snapshot ?? snapshot;
        excludeTip = next.excludeTip ?? excludeTip;
      }
      state.value.commits = commits;
      state.value.tip = tip !== undefined ? tip : commits[0]?.hash ?? null;
      state.value.snapshot = snapshot;
      state.value.excludeTip = excludeTip;
      state.value.hasMore = hasMore;
      state.value.revision = revision;
      const selection = commits.find((commit) => commit.hash === state.value.selectedHash) ?? commits[0];
      if (selection && options.selectDetail?.() !== false) void select(selection.hash);
      else if (selection) state.value.selectedHash = selection.hash;
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
      pageController = new AbortController();
      const page = await options.readPage(options.repositoryId(), { ref: options.reference(), ...options.query?.(), tip: state.value.tip ?? undefined, ...(state.value.snapshot ? { snapshot: state.value.snapshot } : {}), ...(state.value.excludeTip ? { excludeTip: state.value.excludeTip } : {}), limit: 20, skip: state.value.commits.length }, pageController.signal);
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
      if (previousKey) {
        cache.set(previousKey, state.value);
        if (cache.size > 32) cache.delete(cache.keys().next().value!);
      }
      state.value = cache.get(key) ?? emptyState();
      previousKey = key;
    }
    if (options.active() && !state.value.loading && state.value.revision !== options.revision()) void refresh();
    else if (options.active() && state.value.selectedHash && !state.value.detail && !state.value.detailLoading) void select(state.value.selectedHash);
  // 父组件会同时更新 reference/revision/active，等整组 props 更新后再读取。
  }, { immediate: true, flush: 'post' });

  return { state, contextKey, select, refresh, loadMore, invalidate };
}
