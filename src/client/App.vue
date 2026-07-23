<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardPaste,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  History,
  Keyboard,
  Link2,
  LoaderCircle,
  Minus,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
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
  CommitPreview,
  CommitSuggestion,
  FileChange,
  OperationRecord,
  OperationState,
  OperationType,
  OperationsPayload,
  ProfileConfig,
  ProfileViewPreferences,
  RepositoryCommit,
  RepositoryFilterMode,
  RepositoryCapabilities,
  RepositoryState,
  RepositoryStatus,
  ScanCandidate,
  StashEntry,
  UpstreamCandidate,
  UpstreamRepairPlan,
  UpstreamRepairRequest,
} from '../shared/contracts';
import { compareRepositoryActivity, compareRepositoryLastCommit, compareRepositoryPinning } from '../shared/repository-pinning';
import { api } from './api';
import { autoFetchIntervalLabel, autoFetchIntervals, isAutoFetchDue, latestFetchBatchAt, parseLastAutoFetchAt } from './auto-fetch';
import { batchRetryConfirmationDetails, batchSignalAriaLabel, retryableBatchRepositoryIds } from './batch-retry';
import { branchDivergenceLabel } from './branch-presentation';
import { presentGitDiff } from './diff-presentation';
import { remoteLinks } from './remote-links';
import { createUniqueRootId, rootNameFromPath } from './root-identity';
import { cdCommand } from './shell-command';
import {
  hasWorktreeChanges,
  isRemoteStale,
  matchesRepositoryStateFilter,
  needsDailyAction,
  repositoryFilterCounts,
} from './repository-signals';
import { defaultViewPreferences, parseViewPreferences } from './view-preferences';

const queryClient = useQueryClient();
const operationsStreamConnected = ref(false);
let operationsEventSource: EventSource | null = null;
let operationsReconnectTimer: number | null = null;
let autoFetchTimer: number | null = null;
let globalToastTimer: number | null = null;
let scrollbarVisibilityTimer: number | null = null;
let repositoryFilesRequest = 0;
let repositoryCommitsRequest = 0;
let repositoryStashesRequest = 0;
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

const operationsQuery = useQuery({
  queryKey: ['operations'],
  queryFn: api.operations,
  refetchInterval: (operationQuery) =>
    operationsStreamConnected.value
      ? false
      : operationQuery.state.data?.batches.some((batch) => batch.state === 'running')
        ? 1_000
        : 10_000,
});

const search = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
const sortMode = ref(cachedViewPreferences.repositorySort);
const stateFilter = ref<RepositoryFilterMode>(cachedViewPreferences.repositoryFilter);
const groupFilter = ref<string | null>(cachedViewPreferences.repositoryGroup);
const operationRepositoryFilter = ref('all');
const operationTypeFilter = ref<'all' | OperationType>('all');
const operationStateFilter = ref<'all' | OperationState>('all');
const operationRetryId = ref<string | null>(null);
const operationRefreshBusy = ref(false);
const dashboardRefreshBusy = ref(false);
const shortcutHelpOpen = ref(false);
const manageOpen = ref(false);
const historyOpen = ref(false);
const historyReturnOperationId = ref<string | null>(null);
const selectedRepository = ref<RepositoryStatus | null>(null);
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
const branchSearch = ref('');
const branchesLoading = ref(false);
const branchSwitchBusy = ref<string | null>(null);
const openBusy = ref<'finder' | 'terminal' | 'vscode' | null>(null);
const batchStarting = ref<BatchOperationType | null>(null);
const batchRetryBusy = ref(false);
const batchScope = ref(cachedViewPreferences.batchScope);
const activeBatchId = ref<string | null>(null);
const repositoryFiles = ref<FileChange[]>([]);
const filesLoading = ref(false);
const repositoryCommits = ref<RepositoryCommit[]>([]);
const commitsLoading = ref(false);
const commitsError = ref('');
const fileActionId = ref<string | null>(null);
const fileDiscardId = ref<string | null>(null);
const fileMutationBusy = computed(() => fileActionId.value !== null || fileDiscardId.value !== null);
const fileCountLoading = computed(() => filesLoading.value && repositoryFiles.value.length === 0);
const repositoryStashes = ref<StashEntry[]>([]);
const stashesLoading = ref(false);
const stashBusy = ref<'create' | string | null>(null);
const stashMessage = ref('');
const stashIncludeUntracked = ref(true);
type DiffKind = 'staged' | 'unstaged';
type DiffDialogState = {
  path: string;
  fileId: string;
  kind: DiffKind;
  diff: string;
  stagedAvailable: boolean;
  unstagedAvailable: boolean;
};
const diffDialog = ref<DiffDialogState | null>(null);
const diffLoading = ref(false);
const diffLoadingFileId = ref<string | null>(null);
const diffPresentation = computed(() => diffDialog.value ? presentGitDiff(diffDialog.value.diff, diffDialog.value.path) : null);
let diffRequest = 0;
const commitOpen = ref(false);
const commitData = ref<CommitPreview | null>(null);
const commitMessage = ref('');
const commitSuggestion = ref<CommitSuggestion | null>(null);
const commitPushAfter = ref(false);
const commitBusy = ref(false);
const suggestBusy = ref(false);
type CommitSubmitMode = 'manual' | 'auto';
const commitSubmitMode = ref<CommitSubmitMode | null>(null);
let commitSuggestionRequest = 0;
let commitSuggestionAbort: AbortController | null = null;
const commitProgressMessage = computed(() => commitSubmitMode.value === 'auto'
  ? '正在生成 Commit 文案并提交，请保持窗口打开。'
  : '正在提交当前 staged 快照，请保持窗口打开。');
type ConfirmationTone = 'info' | 'caution' | 'danger';
type ConfirmationOptions = {
  title: string;
  summary: string;
  target?: string;
  details: string[];
  confirmLabel: string;
  tone?: ConfirmationTone;
};
type ActiveConfirmation = ConfirmationOptions & {
  id: number;
  tone: ConfirmationTone;
  resolve: (accepted: boolean) => void;
};
const confirmation = ref<ActiveConfirmation | null>(null);
let confirmationId = 0;
const actionError = ref('');
const actionMessage = ref('');
const globalToastDuration = computed(() => actionError.value ? 9_000 : actionMessage.value.startsWith('⚠') ? 6_500 : 4_200);

function dismissGlobalToast(): void {
  actionError.value = '';
  actionMessage.value = '';
}

function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
  if (confirmation.value) confirmation.value.resolve(false);
  return new Promise((resolve) => {
    confirmation.value = {
      ...options,
      id: ++confirmationId,
      tone: options.tone ?? 'info',
      resolve,
    };
  });
}

function settleConfirmation(accepted: boolean): void {
  const activeConfirmation = confirmation.value;
  if (!activeConfirmation) return;
  confirmation.value = null;
  activeConfirmation.resolve(accepted);
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
    }, globalToastDuration.value);
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
    batchScope: batchScope.value,
  };
}

watch(
  () => query.data.value,
  (dashboard) => {
    if (!dashboard) return;
    if (!manageOpen.value || !profileHasUnsavedChanges(dashboard.profile.profile)) {
      Object.assign(profileForm, dashboard.profile.profile);
    }
    if (!viewPreferencesHydrated) {
      const preferences = dashboard.profile.profile.viewPreferences;
      persistedViewPreferences = JSON.stringify(preferences);
      sortMode.value = preferences.repositorySort;
      stateFilter.value = preferences.repositoryFilter;
      groupFilter.value = preferences.repositoryGroup;
      batchScope.value = preferences.batchScope;
      viewPreferencesHydrated = true;
    }
    profileForm.viewPreferences = currentViewPreferences();
    if (!scanRootId.value) scanRootId.value = Object.keys(dashboard.roots)[0] ?? '';
    if (dashboard.repositories.length === 0) manageOpen.value = true;
    if (selectedRepository.value) {
      selectedRepository.value =
        dashboard.repositories.find((repository) => repository.config.id === selectedRepository.value?.config.id) ?? null;
    }
  },
  { immediate: true },
);

watch(
  [sortMode, stateFilter, groupFilter, batchScope],
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
    repositoryCommitsRequest += 1;
    repositoryStashesRequest += 1;
    repositoryBranchesRequest += 1;
    repositoryFiles.value = [];
    filesLoading.value = false;
    repositoryCommits.value = [];
    commitsLoading.value = false;
    commitsError.value = '';
    repositoryStashes.value = [];
    stashesLoading.value = false;
    branchPanelOpen.value = false;
    branchSnapshot.value = null;
    branchesLoading.value = false;
    branchSearch.value = '';
    stashMessage.value = '';
    repositoryAction.value = null;
    branchSwitchBusy.value = null;
    openBusy.value = null;
    stashBusy.value = null;
    fileActionId.value = null;
    fileDiscardId.value = null;
    diffLoading.value = false;
    diffLoadingFileId.value = null;
    commitSuggestionRequest += 1;
    commitSuggestionAbort?.abort();
    commitSuggestionAbort = null;
    commitBusy.value = false;
    suggestBusy.value = false;
    commitSubmitMode.value = null;
    if (repositoryId) {
      void loadRepositoryFiles(repositoryId);
      void loadRepositoryCommits(repositoryId);
      void loadRepositoryStashes(repositoryId);
    }
  },
);

function isCurrentRepositoryContext(repositoryId: string, contextVersion: number): boolean {
  return contextVersion === repositoryContextVersion && selectedRepository.value?.config.id === repositoryId;
}

watch(
  () => operationsQuery.data.value?.batches,
  (batches) => {
    if (!activeBatchId.value) return;
    const batch = batches?.find((item) => item.id === activeBatchId.value);
    if (!batch || batch.state !== 'completed') return;
    actionMessage.value = `批量 ${batch.type.toUpperCase()} 完成：${batch.success} 成功，${batch.skipped} 跳过，${batch.failed} 失败`;
    activeBatchId.value = null;
    void query.refetch();
  },
);

const repositories = computed(() => query.data.value?.repositories ?? []);
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
  const keyword = branchSearch.value.trim().toLowerCase();
  const branches = branchSnapshot.value?.branches ?? [];
  return keyword
    ? branches.filter((branch) => [branch.name, branch.upstream ?? ''].join(' ').toLowerCase().includes(keyword))
    : branches;
});
const branchPanelBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return '仓库详情已关闭';
  if (!repository.config.capabilities.stage) return '仓库配置未允许修改工作区';
  if (repository.inProgressOperation) return `正在进行 ${repository.inProgressOperation}`;
  if (hasWorktreeChanges(repository)) return '工作区有改动，请先 Commit、清理或 Stash';
  return null;
});
const relatedWorktrees = computed(() => branchSnapshot.value?.worktrees.filter((worktree) => !worktree.current) ?? []);
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
const filteredRepositories = computed(() => {
  const filtered = repositoryFilterContext.value.filter((repository) =>
    matchesRepositoryStateFilter(repository, stateFilter.value),
  );
  return [...filtered].sort((a, b) => {
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
  });
});
const batchTargetRepositories = computed(() =>
  batchScope.value === 'visible' ? filteredRepositories.value : repositories.value,
);

