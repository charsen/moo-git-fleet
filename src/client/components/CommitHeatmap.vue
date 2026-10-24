<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import type { AnalyticsRepositoryScope, CommitCodeVolumeSummary, CommitHeatmapData, CommitOvertimeSummary } from '../../shared/contracts';
import type { SelectMenuOption } from '../select-options';
import SelectMenu from './SelectMenu.vue';
import { sameAnalyticsRepositoryScope } from '../../shared/analytics-scope';
import { Activity, AlertTriangle, BarChart3, CalendarDays, Clock3, FileDiff, Flame, FolderGit2, GitCommit, MoonStar, RefreshCw, TrendingUp, Users } from 'lucide-vue-next';
import {
  MINUTES_PER_WORKDAY,
  RESTART_GAP_MINUTES,
  SEGMENT_CONTEXT_MINUTES,
  SEGMENT_GAP_MINUTES,
  formatWorkdayWindow,
} from '../../shared/work-window';
import {
  analyticsRangeOptions,
  dayIndexFromIso,
  isIsoDate,
  localDateFromIso,
  localIsoDate,
  maxAnalyticsRangeDays,
  rangeMatchesSelection,
  resolveAnalyticsRange,
  type AnalyticsRange,
} from '../../shared/report-window';
import {
  bucketRepositoryFreshness,
  buildHeatmapWeeksForWindow,
  buildMonthLabels,
  countRepositoriesActiveSince,
  heatmapLevel,
  initialHeatmapCursor,
  isHeatmapDayDrawn,
  moveHeatmapCursor,
  summarizeHeatmapWindow,
  summarizeHourly,
  type HeatmapArrowKey,
  type HeatmapCursor,
} from '../heatmap-grid';
import { formatHours, formatWorkdays, isZeroHours, overtimeParts } from '../overtime-presentation';
import type { RankingMetric } from '../ranking-metric';
import { formatLines, totalLines, volumeBreakdown, volumeParts } from '../volume-presentation';

const props = defineProps<{
  data: CommitHeatmapData | null;
  /** 所选时间段：四个预设之一，或用户自选的起止日期。由 App 持久化。 */
  range: AnalyticsRange;
  /** 排行榜度量。整页只有一个，由 App 持久化。 */
  metric: RankingMetric;
  repositoryOptions: SelectMenuOption[];
  repositoryScope: AnalyticsRepositoryScope;
  loading: boolean;
  /** 换时间段时的后台请求：保留旧数据，只淡一层，避免整页闪成骨架 */
  refreshing?: boolean;
  /** 请求失败时的可读原因；有值就显示错误态而不是「暂无数据」 */
  error: string | null;
}>();

const emit = defineEmits<{
  retry: [];
  'update:range': [range: AnalyticsRange];
  'update:metric': [metric: RankingMetric];
  'update:repositoryScope': [scope: AnalyticsRepositoryScope];
}>();
function selectRepositories(values: Array<string | number> | null): void {
  emit('update:repositoryScope', values === null ? null : values.map(String));
}
const repositoryScopeLabel = computed(() => props.repositoryScope === null ? '全部仓库' : `已选 ${props.repositoryScope.length} 个仓库`);
const previousRepositoryScope = computed(() => props.data !== null
  && !sameAnalyticsRepositoryScope(props.data.repositoryScope, props.repositoryScope));

/** 时间段预设。标签和周数同源（shared/report-window.ts），不在这里另写一份。 */
const rangeOptions = analyticsRangeOptions;

/** 当前选中的是哪个预设；选了自定义范围时为 null（四个预设都不高亮）。 */
const activePresetWeeks = computed(() => props.range.kind === 'preset' ? props.range.weeks : null);

function selectRange(weeks: number): void {
  if (activePresetWeeks.value === weeks) return;
  emit('update:range', { kind: 'preset', weeks });
}

const customRangeOpen = ref(false);
const todayIso = localIsoDate(new Date());
const customStart = ref('');
const customEnd = ref('');
const customError = ref('');

/** 展开面板时把输入框填成「当前正在看的范围」，改一两个字母就能微调。 */
function toggleCustomRange(): void {
  if (customRangeOpen.value) {
    customRangeOpen.value = false;
    return;
  }
  const fallback = resolveAnalyticsRange(props.range.kind === 'preset' ? { weeks: props.range.weeks } : { start: props.range.start, end: props.range.end });
  const current = props.data?.range;
  customStart.value = current?.start ?? fallback.start;
  customEnd.value = current?.end ?? fallback.end;
  customError.value = '';
  customRangeOpen.value = true;
}

const customDays = computed(() => {
  if (!isIsoDate(customStart.value) || !isIsoDate(customEnd.value)) return 0;
  return dayIndexFromIso(customEnd.value) - dayIndexFromIso(customStart.value) + 1;
});

/**
 * 校验不通过时「应用」是禁用的，并且说清为什么。
 *
 * 服务端对这些情况一律回落成默认预设（只读接口不报错），但那会让用户以为
 * 自己选的范围生效了——所以拦在点击之前，别指望回落机制替界面解释。
 */
const customIssue = computed(() => {
  if (customStart.value === '' || customEnd.value === '') return '请把起止日期都填上';
  if (!isIsoDate(customStart.value) || !isIsoDate(customEnd.value)) return '日期格式不对';
  if (customDays.value < 1) return '结束日期不能早于开始日期';
  if (customDays.value > maxAnalyticsRangeDays) return `最多 ${maxAnalyticsRangeDays} 天（5 年）`;
  return '';
});

function applyCustomRange(): void {
  if (customIssue.value !== '') {
    customError.value = customIssue.value;
    return;
  }
  customError.value = '';
  customRangeOpen.value = false;
  emit('update:range', { kind: 'custom', start: customStart.value, end: customEnd.value });
}

function selectMetric(metric: RankingMetric): void {
  if (metric === props.metric) return;
  emit('update:metric', metric);
}

const tooltip = ref<{ x: number; y: number; text: string; visible: boolean }>({
  x: 0,
  y: 0,
  text: '',
  visible: false,
});

const cellSize = 12;
const cellGap = 3;
/** 网格原点：顶部留给月份标签，左侧留给星期标签。 */
const gridTop = 18;
const gridLeft = 32;

/**
 * 当前**正在显示**的时间窗口。
 *
 * 一律以服务端回传的 `range` 为准：标签、日期范围、格子、四个数字必须描述同一份
 * 数据。切时间段时数据要一会儿才回来，若标签先跟着按钮变，就会出现「近两年 ·
 * 共 7,291 次提交」这种和「近一年」一模一样的假象——数字还没换，标签先换了。
 * 现在标签跟着数据走，工具栏另外用「统计中…」表示正在切。
 *
 * 只有还没拿到任何数据时才按所选周数本地推一份，避免首屏空白。
 */
const activeRange = computed(() => {
  if (props.data?.range) return props.data.range;
  const resolved = resolveAnalyticsRange(props.range.kind === 'preset'
    ? { weeks: props.range.weeks }
    : { start: props.range.start, end: props.range.end });
  return { kind: resolved.kind, weeks: resolved.weeks, label: resolved.label, start: resolved.start, end: resolved.end };
});

const rangeLabel = computed(() => activeRange.value.label);
const rangeDates = computed(() => `${activeRange.value.start} ~ ${activeRange.value.end}`);
/** 服务端回传的范围与所选不一致（非法值回落）：界面要说清实际按哪个范围算的。 */
const rangeAdjusted = computed(() => {
  const data = props.data;
  return Boolean(data) && !rangeMatchesSelection(data!.range, props.range) && !props.refreshing;
});

const gridWeeks = computed(() =>
  buildHeatmapWeeksForWindow(
    activeRange.value.start,
    activeRange.value.end,
    props.data?.daily ?? {},
    localIsoDate(new Date()),
  ),
);
const windowStats = computed(() => summarizeHeatmapWindow(gridWeeks.value));

/**
 * 窗口起点（第 0 列周一）。和热力图实际画出来的第一格是同一个值——
 * 「活跃仓库」要按它筛，不能另算一套，否则卡片和格子会各说各话。
 */
const windowStart = computed(() => gridWeeks.value[0]?.[0]?.date ?? '');

/**
 * 窗口内有提交的仓库数。
 *
 * 服务端的 `summary.activeRepos` 是全部历史里有提交的仓库（用来判断「有没有东西
 * 可看」）；这里的口径是所选时间段。放一起读者必然当成同一个窗口，
 * 所以按窗口重算一遍。
 */
const activeReposInWindow = computed(() =>
  countRepositoriesActiveSince(props.data?.byRepo ?? [], windowStart.value),
);

