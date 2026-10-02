<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertTriangle, ArrowLeft, ChevronRight, File, Folder, GitCommitHorizontal, History, Link, LoaderCircle, Search, X } from 'lucide-vue-next';
import { api } from '../api';
import { useRepositoryRead } from '../use-repository-read';
import type { RevisionReading } from '../workspace-reading';
import CodeContent from './CodeContent.vue';
const props = defineProps<{ repositoryId: string; commit: string; initialPath?: string; initialBlame?: boolean; active: boolean; paneWidth: number; paneMax: number }>();
const emit = defineEmits<{ resize: [event: PointerEvent]; resizeKey: [event: KeyboardEvent]; navigate: [reading: RevisionReading]; commit: [hash: string]; fileHistory: [path: string, commit: string] }>();
const directory = ref(''), selected = ref<string | null>(null), skip = ref(0), search = ref(''), blameMode = ref(false);
const list = ref<HTMLElement | null>(null), preview = ref<HTMLElement | null>(null), input = ref<HTMLInputElement | null>(null);
const tree = useRepositoryRead(() => props.active && props.commit ? JSON.stringify([props.repositoryId, props.commit, directory.value, skip.value, search.value]) : null,
  signal => api.revisionTree(props.repositoryId, { commit: props.commit, path: directory.value, skip: skip.value, search: search.value }, signal));
const file = useRepositoryRead(() => props.active && props.commit && selected.value ? JSON.stringify([props.repositoryId, props.commit, selected.value]) : null,
  signal => api.revisionFile(props.repositoryId, props.commit, selected.value!, signal));
const canBlame = computed(() => file.data.value?.kind === 'file' && !file.data.value.binary && !file.data.value.truncated);
const blame = useRepositoryRead(() => props.active && blameMode.value && canBlame.value ? JSON.stringify([props.repositoryId, props.commit, selected.value]) : null,
  signal => api.fileBlame(props.repositoryId, props.commit, selected.value!, signal));