const summary = computed(() => ({
  total: repositories.value.length,
  today: repositories.value.filter(needsDailyAction).length,
  dirty: repositories.value.filter(hasWorktreeChanges).length,
  ahead: repositories.value.reduce((total, repository) => total + (repository.ahead ?? 0), 0),
  behind: repositories.value.reduce((total, repository) => total + (repository.behind ?? 0), 0),
}));
const filterCounts = computed(() => repositoryFilterCounts(repositoryFilterContext.value));
const hasRepositoryFilters = computed(
  () => search.value.trim().length > 0 || stateFilter.value !== 'all' || groupFilter.value !== null,
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

const filteredOperations = computed(() =>
  (operationsQuery.data.value?.operations ?? []).filter(
    (operation) =>
      (operationRepositoryFilter.value === 'all' || operation.repositoryId === operationRepositoryFilter.value) &&
      (operationTypeFilter.value === 'all' || operation.type === operationTypeFilter.value) &&
      (operationStateFilter.value === 'all' || operation.state === operationStateFilter.value),
  ),
);

const hasOperationFilters = computed(
  () =>
    operationRepositoryFilter.value !== 'all' ||
    operationTypeFilter.value !== 'all' ||
    operationStateFilter.value !== 'all',
);

const retryableBatchRepositoryIdsList = computed(() =>
  retryableBatchRepositoryIds(
    activeBatch.value,
    operationsQuery.data.value?.operations ?? [],
    repositories.value.map((repository) => repository.config.id),
  ),
);

const activeCommitAiPolicy = computed(() => commitSuggestion.value?.aiPolicy ?? commitData.value?.aiPolicy ?? null);
const hasCommitDraft = computed(() =>
  commitMessage.value.trim().length > 0 || commitSuggestion.value !== null || commitPushAfter.value,
);
const pullAvailability = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return { available: false, detail: '请先选择仓库' };
  if (!repository.config.capabilities.pull) return { available: false, detail: '仓库配置未允许 Pull' };
  if (repository.detached) return { available: false, detail: 'Detached HEAD 不能 Pull' };
  if (!repository.upstream) return { available: false, detail: '当前分支没有 upstream' };
  if (repository.conflicted > 0 || repository.inProgressOperation) return { available: false, detail: '存在冲突或进行中的 Git 操作' };
  const worktreeChanges = repository.staged + repository.modified + repository.untracked + repository.deleted + repository.renamed;
  if (worktreeChanges > 0) {
    const parts = [
      repository.staged > 0 ? `${repository.staged} 项已暂存` : '',
      repository.modified > 0 ? `${repository.modified} 项已修改` : '',
      repository.untracked > 0 ? `${repository.untracked} 项未跟踪` : '',
      repository.deleted > 0 ? `${repository.deleted} 项删除` : '',
      repository.renamed > 0 ? `${repository.renamed} 项重命名` : '',
    ].filter(Boolean);
    return { available: false, detail: `工作区有 ${parts.join('、')}，清理或 Stash 后可 Pull` };
  }
  if ((repository.ahead ?? 0) > 0 && (repository.behind ?? 0) > 0) return { available: false, detail: '本地与远端已分叉，不能安全 Pull' };
  if ((repository.ahead ?? 0) > 0) return { available: false, detail: '本地存在领先提交，无需 Pull' };
  return { available: true, detail: '只允许 fast-forward' };
});
const pushAvailability = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return { available: false, detail: '请先选择仓库' };
  if (!repository.config.capabilities.push) return { available: false, detail: '仓库配置未允许 Push' };
  if (repository.detached) return { available: false, detail: 'Detached HEAD 不能 Push' };
  if (!repository.upstream) return { available: false, detail: '当前分支没有 upstream' };
  if (repository.conflicted > 0 || repository.inProgressOperation) return { available: false, detail: '存在冲突或进行中的 Git 操作' };
  if ((repository.behind ?? 0) > 0) return { available: false, detail: '远端存在新提交，请先安全 Pull；分叉状态需手动处理' };
  if ((repository.ahead ?? 0) === 0) return { available: false, detail: '当前没有待推送提交' };
  return { available: true, detail: '执行前先 Fetch 复核远端，永远不会 force push' };
});
const commitPushAvailability = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return { available: false, detail: '请先选择仓库' };
  if (!repository.config.capabilities.push) return { available: false, detail: '仓库配置未允许 Push' };
  if (repository.detached) return { available: false, detail: 'Detached HEAD 不能 Push' };
  if (!repository.upstream) return { available: false, detail: '当前分支没有 upstream' };
  if (repository.conflicted > 0 || repository.inProgressOperation) return { available: false, detail: '存在冲突或进行中的 Git 操作' };
  if ((repository.behind ?? 0) > 0) return { available: false, detail: '当前已落后远端，请先执行安全 Pull' };
  return { available: true, detail: 'Commit 成功后先 Fetch 复核远端，再用明确 refspec Push；永不 force' };
});
watch(
  () => commitPushAvailability.value.available,
  (available) => {
    if (!available) commitPushAfter.value = false;
  },
);
const activeFocusLayers = computed(() => {
  const layers: string[] = [];
  if (selectedRepository.value) layers.push(`repository:${selectedRepository.value.config.id}`);
  else if (historyOpen.value) layers.push('history');
  if (shortcutHelpOpen.value) layers.push('shortcuts');
  if (manageOpen.value) layers.push('manage');
  if (repositoryEdit.value) layers.push(`repository-edit:${repositoryEdit.value.id}`);
  if (diffDialog.value) layers.push(`diff:${diffDialog.value.path}`);
  if (commitOpen.value) layers.push('commit');
  if (upstreamRepair.value) layers.push(`upstream:${upstreamRepair.value.repositoryId}`);
  if (confirmation.value) layers.push(`confirmation:${confirmation.value.id}`);
  return layers;
});
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
    else if (returnTarget?.isConnected) returnTarget.focus();
    else if (fallbackTarget) fallbackTarget.focus();
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
    requestAnimationFrame(focusInitialControl);
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

const statusMeta: Record<RepositoryState, { label: string; tone: string }> = {
  conflict: { label: '冲突', tone: 'red' },
  'operation-in-progress': { label: '操作进行中', tone: 'red' },
  diverged: { label: '已分叉', tone: 'red' },
  dirty: { label: '有改动', tone: 'yellow' },
  ahead: { label: '待推送', tone: 'blue' },
  behind: { label: '待拉取', tone: 'cyan' },
  clean: { label: '已同步', tone: 'green' },
  'remote-unknown': { label: '未设置 upstream', tone: 'muted' },
  missing: { label: '路径缺失', tone: 'muted' },
  invalid: { label: '无效仓库', tone: 'red' },
};

function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || 'GF';
}

function rootUsageCount(rootId: string): number {
  return repositories.value.filter((repository) => repository.config.root === rootId).length;
}

function operationTypeLabel(type: OperationRecord['type']): string {
  if (type === 'commit') return 'COMMIT';
  if (type === 'switch-branch') return '切换分支';
  if (type === 'set-upstream') return '关联 upstream';
  return type.toUpperCase();
}

function operationStateLabel(state: OperationRecord['state']): string {
  return {
    queued: '等待',
    running: '执行中',
    success: '成功',
    skipped: '跳过',
    failed: '失败',
  }[state];
}

function clearOperationFilters(): void {
  operationRepositoryFilter.value = 'all';
  operationTypeFilter.value = 'all';
  operationStateFilter.value = 'all';
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

function closeDiffDialog(): void {
  diffRequest += 1;
  diffLoading.value = false;
  diffLoadingFileId.value = null;
  diffDialog.value = null;
}

function upstreamCandidateReason(candidate: UpstreamCandidate): string {
  return candidate.reason === 'same-name' ? '当前分支同名' : '与当前 HEAD 相同';
}

function upstreamCandidateDivergence(candidate: UpstreamCandidate): string {
  if (candidate.ahead === null || candidate.behind === null) return '提交关系待关联后确认';
  if (candidate.ahead === 0 && candidate.behind === 0) return '提交已对齐';
  return `待推送 ${candidate.ahead} · 待拉取 ${candidate.behind}`;
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
      summary: `将重新执行这条失败或跳过的 ${action} 操作。`,
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
      summary: `将失败或跳过的 ${repositoryIds.length} 个仓库重新组成一个批次。`,
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

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function activeFocusLayer(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-layer]')].at(-1) ?? null;
}

function focusReturnFallback(layer: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-return]')]
    .find((element) => element.dataset.focusReturn === layer) ?? null;
}

function focusableControls(layer: HTMLElement): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], summary, input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => {
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const collapsedDetails = element.closest('details:not([open])');
    return !collapsedDetails || element.tagName === 'SUMMARY';
  });
}

function focusInitialControl(): void {
  const layer = activeFocusLayer();
  if (!layer) return;
  const preferred = layer.querySelector<HTMLElement>('[data-dialog-initial]');
  (preferred ?? focusableControls(layer)[0] ?? layer).focus();
}

function trapDialogFocus(event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false;
  const layer = activeFocusLayer();
  if (!layer) return false;
  const controls = focusableControls(layer);
  if (controls.length === 0) {
    event.preventDefault();
    layer.focus();
    return true;
  }
  const activeIndex = controls.findIndex((control) => control === document.activeElement);
  const nextIndex = event.shiftKey
    ? activeIndex <= 0 ? controls.length - 1 : activeIndex - 1
    : activeIndex < 0 || activeIndex >= controls.length - 1 ? 0 : activeIndex + 1;
  event.preventDefault();
  controls[nextIndex]?.focus();
  return true;
}

function handleGlobalShortcut(event: KeyboardEvent): void {
  if (trapDialogFocus(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (confirmation.value) settleConfirmation(false);
    else if (upstreamRepair.value) closeUpstreamRepair();
    else if (shortcutHelpOpen.value) shortcutHelpOpen.value = false;
    else if (diffDialog.value) closeDiffDialog();
    else if (commitOpen.value) void closeCommitDialog();
    else if (repositoryEdit.value) void closeRepositoryEditor();
    else if (scanRootMenuOpen.value) closeScanRootMenu(true);
    else if (manageOpen.value) void closeManage();
    else if (branchPanelOpen.value) closeBranchPanel(true);
    else closeDrawers();
    return;
  }
  if (activeFocusLayer()) return;
  if (isEditableTarget(event.target)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    closeDrawers();
    requestAnimationFrame(() => searchInput.value?.focus());
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '?') {
    event.preventDefault();
    shortcutHelpOpen.value = true;
  } else if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void refresh();
  } else if (event.key.toLowerCase() === 'h') {
    event.preventDefault();
    openHistory();
  }
}

