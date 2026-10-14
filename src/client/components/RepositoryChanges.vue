<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, FileDiff, FolderClosed, FolderOpen, History, List, ListTree } from 'lucide-vue-next';
import type { CommitFileChange } from '../../shared/contracts';
import { presentGitDiff } from '../diff-presentation';
import { buildFileTree, flattenTree, type FileTreeNode } from '../file-tree';
import { useFileListView } from '../file-list-view';
import DiffView from './DiffView.vue';
const props = defineProps<{ files: CommitFileChange[]; identity: string; truncated: boolean; filePath?: string; allowFileHistory?: boolean; emptyMessage?: string; diffLabel?: string; expansion?: Map<string, boolean> }>();
const emit = defineEmits<{ browseFile: [path: string] }>();
const changes = computed(() => (props.files).map(file => {
  const presentation = file.patch === null ? null : presentGitDiff(file.patch, file.path);
  if (presentation?.lines.some(line => line.kind === 'hunk')) presentation.lines = presentation.lines.filter(line => line.kind !== 'header');
  return { ...file, presentation };
}));
type ChangeEntry = (typeof changes.value)[number];
const totals = computed(() => changes.value.reduce((sum, file) => ({ additions: sum.additions + (file.presentation?.additions ?? 0), deletions: sum.deletions + (file.presentation?.deletions ?? 0) }), { additions: 0, deletions: 0 }));
const statusLabels: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变化' };
const ownExpanded = ref(new Map<string, boolean>());
const expanded = computed(() => props.expansion ?? ownExpanded.value);
const fileKey = (path: string) => `${props.identity}\0${path}`;
function fileToggle(event: Event, path: string): void {
  if (event.target instanceof HTMLDetailsElement) expanded.value.set(fileKey(path), event.target.open);
}

// 文件清单的平铺 / 树形与工作区共用同一个持久化偏好（见 file-list-view.ts）。
const fileListView = useFileListView();
/** 目录折叠状态按 `identity` 分开；切换提交/对比对象时重置，避免沿用上一份清单的折叠结果。 */
const collapsedDirectories = ref<string[]>([]);
watch(() => props.identity, () => { collapsedDirectories.value = []; });
type ChangeRow =
  | { kind: 'directory'; node: FileTreeNode; depth: number }
  | { kind: 'file'; file: ChangeEntry; depth: number; fileIndex: number };
const changeRows = computed<ChangeRow[]>(() => {
  if (fileListView.view.value !== 'tree') {
    return changes.value.map((file, fileIndex) => ({ kind: 'file' as const, file, depth: 0, fileIndex }));
  }
  const fileIndexes = new Map(changes.value.map((file, fileIndex) => [file.path, fileIndex]));
  return flattenTree(buildFileTree(changes.value.map(file => file.path)), new Set(collapsedDirectories.value))
    .flatMap(({ node, depth }): ChangeRow[] => {
      if (node.kind === 'directory') return [{ kind: 'directory', node, depth }];
      const fileIndex = fileIndexes.get(node.path);
      return fileIndex === undefined ? [] : [{ kind: 'file', file: changes.value[fileIndex]!, depth, fileIndex }];
    });
});
function isDirectoryOpen(node: FileTreeNode): boolean {
  return !collapsedDirectories.value.includes(node.path);
}
function toggleDirectory(node: FileTreeNode): void {
  const next = new Set(collapsedDirectories.value);
  if (next.has(node.path)) next.delete(node.path);
  else next.add(node.path);
  collapsedDirectories.value = [...next];
}
/** ← → 折叠/展开，空格与 Enter 等价于点击（preventDefault 阻止浏览器再合成一次 click）。 */
function directoryKey(event: KeyboardEvent, node: FileTreeNode): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowRight' && !isDirectoryOpen(node)) event.preventDefault();
  else if (event.key === 'ArrowLeft' && isDirectoryOpen(node)) event.preventDefault();
  else if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
  else return;
  toggleDirectory(node);
}

