<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertTriangle, ArrowRight, GitBranch, GitMerge, LoaderCircle, X } from 'lucide-vue-next';
import type { MergePreview, MergePreviewRequest } from '../../shared/contracts';
const props = defineProps<{ input: MergePreviewRequest; preview: MergePreview | null; loading: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; merge: [noFastForward: boolean] }>();
const noFastForward = ref(false);
const blocked = computed(() => props.error || props.preview?.blocker || '');
const description = computed(() => props.preview?.kind === 'up-to-date' ? '当前分支已包含全部来源提交，无需合并'
  : props.preview?.kind === 'fast-forward' && !noFastForward.value ? '可以快进，直接移动当前分支到来源提交'
  : '将生成一个合并提交，保留两个分支的历史');
</script>

<template>
  <div class="modal-backdrop confirmation-backdrop" @click.self="!busy && emit('close')">
    <section class="confirmation-modal branch-merge-modal" role="dialog" aria-modal="true" aria-labelledby="merge-title" aria-describedby="merge-summary" data-focus-layer tabindex="-1" :aria-busy="loading || busy">
      <header class="branch-merge-header"><GitMerge :size="19" aria-hidden="true" /><h2 id="merge-title">合并分支</h2><button class="icon-button" aria-label="关闭合并窗口" :disabled="busy" @click="emit('close')"><X :size="16" /></button></header>
      <div class="branch-merge-body">
        <p id="merge-summary" class="branch-merge-summary">将来源的提交合入当前分支</p>
        <div class="branch-merge-direction">
          <div><small>{{ input.source.kind === 'remote' ? '远端来源' : '来源分支' }}</small><strong><GitBranch :size="14" aria-hidden="true" /><span :title="input.source.name">{{ input.source.name }}</span></strong><code>{{ input.expectedSourceHead.slice(0, 7) }}</code></div>
          <ArrowRight :size="18" aria-label="合入" />
          <div class="branch-merge-target"><small>当前分支 <span class="workspace-branch-head">HEAD</span></small><strong><GitBranch :size="14" aria-hidden="true" /><span :title="input.expectedBranch">{{ input.expectedBranch }}</span></strong><code>{{ input.expectedHead.slice(0, 7) }}</code></div>
        </div>
        <p v-if="loading" class="branch-merge-state" role="status"><LoaderCircle :size="14" class="spinning" />正在检查提交关系…</p>
        <template v-else-if="preview"><p class="branch-merge-count"><b>{{ preview.incomingCommits }}</b> 条待合入提交</p><p class="branch-merge-description">{{ description }}</p></template>
        <label class="branch-merge-option"><input v-model="noFastForward" type="checkbox" :disabled="busy || loading || !preview || Boolean(blocked) || preview.kind === 'up-to-date'" /><span>始终生成合并提交<small>即使可以快进，也记录这次合并</small></span></label>
        <p v-if="blocked" class="branch-merge-warning" role="alert"><AlertTriangle :size="15" /><span>{{ blocked }}</span></p>
      </div>
      <footer class="branch-merge-footer"><span>合并到本地 · 不自动 Push</span><div><button class="secondary-button" data-dialog-initial :disabled="busy" @click="emit('close')">{{ preview?.kind === 'up-to-date' ? '关闭' : '取消' }}</button><button class="confirmation-confirm" :disabled="busy || loading || !preview || Boolean(blocked) || preview.kind === 'up-to-date'" @click="emit('merge', noFastForward)"><LoaderCircle v-if="busy" :size="14" class="spinning" /><GitMerge v-else :size="14" />{{ busy ? '正在合并…' : '合并分支' }}</button></div></footer>
    </section>
  </div>
</template>