/**
 * 色阶上限用**窗口内**峰值，不用全量峰值。
 * 全量口径下只要历史上有一天爆过 500 次提交，窗口内所有日子都会被压到最浅一档。
 */
const maxDaily = computed(() => windowStats.value.maxDaily);

const levelColors = [
  'var(--heatmap-empty)',
  'var(--heatmap-l1)',
  'var(--heatmap-l2)',
  'var(--heatmap-l3)',
  'var(--heatmap-l4)',
] as const;

function cellColor(count: number): string {
  return levelColors[heatmapLevel(count, maxDaily.value)];
}

const monthLabels = computed(() => buildMonthLabels(gridWeeks.value));

/** tooltip 尺寸估算，用来在贴边时翻到另一侧，避免被视口裁掉。 */
const tooltipWidth = 168;
const tooltipHeight = 34;
const viewportMargin = 8;

function placeTooltip(clientX: number, clientY: number): { x: number; y: number } {
  let x = clientX + 14;
  let y = clientY - tooltipHeight - 10;
  if (x + tooltipWidth > window.innerWidth - viewportMargin) x = clientX - tooltipWidth - 14;
  if (y < viewportMargin) y = clientY + 18;
  return { x: Math.max(viewportMargin, x), y };
}

function showTooltip(event: MouseEvent, date: string, count: number) {
  const text = count > 0 ? `${date} · ${count} 次提交` : `${date} · 无提交`;
  tooltip.value = { ...placeTooltip(event.clientX, event.clientY), text, visible: true };
}

function moveTooltip(event: MouseEvent) {
  if (!tooltip.value.visible) return;
  const { x, y } = placeTooltip(event.clientX, event.clientY);
  tooltip.value.x = x;
  tooltip.value.y = y;
}

function hideTooltip() {
  tooltip.value.visible = false;
}

/**
 * 数据换了一批（刷新、失败、切回页面）就收起 tooltip。
 * 否则格子被卸载后，那条 `position: fixed` 的提示会孤零零留在屏幕中间，
 * 上面还写着上一批数据里某一天的数字。
 */
watch(
  [() => props.loading, () => props.error, () => props.data],
  () => { tooltip.value.visible = false; },
);

const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 热力图的键盘光标。
 *
 * 735 个格子逐个加 `tabindex` 会让 Tab 键在这里卡 735 下，比只能鼠标更糟；
 * 整张图因此只占一个 Tab 站点，进去之后用方向键逐日移动，Home / End 跳到首尾周。
 * 视觉高亮靠 `.is-keyboard-focused`，读屏播报靠下面那个 `aria-live`。
 */
const heatmapSvg = ref<SVGSVGElement | null>(null);
const cursor = ref<HeatmapCursor | null>(null);
const keyboardMessage = ref('');

/** 光标落在哪一天；模板据此给对应的 `rect` 加高亮类。 */

/**
 * 窗口或数据换了就重设光标。
 *
 * 旧的 `(week, day)` 在更窄的窗口里可能已经越界（近两年 → 近 3 个月会少 78 列），
 * 留着会让高亮消失、方向键又从一个不存在的位置开始走。
 */
watch(
  () => [activeRange.value.start, activeRange.value.end, gridWeeks.value.length],
  () => { cursor.value = initialHeatmapCursor(gridWeeks.value); },
  { immediate: true },
);

/** 把一个格子换算成屏幕坐标，供键盘态复用鼠标那套 tooltip 定位。 */
function cellTooltipPoint(position: HeatmapCursor): { x: number; y: number } {
  const svg = heatmapSvg.value;
  if (!svg) return { x: 0, y: 0 };
  const rect = svg.getBoundingClientRect();
  // viewBox 是固定坐标系，实际渲染尺寸随容器变，两个轴要分别缩放
  const scaleX = chartWidth.value > 0 ? rect.width / chartWidth.value : 1;
  const scaleY = chartHeight > 0 ? rect.height / chartHeight : 1;
  return placeTooltip(
    rect.left + (position.week * (cellSize + cellGap) + gridLeft + cellSize / 2) * scaleX,
    rect.top + (position.day * (cellSize + cellGap) + gridTop + cellSize / 2) * scaleY,
  );
}

function describeCell(position: HeatmapCursor): string {
  const day = gridWeeks.value[position.week]?.[position.day];
  if (!day) return '';
  // 周一 = 0，和网格行序一致
  const weekday = weekdayLabels[(localDateFromIso(day.date).getDay() + 6) % 7];
  return day.count > 0 ? `${day.date} 周${weekday} · ${day.count} 次提交` : `${day.date} 周${weekday} · 无提交`;
}

function focusHeatmapCell(position: HeatmapCursor): void {
  cursor.value = position;
  const text = describeCell(position);
  if (!text) return;
  keyboardMessage.value = text;
  tooltip.value = { ...cellTooltipPoint(position), text, visible: true };
}

function onHeatmapFocus(): void {
  const position = cursor.value ?? initialHeatmapCursor(gridWeeks.value);
  if (position) focusHeatmapCell(position);
}

function onHeatmapKeydown(event: KeyboardEvent): void {
  const arrows: HeatmapArrowKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!arrows.includes(event.key as HeatmapArrowKey)) return;

  // 撞到边界也要吞掉方向键：不拦的话整页会跟着滚，读者会以为格子丢了
  event.preventDefault();

  const current = cursor.value ?? initialHeatmapCursor(gridWeeks.value);
  if (!current) return;
  const next = moveHeatmapCursor(current, event.key as HeatmapArrowKey, gridWeeks.value);
  if (!next) {
    if (!cursor.value) focusHeatmapCell(current);
    return;
  }
  focusHeatmapCell(next);
}

/** 7×24 时段矩阵。服务端没给数据时补一个空矩阵，避免模板里到处判空。 */
const hourly = computed<number[][]>(() => {
  const source = props.data?.hourly;
  if (Array.isArray(source) && source.length === 7) return source;
  return Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
});

const hourlySummary = computed(() => summarizeHourly(hourly.value));
const hourlyMax = computed(() => hourlySummary.value.peak?.count ?? 0);

/** 每行 7 个星期标签 + 24 个格子，拼成 25 列的一维数组，用 CSS grid 排。 */
const hourlyRows = computed(() =>
  hourly.value.map((row, weekday) =>
    row.map((count, hour) => ({
      key: `${weekday}-${hour}`,
      count,
      color: count > 0 ? levelColors[heatmapLevel(count, hourlyMax.value)] : 'var(--heatmap-empty)',
      title: `周${weekdayLabels[weekday]} ${String(hour).padStart(2, '0')}:00 · ${count} 次提交`,
    })),
  ),
);

const hourTicks = [
  { hour: 0, label: '0' },
  { hour: 6, label: '6' },
  { hour: 12, label: '12' },
  { hour: 18, label: '18' },
  { hour: 23, label: '23' },
];

