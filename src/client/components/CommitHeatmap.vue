<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CommitCodeVolumeSummary, CommitHeatmapData, CommitOvertimeSummary } from '../../shared/contracts';
import { Activity, AlertTriangle, BarChart3, CalendarDays, Clock3, FileDiff, Flame, FolderGit2, GitCommit, MoonStar, TrendingUp, Users } from 'lucide-vue-next';
import {
  MINUTES_PER_WORKDAY,
  RESTART_GAP_MINUTES,
  SEGMENT_CONTEXT_MINUTES,
  SEGMENT_GAP_MINUTES,
  formatWorkdayWindow,
} from '../../shared/work-window';
import {
  analyticsRangeLabel,
  analyticsRangeOptions,
  localIsoDate,
  reportWindow,
} from '../../shared/report-window';
import {
  bucketRepositoryFreshness,
  buildHeatmapWeeksForWindow,
  countRepositoriesActiveSince,
  heatmapLevel,
  summarizeHeatmapWindow,
  summarizeHourly,
} from '../heatmap-grid';
import { formatHours, formatWorkdays, isZeroHours, overtimeParts } from '../overtime-presentation';
import { formatLines, totalLines, volumeBreakdown, volumeParts } from '../volume-presentation';

const props = defineProps<{
  data: CommitHeatmapData | null;
  /** 所选时间段（周数）。默认近一年，由 App 持久化。 */
  weeks: number;
  loading: boolean;
  /** 换时间段时的后台请求：保留旧数据，只淡一层，避免整页闪成骨架 */
  refreshing?: boolean;
  /** 请求失败时的可读原因；有值就显示错误态而不是「暂无数据」 */
  error: string | null;
}>();

const emit = defineEmits<{ retry: []; 'update:weeks': [weeks: number] }>();

/** 时间段预设。标签和周数同源（shared/report-window.ts），不在这里另写一份。 */
const rangeOptions = analyticsRangeOptions;

function selectRange(weeks: number): void {
  if (weeks === props.weeks) return;
  emit('update:weeks', weeks);
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
  const window = reportWindow(new Date(), props.weeks);
  return {
    weeks: props.weeks,
    label: analyticsRangeLabel(props.weeks),
    start: window.start,
    end: window.end,
  };
});

const rangeLabel = computed(() => activeRange.value.label);
const rangeDates = computed(() => `${activeRange.value.start} ~ ${activeRange.value.end}`);

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

const monthLabels = computed(() => {
  const labels: { index: number; label: string }[] = [];
  const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  let lastMonth = -1;
  let lastIndex = -10;

  gridWeeks.value.forEach((week, weekIndex) => {
    const midDay = week[3]; // 周四代表这周，避免跨月周被算到上一月
    if (!midDay) return;
    // 直接拆字符串，别用 new Date(iso)：ISO 日期会被当成 UTC 解析，西半球会错月。
    const month = Number(midDay.date.slice(5, 7)) - 1;
    if (month === lastMonth) return;
    lastMonth = month;
    // 太挤的两个月只保留前一个，否则标签会叠在一起
    if (weekIndex - lastIndex < 3) return;
    labels.push({ index: weekIndex, label: months[month] });
    lastIndex = weekIndex;
  });
  return labels;
});

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
const unreadable = computed(() => props.data?.summary.unreadable ?? { count: 0, names: [] });

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
 */
type RankingMetric = 'commits' | 'volume';

const rankingMetric = ref<RankingMetric>('commits');

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
  rankingMetric.value === 'commits'
    ? `${rangeLabel.value} · 非合并提交数`
    : `${rangeLabel.value} · 新增 + 删除行数`,
);

function rankDisplay(value: number): string {
  return rankingMetric.value === 'commits' ? value.toLocaleString() : formatLines(value);
}

/** 排行榜按榜首归一化：按「占总提交数」算的话，20 个仓库时每条都只有几个像素。 */
function barWidth(value: number, leader: number): string {
  if (leader <= 0) return '0%';
  return `${Math.max((value / leader) * 100, 1.5)}%`;
}

