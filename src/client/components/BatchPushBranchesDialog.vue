<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, ArrowUp, GitBranch, LoaderCircle, X } from 'lucide-vue-next';
import { vBackdropClose } from '../backdrop-close';
import type { BatchPushBranchMode, BatchPushBranchesPlan } from '../../shared/contracts';

const props = defineProps<{
  plan: BatchPushBranchesPlan | null;
  loading: boolean;
  busy: boolean;
  error: string;
  modes: BatchPushBranchMode[];
}>();
const emit = defineEmits<{
  close: [];
  push: [repositoryIds: string[]];
  'change-modes': [modes: BatchPushBranchMode[]];
}>();

/** 被用户取消勾选的仓库；默认全选，避免几十个仓库逐个点。 */
const excluded = ref<string[]>([]);
watch(
  () => props.plan,
  () => {
    excluded.value = [];
  },
);

const rows = computed(() => props.plan?.repositories ?? []);
const pushable = computed(() => rows.value.filter((row) => row.targets.length > 0));
const selected = computed(() => pushable.value.filter((row) => !excluded.value.includes(row.repositoryId)));
/** 确认按钮上要能读出规模：和拉取/合并一致，同时给出仓库数与实际会推的分支数。 */
const selectedBranches = computed(() => selected.value.reduce((total, row) => total + row.targets.length, 0));
/**
 * 不看 `error`：读清单失败时 `plan` 本来就是空的，`selected` 自然为空，按钮已经点不动；
 * 而把 `error` 也写进条件，会让「启动批次失败」这种还能重试的情况变成死路——
 * 错误留在窗口里说明原因，同时按钮必须还能按第二次。
 */
const canSubmit = computed(() => !props.busy && !props.loading && selected.value.length > 0);

const modeOptions: Array<{ value: BatchPushBranchMode; label: string; hint: string }> = [
  { value: 'current', label: '当前分支', hint: '每个仓库当前检出的分支' },
  { value: 'default', label: '主分支', hint: '按远端默认分支识别，main 或 master 都行' },
  { value: 'dev', label: 'dev', hint: 'dev 或 develop' },
];

function toggleRepository(repositoryId: string): void {
  if (props.busy) return;
  excluded.value = excluded.value.includes(repositoryId)
    ? excluded.value.filter((item) => item !== repositoryId)
    : [...excluded.value, repositoryId];
}

function toggleMode(mode: BatchPushBranchMode): void {
  if (props.busy || props.loading) return;
  const active = props.modes.includes(mode);
  // 至少留一档：全关掉等于「推什么」没有定义，不如直接不让关最后一个。
  if (active && props.modes.length === 1) return;
  emit('change-modes', active ? props.modes.filter((item) => item !== mode) : [...props.modes, mode]);
}

/** 一行里展示「推哪几个分支」，带各自的领先提交数。 */
function targetSummary(row: BatchPushBranchesPlan['repositories'][number]): string {
  return row.targets
    .map((branch) => (branch.ahead && branch.ahead > 0 ? `${branch.name} ↑${branch.ahead}` : branch.name))
    .join(' · ');
}

/** `dev（仓库没有 dev 或 develop 分支）`：用括号而不是再套一层冒号。 */
function skipSummary(row: BatchPushBranchesPlan['repositories'][number]): string {
  return row.skipped.map((item) => `${item.name}（${item.reason}）`).join('；');
}
</script>

<template>
  <div class="modal-backdrop confirmation-backdrop" v-backdrop-close="() => !busy && emit('close')">
    <section
      class="confirmation-modal batch-push-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-push-title"
      aria-describedby="batch-push-summary"
      data-focus-layer
      tabindex="-1"
      :aria-busy="loading || busy"
    >
      <header class="confirmation-header">
        <div class="confirmation-icon" aria-hidden="true"><ArrowUp :size="19" /></div>
        <h2 id="batch-push-title">批量推送多个分支</h2>
        <button class="icon-button confirmation-close" aria-label="关闭批量推送窗口" :disabled="busy" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="confirmation-body">
        <p id="batch-push-summary" class="confirmation-summary">
          对范围内的仓库按所选档位各推一次。主分支名不写死：先读 <code>origin/HEAD</code>，读不到才按 main → master 兜底。
        </p>
        <div class="batch-push-modes" role="group" aria-label="推送哪些分支">
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

        <p v-if="loading" class="batch-push-state" role="status"><LoaderCircle :size="14" class="spinning" />正在逐仓读取分支…</p>
        <template v-else-if="plan">
          <p v-if="pushable.length === 0" class="batch-push-state" role="status">
            范围内没有可推送的仓库：每个仓库都需要有远端，且所选档位下有分支领先远端。
          </p>
          <ul v-if="rows.length > 0" class="batch-push-list">
            <li
              v-for="row in rows"
              :key="row.repositoryId"
              :data-blocked="row.targets.length === 0"
            >
              <label :title="row.blocker || undefined">
                <input
                  type="checkbox"
                  :checked="row.targets.length > 0 && !excluded.includes(row.repositoryId)"
                  :disabled="busy || row.targets.length === 0"
                  @change="toggleRepository(row.repositoryId)"
                />
                <GitBranch :size="14" aria-hidden="true" />
                <strong>{{ row.repositoryName }}</strong>
                <span v-if="row.targets.length > 0" class="batch-push-targets">{{ targetSummary(row) }}</span>
                <small v-if="row.blocker">{{ row.blocker }}</small>
                <small v-else-if="row.targets.length === 0">{{ skipSummary(row) }}</small>
                <small v-else-if="row.skipped.length > 0">另跳过 {{ skipSummary(row) }}</small>
              </label>
            </li>
          </ul>
        </template>
        <p v-if="error" class="batch-push-warning" role="alert"><AlertTriangle :size="15" /><span>{{ error }}</span></p>
      </div>

      <footer class="confirmation-footer">
        <span>永不 force · 一个分支被拒不影响其他分支</span>
        <div>
          <button class="secondary-button" data-dialog-initial :disabled="busy" @click="emit('close')">取消</button>
          <button
            class="confirmation-confirm"
            :disabled="!canSubmit"
            @click="emit('push', selected.map((row) => row.repositoryId))"
          >
            <LoaderCircle v-if="busy" :size="14" class="spinning" /><ArrowUp v-else :size="14" />
            {{ busy ? '正在开始…' : `推送 ${selected.length} 个仓库 · ${selectedBranches} 条分支` }}
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