function connectOperationsStream(): void {
  if (typeof EventSource === 'undefined' || operationsEventSource) return;
  const eventSource = new EventSource('/api/operations/events');
  operationsEventSource = eventSource;
  eventSource.addEventListener('open', () => {
    if (operationsReconnectTimer !== null) window.clearTimeout(operationsReconnectTimer);
    operationsReconnectTimer = null;
    operationsStreamConnected.value = true;
  });
  eventSource.addEventListener('operations', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as OperationsPayload;
      if (!Array.isArray(payload.batches) || !Array.isArray(payload.operations)) throw new Error('invalid SSE payload');
      queryClient.setQueryData(['operations'], payload);
      operationsStreamConnected.value = true;
    } catch {
      scheduleOperationsStreamReconnect(eventSource);
    }
  });
  eventSource.addEventListener('error', () => {
    void operationsQuery.refetch();
    scheduleOperationsStreamReconnect(eventSource);
  });
}

function scheduleOperationsStreamReconnect(eventSource: EventSource): void {
  if (operationsEventSource !== eventSource) return;
  operationsStreamConnected.value = false;
  eventSource.close();
  operationsEventSource = null;
  if (operationsReconnectTimer !== null) return;
  operationsReconnectTimer = window.setTimeout(() => {
    operationsReconnectTimer = null;
    connectOperationsStream();
  }, 2_000);
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
  operationsEventSource?.close();
  operationsEventSource = null;
  if (operationsReconnectTimer !== null) window.clearTimeout(operationsReconnectTimer);
  operationsReconnectTimer = null;
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
    const currentRoots = query.data.value?.roots ?? {};
    const existingRoot = Object.entries(currentRoots).find(([, configuredPath]) => configuredPath === rootPath);
    if (existingRoot) {
      scanRootId.value = existingRoot[0];
      rootForm.path = '';
      scanCandidates.value = [];
      actionMessage.value = `目录 ${rootNameFromPath(rootPath)} 已配置，可以直接扫描`;
      return;
    }
    const rootId = createUniqueRootId(rootPath, Object.keys(currentRoots));
    const roots = await api.addRoot(rootPath, rootId);
    scanRootId.value = Object.prototype.hasOwnProperty.call(roots, rootId) ? rootId : Object.keys(roots)[0] ?? '';
    rootForm.path = '';
    scanCandidates.value = [];
    closeScanRootMenu();
    actionMessage.value = `目录 ${rootNameFromPath(rootPath)} 已添加，可以开始扫描`;
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
    await api.addRepository(candidate, inferGroup(candidate.name));
    candidate.alreadyAdded = true;
    actionMessage.value = `${candidate.name} 已加入工作台`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '添加失败';
  } finally {
    addingPath.value = null;
  }
}

function inferGroup(name: string): string {
  if (['wisdomcity', 'light-language-engine', 'super-market', 'tcaweb-v2'].includes(name)) return 'Hosts';
  if (name.includes('monitor')) return '监控';
  if (name.startsWith('moo-')) return 'Moo 生态';
  return '未分组';
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
  const accepted = await requestConfirmation({
    title: '从工作台移出仓库',
    summary: '仓库将从 Fleet 列表和批量操作范围中移除。',
    target: repository.config.name,
    details: ['本地仓库目录和全部代码都会保留。', '之后仍可通过扫描或清单重新加入。'],
    confirmLabel: '移出工作台',
    tone: 'caution',
  });
  if (!accepted) return;
  await api.removeRepository(repository.config.id);
  selectedRepository.value = null;
  await query.refetch();
}

