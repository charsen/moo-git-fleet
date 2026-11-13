<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, ArrowDown, GitBranch, LoaderCircle, X } from 'lucide-vue-next';
import { vBackdropClose } from '../backdrop-close';
import type { BatchPullBranchMode, BatchPullBranchesPlan } from '../../shared/contracts';

const props = defineProps<{
  plan: BatchPullBranchesPlan | null;
  loading: boolean;
  busy: boolean;
  error: string;
  modes: BatchPullBranchMode[];
}>();
const emit = defineEmits<{
  close: [];
  pull: [repositoryIds: string[]];
  'change-modes': [modes: BatchPullBranchMode[]];
}>();

/** 被用户取消勾选的仓库；默认全选——可拉取的仓库通常只有几个。 */
const excluded = ref<string[]>([]);
watch(
  () => props.plan,
  () => {
    excluded.value = [];
  },
);

const rows = computed(() => props.plan?.repositories ?? []);
function pullable(row: BatchPullBranchesPlan['repositories'][number]): boolean {
  return row.blocker === null && row.pending > 0;
}
const candidates = computed(() => rows.value.filter((row) => pullable(row)));
const selected = computed(() => candidates.value.filter((row) => !excluded.value.includes(row.repositoryId)));
/** 确认按钮上要能读出规模：几个仓库、实际会更新多少条分支。 */
const selectedBranches = computed(() =>
  selected.value.reduce((total, row) => total + row.branches.filter((branch) => branch.blocker === null && branch.behind > 0).length, 0),
);
/** 不看 `error`：读取失败时清单本来为空；把 error 写进条件会让「启动失败」变成只能关窗重开。 */
const canSubmit = computed(() => !props.busy && !props.loading && selected.value.length > 0);

const modeOptions: Array<{ value: BatchPullBranchMode; label: string; hint: string }> = [
  { value: 'current', label: '当前分支', hint: '每个仓库当前检出的分支，走标准 Pull' },
  { value: 'default', label: '主分支', hint: '按远端默认分支识别，main 或 master 都行' },
  { value: 'dev', label: 'dev', hint: 'dev 或 develop' },
];

function toggleRepository(repositoryId: string): void {
  if (props.busy) return;
  excluded.value = excluded.value.includes(repositoryId)
    ? excluded.value.filter((item) => item !== repositoryId)
    : [...excluded.value, repositoryId];
}

function toggleMode(mode: BatchPullBranchMode): void {
  if (props.busy || props.loading) return;
  const active = props.modes.includes(mode);
  // 至少留一档：全关掉等于「拉什么」没有定义。
  if (active && props.modes.length === 1) return;
  emit('change-modes', active ? props.modes.filter((item) => item !== mode) : [...props.modes, mode]);
}

/** `dev ↓3 · main 已最新`：一眼看出哪条要动、动多少。 */
function branchSummary(row: BatchPullBranchesPlan['repositories'][number]): string {
  return row.branches
    .filter((branch) => branch.blocker === null)
    .map((branch) => (branch.behind > 0 ? `${branch.name} ↓${branch.behind}` : `${branch.name} 已最新`))
    .join(' · ');
}

/** 被挡下的分支单独一行，带原因；没有就返回空串。 */
function blockedSummary(row: BatchPullBranchesPlan['repositories'][number]): string {
  const blocked = row.branches.filter((branch) => branch.blocker);
  const missing = row.skipped;
  return [...blocked.map((branch) => `${branch.name}（${branch.blocker}）`), ...missing.map((item) => `${item.name}（${item.reason}）`)].join('；');
}
</script>