function percentOf(part: number): number {
  const total = hourlySummary.value.total;
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

const hourlyStats = computed(() => {
  const summary = hourlySummary.value;
  const peak = summary.peak;
  const workday = percentOf(summary.workday);
  const weekend = percentOf(summary.weekend);
  const lateNight = percentOf(summary.lateNight);
  // 四个数字并排时，0 和 100 用同一个最亮色就等于没有重点。和工作台一致：
  // 零值收敛到灰（data-zero），让真有数的那几项自己浮出来。
  return [
    { key: 'workday', label: '工作日', value: workday, unit: '%', zero: workday === 0 },
    { key: 'weekend', label: '周末', value: weekend, unit: '%', zero: weekend === 0 },
    { key: 'late', label: '深夜 22–6 点', value: lateNight, unit: '%', zero: lateNight === 0 },
    {
      key: 'peak',
      label: '最忙时段',
      value: peak ? `周${weekdayLabels[peak.weekday]} ${String(peak.hour).padStart(2, '0')}:00` : '—',
      unit: '',
      zero: !peak,
    },
  ];
});

const freshness = computed(() => bucketRepositoryFreshness(props.data?.byRepo ?? [], new Date()));

const freshnessRows = computed(() => {
  const buckets = freshness.value;
  const leader = Math.max(buckets.week, buckets.month, buckets.quarter, buckets.older, 1);
  return [
    { key: 'week', label: '7 天内', count: buckets.week, opacity: 1 },
    { key: 'month', label: '8–30 天', count: buckets.month, opacity: 0.72 },
    { key: 'quarter', label: '31–90 天', count: buckets.quarter, opacity: 0.48 },
    { key: 'older', label: '91 天以上', count: buckets.older, opacity: 0.3 },
  ].map((row) => ({
    ...row,
    width: `${row.count > 0 ? Math.max((row.count / leader) * 100, 2) : 0}%`,
  }));
});

/** 91 天以上 + 31–90 天 = 超过 30 天没动过的仓库。 */
const staleCount = computed(() => freshness.value.quarter + freshness.value.older);

/**
 * 没有出现在 `byRepo` 里的仓库数。
 *
 * 服务端把「没有任何提交」「目录不存在」「不是 git 仓库」都当成「没有可统计的提交」，
 * 但只有前一种是正常的。后两种由 `summary.unreadable` 单列，这里的数字要先把它们
 * 剔掉，否则界面会拿「还没开始写」替一个坏路径背锅。
 */
const unreadable = computed(() => props.data?.summary.unreadable ?? { count: 0, names: [], reason: null });

const idleRepos = computed(() => {
  const summary = props.data?.summary;
  if (!summary) return 0;
  return Math.max(summary.totalRepos - summary.activeRepos - unreadable.value.count, 0);
});

/** 仓库一个都读不到时，空态的措辞必须换一套——那不是「历史还是空的」。 */
const allUnreadable = computed(() => {
  const summary = props.data?.summary;
  return !!summary && summary.totalRepos > 0 && unreadable.value.count >= summary.totalRepos;
});

const emptyTitle = computed(() => {
  if (allUnreadable.value) return '仓库都读取失败';
  if (props.data && props.data.summary.totalRepos > 0) return '这些仓库还没有提交记录';
  return '暂无可用仓库的提交数据';
});

const emptyHint = computed(() => {
  const summary = props.data?.summary;
  if (summary && allUnreadable.value) {
    // git 给了原因就直接说，别替它猜。猜错的代价是让人去翻一堆没问题的路径。
    if (unreadable.value.reason) return `${summary.totalRepos} 个仓库都读取失败：${unreadable.value.reason}`;
    return `${summary.totalRepos} 个仓库的目录不可访问或不是 Git 仓库，请到「仓库舰队」检查路径`;
  }
  if (summary && summary.totalRepos > 0) {
    return `已收录 ${summary.totalRepos} 个仓库，但它们的 Git 历史还是空的`;
  }
  return '请先在「仓库舰队」里添加仓库，并确认本地目录可访问';
});

const freshnessNote = computed(() => {
  const parts = [`超过 30 天没动 ${staleCount.value} 个`];
  if (idleRepos.value > 0) parts.push(`另有 ${idleRepos.value} 个从未提交`);
  return parts.join(' · ');
});

/**
 * 排行榜的度量。
 *
 * 提交数说明不了产出：一次依赖升级能刷出几万行 lock，一次提交也可能只改一个错别字。
 * 但提交数也有不可替代的地方——「这个仓库还在不在动」只有它能答。所以给两种，
 * 由用户自己切，而不是替他选一个。
 *
 * 开关摆在页面工具栏里，不挂在两张卡上：它们排的是同一批提交，两个开关看着像
 * 能分别设置，实际绑同一个状态。一张页面上只留一个口径。
 */

interface RankingRow {
  key: string;
  name: string;
  /** 当前度量下的数值，用来排宽度 */
  metric: number;
  /** 数值的显示形式（提交数带千分位，代码量用万 / 亿） */
  display: string;
  /** title 里的补充说明：另一个度量的数字、被合并进来的写法 */
  detail: string;
}

const rankingHint = computed(() =>
  props.metric === 'commits'
    ? `${rangeLabel.value} · 非合并提交数`
    : `${rangeLabel.value} · 新增 + 删除行数`,
);

function rankDisplay(value: number): string {
  return props.metric === 'commits' ? value.toLocaleString() : formatLines(value);
}

/** 排行榜按榜首归一化：按「占总提交数」算的话，20 个仓库时每条都只有几个像素。 */
function barWidth(value: number, leader: number): string {
  if (leader <= 0) return '0%';
  return `${Math.max((value / leader) * 100, 1.5)}%`;
}

const repoRows = computed<RankingRow[]>(() => {
  // 服务端把「有历史提交但本窗口没提交」的仓库也放在 byRepo 里（活跃度卡要用），
  // 排行这边得滤掉：0 提交 / 0 行的仓库不该占榜位。
  const repos = (props.data?.byRepo ?? []).filter((repo) => repo.total > 0 || repo.additions + repo.deletions > 0);
  const byVolume = props.metric === 'volume';
  const score = (repo: (typeof repos)[number]): number =>
    byVolume ? repo.additions + repo.deletions : repo.total;

  return [...repos]
    .sort((left, right) => score(right) - score(left) || left.repositoryName.localeCompare(right.repositoryName))
    .slice(0, 10)
    .map((repo) => ({
      key: repo.repositoryId,
      name: repo.repositoryName,
      metric: score(repo),
      display: rankDisplay(score(repo)),
      detail: byVolume
        ? `${repo.total.toLocaleString()} 次提交`
        : `${volumeBreakdown(repo)} · ${rangeLabel.value}`,
    }));
});

const authorRows = computed<RankingRow[]>(() => {
  const authors = props.data?.byAuthor ?? [];
  const byVolume = props.metric === 'volume';
  const score = (author: (typeof authors)[number]): number =>
    byVolume ? author.additions + author.deletions : author.commits;

  return [...authors]
    .sort((left, right) => score(right) - score(left) || left.name.localeCompare(right.name))
    .slice(0, 10)
    .map((author) => ({
      key: author.name,
      name: author.name,
      metric: score(author),
      display: rankDisplay(score(author)),
      detail: [
        // 同一个人多种写法被合并时要说清楚，否则用户会以为数字算错了
        author.aliases.length > 0 ? `含别名 ${author.aliases.join('、')}` : '',
        byVolume ? `${author.commits.toLocaleString()} 次提交` : `${volumeBreakdown(author)} · ${rangeLabel.value}`,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
});

const repoLeader = computed(() => repoRows.value[0]?.metric ?? 0);
const authorLeader = computed(() => authorRows.value[0]?.metric ?? 0);

const activeAverage = computed(() => {
  const { commits, activeDays } = windowStats.value;
  return activeDays > 0 ? Math.round((commits / activeDays) * 10) / 10 : 0;
});

const caption = computed(() => {
  const summary = props.data?.summary;
  if (!summary || summary.totalCommits === 0) return '';
  // 副标题写的是所选时间段，这里的数字就必须是同一窗口内的。
  // 原来取的是 summary.totalCommits（全历史），和紧挨着的提交卡片
  // 差出两成，同一屏并排放着必被读成矛盾。
  if (windowStats.value.commits <= 0) return '没有提交';
  const parts = [`共 ${windowStats.value.commits.toLocaleString()} 次提交`];
  if (activeAverage.value > 0) parts.push(`活跃日均 ${activeAverage.value} 次`);
  return parts.join(' · ');
});

/** 没有提交时也要能渲染，别让模板里到处判空。 */
const emptyOvertime: CommitOvertimeSummary = {
  workMinutes: 0,
  offHoursMinutes: 0,
  workdayMinutes: 0,
  weekendMinutes: 0,
  earlyMinutes: 0,
  lunchMinutes: 0,
  eveningMinutes: 0,
  segments: 0,
  activeDays: 0,
  lightDays: 0,
  equivalentDays: 0,
};

const overtime = computed<CommitOvertimeSummary>(() => props.data?.overtime ?? emptyOvertime);
const overtimePartsView = computed(() => overtimeParts(overtime.value));
const overtimeIsZero = computed(() => isZeroHours(overtime.value.offHoursMinutes));
const workdayWindow = formatWorkdayWindow();
const workdayHours = MINUTES_PER_WORKDAY / 60;

const emptyVolume: CommitCodeVolumeSummary = {
  additions: 0,
  deletions: 0,
  files: 0,
  excludedFiles: 0,
  binaryFiles: 0,
};

const volume = computed<CommitCodeVolumeSummary>(() => props.data?.codeVolume ?? emptyVolume);
const volumePartsView = computed(() => volumeParts(volume.value));
const volumeTotal = computed(() => totalLines(volume.value));
const volumeAdditionsWidth = computed(() => `${volumePartsView.value[0]?.share ?? 0}%`);
const volumeBreakdownText = computed(() => volumeBreakdown(volume.value));

/** 「剔除了 N 个生成文件」只在真剔过时才说，否则全是噪声。 */
const excludedNote = computed(() =>
  volume.value.excludedFiles > 0 ? `剔除 ${volume.value.excludedFiles.toLocaleString()} 文件次` : '无生成文件',
);

/** 列数跟着所选时间段走：viewBox 用逻辑尺寸（格子 12px），渲染时按容器等比缩放。 */
const chartWidth = computed(() => gridLeft + gridWeeks.value.length * (cellSize + cellGap) + 14);
const chartHeight = gridTop + 7 * (cellSize + cellGap);
/** 渲染后一格的最小边长：再小色阶就分不出深浅了，宁可横向滚动。 */
const minRenderedCell = 9;
/**
 * 渲染后一格的最大边长，按列数分两档。
 *
 * 这一条是为了让「换时间段」不改变卡片的体量。早先上界一律 26px（按 2.16 倍算），
 * 于是同一个卡片在四个预设之间切换时，格子从 10px 跳到 26px，卡片高度跟着在
 * 102 / 198 / 265px 三档之间来回跳，下面的统计卡被迫上下位移——点一次按钮整页
 * 抖一下，这是「换周期后不好看」最主要的来源，比留白更刺眼。
 *
 * 现在：列数够多（近一年以上，52 列）时仍放宽到 26px，让 1920 以上的宽屏铺得满；
 * 短窗口（近 3 个月 14 列、自定义几十天）钉在 18px，卡片高度稳定在 ~184px。
 * 短窗口本来也填不满卡片——只有 14 列，要铺满得把一格放到 80px，那就是一面色块墙，
 * 不如让它窄着、靠左、留白。
 */
const widePlotColumns = 40;
const maxRenderedCell = computed(() => (gridWeeks.value.length >= widePlotColumns ? 26 : 18));
/**
 * 宽度上下界都按「格子边长」换算，不再写 2.16 这种魔法倍数：
 * 语义是「一格最多 18/26px、最少 9px」，改哪一档都只改上面两个常量。
 */
const chartMaxWidth = computed(() => Math.round(chartWidth.value * (maxRenderedCell.value / cellSize)));
const chartMinWidth = computed(() => Math.round(chartWidth.value * (minRenderedCell / cellSize)));

/**
 * 横向滚动的可见提示。
 *
 * 近两年有 105 列，窗口一窄就放不下（应用最小 1024，用户默认窗口 1354 也放不下）。
 * macOS 的覆盖式滚动条不滚就不出现，卡片右边缘又正好切在某一列上——整张图看着像
 * 「到 8 月就结束了」，和标题上的「近两年」自相矛盾。
 *
 * 两条处理：一是溢出时把视口停在**最右端**（最近的日子），时间序列里最新的数据
 * 最该先看见；二是内容还在某侧延续时，那一侧边缘渐隐，滚到底就撤掉。
 */
const viewportEl = ref<HTMLElement | null>(null);
const viewportScroll = ref({ left: 0, content: 0, visible: 0 });
let viewportObserver: ResizeObserver | null = null;

const canScrollLeft = computed(() => viewportScroll.value.left > 1);
const canScrollRight = computed(
  () => viewportScroll.value.left + viewportScroll.value.visible < viewportScroll.value.content - 1,
);

function syncViewportScroll(): void {
  const el = viewportEl.value;
  if (!el) return;
  viewportScroll.value = { left: el.scrollLeft, content: el.scrollWidth, visible: el.clientWidth };
}

function viewportAtRightEnd(): boolean {
  const { left, content, visible } = viewportScroll.value;
  return content > 0 && left + visible >= content - 1;
}

/**
 * 尺寸变了以后保持「贴住最右端」。
 *
 * 窗口从 1354 缩到 1024 时，视口的可用宽度少了 300px，原先停在最右端的位置会
 * 把最近几个月挤出视野——卡片标题还写着「近两年」，图却停在 4 月。原本就在最右端
 * 的话，缩放后继续贴住最右端；用户自己拖到中间的，就尊重他的位置。
 */
function keepViewportAtRightEnd(): void {
  const wasAtEnd = viewportAtRightEnd();
  syncViewportScroll();
  const el = viewportEl.value;
  if (!wasAtEnd || !el || el.scrollWidth <= el.clientWidth + 1) return;
  el.scrollLeft = el.scrollWidth;
  syncViewportScroll();
}

/** 溢出时停到最右端；已经能整屏放下就归零，免得留个假的偏移。 */
function anchorViewportRight(): void {
  const el = viewportEl.value;
  if (!el) return;
  el.scrollLeft = el.scrollWidth > el.clientWidth ? el.scrollWidth : 0;
  syncViewportScroll();
}

/**
 * 用函数式 ref 绑定视口：图表在 `v-else` 分支里，加载态与错误态时节点根本不存在，
 * 挂载时一次性拿 ref 会扑空。ResizeObserver 同时盯视口（窗口变宽）和 svg（列数变化，
 * 换时间段后 min-width 跟着变），两种情况都不需要额外的 watch。
 */
function bindViewport(el: Element | ComponentPublicInstance | null): void {
  const node = el instanceof HTMLElement ? el : null;
  // Vue 每次 patch 都会重新调用函数式 ref。同一个节点重复回调必须原样返回：
  // 否则下面重挂 observer 并重新锚定最右端，会把用户刚拖到的位置一直拽回去，
  // 表现就是「这张图根本滚不动」。
  if (node === viewportEl.value) return;
  viewportObserver?.disconnect();
  viewportObserver = null;
  viewportEl.value = node;
  if (!node || typeof ResizeObserver === 'undefined') {
    syncViewportScroll();
    return;
  }
  viewportObserver = new ResizeObserver(() => keepViewportAtRightEnd());
  viewportObserver.observe(node);
  if (node.firstElementChild) viewportObserver.observe(node.firstElementChild);
  // 函数式 ref 是在节点刚创建、还没插进文档时回调的，此刻 scrollWidth 一定是 0。
  // 等这一轮 patch 落地再锚定，否则「停在最右端」在首次渲染时会失效。
  void nextTick(anchorViewportRight);
}

// 换时间段 = 换列数，重新停到最右端。仓库范围变化不动列数，就不打扰用户当前的滚动位置。
watch(
  () => gridWeeks.value.length,
  () => {
    void nextTick(anchorViewportRight);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  viewportObserver?.disconnect();
  viewportObserver = null;
});
</script>

<template>
  <div class="commit-heatmap" @mouseleave="hideTooltip">
    <!-- 时间段、排行度量与仓库范围放在状态分支之外，加载、空态和失败时仍可切换。
         三个都是**整页唯一**的口径：卡上再各写一份就会出现同屏两种统计范围。 -->
    <div class="range-toolbar" @pointerenter="hideTooltip" @click.capture="hideTooltip">
      <div class="range-switch" role="group" aria-label="统计时间段">
        <button
          v-for="option in rangeOptions"
          :key="option.weeks"
          type="button"
          :class="{ active: option.weeks === activePresetWeeks }"
          :aria-pressed="option.weeks === activePresetWeeks"
          :data-weeks="option.weeks"
          @click="selectRange(option.weeks)"
        >{{ option.label }}</button>
        <!-- 自由选择：预设只覆盖固定跨度，查某个迭代、某次上线前后就只能填日期 -->
        <button
          type="button"
          class="range-custom-trigger"
          :class="{ active: range.kind === 'custom' }"
          :aria-pressed="range.kind === 'custom'"
          :aria-expanded="customRangeOpen"
          data-range="custom"
          @click="toggleCustomRange"
        >自定义</button>
      </div>
      <span class="range-dates">{{ rangeDates }}</span>
      <span v-if="refreshing" class="range-refreshing" role="status">统计中…</span>
      <span v-else-if="rangeAdjusted" class="range-adjusted">已按{{ rangeLabel }}统计</span>
      <!-- 「排行口径」四个字不能省：单独一组「提交数 / 增删行」会被读成筛提交类型，
           而这组按钮只改两张排行卡的排法与数字，热力图和统计卡不受影响。
           视觉上可见、读屏上交给下面那组的 aria-label，不重复播报两遍。 -->
      <span class="range-caption" aria-hidden="true">排行口径</span>
      <div class="metric-switch" role="group" aria-label="排行口径">
        <button
          type="button"
          :class="{ active: metric === 'commits' }"
          :aria-pressed="metric === 'commits'"
          data-metric="commits"
          @click="selectMetric('commits')"
        >提交数</button>
        <button
          type="button"
          :class="{ active: metric === 'volume' }"
          :aria-pressed="metric === 'volume'"
          data-metric="volume"
          @click="selectMetric('volume')"
        >增删行</button>
      </div>
      <SelectMenu
        class="select-menu--compact analytics-repository-scope"
        :options="repositoryOptions"
        :multiple-values="repositoryScope"
        aria-label="仓库范围"
        multiple
        searchable
        search-placeholder="搜索仓库名称、分组或路径"
        @update:multiple-values="selectRepositories"
      >
        <template #trigger-label>仓库范围 · {{ repositoryScopeLabel }}</template>
      </SelectMenu>
    </div>

    <!-- 数据来源必须常显：这一页只读本机仓库副本，从不连接远端，连「刷新」也只是
         就地重算。不写清楚，「同事昨天推的提交怎么没有」就会变成一个 bug 报告。
         刻意不写「截至某次 Fetch 的时间」——那需要额外的请求和状态同步，而用户要
         知道的只是「为什么这里看不到最新提交、该做什么」。 -->
    <p class="analytics-local-note" data-local-note>
      <RefreshCw :size="12" aria-hidden="true" />
      <span>分析读的是本地仓库副本，不连接远端；远端有新提交要先 Fetch 才会更新，记得及时 Fetch。</span>
    </p>

    <!-- 自定义时间段：两个原生 date 输入，不进下拉、不用自绘日历——
         浏览器自带的日期面板已经带键盘输入、上下键调日和本地化，重造一份只会更难用。 -->
    <div v-if="customRangeOpen" class="range-custom" role="group" aria-label="自定义时间段">
      <label class="range-custom-field">
        <span>从</span>
        <input v-model="customStart" type="date" :max="todayIso" data-range-start />
      </label>
      <span class="range-custom-tilde">~</span>
      <label class="range-custom-field">
        <span>到</span>
        <input v-model="customEnd" type="date" :max="todayIso" :min="customStart || undefined" data-range-end />
      </label>
      <span v-if="customIssue" class="range-custom-hint" role="status">{{ customIssue }}</span>
      <span v-else class="range-custom-hint">共 {{ customDays }} 天</span>
      <button class="compact-button range-custom-apply" type="button" :disabled="customIssue !== ''" @click="applyCustomRange">应用</button>
      <button class="compact-button" type="button" @click="customRangeOpen = false">取消</button>
    </div>
    <p v-if="previousRepositoryScope" class="repository-scope-pending" role="status">
      {{ refreshing ? '正在切换仓库范围，下面暂为上一次的统计结果' : '仓库范围尚未更新，下面仍为上一次成功统计的结果' }}
    </p>

    <!-- 加载态 -->
    <div v-if="loading" class="heatmap-state">
      <div class="heatmap-spinner" />
      <p>正在分析所选仓库的提交历史…</p>
    </div>

    <!-- 错误态：不能退化成「暂无数据」，否则用户会以为仓库真的没有提交。
         但只在**一份数据都没有**时才整页报错——60 秒一次的轮询偶尔失败时，
         屏幕上明明还留着上一次的结果，把它整页换掉是最糟的处理方式。 -->
    <div v-else-if="error && !data" class="heatmap-state heatmap-error">
      <AlertTriangle :size="44" />
      <p>分析数据加载失败</p>
      <span>{{ error }}</span>
      <button class="secondary-button" @click="emit('retry')">重新加载</button>
    </div>

    <!-- 空态 -->
    <div v-else-if="!data || data.summary.activeRepos === 0" class="heatmap-state">
      <AlertTriangle v-if="allUnreadable" :size="44" />
      <BarChart3 v-else :size="44" />
      <p>{{ data?.repositoryScope?.length === 0 ? '尚未选择仓库' : emptyTitle }}</p>
      <span>{{ data?.repositoryScope?.length === 0 ? '请从右上方仓库范围中选择要分析的仓库' : emptyHint }}</span>
    </div>

    <template v-else>
      <!-- 有数据但这次刷新失败：把错误降级成一行提示，图表照常显示 -->
      <p v-if="error" class="heatmap-stale-error" role="status">
        <AlertTriangle :size="13" />
        <span>{{ error }}——下面仍是上一次成功统计的结果</span>
        <button class="link-button" type="button" @click="emit('retry')">重试</button>
      </p>
      <!-- 热力图作为页面主体，放在最上面 -->
      <section class="heatmap-section">
        <header class="heatmap-header">
          <div>
            <h2><Flame :size="18" />提交热力图</h2>
            <p class="heatmap-subtitle">{{ rangeLabel }} · {{ caption || '暂无提交' }}</p>
          </div>
        </header>

        <!-- 图例跟着图的右边缘，不跟着卡片的右边缘。
             短窗口（近 3 个月只有 14 列）时图本来就窄，图例要是留在卡片最右，
             两个元素中间会空出一千多像素，看着像各说各话；
             图与图例包在同一个宽度受限的盒子里，短窗口整体居中，长窗口照旧铺满。 -->
        <div class="heatmap-plot" :style="{ maxWidth: `${chartMaxWidth}px` }">
          <div class="heatmap-legend" aria-hidden="true">
            <span>少</span>
            <i v-for="color in levelColors" :key="color" :style="{ background: color }" />
            <span>多</span>
          </div>

          <div
            :ref="bindViewport"
            class="heatmap-viewport"
            :class="{ 'fade-left': canScrollLeft, 'fade-right': canScrollRight }"
            @scroll.passive="syncViewportScroll"
          >
        <svg
          ref="heatmapSvg"
          :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
          class="heatmap-svg"
          :style="{ maxWidth: chartMaxWidth + 'px', minWidth: chartMinWidth + 'px' }"
          role="group"
          tabindex="0"
          :aria-label="`${rangeLabel}共 ${windowStats.commits} 次提交的热力图。按方向键逐日查看，Home 和 End 跳到首尾周。`"
          @mousemove="moveTooltip"
          @keydown="onHeatmapKeydown"
          @focus="onHeatmapFocus"
          @blur="hideTooltip"
        >
          <!-- 月份标签 -->
          <text
            v-for="label in monthLabels"
            :key="label.label + label.index"
            :x="label.index * (cellSize + cellGap) + gridLeft"
            :y="gridTop - 6"
            class="heatmap-month-label"
          >{{ label.label }}</text>

          <!-- 星期标签：与网格第 0 / 2 / 4 行（周一 / 周三 / 周五）对齐 -->
          <text
            v-for="row in [0, 2, 4]"
            :key="row"
            :x="2"
            :y="gridTop + row * (cellSize + cellGap) + cellSize / 2 + 3.5"
            class="heatmap-day-label"
          >{{ ['一', '三', '五'][row / 2] }}</text>

          <!-- 格子：今天之后的日期不画，免得空白被读成「那天没有提交」 -->
          <g v-for="(week, weekIndex) in gridWeeks" :key="weekIndex">
            <template v-for="(day, dayIndex) in week" :key="day.date">
              <rect
                v-if="isHeatmapDayDrawn(day)"
                :x="weekIndex * (cellSize + cellGap) + gridLeft"
                :y="dayIndex * (cellSize + cellGap) + gridTop"
                :width="cellSize"
                :height="cellSize"
                :fill="cellColor(day.count)"
                :data-count="day.count"
                :data-date="day.date"
                rx="2"
                ry="2"
                :class="['heatmap-cell', { 'is-keyboard-focused': cursor?.week === weekIndex && cursor?.day === dayIndex }]"
                @mouseenter="showTooltip($event, day.date, day.count)"
              />
            </template>
          </g>
        </svg>
        </div>
        </div>
        <!-- 键盘移动时读出当前格：格子本身是 SVG，没法逐格加 aria-label -->
        <p class="sr-only" aria-live="polite">{{ keyboardMessage }}</p>
      </section>

      <!-- 统计卡片 -->
      <div class="heatmap-stats">
        <div class="stat-card">
          <GitCommit :size="20" />
          <div>
            <strong :data-zero="windowStats.commits === 0 ? 'true' : undefined">{{ windowStats.commits.toLocaleString() }}</strong>
            <span>{{ rangeLabel }}提交</span>
          </div>
        </div>
        <div class="stat-card">
          <CalendarDays :size="20" />
          <div>
            <strong :data-zero="windowStats.activeDays === 0 ? 'true' : undefined">{{ windowStats.activeDays }}</strong>
            <span>活跃天数</span>
          </div>
        </div>
        <div class="stat-card">
          <TrendingUp :size="20" />
          <div>
            <strong :data-zero="windowStats.maxDaily === 0 ? 'true' : undefined">{{ windowStats.maxDaily }}</strong>
            <span>单日最多提交</span>
          </div>
        </div>
        <div class="stat-card">
          <FolderGit2 :size="20" />
          <div>
            <strong :data-zero="activeReposInWindow === 0 ? 'true' : undefined">{{ activeReposInWindow }}</strong>
            <span>活跃仓库</span>
          </div>
        </div>
      </div>

      <!-- 投入的两个侧面：花了多久（时长）、写了多少（行数）。
           两张卡并列，共用同一套栅格，分栏边界和下面两排落在同一条竖线上 -->
      <div class="heatmap-investment">
        <section class="heatmap-card overtime-card">
          <header class="heatmap-card-header">
            <h3><MoonStar :size="16" />非上班时间</h3>
            <span class="heatmap-card-hint">{{ rangeLabel }} · 工作日 {{ workdayWindow }} 以外（含午休）及周末全天</span>
          </header>
          <div class="overtime-figure">
            <strong :data-zero="overtimeIsZero ? 'true' : undefined">{{ formatHours(overtime.offHoursMinutes) }}</strong>
            <em>小时</em>
            <p>
              折合 {{ formatWorkdays(overtime.equivalentDays) }} 个 {{ workdayHours }} 小时工作日
              · 涉及 {{ overtime.activeDays }} 天<template v-if="overtime.lightDays > 0">（含 {{ overtime.lightDays }} 天不足 15 分钟）</template>
              · 推算投入 {{ formatHours(overtime.workMinutes) }} 小时
            </p>
          </div>
          <div class="overtime-bar" aria-hidden="true">
            <span
              v-for="part in overtimePartsView"
              :key="part.key"
              :data-part="part.key"
              :style="{ width: part.share + '%', opacity: part.opacity }"
            />
          </div>
          <ul class="overtime-legend">
            <li v-for="part in overtimePartsView" :key="part.key">
              <i :style="{ opacity: part.opacity }" />
              <span>{{ part.label }}</span>
              <b :data-zero="part.minutes === 0 ? 'true' : undefined">{{ formatHours(part.minutes) }} 小时</b>
            </li>
          </ul>
          <p class="overtime-note">
            相邻提交间隔 ≤{{ SEGMENT_GAP_MINUTES }} 分钟算同一工作段；距上一段结束 ≥{{ RESTART_GAP_MINUTES }} 分钟才补
            {{ SEGMENT_CONTEXT_MINUTES }} 分钟准备时间。跨过午休、且午休内没有提交的那一段不计入任何一档。
            工作日只按周一至周五算，不含法定节假日与调休；按提交时间推算，不等同于考勤。
          </p>
        </section>

        <section class="heatmap-card volume-card">
          <header class="heatmap-card-header">
            <h3><FileDiff :size="16" />代码量</h3>
            <span class="heatmap-card-hint">{{ rangeLabel }} · 已剔除生成文件</span>
          </header>
          <div class="volume-figure">
            <strong :data-zero="volumeTotal === 0 ? 'true' : undefined">{{ formatLines(volumeTotal) }}</strong>
            <em>增删行</em>
            <p>{{ volumeBreakdownText }} · 累计 {{ volume.files.toLocaleString() }} 文件次</p>
          </div>
          <svg
            class="volume-bar"
            aria-hidden="true"
            focusable="false"
            shape-rendering="crispEdges"
            :data-empty="volumeTotal === 0 ? 'true' : undefined"
          >
            <template v-if="volumeTotal > 0">
              <rect data-part="deletions" x="0" y="0" width="100%" height="100%" />
              <rect data-part="additions" x="0" y="0" :width="volumeAdditionsWidth" height="100%" />
            </template>
          </svg>
          <ul class="volume-legend">
            <li v-for="part in volumePartsView" :key="part.key">
              <i :data-part="part.key" />
              <span>{{ part.label }}</span>
              <b :data-zero="part.lines === 0 ? 'true' : undefined">{{ formatLines(part.lines) }}</b>
            </li>
            <li>
              <span>{{ excludedNote }}</span>
            </li>
          </ul>
          <p class="volume-note">
            只统计所选时间段的非合并提交。依赖锁文件、.min.js、node_modules 与 dist / build / coverage 等产物目录、
            导出的 .sql、sourcemap、图片音视频等二进制、以及哈希命名的构建产物都不计入。
            文件次按提交计次：同一文件改 3 次记 3 次。
          </p>
        </section>
      </div>

      <!-- 时段与仓库健康：两个都是「同一批 git log 里已经有的信息」，不额外跑命令 -->
      <div class="heatmap-insights">
        <section class="heatmap-card">
          <header class="heatmap-card-header">
            <h3><Clock3 :size="16" />提交时段</h3>
            <span class="heatmap-card-hint">{{ rangeLabel }} · 7 × 24 · 按作者本地时间</span>
          </header>
          <div class="hours-body">
            <div class="hours-chart">
              <div class="hours-grid">
                <template v-for="(row, weekday) in hourlyRows" :key="weekday">
                  <span class="hours-day">{{ weekdayLabels[weekday] }}</span>
                  <div
                    v-for="cell in row"
                    :key="cell.key"
                    class="hours-cell"
                    :style="{ background: cell.color }"
                    :title="cell.title"
                  />
                </template>
              </div>
              <div class="hours-axis">
                <span v-for="tick in hourTicks" :key="tick.hour" :style="{ gridColumn: tick.hour + 2 }">{{ tick.label }}</span>
              </div>
            </div>
            <dl class="hours-stats">
              <div v-for="stat in hourlyStats" :key="stat.key">
                <dt>{{ stat.label }}</dt>
                <dd :class="{ 'hours-peak': stat.key === 'peak' }" :data-zero="stat.zero ? 'true' : undefined">
                  {{ stat.value }}<em v-if="stat.unit">{{ stat.unit }}</em>
                </dd>
              </div>
            </dl>
          </div>
          <p class="hours-note">
            占比的分母是所选时间段内的提交数；「深夜」与「工作日 / 周末」互有重叠，不是同一组分类。
          </p>
        </section>

        <section class="heatmap-card">
          <header class="heatmap-card-header">
            <h3><Activity :size="16" />仓库活跃度</h3>
            <span class="heatmap-card-hint">最近一次提交距今</span>
          </header>
          <div class="freshness-list">
            <div v-for="row in freshnessRows" :key="row.key" class="freshness-row">
              <span class="freshness-label">{{ row.label }}</span>
              <div class="freshness-bar-wrapper">
                <div class="freshness-bar" :style="{ width: row.width, opacity: row.opacity }" />
              </div>
              <span class="freshness-value">{{ row.count }}</span>
            </div>
          </div>
          <p class="freshness-note">{{ freshnessNote }}</p>
          <!-- 读不到和没提交是两件事：坏路径要单独指出来，否则用户永远只会去翻 Git 历史 -->
          <p v-if="unreadable.count > 0" class="freshness-warning">
            <AlertTriangle :size="13" />
            <span>
              {{ unreadable.count }} 个仓库读取失败：{{ unreadable.names.join('、') }}<template
                v-if="unreadable.count > unreadable.names.length"
              > 等</template>
              <template v-if="unreadable.reason"><br>{{ unreadable.reason }}</template>
              <template v-else>（目录不可访问或不是 Git 仓库）</template>
            </span>
          </p>
        </section>
      </div>

      <div class="heatmap-columns">
        <!-- 仓库排行 -->
        <section class="heatmap-ranking">
          <header class="ranking-header">
            <h3><FolderGit2 :size="16" />仓库排行</h3>
          </header>
          <p class="ranking-hint">{{ rankingHint }}</p>
          <div class="ranking-list">
            <div v-for="row in repoRows" :key="row.key" class="ranking-item" :data-metric="metric">
              <span class="ranking-name" :title="`${row.name} · ${row.detail}`">{{ row.name }}</span>
              <div class="ranking-bar-wrapper">
                <div class="ranking-bar" :style="{ width: barWidth(row.metric, repoLeader) }" />
              </div>
              <span class="ranking-value">{{ row.display }}</span>
            </div>
          </div>
        </section>

        <!-- 作者排行 -->
        <section class="heatmap-ranking">
          <header class="ranking-header">
            <h3><Users :size="16" />作者排行</h3>
          </header>
          <p class="ranking-hint">{{ rankingHint }}</p>
          <div class="ranking-list">
            <div v-for="row in authorRows" :key="row.key" class="ranking-item" :data-metric="metric">
              <span class="ranking-name" :title="`${row.name} · ${row.detail}`">{{ row.name }}</span>
              <div class="ranking-bar-wrapper">
                <div class="ranking-bar" :style="{ width: barWidth(row.metric, authorLeader) }" />
              </div>
              <span class="ranking-value">{{ row.display }}</span>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- Tooltip -->
    <div
      v-if="tooltip.visible"
      class="heatmap-tooltip"
      :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
    >
      {{ tooltip.text }}
    </div>
  </div>
</template>

<style scoped>
.commit-heatmap {
  /* 撑满工作区：.workspace 已经给了左右留白，这里不再叠加，也不再限宽。 */
  padding: 6px 0 0;
  margin: 0;
  position: relative;

  /* 整页只有一套栅格：上排（时段 / 活跃度）和下排（两个排行）共用列宽与间距。
     原来上排 3:2、下排 1:1，两排的分栏边界差出半列，下排那张卡会往左探出来一截——
     页面被横切成两套不同的栏，越往下越像没对齐。比例写在这里，两处都只引用，
     免得以后改一处忘一处。 */
  --heatmap-gap: 20px;
  --heatmap-columns: minmax(0, 3fr) minmax(0, 2fr);
}

.heatmap-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 420px;
  color: var(--color-text-muted);
}

.heatmap-state p {
  color: var(--color-text);
  font-size: 16px;
  font-weight: 500;
  margin: 0;
}

.heatmap-state span {
  font-size: 13px;
  max-width: 480px;
  text-align: center;
  line-height: 1.6;
}

.heatmap-state .secondary-button {
  margin-top: 4px;
}

.heatmap-error {
  color: var(--color-red);
}

.heatmap-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-surface-hover);
  border-top-color: var(--color-success);
  border-radius: 50%;
  animation: heatmap-spin 0.8s linear infinite;
}

@keyframes heatmap-spin {
  to { transform: rotate(360deg); }
}

.heatmap-section {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  padding: 20px 24px 18px;
  margin-bottom: 20px;
}

.heatmap-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.heatmap-header h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text-strong);
  margin: 0;
}

