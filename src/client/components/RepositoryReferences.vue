<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertTriangle, Archive, GitCommitHorizontal, LoaderCircle, RefreshCw, Tag } from 'lucide-vue-next';
import type { CommitDetail, StashDetail, StashEntry, TagEntry } from '../../shared/contracts';
import { api } from '../api';
import { presentGitDiff } from '../diff-presentation';
import { relativeTime } from '../relative-time';
import type { ReferenceReading } from '../workspace-reading';
import RepositoryChanges from './RepositoryChanges.vue';
import DiffView from './DiffView.vue';

const props = defineProps<{ repositoryId: string; kind: 'stash' | 'tags'; stashes: StashEntry[]; tags: TagEntry[]; loading: boolean; active: boolean; paneWidth: number; paneMax: number }>();
const emit = defineEmits<{ resize: [event: PointerEvent]; resizeKey: [event: KeyboardEvent]; refresh: []; selectEntry: [key: string] }>();
const selectedKeys = ref<Record<'stash' | 'tags', string | null>>({ stash: null, tags: null });
const key = computed(() => selectedKeys.value[props.kind]);
const entries = computed(() => props.kind === 'stash' ? props.stashes.map(stash => ({ key: stash.hash, title: stash.ref, message: stash.message, date: stash.createdAt, hash: stash.hash })) : props.tags.map(tag => ({ key: tag.name, title: tag.name, message: tag.message || tag.commitSubject, date: tag.createdAt, hash: tag.targetHash })));
const selectedStash = computed(() => props.stashes.find(stash => stash.hash === key.value));
const selectedTag = computed(() => props.tags.find(tag => tag.name === key.value));
const commit = ref<CommitDetail | null>(null);
const stash = ref<StashDetail | null>(null);
const loadingDetail = ref(false);
const error = ref('');
const list = ref<HTMLElement | null>(null);
const preview = ref<HTMLElement | null>(null);
const changes = ref<InstanceType<typeof RepositoryChanges> | null>(null);
const stashSummary = ref<HTMLDetailsElement | null>(null);
const stashPresentation = computed(() => stash.value ? presentGitDiff(stash.value.patch, '') : null);
const positions = new Map<string, ReferenceReading>();
let renderedKey = '';
let request = 0;
let controller: AbortController | undefined;
let pendingRestore: ReferenceReading | undefined;
function capture(): ReferenceReading { return { key: key.value, listTop: list.value?.scrollTop ?? 0, previewTop: preview.value?.scrollTop ?? 0, expanded: changes.value?.capture() ?? (stash.value ? [[`${stash.value.hash}\0stat`, stashSummary.value?.open ?? false]] : []) }; }
function remember(): void { if (renderedKey && props.active && !loadingDetail.value) positions.set(renderedKey, capture()); }
function select(next: string): void { if (key.value === next) return; emit('selectEntry', next); remember(); pendingRestore = undefined; selectedKeys.value[props.kind] = next; }
function restore(reading?: ReferenceReading): void {
  if (!reading) return;
  pendingRestore = reading;
  selectedKeys.value[props.kind] = reading.key;
  void read();
}
async function read(): Promise<void> {
  const token = ++request;
  controller?.abort(); controller = new AbortController();
  const kind = props.kind; const selected = key.value;
  commit.value = null; stash.value = null; error.value = ''; loadingDetail.value = false;
  if (!props.active || props.loading || !selected) return;
  const entry = entries.value.find(entry => entry.key === selected);
  if (!entry) { error.value = '此前阅读的条目已不存在，请选择其他条目'; return; }
  loadingDetail.value = true;
  try {
    const result = kind === 'tags' ? await api.commitDetail(props.repositoryId, entry.hash, undefined, controller.signal) : await api.stashDetail(props.repositoryId, entry.hash, controller.signal);
    if (token !== request) return;
    if (result.hash !== entry.hash) throw new Error('预览身份已变化，请刷新重试');
    if (kind === 'tags') commit.value = result as CommitDetail; else stash.value = result as StashDetail;
  } catch (cause) { if (token === request) error.value = cause instanceof Error ? cause.message : '读取预览失败'; }
  finally {
    if (token === request) {
      loadingDetail.value = false; await nextTick();
      if (token !== request || !props.active) return;
      renderedKey = `${kind}\0${selected}`;
      const saved = pendingRestore ?? positions.get(renderedKey);
      pendingRestore = undefined;
      if (saved) {
        changes.value?.restore(saved.expanded);
        if (stashSummary.value && stash.value) stashSummary.value.open = saved.expanded.some(([key, open]) => key === `${stash.value!.hash}\0stat` && open);
      }
      await nextTick();
      if (token !== request) return;
      if (list.value && saved) list.value.scrollTop = saved.listTop;
      if (preview.value) preview.value.scrollTop = saved?.previewTop ?? 0;
    }
  }
}
watch([() => props.kind, key, () => props.loading, () => props.active, () => entries.value.map(entry => `${entry.key}:${entry.hash}`).join('\0')], () => {
  if (!props.active || props.loading) { void read(); return; }
  if (!key.value || (!pendingRestore && !entries.value.some(entry => entry.key === key.value))) selectedKeys.value[props.kind] = entries.value[0]?.key ?? null;
  void read();
}, { immediate: true, flush: 'post' });
function move(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement) || !event.target.matches('.workspace-reference')) return;
  const buttons = [...list.value!.querySelectorAll<HTMLButtonElement>('.workspace-reference')];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
}
defineExpose({ capture, restore });
onBeforeUnmount(() => { request++; controller?.abort(); });
</script>
<template>
  <div class="workspace-history workspace-references">
    <section class="workspace-files workspace-history-list" :aria-label="kind === 'tags' ? '标签列表' : 'Stash 列表'" :style="{ width: `${paneWidth}px` }">
      <div class="workspace-files-heading workspace-history-heading"><div><strong>{{ kind === 'tags' ? '标签' : 'Stash 备份' }}</strong><span>{{ entries.length }} {{ kind === 'tags' ? '个标签' : '条备份' }}</span></div><button class="table-icon-button" :aria-label="kind === 'tags' ? '刷新标签' : '刷新 Stash'" :disabled="loading" @click="emit('refresh')"><RefreshCw :size="14" :class="{ spinning: loading }" /></button></div>
      <details class="workspace-reference-create"><summary>{{ kind === 'tags' ? '创建标签' : '创建备份' }}</summary><slot name="create" /></details>
      <div ref="list" class="workspace-commit-scroll" @keydown="move" @scroll.passive="remember">
        <div v-if="loading && !entries.length" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取列表…</strong></div>
        <div v-else-if="!entries.length" class="workspace-empty"><Tag v-if="kind === 'tags'" :size="28" /><Archive v-else :size="28" /><strong>{{ kind === 'tags' ? '暂无标签' : '暂无 Stash 备份' }}</strong></div>
        <button v-for="entry in entries" :key="entry.key" class="workspace-commit workspace-reference" :class="{ active: key === entry.key }" :aria-pressed="key === entry.key" :aria-label="`查看${kind === 'tags' ? '标签' : '备份'} ${entry.title}`" @click="select(entry.key)"><span class="workspace-commit-marker"><Tag v-if="kind === 'tags'" :size="14" /><Archive v-else :size="14" /></span><span class="workspace-commit-copy"><strong :title="entry.title">{{ entry.title }}</strong><span class="workspace-reference-message" :title="entry.message">{{ entry.message }}</span><span class="workspace-commit-author"><code>{{ entry.hash.slice(0, 7) }}</code><time v-if="entry.date">{{ relativeTime(entry.date, { longAgo: 'date' }) }}</time></span></span></button>
      </div>
      <div class="workspace-file-summary"><span>↑ ↓ 浏览{{ kind === 'tags' ? '标签' : '备份' }}</span><span>{{ entries.length }} 条</span></div>
    </section>
    <div class="workspace-splitter" role="separator" aria-label="调整列表栏宽度" aria-orientation="vertical" :aria-valuenow="paneWidth" aria-valuemin="280" :aria-valuemax="paneMax" tabindex="0" @pointerdown="emit('resize', $event)" @keydown="emit('resizeKey', $event)"></div>
    <section ref="preview" class="workspace-commit-preview" :aria-label="kind === 'tags' ? '所选标签的变化' : '所选备份的变化'" :aria-busy="loadingDetail" @scroll.passive="remember">
      <header v-if="selectedTag || selectedStash" class="workspace-commit-meta workspace-reference-meta">
        <div class="workspace-reference-heading">
          <div class="workspace-reference-title">
            <h3>{{ selectedTag?.name ?? selectedStash?.ref }}</h3>
            <p class="workspace-reference-caption"><span v-if="selectedTag">{{ selectedTag.annotated ? '附注标签' : '轻量标签' }} · 指向 {{ selectedTag.targetHash.slice(0, 7) }}</span><span v-if="selectedStash">{{ relativeTime(selectedStash.createdAt) }}</span></p>
          </div>
          <div class="workspace-reference-actions"><slot name="actions" :tag="selectedTag" :stash="selectedStash" /></div>
        </div>
        <p v-if="selectedTag?.message || selectedStash?.message" class="workspace-commit-message">{{ selectedTag?.message ?? selectedStash?.message }}</p>
      </header>
      <div v-if="loadingDetail" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取变化…</strong></div>
      <div v-else-if="error" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><strong>无法读取预览</strong><span>{{ error }}</span><button class="compact-button" @click="read">重试</button></div>
      <template v-else-if="commit"><header class="workspace-commit-meta"><h3>{{ commit.subject }}</h3><div><GitCommitHorizontal :size="14" /><code>{{ commit.hash.slice(0, 12) }}</code><span>{{ commit.author }}</span><time>{{ new Date(commit.committedAt).toLocaleString() }}</time></div><p v-if="commit.body" class="workspace-commit-message">{{ commit.body }}</p><span v-if="commit.parents.length > 1" class="workspace-history-note">合并提交 · 相对第一父提交的变化</span></header><div v-if="commit.truncated" class="workspace-history-error">补丁过大，部分文件没有完整预览</div><RepositoryChanges ref="changes" :files="commit.files ?? []" :identity="commit.hash" :truncated="commit.truncated" /></template>
      <template v-else-if="stash && stashPresentation">
        <div v-if="stash.truncated" class="workspace-history-error">补丁过大，预览已截断</div>
        <details v-if="selectedStash?.stat" ref="stashSummary" :key="stash.hash" class="workspace-stash-summary" @toggle="remember">
          <summary><span>变化文件摘要</span><span class="addition">+{{ stashPresentation.additions }}</span><span class="deletion">−{{ stashPresentation.deletions }}</span></summary>
          <pre class="workspace-stash-stat">{{ selectedStash.stat }}</pre>
        </details>
        <div class="workspace-stash-diff"><DiffView :presentation="stashPresentation" :label="`Stash ${stash.hash.slice(0, 7)} 的变化`" /></div>
      </template>
      <div v-else class="workspace-empty"><Archive v-if="kind === 'stash'" :size="28" /><Tag v-else :size="28" /><strong>{{ kind === 'tags' ? '选择标签，查看变化' : '选择备份，查看变化' }}</strong></div>
    </section>
  </div>
</template>
