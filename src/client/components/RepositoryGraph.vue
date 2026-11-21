<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AlertTriangle, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw, Search, X } from 'lucide-vue-next';
import type { CommitPageQuery } from '../../shared/contracts';
import type { SelectMenuOption } from '../select-options';
import { api } from '../api';
import { relativeTime } from '../relative-time';
import { displaySubject } from '../commit-subject';
import { GRAPH_LANE_GUTTER, GRAPH_ROW_HEIGHT, foldCommitRefs, graphLaneWidth, layoutCommitGraph } from '../commit-graph';
import { useInfiniteScroll } from '../use-infinite-scroll';
import { useRepositoryHistory } from '../use-repository-history';
import SelectMenu from './SelectMenu.vue';

const props = defineProps<{ repositoryId: string; head: string; currentBranch: string | null; revision: string; active: boolean; branchOptions: SelectMenuOption[] }>();
const emit = defineEmits<{ openCommit: [hash: string] }>();

// 提交图要看「某个分支的树」还是「全部分支的树」——和 GitLens 一样，切换分支只切换图的视角，不 checkout。
// '' 表示全部分支（scope=all），否则是 refs/heads/x 或 refs/remotes/y（scope=ref）。
const ALL_REFS = '';
const selectedRef = ref<string>(ALL_REFS);
// 打开时默认跟随当前分支的树；用户手动选了别的分支后就不再被当前分支变化带走。
let followCurrent = true;
watch(() => props.currentBranch, () => { if (followCurrent) selectedRef.value = props.currentBranch ? 'refs/heads/' + props.currentBranch : ALL_REFS; }, { immediate: true });

// 选择器选项：首项「全部分支」，其余沿用 workspace 的本地/远端分支清单。
const viewOptions = computed<SelectMenuOption[]>(() => [{ value: ALL_REFS, label: '全部分支', hint: '所有本地/远端分支与标签' }, ...props.branchOptions]);
const viewLabel = computed(() => viewOptions.value.find(option => option.value === selectedRef.value)?.label ?? '全部分支');
function changeRef(value: string | number): void {
  followCurrent = false;
  selectedRef.value = String(value);
}

// 搜索走服务端（和提交历史同一个接口），输入防抖后进 query；否则只改本地状态、列表根本不会变。
// 排序默认拓扑序（合并与旁支成组，容易看出分支结构/异常合并）；时间序作为备选。
// 注意 master 这类长合并链在拓扑序下会同时挂起很多泳道（某个内部 Host 仓库 160 条提交：拓扑序 126 条、时间序 4 条），
// 宽度靠列宽压缩兜底，标题仍然可见。
const ORDER_STORAGE_KEY = 'moo-fleet:graph-order:v1';
const orderOptions: SelectMenuOption[] = [
  { value: 'topo', label: '拓扑序', hint: '分支内提交连续、合并成组（泳道更多）' },
  { value: 'date', label: '时间序', hint: '按提交时间排列' },
];
function readStoredOrder(): 'date' | 'topo' {
  // 只有用户明确选过时间序才用时间序，默认拓扑序。
  try { return localStorage.getItem(ORDER_STORAGE_KEY) === 'date' ? 'date' : 'topo'; } catch { return 'topo'; }
}
const selectedOrder = ref<'date' | 'topo'>(readStoredOrder());
function changeOrder(value: string | number): void {
  selectedOrder.value = value === 'topo' ? 'topo' : 'date';
  // 存不上（隐私模式/禁存储）不影响本次会话内的切换。
  try { localStorage.setItem(ORDER_STORAGE_KEY, selectedOrder.value); } catch { /* 忽略 */ }
}
// 搜索状态必须声明在 query 之前：query 的 getter 会在 useRepositoryHistory 的 immediate watcher 里被读到，
// 放到后面会触发 TDZ（整页白屏），vue-tsc 不报这个错。
const search = ref('');
const appliedSearch = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, value => {
  clearTimeout(searchTimer);
  if (value.trim() === appliedSearch.value) return;
  if (!value.trim()) appliedSearch.value = '';
  else searchTimer = setTimeout(() => { appliedSearch.value = value.trim(); }, 250);
}, { flush: 'sync' });
// 搜索字段：标题 / 作者 / 哈希前缀（和提交历史同一个服务端参数）。
const searchField = ref<'message' | 'author' | 'hash'>('message');
const searchFieldOptions: SelectMenuOption[] = [
  { value: 'message', label: '标题', hint: '提交标题/正文' },
  { value: 'author', label: '作者', hint: '姓名或邮箱' },
  { value: 'hash', label: 'SHA', hint: '哈希前缀（至少 4 位）' },
];
const searchPlaceholder = computed(() => searchField.value === 'hash' ? '输入哈希前缀（至少 4 位）' : searchField.value === 'author' ? '搜索作者姓名或邮箱 ⌘K' : '搜索提交标题 ⌘K');
function changeSearchField(value: string | number): void {
  searchField.value = value === 'author' ? 'author' : value === 'hash' ? 'hash' : 'message';
}
const query = computed<CommitPageQuery>(() => ({
  scope: selectedRef.value ? 'ref' : 'all',
  ...(selectedRef.value ? { ref: selectedRef.value } : {}),
  order: selectedOrder.value,
  ...(appliedSearch.value ? { search: appliedSearch.value, searchField: searchField.value } : {}),
}));
// revision 里混入所选引用，切换分支时强制重载，避免读到上一棵树的缓存。
const effectiveRevision = computed(() => props.revision + '|' + selectedRef.value);
const history = useRepositoryHistory({
  repositoryId: () => props.repositoryId,
  reference: () => selectedRef.value || undefined,
  query: () => query.value,
  revision: () => effectiveRevision.value,
  active: () => props.active,
  // 提交图只用列表：不选首条、也不拉取 commit 详情（详情含最多 200 KB 补丁），点行才进提交历史看详情。
  selectDetail: () => false,
  readPage: api.repositoryCommits,
  readDetail: api.commitDetail,
});
const state = history.state;