/* 主体区块的图标带一点「热度」语义，和右侧图例的色阶呼应；
   下面几个 h3 是中性文字色，层级上不该和它抢。 */
.heatmap-header h2 svg {
  color: var(--heatmap-l3);
  flex: none;
}

.heatmap-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 图 + 图例的整体盒子：宽度由「格子最多 18px」决定，比卡片窄时靠左。
   靠左而不是居中，是因为整张卡的标题、副标题、下面的统计卡全部左对齐；
   把图挪到中间会让它在卡片里"浮"起来，和标题的左边缘对不上。 */
.heatmap-plot {
  width: 100%;
}

.heatmap-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}

.heatmap-legend i {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  display: block;
}

.heatmap-svg {
  display: block;
  width: 100%;
  height: auto;
}

/* 长窗口（近两年 105 列）放不进一屏时横向滚动；短窗口由 svg 的 max-width 兜住，
   不让几列格子铺满整行。短窗口靠左而不是居中：整页所有卡片都是左对齐，
   居中的图会像浮在卡里、和标题的左边缘对不上。 */
.heatmap-viewport {
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
}

/*
 * 哪边还有内容，哪边就渐隐。近两年在 1024 / 1280 / 1354 宽的窗口里都放不下
 * 105 列，没有这层提示，读者会把「卡片边缘」当成「数据到这里为止」。
 */