const repoRows = computed<RankingRow[]>(() => {
  const repos = props.data?.byRepo ?? [];
  const byVolume = rankingMetric.value === 'volume';
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
  const byVolume = rankingMetric.value === 'volume';
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
/**
 * 绿红交界的位置，交给条本身那一条渐变去画。
 *
 * 原来这条是两段 flex 子元素拼的：绿段一个矩形、红段一个矩形，交界处是两条边
 * 各自栅格化的结果。两者的横向起点只要差零点几个设备像素，接缝处就会出现
 * 一列半透明像素或一格台阶——而且随缩放、DPR、是否走合成层而变，
 * 用截图量不出来、换台机器又能看见。一次绘制就没有「两条边」这回事。
 */
const volumeAdditionsCut = computed(() => `${volumePartsView.value[0]?.share ?? 0}%`);
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
 * 渲染宽度的上下界。
 *
 * 上界是「格子最多 18px」：近 3 个月只有 14 列，若按 100% 宽铺满，一格会涨到
 * 60px 以上，像一排按钮而不是热力图。
 * 下界是「格子至少 9px」：近两年 105 列在常见窗口宽度下靠等比缩小就能整屏放下
 * （不滚动才能一眼看完整段趋势）；只有窗口窄到连 9px 都给不出时才横向滚动。
 */
const chartMaxWidth = computed(() => Math.round(chartWidth.value * 1.5));
const chartMinWidth = computed(() => Math.round(gridLeft + gridWeeks.value.length * (minRenderedCell + cellGap) + 14));
</script>

<template>
  <div class="commit-heatmap" @mouseleave="hideTooltip">
    <!-- 时间段：整页唯一的范围开关。放在状态分支之外，切换范围时不会跟着消失 -->
    <div class="range-toolbar">
      <div class="range-switch" role="group" aria-label="统计时间段">
        <button
          v-for="option in rangeOptions"
          :key="option.weeks"
          type="button"
          :class="{ active: option.weeks === weeks }"
          :aria-pressed="option.weeks === weeks"
          :data-weeks="option.weeks"
          @click="selectRange(option.weeks)"
        >{{ option.label }}</button>
      </div>
      <span class="range-dates">{{ rangeDates }}</span>
      <span v-if="refreshing" class="range-refreshing" role="status">统计中…</span>
    </div>

    <!-- 加载态 -->
    <div v-if="loading" class="heatmap-state">
      <div class="heatmap-spinner" />
      <p>正在分析所有仓库的提交历史…</p>
    </div>

    <!-- 错误态：不能退化成「暂无数据」，否则用户会以为仓库真的没有提交 -->
    <div v-else-if="error" class="heatmap-state heatmap-error">
      <AlertTriangle :size="44" />
      <p>分析数据加载失败</p>
      <span>{{ error }}</span>
      <button class="secondary-button" @click="emit('retry')">重新加载</button>
    </div>

    <!-- 空态 -->
    <div v-else-if="!data || data.summary.activeRepos === 0" class="heatmap-state">
      <AlertTriangle v-if="allUnreadable" :size="44" />
      <BarChart3 v-else :size="44" />
      <p>{{ emptyTitle }}</p>
      <span>{{ emptyHint }}</span>
    </div>

    <template v-else>
      <!-- 热力图作为页面主体，放在最上面 -->
      <section class="heatmap-section">
        <header class="heatmap-header">
          <div>
            <h2><Flame :size="18" />提交热力图</h2>
            <p class="heatmap-subtitle">{{ rangeLabel }} · {{ caption || '暂无提交' }}</p>
          </div>
          <div class="heatmap-legend" aria-hidden="true">
            <span>少</span>
            <i v-for="color in levelColors" :key="color" :style="{ background: color }" />
            <span>多</span>
          </div>
        </header>

        <div class="heatmap-viewport">
        <svg
          :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
          class="heatmap-svg"
          :style="{ maxWidth: chartMaxWidth + 'px', minWidth: chartMinWidth + 'px' }"
          role="img"
          :aria-label="`${rangeLabel}共 ${windowStats.commits} 次提交的热力图`"
          @mousemove="moveTooltip"
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
                v-if="day.elapsed"
                :x="weekIndex * (cellSize + cellGap) + gridLeft"
                :y="dayIndex * (cellSize + cellGap) + gridTop"
                :width="cellSize"
                :height="cellSize"
                :fill="cellColor(day.count)"
                :data-count="day.count"
                :data-date="day.date"
                rx="2"
                ry="2"
                class="heatmap-cell"
                @mouseenter="showTooltip($event, day.date, day.count)"
              />
            </template>
          </g>
        </svg>
        </div>
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
              · 涉及 {{ overtime.activeDays }} 天
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
          <div
            class="volume-bar"
            aria-hidden="true"
            :data-empty="volumeTotal === 0 ? 'true' : undefined"
            :style="{ '--volume-additions-cut': volumeAdditionsCut }"
          />
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
              > 等</template>（目录不可访问或不是 Git 仓库）
            </span>
          </p>
        </section>
      </div>

      <div class="heatmap-columns">
        <!-- 仓库排行 -->
        <section class="heatmap-ranking">
          <header class="ranking-header">
            <h3><FolderGit2 :size="16" />仓库排行</h3>
            <div class="ranking-switch" role="group" aria-label="仓库排行度量">
              <button
                type="button"
                :class="{ active: rankingMetric === 'commits' }"
                :aria-pressed="rankingMetric === 'commits'"
                data-metric="commits"
                @click="rankingMetric = 'commits'"
              >提交数</button>
              <button
                type="button"
                :class="{ active: rankingMetric === 'volume' }"
                :aria-pressed="rankingMetric === 'volume'"
                data-metric="volume"
                @click="rankingMetric = 'volume'"
              >增删行</button>
            </div>
          </header>
          <p class="ranking-hint">{{ rankingHint }}</p>
          <div class="ranking-list">
            <div v-for="row in repoRows" :key="row.key" class="ranking-item" :data-metric="rankingMetric">
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
            <div class="ranking-switch" role="group" aria-label="贡献者排行度量">
              <button
                type="button"
                :class="{ active: rankingMetric === 'commits' }"
                :aria-pressed="rankingMetric === 'commits'"
                data-metric="commits"
                @click="rankingMetric = 'commits'"
              >提交数</button>
              <button
                type="button"
                :class="{ active: rankingMetric === 'volume' }"
                :aria-pressed="rankingMetric === 'volume'"
                data-metric="volume"
                @click="rankingMetric = 'volume'"
              >增删行</button>
            </div>
          </header>
          <p class="ranking-hint">{{ rankingHint }}</p>
          <div class="ranking-list">
            <div v-for="row in authorRows" :key="row.key" class="ranking-item" :data-metric="rankingMetric">
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
  margin-bottom: 18px;
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

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  padding-top: 2px;
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

/* 时间段：整页唯一的范围开关，所以放在最外层卡片之外，视觉上属于页面而不是某张卡 */
.range-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 14px;
}

.range-switch {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--color-surface-hover);
}