const rows = computed(() => state.value.commits);
// 贯穿式泳道布局：rows 给出每行节点位置，segments 是按泳道 id 组织的离散段（颜色由布局分配）。
const layout = computed(() => layoutCommitGraph(rows.value));
const graphRows = computed(() => layout.value.rows);
// 泳道多时必须压缩列宽：master 这类分支树上几十条并行泳道，18px/列会把提交标题整个挤出面板。
// 面板宽度用 ResizeObserver 量（v-show 隐藏时为 0，先用窗口宽度兜底，显示后自动校正）。
const root = ref<HTMLElement | null>(null);
const panelWidth = ref(0);
let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  const element = root.value;
  if (!element) return;
  panelWidth.value = element.getBoundingClientRect().width;
  if (typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver((entries) => { panelWidth.value = entries[0]?.contentRect.width ?? panelWidth.value; });
  resizeObserver.observe(element);
});
const laneWidth = computed(() => graphLaneWidth(layout.value.laneCount, panelWidth.value || window.innerWidth * 0.6));
const graphColumnWidth = computed(() => layout.value.laneCount * laneWidth.value + GRAPH_LANE_GUTTER);
// 列宽压到 9px 以下时线宽也收一档，否则密集区会糊成一片。
const dense = computed(() => laneWidth.value < 9);
// 列宽细到 1.5px 以下时线宽再收一档，否则一根压一根会糊成实心色块。
const ultra = computed(() => laneWidth.value < 1.5);
// 泳道很多时整体压暗一档（仍然每条线同色同透明度），避免几十条线把提交列表压成背景噪点。
const busy = computed(() => layout.value.laneCount > 20);
// 自动加载上限：1000 行时约 3000 条 SVG path、布局约 9ms，仍然流畅；再往下滚必须手动点，
// 避免一路滚到底把几万行 DOM 全渲染出来（虚拟滚动没做之前的护栏）。
const AUTO_LOAD_LIMIT = 1000;
const autoLoadLimit = ref(AUTO_LOAD_LIMIT);
const autoLoadCapped = computed(() => state.value.hasMore && rows.value.length >= autoLoadLimit.value);
const svgHeight = computed(() => rows.value.length * GRAPH_ROW_HEIGHT);
const rowHeightPx = GRAPH_ROW_HEIGHT + 'px';