defineExpose({ capture: () => [...expanded.value.entries()], restore: (entries: [string, boolean][]) => { expanded.value.clear(); for (const [key, open] of entries) expanded.value.set(key, open); } });
</script>
<template>
        <div class="workspace-commit-summary"><span>{{ filePath ? '所选文件的变化' : `${changes.length} 个变化文件` }}</span><span class="addition">+{{ totals.additions }}</span><span class="deletion">−{{ totals.deletions }}</span><span v-if="truncated">已加载部分</span><button class="file-tree-toggle" :aria-pressed="fileListView.view.value === 'tree'" :title="fileListView.view.value === 'tree' ? '切回平铺清单' : '按目录折叠显示文件'" @click="fileListView.set(fileListView.view.value === 'tree' ? 'flat' : 'tree')"><ListTree v-if="fileListView.view.value === 'tree'" :size="12" /><List v-else :size="12" /><span>{{ fileListView.view.value === 'tree' ? '树形' : '平铺' }}</span></button></div>
        <template v-for="row in changeRows" :key="row.kind === 'file' ? `${identity}:${row.file.path}` : `dir:${row.node.path}`">
          <button
            v-if="row.kind === 'directory'"
            type="button"
            class="file-tree-directory"
            :aria-expanded="isDirectoryOpen(row.node)"
            :style="{ '--tree-depth': row.depth }"
            :title="row.node.path"
            @click="toggleDirectory(row.node)"
            @keydown="directoryKey($event, row.node)"
          >
            <ChevronRight :size="12" class="file-tree-chevron" :class="{ open: isDirectoryOpen(row.node) }" aria-hidden="true" />
            <FolderOpen v-if="isDirectoryOpen(row.node)" :size="13" aria-hidden="true" /><FolderClosed v-else :size="13" aria-hidden="true" />
            <span>{{ row.node.name }}</span><small>{{ row.node.fileCount }}</small>
          </button>
          <details v-else class="workspace-commit-file" :class="{ 'file-tree-file': fileListView.view.value === 'tree' }" :style="{ '--tree-depth': row.depth }" :open="expanded.get(fileKey(row.file.path)) ?? row.fileIndex === 0" @toggle="fileToggle($event, row.file.path)">
            <summary :title="row.file.originalPath ? `${row.file.originalPath} → ${row.file.path}` : row.file.path"><ChevronDown :size="13" /><span class="workspace-change-status" :data-status="row.file.status">{{ statusLabels[row.file.status] ?? row.file.status }}</span><strong>{{ row.file.path }}</strong><span v-if="row.file.presentation" class="addition">+{{ row.file.presentation.additions }}</span><span v-if="row.file.presentation" class="deletion">−{{ row.file.presentation.deletions }}</span></summary>
            <p v-if="row.file.originalPath" class="workspace-history-note workspace-rename-note">{{ row.file.originalPath }} → {{ row.file.path }}</p>
            <div v-if="allowFileHistory && !filePath" class="workspace-file-history-action"><button class="workspace-head-link" :aria-label="`查看文件历史 ${row.file.path}`" @click="emit('browseFile', row.file.path)"><History :size="12" />查看文件历史</button></div>
            <div v-if="row.file.presentation" class="workspace-commit-file-diff"><DiffView :presentation="row.file.presentation" :label="`${diffLabel ?? `提交 ${identity.slice(0, 7)}`} 中 ${row.file.path} 的变化`" /></div>
            <p v-else class="workspace-history-note workspace-rename-note">该文件没有完整补丁预览，请在本地查看</p>
          </details>
        </template>
        <div v-if="!changes.length" class="workspace-empty"><FileDiff :size="28" /><strong>没有文件变化</strong><span>{{ emptyMessage ?? '这个提交只包含提交记录' }}</span></div>

</template>