.heatmap-viewport.fade-left.fade-right {
  mask-image: linear-gradient(to right, transparent, #000 32px, #000 calc(100% - 32px), transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 32px, #000 calc(100% - 32px), transparent);
}

.heatmap-viewport.fade-left {
  mask-image: linear-gradient(to right, transparent, #000 32px);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 32px);
}

.heatmap-viewport.fade-right {
  mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent);
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent);
}

/* 时间段：整页唯一的范围开关，所以放在最外层卡片之外，视觉上属于页面而不是某张卡 */
.range-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 14px;
}

/* 时间段与排行度量都是页面级口径，样式共用一套：同样的按钮组、同样的选中态，
   读者不用学第二种开关的样子。 */
:is(.range-switch, .metric-switch) {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--color-surface-hover);
}

.analytics-repository-scope {
  margin-left: auto;
  min-width: 210px;
}

.analytics-repository-scope :deep(.select-menu-options) {
  left: auto;
  right: 0;
}

.repository-scope-pending {
  margin: 0 0 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}

/* 数据来源说明：比工具栏低一档的辅助信息，不参与任何状态切换，
   所以不做成可关闭的提示条——关掉之后就没人再提醒「这里是本地副本」。 */
.analytics-local-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -4px 0 14px;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.analytics-local-note svg {
  flex: none;
  opacity: 0.75;
}