interface RenderPath { d: string; color: number; primary: boolean; }
// 跨列连线用「直线 + 圆角拐弯」，不要用对称 S 弯：横向跑 150px 只给 24px 高度时，
// S 弯的两端半径只剩几像素，看起来就是硬折角。父边从节点横着出去再圆滑下折；
// 汇入边从上方竖着下来再圆滑横折进节点。半径取满一行（24px），横向距离不足时按一半收。
function elbowPath(x1: number, y0: number, x2: number, y1: number, horizontalStart: boolean): string {
  const dx = x2 - x1;
  const sign = Math.sign(dx) || 1;
  // 极密集时 |dx| 可能不到 2px，半径必须跟着收，否则圆角会越过起点形成回折。
  const radius = Math.max(0.2, Math.min(Math.abs(y1 - y0), Math.abs(dx) / 2));
  if (horizontalStart) {
    const sweep = sign > 0 ? 1 : 0;
    return 'M ' + x1 + ' ' + y0
      + ' L ' + (x2 - sign * radius) + ' ' + y0
      + ' A ' + radius + ' ' + radius + ' 0 0 ' + sweep + ' ' + x2 + ' ' + (y0 + radius)
      + ' L ' + x2 + ' ' + y1;
  }
  const sweep = sign > 0 ? 0 : 1;
  return 'M ' + x1 + ' ' + y0
    + ' L ' + x1 + ' ' + (y1 - radius)
    + ' A ' + radius + ' ' + radius + ' 0 0 ' + sweep + ' ' + (x1 + sign * radius) + ' ' + y1
    + ' L ' + x2 + ' ' + y1;
}
interface RenderNode { x: number; y: number; r: number; color: number; merge: boolean; head: boolean; }
// 把同一泳道（laneId）在**连续行、同一列**里的整行竖直段合并成一条连续路径——这是消除行间接缝的关键。
// 其余段（节点上半段、汇入曲线、父边曲线）各自按 fromY/toY 精确绘制，端点落在圆心或行边界上。
const graphSegments = computed<RenderPath[]>(() => {
  const cx = (col: number) => col * laneWidth.value + laneWidth.value / 2;
  const isFullVertical = (s: (typeof layout.value.segments)[number]) => s.from === s.to && s.fromY === 0 && s.toY === 1;
  const out: RenderPath[] = [];
  const used = new Set<number>();
  const segs = layout.value.segments;
  const fullByLane = new Map<string, typeof segs>();
  segs.forEach((seg, idx) => {
    if (!isFullVertical(seg)) return;
    used.add(idx);
    const key = seg.laneId + ':' + seg.from;
    const list = fullByLane.get(key) ?? [];
    list.push(seg);
    fullByLane.set(key, list);
  });
  for (const list of fullByLane.values()) {
    list.sort((a, b) => a.row - b.row);
    let startRow = -2, endRow = -2, primary = false;
    const flush = () => {
      if (startRow < 0) return;
      const x = cx(list[0]!.from);
      out.push({ d: 'M ' + x + ' ' + startRow * GRAPH_ROW_HEIGHT + ' L ' + x + ' ' + (endRow + 1) * GRAPH_ROW_HEIGHT, color: list[0]!.color, primary });
      startRow = endRow = -2; primary = false;
    };
    for (const seg of list) {
      if (startRow >= 0 && endRow + 1 === seg.row) { endRow = seg.row; primary = primary || seg.primary; }
      else { flush(); startRow = endRow = seg.row; primary = seg.primary; }
    }
    flush();
  }
  segs.forEach((seg, idx) => {
    if (used.has(idx)) return;
    const x1 = cx(seg.from);
    const x2 = cx(seg.to);
    const yStart = (seg.row + seg.fromY) * GRAPH_ROW_HEIGHT;
    const yEnd = (seg.row + seg.toY) * GRAPH_ROW_HEIGHT;
    const d = seg.from === seg.to ? 'M ' + x1 + ' ' + yStart + ' L ' + x1 + ' ' + yEnd : elbowPath(x1, yStart, x2, yEnd, seg.fromY === 0.5);
    out.push({ d, color: seg.color, primary: seg.primary });
  });
  return out;
});
// 节点颜色直接用布局给出的色槽（与穿过节点的竖线同一泳道），保证圆圈颜色与线严格一致。
const graphNodes = computed<RenderNode[]>(() => layout.value.nodes.map((node) => {
  const merge = layout.value.rows[node.row]?.merge ?? false;
  // 圆半径跟着列宽收：列宽细到 1px 左右时圈会很小，但不会明显压住相邻泳道。
  const radius = merge ? Math.min(4.5, Math.max(0.8, laneWidth.value * 0.42)) : Math.min(3.5, Math.max(0.6, laneWidth.value * 0.3));
  return {
    x: node.lane * laneWidth.value + laneWidth.value / 2,
    y: node.row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
    r: radius,
    color: node.color,
    merge,
    head: rows.value[node.row]?.hash === props.head,
  };
}));
// 每行只折叠一次分支标签：模板里 visible / hidden 两处若各调一次，60 行就是 120 次数组去重。
// 同一提交上的「本地 + 同名远端」只留一个，最多 3 个分支标签；1024px 下列宽有限，再多会把提交标题挤没。
const badges = computed(() => new Map(rows.value.map(commit => [commit.hash, foldCommitRefs(commit.branches ?? [], 3)])));