watch([() => props.commit, () => props.initialPath, () => props.initialBlame], () => {
  const path = props.initialPath ?? '';
  directory.value = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  selected.value = path || null; skip.value = 0; search.value = ''; blameMode.value = Boolean(props.initialBlame);
}, { immediate: true });
watch(tree.data, value => { if (value && !selected.value) selected.value = value.entries.find(entry => entry.kind !== 'directory')?.path ?? null; });
watch(search, () => { skip.value = 0; }, { flush: 'sync' });
function capture(): RevisionReading { return { commit: props.commit, directory: directory.value, path: selected.value, skip: skip.value, search: search.value, blame: blameMode.value, listTop: list.value?.scrollTop ?? 0, previewTop: preview.value?.scrollTop ?? 0, previewLeft: preview.value?.scrollLeft ?? 0 }; }
function change(patch: Partial<RevisionReading>): void {
  restoreSequence++; stopRestore?.();
  const next = { ...capture(), listTop: 0, previewTop: 0, previewLeft: 0, ...patch }; emit('navigate', next);
  directory.value = next.directory; selected.value = next.path; search.value = next.search; skip.value = next.skip; blameMode.value = next.blame;
  void nextTick(() => { if (list.value) list.value.scrollTop = next.listTop; if (preview.value) { preview.value.scrollTop = next.previewTop; preview.value.scrollLeft = next.previewLeft; } });
}
function openDirectory(path: string): void { change({ directory: path, path: null, skip: 0, search: '', blame: false }); }
function selectFile(path: string): void { change({ path, blame: false, listTop: list.value?.scrollTop ?? 0 }); }
function move(event: KeyboardEvent): void {
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.revision-entry') || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const buttons = [...list.value!.querySelectorAll<HTMLButtonElement>('.revision-entry')]; const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault(); buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' });
  if (buttons[next]?.dataset.kind !== 'directory') buttons[next]?.click();
}
let restoreSequence = 0, stopRestore: (() => void) | undefined;
async function restore(reading?: RevisionReading): Promise<void> {
  if (!reading || reading.commit !== props.commit) return;
  const token = ++restoreSequence; stopRestore?.();
  directory.value = reading.directory; selected.value = reading.path; search.value = reading.search; skip.value = reading.skip; blameMode.value = reading.blame;
  await nextTick();
  const apply = async () => {
    if (token !== restoreSequence || !props.active) { stopRestore?.(); return; }
    if (tree.loading.value || file.loading.value || blame.loading.value) return;
    await nextTick(); if (token !== restoreSequence) return;
    if (list.value) list.value.scrollTop = reading.listTop;
    if (preview.value) { preview.value.scrollTop = reading.previewTop; preview.value.scrollLeft = reading.previewLeft; }
    stopRestore?.();
  };
  stopRestore = watch([tree.loading, file.loading, blame.loading], () => { void apply(); }, { flush: 'post' }); void apply();
}
watch(() => props.active, active => { if (!active) { restoreSequence++; stopRestore?.(); } });
onBeforeUnmount(() => { restoreSequence++; stopRestore?.(); });
defineExpose({ capture, restore, focusSearch: () => input.value?.focus({ preventScroll: true }) });
</script>
<template>
  <div class="workspace-history workspace-tree">
    <section class="workspace-files workspace-history-list" :style="{ width: `${paneWidth}px` }" aria-label="历史文件树">
      <div class="workspace-files-heading workspace-history-heading"><div><strong>历史文件树</strong><span :title="commit">提交 {{ commit.slice(0, 12) }}</span></div><GitCommitHorizontal :size="16" /></div>
      <div class="inspection-directory"><button v-if="directory" class="table-icon-button" aria-label="返回上级目录" @click="openDirectory(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '')"><ArrowLeft :size="14" /></button><button class="workspace-head-link" @click="openDirectory('')">根目录</button><span v-if="directory" :title="directory">/ {{ directory }}</span></div>
      <label class="workspace-file-search inspection-search"><Search :size="13" /><input ref="input" v-model="search" placeholder="搜索当前目录 ⌘K" maxlength="300" aria-label="搜索历史文件" /><button v-if="search" class="table-icon-button" aria-label="清除文件树搜索" @click="search = ''"><X :size="12" /></button></label>
      <div ref="list" class="workspace-commit-scroll" @keydown="move">
        <div v-if="tree.loading.value" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取目录…</strong></div>
        <div v-else-if="tree.error.value" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><span>{{ tree.error.value }}</span><button class="compact-button" @click="tree.refresh">重试</button></div>
        <template v-else><button v-for="entry in tree.data.value?.entries" :key="entry.path" class="revision-entry" :data-kind="entry.kind" :class="{ active: selected === entry.path }" :aria-pressed="entry.kind !== 'directory' ? selected === entry.path : undefined" :aria-label="`${entry.kind === 'directory' ? '打开目录' : '查看历史文件'} ${entry.name}`" :title="entry.path" @click="entry.kind === 'directory' ? openDirectory(entry.path) : selectFile(entry.path)"><Folder v-if="entry.kind === 'directory'" :size="15" /><Link v-else-if="entry.kind === 'symlink'" :size="15" /><File v-else :size="15" /><span>{{ entry.name }}</span><ChevronRight v-if="entry.kind === 'directory'" :size="12" /><small v-else>{{ entry.kind === 'submodule' ? '子模块' : entry.size === null ? '' : `${entry.size} B` }}</small></button><div v-if="!tree.data.value?.entries.length" class="workspace-empty"><Folder :size="24" /><strong>{{ search ? '没有匹配文件' : '空目录' }}</strong></div></template>
      </div>
      <div class="workspace-file-summary"><span>{{ tree.data.value?.total ?? '—' }} 个条目</span><div class="inspection-page-actions"><button :disabled="skip === 0 || tree.loading.value" @click="change({ skip: Math.max(0, skip - 100), path: null })">上一页</button><button :disabled="!tree.data.value?.hasMore || tree.loading.value" @click="change({ skip: skip + 100, path: null })">下一页</button></div></div>
    </section>
    <div class="workspace-splitter" role="separator" aria-label="调整文件树栏宽度" aria-orientation="vertical" :aria-valuenow="paneWidth" aria-valuemin="280" :aria-valuemax="paneMax" tabindex="0" @pointerdown="emit('resize', $event)" @keydown="emit('resizeKey', $event)" />
    <section ref="preview" class="workspace-commit-preview" aria-label="历史文件内容">
      <div class="inspection-toolbar"><strong :title="selected ?? undefined">{{ selected ?? '选择文件' }}</strong><button v-if="selected" class="table-icon-button" aria-label="查看这个版本的文件历史" @click="emit('fileHistory', selected, commit)"><History :size="14" /></button></div>
      <div v-if="file.loading.value" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取文件…</strong></div>
      <div v-else-if="file.error.value" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><span>{{ file.error.value }}</span><button class="compact-button" @click="file.refresh">重试</button></div>
      <template v-else-if="file.data.value">
        <div class="inspection-tabs" role="group" aria-label="文件阅读模式"><button :class="{ active: !blameMode }" :aria-pressed="!blameMode" @click="change({ blame: false, listTop: list?.scrollTop ?? 0 })">文件内容</button><button :disabled="!canBlame" :class="{ active: blameMode }" :aria-pressed="blameMode" title="逐行查看作者、时间和归属提交" @click="change({ blame: true, listTop: list?.scrollTop ?? 0 })">Blame 行归属</button></div>
        <p class="inspection-notice">{{ commit.slice(0, 12) }} · {{ file.data.value.size }} 字节 · 此版本内容，不包含工作区修改</p>
        <div v-if="file.data.value.kind === 'submodule'" class="workspace-empty"><strong>子模块提交</strong><code>{{ file.data.value.objectId }}</code></div>
        <div v-else-if="file.data.value.binary" class="workspace-empty"><strong>二进制或非 UTF-8 文件</strong><span>没有文本预览</span></div>
        <template v-else>
          <p v-if="file.data.value.kind === 'symlink'" class="inspection-notice">符号链接保存的目标文本；不会访问目标文件。</p>
          <p v-if="file.data.value.truncated" class="inspection-notice" role="status">文件过大，仅预览前 200 KB／2000 行。完整文件可在本地 Git 中查看。</p>
          <div v-if="blameMode && blame.loading.value" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>读取行归属…</strong></div>
          <div v-else-if="blameMode && blame.error.value" class="workspace-empty" role="alert"><span>{{ blame.error.value }}</span><button class="compact-button" @click="blame.refresh">重试</button></div>
          <CodeContent v-else :content="file.data.value.content ?? ''" :path="file.data.value.path" :label="`${blameMode ? '行归属' : '历史内容'} ${selected}`" :blame="blameMode ? blame.data.value?.lines : undefined" @commit="emit('commit', $event)" />
        </template>
      </template>
      <div v-else class="workspace-empty"><File :size="28" /><strong>选择文件，查看此版本内容</strong></div>
    </section>
  </div>
</template>