:is(.range-switch, .metric-switch) button {
  border: 0;
  padding: 4px 10px;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}

:is(.range-switch, .metric-switch) button:hover:not(.active) {
  color: var(--color-text);
}

:is(.range-switch, .metric-switch) button.active {
  background: var(--color-surface-raised);
  color: var(--color-text-strong);
}

:is(.range-switch, .metric-switch) button:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

/* 按钮组本身自解释（「近一年」不必再挂标签），而「提交数 / 增删行」独立成组时
   会被读成筛提交类型，得给一句 11px 的说明把这组钉在「排行」上。 */
.range-caption {
  margin-left: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 具体到哪一天也写出来：只写「近一年」时，读者没法确认「一年」是从今天往前
   推 365 天，还是按自然周对齐——这两种算法能差出一周。 */
.range-dates {
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 自定义时间段：放在工具栏下方单独一行，展开时不挤动上面的三个口径。
   用原生 date 输入，日历面板由浏览器提供（根上已有 color-scheme: dark）。 */
.range-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: -2px 0 14px;
  padding: 9px 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  background: var(--color-surface);
}

.range-custom-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.range-custom-field input {
  padding: 4px 7px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.range-custom-field input:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

.range-custom-tilde {
  color: var(--color-text-muted);
  font-size: 12px;
}

/* 天数与「哪里不对」共用一行：数字本身就是校验反馈，不该占两个位置。 */
.range-custom-hint {
  min-width: 88px;
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.range-custom-apply {
  color: var(--color-brand-ink);
  border-color: var(--color-brand);
  background: var(--color-brand);
}

.range-custom-apply:hover:not(:disabled) {
  border-color: var(--color-brand-hover);
  background: var(--color-brand-hover);
}

.range-refreshing {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 服务端把非法周数回落成默认值时，界面上的按钮和实际统计范围会对不上——
   这一行把「实际按哪个范围算的」讲明白，而不是让日期范围自己说话。 */
.range-adjusted {
  font-size: 11px;
  color: var(--color-yellow);
}

/* 有数据、但这次刷新失败：一行提示，不抢图表的位置 */
.heatmap-stale-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--color-border-subtle);
  border-left: 2px solid var(--color-yellow);
  border-radius: 6px;
  background: var(--color-surface-hover);
  font-size: 12px;
  color: var(--color-text-muted);
}

.heatmap-stale-error svg {
  color: var(--color-yellow);
  flex: none;
}

.heatmap-stale-error .link-button {
  margin-left: auto;
  border: 0;
  padding: 0;
  background: none;
  color: var(--color-brand);
  font-size: 12px;
  cursor: pointer;
}

.heatmap-month-label {
  font-size: 11px;
  fill: var(--color-text-muted);
}

.heatmap-day-label {
  font-size: 10px;
  fill: var(--color-text-muted);
}

.heatmap-cell {
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.heatmap-cell:hover {
  opacity: 0.75;
  stroke: var(--color-text-muted);
  stroke-width: 1px;
}

/* 键盘光标：比悬停更实（2px 焦点色），并且不降透明度——
   降了会和 hover 一样淡，读者分不清「我停在这」和「我刚划过去」。 */
.heatmap-cell.is-keyboard-focused {
  opacity: 1;
  stroke: var(--color-focus);
  stroke-width: 2px;
}

/* SVG 自己有 1px 描边式的视觉边界，outline 要留 2px 才不贴着格子 */
.heatmap-svg:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

.heatmap-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  /* 原来这里 16px、下面两行 20px，横向看过去间距不齐；统一到同一档。 */
  gap: var(--heatmap-gap);
  margin-bottom: var(--heatmap-gap);
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  color: var(--color-success);
}

.stat-card strong {
  display: block;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-strong);
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

/* 同工作台口径：零值退回灰。 */
.stat-card strong[data-zero='true'] {
  color: var(--color-text-muted);
}

.stat-card span {
  display: block;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 2px;
}

.heatmap-insights {
  display: grid;
  grid-template-columns: var(--heatmap-columns);
  gap: var(--heatmap-gap);
  margin-bottom: var(--heatmap-gap);
}

.heatmap-card {
  min-width: 0;
  padding: 18px 24px 20px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
}

.heatmap-card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.heatmap-card-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-strong);
}