const list = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
const paginationError = ref('');
const error = computed(() => state.value.error || paginationError.value);
const searchPending = computed(() => search.value.trim() !== appliedSearch.value);
watch(history.contextKey, () => { paginationError.value = ''; autoLoadLimit.value = AUTO_LOAD_LIMIT; }, { flush: 'sync' });
useInfiniteScroll({
  root: list, sentinel,
  enabled: () => props.active && !searchPending.value && !state.value.loading && !state.value.loadingMore && !error.value && state.value.hasMore && !autoLoadCapped.value,
  context: () => history.contextKey.value,
  count: () => rows.value.length,
  loadMore: async () => { const key = history.contextKey.value; await history.loadMore(); if (key === history.contextKey.value && state.value.error) paginationError.value = state.value.error; },
});
function refresh(): void { paginationError.value = ''; void history.refresh(); }
// 点一次解锁接下来的 200 条（之后照常随滚动自动加载），避免一次点击只加载 20 条、要连点几十次。
function loadMoreExplicit(): void {
  autoLoadLimit.value += 200;
  void history.loadMore();
}
function openCommit(hash: string): void { emit('openCommit', hash); }
const input = ref<HTMLInputElement | null>(null);
function focusSearch(): void { input.value?.focus({ preventScroll: true }); }
// 方向键只移动焦点、不直接打开提交：之前每次 ↓ 都会触发 click 跳进提交历史，等于没法用键盘浏览列表；
// 打开交给 Enter / 空格（button 的原生行为）。
function moveCommit(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.graph-row')) return;
  const buttons = [...(list.value?.querySelectorAll<HTMLButtonElement>('.graph-row') ?? [])];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const step = event.key === 'PageDown' ? 10 : event.key === 'PageUp' ? -10 : event.key === 'ArrowDown' ? 1 : -1;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + step));
  event.preventDefault();
  buttons[next]?.focus({ preventScroll: false });
}
defineExpose({ focusSearch, refresh });
onBeforeUnmount(() => { resizeObserver?.disconnect(); clearTimeout(searchTimer); history.invalidate(); });
</script>