.range-switch button {
  border: 0;
  padding: 4px 10px;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}

.range-switch button:hover:not(.active) {
  color: var(--color-text);
}

.range-switch button.active {
  background: var(--color-surface-raised);
  color: var(--color-text-strong);
}

.range-switch button:focus-visible {
  outline: 2px solid var(--color-success);
  outline-offset: 1px;
}

/* 具体到哪一天也写出来：只写「近一年」时，读者没法确认「一年」是从今天往前
   推 365 天，还是按自然周对齐——这两种算法能差出一周。 */
.range-dates {
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.range-refreshing {
  font-size: 11px;
  color: var(--color-text-muted);
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

/* 渐变停点默认不能过渡（自定义属性被当成 <string>），注册成 <percentage>
   才能像原来的 width 一样平滑长出来。不支持 @property 的浏览器只是没有过渡，
   颜色与比例照样正确。 */
@property --volume-additions-cut {
  syntax: '<percentage>';
  inherits: false;
  initial-value: 0%;
}

/* 增删沿用 diff 的通用约定：绿的进、红的出。别用品牌色，
   这两个数字的量级差一眼要能看出来。

   重点是一次画完：绿红交界只由渐变的停点决定。原来两段是两个 flex 子元素，
   接缝处是两条边各自栅格化的结果——横向起点差半个设备像素，就会在交界处
   露出一格台阶或一列半透明像素，而且随缩放、DPR、是否走合成层而变。 */
.volume-bar {
  transition: --volume-additions-cut 0.4s ease;
  background: linear-gradient(
    to right,
    var(--color-success) 0 var(--volume-additions-cut, 0%),
    var(--color-red) var(--volume-additions-cut, 0%) 100%
  );
}

/* 没有任何增删行时，整条退到底色，别让「全红」冒充「删除占满」 */
.volume-bar[data-empty='true'] {
  background: var(--color-surface-hover);
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
  background: var(--color-red);
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

/* 排行度量切换：两张卡各自带一个，但绑的是同一个状态，
   切哪边都是整页换度量——不然「仓库按代码量、作者按提交数」并排看会误读 */
.ranking-switch {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--color-surface-hover);
}

.ranking-switch button {
  border: 0;
  padding: 3px 8px;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}

.ranking-switch button.active {
  background: var(--color-surface-raised);
  color: var(--color-text-strong);
}

.ranking-switch button:focus-visible {
  outline: 2px solid var(--color-success);
  outline-offset: 1px;
}

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