.heatmap-card-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.hours-body {
  display: flex;
  align-items: center;
  gap: 28px;
}

/* 24 列 × 7 行；第 1 列留给星期标签，所以是 25 列网格 */
.hours-chart {
  flex: 2 1 320px;
  min-width: 260px;
}

.hours-grid {
  display: grid;
  grid-template-columns: repeat(25, minmax(0, 1fr));
  gap: 3px;
}

.hours-day {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--color-text-muted);
}

.hours-cell {
  aspect-ratio: 1;
  min-height: 6px;
  border-radius: 2px;
}

.hours-axis {
  display: grid;
  grid-template-columns: repeat(25, minmax(0, 1fr));
  gap: 3px;
  margin-top: 6px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.hours-stats {
  flex: 1 1 200px;
  max-width: 360px;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
}

.hours-stats > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hours-stats dt {
  font-size: 11px;
  color: var(--color-text-muted);
}

.hours-stats dd {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--color-text-strong);
  font-variant-numeric: tabular-nums;
}

.hours-stats dd em {
  margin-left: 1px;
  font-style: normal;
  font-size: 12px;
  color: var(--color-text-muted);
}

.hours-stats .hours-peak {
  font-size: 15px;
}

/* 零值不是重点：压低到标签档灰，别和 100% 抢同一个视觉重量。
   口径与工作台的 .summary-block strong[data-zero] 一致——只改颜色，不动字重。 */
