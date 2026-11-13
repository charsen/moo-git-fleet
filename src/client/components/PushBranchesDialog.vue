<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertTriangle, ArrowUp, Check, CircleSlash, GitBranch, LoaderCircle, X } from 'lucide-vue-next';
import { vBackdropClose } from '../backdrop-close';
import { maxPushBranchSelection } from '../../shared/contracts';
import type { PushBranchesPlan, PushBranchesResult } from '../../shared/contracts';

const props = defineProps<{
  plan: PushBranchesPlan | null;
  loading: boolean;
  busy: boolean;
  error: string;
  /** 上次为这个仓库选过、且这次仍可推的分支；为空则退回首屏的 suggested。 */
  initial: string[];
  /** 推送结果；非空时本窗口切到结果视图。 */
  result: PushBranchesResult | null;
}>();
const emit = defineEmits<{ close: []; push: [names: string[]] }>();

const selected = ref<string[]>([]);
watch(
  () => props.plan,
  (plan) => {
    if (!plan) return;
    const pushable = new Set(plan.branches.filter((branch) => !branch.blocker).map((branch) => branch.name));
    const remembered = props.initial.filter((name) => pushable.has(name));
    selected.value = (remembered.length > 0 ? remembered : plan.suggested).slice(0, maxPushBranchSelection);
  },
  { immediate: true },
);

const blocked = computed(() => props.plan?.blocker ?? '');
const pushableCount = computed(() => (props.plan?.branches ?? []).filter((branch) => !branch.blocker).length);
/**
 * 上限由服务端 schema 定（`maxPushBranchSelection`），这里提前挡住。
 *
 * 不在客户端兜底的话，勾满第 11 条才会在提交时拿到一句英文的 zod 报错，用户既看不懂
 * 也不知道上限是多少。达到上限就把没勾的项禁掉，并在列表下面写明原因。
 */
const atLimit = computed(() => selected.value.length >= maxPushBranchSelection);
const canSubmit = computed(
  () => !props.busy && !props.loading && !blocked.value && selected.value.length > 0,
);
/** 结果视图：把「已推送」排前面，失败的往后放，方便一眼看到该处理什么。 */
const resultRows = computed(() => {
  const rows = props.result?.branches ?? [];
  const order = { pushed: 0, 'up-to-date': 1, skipped: 2, rejected: 3, failed: 4 } as const;
  return [...rows].sort((a, b) => order[a.state] - order[b.state]);
});
/** 全都推成功时不必讲「被拒的分支没有被 force 覆盖」，那是给异常情况看的。 */
const hasProblems = computed(() => resultRows.value.some((row) => row.state === 'rejected' || row.state === 'failed'));

function toggle(name: string): void {
  if (props.busy) return;
  if (selected.value.includes(name)) {
    selected.value = selected.value.filter((item) => item !== name);
    return;
  }
  if (selected.value.length >= maxPushBranchSelection) return;
  selected.value = [...selected.value, name];
}
function submit(): void {
  if (!canSubmit.value) return;
  emit('push', [...selected.value]);
}
function stateLabel(state: string): string {
  if (state === 'pushed') return '已推送';
  if (state === 'up-to-date') return '已最新';
  if (state === 'skipped') return '已跳过';
  if (state === 'rejected') return '被拒绝';
  return '失败';
}
</script>

