<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardPaste,
  Clock3,
  Cloud,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  FolderGit2,
  GitBranch,
  History,
  Keyboard,
  Link2,
  ListTodo,
  LoaderCircle,
  MessagesSquare,
  PackageOpen,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tag,
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
  BranchesSnapshot,
  ConflictResolutionStrategy,
  DashboardPayload,
  FileChange,
  MergePreview,
  MergePreviewRequest,
  MergeSource,
  OperationRecord,
  OperationState,
  OperationType,
  OperationsPayload,
  ProfileConfig,
  ProfileViewPreferences,
  RemoteBranch,
  RepositoryFilterMode,
  RepositoryCapabilities,
  RepositoryStatus,
  ScanCandidate,
  StashEntry,
  TagEntry,
  UpstreamRepairPlan,
  UpstreamRepairRequest,
} from '../shared/contracts';
import { compareRepositoryActivity, compareRepositoryLastCommit, compareRepositoryPinning } from '../shared/repository-pinning';
import { api, ApiError } from './api';
import { mergePausedErrorCode } from '../shared/contracts';
import { autoFetchIntervalLabel, autoFetchIntervals, isAutoFetchDue, latestFetchBatchAt, parseLastAutoFetchAt } from './auto-fetch';
import { batchRetryConfirmationDetails, batchSignalAriaLabel, retryableBatchRepositoryIds } from './batch-retry';
import { branchDivergenceLabel, compareBranchNames } from './branch-presentation';
import { presentGitDiff } from './diff-presentation';
import {
  activeFocusLayer,
  focusInitialControl,
  focusReturnFallback,
  focusableControls,
  isEditableTarget,
  trapDialogFocus,
} from './dialog-focus';
import {
  buildOperationHistoryItems,
  isOperationIssue,
  isOperationRetryable,
  operationsRefetchInterval,
} from './operation-history';
import {
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
  pullAvailability as repositoryPullAvailability,
  pushAvailability as repositoryPushAvailability,
} from './repository-action-availability';
import { rootNameFromPath } from './root-identity';
import { presentGlobalToast } from './toast-presentation';
import { useConfirmation, type ConfirmationOptions } from './use-confirmation';
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
} from './repository-signals';
import { defaultViewPreferences, parseViewPreferences } from './view-preferences';
import { interfaceFontFamilies, interfaceFontOptions, interfaceFontSizeOptions } from './appearance';
import SelectMenu from './components/SelectMenu.vue';
import DiffView from './components/DiffView.vue';
import RepositoryWorkspace from './components/RepositoryWorkspace.vue';
import BranchMergeDialog from './components/BranchMergeDialog.vue';
import CommitComposer from './components/CommitComposer.vue';
import { useCommitComposer } from './use-commit-composer';
import { useRepositoryDiff } from './use-repository-diff';
import type { DiffKind } from './repository-workspace';
import SessionRelay from './components/SessionRelay.vue';

const queryClient = useQueryClient();
type SessionRelayHandle = { syncSessions: () => void; focusSearch: () => void; focusList: () => void; refresh: () => void };
const activeWorkspace = ref<'repositories' | 'sessions'>('repositories');
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
let globalToastTimer: number | null = null;
let scrollbarVisibilityTimer: number | null = null;
let repositoryFilesRequest = 0;
let repositoryStashesRequest = 0;
let repositoryTagsRequest = 0;
let repositoryBranchesRequest = 0;
let repositoryContextVersion = 0;