.hours-stats dd[data-zero='true'] {
  color: var(--color-text-muted);
}

/* 占比的口径说明：四个数字里「深夜」和「工作日 / 周末」是两套切法，会重叠 */
.hours-note {
  margin: 12px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.freshness-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.freshness-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.freshness-label {
  color: var(--color-text);
  white-space: nowrap;
}

.freshness-bar-wrapper {
  height: 8px;
  border-radius: 4px;
  background: var(--color-surface-hover);
  overflow: hidden;
}

.freshness-bar {
  height: 100%;
  border-radius: 4px;
  background: var(--color-success);
  transition: width 0.4s ease;
}

.freshness-value {
  text-align: right;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.freshness-note {
  margin: 16px 0 0;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 读不到的仓库：和「没提交」是两件事，用告警色单独一行，别混进上面那句统计里 */
.freshness-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-yellow);
}

.freshness-warning svg {
  flex: none;
  margin-top: 1px;
}

/* ---------- 投入：花了多久 + 写了多少 ---------- */

/* 两张卡都是「一个大数字 + 一条构成条 + 图例 + 口径注脚」，
   所以并排放在同一套栅格里，结构对得上，眼睛不用重新找位置。 */
.heatmap-investment {
  display: grid;
  grid-template-columns: var(--heatmap-columns);
  gap: var(--heatmap-gap);
  margin-bottom: var(--heatmap-gap);
}

.overtime-figure,
.volume-figure {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.overtime-figure strong,
.volume-figure strong {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--color-text-strong);
  font-variant-numeric: tabular-nums;
}

/* 和工作台、统计卡一个口径：零值退回灰，不和真数抢视觉重量 */
.overtime-figure strong[data-zero='true'],
.volume-figure strong[data-zero='true'] {
  color: var(--color-text-muted);
}

.overtime-figure em,
.volume-figure em {
  font-style: normal;
  font-size: 13px;
  color: var(--color-text-muted);
}

.overtime-figure p,
.volume-figure p {
  margin: 0 0 0 auto;
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.overtime-bar,
.volume-bar {
  height: 10px;
  /* 条形是纯色硬边，它的边界就是盒边界；字形却退在字身里，26px 大数字左侧
     有 2px、右侧 1px 的侧边距（12px 正文字号的一半）。左右不对称地内缩，
     条的两端才落在数字笔画的同一条竖线上。图例色块同理（见 .volume-legend li），
     两个硬边元素必须缩同一个量，否则条和它下面那个小方块会错开 1px。 */
  margin: 16px 0.5px 10px 2px;
  border-radius: 5px;
}

/* 非上班时长那条是四段同色、靠 opacity 分深浅，仍用子元素拼：
   改渐变要把每段的 opacity 换算成 color-mix，段数多、收益不抵复杂度。 */
.overtime-bar {
  display: flex;
  background: var(--color-surface-hover);
  overflow: hidden;
}

/* 红色铺满轨道，再覆盖新增比例；两块共用 SVG 的 y/height 和外层圆角裁切。
   crispEdges 让竖直接缝落在设备像素边界，不再使用渐变、透明缝或比例过渡。 */
.volume-bar {
  display: block;
  width: calc(100% - 2.5px);
  overflow: hidden;
  background: var(--color-surface-hover);
}

.volume-bar rect[data-part='additions'] {
  fill: var(--color-success);
}

.volume-bar rect[data-part='deletions'] {
  fill: var(--color-red-muted);
}

.overtime-bar span {
  display: block;
  transition: width 0.4s ease;
  background: var(--color-orange);
}

.overtime-legend,
.volume-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 24px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--color-text-muted);
}

.overtime-legend li,
.volume-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 和 .overtime-bar / .volume-bar 的左侧内缩同一个量，色块才压在条端点的正下方。
     没有色块的那一项（剔除 N 文件次）跟着一起缩，三项的缩进节奏保持一致。 */
  padding-left: 2px;
}

.overtime-legend i,
.volume-legend i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.overtime-legend i {
  background: var(--color-orange);
}

.volume-legend i[data-part='additions'] {
  background: var(--color-success);
}

.volume-legend i[data-part='deletions'] {
  background: var(--color-red-muted);
}

.overtime-legend b,
.volume-legend b {
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.overtime-legend b[data-zero='true'],
.volume-legend b[data-zero='true'] {
  color: var(--color-text-muted);
}

.overtime-note,
.volume-note {
  margin: 12px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.heatmap-columns {
  display: grid;
  /* 与上排同一套列宽，分栏边界才落在同一条竖线上。 */
  grid-template-columns: var(--heatmap-columns);
  gap: var(--heatmap-gap);
}

.heatmap-ranking {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  padding: 18px 24px 20px;
}

.ranking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.heatmap-ranking h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-strong);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 排行度量开关已经搬到页面工具栏（.metric-switch），卡头只留标题。
   两个数现在是同一个时间段、同一个度量，由顶部的选择器统一决定。 */

/* 度量得写出来：两个数现在是同一个时间段（跟着页面顶部的选择器走），
   但「提交数」和「增删行」仍是两种度量，不说清楚就分不出哪个是哪个 */
.ranking-hint {
  margin: 6px 0 14px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.ranking-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ranking-item {
  display: grid;
  /* 值列要放得下「243.9 万」，52px 会被挤成两行 */
  grid-template-columns: 152px 1fr 72px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.ranking-name {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ranking-bar-wrapper {
  height: 8px;
  background: var(--color-surface-hover);
  border-radius: 4px;
  overflow: hidden;
}

.ranking-bar {
  height: 100%;
  background: var(--color-success);
  border-radius: 4px;
  transition: width 0.4s ease;
}

.ranking-value {
  color: var(--color-text-muted);
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.heatmap-tooltip {
  position: fixed;
  z-index: 9999;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text);
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgb(0 0 0 / 30%);
}

@media (max-width: 1280px) {
  /* 两张卡并排时每张只剩 700 上下，时段矩阵会挤成 14px 的小点，不如各占一行 */
  .heatmap-insights,
  .heatmap-investment {
    grid-template-columns: 1fr;
  }

  /* 上排已经各占一行，就没有分栏边界要对齐了；下排这时均分更划得来——
     3:2 会把「贡献者排行」压到 400 上下，名称列固定 152px 之后条形只剩 110px，
     几条几乎一样长的绿条就没法比较了。 */
  .heatmap-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .heatmap-stats {
    grid-template-columns: repeat(2, 1fr);
  }

  /* 一行放不下「折合… · N 个日子 · 总工时…」，让它落到大数字下面 */
  .overtime-figure p,
  .volume-figure p {
    margin-left: 0;
  }

  .heatmap-columns {
    grid-template-columns: 1fr;
  }

  .hours-body {
    flex-direction: column;
    align-items: stretch;
    gap: 20px;
  }

  .hours-stats {
    max-width: none;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
}

@media (max-width: 520px) {
  .heatmap-stats {
    grid-template-columns: 1fr;
  }

  .ranking-item {
    grid-template-columns: 92px 1fr 64px;
  }

  .hours-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .freshness-row {
    grid-template-columns: 68px minmax(0, 1fr) 32px;
  }
}
</style>
