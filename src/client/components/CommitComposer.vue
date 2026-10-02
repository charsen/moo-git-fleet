<script setup lang="ts">
import { computed, ref } from 'vue';
import { Bot, GitCommitHorizontal, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import type { CommitPreview, CommitSuggestion } from '../../shared/contracts';

const props = defineProps<{ message: string; preview: CommitPreview | null; loading: boolean; error: string; ready: boolean; busy: boolean; suggesting: boolean; suggestion: CommitSuggestion | null; needsReview: boolean; blocker: string | null; stagedCount: number }>();
const emit = defineEmits<{ 'update:message': [value: string]; submit: []; generate: []; refresh: [] }>();
const titleInput = ref<HTMLInputElement | null>(null);
const expanded = ref(false);
const description = computed(() => props.message.slice(props.message.indexOf('\n') < 0 ? props.message.length : props.message.indexOf('\n') + 1).replace(/^\n/, ''));
const title = computed(() => props.message.split('\n')[0] ?? '');
const policy = computed(() => props.suggestion?.aiPolicy ?? props.preview?.aiPolicy);
const canSubmit = computed(() => props.ready && !props.busy && !props.suggesting && !props.blocker && Boolean(title.value.trim()));
function editTitle(event: Event): void { const value = (event.target as HTMLInputElement).value; emit('update:message', description.value ? `${value}\n\n${description.value}` : value); }
function editDescription(event: Event): void { const value = (event.target as HTMLTextAreaElement).value; emit('update:message', value ? `${title.value}\n\n${value}` : title.value); }
function submitShortcut(event: KeyboardEvent): void {
  if (event.isComposing || event.repeat || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
  event.preventDefault(); event.stopPropagation();
  if (canSubmit.value) emit('submit');
}
function leaveComposer(event: FocusEvent): void {
  const section = event.currentTarget as HTMLElement;
  if (!props.message.trim() && !props.suggesting && !(event.relatedTarget instanceof Node && section.contains(event.relatedTarget))) expanded.value = false;
}
defineExpose({ focus: () => titleInput.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="workspace-composer" aria-label="编写提交信息" :aria-busy="busy || loading" @keydown="submitShortcut" @focusout="leaveComposer">
    <header class="workspace-composer-heading">
      <strong>提交 <span>{{ preview?.files.length ?? stagedCount }} 个文件</span></strong>
      <button type="button" class="workspace-composer-generate" :disabled="!ready || busy || suggesting || Boolean(blocker)" :title="policy?.detail ?? '根据本次提交内容生成文案'" @click="emit('generate')">
        <LoaderCircle v-if="suggesting" :size="13" class="spinning" /><Bot v-else :size="13" />{{ suggesting ? '生成中' : '生成文案' }}
      </button>
    </header>
    <input ref="titleInput" :value="title" aria-label="提交标题" placeholder="提交标题" maxlength="10000" :disabled="busy" @focus="expanded = true" @input="editTitle" />
    <textarea v-if="expanded || message.length" :value="description" aria-label="提交说明" placeholder="说明（可选）" rows="2" :disabled="busy" @input="editDescription" />
    <p v-if="error" class="workspace-composer-error" role="alert"><span :title="error">{{ error }}</span><button type="button" :disabled="busy || loading" aria-label="刷新提交预览" @click="emit('refresh')"><RefreshCw :size="12" />重试</button></p>
    <p v-else-if="needsReview" class="workspace-composer-warning" role="status">提交内容已变化，请检查文案或重新生成。</p>
    <p v-else-if="blocker" class="workspace-composer-hint">{{ blocker }}</p>
    <p v-else-if="loading" class="workspace-composer-hint" role="status"><LoaderCircle :size="12" class="spinning" />正在核对提交内容…</p>
    <p v-else-if="stagedCount" class="workspace-composer-hint" :title="policy?.detail"><ShieldCheck :size="12" />{{ policy?.label ?? '文案草稿保留在当前窗口' }}</p>
    <button type="button" class="primary-button workspace-composer-submit" :disabled="!canSubmit" @click="emit('submit')">
      <LoaderCircle v-if="busy" :size="14" class="spinning" /><GitCommitHorizontal v-else :size="14" />{{ busy ? '正在提交…' : '提交' }}<kbd v-if="!busy">⌘ / Ctrl ↵</kbd>
    </button>
  </section>
</template>