<template>
  <div class="modal-backdrop confirmation-backdrop" v-backdrop-close="() => !busy && emit('close')">
    <section
      class="confirmation-modal batch-push-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-pull-title"
      aria-describedby="batch-pull-summary"
      data-focus-layer
      tabindex="-1"
      :aria-busy="loading || busy"
    >
      <header class="confirmation-header">
        <div class="confirmation-icon" aria-hidden="true"><ArrowDown :size="19" /></div>
        <h2 id="batch-pull-title">批量拉取多个分支</h2>
        <button class="icon-button confirmation-close" aria-label="关闭批量拉取窗口" :disabled="busy" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="confirmation-body">
        <p id="batch-pull-summary" class="confirmation-summary">
          按所选档位逐仓拉取。当前分支走标准 Pull（沿用仓库的 merge / rebase 设置）；
          其他分支只把本地分支快进到远端，<b>不切分支、不动工作区</b>，本地有远端没有的提交时会直接跳过。
        </p>
        <div class="batch-push-modes" role="group" aria-label="拉取哪些分支">
          <button
            v-for="option in modeOptions"
            :key="option.value"
            type="button"
            class="batch-push-mode"
            :data-active="modes.includes(option.value)"
            :aria-pressed="modes.includes(option.value)"
            :title="option.hint"
            :disabled="busy || loading"
            @click="toggleMode(option.value)"
          >{{ option.label }}</button>
        </div>

        <p v-if="loading" class="batch-push-state" role="status"><LoaderCircle :size="14" class="spinning" />正在逐仓读取本地分支与远端跟踪状态…</p>
        <template v-else-if="plan">
          <p v-if="candidates.length === 0" class="batch-push-state" role="status">
            范围内没有可拉取的仓库：需要配好远端，且所选档位下有分支落后于远端。
          </p>
          <ul v-if="rows.length > 0" class="batch-push-list">
            <li
              v-for="row in rows"
              :key="row.repositoryId"
              :data-blocked="!pullable(row)"
            >
              <label :title="row.blocker || undefined">
                <input
                  type="checkbox"
                  :checked="pullable(row) && !excluded.includes(row.repositoryId)"
                  :disabled="busy || !pullable(row)"
                  @change="toggleRepository(row.repositoryId)"
                />
                <GitBranch :size="14" aria-hidden="true" />
                <strong>{{ row.repositoryName }}</strong>
                <span v-if="pullable(row)" class="batch-push-targets">{{ branchSummary(row) }}</span>
                <small v-if="row.blocker">{{ row.blocker }}</small>
                <template v-else>
                  <small v-if="!pullable(row)">{{ branchSummary(row) || '没有需要拉取的分支' }}</small>
                  <small v-if="blockedSummary(row)">跳过 {{ blockedSummary(row) }}</small>
                </template>
              </label>
            </li>
          </ul>
        </template>
        <p v-if="error" class="batch-push-warning" role="alert"><AlertTriangle :size="15" /><span>{{ error }}</span></p>
      </div>

      <footer class="confirmation-footer">
        <span>非当前分支只快进 · 永不覆盖本地提交</span>
        <div>
          <button class="secondary-button" data-dialog-initial :disabled="busy" @click="emit('close')">取消</button>
          <button
            class="confirmation-confirm"
            :disabled="!canSubmit"
            @click="emit('pull', selected.map((row) => row.repositoryId))"
          >
            <LoaderCircle v-if="busy" :size="14" class="spinning" /><ArrowDown v-else :size="14" />
            {{ busy ? '正在开始…' : `拉取 ${selected.length} 个仓库 · ${selectedBranches} 条分支` }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.batch-push-modal { --operation-dialog-width: 720px; }
.batch-push-modes { display: flex; gap: 6px; margin: 12px 0 0; }
.batch-push-mode { padding: 4px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-list-muted); color: var(--color-text); font-size: .857143rem; cursor: pointer; transition: background 140ms ease, border-color 140ms ease, color 140ms ease; }
.batch-push-mode:hover:not(:disabled) { border-color: color-mix(in srgb, var(--color-brand) 42%, var(--color-border-subtle)); color: var(--color-text); }
/* 选中态必须一眼能看出来：原来写的是 `--color-accent`，而五套主题里都没有这个变量，
   整条 border/background 声明无效，选中和没选中长得一样。改成品牌绿实底 + 深色字，
   和底部确认按钮同一套语义；未选中的仍是描边胶囊，对比够强。 */
.batch-push-mode[data-active='true'] { border-color: var(--color-brand); background: var(--color-brand); color: var(--color-brand-ink); font-weight: 600; }
.batch-push-mode[data-active='true']:hover:not(:disabled) { color: var(--color-brand-ink); }
.batch-push-mode:disabled { cursor: default; opacity: .6; }
.batch-push-list { list-style: none; margin: 12px 0 0; padding: 0; max-height: 44vh; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.batch-push-list li { margin: 0; }
.batch-push-list label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); background: var(--color-list-muted); cursor: pointer; font-size: .928571rem; }
.batch-push-list li[data-blocked='true'] label { cursor: default; opacity: .62; }
.batch-push-list input { accent-color: var(--color-brand); flex: none; }
/* 仓库名允许收缩但禁止逐字竖排：窄视口下否则会出现「de / v」这种碎字。 */
.batch-push-list strong { flex: 0 1 auto; min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.batch-push-targets { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-muted); font-size: .857143rem; font-variant-numeric: tabular-nums; }
.batch-push-list small { flex-basis: 100%; color: var(--color-text-muted); font-size: .857143rem; }
.batch-push-state { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--color-text-muted); font-size: .928571rem; }
.batch-push-warning { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; color: var(--color-yellow); font-size: .928571rem; }
</style>
