<script setup lang="ts">
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowLeftRight,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardPaste,
  Clock3,
  Cloud,
  CloudDownload,
  CloudOff,
  Code2,
    Copy,
    Download,
    ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  FolderGit2,
  GitBranch,
  GitMerge,
  Github,
  History,
  Keyboard,
  Link2,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  PackageOpen,
  Palette,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  UserRound,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type {
  AiCommitRepositoryPolicy,
  AutoFetchIntervalMinutes,
  BatchOperationType,
  BatchMergeBranchesPlan,
  BatchMergeTargets,
  BatchPullBranchMode,
  BatchPullBranchesPlan,
  BatchPullBranchTargets,
  BatchPushBranchMode,
  BatchPushBranchesPlan,
  BatchPushBranchTargets,
  BranchesSnapshot,
  BranchDeletionPreview,
  ConflictResolutionStrategy,
  DashboardPayload,
  FileChange,
  IgnoreFileRules,
  IgnoreRuleLine,
    IgnoreTarget,
    IgnoredEntry,
    LastCommitSnapshot,
    MarkedFile,
  MergePreview,
  MergePreviewRequest,
  MergeSource,
  OperationRecord,
  OperationState,
  OperationType,
  ProfileConfig,
  ProfileViewPreferences,
  PushBranchesPlan,
  PushBranchesResult,
  RemoteBranch,
  RemoteCredentialHost,
  RemoteCredentialOverview,
  ReleaseCheckResult,
  RepositoryFilterMode,
    RepositoryCapabilities,
    RepositoryRemote,
    RepositoryRemoteMutation,
    RepositoryStatus,
  RetryableOperationType,
  ScanCandidate,
  StashEntry,
  TagEntry,
  UpstreamRepairPlan,
  UpstreamRepairRequest,
} from '../shared/contracts';
import { compareRepositoryActivity, compareRepositoryLastCommit, compareRepositoryPinning } from '../shared/repository-pinning';
import {
  analyticsRangeKey,
  defaultAnalyticsRange,
  defaultAnalyticsWeeks,
  rangeMatchesSelection,
  readStoredAnalyticsRange,
  resolveAnalyticsRange,
  sameAnalyticsRange,
  type AnalyticsRange,
} from '../shared/report-window';
import { api, ApiError } from './api';
import type { FeedbackThread } from './api';
import { defaultCodeFont, defaultDarkTheme, defaultInterfaceFont, defaultInterfaceFontSize, maxStashFileSelection, mergePausedErrorCode, type DarkTheme } from '../shared/contracts';
import { isSafeRemoteName } from '../shared/remote-name';
import { isUncommittedNewFile } from '../shared/file-status';
import {
  convertRemoteUrl,
  normalizeRemoteUrlInput,
  parseRemoteTarget,
  parseRemoteUrl,
  protocolLabel,
  suggestedDirectoryName,
  type RemoteProtocol,
} from '../shared/remote-url';
import { autoFetchDelayMs, autoFetchIntervalLabel, autoFetchIntervals, autoFetchRemainingLabel, isAutoFetchDue, latestFetchBatchAt, parseLastAutoFetchAt } from './auto-fetch';
import { batchRetryConfirmationDetails, batchSignalAriaLabel, retryableBatchRepositoryIds } from './batch-retry';
import { branchDivergenceLabel, compareBranchNames } from './branch-presentation';
import { presentGitDiff } from './diff-presentation';
import {
  activeFocusLayer,
  focusInitialControl,
  focusReturnFallback,
  isEditableTarget,
  trapDialogFocus,
} from './dialog-focus';
import {
  buildOperationHistoryItems,
  isOperationIssue,
  isOperationRetryable,
  operationCredentialHost,
  operationsRefetchInterval,
} from './operation-history';
import {
  batchTypeLabel,
  formatDuration,
  initials,
  operationStateLabel,
  operationTypeLabel,
  statusMeta,
  upstreamCandidateDivergence,
  upstreamCandidateReason,
} from './presentation';
import {
  aiCommitModeOptions,
  aiCommitPolicyOptions,
  commitLanguageOptions,
  operationStateOptions,
  operationTypeOptions,
  type SelectMenuOption,
  sortModeOptions,
} from './select-options';
import { relativeTime as sharedRelativeTime } from './relative-time';
import { remoteLinks } from './remote-links';
import {
  batchEligibleRepositoryCount,
  batchPlanDetails,
  fetchAvailability as repositoryFetchAvailability,
  pullAvailability as repositoryPullAvailability,
  pushAvailability as repositoryPushAvailability,
  syncAvailability as repositorySyncAvailability,
} from './repository-action-availability';
import { rootNameFromPath } from './root-identity';
import { appVersion } from './app-version';
import { isNewerVersion } from '../shared/version';
import { releasesUrl, repositoryUrl } from '../shared/app-links';
import { cloneAuthState as detectCloneAuth, cleanCloneError, cloneFailureHint } from './clone-auth';
import { cloneProgressText, cloneProgressWidth as cloneProgressWidthOf } from './clone-progress';
import { useNotices, type NoticeOwner, type NoticeSeverity } from './notices';
import { copyText } from './clipboard';
import { useScrollLock } from './scroll-lock';
import { confirmationBlocked, confirmationInputError, useConfirmation, type ConfirmationCheckbox, type ConfirmationInput, type ConfirmationOptions } from './use-confirmation';
import { provideFileListView, type FileListView } from './file-list-view';
import { useOperationsStream } from './use-operations-stream';
import { replaceDashboardRepository } from './dashboard-cache';
import { fetchBatchResultMessage } from '../shared/fetch-result';
import {
  hasLatestReleaseTag,
  hasWorktreeChanges,
  isMissingRepository,
  isRemoteStale,
  matchesRepositoryStateFilter,
  needsDailyAction,
  repositoryFilterCounts,
  worktreeChangeCount,
} from './repository-signals';
import { defaultViewPreferences, parseViewPreferences } from './view-preferences';
import { codeFontFamilies, codeFontOptions, codeFontSizeOptions, interfaceFontFamilies, interfaceFontOptions, interfaceFontSizeOptions, applyTheme, cacheTheme, readCachedTheme, themeOptions } from './appearance';
import { vBackdropClose } from './backdrop-close';
import { hasActiveSelectionWithin } from './click-guard';
import SelectMenu from './components/SelectMenu.vue';
import SurfaceNotice from './components/SurfaceNotice.vue';
import RepositoryWorkspace from './components/RepositoryWorkspace.vue';
import BranchMergeDialog from './components/BranchMergeDialog.vue';
import BatchPushBranchesDialog from './components/BatchPushBranchesDialog.vue';
import BatchMergeDialog from './components/BatchMergeDialog.vue';
import BatchPullDialog from './components/BatchPullDialog.vue';
import PushBranchesDialog from './components/PushBranchesDialog.vue';
import UpdateDownloadControl from './components/UpdateDownloadControl.vue';
import ConfigurationTransfer from './components/ConfigurationTransfer.vue';
import CommitComposer from './components/CommitComposer.vue';
import CommitHeatmap from './components/CommitHeatmap.vue';
import type { AnalyticsRepositoryScope, CloneProgress, ConfigurationAppearance } from '../shared/contracts';
import { normalizeAnalyticsRepositoryScope, readStoredAnalyticsRepositoryScope, sameAnalyticsRepositoryScope } from '../shared/analytics-scope';
import { useCommitComposer } from './use-commit-composer';
import { useRepositoryDiff } from './use-repository-diff';
import type { DiffKind, FileMenuAction } from './repository-workspace';
import { defaultRankingMetric, normalizeRankingMetric, type RankingMetric } from './ranking-metric';
import SessionRelay from './components/SessionRelay.vue';
import { createForegroundLoad } from './foreground-load';
import { createLatestSave } from './latest-save';

const queryClient = useQueryClient();
type SessionRelayHandle = { syncSessions: () => void; focusSearch: () => void; focusList: () => void; refresh: () => void };
const activeWorkspace = ref<'repositories' | 'sessions' | 'analytics'>('repositories');
const sessionRelay = ref<SessionRelayHandle | null>(null);
const sessionSyncBusy = ref(false);
const sessionWaitingCount = ref(0);
// 事件流先建：`operationsQuery` 的轮询间隔要读它的连接状态。
// 回调里引用的 `operationsQuery` 声明在后面，但只在事件到达时才会执行，不存在初始化顺序问题。
const {
  connected: operationsStreamConnected,
  connect: connectOperationsStream,
  disconnect: disconnectOperationsStream,
} = useOperationsStream({
  applyPayload: (payload) => queryClient.setQueryData(['operations'], payload),
  refetch: () => { void operationsQuery.refetch(); },
});
let autoFetchTimer: number | null = null;
/** 已发起、还没看到结果的后台 Fetch 批次；用来识别「这轮被用户操作挤掉了」。 */
let autoFetchBatchId: string | null = null;
/** 被挤掉后要不要补跑，以及补跑的时间点——让路不该等于「这半小时都不再刷新」。 */
let autoFetchRetryPending = false;
let autoFetchRetryAt = 0;
/**
 * 被让路后的补跑退避：先 20 秒就回来，连着被挤掉才逐步退到 2 分钟。
 *
 * 固定 2 分钟的问题是「用户刚推完代码，列表还得旧两分钟」——而被挤掉一次本来只说明
 * 那一刻有冲突，不代表接下来两分钟都不能碰。
 */
const autoFetchRetryDelays = [20_000, 45_000, 90_000, 120_000];
let autoFetchRetryStep = 0;
/** 设置页与按钮提示里的倒计时需要一个时间源，否则文案永远停在打开弹窗那一刻。 */
const autoFetchClock = ref(Date.now());
let autoFetchClockTimer: number | null = null;
const autoFetchClockTickMs = 15_000;
let scrollbarVisibilityTimer: number | null = null;
let repositoryFilesRequest = 0;
let repositoryStashesRequest = 0;
let repositoryTagsRequest = 0;
let repositoryBranchesRequest = 0;
let repositoryContextVersion = 0;
/**
 * 四个只读清单的加载态闸门。
 *
 * 收尾不能只看 `requestId === xxxRequest`：后台静默刷新也会推进同一条序号，前台请求
 * 返回时序号已经不匹配，`finally` 被跳过，加载态就永远为真——工作台一直灰，暂存、提交、
 * 切分支全被挡住，而且不给任何提示。闸门按「还有几个前台请求在跑」计数，
 * 与后台刷新解耦。判据见 `foreground-load.ts` 的注释与 `foreground-load.test.ts`。
 */
const filesLoad = createForegroundLoad();
const branchesLoad = createForegroundLoad();
const ignoredLoad = createForegroundLoad();
const markedLoad = createForegroundLoad();
/** 后台 tick 的静默刷新同一时间只跑一次，避免慢请求叠加。 */
let backgroundRefreshInFlight = false;

const query = useQuery({
  queryKey: ['dashboard'],
  queryFn: api.dashboard,
  refetchInterval: 15_000,
  // 轮询已经保证 15 秒一次新鲜数据。默认 staleTime 是 0，于是**文档每次由隐藏转
  // 可见**（隐藏 / 最小化 / 切 Space）都会立刻再全量扫一遍所有仓库（每个仓库 5 个
  // git 子进程，54 个仓库约 400ms）；与热力图同样的取舍：对齐成轮询周期，这段往返
  // 就不再白付。写操作后的刷新走显式 `query.refetch()`，不受 staleTime 影响。
  staleTime: 15_000,
});

const heatmapEnabled = computed(() => activeWorkspace.value === 'analytics');

/**
 * 分析页的时间段：四个预设之一，或用户自选的起止日期。
 *
 * 存在本地而不是 profile 里：它是一次「看一眼」的视角，不是账号偏好——
 * 换台机器打开看到「近一年」是合理的默认值，不需要跟着账号同步。
 *
 * v2 存 JSON（能表达自定义范围），v1 只存了一个周数，读的时候兼容过来。
 */
const analyticsRangeStorageKey = 'moo-fleet:analytics-range:v2';
const analyticsRangeLegacyKey = 'moo-fleet:analytics-range:v1';

function loadAnalyticsRange(): AnalyticsRange {
  try {
    const current = localStorage.getItem(analyticsRangeStorageKey);
    if (current !== null) return readStoredAnalyticsRange(current);
    // 升级到 v2 时把旧的周数接过来，用户看到的还是同一张图
    return readStoredAnalyticsRange(localStorage.getItem(analyticsRangeLegacyKey));
  } catch {
    return defaultAnalyticsRange;
  }
}

const analyticsRange = ref<AnalyticsRange>(loadAnalyticsRange());
const analyticsRepositoryStorageKey = 'moo-fleet:analytics-repositories:v1';
const analyticsScopeHydrated = ref(false);
const analyticsRepositoryScope = ref<AnalyticsRepositoryScope>((() => {
  try { return readStoredAnalyticsRepositoryScope(localStorage.getItem(analyticsRepositoryStorageKey)); }
  catch { return null; }
})());
const analyticsRepositoryOptions = computed<SelectMenuOption[]>(() => (query.data.value?.repositories ?? [])
  .filter((repository) => repository.config.enabled)
  .map((repository) => ({ value: repository.config.id, label: repository.config.name, hint: repository.config.group, keywords: repository.config.path }))
  .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')));

function setAnalyticsRepositoryScope(scope: AnalyticsRepositoryScope): void {
  analyticsRepositoryScope.value = normalizeAnalyticsRepositoryScope(scope);
  try { localStorage.setItem(analyticsRepositoryStorageKey, JSON.stringify(analyticsRepositoryScope.value)); }
  catch { /* 浏览器存储不可用时仍可在当前会话筛选。 */ }
}

// 等真实仓库清单到达后再移除已删除/禁用的 ID，不能用初始空清单清掉本机选择。
watch(analyticsRepositoryOptions, (options) => {
  if (!analyticsScopeHydrated.value || analyticsRepositoryScope.value === null) return;
  const available = new Set(options.map((option) => String(option.value)));
  const next = analyticsRepositoryScope.value.filter((id) => available.has(id));
  if (!sameAnalyticsRepositoryScope(next, analyticsRepositoryScope.value)) setAnalyticsRepositoryScope(next);
});

function setAnalyticsRange(next: AnalyticsRange): void {
  // 统一过一遍解析：填反的日期、超长范围、非法值都在这里收敛成实际会生效的窗口，
  // 以免「界面上选的和服务端算的不一样」。
  const resolved = resolveAnalyticsRange(next.kind === 'preset' ? { weeks: next.weeks } : { start: next.start, end: next.end });
  const applied: AnalyticsRange = resolved.kind === 'preset'
    ? { kind: 'preset', weeks: resolved.weeks ?? defaultAnalyticsWeeks }
    : { kind: 'custom', start: resolved.start, end: resolved.end };
  if (sameAnalyticsRange(applied, analyticsRange.value)) return;
  analyticsRange.value = applied;
  try {
    localStorage.setItem(analyticsRangeStorageKey, JSON.stringify(applied));
  } catch {
    // 浏览器存储不可用时按当前会话生效，不影响统计本身
  }
}

/** 排行榜度量：和时间段、仓库范围一样是「看一眼的视角」，一起存在本机。 */
const analyticsMetricStorageKey = 'moo-fleet:analytics-metric:v1';

function loadAnalyticsMetric(): RankingMetric {
  try {
    return normalizeRankingMetric(localStorage.getItem(analyticsMetricStorageKey));
  } catch {
    return defaultRankingMetric;
  }
}

const analyticsMetric = ref<RankingMetric>(loadAnalyticsMetric());

function setAnalyticsMetric(metric: RankingMetric): void {
  const normalized = normalizeRankingMetric(metric);
  analyticsMetric.value = normalized;
  try {
    localStorage.setItem(analyticsMetricStorageKey, normalized);
  } catch {
    // 浏览器存储不可用时按当前会话生效
  }
}

const heatmapQuery = useQuery({
  // 时间段和仓库范围共同标识数据，切回来可以复用对应范围的结果。
  queryKey: computed(() => ['analytics', 'heatmap', analyticsRangeKey(analyticsRange.value), analyticsRepositoryScope.value]),
  // 首屏只等提交数：代码量没缓存时服务端后台算，先拿回 volumePending
  queryFn: () => api.commitHeatmap(analyticsRange.value, analyticsRepositoryScope.value, { deferVolume: true }),
  enabled: computed(() => heatmapEnabled.value && analyticsScopeHydrated.value),
  refetchInterval: 60_000,
  // 默认 staleTime 是 0，于是**每次切回窗口**都会立刻重算一遍；而这里本来就
  // 每分钟轮询一次。对齐成同一个周期，切窗口就从「必算」变成「最多一分钟一次」。
  staleTime: 60_000,
  // 切换范围期间保留上一份结果，由页面标明仍在切换。
  placeholderData: keepPreviousData,
});
/**
 * 代码量在后台算的时候，隔几秒回来取一次。
 *
 * 不放进 `refetchInterval`：那条是 60 秒的常规轮询，用来发现新提交；这里补的是
 * 「首屏先给了提交数、行数还没算完」这一种临时状态，算完就该停。
 * 上限 6 次（约 15 秒）：58 个仓库的 numstat 合计 15.1 秒，再多就该走常规轮询了。
 */
const volumePollIntervalMs = 2500;
const volumePollMaxAttempts = 6;
let volumePollTimer: ReturnType<typeof setTimeout> | null = null;
let volumePollAttempts = 0;

function stopVolumePolling(): void {
  if (volumePollTimer !== null) clearTimeout(volumePollTimer);
  volumePollTimer = null;
}

function scheduleVolumePoll(): void {
  stopVolumePolling();
  volumePollTimer = setTimeout(() => {
    volumePollTimer = null;
    if (!heatmapQuery.data.value?.volumePending) return;
    if (volumePollAttempts >= volumePollMaxAttempts) return;
    volumePollAttempts += 1;
    void heatmapQuery.refetch();
    scheduleVolumePoll();
  }, volumePollIntervalMs);
}

watch(
  () => heatmapQuery.data.value?.volumePending === true,
  (pending) => {
    if (pending) {
      scheduleVolumePoll();
      return;
    }
    stopVolumePolling();
    volumePollAttempts = 0;
  },
);

onBeforeUnmount(stopVolumePolling);

/** 失败原因要给到页面，否则「请求挂了」和「仓库没有提交」看起来一模一样。 */
const heatmapError = computed(() => {
  const error = heatmapQuery.error.value ?? (!query.data.value ? query.error.value : null);
  if (!error) return null;
  return error instanceof Error && error.message ? error.message : '请稍后重试';
});

/**
 * 是不是真的在「换范围」。
 *
 * 不能直接用 `isFetching`：60 秒一次的轮询也满足它，于是工具栏每分钟闪一下
 * 「统计中…」。判据换成「手上这份数据的窗口和所选的不一样」——只有切范围时成立。
 */
const heatmapSwitching = computed(() => {
  const data = heatmapQuery.data.value;
  return heatmapQuery.isFetching.value && (!data || !rangeMatchesSelection(data.range, analyticsRange.value)
    || !sameAnalyticsRepositoryScope(data.repositoryScope, analyticsRepositoryScope.value));
});

const viewPreferencesStorageKey = 'moo-fleet:view-preferences:v1';
const autoFetchLastRunStorageKey = 'moo-fleet:auto-fetch:last-run:v1';
const autoFetchLeaseStorageKey = 'moo-fleet:auto-fetch:lease:v1';
const autoFetchLockName = 'moo-fleet:auto-fetch';
const autoFetchOwner = crypto.randomUUID();
let lastAutoFetchAtMemory: number | null = null;

function loadCachedViewPreferences(): ProfileViewPreferences {
  try {
    return parseViewPreferences(JSON.parse(localStorage.getItem(viewPreferencesStorageKey) ?? 'null')) ?? defaultViewPreferences;
  } catch {
    return defaultViewPreferences;
  }
}

function cacheViewPreferences(preferences: ProfileViewPreferences): void {
  try {
    localStorage.setItem(viewPreferencesStorageKey, JSON.stringify(preferences));
  } catch {
    // Profile persistence remains authoritative when browser storage is unavailable.
  }
}

const cachedViewPreferences = loadCachedViewPreferences();
const interfaceFont = ref(cachedViewPreferences.interfaceFont ?? defaultInterfaceFont);
const interfaceFontSize = ref(cachedViewPreferences.interfaceFontSize ?? defaultInterfaceFontSize);
const codeFont = ref(cachedViewPreferences.codeFont ?? defaultCodeFont);
const codeFontSize = ref<number | null>(cachedViewPreferences.codeFontSize ?? null);
/** 文件清单的平铺 / 树形偏好；工作区中栏与各处提交文件清单共用（见 file-list-view.ts）。 */
const fileListView = ref<FileListView>(cachedViewPreferences.fileListView ?? 'tree');
provideFileListView({ view: fileListView, set: (next) => { fileListView.value = next; } });
watch([interfaceFont, interfaceFontSize, codeFont, codeFontSize], () => {
  document.documentElement.style.setProperty('--ui-font-family', interfaceFontFamilies[interfaceFont.value]);
  document.documentElement.style.setProperty('--ui-font-size', `${interfaceFontSize.value}px`);
  document.documentElement.style.setProperty('--code-font-family', codeFontFamilies[codeFont.value]);
  // 未指定代码字号时移除变量，让 CSS 里那套 clamp 兜底（跟随界面字号）。
  if (codeFontSize.value === null) document.documentElement.style.removeProperty('--code-font-size');
  else document.documentElement.style.setProperty('--code-font-size', `${codeFontSize.value}px`);
}, { immediate: true });

const operationsQuery = useQuery({
  queryKey: ['operations'],
  queryFn: api.operations,
  refetchInterval: (operationQuery) => operationsRefetchInterval(
    operationsStreamConnected.value,
    operationQuery.state.data?.batches.some((batch) => batch.state === 'running') ?? false,
  ),
});

const search = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
const sortMode = ref(cachedViewPreferences.repositorySort);
const stateFilter = ref<RepositoryFilterMode>(cachedViewPreferences.repositoryFilter);
const groupFilter = ref<string | null>(cachedViewPreferences.repositoryGroup);
const operationRepositoryFilter = ref('all');
const operationTypeFilter = ref<'all' | OperationType>('all');
const operationStateFilter = ref<'all' | OperationState>('all');
const operationNeedsAttentionOnly = ref(false);
const expandedSuccessfulFetchBatchIds = ref<Set<string>>(new Set());
const operationRetryId = ref<string | null>(null);
const operationRefreshBusy = ref(false);
const dashboardRefreshBusy = ref(false);
const analyticsManualRefreshing = ref(false);
/**
 * 分析页刷新按钮的忙态。
 *
 * 这里有两种「正在取数」，不是一件事：
 * - `heatmapSwitching`：用户换了范围或仓库范围，手上这份数据已经不是他要的那份；
 * - `analyticsManualRefreshing`：用户自己点了刷新。
 *
 * 原先直接用 `heatmapQuery.isFetching`，把 60 秒一次的轮询也算进去了，于是按钮每分钟
 * 自己灰一次、转一圈，那段时间点击无效。换成只看切换又会漏掉主动刷新这一次——按钮
 * 不灰就能连点，每次都中断上一次重新发。所以两者分开表达，再取并集。
 */
const analyticsRefreshBusy = computed(() => heatmapSwitching.value || analyticsManualRefreshing.value);
const shortcutHelpOpen = ref(false);
const manageOpen = ref(false);
const manageSection = ref<ManageSection>('profile');
const managePane = ref<HTMLElement | null>(null);
const historyOpen = ref(false);
const selectedRepository = ref<RepositoryStatus | null>(null);
watch(() => Boolean(selectedRepository.value), (open, wasOpen) => {
  if (open && !wasOpen) {
    // Preserve the background width while the full-window workspace covers the root gutter.
    // 必须先量再切 workspace-open：切了以后根占位消失，body 宽度就变了。
    document.documentElement.style.setProperty('--fleet-page-gutter', `${window.innerWidth - document.body.getBoundingClientRect().width}px`);
  } else if (!open) {
    document.documentElement.style.removeProperty('--fleet-page-gutter');
  }
  // 详情铺满窗口时由这个 class 取消根占位并补偿背景宽度；和滚动锁一样不依赖 :has()。
  document.documentElement.classList.toggle('workspace-open', open);
}, { flush: 'sync', immediate: true });
const scanRootId = ref('');
const scanCandidates = ref<ScanCandidate[]>([]);
const scanning = ref(false);
const directoryPicking = ref(false);
const savingProfile = ref(false);
const deepSeekApiKey = ref('');
const deepSeekApiKeyVisible = ref(false);
const loadingDeepSeekApiKey = ref(false);
const savingDeepSeekApiKey = ref(false);
const credentialOverview = ref<RemoteCredentialOverview | null>(null);
const credentialsLoading = ref(false);
const credentialsReloadPending = ref(false);
const credentialSaving = ref(false);
const credentialSecretVisible = ref(false);
const credentialRemoving = ref<string | null>(null);
const credentialHostInput = ref<HTMLInputElement | null>(null);
const credentialUsernameInput = ref<HTMLInputElement | null>(null);
const credentialForm = reactive({ host: '', username: '', secret: '' });
/** 正在切换远端协议的仓库 id；批量时用主机键。 */
const remoteProtocolBusy = ref<string | null>(null);
/** 展开查看逐仓切换的主机键集合（`protocol://host`）。 */
const expandedCredentialHosts = ref<Set<string>>(new Set());
/**
 * —— 远端管理 ——
 *
 * 远端列表**按需拉取**（展开某个仓库时才取），不进仪表盘负载：
 * 一次 `git remote -v` 每个仓库一个进程，放进每次扫描会把仪表盘拖慢，
 * 而远端管理是低频操作。
 */
const expandedRemoteRepositories = ref<Set<string>>(new Set());
const repositoryRemotes = ref<Map<string, RepositoryRemote[]>>(new Map());
const remotesLoading = ref<string | null>(null);
/** 舰队配置里的默认远端名；其余远端改了不影响 fetch / pull / push。 */
const remoteDefaultName = ref('origin');
/**
 * 「添加远端」表单归属的仓库 id（null = 未打开），以及表单内容。
 * 拆成两个是因为模板里的 v-model 需要一个稳定的可写对象，
 * 用「可能为 null 的整对象」会到处需要非空断言。
 */
const remoteAddFor = ref<string | null>(null);
const remoteAddForm = reactive({ name: '', url: '' });
/** 正在写入远端的键：`<仓库 id>:<远端名|add>`。 */
const remoteBusy = ref<string | null>(null);
const addingPath = ref<string | null>(null);
const rootBusy = ref<string | null>(null);
const repositoryEdit = ref<{
  id: string;
  name: string;
  group: string;
  tags: string;
  aiCommitPolicy: AiCommitRepositoryPolicy;
  capabilities: RepositoryCapabilities;
} | null>(null);
const repositoryEditSnapshot = ref('');
const repositoryEditBusy = ref(false);
const pinBusyId = ref<string | null>(null);
const repositoryAction = ref<'fetch' | 'pull' | 'sync' | 'push' | null>(null);
type UpstreamRepairDialogState = {
  repositoryId: string;
  repositoryName: string;
  plan: UpstreamRepairPlan | null;
  selectedUpstream: string;
  selectedRemote: string;
  error: string;
};
const upstreamRepair = ref<UpstreamRepairDialogState | null>(null);
const upstreamRepairLoading = ref(false);
const upstreamRepairBusy = ref(false);
let upstreamRepairRequest = 0;
const branchPanelOpen = ref(false);
const branchMenuRoot = ref<HTMLElement | null>(null);
const branchMenuPanel = ref<HTMLElement | null>(null);
const branchCreateInput = ref<HTMLInputElement | null>(null);
const branchTrigger = ref<HTMLButtonElement | null>(null);
const branchSnapshot = ref<BranchesSnapshot | null>(null);
const branchesLoading = ref(false);
const branchSwitchBusy = ref<string | null>(null);
const branchCreateName = ref('');
const branchCreateCheckout = ref(true);
const branchRenameTarget = ref<string | null>(null);
const branchRenameName = ref('');
const openBusy = ref<'finder' | 'terminal' | 'vscode' | 'reveal' | 'editor' | null>(null);
/** 「移出工作台」与「清理缺失仓库」都会改工作台配置，各自只允许一次在途请求。 */
const repositoryRemovalBusy = ref(false);
const pruneBusy = ref(false);
const batchStarting = ref<BatchOperationType | null>(null);
const batchRetryBusy = ref(false);
/** 工作集：手动勾选一组仓库做批量。勾选框默认可见，不需要先进「选择模式」。 */
const selectedRepositoryIds = ref<string[]>([]);
const summaryRovingIndex = ref(0);
const repositoryListRegion = ref<HTMLElement | null>(null);
const activeBatchId = ref<string | null>(null);
const repositoryFiles = ref<FileChange[]>([]);
const filesLoading = ref(false);
/**
 * 文件列表读取失败的原因。空态要靠它区分「确实没有改动」和「读不到」——
 * 后者若沿用「工作区干净」，用户会以为没有待提交内容。
 */
const repositoryFilesError = ref('');
const fileActionId = ref<string | null>(null);
const fileDiscardId = ref<string | null>(null);
/** 批量删除未提交文件（移到废纸篓）在途。 */
const fileDiscardBatchBusy = ref(false);
const fileMutationBusy = computed(() => fileActionId.value !== null || fileDiscardId.value !== null || fileDiscardBatchBusy.value);
const repositoryIgnoredFiles = ref<IgnoredEntry[]>([]);
const ignoredTruncated = ref(false);
const ignoredLoading = ref(false);
const showIgnoredFiles = ref(false);
let repositoryIgnoredRequest = 0;
/** 「编辑仓库配置」弹窗里的忽略规则列表（根 `.gitignore` + 本机 `info/exclude`）。 */
const ignoreRules = ref<IgnoreFileRules[]>([]);
const ignoreRulesLoading = ref(false);
const ignoreRuleBusy = ref<string | null>(null);
let repositoryIgnoreRulesRequest = 0;
/** 正在写入忽略规则的文件 id，用于菜单项的忙碌态。 */
const ignoreBusyId = ref<string | null>(null);
/** 被标记 assume-unchanged 的文件；因为 git status 不再显示它们，界面必须有这个只读入口。 */
const markedFiles = ref<MarkedFile[]>([]);
const markedLoading = ref(false);
const showMarkedFiles = ref(false);
let repositoryMarkedRequest = 0;
const assumeBusyId = ref<string | null>(null);
const conflictBusy = ref<string | null>(null);
const operationBusy = ref<'continue' | 'abort' | null>(null);
const conflictedFiles = computed(() => repositoryFiles.value.filter((file) => file.conflicted));
const repositoryStashes = ref<StashEntry[]>([]);
const stashesLoading = ref(false);
const stashBusy = ref<'create' | string | null>(null);
const stashMessage = ref('');
const stashIncludeUntracked = ref(true);
const repositoryTags = ref<TagEntry[]>([]);
/**
 * 远端标签名。`remoteTagsKnown` 为 false 表示这次没读到（没有远端 / 离线 / 认证失败），
 * 此时不能据此判断标签是否存在，按钮保持可用，由服务端给出准确原因。
 */
const remoteTagNames = ref<Set<string>>(new Set());
const remoteTagsKnown = ref(false);
const tagsLoading = ref(false);
/** 正在处理中的 Tag 名（创建时用 `create:<name>`）。 */
const tagBusy = ref<string | null>(null);
const tagForm = reactive({ name: '', message: '', push: false });
const commitBusy = ref(false);
/**
 * 历史改写（修正 / 撤销上次提交）的可行性快照。
 *
 * 由服务端给出「上次提交是否已推送、是否有更早的提交、当前可否改写」以及 HEAD 指纹，
 * 前端只负责照它渲染——按钮可用性不在前端另立判断，避免两边口径分叉。
 */
const lastCommitSnapshot = ref<LastCommitSnapshot | null>(null);
const rewriteBusy = ref<'amend' | 'undo' | null>(null);
/**
 * 正在应用历史提交（回退 / 拣选）。与历史改写分开，因为两者的忙碌入口不同。
 *
 * 声明必须排在 `workspaceBusy` / `stageLocked` 之前：那两个 computed 会被 setup 期
 * 的其它 computed（`composer.paused`）触发求值，声明在后面就是 TDZ 报错，
 * 整个界面起不来——不是「少挡一个忙态」那么轻。
 */
const replayBusy = ref<'revert' | 'cherry-pick' | null>(null);
const hunkActionBusy = ref<number | null>(null);
const repositoryWorkspace = ref<{ focusSearch: () => void; showWorking: () => void; showCurrentBranch: () => void } | null>(null);
const workspaceRefreshing = ref(false);
const branchMerge = ref<{ repositoryId: string; input: MergePreviewRequest; preview: MergePreview | null; loading: boolean; error: string } | null>(null);
/**
 * 多分支推送窗口（dev + main / dev + master）。
 *
 * `initial` 是上次为这个仓库选过、这次仍可推的分支，用来把「每次都勾同样两个」
 * 变成一次点击。它存在本地而不是仓库配置里：这是操作习惯，不是仓库属性，
 * 换台机器重新勾一次也无所谓，不值得为它改配置 schema。
 */
const pushBranches = ref<{
  repositoryId: string;
  plan: PushBranchesPlan | null;
  loading: boolean;
  error: string;
  initial: string[];
  result: PushBranchesResult | null;
} | null>(null);
const pushBranchesBusy = ref(false);
/**
 * 工作台的批量多分支推送窗口。
 *
 * 与单仓版本分开存：它属于工作台（没有选中仓库），确认后进批次队列，
 * 结果落在操作记录抽屉里，而不是回填到弹窗里。
 */
const batchPushBranches = ref<{
  repositoryIds: string[];
  modes: BatchPushBranchMode[];
  plan: BatchPushBranchesPlan | null;
  loading: boolean;
  error: string;
} | null>(null);
const batchPushBranchesBusy = ref(false);
/**
 * 工作台的「双线合并」窗口。
 *
 * 与推送窗口分开存：它要切分支、会留下 merge 提交，所以确认前必须让用户看到
 * 「每个仓哪几条分支合到哪条线」，而不是只报一个总数。
 */
const batchMerge = ref<{
  repositoryIds: string[];
  plan: BatchMergeBranchesPlan | null;
  loading: boolean;
  error: string;
} | null>(null);
const batchMergeBusy = ref(false);
/**
 * 工作台的「批量拉取多个分支」窗口。
 *
 * 与普通批量 Pull 分开：它一次要更新「当前分支 + dev + 主分支」，非当前分支只把本地
 * ref 快进到远端、不切分支，所以确认前必须让用户看到每个仓哪几条分支落后、哪几条被跳过。
 * 结果同样进批次队列、落在操作记录抽屉里。
 */
const batchPull = ref<{
  repositoryIds: string[];
  modes: BatchPullBranchMode[];
  plan: BatchPullBranchesPlan | null;
  loading: boolean;
  error: string;
} | null>(null);
const batchPullBusy = ref(false);
/** 单仓多分支操作已入队、正在等批次完成并刷新：期间禁用该仓操作按钮，避免重复触发。 */
const repositorySettling = ref(false);
const workspaceBusy = computed(() => repositorySettling.value || fileMutationBusy.value || hunkActionBusy.value !== null || branchSwitchBusy.value !== null || repositoryAction.value !== null || conflictBusy.value !== null || operationBusy.value !== null || stashBusy.value !== null || commitBusy.value || tagBusy.value !== null || rewriteBusy.value !== null || replayBusy.value !== null || pushBranchesBusy.value);
/**
 * 暂存锁：只避开「会改索引或工作区」的操作。
 *
 * 不能直接复用 `workspaceBusy`，它多算了两件事：
 * - 暂存自己：锁住会让连续勾选被静默丢掉（排队执行才对）；
 * - 读提交预览（`composer.reading`）：那是一次只读请求，挡暂存没有意义，
 *   而它恰好发生在每次暂存之后——不排除的话，勾完第一个文件、勾第二个就没反应。
 */
const stageLocked = computed(() => fileDiscardId.value !== null
  || fileDiscardBatchBusy.value
  || hunkActionBusy.value !== null
  || branchSwitchBusy.value !== null
  || repositoryAction.value !== null
  || conflictBusy.value !== null
  || operationBusy.value !== null
  || stashBusy.value !== null
  || commitBusy.value
  || tagBusy.value !== null
  // 修正 / 撤销 / revert / cherry-pick 都会改 HEAD 或索引，漏了它们等于让用户
  // 在 amend 跑到一半时去勾暂存——按钮能点，只换来一句「已有 Git 操作正在执行」。
  || rewriteBusy.value !== null
  || replayBusy.value !== null);
/**
 * 按块暂存按钮的可用性。
 *
 * 同样不能直接用 `workspaceBusy`，但这次要排除的是另一件事：
 * - `hunkActionBusy`：它代表「正在执行的那一块」。把它算进来，整排块按钮会被直接移出
 *   DOM（`hunkActionLabel` 置空），于是 `DiffView` 里那个 `pendingHunkIndex` spinner
 *   永远没机会显示，用户点完一块只看到操作条整体消失两百毫秒再出现。
 * - `composer.reading`：只读的提交预览，每次按块暂存后都会读一次，挡按钮没意义。
 * 其余会改索引/工作区的操作照旧挡住。
 */
const hunkActionBlocked = computed(() => fileMutationBusy.value
  || branchSwitchBusy.value !== null
  || repositoryAction.value !== null
  || conflictBusy.value !== null
  || operationBusy.value !== null
  || stashBusy.value !== null
  || commitBusy.value
  || tagBusy.value !== null
  || workspaceRefreshing.value
  || filesLoading.value
  || diffLoading.value);
const repositoryDiff = useRepositoryDiff({
  repositoryId: () => selectedRepository.value?.config.id ?? null,
  files: repositoryFiles,
  /**
   * 读 diff 的阻塞条件：同样不能用 `workspaceBusy`。
   *
   * 它含「暂存自己」，而暂存恰好发生在用户点文件的瞬间——勾完一个文件马上去看下一个，
   * 那次点击会被 `select()` 直接 return 掉：diff 面板停在旧文件上，没有任何提示，也不会
   * 自己补读（选中项根本没变）。读 diff 是只读的，文件 ID 又是内容寻址的，暂存别的
   * 文件不会让它的 ID 失效，所以只挡真正会改索引/工作区的操作。
   */
  busy: () => stageLocked.value || workspaceRefreshing.value,
  read: api.fileDiff,
});
const { dialog: diffDialog, loading: diffLoading, error: diffError } = repositoryDiff;
const diffPresentation = computed(() => diffDialog.value ? presentGitDiff(diffDialog.value.diff, diffDialog.value.path) : null);
/**
 * 冲突文件、未跟踪文件、被截断的差异与禁用 Stage 的仓库不给按块操作入口。
 *
 * 未跟踪文件也必须排除：它的 diff 是前端按文件内容合成的「纯新增」，而后端按块操作走的是
 * `git diff -- <path>`——未跟踪文件不在其中，取不到 hunk，接口必然回 409
 * 「该文件没有可按块操作的差异」。给一个点了就报错的按钮，比不给按钮更糟。
 */
const diffHunkActionLabel = computed(() => {
  const dialog = diffDialog.value;
  const repository = selectedRepository.value;
  if (!dialog || !repository || !repository.config.capabilities.stage) return undefined;
  const file = repositoryFiles.value.find((item) => item.path === dialog.path);
  // 截断时补丁尾部不完整，按块暂存会漏掉后半段，所以不给入口。
  if (!file || file.conflicted || file.untracked || dialog.truncated) return undefined;
  return dialog.kind === 'unstaged' ? '暂存此块' : '取消暂存此块';
});
const { confirmation, requestConfirmation, settleConfirmation } = useConfirmation();

/**
 * 消息落在哪个容器。
 *
 * 以前是反过来的：先往一个全局变量里塞字符串，再看「此刻开着哪个面板」决定往哪画。
 * 于是同一条消息会在抽屉里出现一次、关掉抽屉又跳到舰队页一次。
 * 现在归属先定，落点跟着归属走，和用户正看着哪个面板无关。
 *
 * `workspace:sessions` / `workspace:analytics` 目前没有产生消息的动作（会话同步的反馈
 * 在 SessionWorkspace 内部）。将来要往里写，必须同时在那两页加上落点，否则消息会静默丢掉。
 */
const activeNoticeOwner = computed<NoticeOwner>(() => {
  if (manageOpen.value) return 'settings';
  const repository = selectedRepository.value;
  if (repository) return `repository:${repository.config.id}`;
  return 'workspace:repositories';
});

const notices = useNotices(() => activeNoticeOwner.value);

/**
 * 旧写法的入口：`actionMessage.value = x` 仍然可用，owner 自动取用户此刻看着的容器。
 *
 * 129 个赋值点因此不必逐个搬，但它们已经不再是「往一个全局变量里塞字符串」。
 * 置空只清本门面负责的那几档——`actionError.value = x` 之后紧跟的
 * `actionMessage.value = ''` 不该把刚写下的错误一起抹掉。
 */
function noticeChannel(severity: NoticeSeverity, clears: readonly NoticeSeverity[]) {
  return {
    get value(): string {
      const notice = notices.noticeFor(activeNoticeOwner.value);
      return notice && clears.includes(notice.severity) ? notice.text : '';
    },
    set value(text: string) {
      if (text) {
        notices.notify(severity, text);
        return;
      }
      const notice = notices.noticeFor(activeNoticeOwner.value);
      if (notice && clears.includes(notice.severity)) notices.dismiss(activeNoticeOwner.value);
    },
  };
}
const actionMessage = noticeChannel('success', ['success', 'warning']);
const actionWarning = noticeChannel('warning', ['warning']);
const actionError = noticeChannel('error', ['error']);

/**
 * 批次跑完的那句结论。
 *
 * 它不走消息通道：批次一开始就把操作记录抽屉推到你面前，序号、成败、进度都在里面，
 * 结论留在那张卡上就是「就地」；再往舰队页丢一条状态行，等于让用户关掉抽屉才看得到结果。
 */
const batchResultMessage = ref('');
const commitComposer = ref<InstanceType<typeof CommitComposer> | null>(null);
const composer = useCommitComposer({
  repositoryId: () => selectedRepository.value?.config.id ?? null,
  draftKey: () => selectedRepository.value ? `${selectedRepository.value.config.id}\0${selectedRepository.value.branch ?? 'DETACHED'}` : '',
  revision: () => JSON.stringify([branchSnapshot.value?.head, repositoryFiles.value.map(file => [file.id, file.staged, file.unstaged, file.conflicted])]),
  paused: () => workspaceBusy.value || workspaceRefreshing.value || filesLoading.value || Boolean(branchMerge.value) || Boolean(pushBranches.value),
  hasStaged: () => Boolean(selectedRepository.value?.config.capabilities.commit) && repositoryFiles.value.some(file => file.staged && !file.conflicted),
  readPreview: api.commitPreview,
  suggest: api.suggestCommit,
});
const commitBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository?.config.capabilities.commit) return '仓库配置未允许提交';
  if (repository.inProgressOperation) return '请先完成或中止当前 Git 操作';
  if (conflictedFiles.value.length || repository.conflicted) return '请先解决冲突';
  return null;
});
/** 舰队页读自己那条。抽屉与设置弹窗各读各的，不再需要「谁在上面」这种判断。 */
const fleetNotice = computed(() => notices.noticeFor('workspace:repositories'));
const settingsNotice = computed(() => notices.noticeFor('settings'));
const repositoryNotice = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return undefined;
  const owner: NoticeOwner = `repository:${repository.config.id}`;
  const notice = notices.noticeFor(owner);
  // 错误优先：仓库自己的状态错误（路径不可用之类）盖过任何一条成功回执，
  // 与原来 `error || repository.error || message` 的次序一致。
  if (notice?.severity === 'error') return notice;
  if (repository.error) return { owner, severity: 'error' as const, text: repository.error, unread: false };
  return notice;
});

/** 只清当前容器那条。别的容器有自己的消息，本来就不该被这里连坐。 */
function dismissFeedback(): void {
  notices.dismiss(activeNoticeOwner.value);
}

/**
 * 容器关着的时候，消息没地方落脚，但也不该就这么消失。
 *
 * 入口点上挂一个点，只回答「那儿有事」，不回答是什么事——想读就进去读。
 * 和顶栏「检查更新」发现新版本时挂的那个点是同一套做法。
 */
function hasUnreadNotice(owner: NoticeOwner): boolean {
  return notices.hasUnread(owner);
}

function unreadNoticeLabel(owner: NoticeOwner): string {
  const notice = notices.noticeFor(owner);
  if (!notice) return '';
  return `${notice.severity === 'error' ? '操作失败' : '待查看'}：${notice.text}`;
}

// 容器一露脸就算读过了：那个点只代表「你还没看过」。
watch(activeNoticeOwner, owner => notices.markRead(owner), { immediate: true });

const profileForm = reactive<ProfileConfig['profile']>({
  displayName: '',
  avatar: null,
  locale: 'zh-CN',
  theme: defaultDarkTheme,
  preferredCommitLanguage: 'zh-CN',
  aiCommitMode: 'review',
  autoFetchIntervalMinutes: 0,
  viewPreferences: { ...cachedViewPreferences },
});

/**
 * 深色主题。
 *
 * 本地缓存先兜首屏（`main.ts` 已按它落过一次），服务端配置回来后以服务端为准；
 * 切换是即时动作，所以单独走一个只改主题的接口自动保存，不占用「保存个人配置」。
 */
const theme = ref<DarkTheme>(readCachedTheme());
const themeModel = computed<string | number>({
  get: () => theme.value,
  set: value => { if (themeOptions.some(option => option.value === value)) theme.value = value as DarkTheme; },
});
/**
 * 主题落库走「只保存最新值」的队列。
 *
 * 早先是用 `persistedTheme` 在 watch 里先比一次再压进 promise 链，问题出在比的是
 * **发起那一刻**的值：连点 A→B→A 时，最后那次改回 A 会判成「和已保存一致」直接跳过，
 * 而先前 B 的请求随后落库——服务端停在 B，本地缓存却是 A，下次启动主题又被改回 B。
 * 队列改成「排队时只记目标值、落库后再比」，最后一次选择一定写进去；中间的 B→C→D
 * 也只保存飞行中的那个和最后一个。
 */
const themeSaver = createLatestSave<DarkTheme>(
  async (next) => (await api.saveTheme(next)).profile.theme,
  {
    current: theme.value,
    onError: (error) => {
      actionError.value = error instanceof Error ? `主题保存失败：${error.message}` : '主题保存失败';
    },
  },
);
watch(theme, (next) => {
  applyTheme(next);
  cacheTheme(next);
  // 同步给表单，否则「保存个人配置」会拿旧主题把刚选的这一套覆盖回去。
  profileForm.theme = next;
  themeSaver.save(next);
}, { immediate: true });

const rootForm = reactive({ path: '' });
/**
 * 克隆远端仓库的表单。
 *
 * 与「登记已存在的本地路径」并列：那条路要求目录先存在，想 clone 一个新仓库只能回终端。
 */
const cloneForm = reactive({ rootId: '', url: '', directory: '' });
const cloneBusy = ref(false);
/** 克隆弹窗：克隆的唯一入口，设置面板里不再保留第二份表单。 */
const cloneDialogOpen = ref(false);
/** 克隆失败详情：只在弹窗内联显示，不占用面板里的那条状态行。 */
const cloneError = ref('');
/**
 * 认证补填：克隆被远端拒绝时，在弹窗里直接录入该主机的凭证，存进系统钥匙串后自动重试。
 * 与设置里的凭证表单互不共享状态——这里只服务「这一次克隆」。
 */
const cloneAuth = reactive({ open: false, host: '', username: '', secret: '' });
const cloneAuthBusy = ref(false);
const cloneAuthError = ref('');
const cloneAuthSecretVisible = ref(false);
const cloneAuthUsernameInput = ref<HTMLInputElement | null>(null);
/** 地址里的主机与协议；SSH 类失败的 stderr 不带主机，只能从这里兜底。 */
const cloneUrlTarget = computed(() => {
  const raw = normalizeRemoteUrlInput(cloneForm.url);
  if (!raw) return null;
  const parsed = parseRemoteUrl(raw);
  if (parsed.ok) {
    const { host, port, protocol } = parsed.shape;
    // 凭证按 `host:port` 存（git 的 credential 键包含端口），丢端口会指向另一条记录。
    return { host: port ? `${host}:${port}` : host, protocol };
  }
  // `parseRemoteUrl` 只认 https / ssh（那是给协议互转用的）；克隆还允许 http 等地址，
  // 这里补一次解析，才能判断「凭证能力只支持 https」。
  try {
    const url = new URL(raw);
    if (!url.hostname) return null;
    return {
      host: url.port ? `${url.hostname}:${url.port}` : url.hostname,
      protocol: url.protocol.replace(/:$/, ''),
    };
  } catch {
    return null;
  }
});
const cloneAuthStatus = computed(() => (cloneError.value
  ? detectCloneAuth(cloneError.value, cloneUrlTarget.value?.host ?? null, cloneUrlTarget.value?.protocol ?? null)
  : null));
/** 底部错误行只放原因，不含 git 的进度行与 `fatal:` 前缀；分类仍用原始文本。 */
const cloneErrorText = computed(() => (cloneError.value ? cleanCloneError(cloneError.value) : ''));
/** 连不上 / 仓库不存在这类常见失败的普通话版本；认证类走补填面板，不在这里。 */
const cloneErrorHint = computed(() => (cloneError.value ? cloneFailureHint(cloneError.value) : null));

/** 克隆表单用到的根目录选项。 */
const cloneRootOptions = computed<SelectMenuOption[]>(() =>
  Object.entries(query.data.value?.roots ?? {}).map(([id, rootPath]) => ({ value: id, label: rootNameFromPath(rootPath) })),
);

/**
 * 实际会落到的目录名：留空时按地址末段推断。
 *
 * 推断逻辑与服务端**共用** `suggestedDirectoryName`，因此这里显示的就是服务端会用的名字，
 * 而不是「界面猜一个、服务端再算一个」。
 */
const cloneDirectory = computed(() => {
  const manual = cloneForm.directory.trim();
  if (manual) return manual;
  // 地址还没填、或填的不是合法地址时不要「预告」目录名：`not a url` 会被推断成 `not a url`，
  // 底部于是写着「将创建：not a url」，比不显示更让人困惑。
  if (!cloneForm.url.trim() || !parseRemoteTarget(cloneForm.url).ok) return '';
  return suggestedDirectoryName(cloneForm.url) ?? '';
});

/** 所选根目录的绝对路径；用于把「将创建」写成用户能直接核对的位置。 */
const cloneRootPath = computed(() => {
  const configured = query.data.value?.roots[cloneForm.rootId] ?? '';
  // 去掉尾部分隔符，否则拼出来是 `…/projects//name`，既难读也对不上仓库的 absolutePath。
  return configured.replace(/[\\/]+$/, '') || configured;
});
const cloneTargetPath = computed(() => {
  if (!cloneDirectory.value) return '';
  return cloneRootPath.value ? `${cloneRootPath.value}/${cloneDirectory.value}` : cloneDirectory.value;
});

/**
 * 目标位置已有的仓库。
 *
 * 只认 `available` 的仓库：目录确实还在时克隆必然失败（服务端 `stat` 一查就知道），
 * 提前说出来能省掉一次「确认 → 等待 → 报错」，也不用在确认框里承诺「将创建」一个已经存在的位置。
 * 反过来，登记了但目录已丢失的仓库不算占用——那里其实是空的，克隆正好能把它补回来。
 */
const cloneConflict = computed(() => {
  const target = cloneTargetPath.value;
  if (!target) return null;
  return query.data.value?.repositories.find((repository) => repository.available && repository.absolutePath === target) ?? null;
});

/**
 * 克隆已用秒数与实时进度。
 *
 * 克隆只在大仓库 / 慢网络时才慢，而这段时间界面原先只有一句「正在克隆…」——看起来像卡住了。
 * 现在两条信息一起给：一条是本机计时（永远不会缺），一条是 git 自己报的阶段与百分比
 * （`--progress` 才有，连上之前读不到）。
 *
 * 为什么用轮询而不是操作事件流：克隆的目标仓库此时还不存在，服务端的操作记录
 * 没有可归属的仓库（见 `cloneRepositoryIntoRoot` 调用处与进度路由的注释）。
 * 克隆本身是个阻塞请求，等它的同时顺手 GET 一下进度最省事。
 */
const cloneElapsedSeconds = ref(0);
const cloneProgress = ref<CloneProgress | null>(null);
const cloneProgressId = ref('');
let cloneTicker: ReturnType<typeof setInterval> | null = null;
let cloneProgressInFlight = false;

function startCloneTicker(progressId: string): void {
  stopCloneTicker();
  const startedAt = Date.now();
  cloneElapsedSeconds.value = 0;
  cloneProgress.value = null;
  cloneProgressId.value = progressId;
  const poll = () => {
    // 上一轮没回来就跳过：克隆正在大量写盘，本地服务偶发的慢响应不该把请求堆起来。
    if (cloneProgressInFlight) return;
    cloneProgressInFlight = true;
    void api
      .cloneProgress(progressId)
      .then((result) => {
        // 进度只是装饰：读失败就保持上一帧，绝不打断克隆。
        if (result.progress && cloneProgressId.value === progressId) cloneProgress.value = result.progress;
      })
      .catch(() => undefined)
      .finally(() => {
        // 只有「还是同一次克隆」才解锁，否则上一次的收尾会把下一次的闸门提前打开。
        if (cloneProgressId.value === progressId) cloneProgressInFlight = false;
      });
  };
  poll();
  cloneTicker = setInterval(() => {
    cloneElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000);
    poll();
  }, 1000);
}
function stopCloneTicker(): void {
  if (cloneTicker !== null) {
    clearInterval(cloneTicker);
    cloneTicker = null;
  }
  cloneProgressId.value = '';
  cloneProgressInFlight = false;
}

/** 进度条宽度；`null` 表示这一阶段没有可量化进度，不画条。 */
const cloneProgressWidth = computed(() => cloneProgressWidthOf(cloneProgress.value));

/** 底部那一行：有进度就报进度，没有就只报已用时间。 */
const cloneProgressSummary = computed(() => {
  const elapsed = `已用 ${cloneElapsedSeconds.value} 秒`;
  return cloneProgress.value ? `${cloneProgressText(cloneProgress.value)} · ${elapsed}` : elapsed;
});

const cloneProblem = computed(() => {
  if (!cloneForm.rootId) return '请选择要克隆到哪个目录';
  if (!cloneForm.url.trim()) return '';
  const parsed = parseRemoteTarget(cloneForm.url);
  if (!parsed.ok) return parsed.reason;
  const directory = cloneDirectory.value;
  if (!directory) return '无法从地址推断目录名，请手动填写';
  // 与服务端 `ensureDirectoryName` 同一套判定：这里漏一条，用户就要多点一次确认、
  // 多等一个往返才能看到同样的拒绝理由。
  if (/[/\\]/.test(directory)) return '目录名只能是单层，不能包含路径分隔符';
  if (directory === '.' || directory === '..') return '目录名不能是「.」或「..」';
  if (directory.startsWith('-')) return '目录名不能以「-」开头，否则会被 git 当成选项';
  // 这条正则的用途就是揪出控制字符，`no-control-regex` 在这里属于误报。
  // eslint-disable-next-line no-control-regex -- 目的正是匹配控制字符
  if (/[\u0000-\u001f\u007f]/.test(directory)) return '目录名不能包含控制字符或换行';
  const conflict = cloneConflict.value;
  if (conflict) return `这个位置已经有仓库「${conflict.config.name}」了，请换一个目录名`;
  return '';
});

const cloneReady = computed(() => Boolean(cloneForm.url.trim()) && !cloneProblem.value && !cloneBusy.value);
let viewPreferencesHydrated = false;
let profileFormHydrated = false;
let repositorySetupPrompted = false;
let persistedViewPreferences = '';
let viewPreferencesSaveChain: Promise<void> = Promise.resolve();

function profileHasUnsavedChanges(saved: ProfileConfig['profile'] | undefined): boolean {
  if (!saved) return false;
  return (
    profileForm.displayName !== saved.displayName ||
    profileForm.preferredCommitLanguage !== saved.preferredCommitLanguage ||
    profileForm.aiCommitMode !== saved.aiCommitMode ||
    profileForm.autoFetchIntervalMinutes !== saved.autoFetchIntervalMinutes
  );
}

function currentViewPreferences(): ProfileViewPreferences {
  return {
    repositorySort: sortMode.value,
    repositoryFilter: stateFilter.value,
    repositoryGroup: groupFilter.value,
    batchScope: profileForm.viewPreferences.batchScope,
    interfaceFont: interfaceFont.value,
    interfaceFontSize: interfaceFontSize.value,
    codeFont: codeFont.value,
    ...(codeFontSize.value === null ? {} : { codeFontSize: codeFontSize.value }),
    fileListView: fileListView.value,
    analyticsRepositoryIds: analyticsRepositoryScope.value,
  };
}

watch(
  () => query.data.value,
  (dashboard) => {
    if (!dashboard) return;
    if (!profileFormHydrated || !manageOpen.value || !profileHasUnsavedChanges(dashboard.profile.profile)) {
      Object.assign(profileForm, dashboard.profile.profile);
      profileFormHydrated = true;
    }
    if (!viewPreferencesHydrated) {
      const preferences = dashboard.profile.profile.viewPreferences;
      sortMode.value = preferences.repositorySort;
      stateFilter.value = preferences.repositoryFilter;
      groupFilter.value = preferences.repositoryGroup;
      interfaceFont.value = preferences.interfaceFont ?? defaultInterfaceFont;
      interfaceFontSize.value = preferences.interfaceFontSize ?? 14;
      codeFont.value = preferences.codeFont ?? 'jetbrains-mono';
      codeFontSize.value = preferences.codeFontSize ?? null;
      // 服务端的本机配置跨端口生效，浏览器缓存只用于首屏；移除失效 ID 后再开始统计。
      const savedScope = normalizeAnalyticsRepositoryScope(preferences.analyticsRepositoryIds ?? null);
      const available = new Set(analyticsRepositoryOptions.value.map((option) => String(option.value)));
      setAnalyticsRepositoryScope(savedScope === null ? null : savedScope.filter((id) => available.has(id)));
      // 主题只在首次同步时对齐服务端：之后再赋值会把用户在别处改过的缓存又压回去。
      theme.value = dashboard.profile.profile.theme;
      // 这一版来自服务端，认作已落库的基线——否则同步本身会触发一次原样回写。
      themeSaver.adopt(theme.value);
      persistedViewPreferences = JSON.stringify({ ...currentViewPreferences(), analyticsRepositoryIds: savedScope });
      viewPreferencesHydrated = true;
      analyticsScopeHydrated.value = true;
    }
    profileForm.viewPreferences = currentViewPreferences();
    if (!scanRootId.value) scanRootId.value = Object.keys(dashboard.roots)[0] ?? '';
    // 克隆目标目录也要有默认值：只有一个根目录时还逼用户先选一次，等于凭空多一步。
    if (!cloneForm.rootId || !dashboard.roots[cloneForm.rootId]) {
      cloneForm.rootId = Object.keys(dashboard.roots)[0] ?? '';
    }
    if (!repositorySetupPrompted) {
      repositorySetupPrompted = true;
      if (dashboard.repositories.length === 0 && activeWorkspace.value === 'repositories') {
        openManage(undefined, 'repositories');
      }
    }
    if (selectedRepository.value) {
      selectedRepository.value =
        dashboard.repositories.find((repository) => repository.config.id === selectedRepository.value?.config.id) ?? null;
      // 复用同一次 15 秒 tick 静默刷新抽屉里的文件与分支；窗口失焦时 react-query 会暂停。
      void refreshRepositoryWorkspaceInBackground();
    }
  },
  { immediate: true },
);

watch(
  [sortMode, stateFilter, groupFilter, interfaceFont, interfaceFontSize, codeFont, codeFontSize, fileListView, analyticsRepositoryScope],
  () => {
    const preferences = currentViewPreferences();
    const serialized = JSON.stringify(preferences);
    cacheViewPreferences(preferences);
    profileForm.viewPreferences = preferences;
    if (!viewPreferencesHydrated || serialized === persistedViewPreferences) return;
    viewPreferencesSaveChain = viewPreferencesSaveChain
      .catch(() => undefined)
      .then(async () => {
        const saved = await api.saveViewPreferences(preferences);
        persistedViewPreferences = JSON.stringify(saved.profile.viewPreferences);
      })
      .catch((error) => {
        actionError.value = error instanceof Error ? `视图偏好保存失败：${error.message}` : '视图偏好保存失败';
      });
  },
  { flush: 'post' },
);

watch(
  () => selectedRepository.value?.config.id,
  (repositoryId) => {
    repositoryContextVersion += 1;
    closeDiffDialog();
    repositoryFilesRequest += 1;
    repositoryStashesRequest += 1;
    repositoryBranchesRequest += 1;
    repositoryFiles.value = [];
    repositoryFilesError.value = '';
    filesLoading.value = false;
    repositoryStashes.value = [];
    stashesLoading.value = false;
    branchPanelOpen.value = false;
    branchSnapshot.value = null;
    branchesLoading.value = false;
    stashMessage.value = '';
    repositoryAction.value = null;
    // 多分支推送窗口属于上一个仓库的分支清单，跟着上下文一起回收；
    // 忙态必须一起清，否则切回来时 Push 入口会永久灰着。
    pushBranches.value = null;
    pushBranchesBusy.value = false;
    // 单仓多分支操作的「等批次收尾」标志也必须清，否则切走后新仓库操作按钮永久灰。
    repositorySettling.value = false;
    branchSwitchBusy.value = null;
    workspaceRefreshing.value = false;
    hunkActionBusy.value = null;
    conflictBusy.value = null;
    operationBusy.value = null;
    openBusy.value = null;
    stashBusy.value = null;
    fileActionId.value = null;
    fileDiscardId.value = null;
    fileDiscardBatchBusy.value = false;
    repositoryIgnoredRequest += 1;
    repositoryIgnoredFiles.value = [];
    ignoredTruncated.value = false;
    ignoredLoading.value = false;
    showIgnoredFiles.value = false;
    ignoreBusyId.value = null;
    repositoryMarkedRequest += 1;
    markedFiles.value = [];
    markedLoading.value = false;
    showMarkedFiles.value = false;
    assumeBusyId.value = null;
    diffLoading.value = false;
    repositoryStashes.value = [];
    stashesLoading.value = false;
    repositoryTags.value = [];
    remoteTagNames.value = new Set();
    remoteTagsKnown.value = false;
    tagsLoading.value = false;
    tagBusy.value = null;
    tagForm.name = '';
    tagForm.message = '';
    lastCommitSnapshot.value = null;
    rewriteBusy.value = null;
    /**
     * 提交与 revert / cherry-pick 的忙态必须在这里一起清。
     *
     * 它们原先只在 `finally` 里清，而那个 `finally` 的条件是「还停在同一个仓库上下文」。
     * 提交期间点顶栏「操作记录」（`openHistory` 直接置空选中仓库）或切到别的仓库，
     * 条件就不成立，忙态永久留在 true 上。而 `workspaceBusy` / `stageLocked` /
     * `hunkActionBlocked` / `composer.paused` 全都含 `commitBusy`，于是之后打开的
     * 任何仓库里，暂存框、提交按钮、按块操作、Fetch 一律是灰的，禁用的按钮还弹不出
     * 原因——只能刷新页面才能恢复。
     *
     * 服务端不依赖这里选中了哪个仓库，提交会照常落地；切走的上下文里这个忙态已经没有
     * 意义，留着只会把界面锁死。重复提交也不用担心：回来时会重新读提交预览，暂存区
     * 已空，提交按钮本身不可用。
     */
    commitBusy.value = false;
    replayBusy.value = null;
    if (repositoryId) {
      void loadRepositoryBranches(repositoryId);
      void loadRepositoryFiles(repositoryId);
      void loadRepositoryStashes(repositoryId);
      void loadRepositoryTags(repositoryId);
      void loadLastCommit(repositoryId);
    }
  },
);

function isCurrentRepositoryContext(repositoryId: string, contextVersion: number): boolean {
  return contextVersion === repositoryContextVersion && selectedRepository.value?.config.id === repositoryId;
}

function cacheRepositoryStatus(status: RepositoryStatus): void {
  queryClient.setQueryData<DashboardPayload>(['dashboard'], (dashboard) => replaceDashboardRepository(dashboard, status));
  if (selectedRepository.value?.config.id === status.config.id) selectedRepository.value = status;
}

watch(
  () => operationsQuery.data.value?.batches,
  async (batches) => {
    if (!activeBatchId.value) return;
    const batch = batches?.find((item) => item.id === activeBatchId.value);
    if (!batch) return;
    // 还没跑完就没有结论：把上一条批次的结论清掉，免得新批次的卡片上挂着旧结果。
    if (batch.state !== 'completed') {
      batchResultMessage.value = '';
      return;
    }
    // 零值不念：一次干净的批量只该留一句「N 个仓库」。
    const anomalies = [
      batch.skipped > 0 ? `${batch.skipped} 跳过` : '',
      batch.failed > 0 ? `${batch.failed} 失败` : '',
    ].filter(Boolean);
    // 后台 Fetch 被用户操作挤掉：这不是「完成」，别让用户以为自己刚推完 66 个仓库。
    const yieldedToUser = batch.background === true && batch.interrupted === true;
    const completionMessage = yieldedToUser
      ? `自动 Fetch 已让路给其他操作 · 已刷 ${batch.success} 个仓库，其余稍后补上`
      : `批量 ${batchTypeLabel(batch.type)} 完成 · ${batch.success} 个仓库${anomalies.map((item) => `，${item}`).join('')}`;
    batchResultMessage.value = completionMessage;
    activeBatchId.value = null;
    const refreshed = await query.refetch();
    // 让路的那一轮不追加 fetch 结论：它本来就没刷完，再念「N 个仓库有更新」只会误导。
    if (!yieldedToUser && batch.type === 'fetch' && refreshed.isSuccess && refreshed.data) {
      const batchRepositoryIds = new Set(
        operationsQuery.data.value?.operations
          .filter((operation) => operation.batchId === batch.id && operation.state === 'success')
          .map((operation) => operation.repositoryId) ?? [],
      );
      const batchRepositories = refreshed.data.repositories.filter((repository) => (
        batchRepositoryIds.has(repository.config.id)
      ));
      if (batchRepositories.length > 0 && batchResultMessage.value === completionMessage) {
        batchResultMessage.value = `${completionMessage}，${fetchBatchResultMessage(batchRepositories)}`;
      }
    }
  },
);

const repositories = computed(() => query.data.value?.repositories ?? []);
const projectSwitchBlocked = computed(() => workspaceBusy.value || workspaceRefreshing.value || Boolean(branchMerge.value) || Boolean(pushBranches.value));
const projectSwitchOptions = computed<SelectMenuOption[]>(() => [...repositories.value]
  .sort(compareWorkspaceRepositories)
  .map(repository => ({
    value: repository.config.id,
    label: repository.config.name,
    // 第二行只放当前分支，前置小图标代替「分支」二字；完整路径只留给搜索与悬停。
    hint: repository.available ? (repository.branch ?? 'DETACHED') : '路径不可用',
    hintIcon: repository.branch ? GitBranch : undefined,
    keywords: repository.absolutePath,
    disabled: !repository.available,
    // 与主列表同一套词汇：状态胶囊 + S/M/U/C 工作区计数，切项目前先看清有没有变动。
    status: repository.available ? statusMeta[repository.state] : undefined,
    counts: [
      repository.staged ? { label: `S ${repository.staged}`, tone: 'staged' } : null,
      repository.modified ? { label: `M ${repository.modified}`, tone: 'modified' } : null,
      repository.untracked ? { label: `U ${repository.untracked}`, tone: 'untracked' } : null,
      repository.conflicted ? { label: `C ${repository.conflicted}`, tone: 'conflict' } : null,
    ].filter((count): count is { label: string; tone: string } => count !== null),
  })));
const selectedProjectModel = computed<string | number>({
  get: () => selectedRepository.value?.config.id ?? '',
  set: value => {
    if (projectSwitchBlocked.value || confirmation.value || upstreamRepair.value) return;
    const repository = repositories.value.find(item => item.config.id === value);
    if (!repository?.available || repository.config.id === selectedRepository.value?.config.id) return;
    // 消息跟着 owner 走，切仓库不用清：这个仓库那条留在它自己名下，切回来看得见。
    // 返回目标由 `selectRepository` 统一清（见它的说明），这里不必再动。
    selectRepository(repository);
  },
});
const repositoryGroups = computed(() => {
  const counts = new Map<string, number>();
  for (const repository of repositories.value) {
    counts.set(repository.config.group, (counts.get(repository.config.group) ?? 0) + 1);
  }
  if (groupFilter.value && !counts.has(groupFilter.value)) counts.set(groupFilter.value, 0);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
const selectedRemoteLinks = computed(() => remoteLinks(selectedRepository.value?.remoteUrl ?? null));
const filteredLocalBranches = computed(() => {
  const branches = branchSnapshot.value?.branches ?? [];
  const primary = branches.some(branch => branch.name === 'main') ? 'main' : 'master';
  return [...branches].sort((a, b) => compareBranchNames(a.name, b.name, primary));
});
const branchWriteBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return '仓库详情已关闭';
  // 这里曾经还有一条 `composer.reading` → 「正在核对提交内容」。那是预览还占仓库锁时
  // 的规避：预览在飞时切分支会被服务端拒成 409。预览改成只读之后不再需要，留着反而
  // 让「刚勾完文件就切分支」的那次点击被静默吞掉（按钮是禁用的，tooltip 也弹不出来）。
  if (!repository.config.capabilities.stage) return '仓库配置未允许修改工作区';
  if (repository.inProgressOperation) return `正在进行 ${repository.inProgressOperation}`;
  return null;
});
/**
 * 检出远端分支与本地切换同语义：不要求干净工作区，能兼容的改动随分支带过去，
 * 会被覆盖时由 Git 拒绝。面板里只做提示，不因此禁用按钮。
 */
const branchPanelBlocker = computed(() => branchWriteBlocker.value);
const selectedWorktreeChanges = computed(() =>
  selectedRepository.value ? worktreeChangeCount(selectedRepository.value) : 0);
const worktreeChangeBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return null;
  const changes = worktreeChangeCount(repository);
  return changes > 0
    ? `工作区有 ${changes} 处改动：创建后切换需要先处理；可取消“创建后切换”仅创建分支` : null;
});
const branchCreateBlocker = computed(() => branchCreateCheckout.value
  ? branchWriteBlocker.value || worktreeChangeBlocker.value
  : branchWriteBlocker.value);
const localBranchSwitchBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return '仓库详情已关闭';
  // 同 `branchWriteBlocker`：预览读取是只读的，切换分支后 composer 会按 draftKey
  // （仓库 + 分支）丢掉旧响应，不需要在这里挡。
  if (!repository.config.capabilities.stage) return '仓库配置未允许修改工作区';
  if (repository.inProgressOperation) return `正在进行 ${repository.inProgressOperation}`;
  if (repository.conflicted) return '工作区存在未解决的冲突';
  return null;
});
/** 所有远端分支都可用未占用的本地名称检出。 */
const remoteBranchesForCheckout = computed(() =>
  branchSnapshot.value?.remoteBranches ?? [],
);
const filteredRemoteBranches = computed(() => {
  return remoteBranchesForCheckout.value.slice(0, 50);
});
const configuredAutoFetchInterval = computed<AutoFetchIntervalMinutes>(
  () => query.data.value?.profile.profile.autoFetchIntervalMinutes ?? 0,
);
const repositoryFilterContext = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return repositories.value.filter((repository) => {
    const matchesKeyword =
      !keyword ||
      [repository.config.name, repository.config.group, repository.config.path, ...repository.config.tags]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    const matchesGroup = groupFilter.value === null || repository.config.group === groupFilter.value;
    return matchesKeyword && matchesGroup;
  });
});
function compareWorkspaceRepositories(a: RepositoryStatus, b: RepositoryStatus): number {
  const pinning = compareRepositoryPinning(a, b);
  if (pinning !== null) return pinning;
  if (sortMode.value === 'activity') return compareRepositoryActivity(a, b);
  if (sortMode.value === 'commit') return compareRepositoryLastCommit(a, b);
  if (sortMode.value === 'name') return a.config.name.localeCompare(b.config.name);
  if (sortMode.value === 'group') {
    return a.config.group.localeCompare(b.config.group) || a.config.name.localeCompare(b.config.name);
  }
  return (
    new Date(b.lastFetchedAt ?? 0).getTime() - new Date(a.lastFetchedAt ?? 0).getTime() ||
    a.config.name.localeCompare(b.config.name)
  );
}
const filteredRepositories = computed(() => repositoryFilterContext.value
  .filter(repository => matchesRepositoryStateFilter(repository, stateFilter.value))
  .sort(compareWorkspaceRepositories));
const hasRepositoryFilters = computed(
  () => search.value.trim().length > 0 || stateFilter.value !== 'all' || groupFilter.value !== null,
);
/**
 * 已勾选且仍然启用、仍然存在的仓库。
 * 与批量接口一致地过滤掉已禁用项，避免把无效 ID 发上去换回 400。
 */
const selectedRepositories = computed(() => {
  if (selectedRepositoryIds.value.length === 0) return [];
  const selected = new Set(selectedRepositoryIds.value);
  return repositories.value.filter((repository) => selected.has(repository.config.id) && repository.config.enabled);
});
const batchTargetRepositories = computed(() => {
  if (selectedRepositoryIds.value.length > 0) return selectedRepositories.value;
  return hasRepositoryFilters.value ? filteredRepositories.value : repositories.value;
});
const batchScopeLabel = computed(() => {
  // 只描述范围，数量由调用处的 <strong> 统一给：写在这里会和后面的数量拼成「已选 1 1」。
  if (selectedRepositoryIds.value.length > 0) return '已选仓库';
  return hasRepositoryFilters.value ? '当前结果' : '全部仓库';
});
type BatchAvailabilitySummary = {
  eligible: number;
  total: number;
  detail: string;
  /** 真正「可执行」的仓库数（合并=可合并+可清理）；缺省时退回 eligible。 */
  actionable?: number;
};
/**
 * 双线合并的工具栏数字要「真」：`batchMergeAvailability` 只按硬条件粗判（工作区干净、
 * 允许提交…），会把一堆「没有非双线分支」的仓库也算进去（实机 66 仓粗判 58、真可合并 2）。
 * 这里用预检接口拿到真实分布，按仓库状态签名缓存 + 防抖，签名不变不重查。
 */
type MergePlanCounts = { signature: string; mergeable: number; cleanupOnly: number };
const mergePlanCounts = ref<MergePlanCounts | null>(null);
let mergeCountTimer: number | undefined;
let lastMergePlanAt = 0;
const batchRepositorySignature = computed(() => batchTargetRepositories.value
  .map((repository) => `${repository.config.id}|${repository.state}|${repository.branch}|${repository.changedFiles}|${repository.untracked}|${repository.ahead}|${repository.behind}`)
  .join(';'));
const mergePlanExact = computed(() => (
  mergePlanCounts.value && mergePlanCounts.value.signature === batchRepositorySignature.value
    ? mergePlanCounts.value
    : null
));
async function refreshMergePlanCounts(signature: string): Promise<void> {
  if (signature === mergePlanCounts.value?.signature) return;
  if (Date.now() - lastMergePlanAt < 15_000) return;
  const ids = batchTargetRepositories.value.map((repository) => repository.config.id);
  if (ids.length === 0) return;
  lastMergePlanAt = Date.now();
  try {
    const { plan } = await api.batchMergeBranchesPlan(ids);
    mergePlanCounts.value = {
      signature,
      mergeable: plan.repositories.filter((row) => row.blocker === null && row.sources.some((source) => !source.blocker)).length,
      cleanupOnly: plan.repositories.filter((row) => row.blocker === null && row.sources.every((source) => source.blocker) && row.mergedBranches.length > 0).length,
    };
  } catch {
    // 预检失败就退回粗判数字，不阻断工具栏。
  }
}
watch(batchRepositorySignature, (signature) => {
  if (mergeCountTimer !== undefined) window.clearTimeout(mergeCountTimer);
  mergeCountTimer = window.setTimeout(() => { void refreshMergePlanCounts(signature); }, 900);
}, { immediate: true });
const batchAvailability = computed<Record<BatchOperationType, BatchAvailabilitySummary>>(() => {
  const targets = batchTargetRepositories.value;
  const total = targets.length;
  const fetchEligible = batchEligibleRepositoryCount(targets, 'fetch');
  const pullEligible = batchEligibleRepositoryCount(targets, 'pull');
  const pushEligible = batchEligibleRepositoryCount(targets, 'push');
  // 粗判只看「有没有资格被合」；真有非双线分支要等弹窗里的预检。
  const mergeEligible = batchEligibleRepositoryCount(targets, 'merge-branches');
  // 多分支 Pull 同理：这里只承诺「基础可拉」的仓库数，真正落后哪几条在弹窗里逐仓算。
  const pullBranchesEligible = batchEligibleRepositoryCount(targets, 'pull-branches');
  return {
    fetch: {
      eligible: fetchEligible,
      total,
      detail: fetchEligible > 0
        ? `可更新 ${fetchEligible} 个仓库的远端状态。`
        : '当前范围没有可更新远端状态的仓库。',
    },
    pull: {
      eligible: pullEligible,
      total,
      detail: pullEligible > 0
        ? `${pullEligible} 个仓库有可安全拉取的更新。`
        : '当前范围没有可安全拉取的仓库；有本地改动、未关联远端或不能直接更新的仓库会被跳过。',
    },
    'pull-branches': {
      eligible: pullBranchesEligible,
      total,
      detail: pullBranchesEligible > 0
        ? `将在 ${pullBranchesEligible} 个仓库里按档位拉取分支，具体可拉项在窗口内逐仓列出。`
        : '当前范围没有可拉取的仓库；不可用、冲突中或没有远端的仓库会被排除。',
    },
    'push-branches': {
      eligible: batchEligibleRepositoryCount(targets, 'push-branches'),
      total,
      detail: batchEligibleRepositoryCount(targets, 'push-branches') > 0
        ? `将在 ${batchEligibleRepositoryCount(targets, 'push-branches')} 个仓库里按档位挑分支推送，具体可推项在窗口内逐仓列出。`
        : '当前范围没有可推送的仓库；不可用、冲突中、Detached HEAD 或没有远端的仓库会被排除。',
    },
    push: {
      eligible: pushEligible,
      total,
      detail: pushEligible > 0
        ? `${pushEligible} 个仓库有提交可安全推送。`
        : '当前范围没有可安全推送的仓库；落后远端、未关联远端或没有新提交的仓库会被跳过。',
    },
    'merge-branches': (() => {
      const exact = mergePlanExact.value;
      const eligible = exact ? exact.mergeable : mergeEligible;
      const actionable = exact ? exact.mergeable + exact.cleanupOnly : mergeEligible;
      const detail = exact
        ? (actionable > 0
            ? `可合并 ${exact.mergeable} 个仓库${exact.cleanupOnly > 0 ? `，另有 ${exact.cleanupOnly} 个可清理已合并分支` : ''}。`
            : '当前范围没有可合并或可清理的仓库。')
        : (mergeEligible > 0
            ? `正在核对双线合并范围（约 ${mergeEligible} 个仓库通过基础检查），可合并数以窗口内逐仓结果为准。`
            : '当前范围没有可合并的仓库；工作区不干净、冲突中、Detached HEAD 或不允许提交的仓库会被排除。');
      return { eligible, total, detail, actionable };
    })(),
  };
});

const missingRepositories = computed(() => repositories.value.filter(isMissingRepository));
const summary = computed(() => ({
  total: repositories.value.filter((repository) => !isMissingRepository(repository)).length,
  today: repositories.value.filter(needsDailyAction).length,
  dirty: repositories.value.filter(hasWorktreeChanges).length,
  ahead: repositories.value.reduce((total, repository) => total + (repository.ahead ?? 0), 0),
  behind: repositories.value.reduce((total, repository) => total + (repository.behind ?? 0), 0),
}));
const filterCounts = computed(() => repositoryFilterCounts(repositoryFilterContext.value));
const summaryFilterModes: RepositoryFilterMode[] = ['all', 'today', 'dirty', 'ahead', 'behind'];
watch(
  stateFilter,
  (filter) => {
    const summaryIndex = summaryFilterModes.indexOf(filter);
    if (summaryIndex >= 0) summaryRovingIndex.value = summaryIndex;
  },
  { immediate: true },
);
const activeRepositoryFilterLabel = computed(() => {
  const stateLabels: Record<RepositoryFilterMode, string> = {
    all: '全部状态',
    today: '今日待处理',
    attention: '有动静',
    dirty: '工作区改动',
    ahead: '待推送',
    behind: '待拉取',
    stale: '久未 Fetch',
  };
  return [
    groupFilter.value ? `分组：${groupFilter.value}` : '',
    stateFilter.value !== 'all' ? stateLabels[stateFilter.value] : '',
    search.value.trim() ? `搜索：${search.value.trim()}` : '',
  ].filter(Boolean).join(' · ');
});
const scanStatusLabel = computed(() => {
  const scan = query.data.value?.scan;
  if (query.isFetching.value) return scan ? `扫描中 · 上次 ${relativeTime(scan.completedAt)}` : '首次扫描中';
  if (!scan) return '等待扫描';
  return `扫描 ${relativeTime(scan.completedAt)} · ${formatDuration(scan.durationMs)}`;
});

const activeBatch = computed(() => {
  const batches = operationsQuery.data.value?.batches ?? [];
  return (
    (activeBatchId.value ? batches.find((batch) => batch.id === activeBatchId.value) : null) ??
    batches.find((batch) => batch.state === 'running') ??
    batches[0] ??
    null
  );
});

/**
 * 是否有「前台」批量在跑。
 *
 * 自动 Fetch 也是批量，但它是后台的：它跑着的时候批量按钮不该变灰——用户正是要在
 * 这会儿推代码，而服务端会在用户批次开始时让自动 Fetch 当场把仓库让出来。
 */
const foregroundBatchRunning = computed(
  () => activeBatch.value?.state === 'running' && activeBatch.value.background !== true,
);

const operationRepositories = computed(() => {
  const repositoriesById = new Map<string, string>();
  for (const operation of operationsQuery.data.value?.operations ?? []) {
    repositoriesById.set(operation.repositoryId, operation.repositoryName);
  }
  return [...repositoriesById.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

// --- SelectMenu option sources & typed v-model proxies ---
const sortModeModel = computed<string | number>({
  get: () => sortMode.value,
  set: (value) => { sortMode.value = value as typeof sortMode.value; },
});

const groupFilterOptions = computed<SelectMenuOption[]>(() => [
  { value: '', label: `全部分组 · ${repositories.value.length}` },
  ...repositoryGroups.value.map((group) => ({ value: group.name, label: `${group.name} · ${group.count}` })),
]);
const groupFilterModel = computed<string | number>({
  get: () => groupFilter.value ?? '',
  set: (value) => { groupFilter.value = value === '' ? null : String(value); },
});

const stateFilterOptions = computed<SelectMenuOption[]>(() => [
  { value: 'all', label: `全部状态 · ${filterCounts.value.all}` },
  { value: 'today', label: `今日待处理 · ${filterCounts.value.today}` },
  { value: 'attention', label: `有动静 · ${filterCounts.value.attention}` },
  { value: 'dirty', label: `工作区改动 · ${filterCounts.value.dirty}` },
  { value: 'ahead', label: `待推送 · ${filterCounts.value.ahead}` },
  { value: 'behind', label: `待拉取 · ${filterCounts.value.behind}` },
  { value: 'stale', label: `久未 Fetch · ${filterCounts.value.stale}` },
]);
const stateFilterModel = computed<string | number>({
  get: () => stateFilter.value,
  set: (value) => { stateFilter.value = value as RepositoryFilterMode; },
});

const operationRepositoryOptions = computed<SelectMenuOption[]>(() => [
  { value: 'all', label: '全部仓库' },
  ...operationRepositories.value.map((repository) => ({ value: repository.id, label: repository.name })),
]);
const operationRepositoryModel = computed<string | number>({
  get: () => operationRepositoryFilter.value,
  set: (value) => { operationRepositoryFilter.value = String(value); },
});

const operationTypeModel = computed<string | number>({
  get: () => operationTypeFilter.value,
  set: (value) => { operationTypeFilter.value = value as typeof operationTypeFilter.value; },
});

const operationStateModel = computed<string | number>({
  get: () => operationStateFilter.value,
  set: (value) => {
    operationNeedsAttentionOnly.value = false;
    operationStateFilter.value = value as typeof operationStateFilter.value;
  },
});

const commitLanguageModel = computed<string | number>({
  get: () => profileForm.preferredCommitLanguage,
  set: (value) => { profileForm.preferredCommitLanguage = value as typeof profileForm.preferredCommitLanguage; },
});
const interfaceFontModel = computed<string | number>({
  get: () => interfaceFont.value,
  set: value => { if (value in interfaceFontFamilies) interfaceFont.value = value as typeof interfaceFont.value; },
});
const codeFontModel = computed<string | number>({
  get: () => codeFont.value,
  set: value => { if (value in codeFontFamilies) codeFont.value = value as typeof codeFont.value; },
});
const codeFontSizeModel = computed<string | number>({
  get: () => codeFontSize.value ?? 0,
  set: value => {
    const size = Number(value);
    codeFontSize.value = Number.isInteger(size) && size >= 12 && size <= 16 ? size : null;
  },
});
function resetAppearance(): void {
  theme.value = defaultDarkTheme;
  interfaceFont.value = 'system';
  interfaceFontSize.value = 14;
  codeFont.value = 'jetbrains-mono';
  codeFontSize.value = null;
}
const interfaceFontSizeModel = computed<string | number>({
  get: () => interfaceFontSize.value,
  set: value => { const size = Number(value); if (Number.isInteger(size) && size >= 12 && size <= 16) interfaceFontSize.value = size; },
});

const aiCommitModeModel = computed<string | number>({
  get: () => profileForm.aiCommitMode,
  set: (value) => { profileForm.aiCommitMode = value as typeof profileForm.aiCommitMode; },
});

const autoFetchIntervalOptions = computed<SelectMenuOption[]>(() =>
  autoFetchIntervals.map((interval) => ({ value: interval, label: autoFetchIntervalLabel(interval) })),
);
const autoFetchIntervalModel = computed<string | number>({
  get: () => profileForm.autoFetchIntervalMinutes,
  set: (value) => { profileForm.autoFetchIntervalMinutes = Number(value) as typeof profileForm.autoFetchIntervalMinutes; },
});

const aiCommitPolicyModel = computed<string | number>({
  get: () => repositoryEdit.value?.aiCommitPolicy ?? 'disabled',
  set: (value) => { if (repositoryEdit.value) repositoryEdit.value.aiCommitPolicy = value as AiCommitRepositoryPolicy; },
});

const upstreamRemoteOptions = computed<SelectMenuOption[]>(() =>
  (upstreamRepair.value?.plan?.remotes ?? []).map((remote) => ({
    value: remote.name,
    label: `${remote.name}${remote.default ? ' · 默认' : ''}`,
  })),
);
const upstreamRemoteModel = computed<string | number>({
  get: () => upstreamRepair.value?.selectedRemote ?? '',
  set: (value) => { if (upstreamRepair.value) upstreamRepair.value.selectedRemote = String(value); },
});

const filteredOperations = computed(() =>
  (operationsQuery.data.value?.operations ?? []).filter(
    (operation) =>
      (operationRepositoryFilter.value === 'all' || operation.repositoryId === operationRepositoryFilter.value) &&
      (operationTypeFilter.value === 'all' || operation.type === operationTypeFilter.value) &&
      (operationStateFilter.value === 'all' || operation.state === operationStateFilter.value) &&
      (!operationNeedsAttentionOnly.value || isOperationIssue(operation)),
  ),
);
const operationIssueCount = computed(() =>
  (operationsQuery.data.value?.operations ?? []).filter(
    (operation) =>
      (operationRepositoryFilter.value === 'all' || operation.repositoryId === operationRepositoryFilter.value) &&
      (operationTypeFilter.value === 'all' || operation.type === operationTypeFilter.value) &&
      isOperationIssue(operation),
  ).length,
);
const operationHistoryItems = computed(() =>
  buildOperationHistoryItems(filteredOperations.value, expandedSuccessfulFetchBatchIds.value),
);

const hasOperationFilters = computed(
  () =>
    operationRepositoryFilter.value !== 'all' ||
    operationTypeFilter.value !== 'all' ||
    operationStateFilter.value !== 'all' ||
    operationNeedsAttentionOnly.value,
);

const retryableBatchRepositoryIdsList = computed(() =>
  retryableBatchRepositoryIds(
    activeBatch.value,
    operationsQuery.data.value?.operations ?? [],
    repositories.value.map((repository) => repository.config.id),
  ),
);

const fetchAvailability = computed(() => repositoryFetchAvailability(selectedRepository.value));
const pullAvailability = computed(() => repositoryPullAvailability(selectedRepository.value));
const pushAvailability = computed(() => repositoryPushAvailability(selectedRepository.value));
/**
 * 多分支推送入口的可用性。
 *
 * 刻意不复用 `pushAvailability`：那个判断的是**当前分支**有没有东西可推（upstream /
 * ahead / behind）。多分支窗口恰恰要处理「当前分支没什么可推、但 dev 或主分支有」
 * 这种情况，用当前分支的条件去禁用它，会把要用的场景挡在门外。
 */
const pushBranchesAvailability = computed<{ available: boolean; detail: string }>(() => {
  const repository = selectedRepository.value;
  if (!repository) return { available: false, detail: '请先选择仓库' };
  if (!repository.config.capabilities.push) return { available: false, detail: '仓库配置未允许 Push' };
  if (!repository.available) return { available: false, detail: '仓库当前不可用' };
  if (repository.detached) return { available: false, detail: 'Detached HEAD 不能推送分支' };
  if (repository.conflicted > 0 || repository.inProgressOperation) {
    return { available: false, detail: '存在冲突或进行中的 Git 操作' };
  }
  return { available: true, detail: '推送多个分支（如 dev + main / dev + master）' };
});
const syncAvailability = computed(() => repositorySyncAvailability(selectedRepository.value));
const activeFocusLayers = computed(() => {
  const layers: string[] = [];
  if (selectedRepository.value) layers.push(`repository:${selectedRepository.value.config.id}`);
  else if (historyOpen.value) layers.push('history');
  if (shortcutHelpOpen.value) layers.push('shortcuts');
  if (cloneDialogOpen.value) layers.push('clone');
  if (manageOpen.value) layers.push('manage');
  if (repositoryEdit.value) layers.push(`repository-edit:${repositoryEdit.value.id}`);
  if (upstreamRepair.value) layers.push(`upstream:${upstreamRepair.value.repositoryId}`);
  if (branchMerge.value) layers.push(`merge:${branchMerge.value.repositoryId}`);
  if (pushBranches.value) layers.push(`push-branches:${pushBranches.value.repositoryId}`);
  if (batchPushBranches.value) layers.push('batch-push-branches');
  if (batchMerge.value) layers.push('batch-merge');
  if (batchPull.value) layers.push('batch-pull');
  if (confirmation.value) layers.push(`confirmation:${confirmation.value.id}`);
  return layers;
});

/**
 * 快捷键帮助只列当前工作区真正生效的键。`H`、`J`/`K`、`Enter`、提交快捷键和阅读前进后退
 * 都只属于仓库舰队，在会话页列出来只会让人以为按了没反应是坏了。
 */
const shortcutHelpRows = computed<Array<{ label: string; chords: string[][] }>>(() => (
  activeWorkspace.value === 'sessions'
    ? [
        { label: '搜索本机会话', chords: [['⌘ / Ctrl', 'K']] },
        { label: '从搜索框进入会话清单', chords: [['↓']] },
        { label: '在会话之间移动焦点', chords: [['↑', '↓']] },
        { label: '刷新当前页面', chords: [['R']] },
        { label: '关闭抽屉或弹窗', chords: [['Esc']] },
        { label: '显示本帮助', chords: [['?']] },
      ]
    : [
        { label: '搜索当前页面', chords: [['⌘ / Ctrl', 'K']] },
        { label: '后退 / 前进阅读位置', chords: [['Alt / ⌥', '← / →']] },
        { label: '编写提交信息', chords: [['⌘ / Ctrl', '⇧ C']] },
        { label: '在提交区提交', chords: [['⌘ / Ctrl', '↵']] },
        { label: '刷新当前页面', chords: [['R']] },
        { label: '打开操作记录', chords: [['H']] },
        { label: '在仓库行之间移动焦点', chords: [['J', 'K'], ['↑', '↓']] },
        { label: '从搜索框进入仓库列表', chords: [['↓']] },
        { label: '打开所选仓库详情', chords: [['Enter']] },
        { label: '关闭抽屉或弹窗', chords: [['Esc'], ['⌘ / Ctrl', '[']] },
        { label: '显示本帮助', chords: [['?']] },
      ]
));
/** 有焦点层打开时，被遮住的后台内容对读屏和脚本都不应再可达；画布自身保持可交互。 */
const appBackgroundInert = computed(() => activeFocusLayers.value.length > 0);
// 滚动锁与 inert 用同一份层状态：关掉最后一层就无条件摘锁，不等 DOM 里的遮罩节点消失。
useScrollLock('app', () => activeFocusLayers.value.length > 0);

let previousFocusLayers: string[] = [];
const focusReturnTargets = new Map<string, HTMLElement>();
const focusReturnOverrides = new Map<string, HTMLElement>();

watch(
  activeFocusLayers,
  async (layers) => {
    let sharedDepth = 0;
    while (layers[sharedDepth] && layers[sharedDepth] === previousFocusLayers[sharedDepth]) sharedDepth += 1;
    const removedLayers = previousFocusLayers.slice(sharedDepth).reverse();
    const addedLayers = layers.slice(sharedDepth);
    if (removedLayers.length === 0 && addedLayers.length === 0) {
      previousFocusLayers = [...layers];
      return;
    }
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (const layer of addedLayers) {
      const explicitTarget = focusReturnOverrides.get(layer);
      focusReturnOverrides.delete(layer);
      const semanticTarget = explicitTarget ?? focusReturnFallback(layer);
      if (semanticTarget) focusReturnTargets.set(layer, semanticTarget);
      else if (activeElement) focusReturnTargets.set(layer, activeElement);
    }
    const returnTarget = removedLayers
      .map((layer) => {
        const target = focusReturnTargets.get(layer) ?? null;
        focusReturnTargets.delete(layer);
        return target;
      })
      .find(Boolean) ?? null;
    const removedLayer = removedLayers[0] ?? null;
    previousFocusLayers = [...layers];
    await nextTick();
    // 关掉最后一层时 `inert` 的摘除与组件更新在同一轮渲染里，而 sync watcher 里的
    // 第一个 nextTick 可能早于这轮渲染：此时对后台元素调用 focus() 会被 inert 静默吞掉，
    // 焦点最终落到 body。多等一轮，确保后台已经可聚焦。
    if (layers.length === 0 && document.querySelector('[inert]')) await nextTick();
    const fallbackTarget = removedLayer ? focusReturnFallback(removedLayer) : null;
    if (addedLayers.length > 0) focusInitialControl();
    else if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    else if (fallbackTarget) fallbackTarget.focus({ preventScroll: true });
    else if (layers.length > 0) focusInitialControl();
  },
  { flush: 'sync' },
);
watch(
  activeFocusLayers,
  async (layers, previousLayers) => {
    const openedLayer = layers.length > previousLayers.length || (
      layers.length === previousLayers.length && layers.at(-1) !== previousLayers.at(-1)
    );
    if (!openedLayer) return;
    await nextTick();
    requestAnimationFrame(() => {
      if (activeFocusLayers.value.length === layers.length && activeFocusLayers.value.at(-1) === layers.at(-1)) {
        focusInitialControl();
      }
    });
  },
  { flush: 'post' },
);
const hasUnsavedProfileChanges = computed(() => profileHasUnsavedChanges(query.data.value?.profile.profile));
const hasUnsavedRepositoryEdit = computed(() =>
  Boolean(repositoryEdit.value && JSON.stringify(repositoryEdit.value) !== repositoryEditSnapshot.value),
);

/**
 * 距离下一轮自动 Fetch 还有多久。0 表示「已经到期，正在起批次」。
 *
 * 关闭自动 Fetch 时返回 `null`——调用方据此不显示任何倒计时文案。
 */
const autoFetchRemainingMs = computed<number | null>(() => {
  const interval = configuredAutoFetchInterval.value;
  if (interval === 0) return null;
  if (autoFetchRetryPending) return Math.max(0, autoFetchRetryAt - autoFetchClock.value);
  return autoFetchDelayMs(interval, readLastAutoFetchAt(), autoFetchClock.value);
});

const autoFetchCountdownLabel = computed(() => {
  const remaining = autoFetchRemainingMs.value;
  return remaining === null ? '' : autoFetchRemainingLabel(remaining);
});

/** Fetch 按钮的补充提示：让「再等多久自动跑」变成可见信息，而不是等用户猜。 */
const automaticFetchHint = computed(() =>
  autoFetchCountdownLabel.value ? `自动 Fetch ${autoFetchCountdownLabel.value}` : '自动 Fetch 已关闭',
);

const autoFetchDescription = computed(() => {
  const interval = profileForm.autoFetchIntervalMinutes;
  if (interval === 0) return '关闭时只刷新本地状态，不主动访问远端';
  // 草稿里的周期还没保存，倒计时按已生效的值算，文案里只解释节奏。
  const countdown = autoFetchCountdownLabel.value;
  return `浏览器打开期间每 ${autoFetchIntervalLabel(interval)} Fetch 全部已启用仓库${countdown ? `，下一轮${countdown}` : ''}`;
});

type ManageSection = 'update' | 'feedback' | 'profile' | 'appearance' | 'ai' | 'remote' | 'repositories' | 'transfer';

// 设置弹窗的分区导航沿用仓库工作台侧栏同一套写法（RepositoryWorkspace 的 nav）：
// button + aria-current="page" + 计数徽标，不引入第二套标签页语义。
const manageNav = computed(() => [
  { id: 'update' as const, label: '检查更新', icon: CloudDownload, count: updateAvailable.value ? 1 : null },
  { id: 'feedback' as const, label: '反馈', icon: MessageCircle, count: null },
  { id: 'profile' as const, label: '个人信息', icon: UserRound, count: null },
  { id: 'appearance' as const, label: '界面显示', icon: Palette, count: null },
  { id: 'ai' as const, label: 'AI 服务', icon: Bot, count: null },
    // 计数即「缺凭证的 https 主机数」：让用户在 Fetch 失败之前就能看到待处理项。
    { id: 'remote' as const, label: '远端', icon: Link2, count: missingCredentialCount.value || null },
  { id: 'repositories' as const, label: '仓库接入', icon: FolderGit2, count: repositories.value.length },
  { id: 'transfer' as const, label: '配置迁移', icon: ArrowLeftRight, count: null },
]);

const canApplyStash = computed(() => {
  const repository = selectedRepository.value;
  return Boolean(
    repository &&
      repository.staged === 0 &&
      repository.modified === 0 &&
      repository.untracked === 0 &&
      repository.conflicted === 0 &&
      !repository.inProgressOperation,
  );
});

function relativeTime(value: string | null | undefined): string {
  return sharedRelativeTime(value, { empty: '—' });
}

function rootUsageCount(rootId: string): number {
  return repositories.value.filter((repository) => repository.config.root === rootId).length;
}

function clearOperationFilters(): void {
  operationRepositoryFilter.value = 'all';
  operationTypeFilter.value = 'all';
  operationStateFilter.value = 'all';
  operationNeedsAttentionOnly.value = false;
}

function toggleOperationNeedsAttention(): void {
  operationNeedsAttentionOnly.value = !operationNeedsAttentionOnly.value;
  if (operationNeedsAttentionOnly.value) operationStateFilter.value = 'all';
}

function toggleSuccessfulFetchBatch(batchId: string): void {
  const expanded = new Set(expandedSuccessfulFetchBatchIds.value);
  if (expanded.has(batchId)) expanded.delete(batchId);
  else expanded.add(batchId);
  expandedSuccessfulFetchBatchIds.value = expanded;
}

async function refreshOperations(): Promise<void> {
  if (operationRefreshBusy.value || operationsQuery.isFetching.value) return;
  operationRefreshBusy.value = true;
  try {
    await operationsQuery.refetch();
  } finally {
    operationRefreshBusy.value = false;
  }
}

function resetRepositoryFilters(): void {
  search.value = '';
  stateFilter.value = 'all';
  groupFilter.value = null;
}

function filterFromSummary(filter: RepositoryFilterMode): void {
  search.value = '';
  groupFilter.value = null;
  stateFilter.value = filter;
}

function moveRovingFocus(event: KeyboardEvent, selector: string): void {
  const current = event.currentTarget;
  if (!(current instanceof HTMLButtonElement)) return;
  const controls = [...(current.parentElement?.querySelectorAll<HTMLButtonElement>(selector) ?? [])]
    .filter((control) => !control.disabled && control.getAttribute('aria-hidden') !== 'true');
  if (controls.length === 0) return;
  const currentIndex = controls.indexOf(current);
  if (currentIndex < 0) return;
  let nextIndex: number | null = null;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = controls.length - 1;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % controls.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + controls.length) % controls.length;
  if (nextIndex === null) return;
  event.preventDefault();
  controls[nextIndex]?.focus({ preventScroll: true });
}

function applyManageSection(key: ManageSection): void {
  manageSection.value = key;
  managePane.value?.scrollTo({ top: 0 });
  if (key === 'feedback') void loadFeedback();
}

/** 配置迁移里新增了根目录或导入了仓库：整页重取一次，导航计数与仓库列表才会同步。 */
function refreshAfterTransfer(): void {
  void query.refetch();
}

/**
 * 迁移导入应用了主题与字体。
 *
 * 这几项在「首次同步」之后就不再跟着 dashboard 覆盖（用户可能在别处改过缓存），
 * 所以服务端刚写进去的值要显式灌回本地 ref；主题的 watch 会顺手落一次缓存与原生标题栏。
 */
function applyImportedAppearance(appearance: ConfigurationAppearance): void {
  theme.value = appearance.theme;
  interfaceFont.value = appearance.interfaceFont ?? defaultInterfaceFont;
  interfaceFontSize.value = appearance.interfaceFontSize ?? defaultInterfaceFontSize;
  codeFont.value = appearance.codeFont ?? defaultCodeFont;
  codeFontSize.value = appearance.codeFontSize ?? null;
  void query.refetch();
}

/**
 * WKWebView 里鼠标点击按钮不保证取得键盘焦点，而旧分区的控件会随 `v-if` 卸载、焦点落回 body，
 * 所以切换分区后必须显式把焦点放到被选中的导航按钮上。
 */
function selectManageSection(key: ManageSection, event?: Event): void {
  applyManageSection(key);
  const target = event?.currentTarget;
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

function moveManageSectionFocus(event: KeyboardEvent, index: number): void {
  const items = manageNav.value;
  let nextIndex: number | null = null;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = items.length - 1;
  else if (event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
  else if (event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
  if (nextIndex === null) return;
  event.preventDefault();
  const current = event.currentTarget;
  const button = current instanceof HTMLElement
    ? [...(current.parentElement?.querySelectorAll<HTMLButtonElement>('.manage-nav-item') ?? [])][nextIndex]
    : undefined;
  applyManageSection(items[nextIndex].id);
  button?.focus({ preventScroll: true });
}

async function focusRepositoryList(): Promise<void> {
  await nextTick();
  const region = repositoryListRegion.value;
  if (!region) return;
  const firstRepository = region.querySelector<HTMLTableRowElement>('tbody tr[tabindex="0"]');
  const target = firstRepository ?? region;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: firstRepository ? 'center' : 'start', behavior: 'smooth' });
}

async function focusActiveList(): Promise<void> {
  if (activeWorkspace.value === 'sessions') {
    await nextTick();
    sessionRelay.value?.focusList();
    return;
  }
  if (activeWorkspace.value === 'analytics') {
    await nextTick();
    document.getElementById('analytics-panel')?.focus();
    return;
  }
  await focusRepositoryList();
}

async function copyToClipboard(value: string | null, label: string): Promise<void> {
  if (!value) return;
  actionError.value = '';
  if (await copyText(value)) actionMessage.value = `${label}已复制`;
  else actionError.value = `${label}复制失败，请检查剪贴板权限`;
}

/** 刚复制过名字的仓库 id；1.4 秒后按钮复原成复制图标。 */
const copiedRepositoryId = ref<string | null>(null);
/** 供读屏播报的一句「已复制」——图标换勾对看不见屏幕的人没有信息量。 */
const copyAnnouncement = ref('');
let copiedRepositoryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 复制单个仓库名。
 *
 * 成功不写消息条：名字常常连着复制好几个，一条条消息会把表格顶来顶去，
 * 反而找不到刚复制的那一行。反馈就地做——按钮换成勾，1.4 秒后复原。
 * 失败则必须说出来：剪贴板静默失败，用户会拿着上一次的内容去粘贴。
 *
 * 开头先清错误：消息按容器存放、留到下一次操作接替它，成功又不写消息条，
 * 于是上一次的「复制失败」会一直挂在页面上——用户刚复制成功，红字却还在。
 */
async function copyRepositoryName(repository: RepositoryStatus): Promise<void> {
  const name = repository.config.name;
  actionError.value = '';
  if (!(await copyText(name))) {
    actionError.value = `复制「${name}」失败，请检查剪贴板权限`;
    return;
  }
  copiedRepositoryId.value = repository.config.id;
  copyAnnouncement.value = `已复制仓库名称 ${name}`;
  if (copiedRepositoryTimer) clearTimeout(copiedRepositoryTimer);
  copiedRepositoryTimer = setTimeout(() => {
    copiedRepositoryId.value = null;
  }, 1400);
}

function openHistory(): void {
  closeDiffDialog();
  selectedRepository.value = null;
  manageOpen.value = false;
  historyOpen.value = true;
}

function openManage(event?: Event, section: ManageSection = 'profile'): void {
  const target = event?.currentTarget;
  if (target instanceof HTMLElement) focusReturnOverrides.set('manage', target);
  manageSection.value = section;
  manageOpen.value = true;
}

/**
 * 从失败的 Fetch / Pull / Push 记录，直接跳到凭证录入。
 * 主机名预填好并把焦点送进用户名输入框，用户不必自己判断该配哪台主机。
 */
async function configureCredentialFor(operation: OperationRecord): Promise<void> {
  const host = operationCredentialHost(operation);
  if (!host) return;
  openManage(undefined, 'remote');
  credentialForm.host = host;
  credentialForm.username = '';
  credentialForm.secret = '';
  credentialSecretVisible.value = false;
  await nextTick();
  const input = credentialUsernameInput.value;
  input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input?.focus();
}

/**
 * 进入某个仓库的工作区抽屉。
 *
 * 只有一条入口语义：从哪儿进都行，Esc / 返回 **一律回到仓库列表**。
 *
 * 这里曾经按「从操作记录点进来」分成两种返回目标：那种情况下 Esc 会把抽屉内容换成
 * 操作记录，抽屉本身不关。两个抽屉都在右侧同一位置，用户看到的是「按了 Esc，抽屉还在」，
 * 于是反馈成「Esc 不能关闭（返回）了」。返回目标要可预测，比「回到上一个面板」重要。
 */
function selectRepository(repository: RepositoryStatus): void {
  closeDiffDialog();
  historyOpen.value = false;
  selectedRepository.value = repository;
}

/**
 * 行点击。拖选仓库名/路径后松手浏览器仍会派发 click，那不是「点了这一行」——
 * 否则用户想复制个路径，抽屉就被顶出来了。
 */
function selectRepositoryFromRow(event: MouseEvent, repository: RepositoryStatus): void {
  if (hasActiveSelectionWithin(event.currentTarget as Element)) return;
  selectRepository(repository);
}

/**
 * 关掉当前抽屉，回到仓库列表。
 *
 * 两条约束，都是被真实的「Esc 没反应」反馈逼出来的：
 *
 * 1. **不能**因为「有操作在跑」就提前 return。`commitBusy` / `branchSwitchBusy` 背后是
 *    服务端在执行的任务，关掉抽屉不会打断它们：`finally` 里按仓库上下文决定要不要清忙态，
 *    而切走的上下文由监听选中仓库的 watch 统一重置（见 `repository-busy-reset.test.ts`）。
 *    提前 return 的代价是 Esc / 返回按钮 / 点遮罩**完全没反应**，且没有任何提示。
 * 2. **不能**在关闭时改道去开另一个抽屉。以前从「操作记录」点进仓库，Esc 会把抽屉内容
 *    换成操作记录——抽屉还在原位，用户看到的就是「Esc 关不掉」。
 *
 * 3. **不能**被合并预览挡住。这一条原先是 `if (branchMerge.value) return;`——它和返回按钮上的
 *    `disabled` 绑定是一对：`branchMerge` 一旦常驻，Esc、返回、点遮罩
 *    **三条退路同时失效**，而且没有任何提示。合并预览开在抽屉里，抽屉关了它就没归属，
 *    正确做法是顺手把它回收掉，而不是让关闭反过来等它。
 * 4. **清场环节不能连累关闭本身**。`closeBranchMerge` / `closeDiffDialog` 里任何一处抛异常，
 *    后面两行就都跑不到，抽屉永远关不掉——而三条退路都走这个函数，症状就是「全哑」。
 *    所以清场放在 `try`，清状态放在 `finally`：清不干净也得先让用户回到列表。
 */
function closeDrawers(): void {
  try {
    if (branchMerge.value) closeBranchMerge();
    if (pushBranches.value) closePushBranches();
    closeDiffDialog();
  } finally {
    selectedRepository.value = null;
    historyOpen.value = false;
  }
}

function switchWorkspace(workspace: 'repositories' | 'sessions' | 'analytics'): void {
  if (activeWorkspace.value === workspace) return;
  closeDrawers();
  shortcutHelpOpen.value = false;
  // 「检查更新」面板跟着顶栏走，换工作区后停在一个没人点开过的弹层上是多余的。
  closeUpdatePanel();
  activeWorkspace.value = workspace;
}

function closeDiffDialog(): void {
  repositoryDiff.clear();
}

async function loadUpstreamRepairPlan(repositoryId: string): Promise<void> {
  const requestId = ++upstreamRepairRequest;
  upstreamRepairLoading.value = true;
  if (upstreamRepair.value?.repositoryId === repositoryId) upstreamRepair.value.error = '';
  try {
    const plan = await api.upstreamRepairPlan(repositoryId);
    const dialog = upstreamRepair.value;
    if (requestId !== upstreamRepairRequest || dialog?.repositoryId !== repositoryId) return;
    if (plan.upstream) {
      actionMessage.value = `${dialog.repositoryName}：当前分支已关联 ${plan.upstream}`;
      upstreamRepair.value = null;
      await query.refetch();
      return;
    }
    dialog.plan = plan;
    dialog.selectedUpstream = plan.recommendedUpstream ?? '';
    dialog.selectedRemote = plan.remotes.find((remote) => remote.default)?.name ?? plan.remotes[0]?.name ?? '';
  } catch (error) {
    const dialog = upstreamRepair.value;
    if (requestId === upstreamRepairRequest && dialog?.repositoryId === repositoryId) {
      dialog.error = error instanceof Error ? error.message : '读取 upstream 修复方案失败';
    }
  } finally {
    if (requestId === upstreamRepairRequest) upstreamRepairLoading.value = false;
  }
}

function openUpstreamRepair(repository: RepositoryStatus, event?: Event): void {
  // 判据用「有没有 upstream」而不是状态：脏工作区、领先提交都会盖掉 remote-unknown 状态，
  // 但那些情况同样需要这条出口（工作台里的「发布此分支…」就落在这些状态上）。
  if (repository.upstream) return;
  const target = event?.currentTarget;
  if (target instanceof HTMLElement) focusReturnOverrides.set(`upstream:${repository.config.id}`, target);
  upstreamRepairRequest += 1;
  upstreamRepair.value = {
    repositoryId: repository.config.id,
    repositoryName: repository.config.name,
    plan: null,
    selectedUpstream: '',
    selectedRemote: '',
    error: '',
  };
  void loadUpstreamRepairPlan(repository.config.id);
}

function closeUpstreamRepair(): void {
  if (upstreamRepairBusy.value) return;
  upstreamRepairRequest += 1;
  upstreamRepairLoading.value = false;
  upstreamRepair.value = null;
}

async function executeUpstreamRepair(input: UpstreamRepairRequest): Promise<void> {
  const dialog = upstreamRepair.value;
  if (!dialog) return;
  const repositoryId = dialog.repositoryId;
  upstreamRepairBusy.value = true;
  dialog.error = '';
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.repairUpstream(repositoryId, input);
    if (selectedRepository.value?.config.id === repositoryId) {
      selectedRepository.value = output.result.status;
      branchSnapshot.value = output.result.branches;
    }
    upstreamRepair.value = null;
    actionMessage.value = `${dialog.repositoryName}：${output.operation.message}`;
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    const current = upstreamRepair.value;
    const message = error instanceof Error ? error.message : 'upstream 修复失败';
    if (current?.repositoryId === repositoryId) current.error = message;
    else actionError.value = `${dialog.repositoryName}：${message}`;
  } finally {
    upstreamRepairBusy.value = false;
  }
}

async function trackSelectedUpstream(): Promise<void> {
  const dialog = upstreamRepair.value;
  const plan = dialog?.plan;
  if (!dialog || !plan || !dialog.selectedUpstream) return;
  await executeUpstreamRepair({
    mode: 'track',
    upstream: dialog.selectedUpstream,
    expectedBranch: plan.branch,
    expectedHead: plan.head,
  });
}

async function publishAndTrackUpstream(): Promise<void> {
  const dialog = upstreamRepair.value;
  const plan = dialog?.plan;
  if (!dialog || !plan || !dialog.selectedRemote || !plan.canPublish) return;
  const accepted = await requestConfirmation({
    title: '首次推送并关联 upstream',
    summary: '所选 remote 中没有可安全推断的同名分支，将创建远端分支。',
    target: `${dialog.repositoryName} · ${dialog.selectedRemote}/${plan.branch}`,
    details: [
      `先 Fetch ${dialog.selectedRemote}，再次确认远端分支尚不存在。`,
      '只推送预览时确认的 HEAD，使用明确 refspec，永远不会 force push。',
      'Push 成功后才写入本地 upstream；远端拒绝时保留当前配置。',
    ],
    confirmLabel: '首次 Push 并关联',
    tone: 'caution',
  });
  if (!accepted || upstreamRepair.value?.repositoryId !== dialog.repositoryId) return;
  await executeUpstreamRepair({
    mode: 'publish',
    remote: dialog.selectedRemote,
    expectedBranch: plan.branch,
    expectedHead: plan.head,
  });
}

async function closeManage(): Promise<void> {
  if (savingProfile.value) return;
  if (hasUnsavedProfileChanges.value) {
    const accepted = await requestConfirmation({
      title: '放弃未保存的个人配置',
      summary: '关闭后，本次尚未保存的个人偏好将恢复为上次保存值。',
      details: ['已添加的仓库和扫描根目录不会受影响。'],
      confirmLabel: '放弃更改',
      tone: 'caution',
    });
    if (!accepted) return;
    const saved = query.data.value?.profile.profile;
    if (saved) Object.assign(profileForm, saved);
  }
  manageOpen.value = false;
}

function openOperationRepository(operation: OperationRecord): void {
  const repository = repositories.value.find((item) => item.config.id === operation.repositoryId);
  if (!repository) {
    actionError.value = '该仓库已不在当前工作台中';
    return;
  }
  selectRepository(repository);
}

async function retryOperation(operation: OperationRecord): Promise<void> {
  if (!['fetch', 'pull', 'sync', 'push'].includes(operation.type)) return;
  // 单仓重试覆盖 sync；它不在 BatchOperationType 里，两者不是一回事。
  const type = operation.type as RetryableOperationType;
  let stashFirst = false;
  let rebase = false;
  if (type !== 'fetch') {
    const action = type === 'sync' ? '同步' : type.toUpperCase();
    const state = repositories.value.find((item) => item.config.id === operation.repositoryId);
    const hasChanges = state
      ? state.staged + state.modified + state.untracked + state.deleted + state.renamed > 0
      : false;
    // 重试要和首次操作同一套选项。少了它们：用 Rebase 的人重试一次会静默变成 merge
    // （历史里凭空多一个合并提交），靠自动 Stash 才拉下来的人重试会再撞一次「工作区不干净」。
    const autoStash: ConfirmationCheckbox | undefined = type !== 'push' && hasChanges
      ? {
          id: 'auto-stash',
          label: '自动 Stash 本地改动',
          description: '先暂存工作区改动，完成后自动恢复；恢复冲突时改动仍保留在 Stash 列表',
          value: true,
        }
      : undefined;
    const useRebase: ConfirmationCheckbox | undefined = type === 'pull' || type === 'sync'
      ? {
          id: 'use-rebase',
          label: '用 Rebase 代替 Merge',
          description: '把本地提交重放到远端最新提交之上，产生线性历史，不产生合并提交',
          value: false,
        }
      : undefined;
    const checkboxes = [autoStash, useRebase].filter((box): box is ConfirmationCheckbox => box !== undefined);
    const accepted = await requestConfirmation({
      title: `重试 ${action}`,
      summary: `将重新执行这条失败或被安全条件阻止的 ${action} 操作。`,
      target: operation.repositoryName,
      details: type === 'pull'
        ? ['默认 merge（分叉时产生合并提交），可勾选 rebase（线性历史）。', '工作区不干净时可勾选自动 Stash。']
        : type === 'sync'
          ? ['整合远端后自动推送；默认 merge，可勾选 rebase；冲突会暂停处理。']
          : ['执行前会先 Fetch 复核远端状态。', '使用明确 refspec，永远不会 force push。'],
      confirmLabel: `重试 ${action}`,
      tone: 'caution',
      checkboxes: checkboxes.length > 0 ? checkboxes : undefined,
    });
    if (!accepted) return;
    stashFirst = autoStash?.value === true;
    rebase = useRebase?.value === true;
  }
  operationRetryId.value = operation.id;
  actionError.value = '';
  try {
    const output =
      type === 'fetch'
        ? await api.fetchRepository(operation.repositoryId)
        : type === 'pull'
          ? await api.pullRepository(operation.repositoryId, { stashFirst, rebase })
          : type === 'sync'
            ? await api.syncRepository(operation.repositoryId, { stashFirst, rebase })
            : await api.pushRepository(operation.repositoryId);
    cacheRepositoryStatus(output.result);
    actionMessage.value = `${operation.repositoryName}：${output.operation.message}`;
    await Promise.all([operationsQuery.refetch(), query.refetch()]);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '重试 Git 操作失败';
    await operationsQuery.refetch();
  } finally {
    operationRetryId.value = null;
  }
}

async function retryActiveBatchIssues(): Promise<void> {
  const batch = activeBatch.value;
  const repositoryIds = retryableBatchRepositoryIdsList.value;
  if (!batch || batch.state !== 'completed' || repositoryIds.length === 0) return;
  if (batch.type !== 'fetch') {
    const action = batchTypeLabel(batch.type);
    const accepted = await requestConfirmation({
      title: `重试批量安全 ${action}`,
      summary: `将失败或被安全条件阻止的 ${repositoryIds.length} 个仓库重新组成一个批次。`,
      target: `${action} · ${repositoryIds.length} 个未完成仓库`,
      details: batchRetryConfirmationDetails(batch.type),
      confirmLabel: `重试 ${repositoryIds.length} 个仓库`,
      tone: 'caution',
    });
    if (!accepted) return;
  }
  batchRetryBusy.value = true;
  actionError.value = '';
  try {
    const { batch: nextBatch } = await api.startBatch(batch.type, repositoryIds);
    activeBatchId.value = nextBatch.id;
    actionMessage.value = `批量 ${batchTypeLabel(batch.type)} 未完成项已重新入队，共 ${nextBatch.total} 个仓库`;
    await operationsQuery.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量重试启动失败';
    await operationsQuery.refetch();
  } finally {
    batchRetryBusy.value = false;
  }
}

/**
 * 在仓库行之间移动焦点（`j` / `k`）。
 * 已经聚焦某一行时从该行出发，否则从列表首行（`j`）或末行（`k`）进入。
 */
function focusAdjacentRepositoryRow(delta: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>('.repo-table tbody tr')];
  if (rows.length === 0) return;
  const currentIndex = rows.findIndex((row) => row === document.activeElement);
  const nextIndex = currentIndex < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
  rows[nextIndex]?.focus();
}

/**
 * 外壳的 Esc 兜底。
 *
 * 这颗键**可能在到达网页之前就没了**（输入法的事件 tap、WebKit 的 `cancelOperation:`
 * 响应链），页面自己无从知道「按过但没送到」。所以由外壳补一刀（见 `MooFleetApp.swift`
 * 的 `installEscapeFallback`）：外壳收到 Esc 后等 150 ms 再问页面一句，没人认领就替它关抽屉。
 *
 * 判据是**「有没有人真的处理」**，不是「页面有没有收到」——这两个曾经被我混成一个：
 * 时间戳记在捕获阶段，只要键到了页面就算「处理过」。于是「键到了、但被某个子层
 * `stopPropagation` 吞掉、什么也没发生」这种情形，兜底会误判成「已处理」而袖手旁观，
 * 用户看到的就是「Esc 和返回都按了，只有 Esc 没反应」。
 *
 * 现在改成看 `event.defaultPrevented`：抽屉里所有处理 Esc 的层（下拉、右键菜单、
 * 分支面板、重命名输入框、拖拽取消、全局快捷键链）都会 `preventDefault`，
 * 而「被吞掉」那条路不会。分发结束后才读得到这个值，所以放进 `setTimeout(0)`。
 */
const escapeFallbackGraceMs = 200;
let lastEscapeHandledAt = 0;

/**
 * 这颗键到底是不是 Esc。
 *
 * 不能只认 `event.key === 'Escape'`：输入法（以及部分键盘映射）会把 Esc 报成
 * `'Process'` 或 `'Unidentified'`，此时 `keyCode` 仍然是 27。只认 `key` 的写法
 * 会把这次按键**静默丢掉**——用户看到的就是「按 Esc 完全没反应，但返回和 ⌘[ 都正常」。
 * `code` 是物理键位，不受输入法影响，三个里任意一个命中就算。
 */
function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === 'Escape' || event.code === 'Escape' || event.keyCode === 27;
}

function noteEscapeKeydown(event: KeyboardEvent): void {
  if (!isEscapeKey(event)) return;
  setTimeout(() => {
    if (event.defaultPrevented) lastEscapeHandledAt = Date.now();
  }, 0);
}
function installEscapeFallback(): void {
  (window as unknown as { __fleetEscapeFallback?: () => void }).__fleetEscapeFallback = () => {
    // 有人处理过（preventDefault 过）就别重复关一层。
    if (Date.now() - lastEscapeHandledAt < escapeFallbackGraceMs) return;
    // 只补仓库抽屉：其余遮挡层各有自己的入口，替它们做决定容易关错层。
    if (!selectedRepository.value) return;
    closeDrawers();
  };
}

function handleGlobalShortcut(event: KeyboardEvent): void {
  if (trapDialogFocus(event)) return;
  if (isEscapeKey(event)) {
    event.preventDefault();
    if (confirmation.value) settleConfirmation(false);
    else if (branchMerge.value) closeBranchMerge();
    else if (pushBranches.value) closePushBranches();
    else if (batchPushBranches.value) closeBatchPushBranches();
    else if (batchMerge.value) closeBatchMerge();
    else if (batchPull.value) closeBatchPull();
    else if (upstreamRepair.value) closeUpstreamRepair();
    else if (shortcutHelpOpen.value) shortcutHelpOpen.value = false;
    else if (updatePanelOpen.value) closeUpdatePanel(true);
    else if (repositoryEdit.value) void closeRepositoryEditor();
    else if (cloneDialogOpen.value) closeCloneDialog();
    else if (manageOpen.value) void closeManage();
    else if (branchPanelOpen.value) closeBranchPanel(true);
    else closeDrawers();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c' && selectedRepository.value && activeFocusLayers.value.length === 1 && !branchPanelOpen.value) {
    event.preventDefault();
    repositoryWorkspace.value?.showWorking();
    void nextTick(() => commitComposer.value?.focus());
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && selectedRepository.value && activeFocusLayers.value.length === 1 && !branchPanelOpen.value) {
    event.preventDefault();
    repositoryWorkspace.value?.focusSearch();
    return;
  }
  /**
   * Esc 的备胎。
   *
   * Esc 可能在到达网页之前就被吞掉（输入法的事件 tap、WebKit 的 `cancelOperation:`
   * 响应链），而 ⌘[ 走的是普通组合键，不会被当成「取消」处理。返回按钮永远可点，
   * 这颗键是它的键盘等价物——`Alt+←/→` 已经被阅读位置占了。
   */
  if ((event.metaKey || event.ctrlKey) && event.key === '[' && selectedRepository.value) {
    event.preventDefault();
    closeDrawers();
    return;
  }
  if (activeFocusLayer()) return;
  if (isEditableTarget(event.target)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    closeDrawers();
    // 快捷键要落在当前工作区上：会话页有它自己的搜索框。
    if (activeWorkspace.value === 'sessions') sessionRelay.value?.focusSearch();
    else requestAnimationFrame(() => searchInput.value?.focus());
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '?') {
    event.preventDefault();
    shortcutHelpOpen.value = true;
  } else if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    if (activeWorkspace.value === 'sessions') sessionRelay.value?.refresh();
    else void refresh();
  } else if (event.key.toLowerCase() === 'h') {
    // 操作记录只属于仓库舰队，顶栏在会话页也隐藏了这个入口。
    if (activeWorkspace.value !== 'repositories') return;
    event.preventDefault();
    openHistory();
  } else if (event.key.toLowerCase() === 'j' || event.key.toLowerCase() === 'k') {
    if (activeWorkspace.value !== 'repositories') return;
    event.preventDefault();
    focusAdjacentRepositoryRow(event.key.toLowerCase() === 'j' ? 1 : -1);
  }
}

function readLastAutoFetchAt(): number | null {
  const persistedBatchAt = latestFetchBatchAt(operationsQuery.data.value?.batches ?? []);
  let browserAt: number | null = lastAutoFetchAtMemory;
  try {
    browserAt = parseLastAutoFetchAt(localStorage.getItem(autoFetchLastRunStorageKey)) ?? browserAt;
  } catch {
    // Persisted operation history remains authoritative across random macOS ports.
  }
  return Math.max(...[persistedBatchAt, browserAt].filter((value): value is number => value !== null), 0) || null;
}

function rememberAutoFetchAt(timestamp: number): void {
  lastAutoFetchAtMemory = timestamp;
  try {
    localStorage.setItem(autoFetchLastRunStorageKey, String(timestamp));
  } catch {
    // In-memory scheduling still prevents repeated Fetches in this tab.
  }
}

function forgetAutoFetchAt(timestamp: number): void {
  if (lastAutoFetchAtMemory === timestamp) lastAutoFetchAtMemory = null;
  try {
    if (parseLastAutoFetchAt(localStorage.getItem(autoFetchLastRunStorageKey)) === timestamp) {
      localStorage.removeItem(autoFetchLastRunStorageKey);
    }
  } catch {
    // The next timer tick can retry from in-memory state.
  }
}

function claimFallbackAutoFetchLease(now: number): boolean {
  try {
    const current = JSON.parse(localStorage.getItem(autoFetchLeaseStorageKey) ?? 'null') as {
      owner?: unknown;
      expiresAt?: unknown;
    } | null;
    if (current && typeof current.expiresAt === 'number' && current.expiresAt > now && current.owner !== autoFetchOwner) {
      return false;
    }
    const lease = { owner: autoFetchOwner, expiresAt: now + 120_000 };
    localStorage.setItem(autoFetchLeaseStorageKey, JSON.stringify(lease));
    const saved = JSON.parse(localStorage.getItem(autoFetchLeaseStorageKey) ?? 'null') as { owner?: unknown } | null;
    return saved?.owner === autoFetchOwner;
  } catch {
    return true;
  }
}

function releaseFallbackAutoFetchLease(): void {
  try {
    const current = JSON.parse(localStorage.getItem(autoFetchLeaseStorageKey) ?? 'null') as { owner?: unknown } | null;
    if (current?.owner === autoFetchOwner) localStorage.removeItem(autoFetchLeaseStorageKey);
  } catch {
    // The short lease expires by itself.
  }
}

async function withAutoFetchLock(task: () => Promise<void>): Promise<void> {
  if ('locks' in navigator && navigator.locks) {
    await navigator.locks.request(autoFetchLockName, { ifAvailable: true }, async (lock) => {
      if (lock) await task();
    });
    return;
  }
  if (!claimFallbackAutoFetchLease(Date.now())) return;
  try {
    await task();
  } finally {
    releaseFallbackAutoFetchLease();
  }
}

function nextAutoFetchDeadline(now: number): number | null {
  if (autoFetchRetryPending) return autoFetchRetryAt;
  const remaining = autoFetchDelayMs(configuredAutoFetchInterval.value, readLastAutoFetchAt(), now);
  return remaining === null ? null : now + remaining;
}

/**
 * 把下一次评估精确排在「自动 Fetch 到期那一刻」，而不是每分钟撞一次运气。
 *
 * 旧写法是 `setInterval(60_000)`：周期到点之后，最坏还要再等满一分钟才真正开跑，
 * 66 个仓库的实际 Fetch 只要 9 秒，白等的那一分钟比干活本身还长。
 *
 * 下限 3 秒是给「已到期但被前台批次挡住」留的退路：那种情况下批次状态变化会通过
 * watch 立刻再评估一次，这里的 3 秒只是兜底，不会空转烧 CPU。
 */
function scheduleAutomaticFetchCheck(): void {
  if (autoFetchTimer !== null) {
    window.clearTimeout(autoFetchTimer);
    autoFetchTimer = null;
  }
  const now = Date.now();
  const deadline = nextAutoFetchDeadline(now);
  if (deadline === null) return;
  autoFetchTimer = window.setTimeout(() => void runAutomaticFetchCheck(), Math.max(deadline - now, 3_000));
}

/** 所有评估入口（定时器、focus、online、watch）都走这里，确保评估完一定重排下一次。 */
async function runAutomaticFetchCheck(): Promise<void> {
  try {
    await maybeRunAutomaticFetch();
  } finally {
    scheduleAutomaticFetchCheck();
  }
}

async function maybeRunAutomaticFetch(): Promise<void> {
  const interval = configuredAutoFetchInterval.value;
  if (
    interval === 0 ||
    repositories.value.length === 0 ||
    !navigator.onLine ||
    operationsQuery.isLoading.value ||
    batchStarting.value !== null ||
    activeBatch.value?.state === 'running' ||
    // 上一轮被用户操作挤掉的自动 Fetch 会在两分钟后补跑；这期间别反复起批次。
    (autoFetchRetryPending && Date.now() < autoFetchRetryAt)
  ) return;

  await withAutoFetchLock(async () => {
    const now = Date.now();
    // 补跑不按周期判定：被挤掉的那轮本身已经「用掉」了这个周期的时间戳。
    if (!autoFetchRetryPending && !isAutoFetchDue(interval, readLastAutoFetchAt(), now)) return;
    autoFetchRetryPending = false;
    rememberAutoFetchAt(now);
    batchStarting.value = 'fetch';
    try {
      // 后台批次：用户在下一次点批量 Pull / Push 时，它会当场把仓库让出来。
      const { batch } = await api.startBatch('fetch', repositories.value.map((repository) => repository.config.id), { background: true });
      autoFetchBatchId = batch.id;
      activeBatchId.value = batch.id;
      // 不说。批次一开，操作记录抽屉就被推到面前，序号、成败、进度都在里面；
      // 这句「已加入队列」只是把按钮上刚点过的事重念一遍，还会顶掉上一条用户真做过的结论。
      // 同样不 await：自动 Fetch 是后台的，不该因为刷新列表而多挡住批量按钮几百毫秒。
      void operationsQuery.refetch();
    } catch (error) {
      if (error instanceof Error && error.message.includes('相同仓库集合的 Git 批次已有实例正在执行')) {
        // 别的实例已经在做同一件事。归属舰队页、强度是后台进度：舰队页手上若还有
        // 一条用户刚做出来的结论，这条不许顶掉它。
        notices.notify('progress', '自动 Fetch 已由其他 Moo Fleet 实例执行', 'workspace:repositories');
      } else {
        forgetAutoFetchAt(now);
        // 后台起不来与用户正看着哪块面板无关：固定落舰队页，抽屉盖着时靠未读圆点提示。
        notices.notify(
          'error',
          error instanceof Error ? `自动 Fetch 启动失败：${error.message}` : '自动 Fetch 启动失败',
          'workspace:repositories',
        );
      }
    } finally {
      batchStarting.value = null;
    }
  });
}

function handleWindowFocus(): void {
  void runAutomaticFetchCheck();
}

function handleDocumentScroll(): void {
  document.documentElement.classList.add('is-scrolling');
  if (scrollbarVisibilityTimer !== null) window.clearTimeout(scrollbarVisibilityTimer);
  scrollbarVisibilityTimer = window.setTimeout(() => {
    document.documentElement.classList.remove('is-scrolling');
    scrollbarVisibilityTimer = null;
  }, 650);
}

watch(
  [
    configuredAutoFetchInterval,
    () => repositories.value.length,
    () => operationsQuery.data.value?.batches,
    // 冷启动时仓库清单和批次还在路上，评估会被闸门挡掉。加载一结束就补评一次，
    // 否则「打开应用」到「真正开始 Fetch」之间可能差掉一整个周期。
    () => operationsQuery.isLoading.value,
  ],
  () => void runAutomaticFetchCheck(),
  { flush: 'post' },
);

/**
 * 自动 Fetch 被用户操作挤掉后安排补跑：先 20 秒，连续被挤才逐步退到 2 分钟。
 *
 * 不补跑的话，让路的代价是「这半小时都不再刷新」——用户越是忙着推代码，列表越不准。
 */
watch(
  () => operationsQuery.data.value?.batches,
  (batches) => {
    if (!autoFetchBatchId) return;
    const record = batches?.find((batch) => batch.id === autoFetchBatchId);
    if (!record || record.state === 'running') return;
    autoFetchBatchId = null;
    if (!record.interrupted) {
      // 完整跑完一轮说明冲突窗口已经过去了，下次被挤重新从 20 秒起算。
      autoFetchRetryStep = 0;
      return;
    }
    autoFetchRetryPending = true;
    autoFetchRetryAt = Date.now() + autoFetchRetryDelays[Math.min(autoFetchRetryStep, autoFetchRetryDelays.length - 1)]!;
    autoFetchRetryStep = Math.min(autoFetchRetryStep + 1, autoFetchRetryDelays.length - 1);
  },
  { flush: 'post' },
);

onMounted(() => {
  connectOperationsStream();
  // 精确到期调度：不再每分钟盲扫一次，而是排到「下一轮到点」那一刻。
  scheduleAutomaticFetchCheck();
  autoFetchClockTimer = window.setInterval(() => {
    autoFetchClock.value = Date.now();
  }, autoFetchClockTickMs);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('online', runAutomaticFetchCheck);
  window.addEventListener('keydown', handleGlobalShortcut);
  window.addEventListener('keydown', noteEscapeKeydown, true);
  installEscapeFallback();
  document.addEventListener('pointerdown', handleBranchMenuPointerDown, true);
  document.addEventListener('scroll', handleDocumentScroll, true);
});
onBeforeUnmount(() => {
  if (confirmation.value) settleConfirmation(false);
  upstreamRepairRequest += 1;
  upstreamRepair.value = null;
  disconnectOperationsStream();
  if (autoFetchTimer !== null) window.clearTimeout(autoFetchTimer);
  autoFetchTimer = null;
  if (autoFetchClockTimer !== null) window.clearInterval(autoFetchClockTimer);
  autoFetchClockTimer = null;
  if (scrollbarVisibilityTimer !== null) window.clearTimeout(scrollbarVisibilityTimer);
  scrollbarVisibilityTimer = null;
  document.documentElement.classList.remove('is-scrolling');
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('online', runAutomaticFetchCheck);
  window.removeEventListener('keydown', handleGlobalShortcut);
  window.removeEventListener('keydown', noteEscapeKeydown, true);
  delete (window as unknown as { __fleetEscapeFallback?: () => void }).__fleetEscapeFallback;
  document.removeEventListener('pointerdown', handleBranchMenuPointerDown, true);
  document.removeEventListener('scroll', handleDocumentScroll, true);
});

async function refresh(): Promise<void> {
  if (dashboardRefreshBusy.value || query.isFetching.value) return;
  dashboardRefreshBusy.value = true;
  actionError.value = '';
  try {
    await query.refetch();
  } finally {
    dashboardRefreshBusy.value = false;
  }
}

async function refreshActiveWorkspace(): Promise<void> {
  if (activeWorkspace.value === 'sessions') {
    sessionRelay.value?.syncSessions();
    return;
  }
  if (activeWorkspace.value === 'analytics') {
    analyticsManualRefreshing.value = true;
    try {
      await queryClient.invalidateQueries({ queryKey: ['analytics', 'heatmap'] });
    } finally {
      analyticsManualRefreshing.value = false;
    }
    return;
  }
  await refresh();
}

async function persistProfile(successMessage: string): Promise<boolean> {
  savingProfile.value = true;
  actionError.value = '';
  try {
    await api.saveProfile({ ...profileForm });
    actionMessage.value = successMessage;
    await query.refetch();
    return true;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存失败';
    return false;
  } finally {
    savingProfile.value = false;
  }
}

async function saveProfile(): Promise<void> {
  await persistProfile('个人配置已保存');
}

async function saveDeepSeekKey(): Promise<void> {
  const apiKey = deepSeekApiKey.value.trim();
  if (!apiKey || savingDeepSeekApiKey.value) return;
  savingDeepSeekApiKey.value = true;
  actionError.value = '';
  try {
    await api.saveDeepSeekApiKey(apiKey);
    actionMessage.value = 'DeepSeek API Key 已安全保存';
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存 DeepSeek API Key 失败';
  } finally {
    savingDeepSeekApiKey.value = false;
  }
}

async function loadDeepSeekKey(): Promise<void> {
  if (loadingDeepSeekApiKey.value) return;
  loadingDeepSeekApiKey.value = true;
  try {
    deepSeekApiKey.value = (await api.loadDeepSeekApiKey()).apiKey;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取 DeepSeek API Key 失败';
  } finally {
    loadingDeepSeekApiKey.value = false;
  }
}

async function pasteDeepSeekKey(): Promise<void> {
  try {
    deepSeekApiKey.value = (await api.readSystemClipboard()).text;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取剪贴板失败';
  }
}

type CredentialState = 'ready' | 'missing' | 'ssh' | 'other';

/** 单个主机的凭证处境；驱动图标与文案，避免在模板里堆条件。 */
function credentialState(host: RemoteCredentialHost): CredentialState {
  if (host.protocol === 'https') return host.hasCredential ? 'ready' : 'missing';
  return host.protocol === 'ssh' ? 'ssh' : 'other';
}

function credentialStateLabel(host: RemoteCredentialHost): string {
  switch (credentialState(host)) {
    case 'ready':
      return '已保存';
    case 'missing':
      return '缺凭证';
    case 'ssh':
      return '走 SSH 密钥';
    default:
      return '不管理';
  }
}

function credentialProtocolLabel(host: RemoteCredentialHost): string {
  if (host.protocol === 'https') return 'HTTPS';
  return host.protocol === 'ssh' ? 'SSH' : '其他协议';
}

/** 缺凭证的 https 主机数；用作导航角标。 */
const missingCredentialCount = computed(
  () =>
    credentialOverview.value?.hosts.filter((host) => host.protocol === 'https' && !host.hasCredential).length ?? 0,
);

/** 主机的归并键，与后端 `protocol://host` 保持一致。 */
function credentialHostKey(protocol: string, host: string): string {
  return `${protocol}://${host}`;
}

/** 把舰队里的仓库按「协议 + 主机」分组，用于在主机行下展开逐仓切换。 */
const credentialHostRepositories = computed(() => {
  const grouped = new Map<string, RepositoryStatus[]>();
  for (const repository of repositories.value) {
    if (!repository.remoteUrl) continue;
    const parsed = parseRemoteUrl(repository.remoteUrl);
    if (!parsed.ok) continue;
    const key = credentialHostKey(parsed.shape.protocol, parsed.shape.host);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(repository);
    else grouped.set(key, [repository]);
  }
  return grouped;
});

function hostRepositories(host: RemoteCredentialHost): RepositoryStatus[] {
  return credentialHostRepositories.value.get(credentialHostKey(host.protocol, host.host)) ?? [];
}

/** 目标协议：https 与 ssh 互为反向；其它协议不提供切换。 */
function oppositeProtocol(protocol: RemoteCredentialHost['protocol']): RemoteProtocol | null {
  if (protocol === 'https') return 'ssh';
  if (protocol === 'ssh') return 'https';
  return null;
}

/** 该主机下能自动转换到目标协议的仓库（自定义端口等会被排除）。 */
function convertibleHostRepositories(host: RemoteCredentialHost): RepositoryStatus[] {
  const target = oppositeProtocol(host.protocol);
  if (!target) return [];
  return hostRepositories(host).filter((repository) => convertRemoteUrl(repository.remoteUrl ?? '', target).ok);
}

function toggleCredentialHost(host: RemoteCredentialHost): void {
  const key = credentialHostKey(host.protocol, host.host);
  const next = new Set(expandedCredentialHosts.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedCredentialHosts.value = next;
}

function isCredentialHostExpanded(host: RemoteCredentialHost): boolean {
  return expandedCredentialHosts.value.has(credentialHostKey(host.protocol, host.host));
}

/** 主机行批量切换按钮的文案，例如「全部切到 HTTPS」。 */
function hostSwitchLabel(host: RemoteCredentialHost): string {
  const target = oppositeProtocol(host.protocol);
  return target ? `全部切到 ${protocolLabel(target)}` : '';
}

/** 单仓切换按钮的文案。 */
function repositorySwitchLabel(repository: RepositoryStatus): string {
  const parsed = parseRemoteUrl(repository.remoteUrl ?? '');
  const target: RemoteProtocol = parsed.ok && parsed.shape.protocol === 'https' ? 'ssh' : 'https';
  return `切到 ${protocolLabel(target)}`;
}

/** 单个仓库：把远端地址在 SSH 与 HTTPS 之间切换。 */
async function switchRepositoryProtocol(repository: RepositoryStatus): Promise<void> {
  const parsed = parseRemoteUrl(repository.remoteUrl ?? '');
  const target: RemoteProtocol = parsed.ok && parsed.shape.protocol === 'https' ? 'ssh' : 'https';
  const conversion = convertRemoteUrl(repository.remoteUrl ?? '', target);
  if (!conversion.ok) {
    actionError.value = `${repository.config.name}：${conversion.reason}`;
    actionMessage.value = '';
    return;
  }
  const accepted = await requestConfirmation({
    title: `切换为 ${protocolLabel(target)}`,
    summary: `将把 ${repository.config.name} 的远端地址切换到 ${protocolLabel(target)}。`,
    target: repository.config.name,
    details: [
      conversion.url,
      '只改本地 .git/config，不动代码、历史与远端；可随时切回。',
      '切换后做一次只读连通性校验；若该地址在远端不存在会自动回滚。',
    ],
    confirmLabel: `切换为 ${protocolLabel(target)}`,
    tone: 'caution',
  });
  if (!accepted) return;
  remoteProtocolBusy.value = repository.config.id;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.switchRemoteProtocol(repository.config.id, target);
    actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    await Promise.all([query.refetch(), loadCredentials()]);
  } catch (error) {
    actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '切换远端协议失败'}`;
  } finally {
    remoteProtocolBusy.value = null;
  }
}

/** 批量：把某主机下的全部可转换仓库一次切到目标协议。 */
async function switchHostProtocol(host: RemoteCredentialHost): Promise<void> {
  const target = oppositeProtocol(host.protocol);
  if (!target) return;
  const targets = convertibleHostRepositories(host);
  if (targets.length === 0) {
    actionError.value = `${host.host} 下没有可自动切换到 ${protocolLabel(target)} 的仓库`;
    actionMessage.value = '';
    return;
  }
  const previews = targets
    .slice(0, 3)
    .map((repository) => {
      const conversion = convertRemoteUrl(repository.remoteUrl ?? '', target);
      return conversion.ok ? `${repository.config.name} → ${conversion.url}` : '';
    })
    .filter((line) => line.length > 0);
  const accepted = await requestConfirmation({
    title: `批量切换为 ${protocolLabel(target)}`,
    summary: `将把 ${host.host} 下的 ${targets.length} 个仓库远端地址切换到 ${protocolLabel(target)}。`,
    target: `${host.host} · ${targets.length} 个仓库`,
    details: [
      ...previews,
      ...(targets.length > 3 ? [`另有 ${targets.length - 3} 个仓库一并切换`] : []),
      '只改各仓库本地 .git/config，不动代码、历史与远端；可随时切回。',
      `切换后逐个做只读连通性校验，约需 ${Math.max(5, Math.ceil(targets.length / 4) * 2)} 秒；地址不可用的会自动回滚。`,
    ],
    confirmLabel: `切换 ${targets.length} 个仓库`,
    tone: 'caution',
  });
  if (!accepted) return;
  const key = credentialHostKey(host.protocol, host.host);
  remoteProtocolBusy.value = key;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const result = await api.switchRemoteProtocolBatch(target, targets.map((repository) => repository.config.id));
    const confirmed = result.switched.filter((item) => item.verification === 'reachable').length;
    const needsCredential = result.switched.filter((item) => item.verification === 'needs-credential').length;
    const parts = [`已切换 ${result.switched.length} 个`];
    if (confirmed > 0) parts.push(`${confirmed} 个已确认连通`);
    if (needsCredential > 0) parts.push(`${needsCredential} 个待录入凭证`);
    if (result.skipped.length) parts.push(`跳过 ${result.skipped.length} 个`);
    if (result.failed.length) parts.push(`失败 ${result.failed.length} 个`);
    actionMessage.value = `${host.host}：${parts.join('，')}`;
    if (result.failed.length) {
      actionError.value = `失败：${result.failed.map((item) => `${item.name}（${item.message}）`).join('；')}`;
    }
    await Promise.all([query.refetch(), loadCredentials()]);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量切换远端协议失败';
  } finally {
    remoteProtocolBusy.value = null;
  }
}

// —— 远端管理 ——
//
// 舰队级操作（fetch / pull / push / 协议切换）全部以配置里的「默认远端」为目标。
// 此前没有任何入口能修改远端本身：仓库缺 origin、或地址写错时，前置校验会挡住所有
// 联网操作而应用内无解。这里补上：列出 / 新增 / 改地址 / 重命名 / 删除。

/** 参与远端管理的仓库：与舰队操作口径一致，只看已启用的。 */
const remoteManagedRepositories = computed(() =>
  repositories.value.filter((repository) => repository.config.enabled),
);

function repositoryNameById(repositoryId: string): string {
  return repositories.value.find((repository) => repository.config.id === repositoryId)?.config.name ?? repositoryId;
}

/** 已拉取的远端列表；未展开过则为空数组。 */
function remotesOf(repositoryId: string): RepositoryRemote[] {
  return repositoryRemotes.value.get(repositoryId) ?? [];
}

function isRemotePanelExpanded(repositoryId: string): boolean {
  return expandedRemoteRepositories.value.has(repositoryId);
}

function isRemoteAdding(repositoryId: string): boolean {
  return remoteAddFor.value === repositoryId;
}

/**
 * 地址的即时校验，与服务端**共用同一份判定**（`parseRemoteTarget`），
 * 因此这里给出的原因和提交失败时看到的一模一样。空值交给「必填」处理。
 */
function remoteTargetProblem(raw: string): string {
  if (!raw.trim()) return '';
  const parsed = parseRemoteTarget(raw);
  return parsed.ok ? '' : parsed.reason;
}

/** 名字的即时校验同样共用共享判定，只是把措辞换成给用户看的。 */
function remoteNameProblem(raw: string, taken: string[] = []): string {
  const name = raw.trim();
  if (!name) return '';
  if (!isSafeRemoteName(name)) return '远端名只能用字母、数字、点、下划线与中划线，且不能以「-」开头';
  if (taken.includes(name)) return `已存在名为 ${name} 的远端`;
  return '';
}

async function toggleRepositoryRemotes(repositoryId: string): Promise<void> {
  const next = new Set(expandedRemoteRepositories.value);
  if (next.has(repositoryId)) {
    next.delete(repositoryId);
    if (remoteAddFor.value === repositoryId) remoteAddFor.value = null;
  } else {
    next.add(repositoryId);
  }
  expandedRemoteRepositories.value = next;
  // 首次展开才拉取：远端列表不进仪表盘负载，避免给每次扫描都加一个 git 进程。
  if (next.has(repositoryId) && !repositoryRemotes.value.has(repositoryId)) {
    await loadRepositoryRemotes(repositoryId);
  }
}

async function loadRepositoryRemotes(repositoryId: string): Promise<void> {
  remotesLoading.value = repositoryId;
  try {
    const snapshot = await api.repositoryRemotes(repositoryId);
    const next = new Map(repositoryRemotes.value);
    next.set(repositoryId, snapshot.remotes);
    repositoryRemotes.value = next;
    remoteDefaultName.value = snapshot.defaultRemote;
  } catch (error) {
    actionError.value = `${repositoryNameById(repositoryId)}：${error instanceof Error ? error.message : '读取远端列表失败'}`;
  } finally {
    remotesLoading.value = null;
  }
}

/**
 * 远端变动后的统一收尾。
 *
 * 用返回值里的 remotes 直接更新面板（省一次请求），但仓库状态仍走仪表盘刷新——
 * 远端地址会体现在 `remoteUrl` 上，而那是扫描结果，不重扫就会显示旧值。
 */
async function afterRemoteMutation(
  repositoryId: string,
  result: RepositoryRemoteMutation,
  message: string,
): Promise<void> {
  const remotes = new Map(repositoryRemotes.value);
  remotes.set(repositoryId, result.remotes);
  repositoryRemotes.value = remotes;
  remoteDefaultName.value = result.defaultRemote;
  // 改动的是默认远端（重命名 / 删除）时必须把风险说出来，而不是留到下次 Pull 才发现。
  actionMessage.value = `${repositoryNameById(repositoryId)}：${message}${result.warning ? `。${result.warning}` : ''}`;
  await query.refetch();
}

function openRemoteAdd(repositoryId: string): void {
  remoteAddFor.value = repositoryId;
  remoteAddForm.name = '';
  remoteAddForm.url = '';
}

/** 当前添加表单的问题（地址优先报），没有问题时为空串。 */
const remoteAddProblem = computed(() => {
  const repositoryId = remoteAddFor.value;
  if (!repositoryId) return '';
  const taken = remotesOf(repositoryId).map((remote) => remote.name);
  return remoteTargetProblem(remoteAddForm.url) || remoteNameProblem(remoteAddForm.name, taken);
});

/** 两个字段都有值且没有任何问题时才允许提交。 */
const remoteAddReady = computed(
  () => remoteAddFor.value !== null && Boolean(remoteAddForm.name.trim()) && Boolean(remoteAddForm.url.trim()) && !remoteAddProblem.value,
);

async function submitAddRemote(repositoryId: string): Promise<void> {
  if (!isRemoteAdding(repositoryId) || !remoteAddReady.value || remoteBusy.value) return;
  const name = remoteAddForm.name.trim();
  const url = remoteAddForm.url.trim();

  remoteBusy.value = `${repositoryId}:add`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.addRepositoryRemote(repositoryId, { name, url });
    await afterRemoteMutation(repositoryId, output.result, output.operation.message);
    remoteAddFor.value = null;
  } catch (error) {
    actionError.value = `${repositoryNameById(repositoryId)}：${error instanceof Error ? error.message : '添加远端失败'}`;
  } finally {
    remoteBusy.value = null;
  }
}

async function changeRemoteUrl(repositoryId: string, remote: RepositoryRemote): Promise<void> {
  if (remoteBusy.value) return;
  const label = repositoryNameById(repositoryId);
  const input: ConfirmationInput = {
    label: '新地址',
    value: remote.url,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return '请输入新地址';
      if (trimmed === remote.url) return '与当前地址相同';
      return remoteTargetProblem(trimmed);
    },
  };
  const accepted = await requestConfirmation({
    title: '修改远端地址',
    summary: `把 ${label} 的远端 ${remote.name} 指向新地址。`,
    target: `${label} · ${remote.name}`,
    details: [
      `当前地址：${remote.url}`,
      '只改本机 .git/config，不动代码、历史与远端服务器上的仓库。',
      ...(remote.pushUrl ? [`该远端另有独立推送地址（${remote.pushUrl}），本次只改 fetch 地址。`] : []),
    ],
    confirmLabel: '修改地址',
    tone: 'caution',
    input,
  });
  if (!accepted) return;
  const url = input.value.trim();
  if (!url || url === remote.url) return;

  remoteBusy.value = `${repositoryId}:${remote.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.setRepositoryRemoteUrl(repositoryId, { name: remote.name, url });
    await afterRemoteMutation(repositoryId, output.result, output.operation.message);
  } catch (error) {
    actionError.value = `${label}：${error instanceof Error ? error.message : '修改远端地址失败'}`;
  } finally {
    remoteBusy.value = null;
  }
}

async function renameRemote(repositoryId: string, remote: RepositoryRemote): Promise<void> {
  if (remoteBusy.value) return;
  const label = repositoryNameById(repositoryId);
  const others = remotesOf(repositoryId)
    .map((item) => item.name)
    .filter((name) => name !== remote.name);
  const input: ConfirmationInput = {
    label: '新远端名',
    value: remote.name,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return '请输入新名称';
      if (trimmed === remote.name) return '与当前名称相同';
      return remoteNameProblem(trimmed, others);
    },
  };
  const accepted = await requestConfirmation({
    title: '重命名远端',
    summary: `把 ${label} 的远端 ${remote.name} 改名。`,
    target: `${label} · ${remote.name}`,
    details: [
      `地址保持不变：${remote.url}`,
      '只改本机 .git/config；git 会同步更新该仓库里指向它的 upstream 关联。',
      ...(remote.isDefault
        ? [`注意：${remote.name} 是舰队默认远端（${remoteDefaultName.value}），改名后 fetch / pull / push 会提示缺少远端。`]
        : []),
    ],
    confirmLabel: '重命名',
    tone: 'caution',
    input,
  });
  if (!accepted) return;
  const nextName = input.value.trim();
  if (!nextName || nextName === remote.name) return;

  remoteBusy.value = `${repositoryId}:${remote.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.renameRepositoryRemote(repositoryId, { name: remote.name, nextName });
    await afterRemoteMutation(repositoryId, output.result, output.operation.message);
  } catch (error) {
    actionError.value = `${label}：${error instanceof Error ? error.message : '重命名远端失败'}`;
  } finally {
    remoteBusy.value = null;
  }
}

async function removeRemote(repositoryId: string, remote: RepositoryRemote): Promise<void> {
  if (remoteBusy.value) return;
  const label = repositoryNameById(repositoryId);
  const accepted = await requestConfirmation({
    title: '删除远端',
    summary: `从 ${label} 删除远端 ${remote.name}。`,
    target: `${label} · ${remote.name}`,
    details: [
      remote.url,
      '只改本机 .git/config；远端服务器上的仓库不受影响。',
      'git 会同时删除该远端的远程跟踪引用（refs/remotes/…），需要重新 Fetch 才会回来。',
      ...(remote.isDefault
        ? [`注意：${remote.name} 是舰队默认远端（${remoteDefaultName.value}），删除后 fetch / pull / push 会提示缺少远端。`]
        : []),
    ],
    confirmLabel: '删除远端',
    tone: 'danger',
  });
  if (!accepted) return;

  remoteBusy.value = `${repositoryId}:${remote.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.removeRepositoryRemote(repositoryId, { name: remote.name });
    await afterRemoteMutation(repositoryId, output.result, output.operation.message);
  } catch (error) {
    actionError.value = `${label}：${error instanceof Error ? error.message : '删除远端失败'}`;
  } finally {
    remoteBusy.value = null;
  }
}

async function loadCredentials(): Promise<void> {
  // 并发调用时只留一次在飞，其余记为「待补一次」，避免互相覆盖结果。
  if (credentialsLoading.value) {
    credentialsReloadPending.value = true;
    return;
  }
  credentialsLoading.value = true;
  try {
    credentialOverview.value = await api.remoteCredentials();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取远端凭证状态失败';
  } finally {
    credentialsLoading.value = false;
    if (credentialsReloadPending.value) {
      credentialsReloadPending.value = false;
      void loadCredentials();
    }
  }
}

/** 把某一行的主机填进表单，用户只需再补用户名与令牌。 */
async function editCredential(host: RemoteCredentialHost): Promise<void> {
  credentialForm.host = host.host;
  credentialForm.username = '';
  credentialForm.secret = '';
  credentialSecretVisible.value = false;
  // 列表在上、表单在下：用户点了「录入」之后要立刻能开始打字，
  // 而不是自己滚下去找输入框。
  await nextTick();
  const input = credentialUsernameInput.value;
  if (!input) return;
  input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  input.focus();
}

function resetCredentialForm(): void {
  credentialForm.host = '';
  credentialForm.username = '';
  credentialForm.secret = '';
  credentialSecretVisible.value = false;
  credentialHostInput.value?.focus();
}

/** 令牌通常是从远端站点复制来的，直接读系统剪贴板省掉一次手动粘贴。 */
async function pasteCredentialSecret(): Promise<void> {
  try {
    credentialForm.secret = (await api.readSystemClipboard()).text.trim();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取剪贴板失败';
  }
}

async function saveCredential(): Promise<void> {
  const host = credentialForm.host.trim();
  const username = credentialForm.username.trim();
  if (!host || !username || !credentialForm.secret || credentialSaving.value) return;
  credentialSaving.value = true;
  actionError.value = '';
  try {
    await api.saveRemoteCredential({ host, username, secret: credentialForm.secret });
    // 立刻清空口令字段：它已经进了系统钥匙串，留在输入框里没有意义。
    credentialForm.secret = '';
    actionMessage.value = `${host} 的凭证已保存；使用该主机的仓库现在都能访问`;
    await loadCredentials();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存凭证失败';
  } finally {
    credentialSaving.value = false;
  }
}

async function removeCredential(host: string): Promise<void> {
  if (credentialRemoving.value) return;
  const accepted = await requestConfirmation({
    title: '移除已保存的凭证',
    summary: `将从系统钥匙串删除 ${host} 的凭证记录。之后该主机的仓库需要重新录入才能访问。`,
    target: `${host} · 远端凭证`,
    details: ['凭证由系统钥匙串保管，删除后终端中的 git 也不再能自动认证该主机。'],
    confirmLabel: '移除凭证',
    tone: 'caution',
  });
  if (!accepted) return;
  credentialRemoving.value = host;
  actionError.value = '';
  try {
    const { removed } = await api.removeRemoteCredential(host);
    actionMessage.value = removed ? `${host} 的凭证已移除` : `${host} 没有可移除的凭证`;
    await loadCredentials();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移除凭证失败';
  } finally {
    credentialRemoving.value = null;
  }
}

watch(manageOpen, (open) => {
  if (open) {
    void loadDeepSeekKey();
    void loadCredentials();
  } else {
    // 关窗即清空口令字段：明文令牌不该在下次打开面板时原样留着。
    credentialForm.username = '';
    credentialForm.secret = '';
    credentialSecretVisible.value = false;
    // 关掉配置面板就把这条结果一起清掉：它已经在发生的地方说过一次，
    // 下次打开不该还挂着上次的「已保存」。这里必须点名 owner——
    // 此刻 manageOpen 已经是 false，按「当前容器」算会清到舰队页头上。
    notices.dismiss('settings');
  }
});

async function addRoot(): Promise<void> {
  if (!rootForm.path.trim()) return;
  rootBusy.value = 'add';
  actionError.value = '';
  try {
    const rootPath = rootForm.path.trim();
    const result = await api.addRoot(rootPath);
    scanRootId.value = result.rootId;
    rootForm.path = '';
    scanCandidates.value = [];
    await query.refetch();
    // 新增目录后直接扫描它，省掉再去 02 点一次「扫描」。
    await scanRepositories();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '添加根目录失败';
  } finally {
    rootBusy.value = null;
  }
}

async function chooseRootDirectory(): Promise<void> {
  directoryPicking.value = true;
  actionError.value = '';
  try {
    const result = await api.selectDirectory(rootForm.path.trim() || undefined);
    if (!result.path) return;
    // 选完即添加：不让用户再点一次「添加目录」。
    rootForm.path = result.path;
    await addRoot();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '选择目录失败';
  } finally {
    directoryPicking.value = false;
  }
}

/** 点 01 的目录行：直接以该目录为范围扫描（不必再去 02 选一次）。 */
async function scanRootFromRow(rootId: string): Promise<void> {
  if (scanning.value) return;
  if (scanRootId.value !== rootId) scanCandidates.value = [];
  scanRootId.value = rootId;
  await scanRepositories();
}

function requestRemoveRoot(rootId: string, rootPath: string): void {
  if (rootBusy.value !== null || rootUsageCount(rootId) > 0) return;
  void removeRoot(rootId, rootPath);
}

async function removeRoot(rootId: string, rootPath: string): Promise<void> {
  const rootName = rootNameFromPath(rootPath);
  const accepted = await requestConfirmation({
    title: '移除仓库根目录',
    summary: '该根目录将不再用于扫描和发现仓库。',
    target: `${rootName} · ${rootPath}`,
    details: [
      '只删除 Moo Fleet 中的根目录配置，不会删除磁盘目录。',
      `当前有 ${rootUsageCount(rootId)} 个工作台仓库引用此根目录；已加入的仓库不会被删除。`,
    ],
    confirmLabel: '移除根目录',
    tone: 'caution',
  });
  if (!accepted) return;
  rootBusy.value = rootId;
  actionError.value = '';
  try {
    await api.removeRoot(rootId);
    if (scanRootId.value === rootId) scanRootId.value = Object.keys(query.data.value?.roots ?? {}).find((id) => id !== rootId) ?? '';
    scanCandidates.value = [];
    actionMessage.value = `目录 ${rootName} 已移除`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移除根目录失败';
  } finally {
    rootBusy.value = null;
  }
}

async function scanRepositories(): Promise<void> {
  if (!scanRootId.value) return;
  scanning.value = true;
  actionError.value = '';
  try {
    scanCandidates.value = (await api.scanRoot(scanRootId.value)).candidates;
    actionMessage.value = `发现 ${scanCandidates.value.length} 个 Git 仓库`;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '扫描失败';
  } finally {
    scanning.value = false;
  }
}

async function addRepository(candidate: ScanCandidate): Promise<void> {
  addingPath.value = candidate.absolutePath;
  actionError.value = '';
  try {
    await api.addRepository(candidate);
    candidate.alreadyAdded = true;
    actionMessage.value = `${candidate.name} 已加入工作台`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '添加失败';
  } finally {
    addingPath.value = null;
  }
}

async function togglePinned(repository: RepositoryStatus): Promise<void> {
  if (pinBusyId.value) return;
  pinBusyId.value = repository.config.id;
  actionError.value = '';
  try {
    const pinned = !repository.config.pinned;
    await api.updateRepository(repository.config.id, { pinned });
    actionMessage.value = `${repository.config.name}：${pinned ? '已置顶' : '已取消置顶'}`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '更新置顶状态失败';
  } finally {
    pinBusyId.value = null;
  }
}

function openRepositoryEditor(repository: RepositoryStatus): void {
  repositoryEdit.value = {
    id: repository.config.id,
    name: repository.config.name,
    group: repository.config.group,
    tags: repository.config.tags.join(', '),
    aiCommitPolicy: repository.config.aiCommitPolicy,
    capabilities: { ...repository.config.capabilities },
  };
  repositoryEditSnapshot.value = JSON.stringify(repositoryEdit.value);
  repositoryIgnoreRulesRequest += 1;
  ignoreRules.value = [];
  void loadRepositoryIgnoreRules(repository.config.id);
}

async function closeRepositoryEditor(): Promise<void> {
  if (repositoryEditBusy.value || !repositoryEdit.value) return;
  if (hasUnsavedRepositoryEdit.value) {
    const accepted = await requestConfirmation({
      title: '放弃仓库配置更改',
      summary: '关闭后，尚未保存的名称、分组、隐私策略和操作权限将丢失。',
      target: repositoryEdit.value.name,
      details: ['仓库本身和工作区文件不会被修改。', '已保存的仓库配置仍保持不变。'],
      confirmLabel: '放弃更改',
      tone: 'caution',
    });
    if (!accepted) return;
  }
  repositoryEdit.value = null;
  repositoryEditSnapshot.value = '';
  repositoryIgnoreRulesRequest += 1;
  ignoreRules.value = [];
  ignoreRuleBusy.value = null;
}

async function saveRepositoryEditor(): Promise<void> {
  const edit = repositoryEdit.value;
  if (!edit) return;
  repositoryEditBusy.value = true;
  actionError.value = '';
  try {
    await api.updateRepository(edit.id, {
      name: edit.name,
      group: edit.group,
      tags: [...new Set(edit.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))],
      aiCommitPolicy: edit.aiCommitPolicy,
      capabilities: { ...edit.capabilities },
    });
    actionMessage.value = `${edit.name} 配置已保存`;
    repositoryEdit.value = null;
    repositoryEditSnapshot.value = '';
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存仓库配置失败';
  } finally {
    repositoryEditBusy.value = false;
  }
}

async function removeRepository(repository: RepositoryStatus): Promise<void> {
  if (repositoryRemovalBusy.value) return;
  const accepted = await requestConfirmation({
    title: '从工作台移出仓库',
    summary: '仓库将从 Fleet 列表和批量操作范围中移除。',
    target: repository.config.name,
    details: ['本地仓库目录和全部代码都会保留。', '之后仍可通过扫描或清单重新加入。'],
    confirmLabel: '移出工作台',
    tone: 'caution',
  });
  if (!accepted) return;
  repositoryRemovalBusy.value = true;
  actionError.value = '';
  try {
    await api.removeRepository(repository.config.id);
    selectedRepository.value = null;
    await query.refetch();
    actionMessage.value = `已把 ${repository.config.name} 移出工作台，本地目录未改动`;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移出工作台失败';
  } finally {
    repositoryRemovalBusy.value = false;
  }
}

async function pruneMissingRepositories(): Promise<void> {
  if (pruneBusy.value) return;
  const targets = missingRepositories.value;
  if (targets.length === 0) return;
  const accepted = await requestConfirmation({
    title: '清理路径缺失的仓库',
    summary: `将从工作台移出 ${targets.length} 个本地目录已不存在的仓库。`,
    target: targets.length === 1 ? targets[0]?.config.name ?? '' : `${targets.length} 个缺失仓库`,
    details: [
      '仅移除工作台配置，不会删除任何本地目录或代码。',
      '若某个目录在清理时重新出现，将自动跳过并保留。',
      '之后仍可通过扫描或清单重新加入。',
    ],
    confirmLabel: `清理 ${targets.length} 个仓库`,
    tone: 'caution',
  });
  if (!accepted) return;
  pruneBusy.value = true;
  actionError.value = '';
  try {
    const result = await api.pruneMissingRepositories(targets.map((repository) => repository.config.id));
    if (selectedRepository.value && result.removed.includes(selectedRepository.value.config.id)) {
      selectedRepository.value = null;
    }
    await query.refetch();
    if (result.removed.length === 0) {
      actionWarning.value = '未清理任何仓库：目标目录已重新出现';
    } else if (result.skipped.length > 0) {
      actionMessage.value = `已清理 ${result.removed.length} 个缺失仓库，${result.skipped.length} 个因目录重新出现而跳过`;
    } else {
      actionMessage.value = `已清理 ${result.removed.length} 个路径缺失的仓库`;
    }
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '清理缺失仓库失败';
  } finally {
    pruneBusy.value = false;
  }
}

function toggleRepositorySelection(id: string): void {
  const current = selectedRepositoryIds.value;
  selectedRepositoryIds.value = current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id];
}

/**
 * 表头勾选框的状态：`all` 表示当前结果全部已选，`partial` 表示只选了一部分。
 * 以「当前结果」为基准，所以筛选后表头会如实反映可见部分的选中情况。
 */
const visibleSelectionState = computed<'none' | 'partial' | 'all'>(() => {
  const visible = filteredRepositories.value;
  if (visible.length === 0) return 'none';
  const selected = new Set(selectedRepositoryIds.value);
  const selectedCount = visible.filter((repository) => selected.has(repository.config.id)).length;
  if (selectedCount === 0) return 'none';
  return selectedCount === visible.length ? 'all' : 'partial';
});

/**
 * 表头勾选框：未全选就全选当前结果；已全选则整体清空。
 * 清空时连不可见的已选项一起清，避免筛选后留下看不见的选中项。
 */
function toggleVisibleSelection(): void {
  if (visibleSelectionState.value === 'all') {
    selectedRepositoryIds.value = [];
    return;
  }
  const visible = filteredRepositories.value.map((repository) => repository.config.id);
  selectedRepositoryIds.value = [...new Set([...selectedRepositoryIds.value, ...visible])];
}

// 仓库被移出工作台后不能在工作集里留下悬空 ID，否则范围计数会虚高。
watch(repositories, (list) => {
  if (selectedRepositoryIds.value.length === 0) return;
  const alive = new Set(list.map((repository) => repository.config.id));
  const next = selectedRepositoryIds.value.filter((id) => alive.has(id));
  if (next.length !== selectedRepositoryIds.value.length) selectedRepositoryIds.value = next;
});

async function runBatch(type: BatchOperationType): Promise<void> {
  const targetRepositories = batchTargetRepositories.value;
  if (targetRepositories.length === 0) return;
  const availability = batchAvailability.value[type];
  if (availability.eligible === 0) {
    actionWarning.value = availability.detail;
    return;
  }
  const scopeLabel = batchScopeLabel.value;
  if (type !== 'fetch') {
    const action = type === 'pull' ? 'Pull' : 'Push';
    const skippedEstimate = targetRepositories.length - availability.eligible;
    const accepted = await requestConfirmation({
      title: `批量 ${action}`,
      summary: `将对${scopeLabel}中符合条件的 ${availability.eligible} 个仓库执行 ${action}。`,
      target: `${scopeLabel} · ${availability.eligible} 个将执行${skippedEstimate > 0 ? ` · ${skippedEstimate} 个跳过` : ''}`,
      // 明细放在最前面：先回答「动哪个、不动哪个」，再讲规则。
      details: [
        ...batchPlanDetails(targetRepositories, type),
        ...(type === 'pull'
          ? ['批量 Pull 默认 merge 整合，工作区不干净的仓库会跳过。']
          : ['推送前会重新检查远端，不会强制覆盖。']),
      ],
      confirmLabel: `确认 ${action}`,
      tone: 'caution',
    });
    if (!accepted) return;
  }
  batchStarting.value = type;
  actionError.value = '';
  try {
    const { batch } = await api.startBatch(type, targetRepositories.map((repository) => repository.config.id));
    activeBatchId.value = batch.id;
    historyOpen.value = true;
    selectedRepository.value = null;
    // 这里不再弹提示：抽屉刚被打开、里面就是这一批的实时进度，按钮此刻也在转，
    // 再说一遍「已开始 FETCH，6 个仓库将执行」等于把按钮上的数字念给用户听。
    // 不 await：批次已经建好，刷新只是补一次列表快照，让它多占住按钮的 200ms 不划算。
    void operationsQuery.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量操作启动失败';
  } finally {
    batchStarting.value = null;
  }
}

/**
 * 打开工作台的批量多分支推送窗口。
 *
 * 先逐仓读分支快照再让用户确认：批量的「预计可推」如果只按当前分支算，
 * 会在 dev / 主分支才是待推对象时给出错误数字。
 */
async function openBatchPushBranches(): Promise<void> {
  if (batchPushBranches.value || batchPushBranchesBusy.value) return;
  if (batchStarting.value !== null || foregroundBatchRunning.value) return;
  const targets = batchTargetRepositories.value;
  if (targets.length === 0) return;
  const availability = batchAvailability.value['push-branches'];
  if (availability.eligible === 0) {
    actionWarning.value = availability.detail;
    return;
  }
  batchPushBranches.value = {
    repositoryIds: targets.map((repository) => repository.config.id),
    modes: ['current', 'default', 'dev'] as BatchPushBranchMode[],
    plan: null as BatchPushBranchesPlan | null,
    loading: true,
    error: '',
  };
  // 必须拿 ref 读回来的响应式代理：直接改刚才那个原始对象不会触发渲染，
  // 界面会一直停在「正在逐仓读取分支…」。
  const active = batchPushBranches.value;
  if (active) await loadBatchPushBranchesPlan(active);
}

async function loadBatchPushBranchesPlan(dialog: NonNullable<typeof batchPushBranches.value>): Promise<void> {
  dialog.loading = true;
  dialog.error = '';
  try {
    const { plan } = await api.batchPushBranchesPlan(dialog.repositoryIds, dialog.modes);
    if (batchPushBranches.value === dialog) dialog.plan = plan;
  } catch (error) {
    if (batchPushBranches.value === dialog) {
      dialog.plan = null;
      dialog.error = error instanceof Error ? error.message : '无法读取分支列表';
    }
  } finally {
    if (batchPushBranches.value === dialog) dialog.loading = false;
  }
}

/** 档位变化就重读一次快照：档位决定挑哪些分支，旧清单不能复用。 */
async function changeBatchPushBranchesModes(modes: BatchPushBranchMode[]): Promise<void> {
  const dialog = batchPushBranches.value;
  if (!dialog || batchPushBranchesBusy.value) return;
  dialog.modes = modes;
  await loadBatchPushBranchesPlan(dialog);
}

function closeBatchPushBranches(): void {
  if (batchPushBranchesBusy.value) return;
  batchPushBranches.value = null;
}

async function executeBatchPushBranches(repositoryIds: string[]): Promise<void> {
  const dialog = batchPushBranches.value;
  if (!dialog || dialog.loading || batchPushBranchesBusy.value || repositoryIds.length === 0) return;
  // 把预览时每仓的分支与其 head 一起送上去：服务端据此复核，预览之后新出现的提交
  // 会被拒推那一条，而不是跟着一起推上去。只取用户勾选的仓库。
  const chosen = new Set(repositoryIds);
  const targets: BatchPushBranchTargets = (dialog.plan?.repositories ?? [])
    .filter((row) => chosen.has(row.repositoryId) && row.targets.length > 0)
    .map((row) => ({
      repositoryId: row.repositoryId,
      branches: row.targets.map((branch) => ({ name: branch.name, head: branch.head })),
    }));
  batchPushBranchesBusy.value = true;
  // 上一次失败的原因在这里清掉：否则确认按钮会因为残留的 error 一直灰着，只能关掉重开。
  dialog.error = '';
  actionError.value = '';
  try {
    const { batch } = await api.startBatch('push-branches', repositoryIds, { modes: dialog.modes, targets });
    batchPushBranches.value = null;
    activeBatchId.value = batch.id;
    historyOpen.value = true;
    selectedRepository.value = null;
    await operationsQuery.refetch();
  } catch (error) {
    const message = error instanceof Error ? error.message : '批量推送启动失败';
    // 失败留在窗口里：关掉再去看操作记录，用户得点两下才知道为什么没起来。
    if (batchPushBranches.value === dialog) dialog.error = message;
    actionError.value = message;
  } finally {
    batchPushBranchesBusy.value = false;
  }
}

/**
 * 打开双线合并窗口。
 *
 * 与推送不同，这里不拿 `batchAvailability` 的 eligible 拦人：能不能合必须逐仓读分支
 * 与提交关系才知道，粗判只在按钮上给个数量。范围里一个都不可合时，弹窗自己会说清楚。
 */
/**
 * 从单仓抽屉直接打开双线合并，范围只有这一仓。
 *
 * 批量入口在工作台那排按钮里，而「把本地任务分支合回双线」这件事发生时，用户
 * 十有八九正站在某个仓库的分支上——让他先退回列表、再勾选、再点合并，等于把
 * 一步操作拆成三步。合并计划的预检本身是只读的，多一个入口不会多一分风险。
 */
async function openRepositoryMerge(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  if (batchMerge.value || batchMergeBusy.value) return;
  if (batchStarting.value !== null || foregroundBatchRunning.value) return;
  if (workspaceBusy.value || workspaceRefreshing.value) return;
  batchMerge.value = {
    repositoryIds: [repository.config.id],
    plan: null as BatchMergeBranchesPlan | null,
    loading: true,
    error: '',
  };
  // 与批量入口一致：必须拿 ref 读回来的响应式代理，直接改原始对象界面不会动。
  const active = batchMerge.value;
  if (active) await loadBatchMergePlan(active);
}

/**
 * 单仓抽屉里「Pull 右侧 ⌄」：以这一仓为范围打开多分支拉取弹窗（当前 / 主分支 / dev）。
 * 与工作台批量入口同一个组件、同一套预检，只是范围只有这一仓。
 */
async function openRepositoryPullBranches(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  if (batchPull.value || batchPullBusy.value) return;
  if (batchStarting.value !== null || foregroundBatchRunning.value) return;
  if (workspaceBusy.value || workspaceRefreshing.value) return;
  batchPull.value = {
    repositoryIds: [repository.config.id],
    modes: ['current', 'default', 'dev'] as BatchPullBranchMode[],
    plan: null as BatchPullBranchesPlan | null,
    loading: true,
    error: '',
  };
  // 同批量入口：必须拿 ref 读回来的响应式代理，直接改原始对象界面不会动。
  const active = batchPull.value;
  if (active) await loadBatchPullPlan(active);
}

async function openBatchMerge(): Promise<void> {
  if (batchMerge.value || batchMergeBusy.value) return;
  if (batchStarting.value !== null || foregroundBatchRunning.value) return;
  const targets = batchTargetRepositories.value;
  if (targets.length === 0) return;
  batchMerge.value = {
    repositoryIds: targets.map((repository) => repository.config.id),
    plan: null as BatchMergeBranchesPlan | null,
    loading: true,
    error: '',
  };
  // 同推送窗口：必须拿 ref 读回来的响应式代理，直接改原始对象界面不会动。
  const active = batchMerge.value;
  if (active) await loadBatchMergePlan(active);
}

async function loadBatchMergePlan(dialog: NonNullable<typeof batchMerge.value>): Promise<void> {
  dialog.loading = true;
  dialog.error = '';
  try {
    const { plan } = await api.batchMergeBranchesPlan(dialog.repositoryIds);
    if (batchMerge.value === dialog) dialog.plan = plan;
  } catch (error) {
    if (batchMerge.value === dialog) {
      dialog.plan = null;
      dialog.error = error instanceof Error ? error.message : '无法读取分支与提交关系';
    }
  } finally {
    if (batchMerge.value === dialog) dialog.loading = false;
  }
}

function closeBatchMerge(): void {
  if (batchMergeBusy.value) return;
  batchMerge.value = null;
}

/**
 * 单仓操作的收尾：等这个批次跑完，刷新当前仓库抽屉并给出结果提示——不关抽屉、不跳主界面、
 * 不打开操作记录（那是工作台批量才需要的）。轮询失败只重试，最多约 36 秒。
 */
async function settleSingleRepositoryBatch(batchId: string, repositoryId: string, label: string): Promise<void> {
  // 等批次期间禁用该仓操作按钮（workspaceBusy 包含此标志），避免重复提交；
  // 结束时先解除再刷新，否则 refreshRepositoryWorkspace 会被 workspaceBusy 挡回。
  repositorySettling.value = true;
  try {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      let payload: Awaited<ReturnType<typeof api.operations>> | null;
      try {
        payload = await api.operations();
      } catch {
        continue;
      }
      void operationsQuery.refetch();
      const batch = payload.batches.find((item) => item.id === batchId);
      if (!batch || batch.state !== 'completed') continue;
      const operation = payload.operations.find((item) => item.batchId === batchId && item.repositoryId === repositoryId);
      if (operation?.state === 'success') actionMessage.value = `${label}完成${operation.message ? `：${operation.message}` : ''}`;
      else if (operation?.state === 'skipped') actionMessage.value = `${label}：${operation.message || '没有可执行的内容'}`;
      else actionMessage.value = `${label}未完成：${operation?.message ?? '请在操作记录查看详情'}`;
      break;
    }
  } finally {
    repositorySettling.value = false;
  }
  if (selectedRepository.value?.config.id === repositoryId) await refreshRepositoryWorkspace();
}

async function executeBatchMerge(repositoryIds: string[], deleteMergedBranches = false): Promise<void> {
  const dialog = batchMerge.value;
  if (!dialog || dialog.loading || batchMergeBusy.value || repositoryIds.length === 0) return;
  // 只把用户勾选的仓库送上去：有待合并源分支的按快照合并；勾了清理时，即使没有可合并内容
  // （已同步），也把「可清理分支」的仓库送上去，让服务端做安全清理。被挡下的仓库不参与。
  const chosen = new Set(repositoryIds);
  const mergeTargets: BatchMergeTargets = (dialog.plan?.repositories ?? [])
    .filter((row) => {
      if (!chosen.has(row.repositoryId) || row.blocker !== null) return false;
      const mergeableSources = row.sources.filter((source) => !source.blocker);
      return mergeableSources.length > 0 || (deleteMergedBranches && row.mergedBranches.length > 0);
    })
    .map((row) => ({
      repositoryId: row.repositoryId,
      sources: row.sources
        .filter((source) => !source.blocker)
        .map((source) => ({ name: source.name, head: source.head })),
      targets: row.targets,
    }));
  if (mergeTargets.length === 0) return;
  // 从单仓抽屉发起（范围正好是当前打开这一仓）：执行后留在抽屉里，不跳主界面/操作记录。
  const singleRepoId = dialog.repositoryIds.length === 1 ? dialog.repositoryIds[0]! : null;
  const fromRepoDrawer = singleRepoId !== null && selectedRepository.value?.config.id === singleRepoId;
  batchMergeBusy.value = true;
  // 上一次失败的原因在这里清掉：否则确认按钮会因残留的 error 一直灰着，只能关掉重开。
  dialog.error = '';
  actionError.value = '';
  try {
    const { batch } = await api.startBatch('merge-branches', mergeTargets.map((item) => item.repositoryId), {
      mergeTargets,
      deleteMergedBranches,
    });
    batchMerge.value = null;
    activeBatchId.value = batch.id;
    void operationsQuery.refetch();
    if (fromRepoDrawer && singleRepoId) {
      actionMessage.value = '合并已提交，正在执行…';
      void settleSingleRepositoryBatch(batch.id, singleRepoId, '合并');
    } else {
      historyOpen.value = true;
      selectedRepository.value = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '双线合并启动失败';
    // 失败留在窗口里：关掉再去看操作记录，用户得点两下才知道为什么没起来。
    if (batchMerge.value === dialog) dialog.error = message;
    actionError.value = message;
  } finally {
    batchMergeBusy.value = false;
  }
}

/**
 * 打开工作台的「批量拉取多个分支」窗口。
 *
 * 与普通批量 Pull 不同：普通批量只按当前分支算，会在「当前分支已最新、dev 落后」时
 * 给出错误数字。这里先逐仓读分支快照再让用户确认；预检只读本机已有的远端跟踪 ref，
 * 不额外打网络，执行时再重新 Fetch。
 */
async function openBatchPull(): Promise<void> {
  if (batchPull.value || batchPullBusy.value) return;
  if (batchStarting.value !== null || foregroundBatchRunning.value) return;
  const targets = batchTargetRepositories.value;
  if (targets.length === 0) return;
  batchPull.value = {
    repositoryIds: targets.map((repository) => repository.config.id),
    modes: ['current', 'default', 'dev'] as BatchPullBranchMode[],
    plan: null as BatchPullBranchesPlan | null,
    loading: true,
    error: '',
  };
  // 必须拿 ref 读回来的响应式代理：直接改刚才那个原始对象不会触发渲染，
  // 界面会一直停在「正在逐仓读取本地分支…」。
  const active = batchPull.value;
  if (active) await loadBatchPullPlan(active);
}

async function loadBatchPullPlan(dialog: NonNullable<typeof batchPull.value>): Promise<void> {
  dialog.loading = true;
  dialog.error = '';
  try {
    const { plan } = await api.batchPullBranchesPlan(dialog.repositoryIds, dialog.modes);
    if (batchPull.value === dialog) dialog.plan = plan;
  } catch (error) {
    if (batchPull.value === dialog) {
      dialog.plan = null;
      dialog.error = error instanceof Error ? error.message : '无法读取分支列表';
    }
  } finally {
    if (batchPull.value === dialog) dialog.loading = false;
  }
}

/** 档位变化就重读一次快照：档位决定挑哪些分支，旧清单不能复用。 */
async function changeBatchPullModes(modes: BatchPullBranchMode[]): Promise<void> {
  const dialog = batchPull.value;
  if (!dialog || batchPullBusy.value) return;
  dialog.modes = modes;
  await loadBatchPullPlan(dialog);
}

function closeBatchPull(): void {
  if (batchPullBusy.value) return;
  batchPull.value = null;
}

async function executeBatchPull(repositoryIds: string[]): Promise<void> {
  const dialog = batchPull.value;
  if (!dialog || dialog.loading || batchPullBusy.value || repositoryIds.length === 0) return;
  // 只把用户勾选、且真的有可拉分支的仓库送上去；每条分支只带名字、不带 head——
  // 拉取的对象是远端，执行时会重新 Fetch，钉死 hash 只会让「远端刚好动了一下」变成失败。
  const chosen = new Set(repositoryIds);
  const pullTargets: BatchPullBranchTargets = (dialog.plan?.repositories ?? [])
    .filter((row) => chosen.has(row.repositoryId) && row.blocker === null)
    .map((row) => ({
      repositoryId: row.repositoryId,
      branches: row.branches
        .filter((branch) => branch.blocker === null && branch.behind > 0)
        .map((branch) => branch.name),
    }))
    .filter((item) => item.branches.length > 0);
  if (pullTargets.length === 0) return;
  // 从单仓抽屉发起（范围正好是当前打开这一仓）：执行后留在抽屉里，不跳主界面/操作记录。
  const singleRepoId = dialog.repositoryIds.length === 1 ? dialog.repositoryIds[0]! : null;
  const fromRepoDrawer = singleRepoId !== null && selectedRepository.value?.config.id === singleRepoId;
  batchPullBusy.value = true;
  // 上一次失败的原因在这里清掉：否则确认按钮会因为残留的 error 一直灰着，只能关掉重开。
  dialog.error = '';
  actionError.value = '';
  try {
    const { batch } = await api.startBatch('pull-branches', pullTargets.map((item) => item.repositoryId), {
      pullTargets,
    });
    batchPull.value = null;
    activeBatchId.value = batch.id;
    void operationsQuery.refetch();
    if (fromRepoDrawer && singleRepoId) {
      actionMessage.value = '多分支拉取已提交，正在执行…';
      void settleSingleRepositoryBatch(batch.id, singleRepoId, '多分支拉取');
    } else {
      historyOpen.value = true;
      selectedRepository.value = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '批量拉取启动失败';
    // 失败留在窗口里：关掉再去看操作记录，用户得点两下才知道为什么没起来。
    if (batchPull.value === dialog) dialog.error = message;
    actionError.value = message;
  } finally {
    batchPullBusy.value = false;
  }
}

async function runRepositoryAction(action: 'fetch' | 'pull' | 'sync' | 'push'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || workspaceRefreshing.value) return;
  const contextVersion = repositoryContextVersion;
  let stashFirst = false;
  let rebase = false;
  if (action !== 'fetch') {
    const actionLabel = action === 'pull' ? 'Pull' : action === 'sync' ? '同步' : 'Push';
    const hasChanges =
      repository.staged + repository.modified + repository.untracked + repository.deleted + repository.renamed > 0;
    const autoStash: ConfirmationCheckbox | undefined =
      action !== 'push' && hasChanges
        ? {
            id: 'auto-stash',
            label: '自动 Stash 本地改动',
            description: '先暂存工作区改动，拉取/同步完成后自动恢复；恢复冲突时改动仍保留在 Stash 列表',
            value: true,
          }
        : undefined;
    const useRebase: ConfirmationCheckbox | undefined =
      action === 'pull' || action === 'sync'
        ? {
            id: 'use-rebase',
            label: '用 Rebase 代替 Merge',
            description: '把本地提交重放到远端最新提交之上，产生线性历史，不产生合并提交',
            value: false,
          }
        : undefined;
    const checkboxes = [autoStash, useRebase].filter((box): box is ConfirmationCheckbox => box !== undefined);
    const accepted = await requestConfirmation({
      title: `确认 ${actionLabel}`,
      summary: action === 'pull'
        ? `将把远端更新整合到 ${repository.config.name}。`
        : action === 'sync'
          ? `将拉取远端更新整合到 ${repository.config.name}，成功后自动推送本地提交。`
          : `将把 ${repository.config.name} 的本地新提交推送到远端。`,
      target: `${repository.config.name} · ${repository.branch || 'DETACHED'}`,
      details: action === 'pull'
        ? ['默认 merge（分叉时产生合并提交），可勾选 rebase（线性历史）。', '遇到冲突会暂停，需在工作区处理后继续或中止。']
        : action === 'sync'
          ? ['默认 merge（分叉时产生合并提交），可勾选 rebase（线性历史）。', '整合成功后自动推送；冲突会暂停，需在工作区处理后继续或中止。']
          : ['推送前会检查远端；发现新变化时会停止，不会强制覆盖。'],
      confirmLabel: `确认 ${actionLabel}`,
      tone: 'caution',
      checkboxes: checkboxes.length > 0 ? checkboxes : undefined,
    });
    stashFirst = autoStash?.value === true;
    rebase = useRebase?.value === true;
    if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || workspaceBusy.value) return;
  }
  repositoryAction.value = action;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output =
      action === 'fetch'
        ? await api.fetchRepository(repository.config.id)
        : action === 'pull'
          ? await api.pullRepository(repository.config.id, { stashFirst, rebase })
          : action === 'sync'
            ? await api.syncRepository(repository.config.id, { stashFirst, rebase })
            : await api.pushRepository(repository.config.id);
    cacheRepositoryStatus(output.result);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = output.operation.message;
    }
    await Promise.all([
      query.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion)
        ? Promise.all([loadRepositoryBranches(repository.config.id), loadRepositoryFiles(repository.config.id)])
        : Promise.resolve(),
    ]);
  } catch (error) {
    // 冲突暂停不是失败：HEAD 可能已经游离、工作区多了未合并文件。不刷新就会停在
    // 操作之前的样子——用户既看不到冲突，也没有「继续 / 终止」，只能去命令行收尾。
    const paused = error instanceof ApiError && error.code === mergePausedErrorCode;
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      const message = error instanceof Error ? error.message : 'Git 操作失败';
      actionError.value = message;
      if (paused) repositoryWorkspace.value?.showWorking();
    }
    if (paused) {
      await Promise.all([
        query.refetch(),
        isCurrentRepositoryContext(repository.config.id, contextVersion)
          ? Promise.all([
              loadRepositoryBranches(repository.config.id, { background: true }),
              loadRepositoryFiles(repository.config.id, { background: true }),
            ])
          : Promise.resolve(),
      ]);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) repositoryAction.value = null;
  }
}

const pushBranchesStoragePrefix = 'moo-fleet:push-branches:';

/** 上次为这个仓库推过哪些分支；读不出来就当没记过，退回服务端给的预选。 */
function rememberedPushBranches(repositoryId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(pushBranchesStoragePrefix + repositoryId) ?? 'null');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

function rememberPushBranches(repositoryId: string, names: string[]): void {
  try {
    localStorage.setItem(pushBranchesStoragePrefix + repositoryId, JSON.stringify(names));
  } catch {
    // 隐私模式 / 配额满时写不进去：只是少一个预选，不该让推送本身失败。
  }
}

function closePushBranches(): void {
  if (pushBranchesBusy.value) return;
  pushBranches.value = null;
}

async function openPushBranches(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || workspaceRefreshing.value || branchMerge.value || pushBranches.value) return;
  if (!pushBranchesAvailability.value.available) {
    actionError.value = pushBranchesAvailability.value.detail;
    return;
  }
  const dialog = {
    repositoryId: repository.config.id,
    plan: null as PushBranchesPlan | null,
    loading: true,
    error: '',
    initial: rememberedPushBranches(repository.config.id),
    result: null as PushBranchesResult | null,
  };
  pushBranches.value = dialog;
  const active = pushBranches.value;
  try {
    const plan = await api.pushBranchesPlan(repository.config.id);
    if (pushBranches.value === active) active.plan = plan;
  } catch (error) {
    if (pushBranches.value === active) active.error = error instanceof Error ? error.message : '无法读取分支列表';
  } finally {
    if (pushBranches.value === active) active.loading = false;
  }
}

async function executePushBranches(names: string[]): Promise<void> {
  const dialog = pushBranches.value;
  if (!dialog || !dialog.plan || dialog.loading || pushBranchesBusy.value) return;
  const repository = selectedRepository.value;
  if (!repository || repository.config.id !== dialog.repositoryId) return;
  // 只送「可推」的分支，并且带上预览时的 head：服务端据此复核分支没在期间变过。
  const targets = names.flatMap((name) => {
    const branch = dialog.plan?.branches.find((item) => item.name === name);
    return branch && !branch.blocker ? [{ name: branch.name, head: branch.head }] : [];
  });
  if (targets.length === 0) return;
  const contextVersion = repositoryContextVersion;
  pushBranchesBusy.value = true;
  // 清掉上一次失败的残留原因，让「再点一次」是可行的（否则按钮一直是灰的）。
  dialog.error = '';
  actionError.value = '';
  try {
    const output = await api.pushBranches(dialog.repositoryId, { branches: targets });
    rememberPushBranches(dialog.repositoryId, names);
    if (pushBranches.value === dialog) dialog.result = output.result;
    cacheRepositoryStatus(output.result.status);
    actionMessage.value = output.operation.message;
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      isCurrentRepositoryContext(dialog.repositoryId, contextVersion)
        ? Promise.all([
            loadRepositoryBranches(dialog.repositoryId),
            loadRepositoryFiles(dialog.repositoryId),
          ])
        : Promise.resolve(),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '推送失败';
    // 失败留在窗口里说明原因：关掉再看操作记录，用户就得多点两下才明白哪条分支没推上去。
    if (pushBranches.value === dialog) dialog.error = message;
    actionError.value = message;
  } finally {
    pushBranchesBusy.value = false;
  }
}

/** `background` 语义同 `loadRepositoryFiles`：静默刷新不改加载态、不弹错误。 */
async function loadRepositoryBranches(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryBranchesRequest;
  const foreground = !options.background;
  if (foreground) {
    branchesLoad.begin();
    branchesLoading.value = true;
  }
  try {
    const snapshot = await api.repositoryBranches(repositoryId);
    if (requestId === repositoryBranchesRequest && selectedRepository.value?.config.id === repositoryId) {
      branchSnapshot.value = snapshot;
    }
  } catch (error) {
    if (!options.background && requestId === repositoryBranchesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取本地分支失败';
    }
  } finally {
    if (foreground && branchesLoad.end()) branchesLoading.value = false;
  }
}

function closeBranchPanel(restoreFocus = false): void {
  if (!branchPanelOpen.value) return;
  branchPanelOpen.value = false;
  if (restoreFocus) requestAnimationFrame(() => branchTrigger.value?.focus({ preventScroll: true }));
}

function handleBranchMenuPointerDown(event: PointerEvent): void {
  if (!branchPanelOpen.value || confirmation.value || upstreamRepair.value) return;
  if (event.target instanceof Node && !branchMenuRoot.value?.contains(event.target)) closeBranchPanel();
}

function handleBranchMenuFocusOut(event: FocusEvent): void {
  if (!branchPanelOpen.value || confirmation.value || upstreamRepair.value) return;
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && branchMenuRoot.value?.contains(nextTarget)) return;
  // 行内重命名会替换掉刚被点击的按钮，焦点会短暂落到 body。
  // 延后一帧再判断焦点是否仍在面板内，避免误关面板。
  requestAnimationFrame(() => {
    if (!branchPanelOpen.value || confirmation.value || upstreamRepair.value) return;
    const active = document.activeElement;
    if (active instanceof Node && branchMenuRoot.value?.contains(active)) return;
    closeBranchPanel();
  });
}

/**
 * 「管理本地分支」面板是 `role="dialog"`：Tab 必须在面板内循环，
 * 否则焦点一离开 .branch-menu，handleBranchMenuFocusOut 就会顺手把面板关掉。
 * 这里只做面板内的局部约束，不走全局焦点层，避免关闭时把焦点硬拉回触发按钮。
 */
function trapBranchPanelFocus(event: KeyboardEvent): void {
  const panel = branchMenuPanel.value;
  if (!panel) return;
  const controls = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href]')]
    .filter((control) => control.offsetParent !== null);
  if (controls.length === 0) return;
  const currentIndex = controls.findIndex((control) => control === document.activeElement);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0 ? controls.length - 1 : currentIndex - 1
    : currentIndex < 0 || currentIndex >= controls.length - 1 ? 0 : currentIndex + 1;
  event.preventDefault();
  controls[nextIndex]?.focus({ preventScroll: true });
}

/** 面板内用 ↑ / ↓ 在本地分支之间移动；重命名、删除仍按 Tab 走到。 */
function moveBranchPanelBranch(event: KeyboardEvent): void {
  const items = [...(branchMenuPanel.value?.querySelectorAll<HTMLElement>('.branch-option') ?? [])]
    .filter((item) => !item.hasAttribute('disabled'));
  if (items.length === 0) return;
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = currentIndex < 0
    ? (delta > 0 ? 0 : items.length - 1)
    : Math.min(items.length - 1, Math.max(0, currentIndex + delta));
  const target = items[nextIndex];
  if (!target) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest' });
}

async function toggleBranchPanel(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  if (branchPanelOpen.value) {
    closeBranchPanel();
    return;
  }
  branchPanelOpen.value = true;
  await nextTick();
  branchMenuPanel.value?.focus({ preventScroll: true });
  if (!branchSnapshot.value) await loadRepositoryBranches(repository.config.id);
}

/**
 * detached HEAD 下最该做的是先给这个提交一条分支，否则提交完就悬空了。
 * 复用分支面板里已有的「新建 + 创建后切换」，不另造一套创建流程。
 */
async function startBranchFromDetached(): Promise<void> {
  if (!selectedRepository.value) return;
  if (!branchPanelOpen.value) await toggleBranchPanel();
  branchCreateCheckout.value = true;
  await nextTick();
  branchCreateInput.value?.focus({ preventScroll: true });
}

function branchSwitchBlocker(branch: BranchesSnapshot['branches'][number]): string | null {
  if (branch.current) return '当前分支';
  if (branch.worktreePath) return `已被其他 Worktree 占用：${branch.worktreePath}`;
  return localBranchSwitchBlocker.value;
}

/**
 * 分支写操作统一复核与回填；普通切换直接执行，创建、重命名、删除等保留确认。
 * 切换、新建、重命名、删除、检出远端共用同一套上下文校验与竞态保护。
 */
async function runBranchMutation(options: {
  busyKey: string;
  confirmation?: ConfirmationOptions;
  execute: (
    repositoryId: string,
    snapshot: BranchesSnapshot,
  ) => Promise<{
    operation: { message: string };
    result: { status: RepositoryStatus; files: FileChange[]; branches: BranchesSnapshot };
  }>;
  failureMessage: string;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot || workspaceBusy.value || workspaceRefreshing.value) return;
  const contextVersion = repositoryContextVersion;
  const accepted = options.confirmation ? await requestConfirmation(options.confirmation) : true;
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || workspaceBusy.value) return;

  repositoryFilesRequest += 1;
  repositoryBranchesRequest += 1;
  filesLoading.value = false;
  branchesLoading.value = false;

  branchSwitchBusy.value = options.busyKey;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await options.execute(repository.config.id, snapshot);
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      closeDiffDialog();
      selectedRepository.value = output.result.status;
      repositoryFiles.value = output.result.files;
      branchSnapshot.value = output.result.branches;
      closeBranchPanel(true);
      actionMessage.value = output.operation.message;
      options.onSuccess?.();
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
    ]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      const message = error instanceof Error ? error.message : options.failureMessage;
      actionError.value = message;
    }
    await Promise.all([
      contextCurrent ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      query.refetch(),
      operationsQuery.refetch(),
    ]);
    if (contextCurrent) options.onError?.(error);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) branchSwitchBusy.value = null;
  }
}

function closeBranchMerge(): void {
  if (branchSwitchBusy.value === 'merge') return;
  branchMerge.value = null;
}
async function openBranchMerge(source: MergeSource): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot?.currentBranch || workspaceBusy.value || workspaceRefreshing.value || branchesLoading.value || filesLoading.value || branchMerge.value) return;
  const branch = source.kind === 'local' ? snapshot.branches.find(item => item.name === source.name) : snapshot.remoteBranches.find(item => item.name === source.name);
  if (!branch || (source.kind === 'local' && source.name === snapshot.currentBranch)) return;
  const dialog = { repositoryId: repository.config.id, input: { source, expectedBranch: snapshot.currentBranch, expectedHead: snapshot.head, expectedSourceHead: branch.head }, preview: null as MergePreview | null, loading: true, error: '' };
  branchMerge.value = dialog;
  const activeDialog = branchMerge.value;
  try {
    const preview = await api.previewBranchMerge(repository.config.id, dialog.input);
    if (branchMerge.value === activeDialog) activeDialog.preview = preview;
  } catch (error) {
    if (branchMerge.value === activeDialog) activeDialog.error = error instanceof Error ? error.message : '无法检查合并条件';
  } finally {
    if (branchMerge.value === activeDialog) activeDialog.loading = false;
  }
}
async function executeBranchMerge(options: { noFastForward: boolean; stashFirst: boolean; stashIncludeUntracked: boolean }): Promise<void> {
  const dialog = branchMerge.value;
  if (!dialog || dialog.loading || dialog.error || !dialog.preview || dialog.preview.blocker || dialog.preview.kind === 'up-to-date' || dialog.repositoryId !== selectedRepository.value?.config.id) return;
  if (dialog.preview.conflicting.length > 0 && !options.stashFirst) return;
  const stashRepositoryId = options.stashFirst ? dialog.repositoryId : null;
  await runBranchMutation({
    busyKey: 'merge', execute: id => api.mergeBranch(id, { ...dialog.input, ...options }), failureMessage: '合并失败',
    onSuccess: () => {
      branchMerge.value = null;
      void nextTick(() => repositoryWorkspace.value?.showCurrentBranch());
      if (stashRepositoryId && selectedRepository.value?.config.id === stashRepositoryId) void loadRepositoryStashes(stashRepositoryId);
    },
    onError: error => {
      if (error instanceof ApiError && error.code === mergePausedErrorCode) { branchMerge.value = null; repositoryWorkspace.value?.showWorking(); }
      else if (branchMerge.value) branchMerge.value.error = error instanceof Error ? error.message : '合并失败，请关闭后重试';
    },
  });
}

async function switchRepositoryBranch(branch: BranchesSnapshot['branches'][number]): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot || branchSwitchBlocker(branch)) return;
  await runBranchMutation({
    busyKey: branch.name,
    execute: (repositoryId, current) =>
      api.switchRepositoryBranch(repositoryId, branch.name, current.currentBranch, current.head),
    failureMessage: '切换分支失败',
  });
}

async function createRepositoryBranch(): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  const branch = branchCreateName.value.trim();
  if (!repository || !snapshot || !branch || branchCreateBlocker.value || branchesLoading.value || filesLoading.value) return;
  const checkout = branchCreateCheckout.value;
  await runBranchMutation({
    busyKey: `create:${branch}`,
    confirmation: {
      title: checkout ? '新建并切换到该分支' : '新建本地分支',
      summary: '新分支从当前 HEAD 创建；分支名与目标会在服务端再次校验。',
      target: `${repository.config.name} · ${snapshot.currentBranch || 'DETACHED'} → ${branch}`,
      details: checkout
        ? ['创建并切换要求工作区干净且没有进行中的 Git 操作。', '不会自动 Stash；取消「创建后切换」可仅创建分支引用。']
        : ['只创建分支引用，不改变当前分支与工作区文件。'],
      confirmLabel: checkout ? '创建并切换' : '仅创建',
      tone: 'caution',
    },
    execute: (repositoryId, current) =>
      api.createBranch(repositoryId, {
        branch,
        checkout,
        expectedBranch: current.currentBranch,
        expectedHead: current.head,
      }),
    failureMessage: '创建分支失败',
    onSuccess: () => {
      branchCreateName.value = '';
    },
  });
}

function startRenameBranch(branch: BranchesSnapshot['branches'][number]): void {
  branchRenameTarget.value = branch.name;
  branchRenameName.value = branch.name;
  // 重命名输入框在 `v-for` 里，模板 ref 会解析成数组而不是元素，直接用 `.focus()` 会抛
  // `value?.focus is not a function`，结果是点了「重命名」但光标没落进输入框。按面板范围查 DOM。
  void nextTick(() => {
    const input = branchMenuPanel.value?.querySelector<HTMLInputElement>('.branch-rename input');
    input?.focus({ preventScroll: true });
    input?.select();
  });
}

function cancelRenameBranch(): void {
  branchRenameTarget.value = null;
  branchRenameName.value = '';
  void nextTick(() => {
    if (branchPanelOpen.value) branchMenuPanel.value?.focus({ preventScroll: true });
  });
}

async function renameRepositoryBranch(branch: BranchesSnapshot['branches'][number]): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  const nextBranch = branchRenameName.value.trim();
  if (!repository || !snapshot || !nextBranch || nextBranch === branch.name || branchWriteBlocker.value || branchesLoading.value) return;
  await runBranchMutation({
    busyKey: `rename:${branch.name}`,
    confirmation: {
      title: '重命名本地分支',
      summary: '重命名只改动分支引用，不改变提交内容与工作区文件。',
      target: `${repository.config.name} · ${branch.name} → ${nextBranch}`,
      details: ['被其他 Worktree 占用的分支会被拒绝。', '新名称不能与已有本地分支重名。'],
      confirmLabel: '确认重命名',
      tone: 'caution',
    },
    execute: (repositoryId, current) =>
      api.renameBranch(repositoryId, {
        branch: branch.name,
        nextBranch,
        expectedBranch: current.currentBranch,
        expectedHead: current.head,
      }),
    failureMessage: '重命名分支失败',
    onSuccess: cancelRenameBranch,
  });
}

async function deleteRepositoryBranch(branch: BranchesSnapshot['branches'][number]): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot || workspaceBusy.value || workspaceRefreshing.value) return;
  const contextVersion = repositoryContextVersion;
  const base = { branch: branch.name, expectedBranch: snapshot.currentBranch, expectedHead: snapshot.head };

  // 先预览「删除会失去哪些引用」：这决定了弹窗是普通确认还是强制删除确认。
  let preview: BranchDeletionPreview;
  try {
    preview = (await api.branchDeletionPreview(repository.config.id, base)).preview;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取删除影响失败';
    return;
  }
  if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;

  const losesCommits = preview.lostCount > 0;
  // `unmerged` 与 Git 的 `branch -d` 判据对齐，和「会不会丢提交」是两个独立维度：
  // 分支设有 upstream 时 Git 只按 upstream 判定，所以提交已合并到 HEAD、删除不丢内容的
  // 分支照样会被普通删除拒绝。两类都要走显式确认的强制删除，不能只看 lostCount。
  const needsForce = preview.unmerged;
  const force: ConfirmationCheckbox = {
    id: 'force',
    label: losesCommits
      ? '我确认强制删除；这些提交之后只留在 reflog 里'
      : '我确认仍要删除这个分支引用',
    required: true,
    value: false,
  };
  const backup: ConfirmationCheckbox = {
    id: 'backup',
    label: '删除前备份成标签',
    description: '在本地建一个 fleet-backup/ 标签指向当前提交，不推送',
    value: losesCommits,
  };
  await runBranchMutation({
    busyKey: `delete:${branch.name}`,
    confirmation: {
      title: losesCommits
        ? '强制删除未合并的本地分支'
        : needsForce
          ? '删除本地分支（需要显式确认）'
          : '删除本地分支',
      summary: losesCommits
        ? `这个分支有 ${preview.lostCount} 个提交不会被其他分支或远端引用，普通删除会被 Git 拒绝。`
        : needsForce
          ? '提交仍被其他 ref 保存，删除不会丢内容；但按 Git 的删除判据它仍算未合并，普通删除会被拒绝。'
          : '这个分支的提交仍被其他 ref 引用，删除不会丢掉内容。',
      target: `${repository.config.name} · ${branch.name} · ${preview.head.slice(0, 7)}`,
      details: losesCommits
        ? [
          ...preview.lostCommits.map((commit) => `${commit.hash.slice(0, 7)} ${commit.subject}`),
          ...(preview.lostTruncated ? [`还有 ${preview.lostCount - preview.lostCommits.length} 条未列出`] : []),
        ]
        : needsForce
          ? [
            '常见原因：分支设有 upstream 时 Git 只按 upstream 判定，提交虽已合并到当前 HEAD，但还没推到 upstream。',
            '确认后只删除这个分支引用；提交仍被其他 ref 保存，不改动工作区、远端或 upstream 配置。',
          ]
          : ['只删除分支引用；当前分支与被其他 Worktree 占用的分支仍会被拒绝。'],
      confirmLabel: losesCommits ? '强制删除分支' : needsForce ? '仍要删除分支' : '删除分支',
      tone: 'danger',
      // 会丢提交时额外给备份标签；不丢内容但 Git 拒绝时只需一次显式确认。
      checkboxes: needsForce ? (losesCommits ? [force, backup] : [force]) : undefined,
    },
    execute: (repositoryId) =>
      api.deleteBranch(repositoryId, {
        ...base,
        force: needsForce && force.value,
        backupTag: losesCommits && backup.value,
        expectedBranchHead: preview.head,
      }),
    failureMessage: '删除分支失败',
  });
}

async function deleteRepositoryRemoteBranch(branch: BranchesSnapshot['remoteBranches'][number]): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || workspaceRefreshing.value) return;
  const primary = ['main', 'master'].includes(branch.branch);
  const confirmPrimary: ConfirmationCheckbox = {
    id: 'primary',
    label: `我确认要删除远端的主分支 ${branch.name}`,
    description: '删除后其他人再拉取就看不到这个分支了；远端仓库上的对象仍可由管理员恢复',
    required: primary,
    value: false,
  };
  await runBranchMutation({
    busyKey: `delete:${branch.name}`,
    confirmation: {
      title: '删除远端分支',
      summary: `这会删除 ${branch.remote} 上的 refs/heads/${branch.branch}，是不可逆的远端操作。`,
      target: `${repository.config.name} · ${branch.name} · ${branch.head.slice(0, 7)}`,
      details: [
        '只删除远端引用：本地同名分支和其他人的克隆都不会被改动。',
        '删除前会用远端当前 sha 做一次租约复核，远端被别人推进过就拒绝删除。',
      ],
      confirmLabel: '删除远端分支',
      tone: 'danger',
      checkboxes: primary ? [confirmPrimary] : undefined,
    },
    execute: (repositoryId) =>
      api.deleteRemoteBranch(repositoryId, {
        remote: branch.remote,
        branch: branch.branch,
        expectedHead: branch.head,
        confirmPrimary: primary && confirmPrimary.value,
      }),
    failureMessage: '删除远端分支失败',
  });
}

async function checkoutRepositoryRemoteBranch(branch: RemoteBranch): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot || branchPanelBlocker.value || branchesLoading.value || filesLoading.value) return;
  const localName = reactive({
    label: '本地分支名称',
    value: branch.branch,
    validate: (value: string) => branchSnapshot.value?.branches.some(item => item.name === value)
      ? `本地分支 ${value} 已存在，请使用其他名称` : null,
  });
  await runBranchMutation({
    busyKey: `checkout:${branch.name}`,
    confirmation: {
      title: '检出远端分支',
      summary: '创建本地分支、跟踪所选远端分支并切换；可修改本地名称，远端 ref 在写入前会再次复核。',
      target: `${repository.config.name} · ${branch.name}`,
      details: ['能兼容的本地改动会随分支带过去；会被覆盖时 Git 会拒绝，不会丢改动。', '不会覆盖已有本地分支。'],
      confirmLabel: '检出并跟踪',
      tone: 'caution',
      input: localName,
    },
    execute: (repositoryId, current) =>
      api.checkoutRemoteBranch(repositoryId, {
        remote: branch.remote,
        branch: branch.branch,
        localBranch: localName.value.trim(),
        expectedBranch: current.currentBranch,
        expectedHead: current.head,
      }),
    failureMessage: '检出远端分支失败',
  });
}

const CONFLICT_STRATEGY_LABELS: Record<ConflictResolutionStrategy, string> = {
  ours: '取当前侧版本',
  theirs: '取合入侧版本',
  'mark-resolved': '标记为已解决',
  restore: '撤销解决并恢复冲突标记',
};
function conflictSideLabel(strategy: 'ours' | 'theirs'): string {
  const operation = selectedRepository.value?.inProgressOperation;
  if (operation === 'rebase') return strategy === 'ours' ? '基准' : '重放';
  if (operation === 'revert' && strategy === 'theirs') return '回退';
  return strategy === 'ours' ? '当前侧' : '合入侧';
}

/** 单文件冲突解决。只影响目标文件，不替其他文件做选择，也不自动提交。 */
async function resolveRepositoryConflict(
  file: FileChange,
  strategy: ConflictResolutionStrategy,
  expectedConflictFingerprint?: string,
): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const label = expectedConflictFingerprint ? '采用所预览的版本' : strategy === 'ours' || strategy === 'theirs' ? `取${conflictSideLabel(strategy)}版本` : CONFLICT_STRATEGY_LABELS[strategy];
  const accepted = await requestConfirmation({
    title: label,
    summary:
      strategy === 'restore'
        ? '会把该文件恢复成带冲突标记的状态，已做的解决会被丢弃。'
        : '只影响这一个文件，不会自动提交，也不会替其他冲突文件做选择。',
    target: `${repository.config.name} · ${file.path}`,
    details:
      strategy === 'mark-resolved'
        ? ['要求文件里已没有冲突标记。', '确认后该文件会进入暂存区。']
        : strategy === 'restore'
          ? ['用于撤销误操作，文件会重新出现冲突标记。']
          : [expectedConflictFingerprint ? `对应 Git ${strategy}；执行前复核预览中的冲突版本。` : '对应 Git ours/theirs；rebase 中 ours 是接收基准，theirs 是重放提交。', '确认后该文件会进入暂存区，等待你继续这次操作。'],
    confirmLabel: label,
    tone: 'caution',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  conflictBusy.value = `${file.id}:${strategy}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.resolveConflict(repository.config.id, { fileId: file.id, strategy, expectedConflictFingerprint });
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      selectedRepository.value = output.status;
      repositoryFiles.value = output.files;
      actionMessage.value = `${file.path} ${label}完成`;
    }
    // 和暂存一样：dashboard 全量重扫不该占着 `conflictBusy`。一次合并冲突常常有好几个
    // 文件要逐个解决，等扫描（54 个仓库约 400 ms）会让下一个文件的按钮一直是禁用的。
    scheduleStageRefresh();
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      actionError.value = `${error instanceof Error ? error.message : '解决冲突失败'}`;
    }
    if (contextCurrent) await loadRepositoryFiles(repository.config.id).catch(() => undefined);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) conflictBusy.value = null;
  }
}

/** 继续或终止被冲突中断的操作；终止会丢弃本地解决进度，必须走确认弹窗。 */
async function runOperationContinuation(mode: 'continue' | 'abort'): Promise<void> {
  const repository = selectedRepository.value;
  const operation = repository?.inProgressOperation;
  if (!repository || !operation) return;
  if (mode === 'continue' && repository.conflicted > 0) {
    actionError.value = `还有 ${repository.conflicted} 个文件未解决冲突，请先全部解决`;
    return;
  }
  const accepted = await requestConfirmation(
    mode === 'continue'
      ? {
          title: `继续 ${operation} 操作`,
          summary: '会使用 Git 默认提交信息完成这次操作。',
          target: `${repository.config.name} · ${operation}`,
          details: ['要求所有冲突都已解决并进入暂存区。', '继续后这次操作会真正写入提交历史。'],
          confirmLabel: '继续',
          tone: 'caution',
        }
      : {
          title: `终止 ${operation} 操作`,
          summary: '会回到这次操作开始前的状态，本地解决进度会被丢弃。',
          target: `${repository.config.name} · ${operation}`,
          details: ['已做的冲突解决不会被保留。', '不会影响已经提交的历史。'],
          confirmLabel: '终止并回滚',
          tone: 'danger',
        },
  );
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  operationBusy.value = mode;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output =
      mode === 'continue'
        ? await api.continueOperation(repository.config.id)
        : await api.abortOperation(repository.config.id);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      selectedRepository.value = output.result.status;
      repositoryFiles.value = output.result.files;
      actionMessage.value = output.operation.message;
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      loadRepositoryBranches(repository.config.id),
    ]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      actionError.value = `${
        error instanceof Error ? error.message : `${mode === 'continue' ? '继续' : '终止'}操作失败`
      }`;
      await loadRepositoryFiles(repository.config.id).catch(() => undefined);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) operationBusy.value = null;
  }
}

/**
 * 按块暂存 / 取消暂存。操作后文件会以新的 file ID 重新登记，
 * 所以必须按路径找回新 ID 再刷新 Diff，不能沿用旧的 fileId。
 */
async function applyDiffHunks(hunkIndex: number): Promise<void> {
  const repository = selectedRepository.value;
  const dialog = diffDialog.value;
  if (!repository || !dialog || hunkActionBusy.value !== null || hunkActionBlocked.value || !dialog.diff) return;
  const contextVersion = repositoryContextVersion;
  hunkActionBusy.value = hunkIndex;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.applyHunks(repository.config.id, {
      fileId: dialog.fileId,
      kind: dialog.kind,
      hunkIndexes: [hunkIndex],
    });
    if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
    selectedRepository.value = output.status;
    repositoryFiles.value = output.files;
    actionMessage.value = `${output.result.path} ${
      dialog.kind === 'unstaged' ? '已暂存所选差异块' : '已取消暂存所选差异块'
    }`;

    // 与文件级暂存同理：不 await 全量重扫。按块暂存是连续动作（一块接一块点），
    // 而 dashboard 重扫一次要 400 ms 上下；等它会把 `hunkActionBusy` 一直挂在那里，
    // 期间所有块按钮都是禁用的，而且 `use-repository-diff` 的 watcher 在 busy 时
    // 会跳过重读——diff 就这么空着等扫描。这里交给合并刷新，函数返回后 diff 立刻重读。
    scheduleStageRefresh();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '按块操作失败'}`;
      // 按块操作最常见的失败原因是文件 ID 过期（工作区被外部改动）。只报错不重读的话，
      // 界面还拿着旧 ID，用户点第二次会以同样的理由再失败一次。
      await loadRepositoryFiles(repository.config.id).catch(() => undefined);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) hunkActionBusy.value = null;
  }
}

async function openRepository(target: 'finder' | 'terminal' | 'vscode'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  openBusy.value = target;
  actionError.value = '';
  try {
    await api.openRepository(repository.config.id, target);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = `已在 ${target === 'finder' ? 'Finder' : target === 'terminal' ? 'Terminal' : 'VS Code'} 打开`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '打开本地仓库失败';
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) openBusy.value = null;
  }
}

/** `background` 用于定时静默刷新：不置加载态、失败不弹全局提示，避免每分钟级别的抖动与噪音。 */
async function loadRepositoryFiles(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryFilesRequest;
  const foreground = !options.background;
  if (foreground) {
    filesLoad.begin();
    filesLoading.value = true;
  }
  try {
    const files = (await api.repositoryFiles(repositoryId)).files;
    if (requestId === repositoryFilesRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryFiles.value = files;
      repositoryFilesError.value = '';
    }
  } catch (error) {
    if (!options.background && requestId === repositoryFilesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取文件状态失败';
      // 只有列表为空时才记下来：已经有内容时保留旧内容，别把画面换成错误页。
      if (repositoryFiles.value.length === 0) {
        repositoryFilesError.value = error instanceof Error ? error.message : '读取文件状态失败';
      }
    }
  } finally {
    if (foreground && filesLoad.end()) filesLoading.value = false;
  }
}

/** 已忽略清单是只读展示，仅在用户打开「显示已忽略文件」时按需拉取。 */
async function loadRepositoryIgnoredFiles(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryIgnoredRequest;
  const foreground = !options.background;
  if (foreground) {
    ignoredLoad.begin();
    ignoredLoading.value = true;
  }
  try {
    const output = await api.repositoryIgnoredFiles(repositoryId);
    if (requestId === repositoryIgnoredRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryIgnoredFiles.value = output.ignored;
      ignoredTruncated.value = output.truncated;
    }
  } catch (error) {
    if (!options.background && requestId === repositoryIgnoredRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取已忽略文件失败';
    }
  } finally {
    if (foreground && ignoredLoad.end()) ignoredLoading.value = false;
  }
}

function toggleIgnoredFiles(visible: boolean): void {
  showIgnoredFiles.value = visible;
  const repository = selectedRepository.value;
  if (!repository) return;
  if (visible) void loadRepositoryIgnoredFiles(repository.config.id);
  else {
    repositoryIgnoredRequest += 1;
    repositoryIgnoredFiles.value = [];
    ignoredTruncated.value = false;
    ignoredLoading.value = false;
  }
}

async function loadRepositoryMarkedFiles(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryMarkedRequest;
  const foreground = !options.background;
  if (foreground) {
    markedLoad.begin();
    markedLoading.value = true;
  }
  try {
    const output = await api.markedFiles(repositoryId);
    if (requestId === repositoryMarkedRequest && selectedRepository.value?.config.id === repositoryId) {
      markedFiles.value = output.files;
    }
  } catch (error) {
    if (!options.background && requestId === repositoryMarkedRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取已标记文件失败';
    }
  } finally {
    if (foreground && markedLoad.end()) markedLoading.value = false;
  }
}

function toggleMarkedFiles(visible: boolean): void {
  showMarkedFiles.value = visible;
  const repository = selectedRepository.value;
  if (!repository) return;
  if (visible) void loadRepositoryMarkedFiles(repository.config.id);
  else {
    repositoryMarkedRequest += 1;
    markedFiles.value = [];
    markedLoading.value = false;
  }
}

/**
 * 读 Stash 列表。`background` 用于 15 秒的静默刷新：不动加载态、不弹错误。
 *
 * 左侧那个「Stash 备份 N」来自整页 dashboard 扫描，会自己跟着变；这里不跟着刷，
 * 就会看到「计数 4、列表 3」——在终端 `git stash push` 之后尤其明显。
 */
async function loadRepositoryStashes(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const background = options.background === true;
  const requestId = ++repositoryStashesRequest;
  if (!background) stashesLoading.value = true;
  try {
    const stashes = (await api.repositoryStashes(repositoryId)).stashes;
    if (requestId === repositoryStashesRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryStashes.value = stashes;
    }
  } catch (error) {
    if (!background && requestId === repositoryStashesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取 Stash 失败';
    }
  } finally {
    if (!background && requestId === repositoryStashesRequest) stashesLoading.value = false;
  }
}

/** 读 Tag 列表；`background` 语义同上（终端里 `git push --tags` 后不必切仓库才看得到）。 */
async function loadRepositoryTags(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const background = options.background === true;
  const requestId = ++repositoryTagsRequest;
  if (!background) tagsLoading.value = true;
  // 远端标签是另一个网络往返，不阻塞列表：先出本地标签，探测结果回来再合并。
  // 静默刷新时不探——每 15 秒一次 ls-remote 对远端不礼貌，而它只影响「删除远端」的可用性。
  if (!background) void loadRemoteTagNames(repositoryId, requestId);
  try {
    const tags = (await api.repositoryTags(repositoryId)).tags;
    if (requestId === repositoryTagsRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryTags.value = tags;
    }
  } catch (error) {
    if (!background && requestId === repositoryTagsRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取 Tag 失败';
    }
  } finally {
    if (!background && requestId === repositoryTagsRequest) tagsLoading.value = false;
  }
}

/** 探测远端标签，只为把「删除远端」在本地专属标签上禁掉；失败就当作不知道。 */
async function loadRemoteTagNames(repositoryId: string, requestId: number): Promise<void> {
  try {
    const result = await api.remoteTagNames(repositoryId);
    if (requestId !== repositoryTagsRequest || selectedRepository.value?.config.id !== repositoryId) return;
    remoteTagNames.value = new Set(result.tags ?? []);
    remoteTagsKnown.value = result.tags !== null;
  } catch {
    // 探测只是锦上添花：读不到远端时列表照常可用，删除失败会给出准确原因。
  }
}

/** 标签是否在远端：null 表示尚未确认。 */
function tagOnRemote(tag: TagEntry): boolean | null {
  return remoteTagsKnown.value ? remoteTagNames.value.has(tag.name) : null;
}

function applyTagMutationResult(
  repository: RepositoryStatus,
  tags: TagEntry[],
  status: RepositoryStatus,
  contextVersion: number,
): boolean {
  if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return false;
  selectedRepository.value = status;
  repositoryTags.value = tags;
  return true;
}

async function createRepositoryTag(): Promise<void> {
  const repository = selectedRepository.value;
  const name = tagForm.name.trim();
  if (!repository || !name || tagBusy.value !== null) return;
  const message = tagForm.message.trim();
  const push = tagForm.push;
  const accepted = await requestConfirmation({
    title: push ? '创建并推送 Tag' : '创建本地 Tag',
    summary: message
      ? '附注标签会记录说明与创建者信息。'
      : '不填说明则创建轻量标签，它只是一个指向提交的引用。',
    target: `${repository.config.name} · ${name} → ${repository.lastCommit?.hash.slice(0, 7) ?? 'HEAD'}`,
    details: push
      ? ['创建后会推送到仓库配置的默认远端。', '远端已有同名 Tag 时会被拒绝，不会覆盖。']
      : ['只在本地创建，不会连接远端。'],
    confirmLabel: push ? '创建并推送' : '创建 Tag',
    tone: 'caution',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  tagBusy.value = `create:${name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.createTag(repository.config.id, {
      name,
      target: repository.lastCommit?.hash ?? 'HEAD',
      message,
      push,
    });
    if (applyTagMutationResult(repository, output.result.tags, output.result.status, contextVersion)) {
      actionMessage.value = output.operation.message;
      tagForm.name = '';
      tagForm.message = '';
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '创建 Tag 失败'}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) tagBusy.value = null;
  }
}

async function deleteRepositoryTag(tag: TagEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || tagBusy.value !== null) return;
  const accepted = await requestConfirmation({
    title: '删除本地 Tag',
    summary: '只删除本机标签引用；远端同名 Tag 不受影响。',
    target: `${repository.config.name} · ${tag.name}`,
    details: ['已推送到远端的同名 Tag 需要另行在远端删除。', '不会影响任何提交内容。'],
    confirmLabel: '删除 Tag',
    tone: 'danger',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  tagBusy.value = `delete:${tag.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.deleteTag(repository.config.id, { name: tag.name, expectedHash: tag.hash });
    if (applyTagMutationResult(repository, output.result.tags, output.result.status, contextVersion)) {
      actionMessage.value = output.operation.message;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '删除 Tag 失败'}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) tagBusy.value = null;
  }
}

async function pushRepositoryTag(tag: TagEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || tagBusy.value !== null) return;
  const accepted = await requestConfirmation({
    title: '推送 Tag 到远端',
    summary: '使用显式 refspec 推送单个 Tag，永不 force。',
    target: `${repository.config.name} · ${tag.name}`,
    details: ['推送到仓库配置里的默认远端。', '远端已有同名 Tag 时会被拒绝，不会覆盖。', '推送失败不影响本地 Tag。'],
    confirmLabel: '推送 Tag',
    tone: 'caution',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  tagBusy.value = `push:${tag.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    // 不传 remote：由服务端用仓库配置的 defaultRemote，避免客户端写死 remote 名。
    const output = await api.pushTag(repository.config.id, { name: tag.name });
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = output.operation.message;
      // 刚推成功：远端已经有这个标签，不必等下一次探测。
      remoteTagNames.value = new Set([...remoteTagNames.value, tag.name]);
      remoteTagsKnown.value = true;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '推送 Tag 失败'}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) tagBusy.value = null;
  }
}

async function deleteRepositoryRemoteTag(tag: TagEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || tagBusy.value !== null) return;
  const accepted = await requestConfirmation({
    title: '删除远端标签',
    summary: '这会删除默认远端上的同名标签，是不可逆的远端操作。',
    target: `${repository.config.name} · ${tag.name} → ${tag.targetHash.slice(0, 7)}`,
    details: [
      '只删除远端标签：本地标签不会被改动。',
      '删除前会用远端当前 sha 做一次租约复核；远端标签被换过就拒绝删除。',
      '远端没有这个标签时会明确提示，不会当成成功。',
    ],
    confirmLabel: '删除远端标签',
    tone: 'danger',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  tagBusy.value = `delete-remote:${tag.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.deleteRemoteTag(repository.config.id, { name: tag.name, expectedHash: tag.hash });
    if (applyTagMutationResult(repository, output.result.tags, output.result.status, contextVersion)) {
      actionMessage.value = output.operation.message;
      const next = new Set(remoteTagNames.value);
      next.delete(tag.name);
      remoteTagNames.value = next;
      remoteTagsKnown.value = true;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '删除远端标签失败'}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) tagBusy.value = null;
  }
}

/**
 * 整仓与「只备份选中文件」共用同一段写链路：请求序号、忙碌态、列表与 dashboard 刷新。
 * 分开写容易漏掉一处刷新，后台 15 秒静默刷新又会掩盖这种遗漏。
 */
async function executeStashCreation(input: {
  repository: RepositoryStatus;
  contextVersion: number;
  message: string;
  includeUntracked: boolean;
  fileIds?: string[];
}): Promise<void> {
  const { repository, contextVersion } = input;
  repositoryStashesRequest += 1;
  repositoryFilesRequest += 1;
  stashesLoading.value = false;
  filesLoading.value = false;
  stashBusy.value = 'create';
  actionError.value = '';
  try {
    const output = await api.createStash(repository.config.id, input.message, input.includeUntracked, input.fileIds);
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      repositoryStashes.value = output.result.stashes;
      if (!input.fileIds?.length) stashMessage.value = '';
      actionMessage.value = output.operation.message;
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
    ]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '创建 Stash 失败';
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) stashBusy.value = null;
  }
}

async function createRepositoryStash(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  const accepted = await requestConfirmation({
    title: '创建 Stash 备份',
    summary: '当前工作区改动会保存到 Stash，并暂时从工作区移走。',
    target: repository.config.name,
    details: [
      stashIncludeUntracked.value ? '包含未跟踪文件。' : '不包含未跟踪文件。',
      stashMessage.value.trim() ? `备份说明：${stashMessage.value.trim()}` : '未填写备份说明。',
    ],
    confirmLabel: '创建并清空工作区',
    tone: 'caution',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  await executeStashCreation({
    repository,
    contextVersion,
    message: stashMessage.value,
    includeUntracked: stashIncludeUntracked.value,
  });
}

/**
 * 只把工作区里勾选的文件存进一条 Stash。
 *
 * 勾选即 `git add`，所以这里以 `staged && !conflicted` 为「选中」口径，和
 * `checkedUncommittedPaths` / 提交预览一致。传给服务端的是文件 token 而不是路径，
 * 由它按当前工作区复核；一次最多 `maxStashFileSelection` 个（与写接口 schema 同上限）。
 */
async function stashRepositoryFiles(paths: string[]): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || !paths.length || workspaceBusy.value || workspaceRefreshing.value || !repository.config.capabilities.stash) return;
  if (paths.length > maxStashFileSelection) {
    actionError.value = `一次最多备份 ${maxStashFileSelection} 个文件，请减少勾选后重试`;
    return;
  }
  const contextVersion = repositoryContextVersion;
  const selectedPaths = new Set(paths);
  const files = repositoryFiles.value.filter((file) => selectedPaths.has(file.path) && file.staged && !file.conflicted);
  // 按去重后的路径数比对：重复路径不该被当成「状态已变化」。
  if (files.length !== selectedPaths.size) {
    actionError.value = '文件状态已变化，请刷新后重试';
    await loadRepositoryFiles(repository.config.id);
    return;
  }
  const preview = files.slice(0, 5).map((file) => file.path);
  const accepted = await requestConfirmation({
    title: '保存选中文件到 Stash 备份',
    summary: `勾选的 ${files.length} 个文件会存进一条 Stash 备份，并从工作区移走；未勾选的文件保持原样。`,
    target: `${repository.config.name} · ${files.length} 个文件`,
    details: [
      '这些文件会同时移出 Git 索引，本次提交的勾选会被取消；同一文件未暂存的改动也会一并收走。',
      '以后用「应用并保留 / 应用并删除」恢复时，文件内容会回来，但不会自动回到已勾选状态，需要重新暂存。',
      ...preview,
      ...(files.length > preview.length ? [`另有 ${files.length - preview.length} 个文件未列出`] : []),
    ],
    confirmLabel: `保存到 Stash（${files.length}）`,
    tone: 'caution',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || workspaceBusy.value || workspaceRefreshing.value) return;
  await executeStashCreation({
    repository,
    contextVersion,
    // 工作区页签里没有说明输入框；服务端会用时间戳生成默认说明。
    // includeUntracked 固定为 true，带 pathspec 时只会收选中路径下的未跟踪文件。
    message: '',
    includeUntracked: true,
    fileIds: files.map((file) => file.id),
  });
}

async function applyRepositoryStash(stash: StashEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  const accepted = await requestConfirmation({
    title: '应用 Stash 备份',
    summary: '备份中的改动将恢复到当前干净工作区。',
    target: `${repository.config.name} · ${stash.ref}`,
    details: ['应用后原 Stash 会继续保留。', '如果代码基线已经变化，恢复过程仍可能产生冲突。'],
    confirmLabel: '应用并保留 Stash',
    tone: 'caution',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  repositoryStashesRequest += 1;
  repositoryFilesRequest += 1;
  stashesLoading.value = false;
  filesLoading.value = false;
  stashBusy.value = `apply:${stash.hash}`;
  actionError.value = '';
  try {
    const output = await api.applyStash(repository.config.id, stash);
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      repositoryStashes.value = output.result.stashes;
      actionMessage.value = output.operation.message;
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
    ]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) actionError.value = error instanceof Error ? error.message : '应用 Stash 失败';
    await Promise.all([
      query.refetch(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
    ]);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) stashBusy.value = null;
  }
}

async function popRepositoryStash(stash: StashEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  const accepted = await requestConfirmation({
    title: '应用并删除 Stash 备份',
    summary: '备份中的改动将恢复到当前干净工作区，并从 Stash 列表中删除。',
    target: `${repository.config.name} · ${stash.ref}`,
    details: [
      '删除后无法通过 Moo Fleet 恢复这条备份。',
      '如果代码基线已经变化，恢复过程仍可能产生冲突；产生冲突时条目会保留。',
    ],
    confirmLabel: '应用并删除备份',
    tone: 'danger',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  repositoryStashesRequest += 1;
  repositoryFilesRequest += 1;
  stashesLoading.value = false;
  filesLoading.value = false;
  stashBusy.value = `pop:${stash.hash}`;
  actionError.value = '';
  try {
    const output = await api.popStash(repository.config.id, stash);
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      repositoryStashes.value = output.result.stashes;
      selectedRepository.value = output.result.status;
      actionMessage.value = output.operation.message;
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
    ]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) actionError.value = error instanceof Error ? error.message : '应用并删除 Stash 失败';
    // 应用成功但删除失败时条目还在，刷新列表让用户看到真实状态。
    await Promise.all([
      query.refetch(),
      contextCurrent ? loadRepositoryStashes(repository.config.id) : Promise.resolve(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
    ]);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) stashBusy.value = null;
  }
}

async function dropRepositoryStash(stash: StashEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  const accepted = await requestConfirmation({
    title: '永久删除 Stash 备份',
    summary: '该备份将从当前仓库永久删除，删除后无法通过 Moo Fleet 恢复。',
    target: `${repository.config.name} · ${stash.ref}`,
    details: [stash.message || '该备份没有说明。', '只删除 Stash 条目，不修改当前工作区文件。'],
    confirmLabel: '永久删除备份',
    tone: 'danger',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  repositoryStashesRequest += 1;
  stashesLoading.value = false;
  stashBusy.value = `drop:${stash.hash}`;
  actionError.value = '';
  try {
    const output = await api.dropStash(repository.config.id, stash);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      repositoryStashes.value = output.result.stashes;
      selectedRepository.value = output.result.status;
      actionMessage.value = output.operation.message;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) actionError.value = error instanceof Error ? error.message : '删除 Stash 失败';
    await Promise.all([
      contextCurrent ? loadRepositoryStashes(repository.config.id) : Promise.resolve(),
      operationsQuery.refetch(),
    ]);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) stashBusy.value = null;
  }
}

/**
 * 暂存 / 取消暂存串行排队。
 *
 * 之前这里是「有操作在跑就直接 return」，快速勾第二个文件时那一次点击会被静默丢掉：
 * 界面上什么都没发生，用户以为两个文件都进了提交，实际只有一个。这里不能改成并发，
 * 因为每次响应都会把整批文件 ID 换新，并发调用会拿上一轮的 ID 去写；而且同一个文件
 * 连点两下（先勾后取消）时，并发执行的到达顺序不确定。所以排队，每次轮到自己时
 * 重新读一遍文件列表拿最新 ID。
 */
let stageQueue: Promise<void> = Promise.resolve();
/** 一串连点会触发很多次暂存，dashboard 的重扫合并成一次。 */
let stageRefreshTimer: number | null = null;

function scheduleStageRefresh(): void {
  if (stageRefreshTimer !== null) return;
  stageRefreshTimer = window.setTimeout(() => {
    stageRefreshTimer = null;
    void query.refetch().catch(() => undefined);
  }, 120);
}

function updateFilesStage(paths: string[], action: 'stage' | 'unstage'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || !paths.length || !repository.config.capabilities.stage) return Promise.resolve();
  const repositoryId = repository.config.id;
  const contextVersion = repositoryContextVersion;
  stageQueue = stageQueue
    .catch(() => undefined)
    .then(() => applyFilesStage(repositoryId, paths, action, contextVersion));
  return stageQueue;
}

async function applyFilesStage(
  repositoryId: string,
  paths: string[],
  action: 'stage' | 'unstage',
  contextVersion: number,
): Promise<void> {
  // 排队期间仓库可能被切走，也可能有别的写操作插进来（提交、切分支、丢弃），
  // 这些都会动索引，轮到自己时再判一次。
  if (!isCurrentRepositoryContext(repositoryId, contextVersion)) return;
  if (stageLocked.value || filesLoading.value || workspaceRefreshing.value) return;
  const selectedPaths = new Set(paths);
  const files = repositoryFiles.value.filter((file) => selectedPaths.has(file.path) && !file.conflicted && (action === 'stage' ? file.unstaged : file.staged));
  if (!files.length) return;
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  fileActionId.value = files[0]!.id;
  actionError.value = '';
  actionMessage.value = '';
  let completed = 0;
  try {
    const pathsToWrite = files.map((file) => file.path);
    // The existing API accepts at most 100 IDs. Each response renews all file IDs.
    for (let offset = 0; offset < pathsToWrite.length; offset += 100) {
      if (!isCurrentRepositoryContext(repositoryId, contextVersion)) return;
      const batchPaths = new Set(pathsToWrite.slice(offset, offset + 100));
      const batch = repositoryFiles.value.filter((file) => batchPaths.has(file.path) && !file.conflicted && (action === 'stage' ? file.unstaged : file.staged));
      if (batch.length !== batchPaths.size) throw new Error('文件状态已变化，请刷新后重试');
      const output = action === 'stage'
        ? await api.stageFiles(repositoryId, batch.map((file) => file.id))
        : await api.unstageFiles(repositoryId, batch.map((file) => file.id));
      if (isCurrentRepositoryContext(repositoryId, contextVersion)) {
        repositoryFiles.value = output.files;
        completed += batch.length;
        actionMessage.value = `${action === 'stage' ? '已暂存' : '已取消暂存'} ${completed} / ${files.length} 个文件`;
      }
    }
    // 不 await：文件列表已经拿到，dashboard 只是把计数刷一遍。等它会把「正在暂存」
    // 的窗口拖到一次全量扫描那么长，后面排队的点击全被挡在门外。
    scheduleStageRefresh();
  } catch (error) {
    if (isCurrentRepositoryContext(repositoryId, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '文件操作失败'}${completed ? `；已完成 ${completed} / ${files.length} 个文件` : ''}`;
      await loadRepositoryFiles(repositoryId);
    }
  } finally {
    if (isCurrentRepositoryContext(repositoryId, contextVersion)) fileActionId.value = null;
  }
}

function fileDiscardAction(file: FileChange): 'trash' | 'restore' | null {
  if (file.conflicted || file.staged) return null;
  if (file.untracked) return 'trash';
  return file.unstaged && ['M', 'D', 'T'].includes(file.worktreeStatus) ? 'restore' : null;
}

async function discardRepositoryFile(file: FileChange): Promise<void> {
  const repository = selectedRepository.value;
  const action = fileDiscardAction(file);
  if (!repository || !action || workspaceBusy.value || workspaceRefreshing.value || !repository.config.capabilities.stage) return;
  const contextVersion = repositoryContextVersion;
  const backsUpCurrentContent = action === 'restore' && file.worktreeStatus !== 'D';
  const accepted = await requestConfirmation({
    title: action === 'trash' ? '移到系统废纸篓' : '丢弃本地修改',
    summary: action === 'trash'
      ? '未跟踪文件将从仓库工作区移除。'
      : backsUpCurrentContent
        ? '当前内容会先进入系统废纸篓，再恢复到 Git 版本。'
        : '被删除的文件会恢复到当前 Git 版本。',
    target: file.path,
    details: action === 'trash'
      ? ['文件会进入 macOS 废纸篓，之后仍可手动恢复。', `操作范围仅限 ${repository.config.name} 中的这个文件。`]
      : backsUpCurrentContent
        ? ['未暂存的当前内容会进入 macOS 废纸篓，之后仍可手动恢复。', '随后仅恢复这个文件，不影响已暂存内容。']
        : ['当前路径已没有可备份的文件内容。', '操作只恢复这个文件，不影响已暂存内容。'],
    confirmLabel: action === 'trash' ? '移到废纸篓' : backsUpCurrentContent ? '备份并丢弃修改' : '恢复文件',
    tone: 'danger',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || workspaceBusy.value || workspaceRefreshing.value) return;
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  fileDiscardId.value = file.id;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.discardFile(repository.config.id, file.id);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) repositoryFiles.value = output.files;
    // 文件清单已经拿到了，dashboard 只是把计数刷一遍；等它会把「正在清理」的窗口
    // 拖到一次全量扫描那么长（54 个仓库约 400 ms），期间其他操作全被挡住。
    scheduleStageRefresh();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '文件清理失败';
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) fileDiscardId.value = null;
  }
}

/**
 * 批量删除勾选中的未提交新文件。
 *
 * 勾选即 `git add`，所以这批文件在服务端是索引里的 `A`（`untracked` 已经变 false），
 * 单文件删除的入口对它们全部失效——这正是这个入口存在的理由。服务端会先取消暂存
 * 再逐个移进废纸篓。
 */
async function discardRepositoryUntrackedFiles(paths: string[]): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || !paths.length || workspaceBusy.value || workspaceRefreshing.value || !repository.config.capabilities.stage) return;
  const contextVersion = repositoryContextVersion;
  const preview = paths.slice(0, 5);
  const accepted = await requestConfirmation({
    title: '删除未提交文件',
    summary: `勾选的 ${paths.length} 个未提交文件会从工作区移除。`,
    target: paths.length === 1 ? paths[0]! : `${paths.length} 个未提交文件`,
    details: [
      '文件会进入系统废纸篓，之后仍可手动恢复。',
      // 只有一个文件时路径已经写在「本次范围」里，不必再列一遍。
      ...(paths.length > 1 ? preview : []),
      ...(paths.length > preview.length ? [`另有 ${paths.length - preview.length} 个文件`] : []),
      `操作范围仅限 ${repository.config.name} 中勾选的这些文件。`,
    ],
    confirmLabel: `移到废纸篓（${paths.length}）`,
    tone: 'danger',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || workspaceBusy.value || workspaceRefreshing.value) return;
  const selectedPaths = new Set(paths);
  const targets = repositoryFiles.value.filter((file) => selectedPaths.has(file.path) && file.staged && isUncommittedNewFile(file));
  if (targets.length !== paths.length) {
    actionError.value = '文件状态已变化，请刷新后重试';
    await loadRepositoryFiles(repository.config.id);
    return;
  }
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  fileDiscardBatchBusy.value = true;
  actionError.value = '';
  actionMessage.value = '';
  let removed = 0;
  const failed: Array<{ path: string; message: string }> = [];
  try {
    // 单次最多 100 个 id；每批的响应都会整体续期文件 id，所以下一批按最新列表重新取。
    for (let offset = 0; offset < paths.length; offset += 100) {
      if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
      const batchPaths = new Set(paths.slice(offset, offset + 100));
      const batch = repositoryFiles.value.filter((file) => batchPaths.has(file.path) && file.staged && isUncommittedNewFile(file));
      if (batch.length !== batchPaths.size) throw new Error('文件状态已变化，请刷新后重试');
      const output = await api.discardUntrackedFiles(repository.config.id, batch.map((file) => file.id));
      if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
      repositoryFiles.value = output.files;
      removed += output.result.trashed.length + output.result.indexedOnly.length;
      failed.push(...output.result.failed);
      // 有文件没删掉就先停下：列表已经变了，剩下的批次让用户看过再决定。
      if (failed.length) break;
    }
    if (failed.length) {
      actionError.value = `已删除 ${removed} 个文件；${failed.length} 个失败：${failed[0]!.message}`;
      await loadRepositoryFiles(repository.config.id);
    } else {
      actionMessage.value = `已删除 ${removed} 个未提交文件`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '文件删除失败'}${removed ? `；已完成 ${removed} 个文件` : ''}`;
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      fileDiscardBatchBusy.value = false;
      // 文件清单已经拿到了，dashboard 只是把计数刷一遍。等它会把「正在删除」的窗口
      // 拖到一次全量扫描那么长（54 个仓库约 400 ms），期间按钮和勾选框全被锁住。
      scheduleStageRefresh();
    }
  }
}

async function discardRepositoryTrackedFiles(paths: string[]): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || !paths.length || workspaceBusy.value || workspaceRefreshing.value || !repository.config.capabilities.stage) return;
  const contextVersion = repositoryContextVersion;
  const preview = paths.slice(0, 5);
  const accepted = await requestConfirmation({
    title: '还原已勾选的文件',
    summary: `勾选的 ${paths.length} 个文件会还原到上次提交，改动被丢弃。`,
    target: paths.length === 1 ? paths[0]! : `${paths.length} 个文件`,
    details: [
      '工作区里这些文件的改动会先进入系统废纸篓（可在废纸篓找回），再恢复到 Git 版本。',
      '同时会取消这些文件的暂存。',
      ...(paths.length > 1 ? preview : []),
      ...(paths.length > preview.length ? [`另有 ${paths.length - preview.length} 个文件`] : []),
      `操作范围仅限 ${repository.config.name} 中勾选的这些文件。`,
    ],
    confirmLabel: `还原 ${paths.length} 个文件`,
    tone: 'danger',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || workspaceBusy.value || workspaceRefreshing.value) return;
  const selectedPaths = new Set(paths);
  const targets = repositoryFiles.value.filter((file) => selectedPaths.has(file.path) && !file.conflicted && !file.untracked && (file.staged || file.unstaged));
  if (targets.length !== paths.length) {
    actionError.value = '文件状态已变化，请刷新后重试';
    await loadRepositoryFiles(repository.config.id);
    return;
  }
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  fileDiscardBatchBusy.value = true;
  actionError.value = '';
  actionMessage.value = '';
  let restored = 0;
  const skipped: Array<{ path: string; reason: string }> = [];
  try {
    // 单次最多 100 个 id；每批响应整体续期文件 id，下一批按最新列表重新取。
    for (let offset = 0; offset < paths.length; offset += 100) {
      if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
      const batchPaths = new Set(paths.slice(offset, offset + 100));
      const batch = repositoryFiles.value.filter((file) => batchPaths.has(file.path) && !file.conflicted && !file.untracked && (file.staged || file.unstaged));
      if (batch.length !== batchPaths.size) throw new Error('文件状态已变化，请刷新后重试');
      const output = await api.discardTrackedFiles(repository.config.id, batch.map((file) => file.id));
      if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
      repositoryFiles.value = output.files;
      restored += output.result.restored.length;
      skipped.push(...output.result.skipped);
    }
    if (skipped.length) {
      actionMessage.value = `已还原 ${restored} 个文件；${skipped.length} 个跳过：${skipped[0]!.reason}`;
    } else {
      actionMessage.value = `已还原 ${restored} 个文件到上次提交`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '还原失败'}${restored ? `；已完成 ${restored} 个文件` : ''}`;
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      fileDiscardBatchBusy.value = false;
      scheduleStageRefresh();
    }
  }
}

async function openRepositoryFile(file: FileChange | IgnoredEntry | MarkedFile, target: 'reveal' | 'editor'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  openBusy.value = target;
  actionError.value = '';
  try {
    await api.openRepository(repository.config.id, target, file.id);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = `${file.path} 已在${target === 'reveal' ? '访达中显示' : ' VS Code 中打开'}`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '打开文件失败';
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) openBusy.value = null;
  }
}

/** 写入一条忽略 / 本机排除规则，并把刷新后的文件清单与已忽略清单一起更新。 */
async function ignoreRepositoryFile(
  file: FileChange,
  target: IgnoreTarget,
  scope: 'path' | 'name' | 'custom',
  pattern?: string,
): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || !repository.config.capabilities.stage) return;
  const contextVersion = repositoryContextVersion;
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  ignoreBusyId.value = file.id;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.ignoreRule(repository.config.id, {
      fileId: file.id,
      target,
      scope,
      ...(pattern ? { pattern } : {}),
    });
    const where = target === 'gitignore' ? '.gitignore' : '.git/info/exclude';
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      repositoryFiles.value = output.files;
      actionMessage.value = output.result.created
        ? `已写入 ${where}：${output.result.pattern}`
        : `${where} 中已有这条规则：${output.result.pattern}`;
    }
    scheduleStageRefresh();
    if (showIgnoredFiles.value) await loadRepositoryIgnoredFiles(repository.config.id, { background: true });
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '写入忽略规则失败';
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) ignoreBusyId.value = null;
  }
}

/** 「按模式忽略…」：预填由文件名推导的模式，允许在确认弹窗里改完再写入。 */
async function promptIgnorePattern(file: FileChange, target: IgnoreTarget): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || !repository.config.capabilities.stage) return;
  const input: ConfirmationInput = {
    label: '忽略模式',
    value: file.path.replace(/\/+$/, '').split('/').at(-1) ?? file.path,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return '请输入忽略模式';
      if (/[\0\r\n]/.test(trimmed)) return '忽略模式必须为单行文本';
      if (trimmed.length > 200) return '忽略模式过长（最多 200 个字符）';
      return null;
    },
  };
  const where = target === 'gitignore' ? '.gitignore' : '.git/info/exclude';
  const accepted = await requestConfirmation({
    title: target === 'gitignore' ? '按模式忽略' : '按模式仅在本机排除',
    summary: `规则会写入 ${where}；可以修改下面的模式再确认。`,
    target: file.path,
    details: [
      '忽略只对未跟踪文件生效；已在版本控制里的文件需要先取消跟踪再提交。',
      target === 'gitignore'
        ? '.gitignore 随仓库提交，对其他协作者同样生效。'
        : '本地排除不进入版本控制，只影响这台电脑。',
    ],
    confirmLabel: '写入规则',
    input,
  });
  if (!accepted) return;
  await ignoreRepositoryFile(file, target, 'custom', input.value.trim());
}

/**
 * 标记 / 取消标记 assume-unchanged。
 * 标记成功后该文件的本地修改会从工作区清单消失——这是 Git 语义（status 不再报告它），不是文件被删。
 */
async function setRepositoryAssumeUnchanged(file: FileChange | MarkedFile, assumed: boolean): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || assumeBusyId.value) return;
  if (!repository.config.capabilities.stage) {
    actionError.value = '仓库配置禁止文件修改';
    return;
  }
  const contextVersion = repositoryContextVersion;
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  assumeBusyId.value = file.id;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.setAssumeUnchanged(repository.config.id, { fileId: file.id, assumed });
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      repositoryFiles.value = output.files;
      markedFiles.value = output.marked;
      actionMessage.value = assumed
        ? `已标记 ${output.result.path}：本地修改不再进入提交，只在本机生效`
        : `已取消标记 ${output.result.path}`;
    }
    scheduleStageRefresh();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '标记文件失败';
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) assumeBusyId.value = null;
  }
}

function ignoreRuleRowId(file: IgnoreFileRules, rule: IgnoreRuleLine): string {
  return `${file.target}:${rule.line}`;
}

/** 规则列表跟随「编辑仓库配置」弹窗加载；弹窗关闭后不写入状态。 */
async function loadRepositoryIgnoreRules(repositoryId: string): Promise<void> {
  const requestId = ++repositoryIgnoreRulesRequest;
  ignoreRulesLoading.value = true;
  try {
    const output = await api.ignoreRules(repositoryId);
    if (requestId === repositoryIgnoreRulesRequest && repositoryEdit.value?.id === repositoryId) {
      ignoreRules.value = output.files;
    }
  } catch (error) {
    if (requestId === repositoryIgnoreRulesRequest && repositoryEdit.value?.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取忽略规则失败';
    }
  } finally {
    if (requestId === repositoryIgnoreRulesRequest) ignoreRulesLoading.value = false;
  }
}

async function removeRepositoryIgnoreRule(file: IgnoreFileRules, rule: IgnoreRuleLine): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || rule.kind !== 'rule' || ignoreRuleBusy.value) return;
  if (!repository.config.capabilities.stage) {
    actionError.value = '仓库配置禁止文件修改';
    return;
  }
  const busyId = ignoreRuleRowId(file, rule);
  ignoreRuleBusy.value = busyId;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.removeIgnoreRule(repository.config.id, {
      target: file.target,
      line: rule.line,
      pattern: rule.text,
    });
    repositoryFiles.value = output.files;
    actionMessage.value = `已移除规则：${output.result.pattern}`;
    scheduleStageRefresh();
    await loadRepositoryIgnoreRules(repository.config.id);
    if (showIgnoredFiles.value) await loadRepositoryIgnoredFiles(repository.config.id, { background: true });
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移除忽略规则失败';
    await loadRepositoryIgnoreRules(repository.config.id);
  } finally {
    if (ignoreRuleBusy.value === busyId) ignoreRuleBusy.value = null;
  }
}

async function openRepositoryIgnoreFile(target: IgnoreTarget): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  openBusy.value = 'editor';
  actionError.value = '';
  try {
    await api.openRepository(repository.config.id, 'editor', undefined, target);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = `已在 VS Code 中打开 ${target === 'gitignore' ? '.gitignore' : '.git/info/exclude'}`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '打开忽略文件失败';
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) openBusy.value = null;
  }
}

/** 「不再忽略」：由服务端用 `git check-ignore -v` 定位规则；规则来自别处时只提示，不算失败。 */
async function unignoreRepositoryFile(file: FileChange | IgnoredEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || !repository.config.capabilities.stage) return;
  const contextVersion = repositoryContextVersion;
  ignoreBusyId.value = file.id;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.unignoreFile(repository.config.id, file.id);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      repositoryFiles.value = output.files;
      // 没移除不等于失败，但结果要用户另找地方处理，所以是 warning 而不是 success。
      if (output.result.removed) actionMessage.value = output.message;
      else actionWarning.value = output.message;
    }
    scheduleStageRefresh();
    if (showIgnoredFiles.value) await loadRepositoryIgnoredFiles(repository.config.id, { background: true });
    if (repositoryEdit.value?.id === repository.config.id) await loadRepositoryIgnoreRules(repository.config.id);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '取消忽略失败';
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) ignoreBusyId.value = null;
  }
}

async function handleRepositoryFileAction(file: FileChange, action: FileMenuAction): Promise<void> {
  if (action === 'copy-path') {
    await copyToClipboard(file.path, '相对路径');
    return;
  }
  if (action === 'reveal' || action === 'editor') {
    await openRepositoryFile(file, action);
    return;
  }
  if (action === 'ignore-path') await ignoreRepositoryFile(file, 'gitignore', 'path');
  else if (action === 'ignore-name') await ignoreRepositoryFile(file, 'gitignore', 'name');
  else if (action === 'ignore-pattern') await promptIgnorePattern(file, 'gitignore');
  else if (action === 'exclude-path') await ignoreRepositoryFile(file, 'exclude', 'path');
  else if (action === 'exclude-name') await ignoreRepositoryFile(file, 'exclude', 'name');
  else if (action === 'exclude-pattern') await promptIgnorePattern(file, 'exclude');
  else if (action === 'assume') await setRepositoryAssumeUnchanged(file, true);
}

async function handleIgnoredFileAction(entry: IgnoredEntry, action: FileMenuAction): Promise<void> {
  if (action === 'copy-path') await copyToClipboard(entry.path, '相对路径');
  else if (action === 'reveal' || action === 'editor') await openRepositoryFile(entry, action);
  else if (action === 'unignore') await unignoreRepositoryFile(entry);
}

async function handleMarkedFileAction(entry: MarkedFile, action: FileMenuAction): Promise<void> {
  if (action === 'copy-path') await copyToClipboard(entry.path, '相对路径');
  else if (action === 'reveal' || action === 'editor') await openRepositoryFile(entry, action);
  else if (action === 'unassume') await setRepositoryAssumeUnchanged(entry, false);
}

async function showFileDiff(file: FileChange, kind?: DiffKind): Promise<void> {
  await repositoryDiff.select(file, kind);
}

async function switchDiffKind(kind: DiffKind): Promise<void> {
  await repositoryDiff.switchKind(kind);
}

async function refreshRepositoryWorkspace(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || workspaceRefreshing.value) return;
  workspaceRefreshing.value = true;
  const contextVersion = repositoryContextVersion;
  actionError.value = '';
  try {
    await query.refetch();
    if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
    await Promise.all([
      loadRepositoryFiles(repository.config.id), loadRepositoryBranches(repository.config.id),
      loadRepositoryStashes(repository.config.id),
      loadRepositoryTags(repository.config.id),
      showIgnoredFiles.value ? loadRepositoryIgnoredFiles(repository.config.id) : Promise.resolve(),
      showMarkedFiles.value ? loadRepositoryMarkedFiles(repository.config.id) : Promise.resolve(),
    ]);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) workspaceRefreshing.value = false;
  }
}

/**
 * 定时后台刷新：只重读当前仓库的文件与分支，静默进行（不动加载态、失败不弹提示）。
 * 有写操作、用户刷新，或合并/确认/编辑等遮挡层打开时跳过，避免与用户正在做的事打架。
 */
async function refreshRepositoryWorkspaceInBackground(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || backgroundRefreshInFlight) return;
  if (workspaceBusy.value || workspaceRefreshing.value) return;
  if (branchMerge.value || pushBranches.value || confirmation.value || repositoryEdit.value || upstreamRepair.value
    || manageOpen.value || shortcutHelpOpen.value || branchPanelOpen.value) return;
  backgroundRefreshInFlight = true;
  try {
    await Promise.all([
      loadRepositoryFiles(repository.config.id, { background: true }),
      loadRepositoryBranches(repository.config.id, { background: true }),
      // Stash 与 Tag 也要跟着刷：左侧计数来自整页扫描，列表不刷就会「计数变了列表没变」，
      // 更糟的是在终端 pop 掉一条之后，列表里那条还在，点「应用」只会报 ref 不存在。
      loadRepositoryStashes(repository.config.id, { background: true }),
      loadRepositoryTags(repository.config.id, { background: true }),
    ]);
  } finally {
    backgroundRefreshInFlight = false;
  }
}

async function submitCommit(): Promise<void> {
  const repository = selectedRepository.value;
  const preview = composer.preview.value;
  const message = composer.message.value;
  if (!repository || !preview || !composer.ready.value || composer.suggesting.value || commitBlocker.value || !message.split('\n')[0]?.trim()) return;
  // detached HEAD 上提交不会属于任何分支，切走后只能从 Reflog 找回：提交前明确确认一次。
  if (repository.detached) {
    const accepted = await requestConfirmation({
      title: '在 detached HEAD 上提交',
      summary: '当前 HEAD 不在任何分支上，这条提交不会有分支指向它。',
      target: `${repository.config.name} · ${repository.lastCommit?.hash.slice(0, 8) ?? 'HEAD'}`,
      details: [
        '提交会正常写入对象库，但切到别的分支后只能从 Reflog 找回。',
        '更稳妥的做法是先新建分支再提交；取消后可在工作区顶部点「新建分支」。',
      ],
      confirmLabel: '仍然提交',
      tone: 'danger',
    });
    if (!accepted || selectedRepository.value?.config.id !== repository.config.id) return;
  }
  const contextVersion = repositoryContextVersion;
  commitBusy.value = true;
  actionError.value = '';
  try {
    const output = await api.commit(repository.config.id, message, preview.fingerprint, false);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      composer.clearDraft();
      actionMessage.value = output.message;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion))
      actionError.value = `${error instanceof Error ? error.message : 'Commit 失败'}`;
  } finally {
    await Promise.allSettled([
      query.refetch(), operationsQuery.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadLastCommit(repository.config.id) : Promise.resolve(),
    ]);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) commitBusy.value = false;
  }
}
async function loadLastCommit(repositoryId: string): Promise<LastCommitSnapshot | null> {
  try {
    const snapshot = await api.lastCommit(repositoryId);
    // 期间切换了仓库就丢弃结果，避免把 A 的快照套到 B 上。
    if (selectedRepository.value?.config.id !== repositoryId) return null;
    lastCommitSnapshot.value = snapshot;
    return snapshot;
  } catch {
    // 读不到就当作「不可改写」：按钮禁用，不打扰用户——真正的失败会在执行时给原因。
    if (selectedRepository.value?.config.id === repositoryId) lastCommitSnapshot.value = null;
    return null;
  }
}

/** 已推送的提交被改写会造成本地与远端分叉，而本工具不提供 force push——确认框里要说清。 */
function rewritePushedLines(snapshot: LastCommitSnapshot): string[] {
  const commit = snapshot.commit;
  if (!commit || commit.pushed !== 'yes') {
    return ['按本地远端跟踪记录，该提交尚未出现在任何远端分支上；改写不会影响远端。'];
  }
  return [
    `⚠ 该提交已经出现在远端（${commit.pushedRef}）。`,
    '改写后本地会与远端分叉；本工具不提供 force push，下一次推送会被拒绝——需要你先在远端自行处理。',
  ];
}

async function amendLastCommit(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || rewriteBusy.value || commitBusy.value) return;
  const message = composer.message.value.trim();
  if (!message.split('\n')[0]?.trim()) {
    actionError.value = '修正提交需要先填写提交标题';
    actionMessage.value = '';
    return;
  }

  // 点下去的一刻重新读一次：HEAD 指纹必须新鲜，否则会被服务端以「已变化」拒绝。
  // 这样也免去在每个可能改动 HEAD 的操作后面都挂一次刷新。
  const snapshot = await loadLastCommit(repository.config.id);
  if (!snapshot?.commit || snapshot.blocked) {
    actionError.value = `${snapshot?.blocked ?? '当前无法修正提交（可能还没有提交）'}`;
    actionMessage.value = '';
    return;
  }

  const staged = snapshot.stagedCount;
  const accepted = await requestConfirmation({
    title: '修正上次提交',
    summary: `用当前文案重写 ${repository.config.name} 的上次提交${staged > 0 ? `，并并入 ${staged} 个已暂存文件` : '（只改提交信息）'}。`,
    target: `${repository.config.name} · ${snapshot.commit.hash.slice(0, 7)}`,
    details: [
      `原提交：${snapshot.commit.subject || '（无标题）'}`,
      `新提交：${message.split('\n')[0]}`,
      staged > 0 ? `已暂存 ${staged} 个文件会一并进入这个提交。` : '当前没有已暂存内容，只改写提交信息。',
      ...(snapshot.commit.merge ? ['上次提交是合并提交：会保留原有父提交，合并结构不变，但该合并提交的 hash 会被改写。'] : []),
      ...(snapshot.commit.hasParent ? [] : ['这是仓库的第一个提交，会连同它的内容一起被改写。']),
      '只改本机历史，不会自动推送。',
      ...rewritePushedLines(snapshot),
    ],
    confirmLabel: '确认修正',
    tone: 'caution',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  rewriteBusy.value = 'amend';
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.amendCommit(repository.config.id, { message, fingerprint: snapshot.fingerprint });
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = output.operation.message;
      composer.clearDraft();
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion))
      actionError.value = `${error instanceof Error ? error.message : '修正提交失败'}`;
  } finally {
    await Promise.allSettled([
      query.refetch(),
      operationsQuery.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadLastCommit(repository.config.id) : Promise.resolve(),
    ]);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) rewriteBusy.value = null;
  }
}

async function undoLastCommit(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || rewriteBusy.value || commitBusy.value) return;

  // 同修正提交：指纹必须新鲜，因此在点击时重新读一次。
  const snapshot = await loadLastCommit(repository.config.id);
  if (!snapshot?.commit || snapshot.blocked) {
    actionError.value = `${snapshot?.blocked ?? '当前无法撤销提交（可能还没有提交）'}`;
    actionMessage.value = '';
    return;
  }

  const accepted = await requestConfirmation({
    title: '撤销上次提交',
    summary: `把 ${repository.config.name} 的上次提交退回暂存区。`,
    target: `${repository.config.name} · ${snapshot.commit.hash.slice(0, 7)}`,
    details: [
      `将撤销：${snapshot.commit.subject || '（无标题）'}`,
      '提交里的改动**全部留在暂存区**，内容一点不会丢，可以改了再重新提交。',
      snapshot.commit.hasParent
        ? '撤销后 HEAD 回到上一个提交。'
        : '这是仓库的第一个提交：撤销后仓库回到「尚无提交」状态，文件仍是已暂存。',
      ...(snapshot.stagedCount > 0
        ? [`注意：当前还有 ${snapshot.stagedCount} 个已暂存文件，撤销后它们会与新退回的改动混在一起。`]
        : []),
      '只改本机历史，不会自动推送。',
      ...rewritePushedLines(snapshot),
    ],
    confirmLabel: '确认撤销',
    tone: 'danger',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  rewriteBusy.value = 'undo';
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.undoCommit(repository.config.id, { fingerprint: snapshot.fingerprint });
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = output.operation.message;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion))
      actionError.value = `${error instanceof Error ? error.message : '撤销提交失败'}`;
  } finally {
    await Promise.allSettled([
      query.refetch(),
      operationsQuery.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadLastCommit(repository.config.id) : Promise.resolve(),
    ]);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) rewriteBusy.value = null;
  }
}
/**
 * 把某条历史提交应用到当前分支：回退（反向抵消）或拣选（搬过来）。
 *
 * 两者共用一套确认与收尾。冲突时服务端抛 `mergePausedErrorCode`，
 * 这里据此直接切到工作区——与合并暂停走同一条路（既有的继续 / 中止会接手）。
 */
async function replayHistoryCommit(hash: string, kind: 'revert' | 'cherry-pick'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || replayBusy.value || rewriteBusy.value || commitBusy.value) return;

  // 读不到提交就退出去，所以这里不需要预置空值：能走到下面说明 detail 一定有值。
  let detail: Awaited<ReturnType<typeof api.commitDetail>>;
  try {
    detail = await api.commitDetail(repository.config.id, hash);
  } catch (error) {
    actionError.value = `${error instanceof Error ? error.message : '无法读取该提交'}`;
    actionMessage.value = '';
    return;
  }
  const subject = detail.subject;
  const parents = detail.parents.length;

  const isRevert = kind === 'revert';
  const label = isRevert ? '回退此提交' : '拣选到当前分支';
  const shortHash = hash.slice(0, 7);
  const accepted = await requestConfirmation({
    title: label,
    summary: isRevert
      ? `生成一个新提交，抵消 ${shortHash} 的改动。`
      : `把 ${shortHash} 的改动搬到当前分支。`,
    target: `${repository.config.name} · ${shortHash}`,
    details: [
      `提交：${subject || '（无标题）'}`,
      isRevert
        ? '做法是新增一个提交来抵消它，历史不会被改写，原提交仍然留在历史里。'
        : '做法是在当前分支新增一个内容相同的提交，原提交留在原分支上。',
      ...(parents > 1
        ? ['这是一条合并提交：需要指定以哪一侧为基准，本工具不猜，会直接拒绝并给出 git 的提示。']
        : []),
      '要求已跟踪的文件没有未提交改动（未跟踪文件不影响）。冲突时会暂停，可在工作区继续或中止。',
      '只改本机，不会自动推送。',
    ],
    confirmLabel: label,
    tone: isRevert ? 'caution' : 'info',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  replayBusy.value = kind;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = isRevert
      ? await api.revertCommit(repository.config.id, hash)
      : await api.cherryPickCommit(repository.config.id, hash);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = output.operation.message;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : `${label}失败`}`;
      // 冲突暂停：直接把人带到工作区，与合并暂停同一处理。
      if (error instanceof ApiError && error.code === mergePausedErrorCode) repositoryWorkspace.value?.showWorking();
    }
  } finally {
    await Promise.allSettled([
      query.refetch(),
      operationsQuery.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadLastCommit(repository.config.id) : Promise.resolve(),
    ]);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) replayBusy.value = null;
  }
}

/**
 * 「克隆远端」入口。
 *
 * 克隆原先埋在「个人配置 → 仓库接入 → 03」，是加入新项目最深的一条路；它本身是
 * 自包含表单，不需要设置面板提供上下文，现在只保留这个弹窗，设置里不再重复一份。
 */
function openCloneDialog(event?: Event): void {
  const target = event?.currentTarget;
  if (target instanceof HTMLElement) focusReturnOverrides.set('clone', target);
  if (!cloneForm.rootId) cloneForm.rootId = Object.keys(query.data.value?.roots ?? {})[0] ?? '';
  cloneError.value = '';
  resetCloneAuth();
  cloneDialogOpen.value = true;
}

function closeCloneDialog(): void {
  cloneDialogOpen.value = false;
  resetCloneAuth();
}

function resetCloneAuth(): void {
  cloneAuth.open = false;
  cloneAuth.host = '';
  cloneAuth.username = '';
  cloneAuth.secret = '';
  cloneAuthError.value = '';
  cloneAuthSecretVisible.value = false;
}

/** 弹窗里一个根目录都没有时的出口：去设置里先加一个目录。 */
function openRepositorySetupFromClone(): void {
  closeCloneDialog();
  openManage(undefined, 'repositories');
}

/**
 * 认证失败时展开补填区。
 *
 * 同一主机重试失败时保留已填的用户名（令牌在保存后已清空），只清掉旧错误，
 * 免得用户每重试一次都要重打一遍账号。
 */
async function openCloneAuth(host: string): Promise<void> {
  if (cloneAuth.host !== host) cloneAuth.username = '';
  cloneAuth.host = host;
  cloneAuth.open = true;
  cloneAuth.secret = '';
  cloneAuthError.value = '';
  await nextTick();
  cloneAuthUsernameInput.value?.focus();
}

async function pasteCloneSecret(): Promise<void> {
  try {
    cloneAuth.secret = (await api.readSystemClipboard()).text.trim();
  } catch (error) {
    cloneAuthError.value = error instanceof Error ? error.message : '读取剪贴板失败';
  }
}

/**
 * 粘贴远端地址。
 *
 * 地址几乎总是从别处复制来的，而系统剪贴板在 WKWebView 里不保证 `navigator.clipboard` 可用，
 * 所以和令牌一样走后端读剪贴板。粘贴后顺手规范化，去掉复制时常带上的引号与尖括号。
 */
async function pasteCloneUrl(): Promise<void> {
  try {
    cloneForm.url = normalizeRemoteUrlInput((await api.readSystemClipboard()).text);
    cloneError.value = '';
  } catch (error) {
    cloneError.value = error instanceof Error ? error.message : '读取剪贴板失败';
  }
}

/** 存进系统钥匙串后立刻重试；成功即收起弹窗，失败则留在原地继续改。 */
async function saveCloneCredentialAndRetry(): Promise<void> {
  if (cloneAuthBusy.value) return;
  const username = cloneAuth.username.trim();
  const secret = cloneAuth.secret;
  if (!cloneAuth.host || !username || !secret) return;
  cloneAuthBusy.value = true;
  cloneAuthError.value = '';
  try {
    await api.saveRemoteCredential({ host: cloneAuth.host, username, secret });
    // 令牌已进钥匙串，别留在内存里的输入框。
    cloneAuth.secret = '';
    cloneAuth.open = false;
    cloneError.value = '';
    await submitClone({ confirm: false });
  } catch (error) {
    cloneAuthError.value = error instanceof Error ? error.message : '保存凭证失败';
  } finally {
    cloneAuthBusy.value = false;
  }
}

/** 克隆远端仓库到所选根目录，并登记进舰队。 */
async function submitClone(options: { confirm?: boolean } = {}): Promise<void> {
  if (!cloneReady.value) return;
  const url = normalizeRemoteUrlInput(cloneForm.url);
  const directory = cloneForm.directory.trim();
  const rootLabel = cloneRootOptions.value.find((option) => option.value === cloneForm.rootId)?.label ?? cloneForm.rootId;

  // 补填凭证后的重试不再弹一次确认：用户刚刚已经确认过同一次克隆。
  if (options.confirm !== false) {
    const accepted = await requestConfirmation({
      title: '克隆远端仓库',
      summary: `把 ${url} 克隆到「${rootLabel}」下，并加入舰队。`,
      target: cloneDirectory.value,
      details: [
        `目标目录：${cloneTargetPath.value}`,
        '克隆完成后自动登记并扫描，可直接在工作台里操作。',
        '不会覆盖任何已存在的目录；失败时会清理未完成的目录。',
      ],
      confirmLabel: '开始克隆',
      tone: 'caution',
    });
    if (!accepted) return;
  }

  cloneBusy.value = true;
  cloneError.value = '';
  // 每次尝试一个新 id：补填凭证后的重试是另一次克隆，旧 id 的残留进度不能串过来。
  const progressId = `clone-${crypto.randomUUID()}`;
  startCloneTicker(progressId);
  try {
    const result = await api.cloneRepository({
      rootId: cloneForm.rootId,
      url,
      ...(directory ? { directory } : {}),
      progressId,
    });
    // 克隆只有弹窗一个入口：成功即收起弹窗。
    cloneForm.url = '';
    cloneForm.directory = '';
    cloneDialogOpen.value = false;
    resetCloneAuth();
    await query.refetch();
    // 刚克隆的仓库直接打开：用户下一步一定是想在这里操作，让他自己去列表里找很别扭。
    const created = query.data.value?.repositories.find((item) => item.config.id === result.repository.id);
    if (created) selectRepository(created);
    // 提示落在抽屉里：先打开抽屉再写消息，否则消息会先出现在舰队页那条状态行上，
    // 抽屉一开就跟着换位，看着像闪了一下。仓库名默认取自目录名，念一遍就够。
    actionMessage.value = `已克隆 ${result.repository.name} 并加入舰队`;
  } catch (error) {
    // 这里存原始 stderr：认证分类要靠它，展示时再经 cloneErrorText 去掉进度行。
    const message = error instanceof Error ? error.message : '未知错误';
    cloneError.value = message;
    const failure = cloneAuthStatus.value;
    if (cloneDialogOpen.value) {
      // 缺凭证 / 凭证过期：直接在弹窗里补填，不必让用户自己去设置里找主机。
      if (failure?.fixable && failure.host) await openCloneAuth(failure.host);
    } else {
      // 弹窗已被关掉（克隆中可以关）：内联错误没有地方显示，不补一条全局提示
      // 这次失败对用户就是完全不可见的——目录可能已经落了一半。
      actionError.value = `克隆 ${url} 失败：${failure ? failure.guidance : cloneFailureHint(message) ?? cleanCloneError(message)}`;
    }
  } finally {
    cloneBusy.value = false;
    stopCloneTicker();
  }
}

// 地址一改，之前那次失败对应的主机就不作数了：收起补填区，错误行也一并清掉，
// 否则底部还挂着一个指向旧地址的「not found」，看着像新地址也失败了。
watch(
  () => cloneForm.url,
  () => {
    cloneError.value = '';
    if (!cloneAuth.open) return;
    cloneAuth.open = false;
    cloneAuth.secret = '';
    cloneAuthError.value = '';
  },
);

/**
 * 顶栏的「检查更新」。
 *
 * 只在用户点击时请求，不跟着页面轮询走。服务端已经把「连不上 GitHub / 被限流 /
 * 上游还没发版」翻译成 payload 里的 `reason`（`release-feed.ts`），面板直接照抄。
 * 剩下的 catch 只兜「本地 API 都没响应」这类传输层失败——这时拿不到服务端的原因，
 * 就地补一条同形状的结果，让面板用同一个位置说明，而不是弹一条与更新无关的提示。
 */
const updateCheckBusy = ref(false);
const updatePanelOpen = ref(false);
const updatePanel = ref<HTMLElement | null>(null);
const updateTrigger = ref<HTMLElement | null>(null);
const releaseCheck = ref<ReleaseCheckResult | null>(null);
/** 上游版本号比当前新；解析不出来时为 false，宁可不说有新版本。 */
const updateAvailable = computed(() => isNewerVersion(releaseCheck.value?.latest, appVersion));
const updateSignalLabel = computed(() => {
  if (updateCheckBusy.value) return '正在检查更新';
  if (updateAvailable.value) return `发现新版本 v${releaseCheck.value?.latest}`;
  return '检查更新';
});
/** 顶栏圆点的三态；文字只有 `error` 时才会出现在界面上。 */
const apiSignalState = computed(() => (query.error.value ? 'error' : query.isFetching.value ? 'busy' : 'ready'));
const apiSignalText = computed(() => {
  if (query.error.value) return `本地 API 未响应：${query.error.value.message}`;
  if (query.isFetching.value) return '本地 API 正在扫描仓库状态';
  return '本地 API 已就绪';
});

const updateCheckLastAtKey = 'moo-fleet:update-checked-at';
const updateCheckIntervalMs = 3 * 24 * 60 * 60 * 1000;
let updateAutoTimer: number | undefined;

/** 三天内成功检查过就不再自动查；手动检查不受限。 */
function updateCheckDue(): boolean {
  const raw = localStorage.getItem(updateCheckLastAtKey);
  const at = raw ? Number(raw) : 0;
  return !Number.isFinite(at) || at <= 0 || Date.now() - at >= updateCheckIntervalMs;
}

/** 面板开着再点一次是收起；收起状态点击才重新查。 */
function toggleUpdatePanel(): void {
  if (updatePanelOpen.value) { closeUpdatePanel(true); return; }
  void checkForUpdates();
}

/**
 * `silent` 为 true 时用于启动自动检查：已是最新/失败都不打开面板，
 * 只有发现新版本才展开提示；手动检查始终展开。
 */
async function checkForUpdates(silent = false): Promise<void> {
  if (updateCheckBusy.value) return;
  updateCheckBusy.value = true;
  try {
    releaseCheck.value = await api.checkForUpdate(appVersion);
    if (!releaseCheck.value.reason) {
      localStorage.setItem(updateCheckLastAtKey, String(Date.now()));
    }
    if (!silent || updateAvailable.value) updatePanelOpen.value = true;
  } catch (error) {
    releaseCheck.value = {
      latest: null,
      releaseUrl: releasesUrl,
      checkedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : '检查更新失败',
    };
    if (!silent) updatePanelOpen.value = true;
  } finally {
    updateCheckBusy.value = false;
  }
}

function closeUpdatePanel(restoreFocus = false): void {
  if (!updatePanelOpen.value) return;
  updatePanelOpen.value = false;
  // 和 ActionMenu 一致：点外面关闭不抢焦点，Esc / 触发键关闭才还焦。
  if (restoreFocus) updateTrigger.value?.focus({ preventScroll: true });
}

const feedbackThreads = ref<FeedbackThread[]>([]);
const feedbackDraft = ref('');
const feedbackBusy = ref(false);
const feedbackLoading = ref(false);
const feedbackError = ref('');
const feedbackReplyTo = ref<string | null>(null);
const feedbackReplyDraft = ref('');

async function loadFeedback(): Promise<void> {
  feedbackLoading.value = true;
  feedbackError.value = '';
  try {
    const payload = await api.listFeedback();
    feedbackThreads.value = payload.feedbacks;
  } catch (error) {
    feedbackError.value = error instanceof Error ? error.message : '反馈加载失败';
  } finally {
    feedbackLoading.value = false;
  }
}

async function submitFeedback(): Promise<void> {
  const content = feedbackDraft.value.trim();
  if (!content || feedbackBusy.value) return;
  feedbackBusy.value = true;
  feedbackError.value = '';
  try {
    await api.submitFeedback(appVersion, content);
    feedbackDraft.value = '';
    await loadFeedback();
  } catch (error) {
    feedbackError.value = error instanceof Error ? error.message : '反馈提交失败';
  } finally {
    feedbackBusy.value = false;
  }
}

async function sendFeedbackReply(id: string): Promise<void> {
  const content = feedbackReplyDraft.value.trim();
  if (!content || feedbackBusy.value) return;
  feedbackBusy.value = true;
  feedbackError.value = '';
  try {
    await api.replyFeedback(id, content);
    feedbackReplyDraft.value = '';
    feedbackReplyTo.value = null;
    await loadFeedback();
  } catch (error) {
    feedbackError.value = error instanceof Error ? error.message : '回复失败';
  } finally {
    feedbackBusy.value = false;
  }
}

function handleUpdatePanelPointerDown(event: PointerEvent): void {
  if (!updatePanelOpen.value) return;
  const target = event.target as Node | null;
  if (updatePanel.value?.contains(target) || updateTrigger.value?.contains(target)) return;
  closeUpdatePanel();
}

onMounted(() => {
  document.addEventListener('pointerdown', handleUpdatePanelPointerDown, true);

  // 超过三天自动检查一次；延迟几秒，先让首屏和仓库扫描跑起来。
  if (updateCheckDue()) {
    updateAutoTimer = window.setTimeout(() => { void checkForUpdates(true); }, 5_000);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleUpdatePanelPointerDown, true);
  if (updateAutoTimer !== undefined) window.clearTimeout(updateAutoTimer);
  if (copiedRepositoryTimer) clearTimeout(copiedRepositoryTimer);
});
</script>

<template>
  <div class="app-shell">
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />
    <a class="skip-link" :inert="appBackgroundInert" :href="activeWorkspace === 'sessions' ? '#session-list' : activeWorkspace === 'analytics' ? '#analytics-panel' : '#repository-list'" @click.prevent="focusActiveList">{{ activeWorkspace === 'sessions' ? '跳到会话列表' : activeWorkspace === 'analytics' ? '跳到分析面板' : '跳到仓库列表' }}</a>

    <header class="topbar" :inert="appBackgroundInert">
      <div class="brand-lockup">
        <div class="brand-copy">
          <img class="brand-logo" src="/logo-dark.png" alt="Moo Fleet" width="188" height="28" />
          <div class="brand-subline">
            <span>LOCAL GIT WORKSPACE</span>
            <span aria-hidden="true">/</span>
            <a href="https://mooeen.com" target="_blank" rel="noreferrer" title="访问 MOOEEN 官网">
              BY MOOEEN.COM
              <ExternalLink :size="9" aria-hidden="true" />
            </a>
          </div>
        </div>
        <nav class="workspace-switcher" aria-label="Moo Fleet 工作区">
          <button :class="{ active: activeWorkspace === 'repositories' }" :aria-current="activeWorkspace === 'repositories' ? 'page' : undefined" @click="switchWorkspace('repositories')"><FolderGit2 :size="14" />仓库舰队<span v-if="hasUnreadNotice('workspace:repositories')" class="unread-dot" aria-hidden="true" /></button>
          <button :class="{ active: activeWorkspace === 'sessions' }" :aria-current="activeWorkspace === 'sessions' ? 'page' : undefined" @click="switchWorkspace('sessions')"><MessagesSquare :size="14" />AI会话</button>
          <button :class="{ active: activeWorkspace === 'analytics' }" :aria-current="activeWorkspace === 'analytics' ? 'page' : undefined" @click="switchWorkspace('analytics')"><BarChart3 :size="14" />数据分析</button>
        </nav>
      </div>

      <div class="topbar-actions">
        <!-- 顶栏只留一个圆点：正常态不再写「LOCAL API / READY」，异常时才就地补一句。
             可读文本放在 sr-only 里给读屏，视觉上完全不占位。 -->
        <div class="local-signal" :data-state="apiSignalState" :title="apiSignalText">
          <span class="signal-dot" aria-hidden="true" />
          <span v-if="apiSignalState === 'error'" class="local-signal-label" aria-hidden="true">API 断开</span>
          <!-- 正常与扫描中的文案不挂 live：dashboard 每 15 秒轮询一次，`isFetching` 一进一出
               就是两条播报，一天上千次，而它们说的都是「一切正常」。状态变化只在出错时值得
               打断用户，其余时候留给读者自己浏览（`title` 上仍有完整文案）。 -->
          <span class="sr-only" :aria-live="apiSignalState === 'error' ? 'polite' : 'off'">{{ apiSignalText }}</span>
        </div>
        <button
          v-if="activeWorkspace === 'repositories'"
          class="icon-button topbar-history"
          :class="{ 'topbar-history--running': activeBatch?.state === 'running' }"
          :title="activeBatch?.state === 'running' ? batchSignalAriaLabel(activeBatch) : '操作记录'"
          :aria-label="activeBatch?.state === 'running' ? batchSignalAriaLabel(activeBatch) : '打开操作记录'"
          aria-live="polite"
          data-focus-return="history"
          @click="openHistory"
        >
          <LoaderCircle v-if="activeBatch?.state === 'running'" :size="17" class="spinning" /><History v-else :size="17" />
          <span v-if="activeBatch?.state === 'running'" class="topbar-badge" aria-hidden="true">{{ activeBatch.completed }}/{{ activeBatch.total }}</span>
        </button>
        <!-- 分析页的忙态走 `analyticsRefreshBusy`，不是 `isFetching`：后者含 60 秒一次的轮询，
             会让按钮每分钟自己灰掉并转圈，而这段时间点击无效。它也不等于 `heatmapSwitching`，
             那个只覆盖「换范围」；用户自己点刷新的这一次另由 `analyticsManualRefreshing` 表达，
             否则按钮不灰就能连点，每次都会中断上一次重新发。 -->
        <button
          class="icon-button topbar-refresh"
          :title="activeWorkspace === 'sessions' ? (sessionWaitingCount > 0 ? `同步 ${sessionWaitingCount} 条待备份会话` : '同步全部 Claude 和 Codex 会话') : activeWorkspace === 'analytics' ? '刷新分析数据' : '刷新仓库状态'"
          :aria-label="activeWorkspace === 'sessions' ? (sessionWaitingCount > 0 ? `同步 ${sessionWaitingCount} 条待备份会话` : '同步全部 Claude 和 Codex 会话') : activeWorkspace === 'analytics' ? '刷新分析数据' : '刷新仓库状态'"
          :aria-busy="activeWorkspace === 'sessions' ? sessionSyncBusy : activeWorkspace === 'analytics' ? analyticsRefreshBusy : dashboardRefreshBusy || query.isFetching.value"
          :disabled="activeWorkspace === 'sessions' ? sessionSyncBusy : activeWorkspace === 'analytics' ? analyticsRefreshBusy : dashboardRefreshBusy || query.isFetching.value"
          :aria-disabled="activeWorkspace === 'sessions' ? sessionSyncBusy : activeWorkspace === 'analytics' ? analyticsRefreshBusy : dashboardRefreshBusy || query.isFetching.value"
          @click="refreshActiveWorkspace"
        >
          <LoaderCircle v-if="activeWorkspace === 'sessions' && sessionSyncBusy" :size="17" class="spinning" />
          <Cloud v-else-if="activeWorkspace === 'sessions'" :size="17" />
          <LoaderCircle v-else-if="activeWorkspace === 'analytics' && analyticsRefreshBusy" :size="17" class="spinning" />
          <RefreshCw v-else :size="17" :class="{ spinning: dashboardRefreshBusy || query.isFetching.value }" />
          <span v-if="activeWorkspace === 'sessions' && sessionWaitingCount > 0" class="topbar-badge" aria-hidden="true">{{ sessionWaitingCount }}</span>
        </button>
        <span class="topbar-divider" aria-hidden="true" />
        <button v-if="activeWorkspace === 'repositories'" class="icon-button topbar-shortcuts" title="快捷键帮助" aria-label="快捷键帮助" data-focus-return="shortcuts" @click="shortcutHelpOpen = true"><Keyboard :size="17" /></button>
        <a class="icon-button topbar-github" :href="repositoryUrl" target="_blank" rel="noreferrer" title="在 GitHub 打开 moo-git-fleet" aria-label="在 GitHub 打开 moo-git-fleet"><Github :size="17" /></a>
        <div class="topbar-update">
          <button
            ref="updateTrigger"
            class="icon-button topbar-update-trigger"
            :class="{ 'topbar-update-trigger--available': updateAvailable }"
            :title="updateSignalLabel"
            :aria-label="updateSignalLabel"
            :aria-busy="updateCheckBusy"
            :aria-expanded="updatePanelOpen"
            @click="toggleUpdatePanel"
          >
            <LoaderCircle v-if="updateCheckBusy" :size="17" class="spinning" /><CloudDownload v-else :size="17" />
            <span v-if="updateAvailable" class="topbar-badge topbar-badge--dot" aria-hidden="true" />
          </button>
          <div v-if="updatePanelOpen" ref="updatePanel" class="update-panel" role="group" aria-label="检查更新" @keydown.esc.stop.prevent="closeUpdatePanel(true)">
            <p class="update-panel-heading">Moo Fleet <code>v{{ appVersion }}</code></p>
            <p v-if="releaseCheck?.reason" class="update-panel-note update-panel-note--error"><AlertTriangle :size="14" aria-hidden="true" />{{ releaseCheck.reason }}</p>
            <p v-else-if="updateAvailable" class="update-panel-note update-panel-note--new"><BadgeCheck :size="14" aria-hidden="true" />发现新版本 <code>v{{ releaseCheck?.latest }}</code></p>
            <p v-else class="update-panel-note"><Check :size="14" aria-hidden="true" />已是最新版本</p>
            <div class="update-panel-actions">
              <UpdateDownloadControl v-if="updateAvailable" :url="releaseCheck?.releaseUrl ?? null" />
              <a class="compact-button" :href="releasesUrl" target="_blank" rel="noreferrer"><Github :size="14" />发布记录</a>
            </div>
          </div>
        </div>
        <button class="topbar-feedback-button" aria-label="打开反馈" data-focus-return="manage" @click="openManage($event, 'feedback')">
          <MessageCircle :size="16" />反馈
        </button>
        <button class="profile-chip" aria-label="打开个人配置" data-focus-return="manage" @click="openManage">
          <span class="avatar">{{ initials(profileForm.displayName) }}</span>
          <span>{{ profileForm.displayName || 'Developer' }}</span>
        </button>
      </div>
    </header>

    <main v-if="activeWorkspace === 'repositories'" class="workspace" :inert="appBackgroundInert">
      <section class="command-strip" role="group" aria-label="仓库摘要筛选，使用方向键移动">
        <button class="summary-block summary-total" :class="{ active: stateFilter === 'all' }" :aria-pressed="stateFilter === 'all'" :tabindex="summaryRovingIndex === 0 ? 0 : -1" @focus="summaryRovingIndex = 0" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('all')">
          <span class="summary-icon"><FolderGit2 :size="17" /></span>
          <div><strong :data-zero="summary.total === 0">{{ summary.total }}</strong><span>仓库总数</span></div>
        </button>
        <button class="summary-block summary-attention" :class="{ active: stateFilter === 'today' }" :aria-pressed="stateFilter === 'today'" :tabindex="summaryRovingIndex === 1 ? 0 : -1" @focus="summaryRovingIndex = 1" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('today')">
          <span class="summary-icon"><ListTodo :size="17" /></span>
          <div><strong :data-zero="summary.today === 0">{{ summary.today }}</strong><span>今日待处理</span></div>
        </button>
        <button class="summary-block summary-dirty" :class="{ active: stateFilter === 'dirty' }" :aria-pressed="stateFilter === 'dirty'" :tabindex="summaryRovingIndex === 2 ? 0 : -1" @focus="summaryRovingIndex = 2" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('dirty')">
          <span class="summary-icon"><CircleDot :size="17" /></span>
          <div><strong :data-zero="summary.dirty === 0">{{ summary.dirty }}</strong><span>工作区改动</span></div>
        </button>
        <button class="summary-block summary-ahead" :class="{ active: stateFilter === 'ahead' }" :aria-pressed="stateFilter === 'ahead'" :tabindex="summaryRovingIndex === 3 ? 0 : -1" @focus="summaryRovingIndex = 3" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('ahead')">
          <span class="summary-icon"><ArrowUp :size="17" /></span>
          <div><strong :data-zero="summary.ahead === 0">{{ summary.ahead }}</strong><span>待推送提交</span></div>
        </button>
        <button class="summary-block summary-behind" :class="{ active: stateFilter === 'behind' }" :aria-pressed="stateFilter === 'behind'" :tabindex="summaryRovingIndex === 4 ? 0 : -1" @focus="summaryRovingIndex = 4" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('behind')">
          <span class="summary-icon"><ArrowDown :size="17" /></span>
          <div><strong :data-zero="summary.behind === 0">{{ summary.behind }}</strong><span>待拉取提交</span></div>
        </button>
        <div class="command-meta">
          <span class="scan-meta" :data-scanning="query.isFetching.value" aria-live="polite" title="页面每 15 秒自动扫描一次；并发刷新会合并为同一次 Git 扫描"><Clock3 :size="14" />{{ scanStatusLabel }}</span>
          <span><Bot :size="14" />AI {{ query.data.value?.ai.configured ? query.data.value.ai.provider.toUpperCase() : 'LOCAL' }} · {{ profileForm.aiCommitMode === 'auto-commit' ? 'AUTO' : 'REVIEW' }}</span>
        </div>
      </section>

      <div v-if="missingRepositories.length > 0" class="missing-repos-alert" role="status" aria-live="polite">
        <span class="missing-repos-text">
          <AlertTriangle :size="15" />
          <span><strong>{{ missingRepositories.length }}</strong> 个仓库本地目录已不存在，未计入仓库总数</span>
        </span>
        <button class="compact-button missing-repos-clean" :disabled="pruneBusy" @click="pruneMissingRepositories">
          <LoaderCircle v-if="pruneBusy" :size="14" class="spinning" /><Trash2 v-else :size="14" />清理缺失仓库
        </button>
      </div>

      <section id="repository-list" ref="repositoryListRegion" class="fleet-panel" tabindex="-1">
        <!-- 常驻而不是跟着每次复制新建：读屏只在既有节点内容变化时播报，
             整个节点换上来的那一刻它是不会被读的。 -->
        <span class="sr-only" role="status">{{ copyAnnouncement }}</span>
        <div class="panel-heading">
          <div class="panel-title">
            <h2>仓库工作台</h2>
            <div class="panel-context">
              <p aria-live="polite">
                显示 <strong>{{ filteredRepositories.length }}</strong> / {{ repositories.length }} 个仓库
                <span v-if="activeRepositoryFilterLabel">· {{ activeRepositoryFilterLabel }}</span>
              </p>
              <span
                class="panel-scan-meta"
                :data-scanning="query.isFetching.value"
                aria-live="polite"
                title="页面每 15 秒自动扫描一次；并发刷新会合并为同一次 Git 扫描"
              ><Clock3 :size="12" />{{ scanStatusLabel }}</span>
            </div>
          </div>
          <div class="panel-controls">
            <div class="search-field" role="search">
              <Search :size="16" />
              <input ref="searchInput" v-model="search" aria-label="搜索仓库、分组、路径或标签" placeholder="搜索仓库、分组、路径或标签" @keydown.esc.stop="search = ''" @keydown.down.prevent="focusAdjacentRepositoryRow(1)" />
              <button v-if="search" class="search-clear" title="清除搜索" aria-label="清除搜索" @click="search = ''"><X :size="14" /></button>
            </div>
            <SelectMenu v-model="sortModeModel" :options="sortModeOptions" aria-label="仓库排序" class="select-menu--toolbar" />
            <SelectMenu v-model="groupFilterModel" :options="groupFilterOptions" aria-label="仓库分组筛选" class="select-menu--toolbar" />
            <SelectMenu v-model="stateFilterModel" :options="stateFilterOptions" aria-label="仓库状态筛选" class="select-menu--toolbar" />
            <button v-if="hasRepositoryFilters" class="panel-reset-button" aria-label="重置全部仓库筛选条件" @click="resetRepositoryFilters"><RotateCcw :size="13" />重置筛选</button>
          </div>
        </div>

        <div class="fleet-toolbar">
          <div class="batch-actions">
            <span class="batch-target-scope" aria-live="polite">
              批量：{{ batchScopeLabel }} <strong>{{ batchTargetRepositories.length }}</strong>
            </span>
            <button
              class="compact-button batch-action-button"
              :disabled="batchStarting !== null || foregroundBatchRunning || batchAvailability.fetch.total === 0"
              :aria-disabled="batchAvailability.fetch.eligible === 0"
              :aria-label="`Fetch，当前预计可执行 ${batchAvailability.fetch.eligible} 个仓库。${batchAvailability.fetch.detail} ${automaticFetchHint}`"
              :title="`${batchAvailability.fetch.detail} · ${automaticFetchHint}`"
              @click="runBatch('fetch')"
            >
              <LoaderCircle v-if="batchStarting === 'fetch'" :size="14" class="spinning" /><RefreshCw v-else :size="14" />Fetch <span class="batch-action-count">{{ batchAvailability.fetch.eligible }}</span>
            </button>
            <div class="batch-push-split">
              <button
                class="compact-button batch-action-button"
                :disabled="batchStarting !== null || foregroundBatchRunning || batchPullBusy || batchAvailability.pull.total === 0"
                :aria-disabled="batchAvailability.pull.eligible === 0"
                :aria-label="`Pull，当前预计可执行 ${batchAvailability.pull.eligible} 个仓库。${batchAvailability.pull.detail}`"
                :title="batchAvailability.pull.detail"
                @click="runBatch('pull')"
              >
                <LoaderCircle v-if="batchStarting === 'pull'" :size="14" class="spinning" /><ArrowDown v-else :size="14" />Pull <span class="batch-action-count">{{ batchAvailability.pull.eligible }}</span>
              </button>
              <button
                class="compact-button batch-action-button batch-action-push-more"
                :disabled="batchStarting !== null || foregroundBatchRunning || batchPullBusy || batchAvailability['pull-branches'].total === 0"
                :aria-disabled="batchAvailability['pull-branches'].eligible === 0"
                :aria-label="`批量拉取多个分支，当前预计可执行 ${batchAvailability['pull-branches'].eligible} 个仓库。${batchAvailability['pull-branches'].detail}`"
                :title="`批量拉取多个分支 · ${batchAvailability['pull-branches'].detail}`"
                @click="openBatchPull()"
              ><ChevronDown :size="13" aria-hidden="true" /></button>
            </div>
            <div class="batch-push-split">
              <button
                class="compact-button batch-action-button"
                :disabled="batchStarting !== null || foregroundBatchRunning || batchAvailability.push.total === 0"
                :aria-disabled="batchAvailability.push.eligible === 0"
                :aria-label="`Push，当前预计可执行 ${batchAvailability.push.eligible} 个仓库。${batchAvailability.push.detail}`"
                :title="batchAvailability.push.detail"
                @click="runBatch('push')"
              >
                <LoaderCircle v-if="batchStarting === 'push'" :size="14" class="spinning" /><ArrowUp v-else :size="14" />Push <span class="batch-action-count">{{ batchAvailability.push.eligible }}</span>
              </button>
              <button
                class="compact-button batch-action-button batch-action-push-more"
                :disabled="batchStarting !== null || foregroundBatchRunning || batchPushBranchesBusy || batchPullBusy || batchAvailability['push-branches'].total === 0"
                :aria-disabled="batchAvailability['push-branches'].eligible === 0"
                :aria-label="`批量推送多个分支，当前预计可执行 ${batchAvailability['push-branches'].eligible} 个仓库。${batchAvailability['push-branches'].detail}`"
                :title="`批量推送多个分支 · ${batchAvailability['push-branches'].detail}`"
                @click="openBatchPushBranches()"
              ><ChevronDown :size="13" aria-hidden="true" /></button>
            </div>
            <button
              class="compact-button batch-action-button"
              :disabled="batchStarting !== null || foregroundBatchRunning || batchPushBranchesBusy || batchMergeBusy || batchPullBusy || (batchAvailability['merge-branches'].actionable ?? batchAvailability['merge-branches'].eligible) === 0"
              :aria-disabled="(batchAvailability['merge-branches'].actionable ?? batchAvailability['merge-branches'].eligible) === 0"
              :aria-label="`双线合并，当前可合并 ${batchAvailability['merge-branches'].eligible} 个仓库。${batchAvailability['merge-branches'].detail}`"
              :title="`把非 dev / main 的分支合回两条线 · ${batchAvailability['merge-branches'].detail}`"
              @click="openBatchMerge()"
            >
              <GitMerge :size="14" />合并 <span class="batch-action-count">{{ batchAvailability['merge-branches'].eligible }}</span>
            </button>
            <span v-if="selectedRepositoryIds.length > 0" class="batch-selection-count" role="status" aria-live="polite">
              已勾选 <strong>{{ selectedRepositoryIds.length }}</strong> 个仓库
            </span>
          </div>
          <div class="fleet-add-actions">
            <button
              class="compact-button"
              data-focus-return="manage"
              title="扫描本地目录，把已存在的仓库加入工作台"
              @click="openManage($event, 'repositories')"
            >
              <Plus :size="14" />添加仓库
            </button>
            <button
              class="compact-button"
              data-focus-return="clone"
              title="从远端地址克隆一个新仓库并直接加入舰队"
              @click="openCloneDialog($event)"
            >
              <Download :size="14" />克隆远端
            </button>
          </div>
        </div>

        <!-- 反馈属于这块面板：紧接工具栏、落在表格之上，占一条高度，不盖内容、不自己消失。
             它读的是 `workspace:repositories` 这个归属，抽屉与设置弹窗各有自己的归属，
             所以谁也不用判断「现在是谁盖在上面」。 -->
        <SurfaceNotice
          v-if="fleetNotice"
          class="fleet-feedback"
          :notice="fleetNotice"
          @dismiss="dismissFeedback"
        />

        <div v-if="query.isLoading.value" class="fleet-loading" role="status" aria-live="polite">
          <div class="loading-copy"><LoaderCircle :size="20" class="spinning" /><div><strong>正在扫描本地 Git 状态</strong><span>读取分支、工作区和远端信号…</span></div></div>
          <div class="skeleton-table" aria-hidden="true">
            <div v-for="index in 5" :key="index" class="skeleton-row">
              <i /><span class="skeleton-name" /><span /><span /><span /><span />
            </div>
          </div>
        </div>
        <div v-else-if="query.error.value" class="error-state">
          <AlertTriangle :size="24" />
          <strong>本地状态扫描失败</strong>
          <span>{{ query.error.value.message }}</span>
          <button class="secondary-button" :disabled="query.isFetching.value" @click="refresh"><RefreshCw :size="14" />重新扫描</button>
        </div>
        <div v-else-if="repositories.length === 0" class="empty-state">
          <div class="empty-glyph"><TerminalSquare :size="32" /></div>
          <div>
            <h3>把本地 Git 仓库接入舰队</h3>
            <p>扫描已配置的根目录，添加仓库后即可在一个页面查看所有状态。</p>
          </div>
          <div class="empty-actions">
            <button class="primary-button" data-focus-return="manage" @click="openManage($event, 'repositories')"><Plus :size="16" />添加仓库</button>
            <button class="secondary-button" data-focus-return="clone" @click="openCloneDialog($event)"><Download :size="16" />克隆远端仓库</button>
          </div>
        </div>
        <div v-else class="table-wrap">
          <table class="repo-table">
            <caption class="sr-only">已配置 Git 仓库的状态、分支、工作区变化与远端差异</caption>
            <thead>
              <tr>
                <th class="sequence-column">
                  <input
                    type="checkbox"
                    :checked="visibleSelectionState === 'all'"
                    :indeterminate="visibleSelectionState === 'partial'"
                    :aria-checked="visibleSelectionState === 'partial' ? 'mixed' : visibleSelectionState === 'all'"
                    aria-label="全选当前结果"
                    :title="visibleSelectionState === 'all' ? '取消全选' : '全选当前结果'"
                    :disabled="filteredRepositories.length === 0"
                    @change="toggleVisibleSelection"
                  />
                </th>
                <th class="pin-column"><span class="sr-only">置顶</span></th>
                <th>仓库</th>
                <th>分支 / Upstream</th>
                <th>工作区</th>
                <th>远端</th>
                <th>最近提交</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="repository in filteredRepositories"
                :key="repository.config.id"
                tabindex="0"
                aria-haspopup="dialog"
                :data-row-tone="repository.state === 'clean' ? 'neutral' : statusMeta[repository.state].tone"
                :data-focus-return="`repository:${repository.config.id}`"
                @click="selectRepositoryFromRow($event, repository)"
                @keydown.enter.self.prevent="selectRepository(repository)"
                @keydown.space.self.prevent="selectRepository(repository)"
                @keydown.down.self.prevent="focusAdjacentRepositoryRow(1)"
                @keydown.up.self.prevent="focusAdjacentRepositoryRow(-1)"
              >
                <td class="sequence-column">
                  <input
                    type="checkbox"
                    :checked="selectedRepositoryIds.includes(repository.config.id)"
                    :aria-label="`选择 ${repository.config.name}`"
                    @click.stop
                    @change="toggleRepositorySelection(repository.config.id)"
                  />
                </td>
                <td class="pin-column">
                  <button
                    class="table-icon-button"
                    :class="{ pinned: repository.config.pinned }"
                    :title="repository.config.pinned ? '取消置顶' : '置顶'"
                    :aria-label="`${repository.config.pinned ? '取消置顶' : '置顶'} ${repository.config.name}`"
                    :aria-pressed="repository.config.pinned"
                    :disabled="pinBusyId !== null"
                    @click.stop="togglePinned(repository)"
                  ><LoaderCircle v-if="pinBusyId === repository.config.id" :size="14" class="spinning" /><Pin v-else :size="15" /></button>
                </td>
                <td class="repository-cell">
                  <div class="repo-name-line">
                    <div class="repo-name" :title="repository.config.name">{{ repository.config.name }}</div>
                    <!-- 复制名字：名字常要贴到终端、提交信息或别处，而表格里的文字是选不中的。
                         紧挨着名字放，不贴到列尾——「旁边」才是用户会去点的地方。
                         `@click.stop` 是必需的：否则顺手把整行也点开，抽屉盖住列表。 -->
                    <button
                      class="table-icon-button repo-copy-button"
                      :class="{ copied: copiedRepositoryId === repository.config.id }"
                      :title="copiedRepositoryId === repository.config.id ? '已复制' : '复制仓库名称'"
                      :aria-label="`复制仓库名称 ${repository.config.name}`"
                      @click.stop="copyRepositoryName(repository)"
                    ><Check v-if="copiedRepositoryId === repository.config.id" :size="14" aria-hidden="true" /><Copy v-else :size="14" aria-hidden="true" /></button>
                    <span
                      v-if="hasUnreadNotice(`repository:${repository.config.id}`)"
                      class="unread-dot"
                      role="img"
                      :aria-label="unreadNoticeLabel(`repository:${repository.config.id}`)"
                      :title="unreadNoticeLabel(`repository:${repository.config.id}`)"
                    />
                    <span v-if="repository.latestTag" class="repo-version" :title="`最近 Tag · ${repository.latestTag.createdAt ? relativeTime(repository.latestTag.createdAt) : '时间未知'}`">{{ repository.latestTag.name }}</span>
                    <span v-if="hasLatestReleaseTag(repository)" class="repo-release-marker" title="最新已发版" role="img" aria-label="最新已发版"><BadgeCheck :size="16" aria-hidden="true" /></span>
                  </div>
                  <div class="repo-subline">
                    <span>{{ repository.config.group }}</span>
                    <code :title="repository.config.path">{{ repository.config.path }}</code>
                    <span v-if="!repository.gitIdentity.complete" class="identity-inline-warning" title="缺少 Git Commit 身份"><AlertTriangle :size="10" />身份缺失</span>
                  </div>
                </td>
                <td data-label="分支 / Upstream">
                  <div class="branch-line"><GitBranch :size="14" /><span class="branch-name" :title="repository.branch || 'DETACHED'">{{ repository.branch || 'DETACHED' }}</span></div>
                  <!-- 窄宽度下「未设置 upstream」会被截成「未设置 upstre…」，title 要给全文，
                       否则鼠标停上去什么都没有，用户只会以为列太窄。 -->
                  <div class="cell-muted" :title="repository.upstream || '未设置 upstream'">{{ repository.upstream || '未设置 upstream' }}</div>
                </td>
                <td data-label="工作区">
                  <div class="change-counts">
                    <!-- 字母缩写对新用户不直观（C 尤其），补 title 与 aria-label；右侧状态胶囊已经是这个做法。 -->
                    <span v-if="repository.staged" class="count staged" :title="`已暂存 ${repository.staged} 个文件（S）`" :aria-label="`已暂存 ${repository.staged} 个文件`"><b>S</b>{{ repository.staged }}</span>
                    <span v-if="repository.modified" class="count modified" :title="`已修改未暂存 ${repository.modified} 个文件（M）`" :aria-label="`已修改未暂存 ${repository.modified} 个文件`"><b>M</b>{{ repository.modified }}</span>
                    <span v-if="repository.untracked" class="count untracked" :title="`未跟踪 ${repository.untracked} 个文件（U）`" :aria-label="`未跟踪 ${repository.untracked} 个文件`"><b>U</b>{{ repository.untracked }}</span>
                    <span v-if="repository.conflicted" class="count conflict" :title="`冲突 ${repository.conflicted} 个文件（C）`" :aria-label="`冲突 ${repository.conflicted} 个文件`"><b>C</b>{{ repository.conflicted }}</span>
                    <span v-if="!repository.staged && !repository.modified && !repository.untracked && !repository.conflicted" class="cell-muted">—</span>
                  </div>
                </td>
                <td data-label="远端">
                  <div class="remote-counts">
                    <span :class="{ active: (repository.ahead || 0) > 0 }"><ArrowUp :size="14" />{{ repository.ahead ?? '—' }}</span>
                    <span :class="{ active: (repository.behind || 0) > 0 }"><ArrowDown :size="14" />{{ repository.behind ?? '—' }}</span>
                  </div>
                  <div
                    class="cell-muted mono fetch-age"
                    :class="{ stale: isRemoteStale(repository) }"
                    :title="isRemoteStale(repository) ? '超过 24 小时未 Fetch，远端差异可能已过期' : '最近一次 Fetch 时间'"
                  >Fetch {{ repository.lastFetchedAt ? relativeTime(repository.lastFetchedAt) : '未知' }}</div>
                </td>
                <td data-label="最近提交">
                  <div class="commit-subject" :title="repository.lastCommit?.subject || '暂无提交'">{{ repository.lastCommit?.subject || '暂无提交' }}</div>
                  <div class="cell-muted mono">{{ repository.lastCommit?.hash.slice(0, 7) || '—' }} · {{ relativeTime(repository.lastCommit?.committedAt) }}</div>
                </td>
                <td class="status-cell" data-label="状态">
                  <button
                    v-if="repository.state === 'remote-unknown'"
                    class="status-pill status-repair-button"
                    :data-tone="statusMeta[repository.state].tone"
                    :data-focus-return="`upstream:${repository.config.id}`"
                    aria-haspopup="dialog"
                    :aria-label="`${repository.config.name} 未设置 upstream，打开一键修复`"
                    title="这个分支还没有设置 upstream，点击检测并关联"
                    @click.stop="openUpstreamRepair(repository, $event)"
                  ><span /><Link2 :size="11" />{{ statusMeta[repository.state].label }}</button>
                  <span v-else class="status-pill" :data-tone="statusMeta[repository.state].tone"><span />{{ statusMeta[repository.state].label }}</span>
                  <span class="row-disclosure" aria-hidden="true"><span>查看详情</span><ChevronRight :size="15" /></span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="filteredRepositories.length === 0" class="no-results" :class="{ 'today-complete': stateFilter === 'today' }" role="status" aria-live="polite">
            <Check v-if="stateFilter === 'today'" :size="24" />
            <Search v-else :size="24" />
            <strong>{{ stateFilter === 'today' ? '当前范围已处理完成' : '没有匹配的仓库' }}</strong>
            <span>{{ stateFilter === 'today' ? '没有工作区改动、待同步或异常仓库' : '调整关键词、分组或状态条件后再试' }}</span>
            <button v-if="hasRepositoryFilters" class="secondary-button" @click="resetRepositoryFilters"><RotateCcw :size="14" />{{ stateFilter === 'today' ? '查看全部仓库' : '重置筛选' }}</button>
          </div>
        </div>
      </section>
    </main>

    <KeepAlive>
      <SessionRelay
        v-if="activeWorkspace === 'sessions'"
        ref="sessionRelay"
        :background-inert="appBackgroundInert"
        @sync-busy="sessionSyncBusy = $event"
        @sync-summary="sessionWaitingCount = $event"
      />
    </KeepAlive>

    <main v-if="activeWorkspace === 'analytics'" id="analytics-panel" class="workspace analytics-workspace" tabindex="-1" :inert="appBackgroundInert">
      <CommitHeatmap
        :data="heatmapQuery.data.value ?? null"
        :range="analyticsRange"
        :metric="analyticsMetric"
        :repository-options="analyticsRepositoryOptions"
        :repository-scope="analyticsRepositoryScope"
        :loading="query.isLoading.value || heatmapQuery.isLoading.value"
        :refreshing="heatmapSwitching"
        :error="heatmapError"
        @update:range="setAnalyticsRange"
        @update:metric="setAnalyticsMetric"
        @update:repository-scope="setAnalyticsRepositoryScope"
        @retry="heatmapQuery.refetch()"
      />
    </main>

    <transition name="fade">
      <button
        v-if="selectedRepository || historyOpen"
        class="drawer-backdrop"
        aria-label="关闭侧边抽屉"
        @click="closeDrawers"
      />
    </transition>

    <transition name="fade">
      <aside v-if="selectedRepository" class="repo-workspace-shell" role="dialog" aria-modal="true" :aria-labelledby="`repo-drawer-title-${selectedRepository.config.id}`" data-focus-layer tabindex="-1">
        <RepositoryWorkspace
          :key="selectedRepository.config.id"
          ref="repositoryWorkspace"
          :repository="selectedRepository" :files="repositoryFiles" :files-loading="filesLoading" :files-error="repositoryFilesError"
          :stashes="repositoryStashes" :tags="repositoryTags" :stashes-loading="stashesLoading" :tags-loading="tagsLoading"
          :branches="branchSnapshot" :branches-loading="branchesLoading" :branch-blocker="localBranchSwitchBlocker" :remote-branch-blocker="branchPanelBlocker"
          :busy="workspaceBusy || workspaceRefreshing" :stage-locked="stageLocked" :discard-busy="fileDiscardBatchBusy" :commit-busy="commitBusy" :refreshing="workspaceRefreshing"
          @merge-branch="openBranchMerge"
          @delete-branch="deleteRepositoryBranch"
          @delete-remote-branch="deleteRepositoryRemoteBranch"
          @checkout-remote-branch="checkoutRepositoryRemoteBranch"
          @resolve-conflict="resolveRepositoryConflict"
          :diff="diffDialog" :presentation="diffPresentation" :diff-loading="diffLoading" :diff-error="diffError"
          :hunk-action-label="diffHunkActionLabel" :pending-hunk="hunkActionBusy" :hunk-action-blocked="hunkActionBlocked" :notice="repositoryNotice"
          :ignored-files="repositoryIgnoredFiles" :ignored-loading="ignoredLoading" :ignored-truncated="ignoredTruncated" :show-ignored-files="showIgnoredFiles"
          :marked-files="markedFiles" :marked-loading="markedLoading" :show-marked-files="showMarkedFiles"
          @file-action="handleRepositoryFileAction" @ignored-action="handleIgnoredFileAction" @marked-action="handleMarkedFileAction" @toggle-ignored="toggleIgnoredFiles" @toggle-marked="toggleMarkedFiles"
          @refresh-stashes="loadRepositoryStashes(selectedRepository.config.id)" @refresh-tags="loadRepositoryTags(selectedRepository.config.id)"
          @select="showFileDiff" @stage="updateFilesStage" @discard-untracked="discardRepositoryUntrackedFiles" @discard-tracked="discardRepositoryTrackedFiles" @stash-checked="stashRepositoryFiles" @switch-branch="switchRepositoryBranch"
          @revert-commit="hash => replayHistoryCommit(hash, 'revert')" @cherry-pick-commit="hash => replayHistoryCommit(hash, 'cherry-pick')"
          @switch-kind="switchDiffKind" @hunk="applyDiffHunks" @refresh="refreshRepositoryWorkspace" @clear-diff="closeDiffDialog" @dismiss-feedback="dismissFeedback"
        >
          <template #commit>
            <CommitComposer ref="commitComposer" :message="composer.message.value" :preview="composer.preview.value" :loading="composer.loading.value" :error="composer.error.value || composer.suggestionError.value" :ready="composer.ready.value" :busy="commitBusy" :suggesting="composer.suggesting.value" :suggestion="composer.suggestion.value" :needs-review="composer.needsReview.value" :blocker="commitBlocker" :staged-count="repositoryFiles.filter(file => file.staged && !file.conflicted).length" :last-commit="lastCommitSnapshot" :rewrite-busy="rewriteBusy" @update:message="composer.updateMessage" @generate="composer.generate" @refresh="composer.refresh" @submit="submitCommit" @amend="amendLastCommit" @undo="undoLastCommit" />
          </template>
          <template #header>
            <div class="drawer-header">
              <button class="compact-button workspace-back-button" title="返回仓库列表 · Esc 或 ⌘[" aria-label="返回仓库列表" @click="closeDrawers"><ArrowLeft :size="16" />返回</button>
              <div class="drawer-title-block">
                <div class="drawer-title-line">
                  <button class="title-pin-button" :class="{ active: selectedRepository.config.pinned }" :aria-label="selectedRepository.config.pinned ? '取消置顶仓库' : '置顶仓库'" :aria-pressed="selectedRepository.config.pinned" :title="selectedRepository.config.pinned ? '取消置顶' : '置顶仓库'" :disabled="pinBusyId !== null" @click="togglePinned(selectedRepository)"><LoaderCircle v-if="pinBusyId === selectedRepository.config.id" :size="14" class="spinning" /><Pin v-else :size="15" /></button>
                  <SelectMenu v-model="selectedProjectModel" class="select-menu--project" :options="projectSwitchOptions" :disabled="projectSwitchBlocked" aria-label="快速切换项目" data-dialog-initial searchable search-placeholder="搜索项目名称或路径" :title="projectSwitchBlocked ? '等待当前操作完成后切换项目' : `切换项目 · ${selectedRepository.absolutePath}`">
                    <template #trigger-label><span :id="`repo-drawer-title-${selectedRepository.config.id}`" role="heading" aria-level="2">{{ selectedRepository.config.name }}</span></template>
                  </SelectMenu>
                  <!-- 复制项目名：名字常要贴到终端、提交信息或对话里，而标题是下拉触发器、
                       文字选不中。紧挨着下拉放——「名称旁边」才是用户会去点的地方。
                       成功就地变勾（1.4 秒复原），失败才走整页消息条。 -->
                  <button
                    class="title-copy-button"
                    :class="{ copied: copiedRepositoryId === selectedRepository.config.id }"
                    :title="copiedRepositoryId === selectedRepository.config.id ? '已复制' : '复制项目名称'"
                    :aria-label="`复制项目名称 ${selectedRepository.config.name}`"
                    @click="copyRepositoryName(selectedRepository)"
                  ><Check v-if="copiedRepositoryId === selectedRepository.config.id" :size="14" aria-hidden="true" /><Copy v-else :size="14" aria-hidden="true" /></button>
                  <!-- 列表里那条播报区在抽屉打开时是 inert 的（读屏拿不到），这里另起一条。 -->
                  <span class="sr-only" role="status">{{ copyAnnouncement }}</span>
                </div>
              </div>
              <div class="workspace-header-actions">
            <div class="workspace-action-row">
            <div class="git-action-grid">
              <button
                class="secondary-button git-action-button git-action-fetch"
                :disabled="workspaceBusy || workspaceRefreshing || !fetchAvailability.available"
                :title="fetchAvailability.detail"
                @click="runRepositoryAction('fetch')"
              ><LoaderCircle v-if="repositoryAction === 'fetch'" :size="16" class="spinning" /><RefreshCw v-else :size="16" />Fetch</button>
              <div class="git-action-split">
                <button
                  class="secondary-button git-action-button git-action-pull"
                  :disabled="workspaceBusy || workspaceRefreshing || !pullAvailability.available"
                  :title="pullAvailability.detail"
                  @click="runRepositoryAction('pull')"
                ><LoaderCircle v-if="repositoryAction === 'pull'" :size="16" class="spinning" /><ArrowDown v-else :size="16" />Pull<span v-if="(selectedRepository.behind ?? 0) > 0" class="git-action-count" :title="`落后远端 ${selectedRepository.behind ?? 0} 个提交`">{{ selectedRepository.behind ?? 0 }}</span></button>
                <!-- 多分支拉取：Pull 保持原样（只拉当前分支），这里作为「一次拉 dev + 主分支」的第二个入口。 -->
                <button
                  class="secondary-button git-action-button git-action-pull-more"
                  :disabled="workspaceBusy || workspaceRefreshing || batchPullBusy || foregroundBatchRunning"
                  title="拉取多个分支（当前 / 主分支 / dev）"
                  aria-label="拉取多个分支"
                  @click="openRepositoryPullBranches()"
                ><ChevronDown :size="14" aria-hidden="true" /></button>
              </div>
              <div class="git-action-split">
                <button
                  class="secondary-button git-action-button git-action-push"
                  :disabled="workspaceBusy || workspaceRefreshing || !pushAvailability.available"
                  :title="pushAvailability.detail"
                  @click="runRepositoryAction('push')"
                ><LoaderCircle v-if="repositoryAction === 'push'" :size="16" class="spinning" /><ArrowUp v-else :size="16" />Push<span v-if="(selectedRepository.ahead ?? 0) > 0" class="git-action-count" :title="`领先远端 ${selectedRepository.ahead ?? 0} 个提交`">{{ selectedRepository.ahead ?? 0 }}</span></button>
                <!-- 多分支推送：Push 保持原样，这里只作为「推 dev + main」的第二个入口。 -->
                <button
                  class="secondary-button git-action-button git-action-push-more"
                  :disabled="workspaceBusy || workspaceRefreshing || !pushBranchesAvailability.available"
                  :title="pushBranchesAvailability.detail"
                  aria-label="推送多个分支"
                  @click="openPushBranches()"
                ><ChevronDown :size="14" aria-hidden="true" /></button>
              </div>
              <button
                class="secondary-button git-action-button git-action-sync"
                :disabled="workspaceBusy || workspaceRefreshing || !syncAvailability.available"
                :title="syncAvailability.detail"
                @click="runRepositoryAction('sync')"
              ><LoaderCircle v-if="repositoryAction === 'sync'" :size="16" class="spinning" /><GitMerge v-else :size="16" />同步<span v-if="(selectedRepository.behind ?? 0) > 0" class="git-action-count" :title="`落后远端 ${selectedRepository.behind ?? 0} 个提交`">{{ selectedRepository.behind ?? 0 }}</span></button>
              <!-- 本地任务分支只用来提交，合适的时候才合回 dev / 主分支；这个入口就长在
                   分支旁边，不用先退回工作台勾选。 -->
              <button
                class="secondary-button git-action-button git-action-merge-lines"
                :disabled="workspaceBusy || workspaceRefreshing || batchMergeBusy || foregroundBatchRunning"
                title="把本仓所有非 dev / main 的本地分支合回两条线 · 只做本地合并，不推送"
                @click="openRepositoryMerge()"
              ><GitMerge :size="16" />合并</button>
            </div>
                <button class="compact-button workspace-header-refresh" :disabled="workspaceRefreshing || workspaceBusy" title="立即重读文件、分支、Stash 与标签 · 每 15 秒也会自动刷新" @click="refreshRepositoryWorkspace"><RefreshCw :size="14" :class="{ spinning: workspaceRefreshing }" />刷新</button>
            </div>
            <!--
              没有 upstream 时三个按钮全灰，而禁用控件的 title 弹不出来（本仓已知坑），
              等于把原因藏死。这里给一条可见的出口，复用仓库列表那个 UPSTREAM REPAIR 弹窗。
            -->
            <p v-if="!selectedRepository.detached && !selectedRepository.upstream" class="git-action-blocker" role="status">
              <Link2 :size="12" aria-hidden="true" />
              <span v-if="selectedRepository.remoteUrl">当前分支没有 upstream，Pull / Push / 同步不可用；可先本地提交，之后用顶部「合并」合回双线，其他分支用 Push 右侧 ⌄ 推送。</span>
              <span v-else>仓库还没有配置远端，先在「设置 → 远端」里补地址。</span>
              <button
                v-if="selectedRepository.remoteUrl"
                class="compact-button git-action-publish"
                :disabled="workspaceBusy || workspaceRefreshing"
                @click="openUpstreamRepair(selectedRepository, $event)"
              >发布此分支…</button>
            </p>
              </div>
            </div>
          </template>
          <template #branch-manager>
                  <div ref="branchMenuRoot" class="branch-menu" @focusout="handleBranchMenuFocusOut">
                    <button
                      ref="branchTrigger"
                      class="table-icon-button branch-trigger"
                      :class="{ active: branchPanelOpen }"
                      :aria-expanded="branchPanelOpen"
                      aria-haspopup="dialog"
                      aria-controls="repository-branch-switcher"
                      title="管理分支" aria-label="管理分支"
                      @click="toggleBranchPanel"
                    ><GitBranch :size="14" /></button>
                    <transition name="branch-popover">
                      <section
                        v-if="branchPanelOpen"
                        id="repository-branch-switcher"
                        ref="branchMenuPanel"
                        class="branch-switcher"
                        role="dialog"
                        aria-labelledby="repository-branch-switcher-title"
                        tabindex="-1"
                        @keydown.esc.stop.prevent="closeBranchPanel(true)"
                        @keydown.tab="trapBranchPanelFocus"
                      >
                        <div class="branch-switcher-heading">
                          <div class="branch-switcher-title">
                            <span class="branch-switcher-glyph"><GitBranch :size="16" /></span>
                            <div><strong id="repository-branch-switcher-title">管理本地分支</strong><span>兼容的本地修改可随分支切换；不会自动 Stash 或强制覆盖。</span></div>
                          </div>
                          <button class="table-icon-button" title="刷新分支" aria-label="刷新分支" :disabled="branchesLoading || branchSwitchBusy !== null" @click="loadRepositoryBranches(selectedRepository.config.id)"><RefreshCw :size="14" :class="{ spinning: branchesLoading }" /></button>
                        </div>
                        <p v-if="branchCreateBlocker" class="branch-panel-blocker" role="status"><AlertTriangle :size="14" /><span><strong>当前创建方式暂不可用</strong><span>{{ branchCreateBlocker }}</span></span></p>
                        <div v-if="!branchWriteBlocker" class="branch-create">
                          <input
                            ref="branchCreateInput"
                            v-model="branchCreateName"
                            aria-label="新分支名称"
                            placeholder="新分支名称，例如 feature/xyz"
                            :disabled="branchSwitchBusy !== null"
                            @keydown.enter="createRepositoryBranch"
                          />
                          <label><input v-model="branchCreateCheckout" type="checkbox" :disabled="branchSwitchBusy !== null" />创建后切换</label>
                          <button class="compact-button" :disabled="branchSwitchBusy !== null || branchesLoading || filesLoading || Boolean(branchCreateBlocker) || !branchCreateName.trim()" :title="branchCreateBlocker ?? undefined" @click="createRepositoryBranch"><Plus :size="13" />新建</button>
                        </div>
                        <div class="branch-list">
                          <div v-if="branchesLoading && !branchSnapshot" class="branch-list-state"><LoaderCircle :size="16" class="spinning" />读取本地分支…</div>
                          <div v-else-if="filteredLocalBranches.length === 0" class="branch-list-state"><GitBranch :size="16" />尚无本地分支，创建首个 Commit 后即可管理分支</div>
                          <div v-for="branch in filteredLocalBranches" v-else :key="branch.name" class="branch-row">
                            <div v-if="branchRenameTarget === branch.name" class="branch-rename">
                              <input v-model="branchRenameName" aria-label="新的分支名称" :disabled="branchSwitchBusy !== null" @keydown.enter="renameRepositoryBranch(branch)" @keydown.esc.stop.prevent="cancelRenameBranch" />
                              <button class="compact-button" :disabled="branchSwitchBusy !== null || !branchRenameName.trim() || branchRenameName.trim() === branch.name" @click="renameRepositoryBranch(branch)">重命名</button>
                              <button class="table-icon-button" title="取消重命名" aria-label="取消重命名" :disabled="branchSwitchBusy !== null" @click="cancelRenameBranch"><X :size="13" /></button>
                            </div>
                            <template v-else>
                              <button
                                class="branch-option"
                                :class="{ current: branch.current, occupied: Boolean(branch.worktreePath && !branch.current) }"
                                :aria-current="branch.current ? 'true' : undefined"
                                :disabled="Boolean(branchSwitchBlocker(branch)) || branchSwitchBusy !== null || repositoryAction !== null"
                                :title="branchSwitchBlocker(branch) || '切换到 ' + branch.name"
                                @click="switchRepositoryBranch(branch)"
                                @keydown.down="moveBranchPanelBranch($event)"
                                @keydown.up="moveBranchPanelBranch($event)"
                              >
                                <span class="branch-option-icon"><LoaderCircle v-if="branchSwitchBusy === branch.name" :size="15" class="spinning" /><Check v-else-if="branch.current" :size="15" /><GitBranch v-else :size="15" /></span>
                                <span class="branch-option-copy"><strong :title="branch.name">{{ branch.name }}</strong><small>{{ branch.upstream || '未设置 upstream' }}</small></span>
                                <span v-if="branch.current" class="branch-option-state">CURRENT</span>
                                <span v-else-if="branch.worktreePath" class="branch-option-state occupied">WORKTREE</span>
                                <span v-else class="branch-option-divergence" :aria-label="branchDivergenceLabel(branch)" :title="branchDivergenceLabel(branch)"><ArrowUp :size="11" />{{ branch.ahead ?? '—' }}<ArrowDown :size="11" />{{ branch.behind ?? '—' }}</span>
                              </button>
                              <div v-if="branch.current || !branch.worktreePath" class="branch-row-actions">
                                <!-- 合并原先只藏在「拖拽」和「浏览后左下角卡片」里，键盘用户无路可走；这里给一个直白入口。 -->
                                <button
                                  v-if="!branch.current && !branch.worktreePath"
                                  class="table-icon-button branch-row-merge"
                                  :title="`合并 ${branch.name} 到 ${branchSnapshot?.currentBranch ?? '当前分支'}`"
                                  :aria-label="`合并分支 ${branch.name} 到当前分支`"
                                  :disabled="branchSwitchBusy !== null || branchesLoading || filesLoading"
                                  @click="openBranchMerge({ kind: 'local', name: branch.name })"
                                ><GitMerge :size="13" /></button>
                                <button class="table-icon-button" :title="branchWriteBlocker || '重命名 ' + branch.name" :aria-label="'重命名分支 ' + branch.name" :disabled="branchSwitchBusy !== null || branchesLoading || Boolean(branchWriteBlocker)" @click="startRenameBranch(branch)"><Pencil :size="13" /></button>
                                <button v-if="!branch.current" class="table-icon-button branch-row-delete" :title="'删除 ' + branch.name" :aria-label="'删除分支 ' + branch.name" :disabled="branchSwitchBusy !== null" @click="deleteRepositoryBranch(branch)"><Trash2 :size="13" /></button>
                              </div>
          </template>
                      </div>
                    </div>
                    <template v-if="filteredRemoteBranches.length">
            <div class="branch-remote-heading">
              <span>远端分支可检出 <strong>{{ filteredRemoteBranches.length }}</strong></span>
              <span v-if="remoteBranchesForCheckout.length > 50">仅显示前 50 个</span>
            </div>
            <p v-if="selectedWorktreeChanges" class="branch-remote-note">
              工作区有 {{ selectedWorktreeChanges }} 处改动：能兼容的改动会一起带到新分支，会被覆盖时 Git 会拒绝。
            </p>
            <div class="branch-remote-list">
              <div v-for="branch in filteredRemoteBranches" :key="branch.name" class="branch-remote-row">
                <span class="branch-remote-copy"><strong>{{ branch.name }}</strong><small>{{ branch.hasLocal ? '同名本地分支已存在，可指定其他名称' : '检出并跟踪，可修改本地名称' }}</small></span>
                <button class="compact-button" :disabled="branchSwitchBusy !== null || Boolean(branchPanelBlocker)" :title="branchPanelBlocker || '检出 ' + branch.name" @click="checkoutRepositoryRemoteBranch(branch)"><LoaderCircle v-if="branchSwitchBusy === 'checkout:' + branch.name" :size="13" class="spinning" /><ArrowDown v-else :size="13" />检出</button>
              </div>
            </div>
          </template>
                  </section>
                </transition>
              </div>
          </template>
          <template #notice>
            <!--
              「进行中的操作」和 detached HEAD 都会让用户丢东西，所以都放在常驻提示位，
              而不是只放在工作区视图里：干净工作区默认打开提交历史，提示等于看不见。
              有进行中的操作时不再提示 detached —— rebase 期间 HEAD 天然是游离的，
              那时该做的是继续或终止，不是新建分支，否则会给出正好相反的建议。
            -->
            <div v-if="selectedRepository.inProgressOperation" class="workspace-notice">
              <div class="drawer-section operation-section" :data-operation="selectedRepository.inProgressOperation">
                <div class="drawer-section-heading">
                  <h3 class="drawer-section-title">进行中的操作</h3>
                  <span class="operation-chip">{{ selectedRepository.inProgressOperation.toUpperCase() }}</span>
                </div>
                <p class="operation-summary">
                  <template v-if="conflictedFiles.length > 0">还有 <strong>{{ conflictedFiles.length }}</strong> 个文件未解决冲突，全部解决后才能继续。</template>
                  <template v-else>当前没有未解决冲突，可以继续这次操作；也可以终止并回到操作前的状态。</template>
                </p>
                <div class="operation-actions">
                  <button
                    class="compact-button operation-continue"
                    :disabled="workspaceBusy || workspaceRefreshing || conflictedFiles.length > 0 || !selectedRepository.config.capabilities.commit"
                    :title="conflictedFiles.length > 0 ? `还有 ${conflictedFiles.length} 个文件未解决冲突` : '使用默认提交信息继续'"
                    @click="runOperationContinuation('continue')"
                  ><LoaderCircle v-if="operationBusy === 'continue'" :size="14" class="spinning" /><Check v-else :size="14" />继续</button>
                  <button
                    class="compact-button operation-abort"
                    :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.commit"
                    title="回到这次操作开始前的状态"
                    @click="runOperationContinuation('abort')"
                  ><LoaderCircle v-if="operationBusy === 'abort'" :size="14" class="spinning" /><RotateCcw v-else :size="14" />终止</button>
                </div>
                <p class="action-hint">继续会写入一次提交；终止会丢弃本地解决进度，但不影响已提交的历史。</p>
              </div>
            </div>
            <div v-else-if="selectedRepository.detached" class="workspace-notice">
              <div class="drawer-section operation-section" data-notice="detached">
                <div class="drawer-section-heading">
                  <h3 class="drawer-section-title">不在任何分支上</h3>
                  <span class="operation-chip">DETACHED</span>
                </div>
                <p class="operation-summary">
                  HEAD 直接指向一个提交，不属于任何分支。在这里提交会得到一条没有分支指向的提交，
                  切走后只能从 Reflog 找回。
                </p>
                <div class="operation-actions">
                  <button
                    class="compact-button"
                    :disabled="workspaceBusy || workspaceRefreshing || branchSwitchBusy !== null"
                    title="从当前 HEAD 新建分支并切换过去"
                    @click="startBranchFromDetached"
                  ><GitBranch :size="14" />新建分支</button>
                  <button
                    class="compact-button"
                    :disabled="workspaceBusy || workspaceRefreshing || branchSwitchBusy !== null"
                    title="打开分支面板，切换到已有分支"
                    @click="toggleBranchPanel"
                  ><GitBranch :size="14" />切到已有分支</button>
                </div>
              </div>
            </div>
          </template>
          <template #file-actions="{ file }">
            <button
              v-if="fileDiscardAction(file)"
              class="file-action file-discard"
              :class="{ trash: fileDiscardAction(file) === 'trash' }"
              :disabled="workspaceBusy || filesLoading || !selectedRepository.config.capabilities.stage"
              :title="fileDiscardAction(file) === 'trash' ? '移到废纸篓' : '丢弃本地修改'"
              :aria-label="`${fileDiscardAction(file) === 'trash' ? '移到废纸篓' : '丢弃本地修改'} ${file.path}`"
              @click="discardRepositoryFile(file)"
            ><LoaderCircle v-if="fileDiscardId === file.id" :size="13" class="spinning" /><Trash2 v-else-if="fileDiscardAction(file) === 'trash'" :size="13" /><RotateCcw v-else :size="13" /></button>
            <div v-if="file.conflicted" class="conflict-actions" role="group" :aria-label="`解决 ${file.path} 的冲突`">
              <button
                class="conflict-action"
                :disabled="conflictBusy !== null || workspaceBusy || filesLoading || !selectedRepository.config.capabilities.stage"
                :title="`取${conflictSideLabel('ours')}版本（Git ours）：${file.path}`"
                :aria-label="`${file.path} 取${conflictSideLabel('ours')}版本`"
                @click="resolveRepositoryConflict(file, 'ours')"
              ><LoaderCircle v-if="conflictBusy === file.id + ':ours'" :size="12" class="spinning" /><span v-else>取{{ conflictSideLabel('ours') }}</span></button>
              <button
                class="conflict-action"
                :disabled="conflictBusy !== null || workspaceBusy || filesLoading || !selectedRepository.config.capabilities.stage"
                :title="`取${conflictSideLabel('theirs')}版本（Git theirs）：${file.path}`"
                :aria-label="`${file.path} 取${conflictSideLabel('theirs')}版本`"
                @click="resolveRepositoryConflict(file, 'theirs')"
              ><LoaderCircle v-if="conflictBusy === file.id + ':theirs'" :size="12" class="spinning" /><span v-else>取{{ conflictSideLabel('theirs') }}</span></button>
              <button
                class="conflict-action"
                :disabled="conflictBusy !== null || workspaceBusy || filesLoading || !selectedRepository.config.capabilities.stage"
                :title="`手工改完后标记为已解决：${file.path}`"
                :aria-label="`${file.path} 标记为已解决`"
                @click="resolveRepositoryConflict(file, 'mark-resolved')"
              ><LoaderCircle v-if="conflictBusy === file.id + ':mark-resolved'" :size="12" class="spinning" /><span v-else>标记已解决</span></button>
              <button
                class="conflict-action conflict-action--restore"
                :disabled="conflictBusy !== null || workspaceBusy || filesLoading || !selectedRepository.config.capabilities.stage"
                :title="`撤销解决并恢复冲突标记：${file.path}`"
                :aria-label="`${file.path} 撤销解决`"
                @click="resolveRepositoryConflict(file, 'restore')"
              ><LoaderCircle v-if="conflictBusy === file.id + ':restore'" :size="12" class="spinning" /><span v-else>撤销解决</span></button>
            </div>
          </template>
          <template #stash-create>
            <div class="stash-create-panel">
                  <input v-model="stashMessage" maxlength="120" placeholder="备份说明（可选）" @keydown.enter="createRepositoryStash" />
                  <button class="compact-button" :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.stash || selectedRepository.changedFiles === 0" :title="selectedRepository.changedFiles === 0 ? '工作区没有可备份的改动' : undefined" @click="createRepositoryStash"><LoaderCircle v-if="stashBusy === 'create'" :size="14" class="spinning" /><Archive v-else :size="14" />创建备份</button>
                  <label><input v-model="stashIncludeUntracked" type="checkbox" />包含未跟踪文件</label>
                </div>
          </template>
          <template #stash-actions="{ stash }">
            <div class="stash-actions">
                      <button
                        class="file-action stash-apply"
                        title="应用并保留该 Stash"
                        :aria-label="`应用并保留 ${stash.ref}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !canApplyStash || !selectedRepository.config.capabilities.stash"
                        @click="applyRepositoryStash(stash)"
                      ><LoaderCircle v-if="stashBusy === `apply:${stash.hash}`" :size="14" class="spinning" /><ArchiveRestore v-else :size="14" />应用并保留</button>
                      <button
                        class="file-action stash-pop"
                        title="应用并从列表中删除该 Stash"
                        :aria-label="`应用并删除 ${stash.ref}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !canApplyStash || !selectedRepository.config.capabilities.stash"
                        @click="popRepositoryStash(stash)"
                      ><LoaderCircle v-if="stashBusy === `pop:${stash.hash}`" :size="14" class="spinning" /><PackageOpen v-else :size="14" />应用并删除</button>
                      <button
                        class="file-action stash-drop"
                        title="永久删除该 Stash"
                        :aria-label="`永久删除 ${stash.ref}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.stash"
                        @click="dropRepositoryStash(stash)"
                      ><LoaderCircle v-if="stashBusy === `drop:${stash.hash}`" :size="14" class="spinning" /><Trash2 v-else :size="14" />删除</button>
                    </div>
            <p v-if="!canApplyStash" class="workspace-history-note">应用备份需要工作区干净；请先提交或备份当前改动。</p>
          </template>
          <template #tags-create>
            <div class="tag-create-panel">
                  <input v-model="tagForm.name" maxlength="250" placeholder="标签名，例如 v0.1.0" aria-label="新标签名称" @keydown.enter="createRepositoryTag" />
                  <input v-model="tagForm.message" maxlength="2000" placeholder="说明（留空则创建轻量标签）" aria-label="标签说明" @keydown.enter="createRepositoryTag" />
                  <div class="tag-create-actions">
                    <label><input v-model="tagForm.push" type="checkbox" />创建后推送</label>
                    <button
                      class="compact-button"
                      :disabled="workspaceBusy || workspaceRefreshing || !tagForm.name.trim() || !selectedRepository.config.capabilities.commit || (tagForm.push && !selectedRepository.config.capabilities.push)"
                      :title="!selectedRepository.config.capabilities.commit ? '仓库配置禁止创建 Tag' : undefined"
                      @click="createRepositoryTag"
                    ><LoaderCircle v-if="tagBusy?.startsWith('create:')" :size="14" class="spinning" /><Plus v-else :size="14" />创建标签</button>
                  </div>
                </div>
          </template>
          <template #tags-actions="{ tag }">
            <div class="tag-actions">
                      <button
                        class="file-action tag-push"
                        title="推送到远端"
                        :aria-label="`推送标签 ${tag.name}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.push"
                        @click="pushRepositoryTag(tag)"
                      ><LoaderCircle v-if="tagBusy === `push:${tag.name}`" :size="14" class="spinning" /><Upload v-else :size="14" />推送</button>
                      <button
                        class="file-action tag-delete-remote"
                        :title="tagOnRemote(tag) === false ? '远端没有这个标签，无需删除' : '删除远端标签'"
                        :aria-label="`删除远端标签 ${tag.name}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.push || tagOnRemote(tag) === false"
                        @click="deleteRepositoryRemoteTag(tag)"
                      ><LoaderCircle v-if="tagBusy === `delete-remote:${tag.name}`" :size="14" class="spinning" /><CloudOff v-else :size="14" />删除远端</button>
                      <button
                        class="file-action tag-delete"
                        title="删除本地标签"
                        :aria-label="`删除标签 ${tag.name}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.commit"
                        @click="deleteRepositoryTag(tag)"
                      ><LoaderCircle v-if="tagBusy === `delete:${tag.name}`" :size="14" class="spinning" /><Trash2 v-else :size="14" />删除</button>
                      <!-- 远端探测确认不在远端时才标「仅本地」；读不到远端就什么都不说，别猜。 -->
                      <small v-if="tagOnRemote(tag) === false" class="tag-remote-note" title="这个标签只在本地，还没有推送到远端">仅本地</small>
                    </div>
          </template>
          <template #footer>
            <div class="drawer-actions">
              <button class="secondary-button" :data-focus-return="`repository-edit:${selectedRepository.config.id}`" @click="openRepositoryEditor(selectedRepository)"><Settings2 :size="16" />编辑配置</button>
              <div class="drawer-utility-actions" aria-label="本机仓库操作">
                <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('finder')"><LoaderCircle v-if="openBusy === 'finder'" :size="14" class="spinning" /><FolderGit2 v-else :size="14" />Finder</button>
                <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('terminal')"><LoaderCircle v-if="openBusy === 'terminal'" :size="14" class="spinning" /><TerminalSquare v-else :size="14" />Terminal</button>
                <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('vscode')"><LoaderCircle v-if="openBusy === 'vscode'" :size="14" class="spinning" /><Code2 v-else :size="14" />VS Code</button>
                <button class="secondary-button" :title="selectedRepository.absolutePath" @click="copyToClipboard(selectedRepository.absolutePath, '本地路径')"><Copy :size="14" />复制路径</button>
                <a v-if="selectedRemoteLinks" class="secondary-button drawer-remote-link" :href="selectedRemoteLinks.repositoryUrl" target="_blank" rel="noopener noreferrer" :aria-label="`在 ${selectedRemoteLinks.provider} 打开 ${selectedRepository.config.name}`"><ExternalLink :size="14" />{{ selectedRemoteLinks.provider }}</a>
              </div>
              <button class="danger-button" :disabled="repositoryRemovalBusy" @click="removeRepository(selectedRepository)"><LoaderCircle v-if="repositoryRemovalBusy" :size="16" class="spinning" /><Trash2 v-else :size="16" />移出工作台</button>
            </div>
          </template>
        </RepositoryWorkspace>
      </aside>
    </transition>

    <transition name="drawer">
      <aside v-if="historyOpen" class="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-drawer-title" data-focus-layer tabindex="-1">
        <div class="drawer-header">
          <div>
            <h2 id="history-drawer-title">批量队列与操作记录</h2>
          </div>
          <button class="icon-button" title="关闭操作记录" aria-label="关闭操作记录" data-dialog-initial @click="closeDrawers"><X :size="18" /></button>
        </div>

        <div v-if="activeBatch" class="batch-card" :data-state="activeBatch.state" role="status" aria-live="polite">
          <div class="batch-card-heading">
            <div><span>{{ activeBatch.state === 'running' ? '执行中' : '最近批次' }}</span><strong>{{ batchTypeLabel(activeBatch.type, activeBatch.background) }}</strong></div>
            <span>{{ activeBatch.completed }} / {{ activeBatch.total }}</span>
          </div>
          <div
            class="batch-progress"
            role="progressbar"
            :aria-label="`${batchTypeLabel(activeBatch.type)} 批量任务进度`"
            aria-valuemin="0"
            :aria-valuemax="activeBatch.total"
            :aria-valuenow="activeBatch.completed"
          ><span :style="{ width: `${activeBatch.total ? (activeBatch.completed / activeBatch.total) * 100 : 100}%` }" /></div>
          <div class="batch-counts">
            <span class="success">{{ activeBatch.success }} 成功</span>
            <span class="skipped">{{ activeBatch.skipped }} 跳过</span>
            <span class="failed">{{ activeBatch.failed }} 失败</span>
          </div>
          <!-- 结论就写在这张卡上：批次一开就推到你面前的抽屉，结果理应也留在这里。 -->
          <div v-if="activeBatch.state === 'completed' && batchResultMessage" class="batch-result">
            <Check :size="13" /><span>{{ batchResultMessage }}</span>
          </div>
          <div v-if="activeBatch.state === 'completed' && retryableBatchRepositoryIdsList.length" class="batch-card-footer">
            <span>重新入队后仍会执行全部安全预检</span>
            <button
              class="batch-retry-button"
              :aria-label="`重试 ${batchTypeLabel(activeBatch.type)} 未完成的 ${retryableBatchRepositoryIdsList.length} 个仓库`"
              :disabled="batchRetryBusy || batchStarting !== null"
              @click="retryActiveBatchIssues"
            ><LoaderCircle v-if="batchRetryBusy" :size="13" class="spinning" /><RotateCcw v-else :size="13" />重试需处理 {{ retryableBatchRepositoryIdsList.length }}</button>
          </div>
        </div>

        <div class="history-heading">
          <span>最近操作 · {{ filteredOperations.length }}/{{ operationsQuery.data.value?.operations.length || 0 }}</span>
          <div class="history-heading-actions">
            <button
              class="history-priority-filter"
              :class="{ active: operationNeedsAttentionOnly }"
              :aria-pressed="operationNeedsAttentionOnly"
              :disabled="operationIssueCount === 0 && !operationNeedsAttentionOnly"
              title="只显示失败或被安全条件阻止、需要人工查看的记录"
              @click="toggleOperationNeedsAttention"
            ><AlertTriangle :size="12" />需处理 <strong>{{ operationIssueCount }}</strong></button>
            <span class="history-stream" :data-live="operationsStreamConnected" aria-live="polite"><i />{{ operationsStreamConnected ? 'SSE 实时' : '轮询兜底' }}</span>
            <button
              class="table-icon-button"
              title="刷新操作记录"
              aria-label="刷新操作记录"
              :aria-busy="operationRefreshBusy || operationsQuery.isFetching.value"
              :aria-disabled="operationRefreshBusy || operationsQuery.isFetching.value"
              @click="refreshOperations"
            ><RefreshCw :size="14" :class="{ spinning: operationRefreshBusy || operationsQuery.isFetching.value }" /></button>
          </div>
        </div>
        <div class="history-filters">
          <SelectMenu v-model="operationRepositoryModel" :options="operationRepositoryOptions" aria-label="按仓库筛选操作记录" class="select-menu--history" />
          <SelectMenu v-model="operationTypeModel" :options="operationTypeOptions" aria-label="按动作筛选操作记录" class="select-menu--history" />
          <SelectMenu v-model="operationStateModel" :options="operationStateOptions" aria-label="按结果筛选操作记录" class="select-menu--history" />
          <button class="table-icon-button" title="清除筛选" aria-label="清除操作记录筛选" :disabled="!hasOperationFilters" @click="clearOperationFilters"><X :size="13" /></button>
        </div>
        <div class="operation-list">
          <div v-if="operationsQuery.isLoading.value" class="file-empty"><LoaderCircle :size="16" class="spinning" />读取操作记录…</div>
          <div v-else-if="!(operationsQuery.data.value?.operations.length)" class="history-empty"><History :size="24" /><span>还没有 Git 操作记录</span></div>
          <div v-else-if="filteredOperations.length === 0" class="history-empty"><Search :size="24" /><span>没有匹配筛选条件的操作</span><button class="compact-button" @click="clearOperationFilters">清除筛选</button></div>
          <template v-else>
            <template v-for="item in operationHistoryItems" :key="item.key">
              <button
                v-if="item.kind === 'successful-fetch-group'"
                class="operation-fetch-group"
                :aria-expanded="item.expanded"
                :aria-label="`${item.expanded ? '收起' : '展开'}同一批次的 ${item.operations.length} 条成功 Fetch 记录`"
                @click="toggleSuccessfulFetchBatch(item.batchId)"
              >
                <span class="operation-fetch-group-icon"><Check :size="13" /></span>
                <span class="operation-fetch-group-copy">
                  <strong>批量 Fetch 成功</strong>
                  <small>{{ item.operations.length }} 个仓库 · {{ relativeTime(item.operations[0]?.finishedAt) }}</small>
                </span>
                <span class="operation-fetch-group-count">{{ item.operations.length }}</span>
                <ChevronDown v-if="item.expanded" :size="14" /><ChevronRight v-else :size="14" />
              </button>
              <div
                v-else
                class="operation-row"
                :class="{ nested: item.nested }"
                :data-state="item.operation.state"
              >
                <span class="operation-state-dot" />
                <div class="operation-main">
                  <div><button class="operation-repository-link" @click="openOperationRepository(item.operation)">{{ item.operation.repositoryName }}</button><span>{{ operationTypeLabel(item.operation.type) }}</span></div>
                  <p>{{ item.operation.message }}</p>
                </div>
                <div class="operation-meta">
                  <span>{{ operationStateLabel(item.operation.state) }}</span>
                  <time>{{ item.operation.finishedAt ? relativeTime(item.operation.finishedAt) : item.operation.startedAt ? '执行中' : '等待中' }}</time>
                  <div
                    v-if="operationCredentialHost(item.operation) || (isOperationRetryable(item.operation) && ['fetch', 'pull', 'sync', 'push'].includes(item.operation.type))"
                    class="operation-actions"
                  >
                    <button
                      v-if="operationCredentialHost(item.operation)"
                      class="operation-credential"
                      :title="`为 ${operationCredentialHost(item.operation)} 录入凭证，成功后重试即可`"
                      :aria-label="`第 ${item.operationIndex + 1} 条操作：为 ${operationCredentialHost(item.operation)} 录入凭证`"
                      @click="configureCredentialFor(item.operation)"
                    ><ShieldCheck :size="12" />配置凭证</button>
                    <button
                      v-if="isOperationRetryable(item.operation) && ['fetch', 'pull', 'sync', 'push'].includes(item.operation.type)"
                      class="operation-retry"
                      :title="`重试 ${item.operation.repositoryName} 的 ${operationTypeLabel(item.operation.type)}`"
                      :aria-label="`第 ${item.operationIndex + 1} 条操作：重试 ${item.operation.repositoryName} 的 ${operationTypeLabel(item.operation.type)}`"
                      :disabled="operationRetryId !== null"
                      @click="retryOperation(item.operation)"
                    ><LoaderCircle v-if="operationRetryId === item.operation.id" :size="12" class="spinning" /><RotateCcw v-else :size="12" />重试</button>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
        <p class="history-note">批量任务最多 {{ query.data.value?.repositories.length || 0 }} 个仓库；单仓失败不会中断其他队列项。</p>
      </aside>
    </transition>

    <transition name="fade">
      <div v-if="shortcutHelpOpen" class="modal-backdrop" v-backdrop-close="() => (shortcutHelpOpen = false)">
        <section class="shortcut-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div><h2 id="shortcut-title">快捷键</h2></div>
            <button class="icon-button" title="关闭快捷键帮助" aria-label="关闭快捷键帮助" data-dialog-initial @click="shortcutHelpOpen = false"><X :size="18" /></button>
          </div>
          <div class="shortcut-list">
            <div v-for="row in shortcutHelpRows" :key="row.label">
              <span>{{ row.label }}</span>
              <template v-for="(chord, index) in row.chords" :key="index">
                <i v-if="index > 0" class="shortcut-alternative">或</i>
                <kbd v-for="key in chord" :key="key">{{ key }}</kbd>
              </template>
            </div>
          </div>
          <p>输入框聚焦时，除 Esc、↓ 外的单键快捷键会自动停用。</p>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="manageOpen" class="modal-backdrop" v-backdrop-close="closeManage">
        <section class="setup-modal manage-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" data-focus-layer tabindex="-1">
          <header class="setup-header manage-header">
            <div class="manage-header-copy">
              <span class="manage-header-kicker">SETTINGS</span>
              <h2 id="setup-title">个人配置与仓库接入</h2>
              <p class="manage-header-sub">配置写入本机 <code>config/</code>，不随仓库提交；个人路径不会离开这台电脑</p>
            </div>
            <button class="icon-button manage-close" title="关闭管理仓库" aria-label="关闭管理仓库" @click="closeManage"><X :size="18" /></button>
          </header>

          <div class="manage-body">
            <nav class="manage-nav" aria-label="设置分区">
              <span class="manage-nav-label" aria-hidden="true">分区</span>
              <button
                v-for="(item, index) in manageNav"
                :key="item.id"
                class="manage-nav-item"
                :aria-current="manageSection === item.id ? 'page' : undefined"
                @click="selectManageSection(item.id, $event)"
                @keydown="moveManageSectionFocus($event, index)"
              ><span class="manage-nav-icon"><component :is="item.icon" :size="15" /></span><span class="manage-nav-text">{{ item.label }}</span><b v-if="item.count !== null">{{ item.count }}</b></button>
              <div class="manage-nav-foot">
                <span>Moo Fleet</span>
                <code>v{{ appVersion }}</code>
              </div>
            </nav>

            <div ref="managePane" class="setup-scroll">
              <section v-if="manageSection === 'update'" class="manage-section">
                <div class="manage-pane-heading"><span class="manage-pane-icon"><CloudDownload :size="17" /></span><div><strong>检查更新</strong><small>手动检查不受三天限制；启动时超过三天自动检查</small></div></div>
                <div class="manage-panel">
                  <div class="manage-panel-head"><strong>Moo Fleet <code>v{{ appVersion }}</code></strong><small>检查结果来自云端更新服务</small></div>
                  <p v-if="!releaseCheck" class="manage-hint"><CloudDownload :size="14" />点击下方按钮检查是否有新版本。</p>
                  <p v-else-if="releaseCheck.reason" class="action-hint ai-key-error" role="status"><AlertTriangle :size="14" />{{ releaseCheck.reason }}</p>
                  <p v-else-if="updateAvailable" class="manage-hint"><BadgeCheck :size="14" />发现新版本 <code>v{{ releaseCheck.latest }}</code>。</p>
                  <p v-else class="manage-hint"><Check :size="14" />已是最新版本。</p>
                  <div class="manage-panel-actions">
                    <button class="secondary-button" :disabled="updateCheckBusy" @click="checkForUpdates()"><LoaderCircle v-if="updateCheckBusy" :size="16" class="spinning" /><CloudDownload v-else :size="16" />{{ updateCheckBusy ? '正在检查' : '检查更新' }}</button>
                    <UpdateDownloadControl v-if="updateAvailable" :url="releaseCheck?.releaseUrl ?? null" />
                  </div>
                </div>
              </section>

              <section v-else-if="manageSection === 'feedback'" class="manage-section">
                <div class="manage-pane-heading">
                  <span class="manage-pane-icon"><MessageCircle :size="17" /></span>
                  <div><strong>反馈</strong><small>提交问题、查看回复</small></div>
                </div>

                <div class="manage-panel">
                  <div class="manage-panel-head">
                    <strong>你的心声，我的提升！</strong>
                    <small>同一设备重装后仍能看到历史。</small>
                  </div>
                  <label class="form-field feedback-composer">
                    <span>描述你遇到的问题或想要的功能</span>
                    <textarea v-model="feedbackDraft" rows="4" maxlength="5000" placeholder="越具体越好，例如操作步骤、预期结果和实际结果。"></textarea>
                  </label>
                  <div class="manage-panel-actions">
                    <button class="secondary-button" :disabled="feedbackBusy || !feedbackDraft.trim()" @click="submitFeedback">
                      <LoaderCircle v-if="feedbackBusy" :size="16" class="spinning" />
                      <MessageCircle v-else :size="16" />
                      {{ feedbackBusy ? '提交中' : '提交反馈' }}
                    </button>
                    <span v-if="feedbackError" class="action-hint ai-key-error" role="status">{{ feedbackError }}</span>
                  </div>
                </div>

                <div v-if="feedbackLoading" class="manage-hint"><LoaderCircle :size="14" class="spinning" />正在加载反馈…</div>
                <div v-else-if="feedbackThreads.length === 0" class="manage-hint"><MessageCircle :size="14" />还没有反馈记录。</div>

                <div v-for="thread in feedbackThreads" :key="thread.id" class="manage-panel feedback-thread">
                  <div class="manage-panel-head">
                    <strong>v{{ thread.version }} · {{ thread.platform }}{{ thread.arch ? ` / ${thread.arch}` : '' }}</strong>
                    <small>{{ thread.status === 'open' ? '待处理' : thread.status === 'replied' ? '已回复' : thread.status === 'resolved' ? '已解决' : '已关闭' }}</small>
                  </div>
                  <div class="feedback-messages">
                    <div v-for="message in thread.messages" :key="message.id" class="feedback-message" :class="`feedback-message--${message.role}`">
                      <small>{{ message.role === 'admin' ? '客服' : '我' }}</small>
                      <p>{{ message.body }}</p>
                    </div>
                  </div>
                  <div v-if="thread.status !== 'closed'" class="manage-panel-actions">
                    <button v-if="feedbackReplyTo !== thread.id" class="compact-button" @click="feedbackReplyTo = thread.id; feedbackReplyDraft = ''">追加回复</button>
                    <template v-else>
                      <textarea v-model="feedbackReplyDraft" rows="2" maxlength="5000" class="feedback-reply-input" placeholder="补充说明…"></textarea>
                      <button class="compact-button" :disabled="feedbackBusy || !feedbackReplyDraft.trim()" @click="sendFeedbackReply(thread.id)">发送</button>
                      <button class="compact-button" @click="feedbackReplyTo = null">取消</button>
                    </template>
                  </div>
                </div>
              </section>

              <section v-else-if="manageSection === 'profile'" class="manage-section">
                <div class="manage-pane-heading"><span class="manage-pane-icon"><UserRound :size="17" /></span><div><strong>个人信息</strong><small>本机显示名称与 Commit 约定</small></div></div>
                <div class="manage-panel">
                  <div class="manage-panel-head"><strong>身份</strong><small>显示在操作记录与提交作者信息中</small></div>
                  <label class="form-field"><span>显示名称</span><input v-model="profileForm.displayName" data-dialog-initial /></label>
                </div>
                <div class="manage-panel">
                  <div class="manage-panel-head"><strong>提交约定</strong><small>决定 Commit 文案的语言与生成方式</small></div>
                  <div class="manage-field-pair">
                    <label class="form-field"><span>Commit 语言</span><SelectMenu v-model="commitLanguageModel" :options="commitLanguageOptions" aria-label="Commit 语言" class="select-menu--field" /></label>
                    <label class="form-field"><span>AI Commit 模式</span><SelectMenu v-model="aiCommitModeModel" :options="aiCommitModeOptions" aria-label="AI Commit 模式" class="select-menu--field" /></label>
                  </div>
                </div>
              </section>

              <section v-else-if="manageSection === 'appearance'" class="manage-section">
                <div class="manage-pane-heading">
                  <span class="manage-pane-icon"><Palette :size="17" /></span>
                  <div><strong>界面显示</strong><small>字体与字号在界面、代码区域分别生效</small></div>
                  <button type="button" class="manage-pane-action" @click="resetAppearance">恢复默认</button>
                </div>
                <div class="manage-panel manage-panel--themes">
                  <fieldset class="theme-picker">
                    <legend>深色主题</legend>
                    <div class="theme-options">
                      <label v-for="option in themeOptions" :key="option.value" class="theme-option">
                        <input v-model="themeModel" type="radio" name="fleet-theme" :value="option.value" />
                        <span class="theme-swatch" aria-hidden="true"><span v-for="(color, index) in option.swatch" :key="index" :style="{ background: color }"></span></span>
                        <span class="theme-option-copy"><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
                        <Check v-if="themeModel === option.value" :size="16" />
                      </label>
                    </div>
                    <small class="theme-picker-note">切换立即生效并保存到本机。Git 的增删红绿语义不随主题改变。</small>
                  </fieldset>
                </div>
                <div class="manage-panel">
                  <div id="appearance-type-head" class="manage-panel-head"><strong>字体与字号</strong><small>界面与代码分别取字，等宽区域始终等宽</small></div>
                  <section class="appearance-preference" aria-labelledby="appearance-type-head">
                    <div class="manage-field-pair">
                      <label class="form-field"><span>界面字体</span><SelectMenu v-model="interfaceFontModel" :options="interfaceFontOptions" aria-label="界面字体" class="select-menu--field" data-dialog-initial /></label>
                      <label class="form-field"><span>代码字体</span><SelectMenu v-model="codeFontModel" :options="codeFontOptions" aria-label="代码字体" class="select-menu--field" /></label>
                      <label class="form-field"><span>界面字号</span><SelectMenu v-model="interfaceFontSizeModel" :options="interfaceFontSizeOptions" aria-label="界面字号" class="select-menu--field" /></label>
                      <label class="form-field"><span>代码字号</span><SelectMenu v-model="codeFontSizeModel" :options="codeFontSizeOptions" aria-label="代码字号" class="select-menu--field" /></label>
                    </div>
                    <p class="appearance-sample"><span class="appearance-sample-label">预览</span>清晰阅读，从容操作<span>Moo Fleet · Aa 0123</span></p>
                    <small>自动保存到本机。系统字体缺失时自动回退到内置字体。</small>
                  </section>
                </div>
              </section>

              <section v-else-if="manageSection === 'ai'" class="manage-section">
                <div class="manage-pane-heading"><span class="manage-pane-icon"><Bot :size="17" /></span><div><strong>AI 服务</strong><small>DeepSeek Key 用于生成 Commit 文案</small></div></div>
                <div class="manage-panel">
                  <div class="manage-panel-head"><strong>DeepSeek 密钥</strong><small>只用于生成 Commit 文案，存在本机 AI 配置里</small></div>
                  <label class="form-field">
                    <span class="form-field-label">DeepSeek API Key<em class="manage-state-pill" :data-state="query.data.value?.ai.configured ? 'ready' : 'idle'">{{ query.data.value?.ai.configured ? '已配置' : '未配置' }}</em></span>
                    <span class="secret-input-control">
                      <input v-model="deepSeekApiKey" data-dialog-initial :type="deepSeekApiKeyVisible ? 'text' : 'password'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入或粘贴 API Key" @keydown.enter.prevent="saveDeepSeekKey" />
                      <button type="button" :title="deepSeekApiKeyVisible ? '隐藏 Key' : '显示 Key'" :aria-label="deepSeekApiKeyVisible ? '隐藏 DeepSeek API Key' : '显示 DeepSeek API Key'" @click="deepSeekApiKeyVisible = !deepSeekApiKeyVisible"><EyeOff v-if="deepSeekApiKeyVisible" :size="15" /><Eye v-else :size="15" /></button>
                      <button type="button" title="从 macOS 剪贴板粘贴" aria-label="粘贴 DeepSeek API Key" @click="pasteDeepSeekKey"><ClipboardPaste :size="15" /></button>
                    </span>
                  </label>
                  <p v-if="query.data.value?.ai.keyError" class="action-hint ai-key-error" role="status">
                    <AlertTriangle :size="14" />{{ query.data.value.ai.keyError }}。重新保存会覆盖该文件；若它已不是普通文件，请先手动删除。
                  </p>
                  <div class="manage-panel-actions">
                    <button class="secondary-button" :disabled="loadingDeepSeekApiKey || savingDeepSeekApiKey || deepSeekApiKey.trim().length < 8" @click="saveDeepSeekKey"><LoaderCircle v-if="loadingDeepSeekApiKey || savingDeepSeekApiKey" :size="16" class="spinning" /><ShieldCheck v-else :size="16" />保存 DeepSeek Key</button>
                    <small>Key 由 DeepSeek 控制台签发，保存后仅本机读取。</small>
                  </div>
                </div>
                <p class="manage-hint"><ShieldCheck :size="14" />每个仓库还能单独收紧 AI 策略（完全关闭 / 只发 diff stat / 发送脱敏 diff），在仓库详情的「编辑仓库配置」里改。</p>
              </section>

              <section v-else-if="manageSection === 'remote'" class="manage-section">
                <div class="manage-pane-heading"><span class="manage-pane-icon"><Link2 :size="17" /></span><div><strong>远端</strong><small>凭证、协议与地址；改动都只落在本机 .git/config</small></div></div>

                <p v-if="credentialOverview && credentialOverview.hosts.length > 0 && !credentialOverview.credentialHelper" class="action-hint ai-key-error" role="status">
                  <AlertTriangle :size="14" />当前没有配置 git credential.helper，保存的凭证不会被持久化。请先执行 <code>git config --global credential.helper osxkeychain</code>。
                </p>

                <p v-if="credentialsLoading && !credentialOverview" class="remote-credential-state" role="status">
                  <LoaderCircle :size="15" class="spinning" />正在读取远端凭证状态…
                </p>
                <p v-else-if="credentialOverview && credentialOverview.hosts.length === 0" class="remote-credential-state">
                  <!-- 判据是「凭证主机数为 0」，不是「没有远端」：本地路径或 SSH 远端都不产生凭证主机。 -->
                  <template v-if="remoteManagedRepositories.length">
                    还没有录入任何远端凭证。HTTPS 远端首次同步被拒时在这里补主机与令牌；
                    远端地址本身在下方「逐仓库远端」里增删改。
                  </template>
                  <template v-else>还没有已启用的仓库。先在「仓库接入」里添加，之后这里会列出需要凭证的远端主机。</template>
                </p>

                <ul v-else-if="credentialOverview" class="remote-credential-list">
                  <template v-for="host in credentialOverview.hosts" :key="`${host.protocol}://${host.host}`">
                    <li
                      class="remote-credential-row"
                      :data-state="credentialState(host)"
                      :data-editing="host.protocol === 'https' && credentialForm.host === host.host"
                    >
                      <span class="remote-credential-icon" aria-hidden="true">
                        <ShieldCheck v-if="credentialState(host) === 'ready'" :size="15" />
                        <AlertTriangle v-else-if="credentialState(host) === 'missing'" :size="15" />
                        <Cloud v-else :size="15" />
                      </span>
                      <div class="remote-credential-copy">
                        <strong>{{ host.host }}</strong>
                        <small>{{ credentialProtocolLabel(host) }} · {{ host.repositoryCount }} 个仓库<template v-if="host.repositories.length"> · {{ host.repositories.join('、') }}<template v-if="host.repositoryCount > host.repositories.length"> 等</template></template></small>
                      </div>
                      <span class="remote-credential-badge">{{ credentialStateLabel(host) }}</span>
                      <span class="remote-credential-actions">
                        <button
                          v-if="convertibleHostRepositories(host).length > 0"
                          type="button"
                          class="compact-button remote-protocol-switch"
                          :disabled="remoteProtocolBusy !== null"
                          :title="`把 ${host.host} 下 ${convertibleHostRepositories(host).length} 个仓库的远端地址切换到 ${oppositeProtocol(host.protocol) === 'https' ? 'HTTPS' : 'SSH'}`"
                          @click="switchHostProtocol(host)"
                        ><LoaderCircle v-if="remoteProtocolBusy === `${host.protocol}://${host.host}`" :size="13" class="spinning" /><GitBranch v-else :size="13" />{{ hostSwitchLabel(host) }}</button>
                        <button
                          v-if="hostRepositories(host).length > 0"
                          type="button"
                          class="table-icon-button remote-credential-expand"
                          :class="{ active: isCredentialHostExpanded(host) }"
                          :aria-expanded="isCredentialHostExpanded(host)"
                          :title="isCredentialHostExpanded(host) ? '收起仓库列表' : `查看 ${hostRepositories(host).length} 个仓库并逐个切换`"
                          :aria-label="isCredentialHostExpanded(host) ? `收起 ${host.host} 的仓库列表` : `展开 ${host.host} 的仓库列表`"
                          @click="toggleCredentialHost(host)"
                        ><ChevronDown v-if="isCredentialHostExpanded(host)" :size="13" /><ChevronRight v-else :size="13" /></button>
                        <template v-if="host.protocol === 'https'">
                          <button type="button" class="compact-button" @click="editCredential(host)">{{ host.hasCredential ? '更新' : '录入' }}</button>
                          <button
                            v-if="host.hasCredential"
                            type="button"
                            class="table-icon-button"
                            :disabled="credentialRemoving === host.host"
                            :title="`移除 ${host.host} 已保存的凭证`"
                            :aria-label="`移除 ${host.host} 已保存的凭证`"
                            @click="removeCredential(host.host)"
                          ><LoaderCircle v-if="credentialRemoving === host.host" :size="13" class="spinning" /><Trash2 v-else :size="13" /></button>
                        </template>
                      </span>
                    </li>
                    <li v-if="isCredentialHostExpanded(host)" class="remote-credential-repos">
                      <div v-for="repository in hostRepositories(host)" :key="repository.config.id" class="remote-credential-repo">
                        <span class="remote-credential-repo-name">{{ repository.config.name }}</span>
                        <code :title="repository.remoteUrl ?? ''">{{ repository.remoteUrl }}</code>
                        <button
                          type="button"
                          class="compact-button"
                          :disabled="remoteProtocolBusy !== null"
                          @click="switchRepositoryProtocol(repository)"
                        ><LoaderCircle v-if="remoteProtocolBusy === repository.config.id" :size="13" class="spinning" />{{ repositorySwitchLabel(repository) }}</button>
                      </div>
                    </li>
                  </template>
                </ul>

                <form class="remote-credential-form" @submit.prevent="saveCredential">
                  <div class="remote-credential-form-heading">
                    <strong>录入凭证</strong>
                    <small>凭证存入系统钥匙串，Moo Fleet 不保存副本</small>
                  </div>
                  <div class="remote-credential-fields">
                    <label class="form-field"><span>主机</span><input ref="credentialHostInput" v-model="credentialForm.host" placeholder="例如 gitee.com" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
                    <label class="form-field"><span>用户名</span><input ref="credentialUsernameInput" v-model="credentialForm.username" placeholder="远端账号名" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
                    <label class="form-field">
                      <span>访问令牌</span>
                      <span class="secret-input-control">
                        <input v-model="credentialForm.secret" :type="credentialSecretVisible ? 'text' : 'password'" placeholder="粘贴私人令牌，不是登录密码" autocomplete="off" autocapitalize="off" spellcheck="false" @keydown.enter.prevent="saveCredential" />
                        <button type="button" :title="credentialSecretVisible ? '隐藏令牌' : '显示令牌'" :aria-label="credentialSecretVisible ? '隐藏访问令牌' : '显示访问令牌'" @click="credentialSecretVisible = !credentialSecretVisible"><EyeOff v-if="credentialSecretVisible" :size="15" /><Eye v-else :size="15" /></button>
                        <button type="button" title="从剪贴板粘贴令牌" aria-label="粘贴访问令牌" @click="pasteCredentialSecret"><ClipboardPaste :size="15" /></button>
                      </span>
                    </label>
                  </div>
                  <div class="remote-credential-form-actions">
                    <button class="secondary-button" type="submit" :disabled="credentialSaving || !credentialForm.host.trim() || !credentialForm.username.trim() || !credentialForm.secret"><LoaderCircle v-if="credentialSaving" :size="16" class="spinning" /><ShieldCheck v-else :size="16" />保存凭证</button>
                    <button class="compact-button" type="button" :disabled="credentialSaving || (!credentialForm.host && !credentialForm.username && !credentialForm.secret)" @click="resetCredentialForm">清空</button>
                  </div>
                    <small class="remote-credential-note">令牌只经 stdin 交给 git，不写入配置文件。Gitee 与 GitHub 的 https 都要求私人令牌，账号密码无效。</small>
                  </form>

                  <!-- 逐仓库远端：舰队操作只认默认远端，这里是补 / 改 / 清远端的唯一入口 -->
                  <div class="manage-pane-heading remote-manage-heading">
                    <span class="manage-pane-icon"><GitBranch :size="17" /></span>
                    <div>
                      <strong>逐仓库远端</strong>
                      <small>补上缺失的 {{ remoteDefaultName }}、改掉写错的地址；改动只落在本机 .git/config</small>
                    </div>
                  </div>

                  <p v-if="remoteManagedRepositories.length === 0" class="remote-credential-state">
                    还没有已启用的仓库。先在「仓库接入」里添加。
                  </p>
                  <ul v-else class="remote-repository-list">
                    <li v-for="repository in remoteManagedRepositories" :key="repository.config.id" class="remote-repository">
                      <div class="remote-repository-head">
                        <button
                          type="button"
                          class="remote-repository-toggle"
                          :aria-expanded="isRemotePanelExpanded(repository.config.id)"
                          :aria-label="isRemotePanelExpanded(repository.config.id) ? `收起 ${repository.config.name} 的远端列表` : `展开 ${repository.config.name} 的远端列表`"
                          @click="toggleRepositoryRemotes(repository.config.id)"
                        >
                          <ChevronDown v-if="isRemotePanelExpanded(repository.config.id)" :size="13" />
                          <ChevronRight v-else :size="13" />
                          <span class="remote-repository-name">{{ repository.config.name }}</span>
                        </button>
                        <code v-if="repository.remoteUrl" class="remote-repository-url" :title="repository.remoteUrl">{{ repository.remoteUrl }}</code>
                        <span v-else class="remote-repository-missing">没有名为 {{ remoteDefaultName }} 的远端</span>
                      </div>

                      <div v-if="isRemotePanelExpanded(repository.config.id)" class="remote-repository-body">
                        <p v-if="remotesLoading === repository.config.id" class="remote-credential-state" role="status">
                          <LoaderCircle :size="14" class="spinning" />正在读取远端…
                        </p>
                        <template v-else>
                          <p v-if="remotesOf(repository.config.id).length === 0" class="remote-repository-empty">
                            这个仓库还没有任何远端。填上名称与地址即可新增——舰队操作使用名为
                            <code>{{ remoteDefaultName }}</code> 的远端。
                          </p>

                          <div v-for="remote in remotesOf(repository.config.id)" :key="remote.name" class="remote-item">
                            <span class="remote-item-name">{{ remote.name }}</span>
                            <span v-if="remote.isDefault" class="remote-item-badge">默认</span>
                            <span v-if="remote.pushUrl" class="remote-item-badge muted" :title="`推送地址：${remote.pushUrl}`">推送另指</span>
                            <code class="remote-item-url" :title="remote.url">{{ remote.url }}</code>
                            <span class="remote-item-actions">
                              <button type="button" class="compact-button" :disabled="remoteBusy !== null" @click="changeRemoteUrl(repository.config.id, remote)">改地址</button>
                              <button type="button" class="compact-button" :disabled="remoteBusy !== null" @click="renameRemote(repository.config.id, remote)">重命名</button>
                              <button
                                type="button"
                                class="table-icon-button"
                                :disabled="remoteBusy !== null"
                                :title="`删除远端 ${remote.name}`"
                                :aria-label="`删除远端 ${remote.name}`"
                                @click="removeRemote(repository.config.id, remote)"
                              >
                                <LoaderCircle v-if="remoteBusy === `${repository.config.id}:${remote.name}`" :size="13" class="spinning" />
                                <Trash2 v-else :size="13" />
                              </button>
                            </span>
                          </div>

                          <div v-if="isRemoteAdding(repository.config.id)" class="remote-add-row">
                            <label class="form-field"><span>名称</span><input v-model="remoteAddForm.name" placeholder="例如 origin" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
                            <label class="form-field"><span>地址</span><input v-model="remoteAddForm.url" placeholder="git@gitee.com:组/仓库.git" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
                            <div class="remote-add-actions">
                              <button class="compact-button" type="button" :disabled="remoteBusy !== null || !remoteAddReady" @click="submitAddRemote(repository.config.id)">
                                <LoaderCircle v-if="remoteBusy === `${repository.config.id}:add`" :size="13" class="spinning" /><Plus v-else :size="13" />添加
                              </button>
                              <button class="compact-button" type="button" @click="remoteAddFor = null">取消</button>
                            </div>
                            <small v-if="remoteAddProblem" class="remote-add-problem">{{ remoteAddProblem }}</small>
                          </div>
                          <button v-else type="button" class="compact-button" :disabled="remoteBusy !== null" @click="openRemoteAdd(repository.config.id)">
                            <Plus :size="13" />添加远端
                          </button>
                        </template>
                      </div>
                    </li>
                  </ul>
                </section>

              <section v-else-if="manageSection === 'repositories'" class="manage-section">
                <div class="manage-pane-heading"><span class="manage-pane-icon"><FolderGit2 :size="17" /></span><div><strong>仓库接入</strong><small>配置扫描目录，把仓库加入工作台</small></div></div>
                <div class="auto-fetch-preference" :data-enabled="profileForm.autoFetchIntervalMinutes !== 0">
                  <span class="preference-icon"><RefreshCw :size="16" /></span>
                  <div><strong>自动 Fetch</strong><span>{{ autoFetchDescription }}</span></div>
                  <SelectMenu v-model="autoFetchIntervalModel" :options="autoFetchIntervalOptions" aria-label="自动 Fetch 周期" class="select-menu--compact" />
                </div>
                <div class="repository-step-heading"><span>01</span><strong>配置扫描根目录</strong><small>选择电脑中的项目上级目录</small></div>
                <div class="root-manager">
                  <div class="root-list">
                    <div
                      v-for="(rootPath, rootId) in query.data.value?.roots"
                      :key="rootId"
                      class="root-row"
                      :class="{ active: scanRootId === String(rootId) }"
                      role="button"
                      tabindex="0"
                      :title="`点击扫描 ${rootNameFromPath(String(rootPath))}`"
                      @click="scanRootFromRow(String(rootId))"
                      @keydown.enter.prevent="scanRootFromRow(String(rootId))"
                      @keydown.space.prevent="scanRootFromRow(String(rootId))"
                    >
                      <span :title="String(rootPath)">{{ rootNameFromPath(String(rootPath)) }}</span><code>{{ rootPath }}</code><small>{{ rootUsageCount(String(rootId)) }} 仓库</small>
                      <button
                        class="table-icon-button"
                        :title="rootUsageCount(String(rootId)) > 0 ? `已有 ${rootUsageCount(String(rootId))} 个仓库引用，先移出仓库后才能移除目录` : '移除根目录'"
                        :aria-label="`移除目录 ${rootNameFromPath(String(rootPath))}`"
                        :aria-describedby="rootUsageCount(String(rootId)) > 0 ? `root-remove-reason-${String(rootId)}` : undefined"
                        :aria-disabled="rootUsageCount(String(rootId)) > 0 || rootBusy !== null"
                        :disabled="rootBusy !== null"
                        @click.stop="requestRemoveRoot(String(rootId), String(rootPath))"
                      ><LoaderCircle v-if="rootBusy === rootId" :size="13" class="spinning" /><Trash2 v-else :size="13" /></button>
                      <p v-if="rootUsageCount(String(rootId)) > 0" :id="`root-remove-reason-${String(rootId)}`" class="root-remove-reason">
                        已有 {{ rootUsageCount(String(rootId)) }} 个仓库引用，先移出仓库后才能移除目录
                      </p>
                    </div>
                  </div>
                  <div class="root-add-row">
                    <div class="root-path-control">
                      <input v-model="rootForm.path" data-dialog-initial aria-label="根目录绝对路径" placeholder="选择项目所在的上级目录" @keydown.enter="addRoot" />
                      <button
                        type="button"
                        class="directory-picker-button"
                        :disabled="directoryPicking || rootBusy !== null"
                        title="从电脑选择文件夹"
                        @click="chooseRootDirectory"
                      ><LoaderCircle v-if="directoryPicking" :size="14" class="spinning" /><FolderOpen v-else :size="14" />浏览</button>
                    </div>
                    <button class="compact-button" :disabled="rootBusy !== null || !rootForm.path.trim()" @click="addRoot"><LoaderCircle v-if="rootBusy === 'add'" :size="13" class="spinning" /><Plus v-else :size="13" />添加目录</button>
                  </div>
                </div>
                <div class="repository-step-heading"><span>02</span><strong>扫描并接入仓库</strong><small>点上方目录即可扫描</small></div>
                <div class="candidate-list">
                  <div v-if="!scanCandidates.length" class="candidate-empty"><FolderGit2 :size="24" /><strong>{{ scanning ? '正在扫描…' : '等待目录扫描' }}</strong><span>{{ scanning ? '正在读取该目录下的 Git 仓库' : '点上方目录即可扫描' }}</span></div>
                  <div v-for="candidate in scanCandidates" :key="candidate.absolutePath" class="candidate-row">
                    <div class="candidate-icon"><GitBranch :size="16" /></div>
                    <div class="candidate-info"><strong>{{ candidate.name }}<em v-if="candidate.sessionBackup" title="这是 Moo Fleet 的会话备份仓，由「AI 会话」页自动管理；加进工作台会被当成普通代码仓库">会话备份仓</em></strong><span>{{ candidate.relativePath }} · {{ candidate.branch || 'DETACHED' }}</span></div>
                    <span v-if="candidate.alreadyAdded" class="added-label"><Check :size="14" />已添加</span>
                    <button v-else class="compact-button" :disabled="addingPath === candidate.absolutePath" @click="addRepository(candidate)"><LoaderCircle v-if="addingPath === candidate.absolutePath" :size="14" class="spinning" /><Plus v-else :size="14" />加入</button>
                  </div>
                </div>
                <p class="repository-clone-hint"><Download :size="14" />要接入还不存在的仓库，用工作台工具栏的「克隆远端」。</p>
              </section>

              <section v-else class="manage-section">
                <ConfigurationTransfer
                  :roots="query.data.value?.roots ?? {}"
                  :repository-count="repositories.length"
                  @roots-changed="refreshAfterTransfer"
                  @imported="refreshAfterTransfer"
                  @settings-applied="applyImportedAppearance"
                />
              </section>
            </div>
          </div>

          <SurfaceNotice
            v-if="settingsNotice"
            class="setup-feedback"
            :notice="settingsNotice"
            @dismiss="dismissFeedback"
          />

          <div class="setup-footer">
            <div class="setup-footer-note">
              <span v-if="hasUnsavedProfileChanges" class="setup-unsaved"><CircleDot :size="14" />个人配置有未保存更改</span>
              <span><ShieldCheck :size="14" />把仓库移出工作台不会删除代码，文件仍留在原目录</span>
            </div>
            <div class="setup-footer-buttons">
              <button class="secondary-button" :disabled="savingProfile || !hasUnsavedProfileChanges" @click="saveProfile"><LoaderCircle v-if="savingProfile" :size="16" class="spinning" /><Check v-else :size="16" />保存个人配置</button>
              <button class="primary-button" :disabled="repositories.length === 0" @click="closeManage">进入工作台<ChevronRight :size="16" /></button>
            </div>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="repositoryEdit" class="modal-backdrop" v-backdrop-close="closeRepositoryEditor">
        <section class="repository-config-modal" role="dialog" aria-modal="true" aria-labelledby="repository-config-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div class="repository-config-title"><h2 id="repository-config-title">编辑仓库配置</h2><span v-if="hasUnsavedRepositoryEdit"><CircleDot :size="11" />未保存</span></div>
            <button class="icon-button" title="关闭仓库配置" aria-label="关闭仓库配置" @click="closeRepositoryEditor"><X :size="18" /></button>
          </div>
          <div class="repository-config-body">
            <label class="form-field"><span>显示名称</span><input v-model="repositoryEdit.name" data-dialog-initial /></label>
            <label class="form-field"><span>分组</span><input v-model="repositoryEdit.group" /></label>
            <label class="form-field"><span>标签（逗号分隔）</span><input v-model="repositoryEdit.tags" placeholder="laravel, package" /></label>
            <label class="form-field">
              <span>AI Commit 隐私策略</span>
              <SelectMenu v-model="aiCommitPolicyModel" :options="aiCommitPolicyOptions" aria-label="AI Commit 隐私策略" class="select-menu--field" />
            </label>
            <div class="repository-ai-policy" :data-policy="repositoryEdit.aiCommitPolicy">
              <ShieldCheck :size="16" />
              <span v-if="repositoryEdit.aiCommitPolicy === 'disabled'">此仓库永远不会调用 DeepSeek 或其他远端 AI。</span>
              <span v-else-if="repositoryEdit.aiCommitPolicy === 'stat-only'">只发送仓库名、路径、diff stat 与最近提交标题。</span>
              <span v-else>发送脱敏后的 staged diff；敏感路径仍会强制本地处理。</span>
            </div>
            <div class="capability-section">
              <div><strong>允许的 Git 操作</strong><span>关闭后对应按钮和 API 都会拒绝执行</span></div>
              <div class="capability-grid">
                <label v-for="capability in (['fetch', 'pull', 'stage', 'commit', 'stash', 'push'] as const)" :key="capability">
                  <input v-model="repositoryEdit.capabilities[capability]" type="checkbox" />
                  <span>{{ capability.toUpperCase() }}</span>
                </label>
              </div>
            </div>
            <div class="ignore-rules-section">
              <div class="ignore-rules-heading">
                <div>
                  <strong>忽略规则</strong><span>只列出仓库根的 .gitignore 与本机的 .git/info/exclude。删除会立刻写入磁盘，不能用下面的「取消」撤销。</span>
                </div>
                <LoaderCircle v-if="ignoreRulesLoading" :size="14" class="spinning" />
              </div>
              <div v-for="file in ignoreRules" :key="file.target" class="ignore-rule-file">
                <div class="ignore-rule-file-heading">
                  <code>{{ file.displayPath }}</code>
                  <span v-if="file.exists">{{ file.lines.filter(line => line.kind === 'rule').length }} 条规则</span>
                  <span v-else>还没有这个文件</span>
                  <button class="secondary-button ignore-rule-open" :disabled="openBusy !== null" :title="`在 VS Code 中打开 ${file.displayPath}`" @click="openRepositoryIgnoreFile(file.target)"><Code2 :size="14" />在编辑器中打开</button>
                </div>
                <ul v-if="file.lines.length" class="ignore-rule-lines">
                  <li v-for="rule in file.lines" :key="`${file.target}:${rule.line}`" :class="rule.kind">
                    <span class="ignore-rule-line-number">{{ rule.line }}</span>
                    <code>{{ rule.text.trim() ? rule.text : '（空行）' }}</code>
                    <button v-if="rule.kind === 'rule'" class="ignore-rule-remove" :disabled="ignoreRuleBusy !== null || !selectedRepository?.config.capabilities.stage" :aria-label="`从 ${file.displayPath} 移除规则 ${rule.text}`" :title="`从 ${file.displayPath} 移除这一条`" @click="removeRepositoryIgnoreRule(file, rule)"><LoaderCircle v-if="ignoreRuleBusy === ignoreRuleRowId(file, rule)" :size="13" class="spinning" /><Trash2 v-else :size="13" /></button>
                  </li>
                </ul>
              </div>
              <p class="ignore-rules-note">子目录里的嵌套 .gitignore 与全局 excludes 不在这里列出；「不再忽略」遇到这类来源只会提示来源文件，不会改动它们。</p>
            </div>
          </div>
          <div class="repository-config-footer">
            <button class="secondary-button" @click="closeRepositoryEditor">取消</button>
            <button class="primary-button" :disabled="repositoryEditBusy || !repositoryEdit.name.trim() || !repositoryEdit.group.trim()" @click="saveRepositoryEditor"><LoaderCircle v-if="repositoryEditBusy" :size="16" class="spinning" /><Check v-else :size="16" />保存配置</button>
          </div>
        </section>
      </div>
    </transition>


    <BranchMergeDialog v-if="branchMerge" :input="branchMerge.input" :preview="branchMerge.preview" :loading="branchMerge.loading" :busy="branchSwitchBusy === 'merge'" :error="branchMerge.error" @close="closeBranchMerge" @merge="executeBranchMerge" />
    <PushBranchesDialog
      v-if="pushBranches"
      :plan="pushBranches.plan"
      :loading="pushBranches.loading"
      :busy="pushBranchesBusy"
      :error="pushBranches.error"
      :initial="pushBranches.initial"
      :result="pushBranches.result"
      @close="closePushBranches"
      @push="executePushBranches"
    />
    <BatchPushBranchesDialog
      v-if="batchPushBranches"
      :plan="batchPushBranches.plan"
      :loading="batchPushBranches.loading"
      :busy="batchPushBranchesBusy"
      :error="batchPushBranches.error"
      :modes="batchPushBranches.modes"
      @close="closeBatchPushBranches"
      @push="executeBatchPushBranches"
      @change-modes="changeBatchPushBranchesModes"
    />
    <BatchMergeDialog
      v-if="batchMerge"
      :plan="batchMerge.plan"
      :loading="batchMerge.loading"
      :busy="batchMergeBusy"
      :error="batchMerge.error"
      @close="closeBatchMerge"
      @merge="executeBatchMerge"
    />
    <BatchPullDialog
      v-if="batchPull"
      :plan="batchPull.plan"
      :loading="batchPull.loading"
      :busy="batchPullBusy"
      :error="batchPull.error"
      :modes="batchPull.modes"
      @close="closeBatchPull"
      @pull="executeBatchPull"
      @change-modes="changeBatchPullModes"
    />

    <transition name="confirm">
      <div v-if="upstreamRepair" class="modal-backdrop upstream-repair-backdrop" v-backdrop-close="closeUpstreamRepair">
        <section
          class="upstream-repair-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="upstream-repair-title"
          :aria-busy="upstreamRepairLoading || upstreamRepairBusy"
          data-focus-layer
          tabindex="-1"
        >
          <div class="upstream-repair-header">
            <div class="upstream-repair-icon" aria-hidden="true"><Link2 :size="21" /></div>
            <div>
              <div class="upstream-repair-kicker">UPSTREAM REPAIR</div>
              <h2 id="upstream-repair-title">{{ upstreamRepair.repositoryName }}</h2>
              <p>为当前本地分支建立明确的远端跟踪关系</p>
            </div>
            <button class="icon-button confirmation-close" aria-label="关闭 upstream 修复" :disabled="upstreamRepairBusy" @click="closeUpstreamRepair"><X :size="17" /></button>
          </div>

          <div class="upstream-repair-body">
            <div v-if="upstreamRepairLoading && !upstreamRepair.plan" class="upstream-repair-loading" role="status">
              <LoaderCircle :size="18" class="spinning" />
              <div><strong>正在读取远端分支</strong><span>只检查本地 Git refs，不会修改仓库。</span></div>
            </div>

            <div v-if="upstreamRepair.error" class="upstream-repair-error" role="alert">
              <AlertTriangle :size="16" />
              <span>{{ upstreamRepair.error }}</span>
              <button :disabled="upstreamRepairLoading || upstreamRepairBusy" @click="loadUpstreamRepairPlan(upstreamRepair.repositoryId)"><RefreshCw :size="13" :class="{ spinning: upstreamRepairLoading }" />重新检测</button>
            </div>

            <template v-if="upstreamRepair.plan">
              <div class="upstream-local-snapshot">
                <div><span>LOCAL BRANCH</span><strong><GitBranch :size="13" />{{ upstreamRepair.plan.branch }}</strong></div>
                <div><span>CONFIRMED HEAD</span><code>{{ upstreamRepair.plan.head.slice(0, 12) }}</code></div>
                <div><span>WRITE SCOPE</span><strong><ShieldCheck :size="13" />{{ upstreamRepair.plan.candidates.length ? '仅本地配置' : '首次 Push' }}</strong></div>
              </div>

              <section v-if="upstreamRepair.plan.candidates.length" class="upstream-candidate-section">
                <div class="upstream-section-heading">
                  <div><strong>选择跟踪分支</strong><span>{{ upstreamRepair.plan.candidates.length === 1 ? '已找到唯一安全候选' : `检测到 ${upstreamRepair.plan.candidates.length} 个安全候选，请明确选择` }}</span></div>
                  <span v-if="upstreamRepair.plan.recommendedUpstream" class="recommended-badge"><Check :size="11" />RECOMMENDED</span>
                </div>
                <div class="upstream-candidate-list">
                  <label
                    v-for="(candidate, index) in upstreamRepair.plan.candidates"
                    :key="candidate.upstream"
                    class="upstream-candidate"
                    :data-selected="upstreamRepair.selectedUpstream === candidate.upstream"
                  >
                    <input
                      v-model="upstreamRepair.selectedUpstream"
                      type="radio"
                      name="upstream-candidate"
                      :value="candidate.upstream"
                      :data-dialog-initial="upstreamRepair.plan.candidates.length > 1 && index === 0 ? '' : undefined"
                    />
                    <span class="upstream-candidate-radio"><i /></span>
                    <span class="upstream-candidate-copy">
                      <strong><Link2 :size="13" />{{ candidate.upstream }}</strong>
                      <small>{{ upstreamCandidateReason(candidate) }}</small>
                    </span>
                    <span class="upstream-candidate-metrics">{{ upstreamCandidateDivergence(candidate) }}</span>
                  </label>
                </div>
                <p class="upstream-safety-note"><ShieldCheck :size="14" />关联只写入当前仓库的 `.git/config`，不会 Fetch、Pull、Push，也不会改变工作区文件。</p>
              </section>

              <section v-else class="upstream-publish-section">
                <div class="upstream-section-heading">
                  <div><strong>未找到可关联的远端分支</strong><span>没有同名 remote-tracking ref，也没有与当前 HEAD 完全相同的候选。</span></div>
                </div>
                <template v-if="upstreamRepair.plan.remotes.length">
                  <label class="upstream-remote-select">
                    <span>首次推送目标</span>
                    <SelectMenu
                      v-model="upstreamRemoteModel"
                      :options="upstreamRemoteOptions"
                      aria-label="首次推送目标"
                      :disabled="upstreamRepairBusy"
                      data-dialog-initial
                      style="grid-row: 1 / span 2; grid-column: 2;"
                    />
                    <code>{{ upstreamRepair.selectedRemote }}/{{ upstreamRepair.plan.branch }}</code>
                  </label>
                  <p class="upstream-publish-warning"><AlertTriangle :size="14" />继续操作会先 Fetch 复核，再创建同名远端分支；提交前还会出现一次明确确认。</p>
                  <p v-if="!upstreamRepair.plan.canPublish" class="upstream-capability-blocker">当前仓库配置未同时允许 Fetch 与 Push，不能执行首次推送。</p>
                </template>
                <p v-else class="upstream-capability-blocker">仓库没有配置 remote，请先在终端或仓库配置中添加 remote。</p>
              </section>
            </template>
          </div>

          <div class="upstream-repair-footer">
            <span><ShieldCheck :size="14" />提交时会再次校验 branch、HEAD 和远端 refs</span>
            <div>
              <button class="secondary-button" :disabled="upstreamRepairBusy" @click="closeUpstreamRepair">取消</button>
              <button
                v-if="upstreamRepair.plan?.candidates.length"
                class="upstream-primary"
                :disabled="upstreamRepairBusy || !upstreamRepair.selectedUpstream"
                :data-dialog-initial="upstreamRepair.plan.candidates.length === 1 ? '' : undefined"
                @click="trackSelectedUpstream"
              ><LoaderCircle v-if="upstreamRepairBusy" :size="15" class="spinning" /><Link2 v-else :size="15" />关联 {{ upstreamRepair.selectedUpstream || '所选分支' }}</button>
              <button
                v-else-if="upstreamRepair.plan"
                class="upstream-primary publish"
                :disabled="upstreamRepairBusy || !upstreamRepair.plan.canPublish || !upstreamRepair.selectedRemote"
                @click="publishAndTrackUpstream"
              ><LoaderCircle v-if="upstreamRepairBusy" :size="15" class="spinning" /><Upload v-else :size="15" />首次 Push 并关联</button>
            </div>
          </div>
        </section>
      </div>
    </transition>

    <transition name="confirm">
      <div v-if="confirmation" class="modal-backdrop confirmation-backdrop" v-backdrop-close="() => settleConfirmation(false)">
        <section
          class="confirmation-modal"
          :data-tone="confirmation.tone"
          :role="confirmation.tone === 'danger' ? 'alertdialog' : 'dialog'"
          aria-modal="true"
          aria-labelledby="confirmation-title"
          aria-describedby="confirmation-summary confirmation-details"
          data-focus-layer
          tabindex="-1"
        >
          <div class="confirmation-header">
            <div class="confirmation-icon" aria-hidden="true">
              <Trash2 v-if="confirmation.tone === 'danger'" :size="21" />
              <AlertTriangle v-else-if="confirmation.tone === 'caution'" :size="21" />
              <ShieldCheck v-else :size="21" />
            </div>
            <div>
              <h2 id="confirmation-title">{{ confirmation.title }}</h2>
            </div>
            <button class="icon-button confirmation-close" aria-label="取消并关闭确认弹窗" @click="settleConfirmation(false)"><X :size="17" /></button>
          </div>
          <div class="confirmation-body">
            <p id="confirmation-summary" class="confirmation-summary">{{ confirmation.summary }}</p>
            <div v-if="confirmation.target" class="confirmation-target">
              <span>本次范围</span>
              <strong :title="confirmation.target">{{ confirmation.target }}</strong>
            </div>
            <label v-if="confirmation.input" class="form-field">
              <span>{{ confirmation.input.label }}</span>
              <input v-model="confirmation.input.value" data-dialog-initial :aria-invalid="Boolean(confirmationInputError(confirmation.input))" :aria-describedby="confirmationInputError(confirmation.input) ? 'confirmation-input-error' : undefined" @keydown.enter.prevent="settleConfirmation(true)" />
              <small v-if="confirmationInputError(confirmation.input)" id="confirmation-input-error" role="status">{{ confirmationInputError(confirmation.input) }}</small>
            </label>
            <div v-if="confirmation.checkboxes?.length" class="confirmation-checkboxes">
              <label v-for="box in confirmation.checkboxes" :key="box.id">
                <input v-model="box.value" type="checkbox" />
                <span>{{ box.label }}<small v-if="box.description">{{ box.description }}</small></span>
              </label>
            </div>
            <ul id="confirmation-details" class="confirmation-details">
              <li v-for="detail in confirmation.details" :key="detail"><Check :size="13" />{{ detail }}</li>
            </ul>
          </div>
          <div class="confirmation-footer">
            <div>
              <button class="secondary-button" :data-dialog-initial="confirmation.input ? undefined : ''" @click="settleConfirmation(false)">取消</button>
              <button class="confirmation-confirm" :disabled="confirmationBlocked(confirmation)" @click="settleConfirmation(true)">
                <Trash2 v-if="confirmation.tone === 'danger'" :size="15" />
                <Check v-else :size="15" />
                {{ confirmation.confirmLabel }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="cloneDialogOpen" class="modal-backdrop" v-backdrop-close="closeCloneDialog">
        <section class="clone-dialog" role="dialog" aria-modal="true" aria-labelledby="clone-dialog-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div>
              <span class="section-kicker">仓库接入</span>
              <h2 id="clone-dialog-title">克隆远端仓库</h2>
            </div>
            <button class="icon-button" title="关闭克隆弹窗" aria-label="关闭克隆弹窗" @click="closeCloneDialog"><X :size="18" /></button>
          </div>
          <div class="clone-dialog-body">
            <p class="clone-dialog-note">克隆完成后会自动登记并扫描，直接出现在工作台里；不会覆盖任何已存在的目录。</p>
            <div v-if="cloneRootOptions.length > 0" class="clone-form">
              <!-- 克隆进行中把输入锁住：这时改地址不会影响已经在跑的那次克隆，
                   只会让人以为改的是它；改完再关窗口，刚敲的内容还会被成功回调清掉。 -->
              <label class="form-field">
                <span>克隆到哪个目录</span>
                <SelectMenu v-model="cloneForm.rootId" :options="cloneRootOptions" :disabled="cloneBusy" aria-label="选择克隆到的根目录" />
              </label>
              <label class="form-field">
                <span>远端地址</span>
                <span class="url-input-control">
                  <!-- 占位只留最不容易猜的那个形态（SSH）。写「或 https://…」在 1024 宽下会被截断，
                       反而看起来像输入框坏了；HTTPS 地址人人会填，不需要示例。 -->
                  <input v-model="cloneForm.url" data-dialog-initial placeholder="git@gitee.com:组/仓库.git" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="cloneBusy" @keydown.enter.prevent="submitClone()" />
                  <button type="button" title="从剪贴板粘贴地址" aria-label="从剪贴板粘贴远端地址" :disabled="cloneBusy" @click="pasteCloneUrl"><ClipboardPaste :size="15" /></button>
                </span>
              </label>
              <label class="form-field">
                <span>目录名（可选）</span>
                <input v-model="cloneForm.directory" :placeholder="cloneDirectory || '按地址末段自动命名'" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="cloneBusy" @keydown.enter.prevent="submitClone()" />
              </label>
              <small v-if="cloneProblem" class="clone-problem">{{ cloneProblem }}</small>
            </div>
            <div v-else class="clone-dialog-empty">
              <FolderOpen :size="22" />
              <div><strong>还没有扫描目录</strong><span>先指定一个项目上级目录，克隆才有地方落盘。</span></div>
              <button class="compact-button" @click="openRepositorySetupFromClone">去添加目录</button>
            </div>
            <!-- 认证类失败：https 就地补填；SSH / 网络类只给下一步，不假装能在这里修。 -->
            <small v-if="cloneAuthStatus && !cloneAuthStatus.fixable" class="clone-auth-guidance"><AlertTriangle :size="13" />{{ cloneAuthStatus.guidance }}</small>
            <div v-if="cloneAuth.open" class="clone-auth">
              <div class="clone-auth-heading">
                <AlertTriangle :size="15" />
                <div>
                  <strong>{{ cloneAuth.host }} 需要凭证</strong>
                  <small>{{ cloneAuthStatus?.guidance ?? '填入该主机的用户名与访问令牌后会自动重试。' }}</small>
                </div>
              </div>
              <div class="clone-auth-fields">
                <label class="form-field"><span>用户名</span><input ref="cloneAuthUsernameInput" v-model="cloneAuth.username" placeholder="远端账号名" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
                <label class="form-field">
                  <span>访问令牌</span>
                  <span class="secret-input-control">
                    <input v-model="cloneAuth.secret" :type="cloneAuthSecretVisible ? 'text' : 'password'" placeholder="粘贴私人令牌，不是登录密码" autocomplete="off" autocapitalize="off" spellcheck="false" @keydown.enter.prevent="saveCloneCredentialAndRetry" />
                    <button type="button" :title="cloneAuthSecretVisible ? '隐藏令牌' : '显示令牌'" :aria-label="cloneAuthSecretVisible ? '隐藏访问令牌' : '显示访问令牌'" @click="cloneAuthSecretVisible = !cloneAuthSecretVisible"><EyeOff v-if="cloneAuthSecretVisible" :size="15" /><Eye v-else :size="15" /></button>
                    <button type="button" title="从剪贴板粘贴令牌" aria-label="粘贴访问令牌" @click="pasteCloneSecret"><ClipboardPaste :size="15" /></button>
                  </span>
                </label>
              </div>
              <div class="clone-auth-actions">
                <button class="primary-button" :disabled="cloneAuthBusy || !cloneAuth.username.trim() || !cloneAuth.secret" @click="saveCloneCredentialAndRetry">
                  <LoaderCircle v-if="cloneAuthBusy" :size="13" class="spinning" /><ShieldCheck v-else :size="13" />{{ cloneAuthBusy ? '保存中…' : '保存并重试' }}
                </button>
                <small class="clone-auth-hint">凭证存入系统钥匙串，Moo Fleet 不保存副本。</small>
                <small v-if="cloneAuthError" class="clone-auth-error" role="alert">{{ cloneAuthError }}</small>
              </div>
            </div>
          </div>
          <div class="clone-dialog-footer" :class="{ 'is-progressing': cloneBusy }">
            <small v-if="cloneError && !cloneAuth.open" class="clone-dialog-error" role="alert"
              ><strong v-if="cloneErrorHint">{{ cloneErrorHint }}</strong
              ><span>克隆失败：{{ cloneErrorText }}</span></small
            >
            <!-- 克隆中给两样东西：git 自己报的阶段百分比，和本机计时。
                 只显示「正在克隆…」时，慢网络下界面看起来像卡死了；
                 而计时永远不会缺，进度要等 git 连上远端才开始有。 -->
            <div v-else-if="cloneBusy" class="clone-progress" role="status">
              <div
                v-if="cloneProgressWidth !== null"
                class="clone-progress-bar"
                role="progressbar"
                aria-label="克隆进度"
                :aria-valuenow="cloneProgressWidth"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: `${cloneProgressWidth}%` }" />
              </div>
              <small class="clone-hint">{{ cloneProgressSummary }}</small>
              <small class="clone-hint">大仓库可能要几分钟；可以先关掉这个窗口，结束后会提示结果。</small>
            </div>
            <!-- 有问题时不能再写「将创建」：那个位置要么已经存在、要么根本不能创建，
                 字段上方已经说明原因，这里再说一句只会自相矛盾。 -->
            <small v-else-if="cloneTargetPath && !cloneProblem" class="clone-hint">将创建：<code>{{ cloneTargetPath }}</code></small>
            <span v-else class="clone-dialog-spacer" />
            <div class="clone-dialog-buttons">
              <!-- 克隆中点「取消」其实取消不了：git 已经在跑，这个按钮只会把窗口收起来。
                   如实写成「关闭」，别让用户以为自己中止了这次克隆。 -->
              <button class="secondary-button" @click="closeCloneDialog">{{ cloneBusy ? '关闭' : '取消' }}</button>
              <!-- 补填面板展开时，这一步唯一有意义的动作是「保存并重试」；
                   再留一个可点的绿色「克隆并加入」只会让人重复撞同一堵墙。 -->
              <button v-if="!cloneAuth.open" class="primary-button" :disabled="!cloneReady" @click="submitClone()">
                <LoaderCircle v-if="cloneBusy" :size="16" class="spinning" /><Download v-else :size="16" />{{ cloneBusy ? '正在克隆…' : '克隆并加入' }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </transition>
  </div>
</template>