<template>
  <section ref="root" class="workspace-graph" aria-label="提交图">
    <header class="workspace-graph-header">
      <div class="workspace-graph-title"><GitBranch :size="16" /><strong>提交图</strong><SelectMenu :model-value="selectedRef" :options="viewOptions" aria-label="切换提交图分支" class="select-menu--compact workspace-graph-ref" @update:model-value="changeRef" /><SelectMenu :model-value="selectedOrder" :options="orderOptions" aria-label="切换提交图排序" class="select-menu--compact workspace-graph-sort" @update:model-value="changeOrder" /></div>
      <div class="workspace-graph-tools">
        <SelectMenu :model-value="searchField" :options="searchFieldOptions" aria-label="切换搜索字段" class="select-menu--compact workspace-graph-field" @update:model-value="changeSearchField" />
        <label class="workspace-graph-search"><Search :size="13" /><input ref="input" v-model="search" maxlength="300" aria-label="搜索提交记录" :placeholder="searchPlaceholder" /><button v-if="search" class="table-icon-button" aria-label="清除搜索" @click="search = ''; focusSearch()"><X :size="12" /></button></label>
        <button class="table-icon-button" aria-label="刷新提交图" :disabled="state.loading || searchPending" @click="refresh"><RefreshCw :size="14" :class="{ spinning: state.loading }" /></button>
      </div>
    </header>
    <div ref="list" class="workspace-graph-scroll" @keydown="moveCommit">
      <!-- 同一查询刷新时保留列表（只让刷新按钮转圈）；搜索/换序会换 contextKey，
           列表确实会短暂进入加载态。 -->
      <div v-if="!rows.length && (searchPending || state.loading)" class="workspace-empty"><LoaderCircle :size="24" class="spinning" /><strong>{{ search ? '搜索提交…' : '读取提交图…' }}</strong></div>
      <div v-else-if="!rows.length && !error" class="workspace-empty"><GitCommitHorizontal :size="28" /><strong>{{ appliedSearch ? '没有匹配的提交' : '暂无提交' }}</strong><span>{{ appliedSearch ? '已搜索当前范围的完整历史' : '当前仓库还没有任何提交' }}</span></div>
      <div v-else role="list" :aria-label="'提交图，共 ' + rows.length + ' 个提交'" :aria-busy="state.loading || searchPending" class="workspace-graph-rows" :style="{ paddingLeft: graphColumnWidth + 'px', '--graph-row-height': rowHeightPx }">
        <!-- 一张连续 SVG 覆盖整张图的泳道；绝对定位贴在左侧，随内容滚动。端点落在行边界，跨行不断线。 -->
        <svg class="graph-overlay" :class="{ 'graph-overlay--dense': dense, 'graph-overlay--ultra': ultra, 'graph-overlay--busy': busy }" :width="graphColumnWidth" :height="svgHeight" :viewBox="'0 0 ' + graphColumnWidth + ' ' + svgHeight" aria-hidden="true">
          <path v-for="(seg, i) in graphSegments" :key="'s' + i" :d="seg.d" :class="['graph-lane-' + seg.color, { 'graph-lane-primary': seg.primary }]" fill="none" />
          <template v-for="(node, i) in graphNodes" :key="'n' + i">
            <circle :cx="node.x" :cy="node.y" :r="node.r" :class="['graph-node-' + node.color, { 'graph-node-merge': node.merge, 'graph-node-head': node.head }]" />
          </template>
        </svg>
        <div v-for="(commit, index) in rows" :key="commit.hash" role="listitem" class="workspace-graph-item">
          <button class="graph-row" :class="{ merge: graphRows[index]?.merge, current: commit.hash === head }" :aria-label="'打开提交 ' + commit.hash.slice(0, 7) + ' ' + displaySubject(commit.subject)" :title="displaySubject(commit.subject)" @click="openCommit(commit.hash)">
            <span class="graph-subject"><span class="graph-subject-text">{{ displaySubject(commit.subject) }}</span><span v-if="graphRows[index]?.merge" class="graph-merge-badge">合并</span></span>
            <span class="graph-refs">
              <b v-if="commit.hash === head" class="graph-ref graph-ref-head">HEAD</b>
              <b v-if="currentBranch && commit.hash === head" class="graph-ref graph-ref-branch">{{ currentBranch }}</b>
              <template v-for="branch in badges.get(commit.hash)?.visible ?? []" :key="'b-' + branch">
                <b v-if="!(branch === currentBranch && commit.hash === head)" class="graph-ref graph-ref-branch">{{ branch }}</b>
              </template>
              <b v-if="(badges.get(commit.hash)?.hidden ?? 0) > 0" class="graph-ref graph-ref-branch" :title="(commit.branches ?? []).join('、')">+{{ badges.get(commit.hash)?.hidden }}</b>
              <b v-for="tag in commit.tags.slice(0, 2)" :key="'t-' + tag" class="graph-ref graph-ref-tag">{{ tag }}</b>
              <b v-if="commit.tags.length > 2" class="graph-ref graph-ref-tag" :title="commit.tags.join('、')">+{{ commit.tags.length - 2 }}</b>
            </span>
            <span class="graph-author">{{ commit.author }}</span>
            <time class="graph-time" :datetime="commit.committedAt" :title="new Date(commit.committedAt).toLocaleString()">{{ relativeTime(commit.committedAt, { longAgo: 'date' }) }}</time>
            <code class="graph-hash">{{ commit.hash.slice(0, 7) }}</code>
          </button>
        </div>
      </div>
      <div v-if="error && !searchPending" class="workspace-history-error" role="alert"><AlertTriangle :size="15" /><span>{{ error }}</span><button class="compact-button" @click="refresh">刷新后重试</button></div>
      <div v-if="state.hasMore && !searchPending && !state.loading && !error && !autoLoadCapped" ref="sentinel" class="workspace-history-more" role="status" aria-live="polite"><template v-if="state.loadingMore"><LoaderCircle :size="13" class="spinning" />正在加载更多提交…</template><span v-else>向下滚动，自动加载更多</span></div>
      <div v-else-if="state.hasMore && !searchPending && !state.loading && !error" class="workspace-history-more" role="status" aria-live="polite"><span>已加载 {{ rows.length }} 条，继续加载会变慢</span><button class="compact-button" :disabled="state.loadingMore" @click="loadMoreExplicit"><LoaderCircle v-if="state.loadingMore" :size="13" class="spinning" />{{ state.loadingMore ? '加载中…' : '继续加载更多' }}</button></div>
    </div>
    <div class="workspace-graph-footer"><span>{{ viewLabel }} · {{ selectedOrder === 'topo' ? '拓扑序' : '时间序' }}{{ state.shallow ? ' · 浅克隆（仅有本地历史）' : '' }} · 单击打开提交 · ↑ ↓ 浏览</span><span>{{ appliedSearch ? '匹配' : '已加载' }} {{ rows.length }}{{ state.hasMore ? ' · 还有更多' : state.shallow ? ' · 到浅克隆边界' : ' · 全部记录' }}</span></div>
  </section>
</template>
