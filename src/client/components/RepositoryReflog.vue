<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertTriangle, ChevronDown, FolderTree, History, LoaderCircle, RefreshCw } from 'lucide-vue-next';
import { api } from '../api';
import { useRepositoryRead } from '../use-repository-read';
import { useRepositoryReflog, reflogEntryKey } from '../use-repository-reflog';
import type { ReflogReading } from '../workspace-reading';
import type { SelectMenuOption } from '../select-options';
import SelectMenu from './SelectMenu.vue';
import RepositoryChanges from './RepositoryChanges.vue';
const props = defineProps<{ repositoryId: string; active: boolean; options: SelectMenuOption[]; paneWidth: number; paneMax: number }>();
const emit = defineEmits<{ resize: [event: PointerEvent]; resizeKey: [event: KeyboardEvent]; navigate: [reading: ReflogReading]; tree: [commit: string]; fileHistory: [path: string, commit: string] }>();
const reference = ref('HEAD'), list = ref<HTMLElement | null>(null), preview = ref<HTMLElement | null>(null), changes = ref<InstanceType<typeof RepositoryChanges> | null>(null);
const log = useRepositoryReflog({ repositoryId: () => props.repositoryId, reference: () => reference.value, active: () => props.active, read: api.reflog });
const entry = computed(() => log.entries.value.find(entry => reflogEntryKey(entry) === log.selected.value));
const detail = useRepositoryRead(() => props.active && entry.value ? JSON.stringify([props.repositoryId, entry.value.hash]) : null, signal => api.commitDetail(props.repositoryId, entry.value!.hash, undefined, signal));
const refOptions = computed(() => [{ value: 'HEAD', label: 'HEAD', hint: '当前工作树的移动记录' }, ...props.options.filter(option => String(option.value).startsWith('refs/heads/'))]);
function capture(): ReflogReading { return { ref: reference.value, key: log.selected.value, listTop: list.value?.scrollTop ?? 0, previewTop: preview.value?.scrollTop ?? 0, expanded: changes.value?.capture() ?? [] }; }
let restoreSequence = 0;
function select(key: string): void {
  restoreSequence++; if (key === log.selected.value) return;
  emit('navigate', { ...capture(), key, previewTop: 0, expanded: [] }); log.selected.value = key;
  void nextTick(() => { if (preview.value) preview.value.scrollTop = 0; });
}
function changeRef(value: string | number): void { restoreSequence++; emit('navigate', { ref: String(value), key: null, listTop: 0, previewTop: 0, expanded: [] }); reference.value = String(value); }
function move(event: KeyboardEvent): void {
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.workspace-commit') || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...list.value!.querySelectorAll<HTMLButtonElement>('.workspace-commit')]; const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault(); buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' }); buttons[next]?.click();
}
async function restore(reading?: ReflogReading): Promise<void> {
  if (!reading) return; const token = ++restoreSequence; reference.value = reading.ref; await nextTick();
  while (log.loading.value) { await new Promise<void>(resolve => { const stop = watch(log.loading, loading => { if (!loading) { stop(); resolve(); } }); }); }
  if (log.loadingMore.value) await new Promise<void>(resolve => { const stop = watch(log.loadingMore, loading => { if (!loading) { stop(); resolve(); } }); });
  if (token !== restoreSequence || !props.active) return;
  while (reading.key && !log.entries.value.some(entry => reflogEntryKey(entry) === reading.key) && log.hasMore.value && !log.error.value) { await log.loadMore(); if (token !== restoreSequence || !props.active) return; }
  if (reading.key && !log.entries.value.some(entry => reflogEntryKey(entry) === reading.key)) { log.error.value = '此前阅读的 Reflog 条目已过期，请刷新或选择其他记录'; return; }
  if (reading.key) log.selected.value = reading.key;
  await nextTick();
  if (detail.loading.value) await new Promise<void>(resolve => { const stop = watch(detail.loading, loading => { if (!loading) { stop(); resolve(); } }); });
  if (token !== restoreSequence || !props.active) return;
  await nextTick(); changes.value?.restore(reading.expanded); await nextTick();
  if (list.value) list.value.scrollTop = reading.listTop; if (preview.value) preview.value.scrollTop = reading.previewTop;
}
onBeforeUnmount(() => { restoreSequence++; });
watch(() => props.active, active => { if (!active) restoreSequence++; });
defineExpose({ capture, restore, focusSearch: () => list.value?.querySelector<HTMLButtonElement>('.workspace-commit')?.focus({ preventScroll: true }) });
</script>
<template>
  <div class="workspace-history workspace-reflog">
    <section class="workspace-files workspace-history-list" :style="{ width: `${paneWidth}px` }" aria-label="Reflog 引用记录">
      <div class="workspace-files-heading workspace-history-heading"><div><strong>Reflog</strong><span>本机引用移动记录</span></div><button class="table-icon-button" aria-label="刷新 Reflog" :disabled="log.loading.value || log.loadingMore.value" @click="log.refresh"><RefreshCw :size="14" /></button></div>
      <div class="inspection-reflog-controls"><SelectMenu :model-value="reference" :options="refOptions" aria-label="Reflog 引用" class="select-menu--compact" @update:model-value="changeRef" /><p class="workspace-history-note">按发生顺序 · 阅读快照 · 不是 Fleet 操作记录</p></div>
      <div ref="list" class="workspace-commit-scroll" @keydown="move">
        <div v-if="log.loading.value" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取引用记录…</strong></div>
        <div v-else-if="!log.entries.value.length && !log.error.value" class="workspace-empty"><History :size="28" /><strong>没有 Reflog 记录</strong><span>新仓库或未启用 Reflog 的引用可能没有记录。</span></div>
        <template v-else><button v-for="item in log.entries.value" :key="reflogEntryKey(item)" class="workspace-commit" :class="{ active: log.selected.value === reflogEntryKey(item) }" :aria-pressed="log.selected.value === reflogEntryKey(item)" :aria-label="`查看引用记录 ${item.selector} ${item.message}`" :title="item.message" @click="select(reflogEntryKey(item))"><span class="workspace-commit-marker"><History :size="14" /></span><span class="workspace-commit-copy"><strong>{{ item.message }}</strong><span class="workspace-commit-author">{{ item.actor }} <time :datetime="item.occurredAt" :title="new Date(item.occurredAt).toLocaleString()">{{ new Date(item.occurredAt).toLocaleString() }}</time></span><span class="workspace-commit-refs"><code>{{ item.hash.slice(0, 7) }}</code><b>{{ item.selector }}</b></span></span></button></template>
        <div v-if="log.error.value" class="workspace-history-error" role="alert"><AlertTriangle :size="14" /><span>{{ log.error.value }}</span><button class="compact-button" @click="log.refresh">刷新</button></div>
        <button v-if="log.hasMore.value" class="workspace-load-more" :disabled="log.loading.value || log.loadingMore.value" @click="log.loadMore"><LoaderCircle v-if="log.loadingMore.value" :size="14" class="spinning" /><ChevronDown v-else :size="14" />加载更多引用记录</button>
      </div>
      <div class="workspace-file-summary"><span>↑ ↓ 浏览记录</span><span>已加载 {{ log.entries.value.length }}{{ log.hasMore.value ? ' · 还有更多' : ' · 全部记录' }}</span></div><p v-if="log.truncated.value" class="inspection-notice">本次快照最多读取 10000 条。</p>
    </section>
    <div class="workspace-splitter" role="separator" aria-label="调整 Reflog 栏宽度" aria-orientation="vertical" :aria-valuenow="paneWidth" aria-valuemin="280" :aria-valuemax="paneMax" tabindex="0" @pointerdown="emit('resize', $event)" @keydown="emit('resizeKey', $event)" />
    <section ref="preview" class="workspace-commit-preview" aria-label="Reflog 目标提交">
      <div v-if="detail.loading.value" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取目标提交…</strong></div>
      <div v-else-if="detail.error.value" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><span>{{ detail.error.value }}</span><span>记录仍存在时，提交对象也可能已被 Git 回收。</span><button class="compact-button" @click="detail.refresh">重试</button></div>
      <template v-else-if="detail.data.value"><header class="workspace-commit-meta"><h3>{{ detail.data.value.subject }}</h3><div><code>{{ detail.data.value.hash.slice(0, 12) }}</code><span>{{ detail.data.value.author }}</span><time>{{ new Date(detail.data.value.committedAt).toLocaleString() }}</time></div><p v-if="detail.data.value.body">{{ detail.data.value.body }}</p><button class="workspace-head-link inspection-tree-link" @click="emit('tree', detail.data.value.hash)"><FolderTree :size="13" />浏览此版本文件</button></header><div v-if="detail.data.value.truncated" class="workspace-history-error" role="status">补丁过大，部分文件没有完整预览。</div><RepositoryChanges ref="changes" :files="detail.data.value.files ?? []" :identity="detail.data.value.hash" :truncated="detail.data.value.truncated" allow-file-history @browse-file="emit('fileHistory', $event, detail.data.value!.hash)" /></template>
      <div v-else class="workspace-empty"><History :size="28" /><strong>选择一条引用记录</strong></div>
    </section>
  </div>
</template>