const query = useQuery({
  queryKey: ['dashboard'],
  queryFn: api.dashboard,
  refetchInterval: 15_000,
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
const interfaceFont = ref(cachedViewPreferences.interfaceFont ?? 'system');
const interfaceFontSize = ref(cachedViewPreferences.interfaceFontSize ?? 14);
watch([interfaceFont, interfaceFontSize], () => {
  document.documentElement.style.setProperty('--ui-font-family', interfaceFontFamilies[interfaceFont.value]);
  document.documentElement.style.setProperty('--ui-font-size', `${interfaceFontSize.value}px`);
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
const shortcutHelpOpen = ref(false);
const manageOpen = ref(false);
const historyOpen = ref(false);
const historyReturnOperationId = ref<string | null>(null);
const selectedRepository = ref<RepositoryStatus | null>(null);
watch(() => Boolean(selectedRepository.value), (open, wasOpen) => {
  if (open && !wasOpen) {
    // Preserve the background width while the full-window workspace covers the root gutter.
    document.documentElement.style.setProperty('--fleet-page-gutter', `${window.innerWidth - document.body.getBoundingClientRect().width}px`);
  }
}, { flush: 'sync' });
const scanRootId = ref('');
const scanRootMenuOpen = ref(false);
const scanRootMenuRoot = ref<HTMLElement | null>(null);
const scanRootTrigger = ref<HTMLButtonElement | null>(null);
const scanCandidates = ref<ScanCandidate[]>([]);
const scanning = ref(false);
const directoryPicking = ref(false);
const savingProfile = ref(false);
const deepSeekApiKey = ref('');
const deepSeekApiKeyVisible = ref(false);
const loadingDeepSeekApiKey = ref(false);
const savingDeepSeekApiKey = ref(false);
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
const repositoryAction = ref<'fetch' | 'pull' | 'push' | null>(null);
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
const branchTrigger = ref<HTMLButtonElement | null>(null);
const branchSnapshot = ref<BranchesSnapshot | null>(null);
const branchesLoading = ref(false);
const branchSwitchBusy = ref<string | null>(null);
const branchCreateName = ref('');
const branchCreateCheckout = ref(true);
const branchRenameTarget = ref<string | null>(null);
const branchRenameName = ref('');
const openBusy = ref<'finder' | 'terminal' | 'vscode' | null>(null);
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
const fileActionId = ref<string | null>(null);
const fileDiscardId = ref<string | null>(null);
const fileMutationBusy = computed(() => fileActionId.value !== null || fileDiscardId.value !== null);
const conflictBusy = ref<string | null>(null);
const operationBusy = ref<'continue' | 'abort' | null>(null);
const conflictedFiles = computed(() => repositoryFiles.value.filter((file) => file.conflicted));
const repositoryStashes = ref<StashEntry[]>([]);
const stashesLoading = ref(false);
const stashBusy = ref<'create' | string | null>(null);
const stashMessage = ref('');
const stashIncludeUntracked = ref(true);
const repositoryTags = ref<TagEntry[]>([]);
const tagsLoading = ref(false);
/** 正在处理中的 Tag 名（创建时用 `create:<name>`）。 */
const tagBusy = ref<string | null>(null);
const tagForm = reactive({ name: '', message: '', push: false });
const commitBusy = ref(false);
const hunkActionBusy = ref<number | null>(null);
const repositoryWorkspace = ref<{ focusSearch: () => void; showWorking: () => void; showCurrentBranch: () => void } | null>(null);
const workspaceRefreshing = ref(false);
const branchMerge = ref<{ repositoryId: string; input: MergePreviewRequest; preview: MergePreview | null; loading: boolean; error: string } | null>(null);
const workspaceBusy = computed(() => fileMutationBusy.value || hunkActionBusy.value !== null || branchSwitchBusy.value !== null || repositoryAction.value !== null || conflictBusy.value !== null || operationBusy.value !== null || stashBusy.value !== null || commitBusy.value || tagBusy.value !== null);
const repositoryDiff = useRepositoryDiff({
  repositoryId: () => selectedRepository.value?.config.id ?? null,
  files: repositoryFiles,
  busy: () => workspaceBusy.value || workspaceRefreshing.value,
  read: api.fileDiff,
});
const { dialog: diffDialog, loading: diffLoading, error: diffError } = repositoryDiff;
const diffPresentation = computed(() => diffDialog.value ? presentGitDiff(diffDialog.value.diff, diffDialog.value.path) : null);
/** 冲突文件与禁用 Stage 的仓库不给按块操作入口。 */
const diffHunkActionLabel = computed(() => {
  const dialog = diffDialog.value;
  const repository = selectedRepository.value;
  if (!dialog || !repository || !repository.config.capabilities.stage) return undefined;
  const file = repositoryFiles.value.find((item) => item.path === dialog.path);
  if (!file || file.conflicted || dialog.diff.endsWith('… diff 已截断 …')) return undefined;
  return dialog.kind === 'unstaged' ? '暂存此块' : '取消暂存此块';
});
const { confirmation, requestConfirmation, settleConfirmation } = useConfirmation();
const actionError = ref('');
const actionMessage = ref('');
const commitComposer = ref<InstanceType<typeof CommitComposer> | null>(null);
const composer = useCommitComposer({
  repositoryId: () => selectedRepository.value?.config.id ?? null,
  draftKey: () => selectedRepository.value ? `${selectedRepository.value.config.id}\0${selectedRepository.value.branch ?? 'DETACHED'}` : '',
  revision: () => JSON.stringify([branchSnapshot.value?.head, repositoryFiles.value.map(file => [file.id, file.staged, file.unstaged, file.conflicted])]),
  paused: () => workspaceBusy.value || workspaceRefreshing.value || filesLoading.value || Boolean(branchMerge.value),
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
const globalToast = computed(() => presentGlobalToast(actionError.value, actionMessage.value));

function dismissGlobalToast(): void {
  actionError.value = '';
  actionMessage.value = '';
}

watch(
  [actionError, actionMessage, manageOpen],
  ([error, message, managing]) => {
    if (globalToastTimer !== null) window.clearTimeout(globalToastTimer);
    globalToastTimer = null;
    if (managing || (!error && !message)) return;
    const currentError = error;
    const currentMessage = message;
    globalToastTimer = window.setTimeout(() => {
      if (actionError.value === currentError && actionMessage.value === currentMessage) dismissGlobalToast();
      globalToastTimer = null;
    }, globalToast.value.duration);
  },
  { flush: 'post' },
);

const profileForm = reactive<ProfileConfig['profile']>({
  displayName: '',
  avatar: null,
  locale: 'zh-CN',
  theme: 'moon',
  preferredCommitLanguage: 'zh-CN',
  aiCommitMode: 'review',
  autoFetchIntervalMinutes: 0,
  viewPreferences: { ...cachedViewPreferences },
});

const rootForm = reactive({ path: '' });
const selectedScanRootPath = computed(() => query.data.value?.roots[scanRootId.value] ?? '');
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
      interfaceFont.value = preferences.interfaceFont ?? 'system';
      interfaceFontSize.value = preferences.interfaceFontSize ?? 14;
      persistedViewPreferences = JSON.stringify(currentViewPreferences());
      viewPreferencesHydrated = true;
    }
    profileForm.viewPreferences = currentViewPreferences();
    if (!scanRootId.value) scanRootId.value = Object.keys(dashboard.roots)[0] ?? '';
    if (!repositorySetupPrompted) {
      repositorySetupPrompted = true;
      if (dashboard.repositories.length === 0 && activeWorkspace.value === 'repositories') manageOpen.value = true;
    }
    if (selectedRepository.value) {
      selectedRepository.value =
        dashboard.repositories.find((repository) => repository.config.id === selectedRepository.value?.config.id) ?? null;
    }
  },
  { immediate: true },
);

watch(
  [sortMode, stateFilter, groupFilter, interfaceFont, interfaceFontSize],
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
    filesLoading.value = false;
    repositoryStashes.value = [];
    stashesLoading.value = false;
    branchPanelOpen.value = false;
    branchSnapshot.value = null;
    branchesLoading.value = false;
    stashMessage.value = '';
    repositoryAction.value = null;
    branchSwitchBusy.value = null;
    workspaceRefreshing.value = false;
    hunkActionBusy.value = null;
    conflictBusy.value = null;
    operationBusy.value = null;
    openBusy.value = null;
    stashBusy.value = null;
    fileActionId.value = null;
    fileDiscardId.value = null;
    diffLoading.value = false;
    repositoryStashes.value = [];
    stashesLoading.value = false;
    repositoryTags.value = [];
    tagsLoading.value = false;
    tagBusy.value = null;
    tagForm.name = '';
    tagForm.message = '';
    if (repositoryId) {
      void loadRepositoryBranches(repositoryId);
      void loadRepositoryFiles(repositoryId);
      void loadRepositoryStashes(repositoryId);
      void loadRepositoryTags(repositoryId);
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
    if (!batch || batch.state !== 'completed') return;
    const completionMessage = `批量 ${batch.type.toUpperCase()} 完成：${batch.success} 成功，${batch.skipped} 跳过，${batch.failed} 失败`;
    actionMessage.value = completionMessage;
    activeBatchId.value = null;
    const refreshed = await query.refetch();
    if (batch.type === 'fetch' && refreshed.isSuccess && refreshed.data) {
      const batchRepositoryIds = new Set(
        operationsQuery.data.value?.operations
          .filter((operation) => operation.batchId === batch.id && operation.state === 'success')
          .map((operation) => operation.repositoryId) ?? [],
      );
      const batchRepositories = refreshed.data.repositories.filter((repository) => (
        batchRepositoryIds.has(repository.config.id)
      ));
      if (batchRepositories.length > 0 && !activeBatchId.value && actionMessage.value === completionMessage) {
        actionMessage.value = `${completionMessage}；${fetchBatchResultMessage(batchRepositories)}`;
      }
    }
  },
);

const repositories = computed(() => query.data.value?.repositories ?? []);
const projectSwitchBlocked = computed(() => workspaceBusy.value || workspaceRefreshing.value || composer.reading.value || Boolean(branchMerge.value));
const projectSwitchOptions = computed<SelectMenuOption[]>(() => [...repositories.value]
  .sort(compareWorkspaceRepositories)
  .map(repository => ({
    value: repository.config.id,
    label: repository.config.name,
    hint: `${repository.absolutePath}${repository.available ? '' : ' · 路径不可用'}`,
    disabled: !repository.available,
  })));
const selectedProjectModel = computed<string | number>({
  get: () => selectedRepository.value?.config.id ?? '',
  set: value => {
    if (projectSwitchBlocked.value || confirmation.value || upstreamRepair.value) return;
    const repository = repositories.value.find(item => item.config.id === value);
    if (!repository?.available || repository.config.id === selectedRepository.value?.config.id) return;
    dismissGlobalToast();
    historyReturnOperationId.value = null;
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
const branchPanelBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return '仓库详情已关闭';
  if (composer.reading.value) return '正在核对提交内容';
  if (!repository.config.capabilities.stage) return '仓库配置未允许修改工作区';
  if (repository.inProgressOperation) return `正在进行 ${repository.inProgressOperation}`;
  if (hasWorktreeChanges(repository)) return '新建或检出需要先处理工作区改动；已有本地分支仍可切换';
  return null;
});
const localBranchSwitchBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return '仓库详情已关闭';
  if (composer.reading.value) return '正在核对提交内容';
  if (!repository.config.capabilities.stage) return '仓库配置未允许修改工作区';
  if (repository.inProgressOperation) return `正在进行 ${repository.inProgressOperation}`;
  if (repository.conflicted) return '工作区存在未解决的冲突';
  return null;
});
/** 还没有同名本地分支的远端分支，可以直接检出并建立跟踪。 */
const checkoutableRemoteBranches = computed(() =>
  (branchSnapshot.value?.remoteBranches ?? []).filter((branch) => !branch.hasLocal),
);
const filteredRemoteBranches = computed(() => {
  return checkoutableRemoteBranches.value.slice(0, 50);
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
  if (selectedRepositoryIds.value.length > 0) return `已选 ${selectedRepositories.value.length}`;
  return hasRepositoryFilters.value ? '当前结果' : '全部仓库';
});
type BatchAvailabilitySummary = {
  eligible: number;
  total: number;
  detail: string;
};
const batchAvailability = computed<Record<BatchOperationType, BatchAvailabilitySummary>>(() => {
  const targets = batchTargetRepositories.value;
  const total = targets.length;
  const fetchEligible = batchEligibleRepositoryCount(targets, 'fetch');
  const pullEligible = batchEligibleRepositoryCount(targets, 'pull');
  const pushEligible = batchEligibleRepositoryCount(targets, 'push');
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
    push: {
      eligible: pushEligible,
      total,
      detail: pushEligible > 0
        ? `${pushEligible} 个仓库有提交可安全推送。`
        : '当前范围没有可安全推送的仓库；落后远端、未关联远端或没有新提交的仓库会被跳过。',
    },
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

const pullAvailability = computed(() => repositoryPullAvailability(selectedRepository.value));
const pushAvailability = computed(() => repositoryPushAvailability(selectedRepository.value));
const activeFocusLayers = computed(() => {
  const layers: string[] = [];
  if (selectedRepository.value) layers.push(`repository:${selectedRepository.value.config.id}`);
  else if (historyOpen.value) layers.push('history');
  if (shortcutHelpOpen.value) layers.push('shortcuts');
  if (manageOpen.value) layers.push('manage');
  if (repositoryEdit.value) layers.push(`repository-edit:${repositoryEdit.value.id}`);
  if (upstreamRepair.value) layers.push(`upstream:${upstreamRepair.value.repositoryId}`);
  if (branchMerge.value) layers.push(`merge:${branchMerge.value.repositoryId}`);
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
        { label: '关闭抽屉或弹窗', chords: [['Esc']] },
        { label: '显示本帮助', chords: [['?']] },
      ]
));
/** 有焦点层打开时，被遮住的后台内容对读屏和脚本都不应再可达；画布自身保持可交互。 */
const appBackgroundInert = computed(() => activeFocusLayers.value.length > 0);

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

const autoFetchDescription = computed(() => {
  const interval = profileForm.autoFetchIntervalMinutes;
  if (interval === 0) return '关闭时只刷新本地状态，不主动访问远端';
  return `浏览器打开期间每 ${autoFetchIntervalLabel(interval)} Fetch 全部已启用仓库`;
});

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
  await focusRepositoryList();
}

async function copyToClipboard(value: string | null, label: string): Promise<void> {
  if (!value) return;
  actionError.value = '';
  try {
    await navigator.clipboard.writeText(value);
    actionMessage.value = `${label}已复制`;
  } catch {
    actionError.value = `${label}复制失败，请检查浏览器剪贴板权限`;
  }
}

function openHistory(): void {
  closeDiffDialog();
  selectedRepository.value = null;
  manageOpen.value = false;
  historyReturnOperationId.value = null;
  historyOpen.value = true;
}

function openManage(event?: Event): void {
  const target = event?.currentTarget;
  if (target instanceof HTMLElement) focusReturnOverrides.set('manage', target);
  manageOpen.value = true;
}

function selectRepository(repository: RepositoryStatus): void {
  closeDiffDialog();
  historyOpen.value = false;
  selectedRepository.value = repository;
}

function closeDrawers(): void {
  if (commitBusy.value || branchMerge.value || branchSwitchBusy.value !== null) return;
  closeDiffDialog();
  if (selectedRepository.value && historyReturnOperationId.value) {
    selectedRepository.value = null;
    historyOpen.value = true;
    return;
  }
  selectedRepository.value = null;
  historyOpen.value = false;
  historyReturnOperationId.value = null;
}

function switchWorkspace(workspace: 'repositories' | 'sessions'): void {
  if (activeWorkspace.value === workspace) return;
  closeDrawers();
  shortcutHelpOpen.value = false;
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
  if (repository.state !== 'remote-unknown') return;
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
  historyReturnOperationId.value = operation.id;
  selectRepository(repository);
}

async function retryOperation(operation: OperationRecord): Promise<void> {
  if (!['fetch', 'pull', 'push'].includes(operation.type)) return;
  const type = operation.type as BatchOperationType;
  if (type !== 'fetch') {
    const action = type.toUpperCase();
    const accepted = await requestConfirmation({
      title: `重试安全 ${action}`,
      summary: `将重新执行这条失败或被安全条件阻止的 ${action} 操作。`,
      target: operation.repositoryName,
      details: type === 'pull'
        ? ['仍然只允许 fast-forward，不会创建 merge commit。', '工作区状态不满足条件时会再次安全跳过。']
        : ['执行前会先 Fetch 复核远端状态。', '使用明确 refspec，永远不会 force push。'],
      confirmLabel: `重试 ${action}`,
      tone: 'caution',
    });
    if (!accepted) return;
  }
  operationRetryId.value = operation.id;
  actionError.value = '';
  try {
    const output =
      type === 'fetch'
        ? await api.fetchRepository(operation.repositoryId)
        : type === 'pull'
          ? await api.pullRepository(operation.repositoryId)
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
    const action = batch.type.toUpperCase();
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
    actionMessage.value = `批量 ${batch.type.toUpperCase()} 未完成项已重新入队，共 ${nextBatch.total} 个仓库`;
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

function handleGlobalShortcut(event: KeyboardEvent): void {
  if (trapDialogFocus(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (confirmation.value) settleConfirmation(false);
    else if (branchMerge.value) closeBranchMerge();
    else if (upstreamRepair.value) closeUpstreamRepair();
    else if (shortcutHelpOpen.value) shortcutHelpOpen.value = false;
    else if (repositoryEdit.value) void closeRepositoryEditor();
    else if (scanRootMenuOpen.value) closeScanRootMenu(true);
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

async function maybeRunAutomaticFetch(): Promise<void> {
  const interval = configuredAutoFetchInterval.value;
  if (
    interval === 0 ||
    repositories.value.length === 0 ||
    !navigator.onLine ||
    operationsQuery.isLoading.value ||
    batchStarting.value !== null ||
    activeBatch.value?.state === 'running'
  ) return;

  await withAutoFetchLock(async () => {
    const now = Date.now();
    if (!isAutoFetchDue(interval, readLastAutoFetchAt(), now)) return;
    rememberAutoFetchAt(now);
    batchStarting.value = 'fetch';
    try {
      const { batch } = await api.startBatch('fetch', repositories.value.map((repository) => repository.config.id));
      activeBatchId.value = batch.id;
      actionMessage.value = `自动 Fetch 已加入队列，共 ${batch.total} 个仓库`;
      await operationsQuery.refetch();
    } catch (error) {
      if (error instanceof Error && error.message.includes('相同仓库集合的 Git 批次已有实例正在执行')) {
        actionMessage.value = '自动 Fetch 已由其他 Moo Fleet 实例执行';
      } else {
        forgetAutoFetchAt(now);
        actionError.value = error instanceof Error ? `自动 Fetch 启动失败：${error.message}` : '自动 Fetch 启动失败';
      }
    } finally {
      batchStarting.value = null;
    }
  });
}

function handleWindowFocus(): void {
  void maybeRunAutomaticFetch();
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
  [configuredAutoFetchInterval, () => repositories.value.length, () => operationsQuery.data.value?.batches],
  () => void maybeRunAutomaticFetch(),
  { flush: 'post' },
);

onMounted(() => {
  connectOperationsStream();
  autoFetchTimer = window.setInterval(() => void maybeRunAutomaticFetch(), 60_000);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('online', maybeRunAutomaticFetch);
  window.addEventListener('keydown', handleGlobalShortcut);
  document.addEventListener('pointerdown', handleBranchMenuPointerDown, true);
  document.addEventListener('pointerdown', handleScanRootMenuPointerDown, true);
  document.addEventListener('scroll', handleDocumentScroll, true);
});
onBeforeUnmount(() => {
  if (confirmation.value) settleConfirmation(false);
  upstreamRepairRequest += 1;
  upstreamRepair.value = null;
  disconnectOperationsStream();
  if (autoFetchTimer !== null) window.clearInterval(autoFetchTimer);
  autoFetchTimer = null;
  if (globalToastTimer !== null) window.clearTimeout(globalToastTimer);
  globalToastTimer = null;
  if (scrollbarVisibilityTimer !== null) window.clearTimeout(scrollbarVisibilityTimer);
  scrollbarVisibilityTimer = null;
  document.documentElement.classList.remove('is-scrolling');
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('online', maybeRunAutomaticFetch);
  window.removeEventListener('keydown', handleGlobalShortcut);
  document.removeEventListener('pointerdown', handleBranchMenuPointerDown, true);
  document.removeEventListener('pointerdown', handleScanRootMenuPointerDown, true);
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

watch(manageOpen, (open) => {
  if (open) void loadDeepSeekKey();
  else {
    closeScanRootMenu();
    // 配置弹窗已经原位展示操作结果，关闭后不再把同一条反馈
    // 重新呈现为带倒计时的全局提示。
    dismissGlobalToast();
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
    closeScanRootMenu();
    const rootName = rootNameFromPath(result.canonicalPath);
    actionMessage.value = result.created
      ? `目录 ${rootName} 已添加，可以开始扫描`
      : `目录 ${rootName} 已配置，可以直接扫描`;
    await query.refetch();
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
    if (result.path) rootForm.path = result.path;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '选择目录失败';
  } finally {
    directoryPicking.value = false;
  }
}

function closeScanRootMenu(restoreFocus = false): void {
  if (!scanRootMenuOpen.value) return;
  scanRootMenuOpen.value = false;
  if (restoreFocus) requestAnimationFrame(() => scanRootTrigger.value?.focus({ preventScroll: true }));
}

function handleScanRootMenuPointerDown(event: PointerEvent): void {
  if (!scanRootMenuOpen.value) return;
  if (event.target instanceof Node && !scanRootMenuRoot.value?.contains(event.target)) closeScanRootMenu();
}

function handleScanRootMenuFocusOut(event: FocusEvent): void {
  if (!scanRootMenuOpen.value) return;
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && scanRootMenuRoot.value?.contains(nextTarget)) return;
  closeScanRootMenu();
}

async function toggleScanRootMenu(): Promise<void> {
  if (Object.keys(query.data.value?.roots ?? {}).length === 0) return;
  if (scanRootMenuOpen.value) {
    closeScanRootMenu();
    return;
  }
  scanRootMenuOpen.value = true;
  await nextTick();
  const currentOption = scanRootMenuRoot.value?.querySelector<HTMLButtonElement>('[data-current="true"]');
  currentOption?.focus({ preventScroll: true });
}

function selectScanRoot(rootId: string): void {
  if (scanRootId.value !== rootId) scanCandidates.value = [];
  scanRootId.value = rootId;
  closeScanRootMenu(true);
}

function moveScanRootOption(event: KeyboardEvent, offset: number): void {
  const options = Array.from(scanRootMenuRoot.value?.querySelectorAll<HTMLButtonElement>('.scan-root-option') ?? []);
  const currentIndex = options.findIndex((option) => option === event.currentTarget);
  if (currentIndex < 0 || options.length === 0) return;
  options[(currentIndex + offset + options.length) % options.length]?.focus({ preventScroll: true });
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
    closeScanRootMenu();
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
      actionMessage.value = '⚠ 未清理任何仓库：目标目录已重新出现';
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
    actionMessage.value = `⚠ ${availability.detail}`;
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
      details: type === 'pull'
        ? [
            '只处理可以直接更新的仓库，不会自动合并代码。',
            ...(skippedEstimate > 0 ? [`其余 ${skippedEstimate} 个不符合条件的仓库会自动跳过。`] : []),
          ]
        : [
            '推送前会重新检查远端，不会强制覆盖。',
            ...(skippedEstimate > 0
              ? [`其余 ${skippedEstimate} 个不符合条件的仓库会自动跳过。`]
              : []),
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
    actionMessage.value = `${scopeLabel} · 已开始 ${type.toUpperCase()}，${availability.eligible} 个仓库将执行${batch.total > availability.eligible ? `，其余 ${batch.total - availability.eligible} 个自动跳过` : ''}`;
    await operationsQuery.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量操作启动失败';
  } finally {
    batchStarting.value = null;
  }
}

async function runRepositoryAction(action: 'fetch' | 'pull' | 'push'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || workspaceRefreshing.value) return;
  const contextVersion = repositoryContextVersion;
  if (action !== 'fetch') {
    const actionLabel = action === 'pull' ? 'Pull' : 'Push';
    const accepted = await requestConfirmation({
      title: `确认 ${actionLabel}`,
      summary: action === 'pull'
        ? `将把远端更新拉取到 ${repository.config.name}。`
        : `将把 ${repository.config.name} 的本地新提交推送到远端。`,
      target: `${repository.config.name} · ${repository.branch || 'DETACHED'}`,
      details: action === 'pull'
        ? ['无法直接更新时会停止，不会自动合并代码。']
        : ['推送前会检查远端；发现新变化时会停止，不会强制覆盖。'],
      confirmLabel: `确认 ${actionLabel}`,
      tone: 'caution',
    });
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
          ? await api.pullRepository(repository.config.id)
          : await api.pushRepository(repository.config.id);
    cacheRepositoryStatus(output.result);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
    await Promise.all([
      query.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion)
        ? Promise.all([loadRepositoryBranches(repository.config.id), loadRepositoryFiles(repository.config.id)])
        : Promise.resolve(),
    ]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      const message = error instanceof Error ? error.message : 'Git 操作失败';
      actionError.value = `${repository.config.name}：${message}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) repositoryAction.value = null;
  }
}

async function loadRepositoryBranches(repositoryId: string): Promise<void> {
  const requestId = ++repositoryBranchesRequest;
  branchesLoading.value = true;
  try {
    const snapshot = await api.repositoryBranches(repositoryId);
    if (requestId === repositoryBranchesRequest && selectedRepository.value?.config.id === repositoryId) {
      branchSnapshot.value = snapshot;
    }
  } catch (error) {
    if (requestId === repositoryBranchesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取本地分支失败';
    }
  } finally {
    if (requestId === repositoryBranchesRequest) branchesLoading.value = false;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
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
      actionError.value = `${repository.config.name}：${message}`;
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
  if (!repository || !snapshot?.currentBranch || workspaceBusy.value || workspaceRefreshing.value || branchesLoading.value || filesLoading.value || composer.reading.value || branchMerge.value) return;
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
async function executeBranchMerge(noFastForward: boolean): Promise<void> {
  const dialog = branchMerge.value;
  if (!dialog || dialog.loading || dialog.error || !dialog.preview || dialog.preview.blocker || dialog.preview.kind === 'up-to-date' || dialog.repositoryId !== selectedRepository.value?.config.id) return;
  await runBranchMutation({
    busyKey: 'merge', execute: id => api.mergeBranch(id, { ...dialog.input, noFastForward }), failureMessage: '合并失败',
    onSuccess: () => { branchMerge.value = null; void nextTick(() => repositoryWorkspace.value?.showCurrentBranch()); },
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
  if (!repository || !snapshot || !branch) return;
  const checkout = branchCreateCheckout.value;
  await runBranchMutation({
    busyKey: `create:${branch}`,
    confirmation: {
      title: checkout ? '新建并切换到该分支' : '新建本地分支',
      summary: '新分支从当前 HEAD 创建；分支名与目标会在服务端再次校验。',
      target: `${repository.config.name} · ${snapshot.currentBranch || 'DETACHED'} → ${branch}`,
      details: checkout
        ? ['要求工作区干净且没有进行中的 Git 操作。', '不会自动 Stash，也不会携带未提交改动。']
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
  if (!repository || !snapshot || !nextBranch || nextBranch === branch.name) return;
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
  if (!repository || !snapshot) return;
  await runBranchMutation({
    busyKey: `delete:${branch.name}`,
    confirmation: {
      title: '删除本地分支',
      summary: '只删除分支引用；未合并到当前 HEAD 或其 upstream 的分支会被拒绝。',
      target: `${repository.config.name} · ${branch.name}`,
      details: ['不会使用强制删除，未合并的提交不会被丢弃。', '当前分支与被其他 Worktree 占用的分支会被拒绝。'],
      confirmLabel: '删除分支',
      tone: 'danger',
    },
    execute: (repositoryId, current) =>
      api.deleteBranch(repositoryId, {
        branch: branch.name,
        expectedBranch: current.currentBranch,
        expectedHead: current.head,
      }),
    failureMessage: '删除分支失败',
  });
}

async function checkoutRepositoryRemoteBranch(branch: RemoteBranch): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot) return;
  await runBranchMutation({
    busyKey: `checkout:${branch.name}`,
    confirmation: {
      title: '检出远端分支',
      summary: '会创建同名本地分支并跟踪所选远端分支；远端 ref 在写入前会再次复核。',
      target: `${repository.config.name} · ${branch.name}`,
      details: ['要求工作区干净且没有进行中的 Git 操作。', '不会覆盖已有本地分支。'],
      confirmLabel: '检出并跟踪',
      tone: 'caution',
    },
    execute: (repositoryId, current) =>
      api.checkoutRemoteBranch(repositoryId, {
        remote: branch.remote,
        branch: branch.branch,
        localBranch: branch.branch,
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
      actionMessage.value = `${repository.config.name}：${file.path} ${label}完成`;
    }
    await query.refetch();
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '解决冲突失败'}`;
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
    actionError.value = `${repository.config.name}：还有 ${repository.conflicted} 个文件未解决冲突，请先全部解决`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      loadRepositoryBranches(repository.config.id),
    ]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      actionError.value = `${repository.config.name}：${
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
  if (!repository || !dialog || workspaceBusy.value || composer.reading.value || workspaceRefreshing.value || filesLoading.value || diffLoading.value || !dialog.diff) return;
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
    actionMessage.value = `${repository.config.name}：${output.result.path} ${
      dialog.kind === 'unstaged' ? '已暂存所选差异块' : '已取消暂存所选差异块'
    }`;

    await query.refetch();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '按块操作失败'}`;
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
      actionMessage.value = `${repository.config.name} 已在 ${target === 'finder' ? 'Finder' : target === 'terminal' ? 'Terminal' : 'VS Code'} 打开`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '打开本地仓库失败';
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) openBusy.value = null;
  }
}

async function loadRepositoryFiles(repositoryId: string): Promise<void> {
  const requestId = ++repositoryFilesRequest;
  filesLoading.value = true;
  try {
    const files = (await api.repositoryFiles(repositoryId)).files;
    if (requestId === repositoryFilesRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryFiles.value = files;
    }
  } catch (error) {
    if (requestId === repositoryFilesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取文件状态失败';
    }
  } finally {
    if (requestId === repositoryFilesRequest) filesLoading.value = false;
  }
}

async function loadRepositoryStashes(repositoryId: string): Promise<void> {
  const requestId = ++repositoryStashesRequest;
  stashesLoading.value = true;
  try {
    const stashes = (await api.repositoryStashes(repositoryId)).stashes;
    if (requestId === repositoryStashesRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryStashes.value = stashes;
    }
  } catch (error) {
    if (requestId === repositoryStashesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取 Stash 失败';
    }
  } finally {
    if (requestId === repositoryStashesRequest) stashesLoading.value = false;
  }
}

async function loadRepositoryTags(repositoryId: string): Promise<void> {
  const requestId = ++repositoryTagsRequest;
  tagsLoading.value = true;
  try {
    const tags = (await api.repositoryTags(repositoryId)).tags;
    if (requestId === repositoryTagsRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryTags.value = tags;
    }
  } catch (error) {
    if (requestId === repositoryTagsRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取 Tag 失败';
    }
  } finally {
    if (requestId === repositoryTagsRequest) tagsLoading.value = false;
  }
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
      tagForm.name = '';
      tagForm.message = '';
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '创建 Tag 失败'}`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '删除 Tag 失败'}`;
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
    details: ['远端已有同名 Tag 时会被拒绝，不会覆盖。', '推送失败不影响本地 Tag。'],
    confirmLabel: '推送 Tag',
    tone: 'caution',
  });
  if (!accepted) return;

  const contextVersion = repositoryContextVersion;
  tagBusy.value = `push:${tag.name}`;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.pushTag(repository.config.id, { name: tag.name, remote: 'origin' });
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '推送 Tag 失败'}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) tagBusy.value = null;
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
  repositoryStashesRequest += 1;
  repositoryFilesRequest += 1;
  stashesLoading.value = false;
  filesLoading.value = false;
  stashBusy.value = 'create';
  actionError.value = '';
  try {
    const output = await api.createStash(repository.config.id, stashMessage.value, stashIncludeUntracked.value);
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      repositoryStashes.value = output.result.stashes;
      stashMessage.value = '';
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
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

async function updateFilesStage(paths: string[], action: 'stage' | 'unstage'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || workspaceBusy.value || composer.reading.value || filesLoading.value || workspaceRefreshing.value || !repository.config.capabilities.stage) return;
  const selectedPaths = new Set(paths);
  const files = repositoryFiles.value.filter((file) => selectedPaths.has(file.path) && !file.conflicted && (action === 'stage' ? file.unstaged : file.staged));
  if (!files.length) return;
  const contextVersion = repositoryContextVersion;
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
      if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
      const batchPaths = new Set(pathsToWrite.slice(offset, offset + 100));
      const batch = repositoryFiles.value.filter((file) => batchPaths.has(file.path) && !file.conflicted && (action === 'stage' ? file.unstaged : file.staged));
      if (batch.length !== batchPaths.size) throw new Error('文件状态已变化，请刷新后重试');
      const output = action === 'stage'
        ? await api.stageFiles(repository.config.id, batch.map((file) => file.id))
        : await api.unstageFiles(repository.config.id, batch.map((file) => file.id));
      if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
        repositoryFiles.value = output.files;
        completed += batch.length;
        actionMessage.value = `${action === 'stage' ? '已暂存' : '已取消暂存'} ${completed} / ${files.length} 个文件`;
      }
    }
    await query.refetch();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${error instanceof Error ? error.message : '文件操作失败'}${completed ? `；已完成 ${completed} / ${files.length} 个文件` : ''}`;
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) fileActionId.value = null;
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
  if (!repository || !action || workspaceBusy.value || composer.reading.value || workspaceRefreshing.value || !repository.config.capabilities.stage) return;
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
    await query.refetch();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '文件清理失败';
      await loadRepositoryFiles(repository.config.id);
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) fileDiscardId.value = null;
  }
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
    ]);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) workspaceRefreshing.value = false;
  }
}

async function submitCommit(): Promise<void> {
  const repository = selectedRepository.value;
  const preview = composer.preview.value;
  const message = composer.message.value;
  if (!repository || !preview || !composer.ready.value || composer.suggesting.value || commitBlocker.value || !message.split('\n')[0]?.trim()) return;
  const contextVersion = repositoryContextVersion;
  commitBusy.value = true;
  actionError.value = '';
  try {
    const output = await api.commit(repository.config.id, message, preview.fingerprint, false);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      composer.clearDraft();
      actionMessage.value = `${repository.config.name}：${output.message}`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion))
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : 'Commit 失败'}`;
  } finally {
    await Promise.allSettled([
      query.refetch(), operationsQuery.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      isCurrentRepositoryContext(repository.config.id, contextVersion) ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
    ]);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) commitBusy.value = false;
  }
}
</script>

