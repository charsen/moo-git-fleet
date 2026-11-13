<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, GitMerge, LoaderCircle, X } from 'lucide-vue-next';
import { vBackdropClose } from '../backdrop-close';
import type { BatchMergeBranchesPlan, BatchMergeRepositoryPlan } from '../../shared/contracts';

const props = defineProps<{
  plan: BatchMergeBranchesPlan | null;
  loading: boolean;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  merge: [repositoryIds: string[], deleteMergedBranches: boolean];
}>();

/** 被用户取消勾选的仓库；默认全选——可合并的仓库通常只有几个，逐个点反而费事。 */
const excluded = ref<string[]>([]);
/** 可选：合并成功后清理「已完全合进两条线」的非双线分支。默认不勾，删除属于不可逆动作。 */
const deleteMerged = ref(false);
watch(
  () => props.plan,
  () => {
    excluded.value = [];
  },
);

const rows = computed(() => props.plan?.repositories ?? []);
/**
 * 可选中的仓库：有待合并分支，或（勾了清理时）有已合并待清理的分支。
 * 已同步、没有可合并内容的仓库，只有勾上「合并后删除已合并的任务分支」后才变得可选。
 */
function mergeable(row: BatchMergeRepositoryPlan): boolean {
  return row.blocker === null && (row.sources.length > 0 || (deleteMerged.value && row.mergedBranches.length > 0));
}
const candidates = computed(() => rows.value.filter((row) => mergeable(row)));
const selected = computed(() => candidates.value.filter((row) => !excluded.value.includes(row.repositoryId)));
/** 确认按钮上要能读出规模：几个仓库、实际会发生多少条合并。 */
const selectedMerges = computed(() =>
  selected.value.reduce((total, row) => total + row.sources.reduce((sum, source) => sum + source.merges.filter((merge) => merge.kind !== 'up-to-date').length, 0), 0),
);
/** 勾选清理时预计删除的分支数：待合并的源分支合并成功后也变为可清理，加上已合并的。 */
const selectedCleanup = computed(() =>
  selected.value.reduce((total, row) => total + row.sources.length + row.mergedBranches.length, 0),
);
/** 已同步、没有待合并内容但存在已合并分支的仓库数（用来提示「勾选清理」）。 */
const cleanupOnlyCount = computed(() =>
  rows.value.filter((row) => row.blocker === null && row.sources.length === 0 && row.mergedBranches.length > 0).length,
);
/**
 * 不看 `error`：读取失败时 `plan` 本来就是空、按钮自然点不动；把 `error` 也写进条件，
 * 会让「启动批次失败」变成死路——原因要留在窗口里，按钮必须还能按第二次。
 */
const canSubmit = computed(() => !props.busy && !props.loading && selected.value.length > 0);

/** 确认按钮文案：合并/清理规模分开报，避免出现「0 条合并」但实际在清理的歧义。 */
const confirmText = computed(() => {
  if (props.busy) return '正在开始…';
  const parts = [`合并 ${selected.value.length} 个仓库`];
  if (selectedMerges.value > 0) parts.push(`${selectedMerges.value} 条合并`);
  if (deleteMerged.value && selectedCleanup.value > 0) parts.push(`清理 ${selectedCleanup.value} 条已合并分支`);
  return parts.join(' · ');
});

function toggleRepository(repositoryId: string): void {
  if (props.busy) return;
  excluded.value = excluded.value.includes(repositoryId)
    ? excluded.value.filter((item) => item !== repositoryId)
    : [...excluded.value, repositoryId];
}

/** `feature-a → dev 快进（3 个提交） · main 合并提交（5 个提交）`。 */
function describeSource(source: BatchMergeRepositoryPlan['sources'][number]): string {
  const lines = source.merges.map((merge) => {
    if (merge.kind === 'up-to-date') return `${merge.target} 已包含`;
    const kind = merge.kind === 'fast-forward' ? '快进' : '合并提交';
    return `${merge.target} ${kind}${merge.incomingCommits > 0 ? `（${merge.incomingCommits} 个提交）` : ''}`;
  });
  return `${source.name} → ${lines.join(' · ')}`;
}

function sourceTitle(row: BatchMergeRepositoryPlan): string {
  return row.sources.map((source) => describeSource(source)).join('\n');
}
</script>

