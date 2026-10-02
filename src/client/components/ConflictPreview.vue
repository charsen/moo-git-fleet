<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-vue-next';
import type { FileChange } from '../../shared/contracts';
import { api } from '../api';
import { useRepositoryRead } from '../use-repository-read';
import CodeContent from './CodeContent.vue';
const props = defineProps<{ repositoryId: string; file: FileChange; busy: boolean; canResolve: boolean }>();
const emit = defineEmits<{ resolve: [file: FileChange, strategy: 'ours' | 'theirs', fingerprint: string] }>();
const stage = ref(2);
const read = useRepositoryRead(() => JSON.stringify([props.repositoryId, props.file.id]), signal => api.conflictPreview(props.repositoryId, props.file.id, signal));
const side = computed(() => read.data.value?.sides.find(side => side.stage === stage.value));
watch(() => props.file.path, () => { stage.value = 2; });
</script>
<template>
  <div class="conflict-preview-content">
    <div class="inspection-toolbar"><strong :title="file.path">{{ file.path }} · 冲突版本</strong><button class="table-icon-button" aria-label="刷新冲突预览" :disabled="read.loading.value || busy" @click="read.refresh"><RefreshCw :size="14" /></button></div>
    <div v-if="read.loading.value" class="workspace-empty" role="status"><LoaderCircle :size="24" class="spinning" /><strong>读取冲突版本…</strong></div>
    <div v-else-if="read.error.value" class="workspace-empty" role="alert"><AlertTriangle :size="24" /><span>{{ read.error.value }}</span><button class="compact-button" @click="read.refresh">重新读取</button></div>
    <template v-else-if="read.data.value && side">
      <div class="inspection-tabs" role="group" aria-label="冲突版本选择"><button v-for="item in read.data.value.sides" :key="item.stage" :class="{ active: stage === item.stage }" :aria-pressed="stage === item.stage" @click="stage = item.stage">{{ item.label }}</button></div>
      <div class="inspection-version-meta"><strong>{{ side.source }}</strong><code v-if="side.commit" :title="side.commit">{{ side.commit.slice(0, 12) }}</code><code v-if="side.file" :title="side.file.objectId">文件 {{ side.file.objectId.slice(0, 12) }}</code><p>{{ read.data.value.note }}</p>
        <button v-if="stage !== 1" class="compact-button" :disabled="busy || !canResolve || !side.file || side.mode === '160000' || side.mode === '120000'" :title="!side.file ? '该侧没有文件，请手工处理删除冲突' : side.mode === '160000' || side.mode === '120000' ? '符号链接与子模块冲突请在本地处理' : undefined" @click="emit('resolve', file, stage === 2 ? 'ours' : 'theirs', read.data.value.fingerprint)">取此版本…</button>
      </div>
      <div v-if="!side.file" class="workspace-empty"><strong>该侧没有文件</strong><span>可能是删除／修改冲突，请手工确认结果。</span></div>
      <div v-else-if="side.mode === '160000'" class="workspace-empty"><strong>子模块版本</strong><code>{{ side.file.objectId }}</code></div>
      <div v-else-if="side.file.binary" class="workspace-empty"><strong>二进制或非 UTF-8 文件</strong><span>{{ side.file.size }} 字节 · 没有文本预览</span></div>
      <template v-else><p v-if="side.mode === '120000'" class="inspection-notice">符号链接保存的目标文本；不会访问目标文件。</p><p v-if="side.file.truncated" class="inspection-notice" role="status">文件过大，仅预览前 200 KB／2000 行。</p><CodeContent :key="`${file.path}:${stage}:${side.file.objectId}`" :content="side.file.content ?? ''" :path="file.path" :label="`${file.path} ${side.label}`" /></template>
    </template>
  </div>
</template>