<template>
  <div class="app-shell">
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />
    <a class="skip-link" :inert="appBackgroundInert" :href="activeWorkspace === 'sessions' ? '#session-list' : '#repository-list'" @click.prevent="focusActiveList">{{ activeWorkspace === 'sessions' ? '跳到会话列表' : '跳到仓库列表' }}</a>

    <header class="topbar" :inert="appBackgroundInert">
      <div class="brand-lockup">
        <div class="brand-copy">
          <img class="brand-logo" src="/logo_2.svg" alt="Moo Fleet" />
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
          <button :class="{ active: activeWorkspace === 'repositories' }" :aria-current="activeWorkspace === 'repositories' ? 'page' : undefined" @click="switchWorkspace('repositories')"><FolderGit2 :size="14" />仓库舰队</button>
          <button :class="{ active: activeWorkspace === 'sessions' }" :aria-current="activeWorkspace === 'sessions' ? 'page' : undefined" @click="switchWorkspace('sessions')"><MessagesSquare :size="14" />AI 会话</button>
        </nav>
      </div>

      <div class="topbar-actions">
        <div class="local-signal" :data-state="query.error.value ? 'error' : query.isFetching.value ? 'busy' : 'ready'" aria-live="polite">
          <span class="signal-dot" />
          {{ query.error.value ? 'LOCAL API / ERROR' : query.isFetching.value ? 'LOCAL API / SCANNING' : 'LOCAL API / READY' }}
        </div>
        <button
          v-if="activeWorkspace === 'repositories'"
          class="secondary-button topbar-history"
          :class="{ 'topbar-history--running': activeBatch?.state === 'running' }"
          :title="activeBatch?.state === 'running' ? batchSignalAriaLabel(activeBatch) : '操作记录'"
          :aria-label="activeBatch?.state === 'running' ? batchSignalAriaLabel(activeBatch) : '打开操作记录'"
          aria-live="polite"
          data-focus-return="history"
          @click="openHistory"
        >
          <LoaderCircle v-if="activeBatch?.state === 'running'" :size="16" class="spinning" /><History v-else :size="16" />
          <span class="topbar-history-label">操作记录</span>
          <span v-if="activeBatch?.state === 'running'" class="topbar-history-progress" aria-hidden="true">{{ activeBatch.type.toUpperCase() }} {{ activeBatch.completed }}/{{ activeBatch.total }}</span>
        </button>
        <button v-if="activeWorkspace === 'repositories'" class="icon-button topbar-shortcuts" title="快捷键帮助" aria-label="快捷键帮助" data-focus-return="shortcuts" @click="shortcutHelpOpen = true"><Keyboard :size="18" /></button>
        <button
          class="primary-button topbar-refresh"
          :title="activeWorkspace === 'sessions' ? (sessionWaitingCount > 0 ? `同步 ${sessionWaitingCount} 条待备份会话` : '同步全部 Claude 和 Codex 会话') : '刷新仓库状态'"
          :aria-label="activeWorkspace === 'sessions' ? (sessionWaitingCount > 0 ? `同步 ${sessionWaitingCount} 条待备份会话` : '同步全部 Claude 和 Codex 会话') : '刷新仓库状态'"
          :aria-busy="activeWorkspace === 'sessions' ? sessionSyncBusy : dashboardRefreshBusy || query.isFetching.value"
          :disabled="activeWorkspace === 'sessions' ? sessionSyncBusy : dashboardRefreshBusy || query.isFetching.value"
          :aria-disabled="activeWorkspace === 'sessions' ? sessionSyncBusy : dashboardRefreshBusy || query.isFetching.value"
          @click="refreshActiveWorkspace"
        >
          <LoaderCircle v-if="activeWorkspace === 'sessions' && sessionSyncBusy" :size="16" class="spinning" />
          <Cloud v-else-if="activeWorkspace === 'sessions'" :size="16" />
          <RefreshCw v-else :size="16" :class="{ spinning: dashboardRefreshBusy || query.isFetching.value }" />
          <span>{{ activeWorkspace === 'sessions' ? (sessionWaitingCount > 0 ? `同步 ${sessionWaitingCount} 条` : '同步会话') : '刷新状态' }}</span>
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
          <div><strong>{{ summary.total }}</strong><span>仓库总数</span></div>
        </button>
        <button class="summary-block summary-attention" :class="{ active: stateFilter === 'today' }" :aria-pressed="stateFilter === 'today'" :tabindex="summaryRovingIndex === 1 ? 0 : -1" @focus="summaryRovingIndex = 1" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('today')">
          <span class="summary-icon"><ListTodo :size="17" /></span>
          <div><strong>{{ summary.today }}</strong><span>今日待处理</span></div>
        </button>
        <button class="summary-block summary-dirty" :class="{ active: stateFilter === 'dirty' }" :aria-pressed="stateFilter === 'dirty'" :tabindex="summaryRovingIndex === 2 ? 0 : -1" @focus="summaryRovingIndex = 2" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('dirty')">
          <span class="summary-icon"><CircleDot :size="17" /></span>
          <div><strong>{{ summary.dirty }}</strong><span>工作区改动</span></div>
        </button>
        <button class="summary-block summary-ahead" :class="{ active: stateFilter === 'ahead' }" :aria-pressed="stateFilter === 'ahead'" :tabindex="summaryRovingIndex === 3 ? 0 : -1" @focus="summaryRovingIndex = 3" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('ahead')">
          <span class="summary-icon"><ArrowUp :size="17" /></span>
          <div><strong>{{ summary.ahead }}</strong><span>待推送提交</span></div>
        </button>
        <button class="summary-block summary-behind" :class="{ active: stateFilter === 'behind' }" :aria-pressed="stateFilter === 'behind'" :tabindex="summaryRovingIndex === 4 ? 0 : -1" @focus="summaryRovingIndex = 4" @keydown="moveRovingFocus($event, '.summary-block')" @click="filterFromSummary('behind')">
          <span class="summary-icon"><ArrowDown :size="17" /></span>
          <div><strong>{{ summary.behind }}</strong><span>待拉取提交</span></div>
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
              :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchAvailability.fetch.total === 0"
              :aria-disabled="batchAvailability.fetch.eligible === 0"
              :aria-label="`Fetch，当前预计可执行 ${batchAvailability.fetch.eligible} 个仓库。${batchAvailability.fetch.detail}`"
              :title="batchAvailability.fetch.detail"
              @click="runBatch('fetch')"
            >
              <LoaderCircle v-if="batchStarting === 'fetch'" :size="14" class="spinning" /><RefreshCw v-else :size="14" />Fetch <span class="batch-action-count">{{ batchAvailability.fetch.eligible }}</span>
            </button>
            <button
              class="compact-button batch-action-button"
              :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchAvailability.pull.total === 0"
              :aria-disabled="batchAvailability.pull.eligible === 0"
              :aria-label="`安全 Pull，当前预计可执行 ${batchAvailability.pull.eligible} 个仓库。${batchAvailability.pull.detail}`"
              :title="batchAvailability.pull.detail"
              @click="runBatch('pull')"
            >
              <LoaderCircle v-if="batchStarting === 'pull'" :size="14" class="spinning" /><ArrowDown v-else :size="14" />安全 Pull <span class="batch-action-count">{{ batchAvailability.pull.eligible }}</span>
            </button>
            <button
              class="compact-button batch-action-button"
              :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchAvailability.push.total === 0"
              :aria-disabled="batchAvailability.push.eligible === 0"
              :aria-label="`安全 Push，当前预计可执行 ${batchAvailability.push.eligible} 个仓库。${batchAvailability.push.detail}`"
              :title="batchAvailability.push.detail"
              @click="runBatch('push')"
            >
              <LoaderCircle v-if="batchStarting === 'push'" :size="14" class="spinning" /><ArrowUp v-else :size="14" />安全 Push <span class="batch-action-count">{{ batchAvailability.push.eligible }}</span>
            </button>
            <span v-if="selectedRepositoryIds.length > 0" class="batch-selection-count" role="status" aria-live="polite">
              已勾选 <strong>{{ selectedRepositoryIds.length }}</strong> 个仓库
            </span>
          </div>
        </div>

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
          <button class="primary-button" data-focus-return="manage" @click="openManage"><Plus :size="16" />添加仓库</button>
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
                @click="selectRepository(repository)"
                @keydown.enter.self="selectRepository(repository)"
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
                  <div class="cell-muted" :title="repository.upstream || undefined">{{ repository.upstream || '未设置 upstream' }}</div>
                </td>
                <td data-label="工作区">
                  <div class="change-counts">
                    <span v-if="repository.staged" class="count staged">S {{ repository.staged }}</span>
                    <span v-if="repository.modified" class="count modified">M {{ repository.modified }}</span>
                    <span v-if="repository.untracked" class="count untracked">U {{ repository.untracked }}</span>
                    <span v-if="repository.conflicted" class="count conflict">C {{ repository.conflicted }}</span>
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
          :repository="selectedRepository" :files="repositoryFiles" :files-loading="filesLoading"
          :stashes="repositoryStashes" :tags="repositoryTags" :stashes-loading="stashesLoading" :tags-loading="tagsLoading"
          :branches="branchSnapshot" :branches-loading="branchesLoading" :branch-blocker="localBranchSwitchBlocker"
          :busy="workspaceBusy || workspaceRefreshing || composer.reading.value" :commit-busy="commitBusy" :refreshing="workspaceRefreshing"
          @merge-branch="openBranchMerge"
          @delete-branch="deleteRepositoryBranch"
          @resolve-conflict="resolveRepositoryConflict"
          :diff="diffDialog" :presentation="diffPresentation" :diff-loading="diffLoading" :diff-error="diffError"
          :hunk-action-label="diffHunkActionLabel" :pending-hunk="hunkActionBusy" :message="actionMessage" :error="actionError"
          @refresh-stashes="loadRepositoryStashes(selectedRepository.config.id)" @refresh-tags="loadRepositoryTags(selectedRepository.config.id)"
          @select="showFileDiff" @stage="updateFilesStage" @switch-branch="switchRepositoryBranch"
          @switch-kind="switchDiffKind" @hunk="applyDiffHunks" @refresh="refreshRepositoryWorkspace" @clear-diff="closeDiffDialog" @dismiss-feedback="dismissGlobalToast"
        >
          <template #commit>
            <CommitComposer ref="commitComposer" :message="composer.message.value" :preview="composer.preview.value" :loading="composer.loading.value" :error="composer.error.value || composer.suggestionError.value" :ready="composer.ready.value" :busy="commitBusy" :suggesting="composer.suggesting.value" :suggestion="composer.suggestion.value" :needs-review="composer.needsReview.value" :blocker="commitBlocker" :staged-count="repositoryFiles.filter(file => file.staged && !file.conflicted).length" @update:message="composer.updateMessage" @generate="composer.generate" @refresh="composer.refresh" @submit="submitCommit" />
          </template>
          <template #header>
            <div class="drawer-header">
              <button class="compact-button workspace-back-button" :title="`${historyReturnOperationId ? '返回操作记录' : '返回仓库列表'} · Esc`" :aria-label="historyReturnOperationId ? '返回操作记录' : '返回仓库列表'" :disabled="commitBusy || branchSwitchBusy !== null" @click="closeDrawers"><ArrowLeft :size="16" />返回</button>
              <div class="drawer-title-block">
                <div class="drawer-title-line">
                  <button class="title-pin-button" :class="{ active: selectedRepository.config.pinned }" :aria-label="selectedRepository.config.pinned ? '取消置顶仓库' : '置顶仓库'" :aria-pressed="selectedRepository.config.pinned" :title="selectedRepository.config.pinned ? '取消置顶' : '置顶仓库'" :disabled="pinBusyId !== null" @click="togglePinned(selectedRepository)"><LoaderCircle v-if="pinBusyId === selectedRepository.config.id" :size="14" class="spinning" /><Pin v-else :size="15" /></button>
                  <SelectMenu v-model="selectedProjectModel" class="select-menu--project" :options="projectSwitchOptions" :disabled="projectSwitchBlocked" aria-label="快速切换项目" data-dialog-initial searchable search-placeholder="搜索项目名称或路径" :title="projectSwitchBlocked ? '等待当前操作完成后切换项目' : `切换项目 · ${selectedRepository.absolutePath}`">
                    <template #trigger-label><span :id="`repo-drawer-title-${selectedRepository.config.id}`" role="heading" aria-level="2">{{ selectedRepository.config.name }}</span></template>
                  </SelectMenu>
                </div>
              </div>
              <div class="workspace-header-actions">
            <div class="git-action-grid">
              <button
                class="secondary-button git-action-button git-action-fetch"
                :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.fetch"
                @click="runRepositoryAction('fetch')"
              ><LoaderCircle v-if="repositoryAction === 'fetch'" :size="16" class="spinning" /><RefreshCw v-else :size="16" />Fetch</button>
              <button
                class="secondary-button git-action-button git-action-pull"
                :disabled="workspaceBusy || workspaceRefreshing || !pullAvailability.available"
                :title="pullAvailability.detail"
                @click="runRepositoryAction('pull')"
              ><LoaderCircle v-if="repositoryAction === 'pull'" :size="16" class="spinning" /><ArrowDown v-else :size="16" />安全 Pull<span class="git-action-count" :title="`落后远端 ${selectedRepository.behind ?? 0} 个提交`">{{ selectedRepository.behind ?? 0 }}</span></button>
              <button
                class="secondary-button git-action-button git-action-push"
                :disabled="workspaceBusy || workspaceRefreshing || !pushAvailability.available"
                :title="pushAvailability.detail"
                @click="runRepositoryAction('push')"
              ><LoaderCircle v-if="repositoryAction === 'push'" :size="16" class="spinning" /><ArrowUp v-else :size="16" />安全 Push<span class="git-action-count" :title="`领先远端 ${selectedRepository.ahead ?? 0} 个提交`">{{ selectedRepository.ahead ?? 0 }}</span></button>
            </div>
                <button class="compact-button workspace-header-refresh" :disabled="workspaceRefreshing || workspaceBusy || composer.reading.value" @click="refreshRepositoryWorkspace"><RefreshCw :size="14" :class="{ spinning: workspaceRefreshing }" />刷新</button>
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
                        <p v-if="branchPanelBlocker" class="branch-panel-blocker" role="status"><AlertTriangle :size="14" /><span><strong>创建或检出暂不可用</strong><span>{{ branchPanelBlocker }}</span></span></p>
                        <div v-if="!branchPanelBlocker" class="branch-create">
                          <input
                            v-model="branchCreateName"
                            aria-label="新分支名称"
                            placeholder="新分支名称，例如 feature/xyz"
                            :disabled="branchSwitchBusy !== null"
                            @keydown.enter="createRepositoryBranch"
                          />
                          <label><input v-model="branchCreateCheckout" type="checkbox" :disabled="branchSwitchBusy !== null" />创建后切换</label>
                          <button class="compact-button" :disabled="branchSwitchBusy !== null || !branchCreateName.trim()" @click="createRepositoryBranch"><Plus :size="13" />新建</button>
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
                                <span class="branch-option-copy"><strong>{{ branch.name }}</strong><small>{{ branch.upstream || '未设置 upstream' }}</small></span>
                                <span v-if="branch.current" class="branch-option-state">CURRENT</span>
                                <span v-else-if="branch.worktreePath" class="branch-option-state occupied">WORKTREE</span>
                                <span v-else class="branch-option-divergence" :aria-label="branchDivergenceLabel(branch)" :title="branchDivergenceLabel(branch)"><ArrowUp :size="11" />{{ branch.ahead ?? '—' }}<ArrowDown :size="11" />{{ branch.behind ?? '—' }}</span>
                              </button>
                              <div v-if="!branch.current && !branch.worktreePath" class="branch-row-actions">
                                <button class="table-icon-button" :title="'重命名 ' + branch.name" :aria-label="'重命名分支 ' + branch.name" :disabled="branchSwitchBusy !== null" @click="startRenameBranch(branch)"><Pencil :size="13" /></button>
                                <button class="table-icon-button branch-row-delete" :title="'删除 ' + branch.name" :aria-label="'删除分支 ' + branch.name" :disabled="branchSwitchBusy !== null" @click="deleteRepositoryBranch(branch)"><Trash2 :size="13" /></button>
                              </div>
          </template>
                      </div>
                    </div>
                    <template v-if="filteredRemoteBranches.length">
            <div class="branch-remote-heading">
              <span>远端分支可检出 <strong>{{ filteredRemoteBranches.length }}</strong></span>
              <span v-if="checkoutableRemoteBranches.length > 50">仅显示前 50 个</span>
            </div>
            <div class="branch-remote-list">
              <div v-for="branch in filteredRemoteBranches" :key="branch.name" class="branch-remote-row">
                <span class="branch-remote-copy"><strong>{{ branch.name }}</strong><small>检出为本地 {{ branch.branch }} 并跟踪</small></span>
                <button class="compact-button" :disabled="branchSwitchBusy !== null || Boolean(branchPanelBlocker)" :title="branchPanelBlocker || '检出 ' + branch.name" @click="checkoutRepositoryRemoteBranch(branch)"><LoaderCircle v-if="branchSwitchBusy === 'checkout:' + branch.name" :size="13" class="spinning" /><ArrowDown v-else :size="13" />检出</button>
              </div>
            </div>
          </template>
                  </section>
                </transition>
              </div>
          </template>
          <template #operation>
            <div v-if="selectedRepository.inProgressOperation" class="drawer-section operation-section" :data-operation="selectedRepository.inProgressOperation">
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
          </template>
          <template #file-actions="{ file }">
            <button
              v-if="fileDiscardAction(file)"
              class="file-action file-discard"
              :class="{ trash: fileDiscardAction(file) === 'trash' }"
              :disabled="workspaceBusy || composer.reading.value || filesLoading || !selectedRepository.config.capabilities.stage"
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
                        class="file-action tag-delete"
                        title="删除本地标签"
                        :aria-label="`删除标签 ${tag.name}`"
                        :disabled="workspaceBusy || workspaceRefreshing || !selectedRepository.config.capabilities.commit"
                        @click="deleteRepositoryTag(tag)"
                      ><LoaderCircle v-if="tagBusy === `delete:${tag.name}`" :size="14" class="spinning" /><Trash2 v-else :size="14" />删除</button>
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
          <button class="icon-button" title="关闭操作记录" aria-label="关闭操作记录" :data-dialog-initial="historyReturnOperationId ? undefined : ''" @click="closeDrawers"><X :size="18" /></button>
        </div>

        <div v-if="activeBatch" class="batch-card" :data-state="activeBatch.state" role="status" aria-live="polite">
          <div class="batch-card-heading">
            <div><span>{{ activeBatch.state === 'running' ? '执行中' : '最近批次' }}</span><strong>{{ activeBatch.type.toUpperCase() }}</strong></div>
            <span>{{ activeBatch.completed }} / {{ activeBatch.total }}</span>
          </div>
          <div
            class="batch-progress"
            role="progressbar"
            :aria-label="`${activeBatch.type.toUpperCase()} 批量任务进度`"
            aria-valuemin="0"
            :aria-valuemax="activeBatch.total"
            :aria-valuenow="activeBatch.completed"
          ><span :style="{ width: `${activeBatch.total ? (activeBatch.completed / activeBatch.total) * 100 : 100}%` }" /></div>
          <div class="batch-counts">
            <span class="success">{{ activeBatch.success }} 成功</span>
            <span class="skipped">{{ activeBatch.skipped }} 跳过</span>
            <span class="failed">{{ activeBatch.failed }} 失败</span>
          </div>
          <div v-if="activeBatch.state === 'completed' && retryableBatchRepositoryIdsList.length" class="batch-card-footer">
            <span>重新入队后仍会执行全部安全预检</span>
            <button
              class="batch-retry-button"
              :aria-label="`重试 ${activeBatch.type.toUpperCase()} 未完成的 ${retryableBatchRepositoryIdsList.length} 个仓库`"
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
                  <div><button class="operation-repository-link" :data-dialog-initial="historyReturnOperationId === item.operation.id ? '' : undefined" @click="openOperationRepository(item.operation)">{{ item.operation.repositoryName }}</button><span>{{ operationTypeLabel(item.operation.type) }}</span></div>
                  <p>{{ item.operation.message }}</p>
                </div>
                <div class="operation-meta">
                  <span>{{ operationStateLabel(item.operation.state) }}</span>
                  <time>{{ item.operation.finishedAt ? relativeTime(item.operation.finishedAt) : item.operation.startedAt ? '执行中' : '等待中' }}</time>
                  <button
                    v-if="isOperationRetryable(item.operation) && ['fetch', 'pull', 'push'].includes(item.operation.type)"
                    class="operation-retry"
                    :title="`安全重试 ${item.operation.repositoryName} 的 ${operationTypeLabel(item.operation.type)}`"
                    :aria-label="`第 ${item.operationIndex + 1} 条操作：安全重试 ${item.operation.repositoryName} 的 ${operationTypeLabel(item.operation.type)}`"
                    :disabled="operationRetryId !== null"
                    @click="retryOperation(item.operation)"
                  ><LoaderCircle v-if="operationRetryId === item.operation.id" :size="12" class="spinning" /><RotateCcw v-else :size="12" />重试</button>
                </div>
              </div>
            </template>
          </template>
        </div>
        <p class="history-note">批量任务最多 {{ query.data.value?.repositories.length || 0 }} 个仓库；单仓失败不会中断其他队列项。</p>
      </aside>
    </transition>

    <transition name="fade">
      <div v-if="shortcutHelpOpen" class="modal-backdrop" @click.self="shortcutHelpOpen = false">
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
      <div v-if="manageOpen" class="modal-backdrop" @click.self="closeManage">
        <section class="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" data-focus-layer tabindex="-1">
          <div class="setup-header">
            <div>
              <h2 id="setup-title">个人配置与仓库接入</h2>
            </div>
            <button class="icon-button" title="关闭管理仓库" aria-label="关闭管理仓库" @click="closeManage"><X :size="18" /></button>
          </div>

          <div class="setup-scroll">
            <div class="setup-grid">
              <section class="setup-card profile-card">
              <div class="card-heading"><UserRound :size="18" /><div><strong>本机个人信息</strong></div></div>
              <label class="form-field"><span>显示名称</span><input v-model="profileForm.displayName" data-dialog-initial /></label>
              <label class="form-field"><span>Commit 语言</span><SelectMenu v-model="commitLanguageModel" :options="commitLanguageOptions" aria-label="Commit 语言" class="select-menu--field" /></label>
              <label class="form-field"><span>AI Commit 模式</span><SelectMenu v-model="aiCommitModeModel" :options="aiCommitModeOptions" aria-label="AI Commit 模式" class="select-menu--field" /></label>
              <label class="form-field">
                <span>DeepSeek API Key · {{ query.data.value?.ai.configured ? '已配置' : '未配置' }}</span>
                <span class="secret-input-control">
                  <input v-model="deepSeekApiKey" :type="deepSeekApiKeyVisible ? 'text' : 'password'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入或粘贴 API Key" @keydown.enter.prevent="saveDeepSeekKey" />
                  <button type="button" :title="deepSeekApiKeyVisible ? '隐藏 Key' : '显示 Key'" :aria-label="deepSeekApiKeyVisible ? '隐藏 DeepSeek API Key' : '显示 DeepSeek API Key'" @click="deepSeekApiKeyVisible = !deepSeekApiKeyVisible"><EyeOff v-if="deepSeekApiKeyVisible" :size="15" /><Eye v-else :size="15" /></button>
                  <button type="button" title="从 macOS 剪贴板粘贴" aria-label="粘贴 DeepSeek API Key" @click="pasteDeepSeekKey"><ClipboardPaste :size="15" /></button>
                </span>
              </label>
              <p v-if="query.data.value?.ai.keyError" class="action-hint ai-key-error" role="status">
                <AlertTriangle :size="14" />{{ query.data.value.ai.keyError }}。重新保存会覆盖该文件；若它已不是普通文件，请先手动删除。
              </p>
              <button class="secondary-button full-width" :disabled="loadingDeepSeekApiKey || savingDeepSeekApiKey || deepSeekApiKey.trim().length < 8" @click="saveDeepSeekKey"><LoaderCircle v-if="loadingDeepSeekApiKey || savingDeepSeekApiKey" :size="16" class="spinning" /><ShieldCheck v-else :size="16" />保存 DeepSeek Key</button>
              <div class="auto-fetch-preference" :data-enabled="profileForm.autoFetchIntervalMinutes !== 0">
                <span class="preference-icon"><RefreshCw :size="16" /></span>
                <div><strong>自动 Fetch</strong><span>{{ autoFetchDescription }}</span></div>
                <SelectMenu v-model="autoFetchIntervalModel" :options="autoFetchIntervalOptions" aria-label="自动 Fetch 周期" class="select-menu--compact" />
              </div>
              <div class="theme-preview"><span class="theme-orb"><Sparkles :size="15" /></span><div><strong>Moon / One Dark Pro</strong><span>默认本地工程主题</span></div><Check :size="17" /></div>
              <section class="appearance-preference" aria-labelledby="appearance-title">
                <div class="appearance-heading"><strong id="appearance-title">界面显示</strong><button type="button" @click="interfaceFont = 'system'; interfaceFontSize = 14">恢复默认</button></div>
                <label class="form-field"><span>界面字体</span><SelectMenu v-model="interfaceFontModel" :options="interfaceFontOptions" aria-label="界面字体" class="select-menu--field" /></label>
                <label class="form-field"><span>界面字号</span><SelectMenu v-model="interfaceFontSizeModel" :options="interfaceFontSizeOptions" aria-label="界面字号" class="select-menu--field" /></label>
                <p class="appearance-sample">清晰阅读，从容操作 <span>Moo Fleet · Aa 0123</span></p>
                <small>自动保存到本机。代码保持等宽；未安装的字体使用系统替代。</small>
              </section>
              <button class="secondary-button full-width" :disabled="savingProfile" @click="saveProfile"><LoaderCircle v-if="savingProfile" :size="16" class="spinning" /><Check v-else :size="16" />保存个人配置</button>
              </section>

              <section class="setup-card repositories-card">
              <div class="card-heading"><Code2 :size="18" /><div><strong>添加本地仓库</strong></div></div>
              <div class="repository-step-heading"><span>01</span><strong>配置扫描根目录</strong><small>选择电脑中的项目上级目录</small></div>
              <div class="root-manager">
                <div class="root-list">
                  <div v-for="(rootPath, rootId) in query.data.value?.roots" :key="rootId" class="root-row">
                    <span :title="String(rootPath)">{{ rootNameFromPath(String(rootPath)) }}</span><code>{{ rootPath }}</code><small>{{ rootUsageCount(String(rootId)) }} 仓库</small>
                    <button
                      class="table-icon-button"
                      :title="rootUsageCount(String(rootId)) > 0 ? `已有 ${rootUsageCount(String(rootId))} 个仓库引用，先移出仓库后才能移除目录` : '移除根目录'"
                      :aria-label="`移除目录 ${rootNameFromPath(String(rootPath))}`"
                      :aria-describedby="rootUsageCount(String(rootId)) > 0 ? `root-remove-reason-${String(rootId)}` : undefined"
                      :aria-disabled="rootUsageCount(String(rootId)) > 0 || rootBusy !== null"
                      :disabled="rootBusy !== null"
                      @click="requestRemoveRoot(String(rootId), String(rootPath))"
                    ><LoaderCircle v-if="rootBusy === rootId" :size="13" class="spinning" /><Trash2 v-else :size="13" /></button>
                    <p v-if="rootUsageCount(String(rootId)) > 0" :id="`root-remove-reason-${String(rootId)}`" class="root-remove-reason">
                      已有 {{ rootUsageCount(String(rootId)) }} 个仓库引用，先移出仓库后才能移除目录
                    </p>
                  </div>
                </div>
                <div class="root-add-row">
                  <div class="root-path-control">
                    <input v-model="rootForm.path" aria-label="根目录绝对路径" placeholder="选择项目所在的上级目录" @keydown.enter="addRoot" />
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
              <div class="repository-step-heading"><span>02</span><strong>扫描并接入仓库</strong><small>扫描后按需加入工作台</small></div>
              <div class="scan-toolbar">
                <div ref="scanRootMenuRoot" class="scan-root-select" @focusout="handleScanRootMenuFocusOut">
                  <button
                    ref="scanRootTrigger"
                    type="button"
                    class="scan-root-trigger"
                    :class="{ active: scanRootMenuOpen }"
                    :aria-expanded="scanRootMenuOpen"
                    aria-haspopup="listbox"
                    aria-controls="scan-root-options"
                    :disabled="Object.keys(query.data.value?.roots ?? {}).length === 0"
                    @click="toggleScanRootMenu"
                  >
                    <span class="scan-root-trigger-icon"><FolderGit2 :size="17" /></span>
                    <span class="scan-root-trigger-copy">
                      <strong>{{ selectedScanRootPath ? rootNameFromPath(selectedScanRootPath) : '尚未添加目录' }}</strong>
                      <small>{{ selectedScanRootPath || '先在上方选择一个项目目录' }}</small>
                    </span>
                    <ChevronDown :size="16" />
                  </button>
                  <transition name="branch-popover">
                    <div v-if="scanRootMenuOpen" id="scan-root-options" class="scan-root-options" role="listbox" aria-label="选择扫描目录">
                      <button
                        v-for="(rootPath, rootId) in query.data.value?.roots"
                        :key="rootId"
                        type="button"
                        class="scan-root-option"
                        :class="{ current: scanRootId === String(rootId) }"
                        :data-current="scanRootId === String(rootId)"
                        role="option"
                        :aria-selected="scanRootId === String(rootId)"
                        @click="selectScanRoot(String(rootId))"
                        @keydown.down.prevent="moveScanRootOption($event, 1)"
                        @keydown.up.prevent="moveScanRootOption($event, -1)"
                        @keydown.esc.stop.prevent="closeScanRootMenu(true)"
                      >
                        <span class="scan-root-option-icon"><Check v-if="scanRootId === String(rootId)" :size="15" /><FolderOpen v-else :size="15" /></span>
                        <span><strong>{{ rootNameFromPath(String(rootPath)) }}</strong><small>{{ rootPath }}</small></span>
                        <span v-if="scanRootId === String(rootId)" class="scan-root-current">当前</span>
                      </button>
                    </div>
                  </transition>
                </div>
                <button class="primary-button" :disabled="scanning || !scanRootId" @click="scanRepositories"><LoaderCircle v-if="scanning" :size="16" class="spinning" /><Search v-else :size="16" />扫描</button>
              </div>
              <div class="candidate-list">
                <div v-if="!scanCandidates.length" class="candidate-empty"><FolderGit2 :size="24" /><strong>等待目录扫描</strong><span>发现 Git 仓库后，可逐个加入工作台</span></div>
                <div v-for="candidate in scanCandidates" :key="candidate.absolutePath" class="candidate-row">
                  <div class="candidate-icon"><GitBranch :size="16" /></div>
                  <div class="candidate-info"><strong>{{ candidate.name }}<em v-if="candidate.sessionBackup" title="这是 Moo Fleet 的会话备份仓，由「AI 会话」页自动管理；加进工作台会被当成普通代码仓库">会话备份仓</em></strong><span>{{ candidate.relativePath }} · {{ candidate.branch || 'DETACHED' }}</span></div>
                  <span v-if="candidate.alreadyAdded" class="added-label"><Check :size="14" />已添加</span>
                  <button v-else class="compact-button" :disabled="addingPath === candidate.absolutePath" @click="addRepository(candidate)"><LoaderCircle v-if="addingPath === candidate.absolutePath" :size="14" class="spinning" /><Plus v-else :size="14" />加入</button>
                </div>
              </div>
              </section>
            </div>

            <div v-if="actionError || actionMessage" class="setup-feedback" :class="{ error: actionError }" :role="actionError ? 'alert' : 'status'" :aria-live="actionError ? 'assertive' : 'polite'">
              <AlertTriangle v-if="actionError" :size="16" /><Check v-else :size="16" />{{ actionError || actionMessage }}
            </div>
          </div>
          <div class="setup-footer">
            <div class="setup-footer-note">
              <span v-if="hasUnsavedProfileChanges" class="setup-unsaved"><CircleDot :size="14" />个人配置有未保存更改</span>
              <span><ShieldCheck :size="14" />配置仅保存在本机 config/，不会上传个人路径；把仓库移出工作台不会删除代码</span>
            </div>
            <button class="primary-button" :disabled="repositories.length === 0" @click="closeManage">进入工作台<ChevronRight :size="16" /></button>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="repositoryEdit" class="modal-backdrop" @click.self="closeRepositoryEditor">
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
          </div>
          <div class="repository-config-footer">
            <button class="secondary-button" @click="closeRepositoryEditor">取消</button>
            <button class="primary-button" :disabled="repositoryEditBusy || !repositoryEdit.name.trim() || !repositoryEdit.group.trim()" @click="saveRepositoryEditor"><LoaderCircle v-if="repositoryEditBusy" :size="16" class="spinning" /><Check v-else :size="16" />保存配置</button>
          </div>
        </section>
      </div>
    </transition>


    <BranchMergeDialog v-if="branchMerge" :input="branchMerge.input" :preview="branchMerge.preview" :loading="branchMerge.loading" :busy="branchSwitchBusy === 'merge'" :error="branchMerge.error" @close="closeBranchMerge" @merge="executeBranchMerge" />

    <transition name="confirm">
      <div v-if="upstreamRepair" class="modal-backdrop upstream-repair-backdrop" @click.self="closeUpstreamRepair">
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
      <div v-if="confirmation" class="modal-backdrop confirmation-backdrop" @click.self="settleConfirmation(false)">
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
            <ul id="confirmation-details" class="confirmation-details">
              <li v-for="detail in confirmation.details" :key="detail"><Check :size="13" />{{ detail }}</li>
            </ul>
          </div>
          <div class="confirmation-footer">
            <div>
              <button class="secondary-button" data-dialog-initial @click="settleConfirmation(false)">取消</button>
              <button class="confirmation-confirm" @click="settleConfirmation(true)">
                <Trash2 v-if="confirmation.tone === 'danger'" :size="15" />
                <Check v-else :size="15" />
                {{ confirmation.confirmLabel }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </transition>

    <transition name="toast">
      <div
        v-if="(actionMessage || actionError) && !manageOpen && (!selectedRepository || activeFocusLayers.length > 1)"
        :key="`${globalToast.tone}:${globalToast.text}`"
        class="global-toast"
        :class="globalToast.tone"
        :style="{ '--toast-duration': `${globalToast.duration}ms` }"
        :role="globalToast.tone === 'error' ? 'alert' : 'status'"
        :aria-live="globalToast.tone === 'error' ? 'assertive' : 'polite'"
      >
        <AlertTriangle v-if="globalToast.tone !== 'success'" :size="16" /><Check v-else :size="16" />
        <span>{{ globalToast.text }}</span>
        <button aria-label="关闭提示" @click="dismissGlobalToast"><X :size="14" /></button>
        <i class="toast-progress" aria-hidden="true" />
      </div>
    </transition>
  </div>
</template>