async function runBatch(type: BatchOperationType): Promise<void> {
  const targetRepositories = batchTargetRepositories.value;
  if (targetRepositories.length === 0) return;
  const scopeLabel = batchScope.value === 'visible' ? '当前结果' : '全部仓库';
  if (type !== 'fetch') {
    const action = type === 'pull' ? 'Pull' : 'Push';
    const accepted = await requestConfirmation({
      title: `批量安全 ${action}`,
      summary: `将为${scopeLabel}中的 ${targetRepositories.length} 个仓库创建操作队列。`,
      target: `${scopeLabel} · ${targetRepositories.length} 个仓库`,
      details: type === 'pull'
        ? ['只允许 fast-forward，不会自动合并。', '有本地改动、冲突或分叉的仓库会安全跳过。']
        : ['每个仓库都会先 Fetch 复核远端状态。', '远端有新提交时会跳过，永远不会 force push。'],
      confirmLabel: `开始批量 ${action}`,
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
    actionMessage.value = `${scopeLabel} · 批量 ${type.toUpperCase()} 已加入队列，共 ${batch.total} 个仓库`;
    await operationsQuery.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量操作启动失败';
  } finally {
    batchStarting.value = null;
  }
}

async function runRepositoryAction(action: 'fetch' | 'pull' | 'push'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  if (action !== 'fetch') {
    const actionLabel = action === 'pull' ? 'Pull' : 'Push';
    const accepted = await requestConfirmation({
      title: `执行安全 ${actionLabel}`,
      summary: `即将在当前仓库执行 ${actionLabel}。`,
      target: `${repository.config.name} · ${repository.branch || 'DETACHED'}`,
      details: action === 'pull'
        ? ['只允许 fast-forward，不会创建 merge commit。', '执行前仍会由服务端复核工作区和分支状态。']
        : ['先 Fetch 再复核远端是否有新提交。', '使用明确 refspec，永远不会 force push。'],
      confirmLabel: `安全 ${actionLabel}`,
      tone: 'caution',
    });
    if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  }
  repositoryCommitsRequest += 1;
  commitsLoading.value = false;
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
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
    await Promise.all([
      query.refetch(),
      isCurrentRepositoryContext(repository.config.id, contextVersion)
        ? loadRepositoryCommits(repository.config.id)
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
  branchSearch.value = '';
  if (restoreFocus) requestAnimationFrame(() => branchTrigger.value?.focus({ preventScroll: true }));
}

function handleBranchMenuPointerDown(event: PointerEvent): void {
  if (!branchPanelOpen.value || confirmation.value || upstreamRepair.value) return;
  if (event.target instanceof Node && !branchMenuRoot.value?.contains(event.target)) closeBranchPanel();
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
  return branchPanelBlocker.value;
}

async function switchRepositoryBranch(branch: BranchesSnapshot['branches'][number]): Promise<void> {
  const repository = selectedRepository.value;
  const snapshot = branchSnapshot.value;
  if (!repository || !snapshot || branchSwitchBlocker(branch)) return;
  const contextVersion = repositoryContextVersion;
  const accepted = await requestConfirmation({
    title: '切换当前工作区分支',
    summary: '服务端会再次复核当前 HEAD、工作区状态和 Worktree 占用。',
    target: `${repository.config.name} · ${snapshot.currentBranch || 'DETACHED'} → ${branch.name}`,
    details: ['不会自动 Stash，也不会携带未提交改动。', '不会强制覆盖文件；不满足安全条件时将拒绝切换。'],
    confirmLabel: '确认切换',
    tone: 'caution',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  repositoryFilesRequest += 1;
  repositoryCommitsRequest += 1;
  repositoryBranchesRequest += 1;
  filesLoading.value = false;
  commitsLoading.value = false;
  branchesLoading.value = false;

  branchSwitchBusy.value = branch.name;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output = await api.switchRepositoryBranch(
      repository.config.id,
      branch.name,
      snapshot.currentBranch,
      snapshot.head,
    );
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      selectedRepository.value = output.result.status;
      repositoryFiles.value = output.result.files;
      branchSnapshot.value = output.result.branches;
      closeBranchPanel(true);
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
    await Promise.all([
      query.refetch(),
      operationsQuery.refetch(),
      contextCurrent ? loadRepositoryCommits(repository.config.id) : Promise.resolve(),
    ]);
  } catch (error) {
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      const message = error instanceof Error ? error.message : '切换分支失败';
      actionError.value = `${repository.config.name}：${message}`;
    }
    await Promise.all([
      contextCurrent ? loadRepositoryBranches(repository.config.id) : Promise.resolve(),
      operationsQuery.refetch(),
    ]);
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) branchSwitchBusy.value = null;
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

async function loadRepositoryCommits(repositoryId: string): Promise<void> {
  const requestId = ++repositoryCommitsRequest;
  commitsLoading.value = true;
  if (selectedRepository.value?.config.id === repositoryId) commitsError.value = '';
  try {
    const commits = (await api.repositoryCommits(repositoryId)).commits;
    if (requestId === repositoryCommitsRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryCommits.value = commits;
    }
  } catch (error) {
    if (requestId === repositoryCommitsRequest && selectedRepository.value?.config.id === repositoryId) {
      commitsError.value = error instanceof Error ? error.message : '读取最近提交失败';
    }
  } finally {
    if (requestId === repositoryCommitsRequest) commitsLoading.value = false;
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

async function updateFileStage(file: FileChange, action: 'stage' | 'unstage'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || fileMutationBusy.value || !repository.config.capabilities.stage) return;
  const contextVersion = repositoryContextVersion;
  repositoryFilesRequest += 1;
  filesLoading.value = false;
  fileActionId.value = file.id;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const output =
      action === 'stage'
        ? await api.stageFiles(repository.config.id, [file.id])
        : await api.unstageFiles(repository.config.id, [file.id]);
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) repositoryFiles.value = output.files;
    await query.refetch();
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '文件操作失败';
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
  if (!repository || !action || fileMutationBusy.value || !repository.config.capabilities.stage) return;
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
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion) || fileMutationBusy.value) return;
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

async function showFileDiff(file: FileChange, requestedKind?: DiffKind): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || fileMutationBusy.value) return;
  const kind: DiffKind = requestedKind ?? (file.unstaged ? 'unstaged' : 'staged');
  if (kind === 'staged' ? !file.staged : !file.unstaged) return;
  const contextVersion = repositoryContextVersion;
  const requestId = ++diffRequest;
  diffLoading.value = true;
  diffLoadingFileId.value = file.id;
  actionError.value = '';
  try {
    const output = await api.fileDiff(repository.config.id, file.id, kind);
    if (requestId !== diffRequest || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
    diffDialog.value = {
      path: output.path,
      fileId: file.id,
      kind,
      diff: output.diff || '该文件没有可显示的文本 diff。',
      stagedAvailable: file.staged,
      unstagedAvailable: file.unstaged,
    };
    await nextTick();
    focusInitialControl();
  } catch (error) {
    if (requestId === diffRequest && isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '读取 diff 失败';
    }
  } finally {
    if (requestId === diffRequest && isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      diffLoading.value = false;
      diffLoadingFileId.value = null;
    }
  }
}

async function switchDiffKind(kind: DiffKind): Promise<void> {
  const dialog = diffDialog.value;
  if (!dialog || diffLoading.value || dialog.kind === kind) return;
  const available = kind === 'staged' ? dialog.stagedAvailable : dialog.unstagedAvailable;
  if (!available) return;
  const file = repositoryFiles.value.find((item) => item.id === dialog.fileId);
  if (!file) {
    closeDiffDialog();
    return;
  }
  await showFileDiff(file, kind);
}

async function openCommitDialog(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const contextVersion = repositoryContextVersion;
  commitBusy.value = true;
  actionError.value = '';
  try {
    const preview = await api.commitPreview(repository.config.id);
    if (!isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
    commitData.value = preview;
    commitMessage.value = '';
    commitSuggestion.value = null;
    commitPushAfter.value = false;
    commitOpen.value = true;
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : 'Commit 预览失败';
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) commitBusy.value = false;
    if (isCurrentRepositoryContext(repository.config.id, contextVersion) && commitOpen.value) {
      await nextTick();
      focusInitialControl();
    }
  }
}

async function generateCommitSuggestion(): Promise<void> {
  const repository = selectedRepository.value;
  const preview = commitData.value;
  if (!repository || !preview) return;
  const contextVersion = repositoryContextVersion;
  const expectedFingerprint = preview.fingerprint;
  const requestId = ++commitSuggestionRequest;
  commitSuggestionAbort?.abort();
  const abortController = new AbortController();
  commitSuggestionAbort = abortController;
  suggestBusy.value = true;
  actionError.value = '';
  try {
    const suggestion = await api.suggestCommit(repository.config.id, expectedFingerprint, abortController.signal);
    if (requestId !== commitSuggestionRequest || !commitOpen.value || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
    if (!commitData.value || commitData.value.fingerprint !== expectedFingerprint || suggestion.fingerprint !== expectedFingerprint) {
      throw new Error('暂存区预览已变化，请重新打开 Commit 弹窗');
    }
    commitSuggestion.value = suggestion;
    commitMessage.value = commitSuggestion.value.message;
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    if (!aborted && requestId === commitSuggestionRequest && commitOpen.value && isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = error instanceof Error ? error.message : '生成 Commit 文案失败';
    }
  } finally {
    if (requestId === commitSuggestionRequest) {
      if (commitSuggestionAbort === abortController) commitSuggestionAbort = null;
      if (isCurrentRepositoryContext(repository.config.id, contextVersion)) suggestBusy.value = false;
    }
  }
}

async function closeCommitDialog(): Promise<void> {
  if (commitBusy.value || !commitOpen.value) return;
  if (suggestBusy.value) {
    commitSuggestionRequest += 1;
    commitSuggestionAbort?.abort();
    commitSuggestionAbort = null;
    suggestBusy.value = false;
  }
  if (hasCommitDraft.value) {
    const accepted = await requestConfirmation({
      title: '放弃 Commit 草稿',
      summary: '关闭后，当前文案、AI 建议和提交后 Push 选择将被清除。',
      target: selectedRepository.value?.config.name,
      details: ['已暂存文件不会被修改或取消暂存。', '不会创建 Commit，也不会执行 Push。'],
      confirmLabel: '放弃草稿',
      tone: 'caution',
    });
    if (!accepted) return;
  }
  commitOpen.value = false;
  commitData.value = null;
  commitMessage.value = '';
  commitSuggestion.value = null;
  commitPushAfter.value = false;
  commitSubmitMode.value = null;
}

async function submitCommit(auto: boolean): Promise<void> {
  const repository = selectedRepository.value;
  const preview = commitData.value;
  if (!repository || !preview) return;
  const contextVersion = repositoryContextVersion;
  if (!auto && !commitMessage.value.trim()) {
    actionError.value = '请填写 Commit 文案';
    return;
  }
  const accepted = await requestConfirmation({
    title: auto ? '生成文案并提交' : '提交已暂存内容',
    summary: auto ? '将生成 Commit 文案，并提交当前 staged 快照。' : '将使用当前文案提交 staged 快照。',
    target: `${repository.config.name} · ${repository.branch || 'DETACHED'}`,
    details: [
      `本次只提交 ${preview.files.length} 个 staged 文件，不会自动 Stage 其他改动。`,
      commitPushAfter.value
        ? 'Commit 成功后会继续执行安全 Push；Push 失败不会回滚本地 Commit。'
        : 'Commit 只保存在本地，不会自动 Push。',
    ],
    confirmLabel: commitPushAfter.value ? '提交并安全 Push' : '确认 Commit',
    tone: commitPushAfter.value ? 'caution' : 'info',
  });
  if (!accepted || !isCurrentRepositoryContext(repository.config.id, contextVersion)) return;
  repositoryFilesRequest += 1;
  repositoryCommitsRequest += 1;
  filesLoading.value = false;
  commitsLoading.value = false;
  commitSubmitMode.value = auto ? 'auto' : 'manual';
  commitBusy.value = true;
  actionError.value = '';
  try {
    const output = auto
      ? await api.autoCommit(repository.config.id, preview.fingerprint, commitPushAfter.value)
      : await api.commit(repository.config.id, commitMessage.value, preview.fingerprint, commitPushAfter.value);
    const contextCurrent = isCurrentRepositoryContext(repository.config.id, contextVersion);
    if (contextCurrent) {
      actionMessage.value = `${repository.config.name}：${output.message}`;
      commitOpen.value = false;
      commitData.value = null;
      commitMessage.value = '';
      commitSuggestion.value = null;
      commitPushAfter.value = false;
    }
    await Promise.all([
      query.refetch(),
      contextCurrent ? loadRepositoryFiles(repository.config.id) : Promise.resolve(),
      contextCurrent ? loadRepositoryCommits(repository.config.id) : Promise.resolve(),
    ]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : 'Commit 失败'}`;
    }
  } finally {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      commitBusy.value = false;
      commitSubmitMode.value = null;
    }
  }
}
</script>

<template>
  <div class="app-shell">
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />

    <header class="topbar">
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
      </div>

      <div class="topbar-actions">
        <div class="local-signal" :data-state="query.error.value ? 'error' : query.isFetching.value ? 'busy' : 'ready'" aria-live="polite">
          <span class="signal-dot" />
          {{ query.error.value ? 'LOCAL API / ERROR' : query.isFetching.value ? 'LOCAL API / SCANNING' : 'LOCAL API / READY' }}
        </div>
        <button class="secondary-button topbar-history" title="操作记录" aria-label="打开操作记录" data-focus-return="history" @click="openHistory"><History :size="16" /><span>操作记录</span></button>
        <button class="icon-button topbar-shortcuts" title="快捷键帮助" aria-label="快捷键帮助" data-focus-return="shortcuts" @click="shortcutHelpOpen = true"><Keyboard :size="18" /></button>
        <button
          class="primary-button topbar-refresh"
          title="刷新仓库状态"
          aria-label="刷新仓库状态"
          :aria-busy="dashboardRefreshBusy || query.isFetching.value"
          :aria-disabled="dashboardRefreshBusy || query.isFetching.value"
          @click="refresh"
        >
          <RefreshCw :size="16" :class="{ spinning: dashboardRefreshBusy || query.isFetching.value }" />
          <span>刷新状态</span>
        </button>
        <button class="profile-chip" aria-label="打开个人配置" data-focus-return="manage" @click="openManage">
          <span class="avatar">{{ initials(profileForm.displayName) }}</span>
          <span>{{ profileForm.displayName || 'Developer' }}</span>
        </button>
      </div>
    </header>

    <main class="workspace">
      <section class="command-strip">
        <button class="summary-block summary-total" :class="{ active: stateFilter === 'all' }" :aria-pressed="stateFilter === 'all'" @click="filterFromSummary('all')">
          <span class="summary-icon"><FolderGit2 :size="17" /></span>
          <div><strong>{{ summary.total }}</strong><span>仓库总数</span></div>
        </button>
        <button class="summary-block summary-attention" :class="{ active: stateFilter === 'today' }" :aria-pressed="stateFilter === 'today'" @click="filterFromSummary('today')">
          <span class="summary-icon"><Check :size="17" /></span>
          <div><strong>{{ summary.today }}</strong><span>今日待处理</span></div>
        </button>
        <button class="summary-block summary-dirty" :class="{ active: stateFilter === 'dirty' }" :aria-pressed="stateFilter === 'dirty'" @click="filterFromSummary('dirty')">
          <span class="summary-icon"><CircleDot :size="17" /></span>
          <div><strong>{{ summary.dirty }}</strong><span>工作区改动</span></div>
        </button>
        <button class="summary-block summary-ahead" :class="{ active: stateFilter === 'ahead' }" :aria-pressed="stateFilter === 'ahead'" @click="filterFromSummary('ahead')">
          <span class="summary-icon"><ArrowUp :size="17" /></span>
          <div><strong>{{ summary.ahead }}</strong><span>待推送 commits</span></div>
        </button>
        <button class="summary-block summary-behind" :class="{ active: stateFilter === 'behind' }" :aria-pressed="stateFilter === 'behind'" @click="filterFromSummary('behind')">
          <span class="summary-icon"><ArrowDown :size="17" /></span>
          <div><strong>{{ summary.behind }}</strong><span>待拉取 commits</span></div>
        </button>
        <div class="command-meta">
          <span class="scan-meta" :data-scanning="query.isFetching.value" aria-live="polite" title="页面每 15 秒自动扫描一次；并发刷新会合并为同一次 Git 扫描"><Clock3 :size="14" />{{ scanStatusLabel }}</span>
          <span><Bot :size="14" />AI {{ query.data.value?.ai.configured ? query.data.value.ai.provider.toUpperCase() : 'LOCAL' }} · {{ profileForm.aiCommitMode === 'auto-commit' ? 'AUTO' : 'REVIEW' }}</span>
        </div>
      </section>

      <section class="fleet-panel">
        <div class="panel-heading">
          <div class="panel-title">
            <h2>仓库工作台</h2>
            <div class="panel-context">
              <p aria-live="polite">
                显示 <strong>{{ filteredRepositories.length }}</strong> / {{ repositories.length }} 个仓库
                <span v-if="activeRepositoryFilterLabel">· {{ activeRepositoryFilterLabel }}</span>
              </p>
              <button
                class="panel-reset-button"
                :class="{ active: hasRepositoryFilters }"
                :aria-hidden="!hasRepositoryFilters"
                :disabled="!hasRepositoryFilters"
                :tabindex="hasRepositoryFilters ? 0 : -1"
                @click="resetRepositoryFilters"
              ><RotateCcw :size="11" />重置条件</button>
            </div>
          </div>
          <div class="panel-controls">
            <select v-model="sortMode" class="sort-select" aria-label="仓库排序">
              <option value="activity">有动静优先</option>
              <option value="commit">最近提交</option>
              <option value="name">按名称</option>
              <option value="group">按分组</option>
              <option value="fetch">最近 Fetch</option>
            </select>
            <select v-model="groupFilter" class="group-select" aria-label="仓库分组筛选">
              <option :value="null">全部分组 · {{ repositories.length }}</option>
              <option v-for="group in repositoryGroups" :key="group.name" :value="group.name">{{ group.name }} · {{ group.count }}</option>
            </select>
            <div class="search-field" role="search">
              <Search :size="16" />
              <input ref="searchInput" v-model="search" aria-label="搜索仓库、路径或标签" placeholder="搜索仓库 / 路径 / 标签" @keydown.esc.stop="search = ''" />
              <button v-if="search" class="search-clear" title="清除搜索" aria-label="清除搜索" @click="search = ''"><X :size="14" /></button>
            </div>
            <div class="filter-tabs">
              <button :class="{ active: stateFilter === 'all' }" :aria-pressed="stateFilter === 'all'" @click="stateFilter = 'all'">全部 <span>{{ filterCounts.all }}</span></button>
              <button :class="{ active: stateFilter === 'today' }" :aria-pressed="stateFilter === 'today'" @click="stateFilter = 'today'">今日 <span>{{ filterCounts.today }}</span></button>
              <button :class="{ active: stateFilter === 'attention' }" :aria-pressed="stateFilter === 'attention'" @click="stateFilter = 'attention'">有动静 <span>{{ filterCounts.attention }}</span></button>
              <button :class="{ active: stateFilter === 'dirty' }" :aria-pressed="stateFilter === 'dirty'" @click="stateFilter = 'dirty'">Dirty <span>{{ filterCounts.dirty }}</span></button>
              <button :class="{ active: stateFilter === 'ahead' }" :aria-pressed="stateFilter === 'ahead'" @click="stateFilter = 'ahead'">待推送 <span>{{ filterCounts.ahead }}</span></button>
              <button :class="{ active: stateFilter === 'behind' }" :aria-pressed="stateFilter === 'behind'" @click="stateFilter = 'behind'">待拉取 <span>{{ filterCounts.behind }}</span></button>
              <button :class="{ active: stateFilter === 'stale' }" :aria-pressed="stateFilter === 'stale'" @click="stateFilter = 'stale'">久未 Fetch <span>{{ filterCounts.stale }}</span></button>
            </div>
          </div>
        </div>

        <div class="fleet-toolbar">
          <div class="batch-actions">
            <div class="batch-scope" role="group" aria-label="批量操作范围">
              <button :class="{ active: batchScope === 'visible' }" :aria-pressed="batchScope === 'visible'" @click="batchScope = 'visible'">
                当前结果 <span>{{ filteredRepositories.length }}</span>
              </button>
              <button :class="{ active: batchScope === 'all' }" :aria-pressed="batchScope === 'all'" @click="batchScope = 'all'">
                全部 <span>{{ repositories.length }}</span>
              </button>
            </div>
            <button class="compact-button" :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchTargetRepositories.length === 0" @click="runBatch('fetch')">
              <LoaderCircle v-if="batchStarting === 'fetch'" :size="14" class="spinning" /><RefreshCw v-else :size="14" />Fetch
            </button>
            <button class="compact-button" :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchTargetRepositories.length === 0" @click="runBatch('pull')">
              <LoaderCircle v-if="batchStarting === 'pull'" :size="14" class="spinning" /><ArrowDown v-else :size="14" />安全 Pull
            </button>
            <button class="compact-button" :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchTargetRepositories.length === 0" @click="runBatch('push')">
              <LoaderCircle v-if="batchStarting === 'push'" :size="14" class="spinning" /><ArrowUp v-else :size="14" />安全 Push
            </button>
          </div>
          <button v-if="activeBatch" class="batch-signal" :aria-label="batchSignalAriaLabel(activeBatch)" aria-live="polite" data-focus-return="history" @click="openHistory">
            <LoaderCircle v-if="activeBatch.state === 'running'" :size="14" class="spinning" /><Check v-else :size="14" />
            {{ activeBatch.type.toUpperCase() }} {{ activeBatch.completed }}/{{ activeBatch.total }}
          </button>
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
                <th class="sequence-column">#</th>
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
                v-for="(repository, index) in filteredRepositories"
                :key="repository.config.id"
                tabindex="0"
                aria-haspopup="dialog"
                :data-row-tone="repository.state === 'clean' ? 'neutral' : statusMeta[repository.state].tone"
                :data-focus-return="`repository:${repository.config.id}`"
                @click="selectRepository(repository)"
                @keydown.enter.self="selectRepository(repository)"
                @keydown.space.self.prevent="selectRepository(repository)"
              >
                <td class="sequence-column">{{ index + 1 }}</td>
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
                    <div class="repo-name">{{ repository.config.name }}</div>
                    <span v-if="repository.latestTag" class="repo-version" :title="`最近 Tag · ${repository.latestTag.createdAt ? relativeTime(repository.latestTag.createdAt) : '时间未知'}`">{{ repository.latestTag.name }}</span>
                  </div>
                  <div class="repo-subline">
                    <span>{{ repository.config.group }}</span>
                    <code>{{ repository.config.path }}</code>
                    <span v-if="!repository.gitIdentity.complete" class="identity-inline-warning" title="缺少 Git Commit 身份"><AlertTriangle :size="10" />身份缺失</span>
                  </div>
                </td>
                <td data-label="分支 / Upstream">
                  <div class="branch-line"><GitBranch :size="14" />{{ repository.branch || 'DETACHED' }}</div>
                  <div class="cell-muted">{{ repository.upstream || '未设置 upstream' }}</div>
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
                  <div class="commit-subject">{{ repository.lastCommit?.subject || '暂无提交' }}</div>
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
                    title="点击检测并关联 upstream"
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
            <span>{{ stateFilter === 'today' ? '没有工作区改动、待同步或异常仓库。' : '调整关键词、分组或状态条件后再试。' }}</span>
            <button v-if="hasRepositoryFilters" class="secondary-button" @click="resetRepositoryFilters"><RotateCcw :size="14" />{{ stateFilter === 'today' ? '查看全部仓库' : '重置筛选' }}</button>
          </div>
        </div>
      </section>
    </main>

    <transition name="fade">
      <button
        v-if="selectedRepository || historyOpen"
        class="drawer-backdrop"
        aria-label="关闭侧边抽屉"
        @click="closeDrawers"
      />
    </transition>

    <transition name="drawer">
      <aside
        v-if="selectedRepository"
        class="repo-drawer"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`repo-drawer-title-${selectedRepository.config.id}`"
        data-focus-layer
        tabindex="-1"
      >
        <div class="drawer-header">
          <div class="drawer-title-block">
            <div class="drawer-title-line">
              <button
                class="title-pin-button"
                :class="{ active: selectedRepository.config.pinned }"
                :aria-label="selectedRepository.config.pinned ? '取消置顶仓库' : '置顶仓库'"
                :aria-pressed="selectedRepository.config.pinned"
                :title="selectedRepository.config.pinned ? '取消置顶' : '置顶仓库'"
                :disabled="pinBusyId !== null"
                @click="togglePinned(selectedRepository)"
              ><LoaderCircle v-if="pinBusyId === selectedRepository.config.id" :size="14" class="spinning" /><Pin v-else :size="15" /></button>
              <h2 :id="`repo-drawer-title-${selectedRepository.config.id}`">{{ selectedRepository.config.name }}</h2>
              <button
                v-if="selectedRepository.state === 'remote-unknown'"
                class="repository-state-chip upstream-chip-button"
                :data-tone="statusMeta[selectedRepository.state].tone"
                :data-focus-return="`upstream:${selectedRepository.config.id}`"
                aria-haspopup="dialog"
                title="点击检测并关联 upstream"
                @click="openUpstreamRepair(selectedRepository, $event)"
              ><i /><Link2 :size="11" />{{ statusMeta[selectedRepository.state].label }}</button>
              <span v-else class="repository-state-chip" :data-tone="statusMeta[selectedRepository.state].tone"><i />{{ statusMeta[selectedRepository.state].label }}</span>
            </div>
            <div class="drawer-header-signals">
              <div ref="branchMenuRoot" class="branch-menu">
                <button
                  ref="branchTrigger"
                  class="header-signal-branch branch-trigger"
                  :class="{ active: branchPanelOpen }"
                  :aria-expanded="branchPanelOpen"
                  aria-haspopup="dialog"
                  aria-controls="repository-branch-switcher"
                  title="查看并切换本地分支"
                  @click="toggleBranchPanel"
                ><GitBranch :size="12" />{{ selectedRepository.branch || 'DETACHED' }}<ChevronDown :size="12" /></button>
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
                  >
                    <div class="branch-switcher-heading">
                      <div class="branch-switcher-title">
                        <span class="branch-switcher-glyph"><GitBranch :size="16" /></span>
                        <div><strong id="repository-branch-switcher-title">切换本地分支</strong><span>只允许干净工作区；不会自动 Stash 或强制覆盖。</span></div>
                      </div>
                      <button class="table-icon-button" title="刷新分支" aria-label="刷新分支" :disabled="branchesLoading || branchSwitchBusy !== null" @click="loadRepositoryBranches(selectedRepository.config.id)"><RefreshCw :size="14" :class="{ spinning: branchesLoading }" /></button>
                    </div>
                    <p v-if="branchPanelBlocker" class="branch-panel-blocker" role="status"><AlertTriangle :size="14" /><span><strong>暂不可切换</strong><span>{{ branchPanelBlocker }}</span></span></p>
                    <div v-if="branchSnapshot && branchSnapshot.branches.length > 6" class="branch-search">
                      <Search :size="14" /><input v-model="branchSearch" aria-label="搜索本地分支" placeholder="搜索分支或 upstream" />
                      <button v-if="branchSearch" title="清除分支搜索" aria-label="清除分支搜索" @click="branchSearch = ''"><X :size="13" /></button>
                    </div>
                    <div class="branch-list">
                      <div v-if="branchesLoading && !branchSnapshot" class="branch-list-state"><LoaderCircle :size="16" class="spinning" />读取本地分支…</div>
                      <div v-else-if="filteredLocalBranches.length === 0" class="branch-list-state"><GitBranch :size="16" />{{ branchSearch ? '没有匹配的本地分支' : '尚无本地分支，创建首个 Commit 后即可管理分支' }}</div>
                      <button
                        v-for="branch in filteredLocalBranches"
                        v-else
                        :key="branch.name"
                        class="branch-option"
                        :class="{ current: branch.current, occupied: Boolean(branch.worktreePath && !branch.current) }"
                        :aria-current="branch.current ? 'true' : undefined"
                        :disabled="Boolean(branchSwitchBlocker(branch)) || branchSwitchBusy !== null || repositoryAction !== null"
                        :title="branchSwitchBlocker(branch) || `切换到 ${branch.name}`"
                        @click="switchRepositoryBranch(branch)"
                      >
                        <span class="branch-option-icon"><LoaderCircle v-if="branchSwitchBusy === branch.name" :size="15" class="spinning" /><Check v-else-if="branch.current" :size="15" /><GitBranch v-else :size="15" /></span>
                        <span class="branch-option-copy"><strong>{{ branch.name }}</strong><small>{{ branch.upstream || '未设置 upstream' }}</small></span>
                        <span v-if="branch.current" class="branch-option-state">CURRENT</span>
                        <span v-else-if="branch.worktreePath" class="branch-option-state occupied">WORKTREE</span>
                        <span v-else class="branch-option-divergence" :aria-label="branchDivergenceLabel(branch)" :title="branchDivergenceLabel(branch)"><ArrowUp :size="11" />{{ branch.ahead ?? '—' }}<ArrowDown :size="11" />{{ branch.behind ?? '—' }}</span>
                      </button>
                    </div>
                  </section>
                </transition>
              </div>
              <span class="header-signal-changes" title="唯一变更文件数"><CircleDot :size="12" />{{ selectedRepository.changedFiles }} 个文件</span>
              <span class="header-signal-ahead" title="待推送提交"><ArrowUp :size="12" />{{ selectedRepository.ahead ?? '—' }}</span>
              <span class="header-signal-behind" title="待拉取提交"><ArrowDown :size="12" />{{ selectedRepository.behind ?? '—' }}</span>
              <span class="header-signal-fetch" title="最近一次 Fetch"><RefreshCw :size="12" />Fetch {{ selectedRepository.lastFetchedAt ? relativeTime(selectedRepository.lastFetchedAt) : '未知' }}</span>
              <span class="header-signal-stash" title="Stash 备份数量"><Archive :size="12" />Stash {{ selectedRepository.stashCount }}</span>
              <span class="header-signal-scan" title="最近一次本地扫描"><Clock3 :size="12" />扫描 {{ relativeTime(selectedRepository.scannedAt) }}</span>
            </div>
          </div>
          <button class="icon-button drawer-close-button" title="关闭仓库详情" aria-label="关闭仓库详情" data-dialog-initial @click="closeDrawers"><X :size="16" /></button>
        </div>
        <div class="drawer-section">
          <h3 class="drawer-section-title">工作区信号</h3>
          <div class="signal-grid">
            <div><span>Staged</span><strong>{{ selectedRepository.staged }}</strong></div>
            <div><span>Modified</span><strong>{{ selectedRepository.modified }}</strong></div>
            <div><span>Untracked</span><strong>{{ selectedRepository.untracked }}</strong></div>
            <div><span>Conflicts</span><strong>{{ selectedRepository.conflicted }}</strong></div>
          </div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-heading safety-section-heading">
            <div class="safety-title-group">
              <span class="safety-title-icon"><ShieldCheck :size="15" /></span>
              <h3 class="drawer-section-title">安全操作</h3>
              <span class="safety-channel-mark">SAFE GIT</span>
            </div>
            <span class="section-inline-hint">Pull 仅 fast-forward；Push 会先 Fetch 且永不 force。</span>
            <div class="section-inline-blockers">
              <span v-if="!pullAvailability.available && (selectedRepository.behind ?? 0) > 0" class="section-inline-blocker"><AlertTriangle :size="11" />Pull：{{ pullAvailability.detail }}</span>
              <span v-if="!pushAvailability.available && (selectedRepository.ahead ?? 0) > 0" class="section-inline-blocker"><AlertTriangle :size="11" />Push：{{ pushAvailability.detail }}</span>
            </div>
          </div>
          <div class="git-action-grid">
            <button
              class="secondary-button git-action-button git-action-fetch"
              :disabled="repositoryAction !== null || !selectedRepository.config.capabilities.fetch"
              @click="runRepositoryAction('fetch')"
            ><LoaderCircle v-if="repositoryAction === 'fetch'" :size="16" class="spinning" /><RefreshCw v-else :size="16" />Fetch</button>
            <button
              class="secondary-button git-action-button git-action-pull"
              :disabled="repositoryAction !== null || !pullAvailability.available"
              :title="pullAvailability.detail"
              @click="runRepositoryAction('pull')"
            ><LoaderCircle v-if="repositoryAction === 'pull'" :size="16" class="spinning" /><ArrowDown v-else :size="16" />安全 Pull</button>
            <button
              class="secondary-button git-action-button git-action-push"
              :disabled="repositoryAction !== null || !pushAvailability.available"
              :title="pushAvailability.detail"
              @click="runRepositoryAction('push')"
            ><LoaderCircle v-if="repositoryAction === 'push'" :size="16" class="spinning" /><ArrowUp v-else :size="16" />安全 Push</button>
          </div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-heading">
            <div class="drawer-section-label">
              <h3 class="drawer-section-title">文件变化</h3>
              <span
                class="file-change-count"
                :class="{ loading: fileCountLoading }"
                role="status"
                aria-atomic="true"
                :aria-label="fileCountLoading ? '正在统计文件变化' : `${repositoryFiles.length} 个文件变化`"
              ><LoaderCircle v-if="fileCountLoading" :size="10" class="spinning" aria-hidden="true" /><template v-else>{{ repositoryFiles.length }}</template></span>
            </div>
            <button
              class="compact-button"
              data-focus-return="commit"
              :disabled="selectedRepository.staged === 0 || commitBusy"
              @click="openCommitDialog"
            ><LoaderCircle v-if="commitBusy" :size="14" class="spinning" /><GitCommitHorizontal v-else :size="14" />Commit {{ selectedRepository.staged || '' }}</button>
          </div>
          <div class="file-list" :aria-busy="filesLoading || fileMutationBusy">
            <div v-if="filesLoading" class="file-empty"><LoaderCircle :size="16" class="spinning" />读取文件状态…</div>
            <div v-else-if="repositoryFiles.length === 0" class="file-empty"><Check :size="16" />工作区干净</div>
            <div v-for="file in repositoryFiles" v-else :key="file.id" class="file-row">
              <button class="file-path" :data-focus-return="`diff:${file.path}`" :aria-busy="diffLoadingFileId === file.id" :disabled="diffLoading || fileMutationBusy" @click="showFileDiff(file)">
                <span class="file-status" :class="{ staged: file.staged, conflict: file.conflicted, loading: diffLoadingFileId === file.id }">
                  <LoaderCircle v-if="diffLoadingFileId === file.id" :size="12" class="spinning" aria-hidden="true" />
                  <template v-else>{{ file.untracked ? 'U' : file.indexStatus !== ' ' ? file.indexStatus : file.worktreeStatus }}</template>
                </span>
                <span>{{ file.path }}</span>
              </button>
              <button
                v-if="fileDiscardAction(file)"
                class="file-action file-discard"
                :class="{ trash: fileDiscardAction(file) === 'trash' }"
                :disabled="fileMutationBusy || !selectedRepository.config.capabilities.stage"
                :title="fileDiscardAction(file) === 'trash' ? '移到废纸篓' : '丢弃本地修改'"
                :aria-label="`${fileDiscardAction(file) === 'trash' ? '移到废纸篓' : '丢弃本地修改'} ${file.path}`"
                @click="discardRepositoryFile(file)"
              ><LoaderCircle v-if="fileDiscardId === file.id" :size="13" class="spinning" /><Trash2 v-else-if="fileDiscardAction(file) === 'trash'" :size="13" /><RotateCcw v-else :size="13" /></button>
              <button
                v-if="file.staged"
                class="file-action"
                :disabled="fileMutationBusy || !selectedRepository.config.capabilities.stage"
                title="取消暂存"
                :aria-label="`取消暂存 ${file.path}`"
                @click="updateFileStage(file, 'unstage')"
              ><LoaderCircle v-if="fileActionId === file.id" :size="13" class="spinning" /><Minus v-else :size="13" /></button>
              <button
                v-else
                class="file-action"
                :disabled="fileMutationBusy || !selectedRepository.config.capabilities.stage"
                title="暂存"
                :aria-label="`暂存 ${file.path}`"
                @click="updateFileStage(file, 'stage')"
              ><LoaderCircle v-if="fileActionId === file.id" :size="13" class="spinning" /><Plus v-else :size="13" /></button>
            </div>
          </div>
        </div>
        <details class="drawer-section stash-section">
          <summary class="stash-summary">
            <span class="drawer-section-title">STASH 备份</span>
            <span class="stash-summary-meta"><strong>{{ repositoryStashes.length }}</strong>{{ repositoryStashes.length ? ' 条备份' : ' 暂无备份' }}<ChevronRight :size="15" /></span>
          </summary>
          <div class="stash-section-body">
            <div class="stash-body-heading">
              <span>临时收起当前改动，应用时保留原备份</span>
              <button class="table-icon-button" title="刷新 Stash" aria-label="刷新 Stash" :disabled="stashesLoading || stashBusy !== null" @click="loadRepositoryStashes(selectedRepository.config.id)"><RefreshCw :size="14" :class="{ spinning: stashesLoading }" /></button>
            </div>
            <div class="stash-create-panel">
              <input v-model="stashMessage" maxlength="120" placeholder="备份说明（可选）" @keydown.enter="createRepositoryStash" />
              <button class="compact-button" :disabled="stashBusy !== null || !selectedRepository.config.capabilities.stash" @click="createRepositoryStash"><LoaderCircle v-if="stashBusy === 'create'" :size="14" class="spinning" /><Archive v-else :size="14" />创建备份</button>
              <label><input v-model="stashIncludeUntracked" type="checkbox" />包含未跟踪文件</label>
            </div>
            <div class="stash-list">
              <div v-if="stashesLoading" class="file-empty"><LoaderCircle :size="16" class="spinning" />读取 Stash…</div>
              <div v-else-if="repositoryStashes.length === 0" class="file-empty"><Archive :size="16" />暂无 Stash 备份</div>
              <div v-for="stash in repositoryStashes" v-else :key="stash.hash" class="stash-row">
                <div class="stash-main">
                  <div><strong>{{ stash.ref }}</strong><span>{{ relativeTime(stash.createdAt) }}</span></div>
                  <p :title="stash.message">{{ stash.message }}</p>
                  <pre v-if="stash.stat">{{ stash.stat }}</pre>
                </div>
                <div class="stash-actions">
                  <button
                    class="file-action stash-apply"
                    title="应用并保留该 Stash"
                    :aria-label="`应用并保留 ${stash.ref}`"
                    :disabled="stashBusy !== null || !canApplyStash || !selectedRepository.config.capabilities.stash"
                    @click="applyRepositoryStash(stash)"
                  ><LoaderCircle v-if="stashBusy === `apply:${stash.hash}`" :size="14" class="spinning" /><ArchiveRestore v-else :size="14" /></button>
                  <button
                    class="file-action stash-drop"
                    title="永久删除该 Stash"
                    :aria-label="`永久删除 ${stash.ref}`"
                    :disabled="stashBusy !== null || !selectedRepository.config.capabilities.stash"
                    @click="dropRepositoryStash(stash)"
                  ><LoaderCircle v-if="stashBusy === `drop:${stash.hash}`" :size="14" class="spinning" /><Trash2 v-else :size="14" /></button>
                </div>
              </div>
            </div>
            <p class="action-hint">创建会暂时清空所选改动；应用要求工作区干净且保留原备份；删除操作不可恢复。</p>
          </div>
        </details>
        <div class="drawer-section recent-commits-section">
          <div class="drawer-section-heading">
            <h3 class="drawer-section-title">最近提交</h3>
            <span class="recent-commits-count">{{ repositoryCommits.length }}/7</span>
            <button class="table-icon-button" title="刷新最近提交" aria-label="刷新最近提交" :disabled="commitsLoading" @click="loadRepositoryCommits(selectedRepository.config.id)"><RefreshCw :size="13" :class="{ spinning: commitsLoading }" /></button>
          </div>
          <div v-if="commitsLoading && repositoryCommits.length === 0" class="commit-list-state"><LoaderCircle :size="16" class="spinning" />读取最近提交…</div>
          <div v-else-if="commitsError" class="commit-list-state commit-list-error"><AlertTriangle :size="15" />{{ commitsError }}</div>
          <div v-else-if="repositoryCommits.length === 0" class="commit-list-state"><GitCommitHorizontal :size="16" />暂无提交</div>
          <div v-else class="recent-commit-list" role="list" aria-label="最近 7 条提交">
            <div v-for="(commit, index) in repositoryCommits" :key="commit.hash" class="recent-commit-row" role="listitem">
              <span class="recent-commit-marker" aria-hidden="true"><GitCommitHorizontal :size="13" /></span>
              <div class="recent-commit-copy">
                <strong :title="commit.subject">{{ commit.subject }}</strong>
                <span>{{ commit.author }} · {{ relativeTime(commit.committedAt) }}</span>
                <code>{{ commit.hash.slice(0, 7) }}</code>
              </div>
              <a
                v-if="selectedRemoteLinks?.commitUrl(commit.hash)"
                class="recent-commit-link"
                :href="selectedRemoteLinks?.commitUrl(commit.hash) || undefined"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="`在 ${selectedRemoteLinks.provider} 查看第 ${index + 1} 条最近提交 ${commit.subject}`"
              ><ExternalLink :size="12" /></a>
            </div>
          </div>
        </div>
        <div v-if="selectedRepository.error" class="drawer-error"><AlertTriangle :size="16" />{{ selectedRepository.error }}</div>
        <div class="repository-context repository-context-bottom">
          <div class="drawer-section-heading repository-context-heading">
            <h3 class="drawer-section-title">仓库信息</h3>
            <span class="section-inline-hint">路径、分支与远端</span>
          </div>
          <div class="repository-info-card">
            <dl class="detail-grid">
              <div><dt>LOCAL PATH</dt><dd class="copyable-value"><span :title="selectedRepository.absolutePath">{{ selectedRepository.absolutePath }}</span><button title="复制本地路径" aria-label="复制本地路径" @click="copyToClipboard(selectedRepository.absolutePath, '本地路径')"><Copy :size="12" /></button></dd></div>
              <div><dt>BRANCH / UPSTREAM</dt><dd>{{ selectedRepository.branch || 'DETACHED HEAD' }} · {{ selectedRepository.upstream || '未设置 upstream' }}</dd></div>
              <div><dt>REMOTE URL</dt><dd class="copyable-value"><span :title="selectedRepository.remoteUrl || '未配置'">{{ selectedRepository.remoteUrl || '未配置' }}</span><a v-if="selectedRemoteLinks" class="metadata-link" :href="selectedRemoteLinks.repositoryUrl" target="_blank" rel="noopener noreferrer" :aria-label="`在 ${selectedRemoteLinks.provider} 打开 ${selectedRepository.config.name}`"><ExternalLink :size="12" />{{ selectedRemoteLinks.provider }} 主页</a><button title="复制 Remote URL" aria-label="复制 Remote URL" :disabled="!selectedRepository.remoteUrl" @click="copyToClipboard(selectedRepository.remoteUrl, 'Remote URL')"><Copy :size="12" /></button></dd></div>
            </dl>
          </div>
          <details v-if="branchSnapshot && relatedWorktrees.length" class="related-worktrees">
            <summary><GitBranch :size="13" />关联 Worktree <strong>{{ relatedWorktrees.length }}</strong><ChevronRight :size="14" /></summary>
            <div v-for="worktree in relatedWorktrees" :key="worktree.path" class="related-worktree-row">
              <span><GitBranch :size="12" />{{ worktree.branch || 'DETACHED' }}</span>
              <code :title="worktree.path">{{ worktree.path }}</code>
              <small v-if="worktree.prunable">失效</small>
            </div>
          </details>
        </div>
        <div class="drawer-spacer" />
        <div class="drawer-actions">
          <button class="secondary-button" :data-focus-return="`repository-edit:${selectedRepository.config.id}`" @click="openRepositoryEditor(selectedRepository)"><Settings2 :size="16" />编辑配置</button>
          <div class="drawer-utility-actions" aria-label="本机仓库操作">
            <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('finder')"><LoaderCircle v-if="openBusy === 'finder'" :size="14" class="spinning" /><FolderGit2 v-else :size="14" />Finder</button>
            <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('terminal')"><LoaderCircle v-if="openBusy === 'terminal'" :size="14" class="spinning" /><TerminalSquare v-else :size="14" />Terminal</button>
            <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('vscode')"><LoaderCircle v-if="openBusy === 'vscode'" :size="14" class="spinning" /><Code2 v-else :size="14" />VS Code</button>
            <button class="secondary-button" @click="copyToClipboard(cdCommand(selectedRepository.absolutePath), 'cd 命令')"><Copy :size="14" />复制 cd</button>
          </div>
          <button class="danger-button" @click="removeRepository(selectedRepository)"><Trash2 :size="16" />移出列表</button>
        </div>
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
            ><LoaderCircle v-if="batchRetryBusy" :size="13" class="spinning" /><RotateCcw v-else :size="13" />重试未完成 {{ retryableBatchRepositoryIdsList.length }}</button>
          </div>
        </div>

        <div class="history-heading">
          <span>最近操作 · {{ filteredOperations.length }}/{{ operationsQuery.data.value?.operations.length || 0 }}</span>
          <div class="history-heading-actions">
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
          <select v-model="operationRepositoryFilter" aria-label="按仓库筛选操作记录">
            <option value="all">全部仓库</option>
            <option v-for="repository in operationRepositories" :key="repository.id" :value="repository.id">{{ repository.name }}</option>
          </select>
          <select v-model="operationTypeFilter" aria-label="按动作筛选操作记录">
            <option value="all">全部动作</option>
            <option value="fetch">Fetch</option>
            <option value="pull">Pull</option>
            <option value="push">Push</option>
            <option value="commit">Commit</option>
            <option value="stash">Stash</option>
            <option value="switch-branch">切换分支</option>
            <option value="set-upstream">关联 upstream</option>
          </select>
          <select v-model="operationStateFilter" aria-label="按结果筛选操作记录">
            <option value="all">全部结果</option>
            <option value="queued">等待</option>
            <option value="running">执行中</option>
            <option value="success">成功</option>
            <option value="skipped">跳过</option>
            <option value="failed">失败</option>
          </select>
          <button class="table-icon-button" title="清除筛选" aria-label="清除操作记录筛选" :disabled="!hasOperationFilters" @click="clearOperationFilters"><X :size="13" /></button>
        </div>
        <div class="operation-list">
          <div v-if="operationsQuery.isLoading.value" class="file-empty"><LoaderCircle :size="16" class="spinning" />读取操作记录…</div>
          <div v-else-if="!(operationsQuery.data.value?.operations.length)" class="history-empty"><History :size="24" /><span>还没有 Git 操作记录</span></div>
          <div v-else-if="filteredOperations.length === 0" class="history-empty"><Search :size="24" /><span>没有匹配筛选条件的操作</span><button class="compact-button" @click="clearOperationFilters">清除筛选</button></div>
          <div
            v-for="(operation, operationIndex) in filteredOperations"
            v-else
            :key="operation.id"
            class="operation-row"
            :data-state="operation.state"
          >
            <span class="operation-state-dot" />
            <div class="operation-main">
              <div><button class="operation-repository-link" :data-dialog-initial="historyReturnOperationId === operation.id ? '' : undefined" @click="openOperationRepository(operation)">{{ operation.repositoryName }}</button><span>{{ operationTypeLabel(operation.type) }}</span></div>
              <p>{{ operation.message }}</p>
            </div>
            <div class="operation-meta">
              <span>{{ operationStateLabel(operation.state) }}</span>
              <time>{{ operation.finishedAt ? relativeTime(operation.finishedAt) : operation.startedAt ? '执行中' : '等待中' }}</time>
              <button
                v-if="['failed', 'skipped'].includes(operation.state) && ['fetch', 'pull', 'push'].includes(operation.type)"
                class="operation-retry"
                :title="`安全重试 ${operation.repositoryName} 的 ${operationTypeLabel(operation.type)}`"
                :aria-label="`第 ${operationIndex + 1} 条操作：安全重试 ${operation.repositoryName} 的 ${operationTypeLabel(operation.type)}`"
                :disabled="operationRetryId !== null"
                @click="retryOperation(operation)"
              ><LoaderCircle v-if="operationRetryId === operation.id" :size="12" class="spinning" /><RotateCcw v-else :size="12" />重试</button>
            </div>
          </div>
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
            <div><span>搜索仓库</span><kbd>⌘ / Ctrl</kbd><kbd>K</kbd></div>
            <div><span>刷新本地状态</span><kbd>R</kbd></div>
            <div><span>打开操作记录</span><kbd>H</kbd></div>
            <div><span>关闭抽屉或弹窗</span><kbd>Esc</kbd></div>
            <div><span>显示本帮助</span><kbd>?</kbd></div>
          </div>
          <p>输入框聚焦时，除 Esc 外的单键快捷键会自动停用。</p>
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
              <label class="form-field"><span>Commit 语言</span><select v-model="profileForm.preferredCommitLanguage"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
              <label class="form-field"><span>AI Commit 模式</span><select v-model="profileForm.aiCommitMode"><option value="review">生成后确认</option><option value="auto-commit">一键生成并提交</option></select></label>
              <label class="form-field">
                <span>DeepSeek API Key · {{ query.data.value?.ai.configured ? '已配置' : '未配置' }}</span>
                <span class="secret-input-control">
                  <input v-model="deepSeekApiKey" :type="deepSeekApiKeyVisible ? 'text' : 'password'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入或粘贴 API Key" @keydown.enter.prevent="saveDeepSeekKey" />
                  <button type="button" :title="deepSeekApiKeyVisible ? '隐藏 Key' : '显示 Key'" :aria-label="deepSeekApiKeyVisible ? '隐藏 DeepSeek API Key' : '显示 DeepSeek API Key'" @click="deepSeekApiKeyVisible = !deepSeekApiKeyVisible"><EyeOff v-if="deepSeekApiKeyVisible" :size="15" /><Eye v-else :size="15" /></button>
                  <button type="button" title="从 macOS 剪贴板粘贴" aria-label="粘贴 DeepSeek API Key" @click="pasteDeepSeekKey"><ClipboardPaste :size="15" /></button>
                </span>
              </label>
              <button class="secondary-button full-width" :disabled="loadingDeepSeekApiKey || savingDeepSeekApiKey || deepSeekApiKey.trim().length < 8" @click="saveDeepSeekKey"><LoaderCircle v-if="loadingDeepSeekApiKey || savingDeepSeekApiKey" :size="16" class="spinning" /><ShieldCheck v-else :size="16" />保存 DeepSeek Key</button>
              <div class="auto-fetch-preference" :data-enabled="profileForm.autoFetchIntervalMinutes !== 0">
                <span class="preference-icon"><RefreshCw :size="16" /></span>
                <div><strong>自动 Fetch</strong><span>{{ autoFetchDescription }}</span></div>
                <select v-model.number="profileForm.autoFetchIntervalMinutes" aria-label="自动 Fetch 周期">
                  <option v-for="interval in autoFetchIntervals" :key="interval" :value="interval">{{ autoFetchIntervalLabel(interval) }}</option>
                </select>
              </div>
              <div class="theme-preview"><span class="theme-orb"><Sparkles :size="15" /></span><div><strong>Moon / One Dark Pro</strong><span>默认本地工程主题</span></div><Check :size="17" /></div>
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
                      title="移除根目录"
                      :aria-label="`移除目录 ${rootNameFromPath(String(rootPath))}`"
                      :disabled="rootUsageCount(String(rootId)) > 0 || rootBusy !== null"
                      @click="removeRoot(String(rootId), String(rootPath))"
                    ><LoaderCircle v-if="rootBusy === rootId" :size="13" class="spinning" /><Trash2 v-else :size="13" /></button>
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
                <div ref="scanRootMenuRoot" class="scan-root-select">
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
                  <div class="candidate-info"><strong>{{ candidate.name }}</strong><span>{{ candidate.relativePath }} · {{ candidate.branch || 'DETACHED' }}</span></div>
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
              <span><ShieldCheck :size="14" />配置仅保存在本机 config/，不会上传个人路径；移出仓库列表不会删除代码</span>
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
              <select v-model="repositoryEdit.aiCommitPolicy">
                <option value="disabled">禁用远端 AI · 仅本地规则</option>
                <option value="stat-only">仅发送统计 · 不发送 Patch</option>
                <option value="redacted-patch">发送脱敏 Patch</option>
              </select>
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

    <transition name="fade">
      <div v-if="diffDialog" class="modal-backdrop" @click.self="closeDiffDialog">
        <section class="code-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div>
              <div class="diff-modal-kicker">
                <span v-if="!(diffDialog.stagedAvailable && diffDialog.unstagedAvailable)" class="section-kicker">{{ diffDialog.kind === 'staged' ? '已暂存差异' : '未暂存差异' }}</span>
                <div v-if="diffDialog.stagedAvailable && diffDialog.unstagedAvailable" class="diff-kind-tabs" role="tablist" aria-label="Diff 范围">
                  <button
                    class="diff-kind-tab"
                    :class="{ active: diffDialog.kind === 'unstaged' }"
                    role="tab"
                    :aria-selected="diffDialog.kind === 'unstaged'"
                    :disabled="diffLoading"
                    @click="switchDiffKind('unstaged')"
                  >未暂存</button>
                  <button
                    class="diff-kind-tab"
                    :class="{ active: diffDialog.kind === 'staged' }"
                    role="tab"
                    :aria-selected="diffDialog.kind === 'staged'"
                    :disabled="diffLoading"
                    @click="switchDiffKind('staged')"
                  >已暂存</button>
                </div>
                <span v-if="diffPresentation" class="diff-language">{{ diffPresentation.languageLabel }}</span>
                <span v-if="diffPresentation" class="diff-stat">{{ diffPresentation.lines.length }} 行</span>
                <span v-if="diffPresentation" class="diff-stat addition">+{{ diffPresentation.additions }}</span>
                <span v-if="diffPresentation" class="diff-stat deletion">−{{ diffPresentation.deletions }}</span>
                <span v-if="diffLoading" class="diff-loading-label" role="status">读取中…</span>
              </div>
              <h2 id="diff-title">{{ diffDialog.path }}</h2>
            </div>
            <button class="icon-button" title="关闭 Diff 预览" aria-label="关闭 Diff 预览" data-dialog-initial @click="closeDiffDialog"><X :size="18" /></button>
          </div>
          <div v-if="diffPresentation" class="diff-view" role="table" :aria-label="`${diffDialog.path} Git Diff`">
            <div
              v-for="line in diffPresentation.lines"
              :key="line.id"
              class="diff-line"
              :data-kind="line.kind"
              role="row"
            >
              <span class="diff-line-number old" role="cell">{{ line.oldLine ?? '' }}</span>
              <span class="diff-line-number new" role="cell">{{ line.newLine ?? '' }}</span>
              <span
                class="diff-line-marker"
                role="cell"
                :aria-label="line.kind === 'addition' ? '新增行' : line.kind === 'deletion' ? '删除行' : undefined"
              >{{ line.marker }}</span>
              <code class="diff-line-code" role="cell"><span
                v-for="(token, tokenIndex) in line.tokens"
                :key="`${line.id}:${tokenIndex}`"
                :class="`syntax-${token.kind}`"
              >{{ token.text }}</span></code>
            </div>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="commitOpen && commitData" class="modal-backdrop" @click.self="closeCommitDialog">
        <section class="commit-modal" role="dialog" aria-modal="true" aria-labelledby="commit-title" :aria-busy="commitBusy" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div class="commit-modal-title"><h2 id="commit-title">{{ selectedRepository?.config.name }}</h2><span v-if="hasCommitDraft"><CircleDot :size="11" />草稿</span></div>
            <button class="icon-button" title="关闭 Commit 弹窗" aria-label="关闭 Commit 弹窗" :disabled="commitBusy" @click="closeCommitDialog"><X :size="18" /></button>
          </div>
          <div class="commit-modal-body">
            <div class="commit-preview-column">
              <div class="commit-meta-line"><span>{{ commitData.files.length }} 个 staged 文件</span><span class="mono">{{ commitData.fingerprint.slice(0, 10) }}</span></div>
              <div class="staged-file-chips"><span v-for="file in commitData.files" :key="file">{{ file }}</span></div>
              <pre class="stat-view">{{ commitData.stat }}</pre>
              <div v-if="commitData.truncated" class="truncated-note"><AlertTriangle :size="14" />Diff 过大，AI 输入和页面预览已截断</div>
            </div>
            <div class="commit-editor-column">
              <div v-if="activeCommitAiPolicy" class="ai-privacy-card" :data-mode="activeCommitAiPolicy.mode">
                <ShieldCheck :size="17" />
                <div><strong>{{ activeCommitAiPolicy.label }}</strong><span>{{ activeCommitAiPolicy.detail }}</span></div>
              </div>
              <label class="form-field commit-message-field">
                <span>Commit 文案</span>
                <textarea v-model="commitMessage" data-dialog-initial placeholder="填写文案，或让 DeepSeek / 本地规则生成" :disabled="commitBusy || suggestBusy" />
              </label>
              <div v-if="commitSuggestion" class="suggestion-meta">
                <Sparkles :size="15" /><div><strong>{{ commitSuggestion.source }}</strong><span>{{ commitSuggestion.summary }}</span></div>
              </div>
              <button class="secondary-button full-width" :disabled="suggestBusy || commitBusy" @click="generateCommitSuggestion">
                <template v-if="suggestBusy"><LoaderCircle :size="16" class="spinning" />正在生成文案…</template>
                <template v-else><Bot :size="16" />生成 Commit 文案</template>
              </button>
              <label class="commit-push-option" :data-active="commitPushAfter" :data-available="commitPushAvailability.available">
                <input v-model="commitPushAfter" type="checkbox" role="switch" aria-label="提交后安全 Push" :aria-checked="commitPushAfter" :disabled="commitBusy || !commitPushAvailability.available" />
                <span class="commit-push-icon"><ArrowUp :size="16" /></span>
                <span class="commit-push-copy">
                  <strong>提交后安全 Push <small>默认关闭</small></strong>
                  <span>{{ commitPushAvailability.detail }}</span>
                </span>
                <span class="commit-push-switch"><i /></span>
              </label>
              <div class="commit-action-row">
                <button class="secondary-button" :disabled="commitBusy || !commitMessage.trim()" @click="submitCommit(false)">
                  <template v-if="commitSubmitMode === 'manual'"><LoaderCircle :size="16" class="spinning" />正在提交…</template>
                  <template v-else><GitCommitHorizontal :size="16" />确认提交</template>
                </button>
                <button class="primary-button" :disabled="commitBusy" @click="submitCommit(true)">
                  <template v-if="commitSubmitMode === 'auto'"><LoaderCircle :size="16" class="spinning" />正在生成并提交…</template>
                  <template v-else><Sparkles :size="16" />生成并提交</template>
                </button>
              </div>
              <p v-if="commitBusy" class="commit-progress-note" role="status"><LoaderCircle :size="14" class="spinning" />{{ commitProgressMessage }}</p>
              <p class="action-hint">只提交当前 staged 内容，不会自动 Stage。后置 Push 失败时 Commit 仍安全保留在本地。</p>
            </div>
          </div>
        </section>
      </div>
    </transition>

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
                    <select v-model="upstreamRepair.selectedRemote" :disabled="upstreamRepairBusy" data-dialog-initial>
                      <option v-for="remote in upstreamRepair.plan.remotes" :key="remote.name" :value="remote.name">{{ remote.name }}{{ remote.default ? ' · 默认' : '' }}</option>
                    </select>
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
              <div class="confirmation-kicker">OPERATION CHECKPOINT</div>
              <h2 id="confirmation-title">{{ confirmation.title }}</h2>
            </div>
            <button class="icon-button confirmation-close" aria-label="取消并关闭确认弹窗" @click="settleConfirmation(false)"><X :size="17" /></button>
          </div>
          <div class="confirmation-body">
            <p id="confirmation-summary" class="confirmation-summary">{{ confirmation.summary }}</p>
            <div v-if="confirmation.target" class="confirmation-target">
              <span>操作目标</span>
              <strong :title="confirmation.target">{{ confirmation.target }}</strong>
            </div>
            <ul id="confirmation-details" class="confirmation-details">
              <li v-for="detail in confirmation.details" :key="detail"><Check :size="13" />{{ detail }}</li>
            </ul>
          </div>
          <div class="confirmation-footer">
            <span><ShieldCheck :size="14" />服务端仍会执行最终安全校验</span>
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
        v-if="(actionMessage || actionError) && !manageOpen"
        :key="actionError || actionMessage"
        class="global-toast"
        :class="{ error: actionError, warning: !actionError && actionMessage.startsWith('⚠') }"
        :style="{ '--toast-duration': `${globalToastDuration}ms` }"
        :role="actionError ? 'alert' : 'status'"
        :aria-live="actionError ? 'assertive' : 'polite'"
      >
        <AlertTriangle v-if="actionError || actionMessage.startsWith('⚠')" :size="16" /><Check v-else :size="16" />
        <span>{{ actionError || actionMessage }}</span>
        <button aria-label="关闭提示" @click="dismissGlobalToast"><X :size="14" /></button>
        <i class="toast-progress" aria-hidden="true" />
      </div>
    </transition>
  </div>
</template>
