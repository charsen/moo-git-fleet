<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertTriangle, ExternalLink, GitCommitHorizontal, GitCompareArrows, ArrowLeftRight, FileDiff, FolderTree, LoaderCircle, RefreshCw, Search, X } from 'lucide-vue-next';
import type { SelectMenuOption } from '../select-options';
import type { CommitPageQuery } from '../../shared/contracts';
import { api } from '../api';
import { relativeTime } from '../relative-time';
import { remoteLinks } from '../remote-links';
import { useBranchComparison } from '../use-branch-comparison';
import { useRepositoryHistory } from '../use-repository-history';
import { useInfiniteScroll } from '../use-infinite-scroll';
import RepositoryChanges from './RepositoryChanges.vue';
import type { HistoryReading } from '../workspace-reading';
import SelectMenu from './SelectMenu.vue';

const props = defineProps<{ repositoryId: string; remoteUrl: string | null; reference?: string; scope?: CommitPageQuery['scope']; baseReference?: string; comparisonOptions?: SelectMenuOption[]; upstreamLabel?: string; filePath?: string; startTip?: string; revision: string; branchLabel: string; head: string; active: boolean; paneWidth: number; paneMax: number }>();
const links = computed(() => remoteLinks(props.remoteUrl));
const emit = defineEmits<{ resize: [event: PointerEvent]; resizeKey: [event: KeyboardEvent]; browseHead: []; browseAll: []; browseFile: [path: string, tip: string]; browseTree: [hash: string]; selectCommit: [hash: string]; compare: [source: string, base: string] }>();
const search = ref('');
const appliedSearch = ref('');
const searchField = ref<'message' | 'author' | 'hash'>('message');
const searchFields = [{ value: 'message', label: '消息' }, { value: 'author', label: '作者' }, { value: 'hash', label: 'SHA' }];
const searchFieldModel = computed<string | number>({ get: () => searchField.value, set: value => { if (value === 'message' || value === 'author' || value === 'hash') searchField.value = value; } });
const hashError = computed(() => searchField.value === 'hash' && appliedSearch.value && !/^[a-f0-9]{4,64}$/i.test(appliedSearch.value) ? '请输入至少 4 位十六进制 SHA 前缀' : '');
const query = computed<CommitPageQuery>(() => ({ scope: props.scope ?? 'ref', ...(props.scope === 'compare' ? { baseRef: props.baseReference } : {}), ...(props.startTip ? { tip: props.startTip } : {}), ...(props.filePath ? { filePath: props.filePath } : {}), ...(appliedSearch.value ? { search: appliedSearch.value, searchField: searchField.value } : {}) }));
const history = useRepositoryHistory({ repositoryId: () => props.repositoryId, reference: () => props.reference, query: () => query.value, revision: () => props.revision, active: () => props.active && !hashError.value, readPage: api.repositoryCommits, readDetail: api.commitDetail });
const state = history.state;
const searchPending = computed(() => search.value.trim() !== appliedSearch.value);
const comparison = useBranchComparison({ repositoryId: () => props.repositoryId, tip: () => state.value.tip, baseTip: () => state.value.excludeTip, active: () => props.active && props.scope === 'compare' && !state.value.loading && !state.value.error && !searchPending.value && !hashError.value, read: api.branchComparison });
const comparisonPreview = ref<'changes' | 'commit'>('changes');
const baseLabel = computed(() => props.baseReference?.replace(/^refs\/(heads|remotes)\//, '') ?? '基准');
function changeComparison(side: 'source' | 'base', value: string | number): void {
  const source = side === 'source' ? String(value) : props.reference;
  const base = side === 'base' ? String(value) : props.baseReference;
  if (source && base) emit('compare', source, base);
}
function swapComparison(): void { if (props.reference && props.baseReference) emit('compare', props.baseReference, props.reference); }
watch([() => props.scope, () => props.reference, () => props.baseReference], () => { comparisonPreview.value = 'changes'; });
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, value => {
  clearTimeout(searchTimer);
  if (value.trim() === appliedSearch.value) return;
  if (!value.trim()) appliedSearch.value = '';
  else searchTimer = setTimeout(() => { appliedSearch.value = value.trim(); }, 250);
}, { flush: 'sync' });
watch(() => props.filePath, () => { search.value = ''; });
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
const paginationError = ref('');
const historyError = computed(() => state.value.error || paginationError.value);
watch(history.contextKey, () => { paginationError.value = ''; }, { flush: 'sync' });
function refreshHistory(): void { paginationError.value = ''; void history.refresh(); }
useInfiniteScroll({
  root: list, sentinel,
  enabled: () => props.active && !searchPending.value && !hashError.value && !state.value.loading && !state.value.loadingMore && !historyError.value && state.value.hasMore,
  context: () => history.contextKey.value,
  count: () => state.value.commits.length,
  loadMore: async () => {
    const key = history.contextKey.value;
    await history.loadMore();
    if (key === history.contextKey.value && state.value.error) paginationError.value = state.value.error;
  },
});
const preview = ref<HTMLElement | null>(null);
const filtered = computed(() => state.value.commits);
function moveCommit(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.workspace-commit')) return;
  const buttons = [...list.value!.querySelectorAll<HTMLButtonElement>('.workspace-commit')];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
}
function enterList(event: KeyboardEvent): void {
  if (searchPending.value || hashError.value || state.value.loading) return;
  const first = list.value?.querySelector<HTMLButtonElement>('.workspace-commit');
  if (!first || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault(); first.focus(); first.click();
}
const listPositions = new Map<string, number>();
const previewIdentity = computed(() => props.scope === 'compare' && comparisonPreview.value === 'changes' ? comparison.detail.value ? `${comparison.detail.value.baseTip}:${comparison.detail.value.tip}` : '' : state.value.detail?.hash ?? '');
const previewPositions = new Map<string, { top: number; left: number }>();
let renderedListKey = '';
let renderedPreviewHash = '';
let restoringList = true;
let restoringPreview = true;
let listRestoreRequest = 0;
let previewRestoreRequest = 0;
function rememberList(): void {
  if (props.active && list.value && !state.value.loading && !restoringList && renderedListKey === history.contextKey.value) listPositions.set(renderedListKey, list.value.scrollTop);
}
function rememberPreview(): void {
  if (props.active && preview.value && previewIdentity.value && !restoringPreview && renderedPreviewHash === previewIdentity.value) previewPositions.set(renderedPreviewHash, { top: preview.value.scrollTop, left: preview.value.scrollLeft });
}
watch([history.contextKey, () => props.active], () => {
  if (props.active && list.value?.getClientRects().length && renderedListKey && !restoringList) listPositions.set(renderedListKey, list.value.scrollTop);
  restoringList = true;
}, { flush: 'sync' });
watch([previewIdentity, () => props.active], () => {
  if (props.active && preview.value?.getClientRects().length && renderedPreviewHash && !restoringPreview) previewPositions.set(renderedPreviewHash, { top: preview.value.scrollTop, left: preview.value.scrollLeft });
  restoringPreview = true;
}, { flush: 'sync' });
watch([history.contextKey, () => state.value.loading, () => state.value.commits.length, () => props.active], async () => {
  const token = ++listRestoreRequest;
  restoringList = true;
  if (!props.active || state.value.loading) return;
  await nextTick();
  if (token !== listRestoreRequest || !list.value || state.value.loading) return;
  renderedListKey = history.contextKey.value;
  list.value.scrollTop = listPositions.get(renderedListKey) ?? 0;
  requestAnimationFrame(() => { if (token === listRestoreRequest) restoringList = false; });
}, { flush: 'post' });
watch([previewIdentity, () => props.active], async () => {
  const token = ++previewRestoreRequest;
  await nextTick();
  if (token !== previewRestoreRequest || !props.active || !preview.value || !previewIdentity.value) return;
  renderedPreviewHash = previewIdentity.value;
  const position = previewPositions.get(renderedPreviewHash);
  preview.value.scrollTop = position?.top ?? 0;
  preview.value.scrollLeft = position?.left ?? 0;
  requestAnimationFrame(() => { if (token === previewRestoreRequest) restoringPreview = false; });
}, { flush: 'post' });
function focusSearch(): void { input.value?.focus({ preventScroll: true }); }
const expansion = ref(new Map<string, boolean>());
const changesPanel = ref<InstanceType<typeof RepositoryChanges> | null>(null);
let restoreToken = 0;
function capture(): HistoryReading {
  return { search: search.value, searchField: searchField.value, hash: state.value.selectedHash, listTop: list.value?.scrollTop ?? 0, previewTop: preview.value?.scrollTop ?? 0, previewLeft: preview.value?.scrollLeft ?? 0, expanded: changesPanel.value?.capture() ?? [], comparisonPreview: comparisonPreview.value };
}
let stopRestore: (() => void) | undefined;
let restoringSearch = false;
watch([search, searchField], () => { if (!restoringSearch) { restoreToken++; stopRestore?.(); } }, { flush: 'sync' });
watch([() => props.reference, () => props.scope, () => props.baseReference, () => props.filePath, () => props.startTip, () => props.active], () => { restoreToken++; stopRestore?.(); }, { flush: 'sync' });
async function restore(reading?: HistoryReading): Promise<void> {
  const token = ++restoreToken; stopRestore?.();
  if (!reading) return;
  comparisonPreview.value = reading.comparisonPreview ?? 'changes';
  clearTimeout(searchTimer); restoringSearch = true;
  searchField.value = reading.searchField; search.value = reading.search; appliedSearch.value = reading.search.trim();
  restoringSearch = false;
  await nextTick();
  if (token !== restoreToken || !props.active) return;
  let running = false;
  let stop: () => void = () => {};
  const apply = async () => {
    if (token !== restoreToken || !props.active) { stop(); return; }
    if (running || state.value.loading || state.value.detailLoading || state.value.loadingMore) return;
    if (props.scope === 'compare' && comparisonPreview.value === 'changes' && (comparison.loading.value || !comparison.detail.value)) return;
    running = true;
    try {
      while (reading.hash && !state.value.commits.some(commit => commit.hash === reading.hash) && state.value.hasMore && !state.value.error) {
        await history.loadMore();
        if (token !== restoreToken || !props.active) return;
      }
      if (reading.hash && !state.value.commits.some(commit => commit.hash === reading.hash)) {
        state.value.detail = null; state.value.detailError = '此前阅读的提交已不在这个历史范围，请刷新或选择其他提交';
        stop(); return;
      }
      if (reading.hash) await history.select(reading.hash);
      await nextTick();
      if (token !== restoreToken || !props.active) return;
      changesPanel.value?.restore(reading.expanded); await nextTick();
      if (token !== restoreToken || !props.active) return;
      listPositions.set(history.contextKey.value, reading.listTop);
      if (previewIdentity.value) previewPositions.set(previewIdentity.value, { top: reading.previewTop, left: reading.previewLeft });
      if (list.value) list.value.scrollTop = reading.listTop;
      if (preview.value) { preview.value.scrollTop = reading.previewTop; preview.value.scrollLeft = reading.previewLeft; }
      stop();
    } finally { running = false; }
  };
  stopRestore = stop = watch([history.contextKey, () => state.value.loading, () => state.value.detailLoading, comparison.loading, comparison.detail, () => props.active], () => { void apply(); }, { flush: 'post' });
  void apply();
}
function selectCommit(hash: string): void { restoreToken++; stopRestore?.(); if (state.value.selectedHash !== hash) emit('selectCommit', hash); comparisonPreview.value = 'commit'; void history.select(hash); }
defineExpose({ focusSearch, capture, restore });
onBeforeUnmount(() => { clearTimeout(searchTimer); restoreToken++; stopRestore?.(); history.invalidate(); comparison.invalidate(); });
</script>

<template>
  <div class="workspace-history">
    <section class="workspace-files workspace-history-list" aria-label="分支提交历史" :style="{ width: `${paneWidth}px` }">
      <div class="workspace-files-heading workspace-history-heading">
        <div><strong>{{ filePath ? '文件历史' : scope === 'all' ? '全仓历史' : scope === 'outgoing' ? '待推送提交' : scope === 'incoming' ? '待拉取提交' : scope === 'compare' ? '分支对比' : '提交历史' }}</strong><span :title="filePath || branchLabel">{{ filePath || `浏览 ${branchLabel}` }}</span></div>
        <button class="table-icon-button" aria-label="刷新历史记录" :disabled="state.loading || searchPending" @click="refreshHistory"><RefreshCw :size="14" :class="{ spinning: state.loading }" /></button>
      </div>
      <div v-if="scope === 'compare'" class="workspace-comparison-controls">
        <label><span>来源</span><SelectMenu :model-value="reference || ''" :options="comparisonOptions ?? []" aria-label="对比来源分支" class="select-menu--compact" @update:model-value="changeComparison('source', $event)" /></label>
        <label><span>基准</span><SelectMenu :model-value="baseReference || ''" :options="comparisonOptions ?? []" aria-label="对比基准分支" class="select-menu--compact" @update:model-value="changeComparison('base', $event)" /><button class="table-icon-button" aria-label="交换对比分支" title="交换来源与基准" @click="swapComparison"><ArrowLeftRight :size="14" /></button></label>
        <div class="workspace-comparison-counts"><span>来源独有 <b>{{ comparison.detail.value?.sourceOnly ?? '—' }}</b></span><button :disabled="!comparison.detail.value" :title="`查看 ${baseLabel} 独有的提交`" @click="swapComparison">基准独有 <b>{{ comparison.detail.value?.baseOnly ?? '—' }}</b><ArrowLeftRight :size="11" /></button></div>
      </div>
      <div class="workspace-history-search">
        <div class="workspace-history-search-row">
          <SelectMenu v-model="searchFieldModel" :options="searchFields" aria-label="历史搜索条件" class="select-menu--compact" />
          <label class="workspace-file-search"><Search :size="13" /><input ref="input" v-model="search" maxlength="300" aria-label="搜索提交记录" :placeholder="searchField === 'hash' ? 'SHA 前缀（至少 4 位）' : searchField === 'author' ? '姓名或邮箱 ⌘K' : '标题或正文 ⌘K'" @keydown.down="enterList" /><button v-if="search" class="table-icon-button" aria-label="清除历史搜索" @click="search = ''; focusSearch()"><X :size="12" /></button></label>
        </div>
        <div class="workspace-history-scope-links"><button v-if="scope !== 'all'" class="workspace-head-link" @click="emit('browseAll')">全仓历史</button><button v-if="scope === 'all' || reference || filePath" class="workspace-head-link" @click="emit('browseHead')">当前分支历史</button></div>
        <span v-if="scope === 'outgoing' || scope === 'incoming'" class="workspace-history-note" :title="upstreamLabel">{{ scope === 'incoming' ? 'upstream 独有 · ' : '本地独有 · ' }}{{ upstreamLabel || 'upstream' }} · 基于最近 Fetch</span>
        <span v-if="scope === 'compare'" class="workspace-history-note" :title="`只列 ${branchLabel} 可达、${baseLabel} 不可达的提交`">来源独有提交 · 相对 {{ baseLabel }}</span>
        <span v-if="filePath" class="workspace-history-note" :title="branchLabel">{{ startTip ? `起点 ${startTip.slice(0, 7)}` : branchLabel }} · 跟踪重命名</span>
      </div>
      <div ref="list" class="workspace-commit-scroll" @keydown="moveCommit" @scroll.passive="rememberList">
        <div v-if="hashError && !searchPending" class="workspace-empty"><Search :size="24" /><strong>按 SHA 查找提交</strong><span>{{ hashError }}</span></div>
        <div v-else-if="searchPending || state.loading" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>{{ search ? '搜索历史…' : '读取历史…' }}</strong></div>
        <div v-else-if="!state.commits.length && !state.error" class="workspace-empty"><Search v-if="appliedSearch" :size="24" /><GitCommitHorizontal v-else :size="28" /><strong>{{ appliedSearch ? '没有匹配的提交' : filePath ? '此文件没有提交历史' : scope === 'incoming' ? '没有待拉取提交' : scope === 'outgoing' ? '没有待推送提交' : scope === 'compare' ? '来源没有独有提交' : '暂无提交' }}</strong><span>{{ appliedSearch ? '已搜索当前范围的完整历史' : filePath ? '未跟踪且从未提交的文件没有历史记录' : scope === 'compare' ? '仍可在右侧查看两个端点的文件差异' : scope === 'incoming' || scope === 'outgoing' ? '两端提交已固定；刷新可读取最新范围' : '当前历史范围尚无提交记录' }}</span></div>
        <div v-show="!hashError && !searchPending && !state.loading" role="list" :aria-label="`${branchLabel} 的提交历史`">
          <div v-for="commit in filtered" :key="commit.hash" role="listitem">
            <button class="workspace-commit" :class="{ active: state.selectedHash === commit.hash }" :aria-pressed="state.selectedHash === commit.hash" :aria-label="`查看提交 ${commit.hash.slice(0, 7)} ${commit.subject}`" :title="commit.subject" @click="selectCommit(commit.hash)">
              <span class="workspace-commit-marker" aria-hidden="true"><GitCommitHorizontal :size="14" /></span>
              <span class="workspace-commit-copy"><strong>{{ commit.subject }}</strong><span class="workspace-commit-author">{{ commit.author }} <time :datetime="commit.committedAt" :title="new Date(commit.committedAt).toLocaleString()">{{ relativeTime(commit.committedAt, { longAgo: 'date' }) }}</time></span><span v-if="commit.filePath" class="workspace-commit-historical-path" :title="commit.filePath">{{ commit.filePath }}</span><span class="workspace-commit-refs"><code>{{ commit.hash.slice(0, 7) }}</code><b v-if="commit.hash === head">HEAD</b><b v-if="scope !== 'all' && !startTip && commit.hash === state.tip">{{ scope === 'incoming' ? upstreamLabel || 'upstream' : branchLabel }}</b><b v-for="tag in commit.tags.slice(0, 2)" :key="tag" class="workspace-commit-tag">{{ tag }}</b><b v-if="commit.tags.length > 2" class="workspace-commit-tag" :title="commit.tags.slice(2).join('、')">+{{ commit.tags.length - 2 }} 标签</b></span></span>
            </button>
          </div>
        </div>
        <div v-if="historyError && !searchPending" class="workspace-history-error" role="alert"><AlertTriangle :size="15" /><span>{{ historyError }}</span><button class="compact-button" @click="refreshHistory">刷新后重试</button></div>
        <div v-if="state.hasMore && !hashError && !searchPending && !state.loading && !historyError" ref="sentinel" class="workspace-history-more" role="status" aria-live="polite"><template v-if="state.loadingMore"><LoaderCircle :size="13" class="spinning" />正在加载更多提交…</template><span v-else>向下滚动，自动加载更多</span></div>
      </div>
      <div class="workspace-file-summary"><span>↑ ↓ 浏览提交</span><span>{{ appliedSearch ? '匹配' : '已加载' }} {{ state.commits.length }}{{ state.hasMore ? ' · 还有更多' : ' · 全部记录' }}</span></div>
    </section>
    <div class="workspace-splitter" role="separator" aria-label="调整提交栏宽度" aria-orientation="vertical" :aria-valuenow="paneWidth" aria-valuemin="280" :aria-valuemax="paneMax" tabindex="0" @pointerdown="emit('resize', $event)" @keydown="emit('resizeKey', $event)"></div>
    <section ref="preview" class="workspace-commit-preview" :aria-label="scope === 'compare' && comparisonPreview === 'changes' ? '两端代码差异' : '所选提交的变化'" :aria-busy="scope === 'compare' && comparisonPreview === 'changes' ? comparison.loading.value : state.detailLoading" @scroll.passive="rememberPreview">
      <div v-if="scope === 'compare'" class="workspace-comparison-tabs" role="group" aria-label="对比预览内容"><button :aria-pressed="comparisonPreview === 'changes'" :class="{ active: comparisonPreview === 'changes' }" @click="comparisonPreview = 'changes'"><FileDiff :size="13" />累计差异</button><button :aria-pressed="comparisonPreview === 'commit'" :class="{ active: comparisonPreview === 'commit' }" :disabled="!state.selectedHash" @click="comparisonPreview = 'commit'"><GitCommitHorizontal :size="13" />单条提交</button></div>
      <template v-if="scope === 'compare' && comparisonPreview === 'changes'">
        <div v-if="hashError && !searchPending" class="workspace-empty"><Search :size="24" /><strong>按 SHA 查找提交</strong><span>{{ hashError }}</span></div>
        <div v-else-if="state.loading || searchPending || comparison.loading.value" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取分支差异…</strong></div>
        <div v-else-if="state.error || comparison.error.value" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><strong>读取差异失败</strong><span>{{ state.error || comparison.error.value }}</span><button class="compact-button" @click="state.error ? history.refresh() : comparison.refresh()">重试</button></div>
        <template v-else-if="comparison.detail.value">
          <header class="workspace-commit-meta workspace-comparison-meta"><h3><GitCompareArrows :size="17" />两端代码差异</h3><div class="workspace-comparison-endpoints"><span :title="baseLabel"><b>基准</b> {{ baseLabel }} <code>{{ comparison.detail.value.baseTip.slice(0, 7) }}</code></span><span :title="branchLabel"><b>来源</b> {{ branchLabel }} <code>{{ comparison.detail.value.tip.slice(0, 7) }}</code></span></div><p class="workspace-history-note">从基准端点到来源端点的完整差异；不是合并结果预览。</p></header>
          <div v-if="comparison.detail.value.truncated" class="workspace-history-error" role="status"><AlertTriangle :size="14" />补丁过大，部分文件没有完整预览</div>
          <RepositoryChanges ref="changesPanel" :expansion="expansion" :files="comparison.detail.value.files" :identity="`${comparison.detail.value.baseTip}:${comparison.detail.value.tip}`" :truncated="comparison.detail.value.truncated" empty-message="两个端点的文件内容相同" diff-label="分支端点差异" />
        </template>
        <div v-else class="workspace-empty"><GitCompareArrows :size="28" /><strong>选择来源与基准，查看差异</strong></div>
      </template>
      <div v-else-if="hashError && !searchPending" class="workspace-empty"><Search :size="24" /><strong>输入 SHA 前缀，定位提交</strong></div>
      <div v-else-if="searchPending || state.loading || state.detailLoading" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取提交变化…</strong></div>
      <div v-else-if="state.detailError" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><strong>读取失败</strong><span>{{ state.detailError }}</span><button class="compact-button" @click="state.selectedHash && history.select(state.selectedHash)">重试</button></div>
      <template v-else-if="state.detail">
        <header class="workspace-commit-meta">
          <h3>{{ state.detail.subject }}</h3>
          <div><code :title="state.detail.hash">{{ state.detail.hash.slice(0, 12) }}</code><span>{{ state.detail.author }}</span><time :datetime="state.detail.committedAt">{{ new Date(state.detail.committedAt).toLocaleString() }}</time><a v-if="links?.commitUrl(state.detail.hash)" class="commit-detail-link" :href="links.commitUrl(state.detail.hash) || undefined" target="_blank" rel="noopener noreferrer"><ExternalLink :size="12" />在 {{ links.provider }} 打开</a></div>
          <p v-if="state.detail.body" class="workspace-commit-message">{{ state.detail.body }}</p>
          <span v-if="state.detail.parents.length > 1" class="workspace-history-note">合并提交 · 相对第一父提交的变化</span>
          <span v-else-if="!state.detail.parents.length" class="workspace-history-note">根提交</span>
        </header>
        <div v-if="state.detail.truncated" class="workspace-history-error" role="status"><AlertTriangle :size="14" />补丁过大，部分文件没有完整预览</div>
        <div class="inspection-commit-actions"><button class="workspace-head-link" @click="emit('browseTree', state.detail.hash)"><FolderTree :size="13" />浏览此版本文件</button></div>
        <RepositoryChanges ref="changesPanel" :expansion="expansion" :files="state.detail.files ?? []" :identity="state.detail.hash" :truncated="state.detail.truncated" :file-path="filePath" allow-file-history @browse-file="emit('browseFile', $event, state.detail.hash)" />
      </template>
      <div v-else class="workspace-empty"><GitCommitHorizontal :size="32" /><strong>选择提交，查看变化</strong></div>
    </section>
  </div>
</template>
