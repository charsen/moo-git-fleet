<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDown, FileDiff, History } from 'lucide-vue-next';
import type { CommitFileChange } from '../../shared/contracts';
import { presentGitDiff } from '../diff-presentation';
import DiffView from './DiffView.vue';
const props = defineProps<{ files: CommitFileChange[]; identity: string; truncated: boolean; filePath?: string; allowFileHistory?: boolean; expansion?: Map<string, boolean> }>();
const emit = defineEmits<{ browseFile: [path: string] }>();
const changes = computed(() => (props.files).map(file => {
  const presentation = file.patch === null ? null : presentGitDiff(file.patch, file.path);
  if (presentation?.lines.some(line => line.kind === 'hunk')) presentation.lines = presentation.lines.filter(line => line.kind !== 'header');
  return { ...file, presentation };
}));
const totals = computed(() => changes.value.reduce((sum, file) => ({ additions: sum.additions + (file.presentation?.additions ?? 0), deletions: sum.deletions + (file.presentation?.deletions ?? 0) }), { additions: 0, deletions: 0 }));
const statusLabels: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变化' };
const ownExpanded = ref(new Map<string, boolean>());
const expanded = computed(() => props.expansion ?? ownExpanded.value);
const fileKey = (path: string) => `${props.identity}\0${path}`;
function fileToggle(event: Event, path: string): void {
  if (event.target instanceof HTMLDetailsElement) expanded.value.set(fileKey(path), event.target.open);
}
defineExpose({ capture: () => [...expanded.value.entries()], restore: (entries: [string, boolean][]) => { expanded.value.clear(); for (const [key, open] of entries) expanded.value.set(key, open); } });
</script>
<template>
        <div class="workspace-commit-summary"><span>{{ filePath ? '所选文件的变化' : `${changes.length} 个变化文件` }}</span><span class="addition">+{{ totals.additions }}</span><span class="deletion">−{{ totals.deletions }}</span><span v-if="truncated">已加载部分</span></div>
        <details v-for="(file, index) in changes" :key="`${identity}:${file.path}`" class="workspace-commit-file" :open="expanded.get(fileKey(file.path)) ?? index === 0" @toggle="fileToggle($event, file.path)">
          <summary :title="file.originalPath ? `${file.originalPath} → ${file.path}` : file.path"><ChevronDown :size="13" /><span class="workspace-change-status" :data-status="file.status">{{ statusLabels[file.status] ?? file.status }}</span><strong>{{ file.path }}</strong><span v-if="file.presentation" class="addition">+{{ file.presentation.additions }}</span><span v-if="file.presentation" class="deletion">−{{ file.presentation.deletions }}</span></summary>
          <p v-if="file.originalPath" class="workspace-history-note workspace-rename-note">{{ file.originalPath }} → {{ file.path }}</p>
          <div v-if="allowFileHistory && !filePath" class="workspace-file-history-action"><button class="workspace-head-link" :aria-label="`查看文件历史 ${file.path}`" @click="emit('browseFile', file.path)"><History :size="12" />查看文件历史</button></div>
          <div v-if="file.presentation" class="workspace-commit-file-diff"><DiffView :presentation="file.presentation" :label="`提交 ${identity.slice(0, 7)} 中 ${file.path} 的变化`" /></div>
          <p v-else class="workspace-history-note workspace-rename-note">该文件没有完整补丁预览，请在本地查看</p>
        </details>
        <div v-if="!changes.length" class="workspace-empty"><FileDiff :size="28" /><strong>没有文件变化</strong><span>这个提交只包含提交记录</span></div>

</template>
