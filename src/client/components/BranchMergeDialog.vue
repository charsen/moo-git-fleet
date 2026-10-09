<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertTriangle, ArrowRight, GitBranch, GitMerge, LoaderCircle, X } from 'lucide-vue-next';
import type { MergePreview, MergePreviewRequest } from '../../shared/contracts';
const props = defineProps<{ input: MergePreviewRequest; preview: MergePreview | null; loading: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; merge: [options: { noFastForward: boolean; stashFirst: boolean; stashIncludeUntracked: boolean }] }>();
const noFastForward = ref(false);
const blocked = computed(() => props.error || props.preview?.blocker || '');
const conflicts = computed(() => props.preview?.conflicting ?? []);
/** 有重叠改动又没有其它阻塞时，才需要用 Stash 让路。 */
const needsStash = computed(() => conflicts.value.length > 0 && !blocked.value);
const stashFirst = ref(true);
const stashIncludeUntracked = ref(true);
const listedConflicts = computed(() => conflicts.value.slice(0, 5));
/** 重叠文件里含未跟踪文件时必须一并存入，不能取消勾选。 */
const mustIncludeUntracked = computed(() => Boolean(props.preview?.conflictingUntracked));
const description = computed(() => props.preview?.kind === 'up-to-date' ? '当前分支已包含全部来源提交，无需合并'
  : props.preview?.kind === 'fast-forward' && !noFastForward.value ? '可以快进，直接移动当前分支到来源提交'
  : '将生成一个合并提交，保留两个分支的历史');
function submit(): void {
  emit('merge', {
    noFastForward: noFastForward.value,
    stashFirst: needsStash.value && stashFirst.value,
    stashIncludeUntracked: mustIncludeUntracked.value ? true : stashIncludeUntracked.value,
  });
}
</script>

<template>
  <div class="modal-backdrop confirmation-backdrop" @click.self="!busy && emit('close')">
    <section class="confirmation-modal branch-merge-modal" role="dialog" aria-modal="true" aria-labelledby="merge-title" aria-describedby="merge-summary" data-focus-layer tabindex="-1" :aria-busy="loading || busy">
      <header class="branch-merge-header"><div class="confirmation-icon" aria-hidden="true"><GitMerge :size="19" /></div><h2 id="merge-title">合并分支</h2><button class="icon-button confirmation-close" aria-label="关闭合并窗口" :disabled="busy" @click="emit('close')"><X :size="16" /></button></header>
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
        <template v-if="needsStash">
          <p class="branch-merge-warning" role="alert"><AlertTriangle :size="15" /><span>这些本地改动会被本次合并覆盖：{{ listedConflicts.join('、') }}<template v-if="conflicts.length > listedConflicts.length"> 等 {{ conflicts.length }} 个文件</template></span></p>
          <label class="branch-merge-option"><input v-model="stashFirst" type="checkbox" :disabled="busy || loading" /><span>先把这些改动存入 Stash 再合并<small>合并后改动仍留在 Stash 里，需要时再恢复</small></span></label>
          <label v-if="mustIncludeUntracked" class="branch-merge-option branch-merge-suboption"><input v-model="stashIncludeUntracked" type="checkbox" disabled /><span>包含未跟踪文件<small>重叠的文件里有未跟踪文件，必须一并存入 Stash</small></span></label>
          <p v-if="!stashFirst" class="branch-merge-note" role="status">取消后无法合并，请先提交或把这些文件自行存入 Stash。</p>
        </template>
        <p v-else-if="preview && preview.dirty && !blocked && preview.kind !== 'up-to-date'" class="branch-merge-note" role="status">工作区有改动，不影响本次合并，改动会原样保留。</p>
        <p v-if="blocked" class="branch-merge-warning" role="alert"><AlertTriangle :size="15" /><span>{{ blocked }}</span></p>
      </div>
      <footer class="branch-merge-footer"><span>合并到本地 · 不自动 Push</span><div><button class="secondary-button" data-dialog-initial :disabled="busy" @click="emit('close')">{{ preview?.kind === 'up-to-date' ? '关闭' : '取消' }}</button><button class="confirmation-confirm" :disabled="busy || loading || !preview || Boolean(blocked) || preview.kind === 'up-to-date' || (needsStash && !stashFirst)" @click="submit"><LoaderCircle v-if="busy" :size="14" class="spinning" /><GitMerge v-else :size="14" />{{ busy ? '正在合并…' : '合并分支' }}</button></div></footer>
    </section>
  </div>
</template>
