<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertTriangle, ChevronDown, ExternalLink, FileDiff, GitCommitHorizontal, History, LoaderCircle, RefreshCw, Search, X } from 'lucide-vue-next';
import type { CommitPageQuery } from '../../shared/contracts';
import { api } from '../api';
import { presentGitDiff } from '../diff-presentation';
import { relativeTime } from '../relative-time';
import { remoteLinks } from '../remote-links';
import { useRepositoryHistory } from '../use-repository-history';
import DiffView from './DiffView.vue';
import SelectMenu from './SelectMenu.vue';

const props = defineProps<{ repositoryId: string; remoteUrl: string | null; reference?: string; scope?: 'all' | 'ref'; filePath?: string; startTip?: string; revision: string; branchLabel: string; head: string; active: boolean; paneWidth: number; paneMax: number }>();
const links = computed(() => remoteLinks(props.remoteUrl));
const emit = defineEmits<{ resize: [event: PointerEvent]; resizeKey: [event: KeyboardEvent]; browseHead: []; browseAll: []; browseFile: [path: string, tip: string] }>();
const search = ref('');
const appliedSearch = ref('');
const searchField = ref<'message' | 'author' | 'hash'>('message');
const searchFields = [{ value: 'message', label: '消息' }, { value: 'author', label: '作者' }, { value: 'hash', label: 'SHA' }];
const searchFieldModel = computed<string | number>({ get: () => searchField.value, set: value => { if (value === 'message' || value === 'author' || value === 'hash') searchField.value = value; } });
const hashError = computed(() => searchField.value === 'hash' && appliedSearch.value && !/^[a-f0-9]{4,64}$/i.test(appliedSearch.value) ? '请输入至少 4 位十六进制 SHA 前缀' : '');
const query = computed<CommitPageQuery>(() => ({ scope: props.scope ?? 'ref', ...(props.filePath ? { filePath: props.filePath, tip: props.startTip } : {}), ...(appliedSearch.value ? { search: appliedSearch.value, searchField: searchField.value } : {}) }));
const history = useRepositoryHistory({ repositoryId: () => props.repositoryId, reference: () => props.reference, query: () => query.value, revision: () => props.revision, active: () => props.active && !hashError.value, readPage: api.repositoryCommits, readDetail: api.commitDetail });
const state = history.state;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const searchPending = computed(() => search.value.trim() !== appliedSearch.value);
watch(search, value => {
  clearTimeout(searchTimer);
  if (value.trim() === appliedSearch.value) return;
  if (!value.trim()) appliedSearch.value = '';
  else searchTimer = setTimeout(() => { appliedSearch.value = value.trim(); }, 250);
}, { flush: 'sync' });
watch(() => props.filePath, () => { search.value = ''; });
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const preview = ref<HTMLElement | null>(null);
const filtered = computed(() => state.value.commits);
const changes = computed(() => (state.value.detail?.files ?? []).map(file => {
  const presentation = file.patch === null ? null : presentGitDiff(file.patch, file.path);
  if (presentation?.lines.some(line => line.kind === 'hunk')) presentation.lines = presentation.lines.filter(line => line.kind !== 'header');
  return { ...file, presentation };
}));
const totals = computed(() => changes.value.reduce((sum, file) => ({ additions: sum.additions + (file.presentation?.additions ?? 0), deletions: sum.deletions + (file.presentation?.deletions ?? 0) }), { additions: 0, deletions: 0 }));
const statusLabels: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变化' };
const expanded = ref(new Map<string, boolean>());
const fileKey = (path: string) => `${state.value.selectedHash}\0${path}`;
function fileToggle(event: Event, path: string): void {
  if (event.target instanceof HTMLDetailsElement) expanded.value.set(fileKey(path), event.target.open);
}
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
  if (props.active && preview.value && state.value.detail && !state.value.detailLoading && !restoringPreview && renderedPreviewHash === state.value.detail.hash) previewPositions.set(renderedPreviewHash, { top: preview.value.scrollTop, left: preview.value.scrollLeft });
}
watch([history.contextKey, () => props.active], () => {
  if (props.active && list.value?.getClientRects().length && renderedListKey && !restoringList) listPositions.set(renderedListKey, list.value.scrollTop);
  restoringList = true;
}, { flush: 'sync' });
watch([() => state.value.detail?.hash, () => props.active], () => {
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
watch([() => state.value.detail?.hash, () => props.active], async () => {
  const token = ++previewRestoreRequest;
  await nextTick();
  if (token !== previewRestoreRequest || !props.active || !preview.value || !state.value.detail) return;
  renderedPreviewHash = state.value.detail.hash;
  const position = previewPositions.get(renderedPreviewHash);
  preview.value.scrollTop = position?.top ?? 0;
  preview.value.scrollLeft = position?.left ?? 0;
  requestAnimationFrame(() => { if (token === previewRestoreRequest) restoringPreview = false; });
}, { flush: 'post' });
function focusSearch(): void { input.value?.focus({ preventScroll: true }); }
defineExpose({ focusSearch });
onBeforeUnmount(() => { clearTimeout(searchTimer); history.invalidate(); });
</script>

<template>
  <div class="workspace-history">
    <section class="workspace-files workspace-history-list" aria-label="分支提交历史" :style="{ width: `${paneWidth}px` }">
      <div class="workspace-files-heading workspace-history-heading">
        <div><strong>{{ filePath ? '文件历史' : scope === 'all' ? '全仓历史' : '提交历史' }}</strong><span :title="filePath || branchLabel">{{ filePath || `浏览 ${branchLabel}` }}</span></div>
        <button class="table-icon-button" aria-label="刷新历史记录" :disabled="state.loading || searchPending" @click="history.refresh"><RefreshCw :size="14" :class="{ spinning: state.loading }" /></button>
      </div>
      <div class="workspace-history-search">
        <div class="workspace-history-search-row">
          <SelectMenu v-model="searchFieldModel" :options="searchFields" aria-label="历史搜索条件" class="select-menu--compact" />
          <label class="workspace-file-search"><Search :size="13" /><input ref="input" v-model="search" maxlength="300" aria-label="搜索提交记录" :placeholder="searchField === 'hash' ? 'SHA 前缀（至少 4 位）' : searchField === 'author' ? '姓名或邮箱 ⌘K' : '标题或正文 ⌘K'" @keydown.down="enterList" /><button v-if="search" class="table-icon-button" aria-label="清除历史搜索" @click="search = ''; focusSearch()"><X :size="12" /></button></label>
        </div>
        <div class="workspace-history-scope-links"><button v-if="scope !== 'all'" class="workspace-head-link" @click="emit('browseAll')">全仓历史</button><button v-if="scope === 'all' || reference || filePath" class="workspace-head-link" @click="emit('browseHead')">当前分支历史</button></div>
        <span v-if="filePath" class="workspace-history-note" :title="branchLabel">{{ startTip ? `起点 ${startTip.slice(0, 7)}` : branchLabel }} · 跟踪重命名</span>
      </div>
      <div ref="list" class="workspace-commit-scroll" @keydown="moveCommit" @scroll.passive="rememberList">
        <div v-if="hashError && !searchPending" class="workspace-empty"><Search :size="24" /><strong>按 SHA 查找提交</strong><span>{{ hashError }}</span></div>
        <div v-else-if="searchPending || state.loading" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>{{ search ? '搜索历史…' : '读取历史…' }}</strong></div>
        <div v-else-if="!state.commits.length && !state.error" class="workspace-empty"><Search v-if="appliedSearch" :size="24" /><GitCommitHorizontal v-else :size="28" /><strong>{{ appliedSearch ? '没有匹配的提交' : filePath ? '此文件没有提交历史' : '暂无提交' }}</strong><span>{{ appliedSearch ? '已搜索当前范围的完整历史' : filePath ? '未跟踪且从未提交的文件没有历史记录' : '当前历史范围尚无提交记录' }}</span></div>
        <div v-if="state.error && !searchPending" class="workspace-history-error" role="alert"><AlertTriangle :size="15" /><span>{{ state.error }}</span><button class="compact-button" @click="history.refresh()">刷新后重试</button></div>
        <div v-show="!hashError && !searchPending && !state.loading" role="list" :aria-label="`${branchLabel} 的提交历史`">
          <div v-for="commit in filtered" :key="commit.hash" role="listitem">
            <button class="workspace-commit" :class="{ active: state.selectedHash === commit.hash }" :aria-pressed="state.selectedHash === commit.hash" :aria-label="`查看提交 ${commit.hash.slice(0, 7)} ${commit.subject}`" :title="commit.subject" @click="history.select(commit.hash)">
              <span class="workspace-commit-marker" aria-hidden="true"><GitCommitHorizontal :size="14" /></span>
              <span class="workspace-commit-copy"><strong>{{ commit.subject }}</strong><span class="workspace-commit-author">{{ commit.author }} <time :datetime="commit.committedAt" :title="new Date(commit.committedAt).toLocaleString()">{{ relativeTime(commit.committedAt, { longAgo: 'date' }) }}</time></span><span v-if="commit.filePath" class="workspace-commit-historical-path" :title="commit.filePath">{{ commit.filePath }}</span><span class="workspace-commit-refs"><code>{{ commit.hash.slice(0, 7) }}</code><b v-if="commit.hash === head">HEAD</b><b v-if="scope !== 'all' && !startTip && commit.hash === state.tip">{{ branchLabel }}</b><b v-for="tag in commit.tags.slice(0, 2)" :key="tag" class="workspace-commit-tag">{{ tag }}</b><b v-if="commit.tags.length > 2" class="workspace-commit-tag" :title="commit.tags.slice(2).join('、')">+{{ commit.tags.length - 2 }} 标签</b></span></span>
            </button>
          </div>
        </div>
        <button v-if="state.hasMore && !searchPending && !state.loading" class="compact-button workspace-history-more" :disabled="state.loadingMore" @click="history.loadMore"><LoaderCircle v-if="state.loadingMore" :size="13" class="spinning" /><ChevronDown v-else :size="13" />加载更多提交</button>
      </div>
      <div class="workspace-file-summary"><span>↑ ↓ 浏览提交</span><span>{{ appliedSearch ? '匹配' : '已加载' }} {{ state.commits.length }}{{ state.hasMore ? ' · 还有更多' : ' · 全部记录' }}</span></div>
    </section>
    <div class="workspace-splitter" role="separator" aria-label="调整提交栏宽度" aria-orientation="vertical" :aria-valuenow="paneWidth" aria-valuemin="280" :aria-valuemax="paneMax" tabindex="0" @pointerdown="emit('resize', $event)" @keydown="emit('resizeKey', $event)"></div>
    <section ref="preview" class="workspace-commit-preview" aria-label="所选提交的变化" :aria-busy="state.detailLoading" @scroll.passive="rememberPreview">
      <div v-if="hashError && !searchPending" class="workspace-empty"><Search :size="24" /><strong>输入 SHA 前缀，定位提交</strong></div>
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
        <div class="workspace-commit-summary"><span>{{ filePath ? '所选文件的变化' : `${changes.length} 个变化文件` }}</span><span class="addition">+{{ totals.additions }}</span><span class="deletion">−{{ totals.deletions }}</span><span v-if="state.detail.truncated">已加载部分</span></div>
        <details v-for="(file, index) in changes" :key="`${state.detail.hash}:${file.path}`" class="workspace-commit-file" :open="expanded.get(fileKey(file.path)) ?? index === 0" @toggle="fileToggle($event, file.path)">
          <summary :title="file.originalPath ? `${file.originalPath} → ${file.path}` : file.path"><ChevronDown :size="13" /><span class="workspace-change-status" :data-status="file.status">{{ statusLabels[file.status] ?? file.status }}</span><strong>{{ file.path }}</strong><span v-if="file.presentation" class="addition">+{{ file.presentation.additions }}</span><span v-if="file.presentation" class="deletion">−{{ file.presentation.deletions }}</span></summary>
          <p v-if="file.originalPath" class="workspace-history-note workspace-rename-note">{{ file.originalPath }} → {{ file.path }}</p>
          <div v-if="!filePath" class="workspace-file-history-action"><button class="workspace-head-link" :aria-label="`查看文件历史 ${file.path}`" @click="emit('browseFile', file.path, state.detail.hash)"><History :size="12" />查看文件历史</button></div>
          <div v-if="file.presentation" class="workspace-commit-file-diff"><DiffView :presentation="file.presentation" :label="`提交 ${state.detail.hash.slice(0, 7)} 中 ${file.path} 的变化`" /></div>
          <p v-else class="workspace-history-note workspace-rename-note">该文件没有完整补丁预览，请在本地查看</p>
        </details>
        <div v-if="!changes.length" class="workspace-empty"><FileDiff :size="28" /><strong>没有文件变化</strong><span>这个提交只包含提交记录</span></div>
      </template>
      <div v-else class="workspace-empty"><GitCommitHorizontal :size="32" /><strong>选择提交，查看变化</strong></div>
    </section>
  </div>
</template>