<template>
  <div class="modal-backdrop confirmation-backdrop" v-backdrop-close="() => !busy && emit('close')">
    <section
      class="confirmation-modal push-branches-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="push-branches-title"
      aria-describedby="push-branches-summary"
      data-focus-layer
      tabindex="-1"
      :aria-busy="loading || busy"
    >
      <header class="confirmation-header">
        <div class="confirmation-icon" aria-hidden="true"><ArrowUp :size="19" /></div>
        <h2 id="push-branches-title">{{ result ? '推送结果' : '推送多个分支' }}</h2>
        <button class="icon-button confirmation-close" aria-label="关闭推送窗口" :disabled="busy" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="confirmation-body">
        <template v-if="result">
          <p id="push-branches-summary" class="confirmation-summary">{{ result.summary }}</p>
          <ul class="push-branch-results">
            <li v-for="row in resultRows" :key="row.name" :data-state="row.state">
              <Check v-if="row.state === 'pushed'" :size="15" aria-hidden="true" />
              <CircleSlash v-else-if="row.state === 'up-to-date' || row.state === 'skipped'" :size="15" aria-hidden="true" />
              <AlertTriangle v-else :size="15" aria-hidden="true" />
              <span class="push-branch-result-name">{{ row.name }}</span>
              <span class="push-branch-result-state">{{ stateLabel(row.state) }}</span>
              <span class="push-branch-result-message">{{ row.message }}</span>
            </li>
          </ul>
          <p v-if="hasProblems" class="push-branch-note" role="status">被拒或失败的分支没有改动远端，也未被 force 覆盖；处理完冲突后可再次推送。</p>
        </template>

        <template v-else>
          <p id="push-branches-summary" class="confirmation-summary">
            选择要推送到各自 upstream 的本地分支。常见做法是一次推 dev 与主分支（不同仓库是 main 或 master）。
          </p>
          <p v-if="loading" class="push-branch-state" role="status"><LoaderCircle :size="14" class="spinning" />正在读取分支…</p>
          <template v-else-if="plan">
            <p v-if="blocked" class="push-branch-warning" role="alert"><AlertTriangle :size="15" /><span>{{ blocked }}</span></p>
            <p v-if="pushableCount === 0 && !blocked" class="push-branch-state" role="status">没有可推送的分支：每个分支都需要有 upstream，并且本地领先远端。</p>
            <!-- 没有可推的分支时也把清单列出来：一行一句原因，比「没有可推送的分支」有用得多。 -->
            <ul v-if="plan.branches.length > 0" class="push-branch-list">
              <li v-for="branch in plan.branches" :key="branch.name" :data-blocked="Boolean(branch.blocker)">
                <label :title="branch.blocker || undefined">
                  <input
                    type="checkbox"
                    :checked="selected.includes(branch.name)"
                    :disabled="busy || Boolean(branch.blocker) || Boolean(blocked) || (atLimit && !selected.includes(branch.name))"
                    @change="toggle(branch.name)"
                  />
                  <GitBranch :size="14" aria-hidden="true" />
                  <strong>{{ branch.name }}</strong>
                  <cite v-if="branch.upstream">{{ branch.upstream }}</cite>
                  <span v-if="(branch.ahead ?? 0) > 0" class="push-branch-count" title="本地领先远端的提交数">↑{{ branch.ahead }}</span>
                  <span v-if="(branch.behind ?? 0) > 0" class="push-branch-count behind" title="远端领先本地的提交数">↓{{ branch.behind }}</span>
                  <em v-if="branch.current">当前</em>
                  <small v-if="branch.blocker">{{ branch.blocker }}</small>
                </label>
              </li>
            </ul>
            <p v-if="atLimit" class="push-branch-hint" role="status">
              已选满 {{ maxPushBranchSelection }} 个分支（一次的上限）；其余分支取消勾选后可再选。
            </p>
            <p v-if="plan.branches.length === 0 && !blocked" class="push-branch-state" role="status">这个仓库还没有本地分支。</p>
          </template>
          <p v-if="error" class="push-branch-warning" role="alert"><AlertTriangle :size="15" /><span>{{ error }}</span></p>
        </template>
      </div>

      <footer class="confirmation-footer">
        <span v-if="result">推送期间未使用 force，也没有切换分支。</span>
        <span v-else>永不 force · 一个分支被拒不影响其他分支</span>
        <div>
          <button v-if="result" class="confirmation-confirm" data-dialog-initial @click="emit('close')">关闭</button>
          <template v-else>
            <button class="secondary-button" data-dialog-initial :disabled="busy" @click="emit('close')">取消</button>
            <button class="confirmation-confirm" :disabled="!canSubmit" @click="submit">
              <LoaderCircle v-if="busy" :size="14" class="spinning" /><ArrowUp v-else :size="14" />
              {{ busy ? '正在推送…' : `推送 ${selected.length} 个分支` }}
            </button>
          </template>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.push-branches-modal { --operation-dialog-width: 680px; }
.push-branch-list { list-style: none; margin: 12px 0 0; padding: 0; max-height: 42vh; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.push-branch-list li { margin: 0; }
.push-branch-list label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); background: var(--color-list-muted); cursor: pointer; font-size: .928571rem; }
.push-branch-list li[data-blocked='true'] label { cursor: default; opacity: .62; }
.push-branch-list input { accent-color: var(--color-brand); flex: none; }
/* 分支名与 upstream 都是单行可省略的字段：允许收缩但禁止逐字换行，
   否则窄视口下会出现「de / v」「origin/d / ev」这种竖排碎字。 */
.push-branch-list strong { flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.push-branch-list cite { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-muted); font-style: normal; font-size: .857143rem; }
.push-branch-list em { flex: none; margin-left: auto; padding: 1px 6px; border-radius: var(--radius-pill); background: color-mix(in srgb, var(--color-brand) 16%, transparent); color: var(--color-text-muted); font-style: normal; font-size: .785714rem; }
.push-branch-list small { flex-basis: 100%; color: var(--color-text-muted); font-size: .857143rem; }
.push-branch-count { flex: none; padding: 1px 6px; border-radius: var(--radius-pill); background: color-mix(in srgb, var(--color-success) 18%, transparent); color: var(--color-success); font-size: .785714rem; font-variant-numeric: tabular-nums; }
.push-branch-count.behind { background: color-mix(in srgb, var(--color-yellow) 18%, transparent); color: var(--color-yellow); }
.push-branch-state { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--color-text-muted); font-size: .928571rem; }
.push-branch-hint { margin: 10px 0 0; color: var(--color-text-muted); font-size: .857143rem; }
.push-branch-warning { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; color: var(--color-yellow); font-size: .928571rem; }
.push-branch-note { margin: 12px 0 0; color: var(--color-text-muted); font-size: .928571rem; }
.push-branch-results { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 42vh; overflow: auto; }
.push-branch-results li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); background: var(--color-list-muted); font-size: .928571rem; }
.push-branch-results li[data-state='pushed'] > svg { color: var(--color-success); }
.push-branch-results li[data-state='rejected'] > svg, .push-branch-results li[data-state='failed'] > svg { color: var(--color-red); }
.push-branch-results li[data-state='skipped'] > svg, .push-branch-results li[data-state='up-to-date'] > svg { color: var(--color-text-muted); }
.push-branch-result-name { font-weight: 500; }
.push-branch-result-state { color: var(--color-text-muted); }
.push-branch-result-message { flex-basis: 100%; color: var(--color-text-muted); font-size: .857143rem; }
</style>