<template>
  <div class="modal-backdrop confirmation-backdrop" v-backdrop-close="() => !busy && emit('close')">
    <section
      class="confirmation-modal batch-push-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-merge-title"
      aria-describedby="batch-merge-summary"
      data-focus-layer
      tabindex="-1"
      :aria-busy="loading || busy"
    >
      <header class="confirmation-header">
        <div class="confirmation-icon" aria-hidden="true"><GitMerge :size="19" /></div>
        <h2 id="batch-merge-title">双线合并</h2>
        <button class="icon-button confirmation-close" aria-label="关闭双线合并窗口" :disabled="busy" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="confirmation-body">
        <p id="batch-merge-summary" class="confirmation-summary">
          把非双线分支依次合进 <code>dev</code>（或 <code>develop</code>）与主分支（<code>main</code> / <code>master</code>）。
          只做本地合并、不推送；工作区有改动会跳过，冲突会停在目标分支。
        </p>

        <p v-if="loading" class="batch-push-state" role="status"><LoaderCircle :size="14" class="spinning" />正在逐仓核对分支与提交关系…</p>
        <template v-else-if="plan">
          <p v-if="candidates.length === 0" class="batch-push-state" role="status">
            范围内没有可合并的仓库：需工作区干净、有本地 dev 与主分支，且有尚未合进双线的任务分支<template v-if="cleanupOnlyCount > 0">；另有 {{ cleanupOnlyCount }} 个仓库已同步，可勾选下方「合并后删除已合并的任务分支」来清理</template>。
          </p>
          <ul v-if="rows.length > 0" class="batch-push-list">
            <li
              v-for="row in rows"
              :key="row.repositoryId"
              :data-blocked="!mergeable(row)"
            >
              <label :title="row.blocker || sourceTitle(row)">
                <input
                  type="checkbox"
                  :checked="mergeable(row) && !excluded.includes(row.repositoryId)"
                  :disabled="busy || !mergeable(row)"
                  @change="toggleRepository(row.repositoryId)"
                />
                <GitMerge :size="14" aria-hidden="true" />
                <strong>{{ row.repositoryName }}</strong>
                <span v-if="mergeable(row) && row.sources.length > 0" class="batch-push-targets">
                  {{ row.targets.join(' + ') }} · {{ row.sources.length }} 个源分支 · {{ row.pendingMerges }} 条合并
                </span>
                <span v-else-if="mergeable(row)" class="batch-push-targets">
                  {{ row.targets.join(' + ') }} · 已同步，可清理 {{ row.mergedBranches.length }} 条已合并分支
                </span>
                <small v-if="row.blocker">{{ row.blocker }}</small>
                <template v-else-if="mergeable(row) && row.sources.length > 0">
                  <small v-for="source in row.sources" :key="source.name" class="batch-merge-source">
                    {{ describeSource(source) }}
                  </small>
                </template>
                <small v-else-if="mergeable(row)">已合并、待清理：{{ row.mergedBranches.join('、') }}</small>
                <small v-else-if="row.mergedBranches.length > 0">没有需要合并的分支；勾选「合并后删除已合并的任务分支」可清理 {{ row.mergedBranches.length }} 条</small>
                <small v-else>
                  没有需要合并的分支{{ row.excluded.length > 0 ? `（双线：${row.excluded.join('、')}）` : '' }}
                </small>
              </label>
            </li>
          </ul>
        </template>
        <label class="batch-merge-cleanup">
          <input type="checkbox" v-model="deleteMerged" :disabled="busy || loading" />
          <span>
            合并后删除已合并的任务分支
            <small>只删成果已完全合进两条线的分支，未合过去的不动</small>
          </span>
        </label>
        <p v-if="error" class="batch-push-warning" role="alert"><AlertTriangle :size="15" /><span>{{ error }}</span></p>
      </div>

      <footer class="confirmation-footer">
        <span>只合并本地分支 · 冲突即停 · 不推送</span>
        <div>
          <button class="secondary-button" data-dialog-initial :disabled="busy" @click="emit('close')">取消</button>
          <button
            class="confirmation-confirm"
            :disabled="!canSubmit"
            @click="emit('merge', selected.map((row) => row.repositoryId), deleteMerged)"
          >
            <LoaderCircle v-if="busy" :size="14" class="spinning" /><GitMerge v-else :size="14" />
            {{ confirmText }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.batch-push-modal { --operation-dialog-width: 760px; }
.batch-push-list { list-style: none; margin: 12px 0 0; padding: 0; max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.batch-push-list li { margin: 0; }
.batch-push-list label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); background: var(--color-list-muted); cursor: pointer; font-size: .928571rem; }
.batch-push-list li[data-blocked='true'] label { cursor: default; opacity: .62; }
.batch-push-list input { accent-color: var(--color-brand); flex: none; }
/* 仓库名允许收缩但禁止逐字竖排：窄视口下否则会出现「de / v」这种碎字。 */
.batch-push-list strong { flex: 0 1 auto; min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.batch-push-targets { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-muted); font-size: .857143rem; font-variant-numeric: tabular-nums; }
.batch-push-list small { flex-basis: 100%; color: var(--color-text-muted); font-size: .857143rem; }
/* 每条源分支一行，等宽数字让「3 个提交」与「12 个提交」对齐，扫读不会跳。 */
.batch-merge-source { padding-left: 22px; font-variant-numeric: tabular-nums; }
.batch-push-state { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--color-text-muted); font-size: .928571rem; }
.batch-merge-cleanup { display: flex; align-items: flex-start; gap: 8px; margin: 14px 0 0; padding: 9px 10px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); background: var(--color-list-muted); cursor: pointer; font-size: .928571rem; }
.batch-merge-cleanup input { accent-color: var(--color-brand); flex: none; margin-top: 2px; }
.batch-merge-cleanup small { display: block; margin-top: 2px; color: var(--color-text-muted); font-size: .857143rem; }
.batch-merge-cleanup:has(input:disabled) { opacity: .62; cursor: default; }
.batch-push-warning { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; color: var(--color-yellow); font-size: .928571rem; }
</style>
