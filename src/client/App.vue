<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  History,
  Keyboard,
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
  UserRound,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type {
  AiCommitRepositoryPolicy,
  AutoFetchIntervalMinutes,
  BatchOperationType,
  BatchRecord,
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
  RepositoryFilterMode,
  RepositoryCapabilities,
  RepositoryState,
  RepositoryStatus,
  ScanCandidate,
  StashEntry,
} from '../shared/contracts';
import { api } from './api';
import { autoFetchIntervalLabel, autoFetchIntervals, isAutoFetchDue, parseLastAutoFetchAt } from './auto-fetch';
import { batchRetryConfirmationDetails, batchSignalAriaLabel, retryableBatchRepositoryIds } from './batch-retry';
import { remoteLinks } from './remote-links';
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

const query = useQuery({
  queryKey: ['dashboard'],
  queryFn: api.dashboard,
  refetchInterval: 15_000,
});

const viewPreferencesStorageKey = 'moo-git-fleet:view-preferences:v1';
const autoFetchLastRunStorageKey = 'moo-git-fleet:auto-fetch:last-run:v1';
const autoFetchLeaseStorageKey = 'moo-git-fleet:auto-fetch:lease:v1';
const autoFetchLockName = 'moo-git-fleet:auto-fetch';
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
const fleetPanel = ref<HTMLElement | null>(null);
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
const selectedRepository = ref<RepositoryStatus | null>(null);
const scanRootId = ref('');
const scanCandidates = ref<ScanCandidate[]>([]);
const scanning = ref(false);
const directoryPicking = ref(false);
const savingProfile = ref(false);
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
const branchPanelOpen = ref(false);
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
const fileActionId = ref<string | null>(null);
const fileDiscardId = ref<string | null>(null);
const repositoryStashes = ref<StashEntry[]>([]);
const stashesLoading = ref(false);
const stashBusy = ref<'create' | string | null>(null);
const stashMessage = ref('');
const stashIncludeUntracked = ref(true);
const diffDialog = ref<{ path: string; kind: 'staged' | 'unstaged'; diff: string } | null>(null);
const diffLoading = ref(false);
const commitOpen = ref(false);
const commitData = ref<CommitPreview | null>(null);
const commitMessage = ref('');
const commitSuggestion = ref<CommitSuggestion | null>(null);
const commitPushAfter = ref(false);
const commitBusy = ref(false);
const suggestBusy = ref(false);
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
const notificationPermission = ref<NotificationPermission | 'unsupported'>('unsupported');
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
  notificationsEnabled: false,
  autoFetchIntervalMinutes: 0,
  viewPreferences: { ...cachedViewPreferences },
});

const rootForm = reactive({ id: '', path: '' });
let viewPreferencesHydrated = false;
let persistedViewPreferences = '';
let viewPreferencesSaveChain: Promise<void> = Promise.resolve();

function profileHasUnsavedChanges(saved: ProfileConfig['profile'] | undefined): boolean {
  if (!saved) return false;
  return (
    profileForm.displayName !== saved.displayName ||
    profileForm.preferredCommitLanguage !== saved.preferredCommitLanguage ||
    profileForm.aiCommitMode !== saved.aiCommitMode ||
    profileForm.autoFetchIntervalMinutes !== saved.autoFetchIntervalMinutes ||
    profileForm.notificationsEnabled !== saved.notificationsEnabled
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
    repositoryFiles.value = [];
    repositoryStashes.value = [];
    branchPanelOpen.value = false;
    branchSnapshot.value = null;
    branchSearch.value = '';
    stashMessage.value = '';
    if (repositoryId) {
      void loadRepositoryFiles(repositoryId);
      void loadRepositoryStashes(repositoryId);
    }
  },
);

watch(
  () => operationsQuery.data.value?.batches,
  (batches) => {
    if (!activeBatchId.value) return;
    const batch = batches?.find((item) => item.id === activeBatchId.value);
    if (!batch || batch.state !== 'completed') return;
    actionMessage.value = `批量 ${batch.type.toUpperCase()} 完成：${batch.success} 成功，${batch.skipped} 跳过，${batch.failed} 失败`;
    showBatchNotification(batch);
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
const selectedRemoteCommitUrl = computed(() => {
  const hash = selectedRepository.value?.lastCommit?.hash;
  return hash ? selectedRemoteLinks.value?.commitUrl(hash) ?? null : null;
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
const filteredRepositories = computed(() => {
  const filtered = repositoryFilterContext.value.filter((repository) =>
    matchesRepositoryStateFilter(repository, stateFilter.value),
  );
  if (sortMode.value === 'activity') return filtered;
  return [...filtered].sort((a, b) => {
    if (a.config.pinned !== b.config.pinned) return a.config.pinned ? -1 : 1;
    if (sortMode.value === 'name') return a.config.name.localeCompare(b.config.name);
    if (sortMode.value === 'group') {
      return a.config.group.localeCompare(b.config.group) || a.config.name.localeCompare(b.config.name);
    }
    if (sortMode.value === 'commit') {
      return (
        new Date(b.lastCommit?.committedAt ?? 0).getTime() - new Date(a.lastCommit?.committedAt ?? 0).getTime() ||
        a.config.name.localeCompare(b.config.name)
      );
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
  if (confirmation.value) layers.push(`confirmation:${confirmation.value.id}`);
  return layers;
});
let previousFocusLayers: string[] = [];
const focusReturnTargets = new Map<string, HTMLElement>();

watch(
  activeFocusLayers,
  async (layers) => {
    let sharedDepth = 0;
    while (layers[sharedDepth] && layers[sharedDepth] === previousFocusLayers[sharedDepth]) sharedDepth += 1;
    const removedLayers = previousFocusLayers.slice(sharedDepth).reverse();
    const addedLayers = layers.slice(sharedDepth);
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (const layer of addedLayers) {
      const semanticTarget = focusReturnFallback(layer);
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
const notificationsActive = computed(
  () => profileForm.notificationsEnabled && notificationPermission.value === 'granted',
);
const hasUnsavedProfileChanges = computed(() => profileHasUnsavedChanges(query.data.value?.profile.profile));
const hasUnsavedRepositoryEdit = computed(() =>
  Boolean(repositoryEdit.value && JSON.stringify(repositoryEdit.value) !== repositoryEditSnapshot.value),
);

const notificationDescription = computed(() => {
  if (notificationPermission.value === 'unsupported') return '当前浏览器不支持系统通知';
  if (notificationPermission.value === 'denied') return '浏览器已阻止，请在地址栏权限中重新允许';
  if (profileForm.notificationsEnabled && notificationPermission.value === 'granted') return '批量任务完成后发送桌面通知';
  if (profileForm.notificationsEnabled) return '需要重新授权后才能发送通知';
  return '关闭时只在页面内显示完成消息';
});

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
  'remote-unknown': { label: '远端未知', tone: 'muted' },
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

async function filterFromSummary(filter: RepositoryFilterMode): Promise<void> {
  search.value = '';
  groupFilter.value = null;
  stateFilter.value = filter;
  await nextTick();
  fleetPanel.value?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
}

function showBatchNotification(batch: BatchRecord): void {
  if (!notificationsActive.value) return;
  try {
    const notification = new Notification(`Git Fleet · ${batch.type.toUpperCase()} 完成`, {
      body: `${batch.success} 成功 · ${batch.skipped} 跳过 · ${batch.failed} 失败`,
      icon: '/favicon.svg',
      tag: `git-fleet-batch-${batch.id}`,
    });
    notification.onclick = () => {
      window.focus();
      openHistory();
      notification.close();
    };
  } catch {
    // Notification delivery is best-effort; the in-page result remains authoritative.
  }
}

function syncNotificationPermission(): void {
  notificationPermission.value = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
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
  selectedRepository.value = null;
  manageOpen.value = false;
  historyOpen.value = true;
}

function selectRepository(repository: RepositoryStatus): void {
  historyOpen.value = false;
  selectedRepository.value = repository;
}

function closeDrawers(): void {
  selectedRepository.value = null;
  historyOpen.value = false;
}

async function closeManage(): Promise<void> {
  if (savingProfile.value) return;
  if (hasUnsavedProfileChanges.value) {
    const accepted = await requestConfirmation({
      title: '放弃未保存的个人配置',
      summary: '关闭后，本次尚未保存的个人偏好将恢复为上次保存值。',
      details: ['已添加的仓库和扫描根目录不会受影响。', '已单独保存的通知权限设置也会保留。'],
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
    else if (shortcutHelpOpen.value) shortcutHelpOpen.value = false;
    else if (diffDialog.value) diffDialog.value = null;
    else if (commitOpen.value) void closeCommitDialog();
    else if (repositoryEdit.value) void closeRepositoryEditor();
    else if (manageOpen.value) void closeManage();
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
  try {
    return parseLastAutoFetchAt(localStorage.getItem(autoFetchLastRunStorageKey)) ?? lastAutoFetchAtMemory;
  } catch {
    return lastAutoFetchAtMemory;
  }
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
      forgetAutoFetchAt(now);
      actionError.value = error instanceof Error ? `自动 Fetch 启动失败：${error.message}` : '自动 Fetch 启动失败';
    } finally {
      batchStarting.value = null;
    }
  });
}

function handleWindowFocus(): void {
  syncNotificationPermission();
  void maybeRunAutomaticFetch();
}

watch(
  [configuredAutoFetchInterval, () => repositories.value.length],
  () => void maybeRunAutomaticFetch(),
  { flush: 'post' },
);

onMounted(() => {
  syncNotificationPermission();
  connectOperationsStream();
  autoFetchTimer = window.setInterval(() => void maybeRunAutomaticFetch(), 60_000);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('online', maybeRunAutomaticFetch);
  window.addEventListener('keydown', handleGlobalShortcut);
});
onBeforeUnmount(() => {
  if (confirmation.value) settleConfirmation(false);
  operationsEventSource?.close();
  operationsEventSource = null;
  if (operationsReconnectTimer !== null) window.clearTimeout(operationsReconnectTimer);
  operationsReconnectTimer = null;
  if (autoFetchTimer !== null) window.clearInterval(autoFetchTimer);
  autoFetchTimer = null;
  if (globalToastTimer !== null) window.clearTimeout(globalToastTimer);
  globalToastTimer = null;
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('online', maybeRunAutomaticFetch);
  window.removeEventListener('keydown', handleGlobalShortcut);
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

async function toggleNotifications(): Promise<void> {
  const previous = profileForm.notificationsEnabled;
  syncNotificationPermission();
  if (notificationsActive.value) {
    profileForm.notificationsEnabled = false;
    if (!(await persistProfile('浏览器通知已关闭'))) profileForm.notificationsEnabled = previous;
    return;
  }
  if (typeof Notification === 'undefined') {
    notificationPermission.value = 'unsupported';
    actionError.value = '当前浏览器不支持系统通知';
    return;
  }
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  notificationPermission.value = permission;
  if (permission !== 'granted') {
    actionError.value = permission === 'denied' ? '浏览器已阻止通知，请在地址栏权限中重新允许' : '未获得浏览器通知权限';
    return;
  }
  profileForm.notificationsEnabled = true;
  if (!(await persistProfile('浏览器通知已开启'))) profileForm.notificationsEnabled = previous;
}

async function addRoot(): Promise<void> {
  if (!rootForm.id.trim() || !rootForm.path.trim()) return;
  rootBusy.value = 'add';
  actionError.value = '';
  try {
    await api.addRoot(rootForm.id.trim(), rootForm.path.trim());
    scanRootId.value = rootForm.id.trim();
    rootForm.id = '';
    rootForm.path = '';
    actionMessage.value = '仓库根目录已添加';
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

async function removeRoot(rootId: string): Promise<void> {
  const accepted = await requestConfirmation({
    title: '移除仓库根目录',
    summary: '该根目录将不再用于扫描和发现仓库。',
    target: rootId,
    details: [
      '只删除 Git Fleet 中的根目录配置，不会删除磁盘目录。',
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
    actionMessage.value = `根目录 ${rootId} 已移除`;
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
    actionMessage.value = `${repository.config.name}：${pinned ? '已收藏' : '已取消收藏'}`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '更新收藏状态失败';
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
    if (!accepted) return;
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
    actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Git 操作失败';
  } finally {
    repositoryAction.value = null;
  }
}

async function loadRepositoryBranches(repositoryId: string): Promise<void> {
  branchesLoading.value = true;
  try {
    const snapshot = await api.repositoryBranches(repositoryId);
    if (selectedRepository.value?.config.id === repositoryId) branchSnapshot.value = snapshot;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取本地分支失败';
  } finally {
    branchesLoading.value = false;
  }
}

async function toggleBranchPanel(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  branchPanelOpen.value = !branchPanelOpen.value;
  if (branchPanelOpen.value && !branchSnapshot.value) await loadRepositoryBranches(repository.config.id);
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
  const accepted = await requestConfirmation({
    title: '切换当前工作区分支',
    summary: '服务端会再次复核当前 HEAD、工作区状态和 Worktree 占用。',
    target: `${repository.config.name} · ${snapshot.currentBranch || 'DETACHED'} → ${branch.name}`,
    details: ['不会自动 Stash，也不会携带未提交改动。', '不会强制覆盖文件；不满足安全条件时将拒绝切换。'],
    confirmLabel: '确认切换',
    tone: 'caution',
  });
  if (!accepted) return;

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
    selectedRepository.value = output.result.status;
    repositoryFiles.value = output.result.files;
    branchSnapshot.value = output.result.branches;
    branchPanelOpen.value = false;
    branchSearch.value = '';
    actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '切换分支失败';
    await Promise.all([loadRepositoryBranches(repository.config.id), operationsQuery.refetch()]);
  } finally {
    branchSwitchBusy.value = null;
  }
}

async function openRepository(target: 'finder' | 'terminal' | 'vscode'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  openBusy.value = target;
  actionError.value = '';
  try {
    await api.openRepository(repository.config.id, target);
    actionMessage.value = `${repository.config.name} 已在 ${target === 'finder' ? 'Finder' : target === 'terminal' ? 'Terminal' : 'VS Code'} 打开`;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '打开本地仓库失败';
  } finally {
    openBusy.value = null;
  }
}

async function loadRepositoryFiles(repositoryId: string): Promise<void> {
  filesLoading.value = true;
  try {
    repositoryFiles.value = (await api.repositoryFiles(repositoryId)).files;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取文件状态失败';
  } finally {
    filesLoading.value = false;
  }
}

async function loadRepositoryStashes(repositoryId: string): Promise<void> {
  stashesLoading.value = true;
  try {
    repositoryStashes.value = (await api.repositoryStashes(repositoryId)).stashes;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取 Stash 失败';
  } finally {
    stashesLoading.value = false;
  }
}

async function createRepositoryStash(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
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
  if (!accepted) return;
  stashBusy.value = 'create';
  actionError.value = '';
  try {
    const output = await api.createStash(repository.config.id, stashMessage.value, stashIncludeUntracked.value);
    repositoryStashes.value = output.result.stashes;
    stashMessage.value = '';
    actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    await Promise.all([query.refetch(), operationsQuery.refetch(), loadRepositoryFiles(repository.config.id)]);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '创建 Stash 失败';
  } finally {
    stashBusy.value = null;
  }
}

async function applyRepositoryStash(stash: StashEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const accepted = await requestConfirmation({
    title: '应用 Stash 备份',
    summary: '备份中的改动将恢复到当前干净工作区。',
    target: `${repository.config.name} · ${stash.ref}`,
    details: ['应用后原 Stash 会继续保留。', '如果代码基线已经变化，恢复过程仍可能产生冲突。'],
    confirmLabel: '应用并保留 Stash',
    tone: 'caution',
  });
  if (!accepted) return;
  stashBusy.value = `apply:${stash.hash}`;
  actionError.value = '';
  try {
    const output = await api.applyStash(repository.config.id, stash);
    repositoryStashes.value = output.result.stashes;
    actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    await Promise.all([query.refetch(), operationsQuery.refetch(), loadRepositoryFiles(repository.config.id)]);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '应用 Stash 失败';
    await Promise.all([query.refetch(), loadRepositoryFiles(repository.config.id)]);
  } finally {
    stashBusy.value = null;
  }
}

async function dropRepositoryStash(stash: StashEntry): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  const accepted = await requestConfirmation({
    title: '永久删除 Stash 备份',
    summary: '该备份将从当前仓库永久删除，删除后无法通过 Git Fleet 恢复。',
    target: `${repository.config.name} · ${stash.ref}`,
    details: [stash.message || '该备份没有说明。', '只删除 Stash 条目，不修改当前工作区文件。'],
    confirmLabel: '永久删除备份',
    tone: 'danger',
  });
  if (!accepted) return;
  stashBusy.value = `drop:${stash.hash}`;
  actionError.value = '';
  try {
    const output = await api.dropStash(repository.config.id, stash);
    repositoryStashes.value = output.result.stashes;
    selectedRepository.value = output.result.status;
    actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '删除 Stash 失败';
    await Promise.all([loadRepositoryStashes(repository.config.id), operationsQuery.refetch()]);
  } finally {
    stashBusy.value = null;
  }
}

async function updateFileStage(file: FileChange, action: 'stage' | 'unstage'): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  fileActionId.value = file.id;
  actionError.value = '';
  try {
    const output =
      action === 'stage'
        ? await api.stageFiles(repository.config.id, [file.id])
        : await api.unstageFiles(repository.config.id, [file.id]);
    repositoryFiles.value = output.files;
    actionMessage.value = `${file.path} 已${action === 'stage' ? '暂存' : '取消暂存'}`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '文件操作失败';
  } finally {
    fileActionId.value = null;
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
  if (!repository || !action) return;
  const accepted = await requestConfirmation({
    title: action === 'trash' ? '移到系统废纸篓' : '丢弃本地修改',
    summary: action === 'trash'
      ? '未跟踪文件将从仓库工作区移除。'
      : '文件会立即恢复到当前 Git 版本。',
    target: file.path,
    details: action === 'trash'
      ? ['文件会进入 macOS 废纸篓，之后仍可手动恢复。', `操作范围仅限 ${repository.config.name} 中的这个文件。`]
      : ['未暂存的本地修改将永久丢失。', '该修改不会进入废纸篓，也不会影响已暂存内容。'],
    confirmLabel: action === 'trash' ? '移到废纸篓' : '永久丢弃修改',
    tone: 'danger',
  });
  if (!accepted) return;
  fileDiscardId.value = file.id;
  actionError.value = '';
  try {
    const output = await api.discardFile(repository.config.id, file.id);
    repositoryFiles.value = output.files;
    actionMessage.value = output.result.action === 'trash'
      ? `${output.result.path} 已移到废纸篓`
      : `${output.result.path} 的本地修改已丢弃`;
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '文件清理失败';
    await loadRepositoryFiles(repository.config.id);
  } finally {
    fileDiscardId.value = null;
  }
}

async function showFileDiff(file: FileChange): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository || file.untracked) return;
  const kind: 'staged' | 'unstaged' = file.unstaged ? 'unstaged' : 'staged';
  diffLoading.value = true;
  actionError.value = '';
  try {
    const output = await api.fileDiff(repository.config.id, file.id, kind);
    diffDialog.value = { path: output.path, kind, diff: output.diff || '该文件没有可显示的文本 diff。' };
    await nextTick();
    focusInitialControl();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '读取 diff 失败';
  } finally {
    diffLoading.value = false;
  }
}

async function openCommitDialog(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  commitBusy.value = true;
  actionError.value = '';
  try {
    commitData.value = await api.commitPreview(repository.config.id);
    commitMessage.value = '';
    commitSuggestion.value = null;
    commitPushAfter.value = false;
    commitOpen.value = true;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Commit 预览失败';
  } finally {
    commitBusy.value = false;
    if (commitOpen.value) {
      await nextTick();
      focusInitialControl();
    }
  }
}

async function generateCommitSuggestion(): Promise<void> {
  const repository = selectedRepository.value;
  if (!repository) return;
  suggestBusy.value = true;
  actionError.value = '';
  try {
    commitSuggestion.value = await api.suggestCommit(repository.config.id);
    commitMessage.value = commitSuggestion.value.message;
    if (commitData.value) commitData.value.fingerprint = commitSuggestion.value.fingerprint;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '生成 Commit 文案失败';
  } finally {
    suggestBusy.value = false;
  }
}

async function closeCommitDialog(): Promise<void> {
  if (commitBusy.value || suggestBusy.value || !commitOpen.value) return;
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
}

async function submitCommit(auto: boolean): Promise<void> {
  const repository = selectedRepository.value;
  const preview = commitData.value;
  if (!repository || !preview) return;
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
  if (!accepted) return;
  commitBusy.value = true;
  actionError.value = '';
  try {
    const output = auto
      ? await api.autoCommit(repository.config.id, preview.fingerprint, commitPushAfter.value)
      : await api.commit(repository.config.id, commitMessage.value, preview.fingerprint, commitPushAfter.value);
    actionMessage.value = `${repository.config.name}：${output.message}`;
    commitOpen.value = false;
    commitData.value = null;
    commitMessage.value = '';
    commitPushAfter.value = false;
    await query.refetch();
    await loadRepositoryFiles(repository.config.id);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Commit 失败';
  } finally {
    commitBusy.value = false;
  }
}
</script>

<template>
  <div class="app-shell">
    <div class="ambient ambient-one" />
    <div class="ambient ambient-two" />

    <header class="topbar">
      <div class="brand-lockup">
        <img class="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
        <div>
          <h1>Git Fleet</h1>
        </div>
      </div>

      <div class="topbar-actions">
        <div class="local-signal" :data-state="query.error.value ? 'error' : query.isFetching.value ? 'busy' : 'ready'" aria-live="polite">
          <span class="signal-dot" />
          {{ query.error.value ? 'LOCAL API / ERROR' : query.isFetching.value ? 'LOCAL API / SCANNING' : 'LOCAL API / READY' }}
        </div>
        <button class="secondary-button topbar-history" title="操作记录" aria-label="打开操作记录" data-focus-return="history" @click="openHistory"><History :size="16" /><span>操作记录</span></button>
        <button class="icon-button topbar-shortcuts" title="快捷键帮助" aria-label="快捷键帮助" data-focus-return="shortcuts" @click="shortcutHelpOpen = true"><Keyboard :size="18" /></button>
        <button class="icon-button topbar-settings" title="管理仓库" aria-label="管理仓库" data-focus-return="manage" @click="manageOpen = true"><Settings2 :size="18" /></button>
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
        <button class="profile-chip" aria-label="打开个人配置" data-focus-return="manage" @click="manageOpen = true">
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

      <section ref="fleetPanel" class="fleet-panel">
        <div class="panel-heading">
          <div class="panel-title">
            <h2>仓库工作台</h2>
            <div class="panel-context">
              <p aria-live="polite">
                显示 <strong>{{ filteredRepositories.length }}</strong> / {{ repositories.length }} 个仓库
                <span v-if="activeRepositoryFilterLabel">· {{ activeRepositoryFilterLabel }}</span>
              </p>
              <button v-if="hasRepositoryFilters" @click="resetRepositoryFilters"><RotateCcw :size="11" />重置条件</button>
            </div>
          </div>
          <div class="panel-controls">
            <select v-model="sortMode" class="sort-select" aria-label="仓库排序">
              <option value="activity">动静优先</option>
              <option value="name">按名称</option>
              <option value="group">按分组</option>
              <option value="commit">最近提交</option>
              <option value="fetch">最近 Fetch</option>
            </select>
            <select v-model="groupFilter" class="group-select" aria-label="仓库分组筛选">
              <option :value="null">全部分组 · {{ repositories.length }}</option>
              <option v-for="group in repositoryGroups" :key="group.name" :value="group.name">{{ group.name }} · {{ group.count }}</option>
            </select>
            <div class="search-field" role="search">
              <Search :size="16" />
              <input ref="searchInput" v-model="search" aria-label="搜索仓库、路径或标签" placeholder="搜索仓库、路径或标签" @keydown.esc.stop="search = ''" />
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
          <button class="primary-button" data-focus-return="manage" @click="manageOpen = true"><Plus :size="16" />添加仓库</button>
        </div>
        <div v-else class="table-wrap">
          <table class="repo-table">
            <caption class="sr-only">已配置 Git 仓库的状态、分支、工作区变化与远端差异</caption>
            <thead>
              <tr>
                <th class="sequence-column">#</th>
                <th class="pin-column"><span class="sr-only">收藏</span></th>
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
                    :title="repository.config.pinned ? '取消收藏' : '收藏'"
                    :aria-label="`${repository.config.pinned ? '取消收藏' : '收藏'} ${repository.config.name}`"
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
                  <div class="cell-muted">{{ repository.upstream || '无 upstream' }}</div>
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
                  <span class="status-pill" :data-tone="statusMeta[repository.state].tone"><span />{{ statusMeta[repository.state].label }}</span>
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
                :aria-label="selectedRepository.config.pinned ? '取消收藏仓库' : '收藏仓库'"
                :aria-pressed="selectedRepository.config.pinned"
                :title="selectedRepository.config.pinned ? '取消收藏' : '收藏仓库'"
                :disabled="pinBusyId !== null"
                @click="togglePinned(selectedRepository)"
              ><LoaderCircle v-if="pinBusyId === selectedRepository.config.id" :size="14" class="spinning" /><Pin v-else :size="15" /></button>
              <h2 :id="`repo-drawer-title-${selectedRepository.config.id}`">{{ selectedRepository.config.name }}</h2>
              <span class="repository-state-chip" :data-tone="statusMeta[selectedRepository.state].tone"><i />{{ statusMeta[selectedRepository.state].label }}</span>
            </div>
            <div class="drawer-header-signals">
              <button
                class="header-signal-branch branch-trigger"
                :class="{ active: branchPanelOpen }"
                :aria-expanded="branchPanelOpen"
                aria-controls="repository-branch-switcher"
                title="查看并切换本地分支"
                @click="toggleBranchPanel"
              ><GitBranch :size="12" />{{ selectedRepository.branch || 'DETACHED' }}<ChevronDown :size="12" /></button>
              <span class="header-signal-changes"><CircleDot :size="12" />{{ selectedRepository.staged + selectedRepository.modified + selectedRepository.untracked + selectedRepository.conflicted }} 项改动</span>
              <span class="header-signal-ahead" title="待推送提交"><ArrowUp :size="12" />{{ selectedRepository.ahead ?? '—' }}</span>
              <span class="header-signal-behind" title="待拉取提交"><ArrowDown :size="12" />{{ selectedRepository.behind ?? '—' }}</span>
              <span class="header-signal-fetch" title="最近一次 Fetch"><RefreshCw :size="12" />Fetch {{ selectedRepository.lastFetchedAt ? relativeTime(selectedRepository.lastFetchedAt) : '未知' }}</span>
              <span class="header-signal-stash" title="Stash 备份数量"><Archive :size="12" />Stash {{ selectedRepository.stashCount }}</span>
              <span class="header-signal-scan" title="最近一次本地扫描"><Clock3 :size="12" />扫描 {{ relativeTime(selectedRepository.scannedAt) }}</span>
            </div>
          </div>
          <button class="icon-button" title="关闭仓库详情" aria-label="关闭仓库详情" data-dialog-initial @click="closeDrawers"><X :size="18" /></button>
        </div>
        <section v-if="branchPanelOpen" id="repository-branch-switcher" class="branch-switcher" aria-label="切换本地分支">
          <div class="branch-switcher-heading">
            <div><strong>切换本地分支</strong><span>只允许干净工作区；不会自动 Stash 或强制覆盖。</span></div>
            <button class="table-icon-button" title="刷新分支" aria-label="刷新分支" :disabled="branchesLoading || branchSwitchBusy !== null" @click="loadRepositoryBranches(selectedRepository.config.id)"><RefreshCw :size="14" :class="{ spinning: branchesLoading }" /></button>
          </div>
          <p v-if="branchPanelBlocker" class="branch-panel-blocker" role="status"><AlertTriangle :size="13" />{{ branchPanelBlocker }}</p>
          <div v-if="branchSnapshot && branchSnapshot.branches.length > 6" class="branch-search">
            <Search :size="14" /><input v-model="branchSearch" aria-label="搜索本地分支" placeholder="搜索分支或 upstream" />
            <button v-if="branchSearch" title="清除分支搜索" aria-label="清除分支搜索" @click="branchSearch = ''"><X :size="13" /></button>
          </div>
          <div class="branch-list">
            <div v-if="branchesLoading && !branchSnapshot" class="branch-list-state"><LoaderCircle :size="16" class="spinning" />读取本地分支…</div>
            <div v-else-if="filteredLocalBranches.length === 0" class="branch-list-state"><GitBranch :size="16" />没有匹配的本地分支</div>
            <button
              v-for="branch in filteredLocalBranches"
              v-else
              :key="branch.name"
              class="branch-option"
              :class="{ current: branch.current, occupied: Boolean(branch.worktreePath && !branch.current) }"
              :disabled="Boolean(branchSwitchBlocker(branch)) || branchSwitchBusy !== null || repositoryAction !== null"
              :title="branchSwitchBlocker(branch) || `切换到 ${branch.name}`"
              @click="switchRepositoryBranch(branch)"
            >
              <span class="branch-option-icon"><LoaderCircle v-if="branchSwitchBusy === branch.name" :size="15" class="spinning" /><Check v-else-if="branch.current" :size="15" /><GitBranch v-else :size="15" /></span>
              <span class="branch-option-copy"><strong>{{ branch.name }}</strong><small>{{ branch.upstream || '无 upstream' }}</small></span>
              <span v-if="branch.current" class="branch-option-state">CURRENT</span>
              <span v-else-if="branch.worktreePath" class="branch-option-state occupied">WORKTREE</span>
              <span v-else class="branch-option-divergence"><ArrowUp :size="11" />{{ branch.ahead ?? '—' }}<ArrowDown :size="11" />{{ branch.behind ?? '—' }}</span>
            </button>
          </div>
        </section>
        <div class="drawer-section" data-accent="yellow">
          <div class="drawer-section-title">工作区信号</div>
          <div class="signal-grid">
            <div><span>Staged</span><strong>{{ selectedRepository.staged }}</strong></div>
            <div><span>Modified</span><strong>{{ selectedRepository.modified }}</strong></div>
            <div><span>Untracked</span><strong>{{ selectedRepository.untracked }}</strong></div>
            <div><span>Conflicts</span><strong>{{ selectedRepository.conflicted }}</strong></div>
          </div>
        </div>
        <div class="drawer-section" data-accent="green">
          <div class="drawer-section-heading safety-section-heading">
            <div class="drawer-section-title">安全操作</div>
            <span class="section-inline-hint">Pull 仅 fast-forward；Push 会先 Fetch 且永不 force。</span>
            <div class="section-inline-blockers">
              <span v-if="!pullAvailability.available && (selectedRepository.behind ?? 0) > 0" class="section-inline-blocker"><AlertTriangle :size="11" />Pull：{{ pullAvailability.detail }}</span>
              <span v-if="!pushAvailability.available && (selectedRepository.ahead ?? 0) > 0" class="section-inline-blocker"><AlertTriangle :size="11" />Push：{{ pushAvailability.detail }}</span>
            </div>
          </div>
          <div class="git-action-grid">
            <button
              class="secondary-button"
              :disabled="repositoryAction !== null || !selectedRepository.config.capabilities.fetch"
              @click="runRepositoryAction('fetch')"
            ><LoaderCircle v-if="repositoryAction === 'fetch'" :size="16" class="spinning" /><RefreshCw v-else :size="16" />Fetch</button>
            <button
              class="secondary-button"
              :disabled="repositoryAction !== null || !pullAvailability.available"
              :title="pullAvailability.detail"
              @click="runRepositoryAction('pull')"
            ><LoaderCircle v-if="repositoryAction === 'pull'" :size="16" class="spinning" /><ArrowDown v-else :size="16" />安全 Pull</button>
            <button
              class="secondary-button"
              :disabled="repositoryAction !== null || !pushAvailability.available"
              :title="pushAvailability.detail"
              @click="runRepositoryAction('push')"
            ><LoaderCircle v-if="repositoryAction === 'push'" :size="16" class="spinning" /><ArrowUp v-else :size="16" />安全 Push</button>
          </div>
        </div>
        <div class="drawer-section" data-accent="blue">
          <div class="drawer-section-heading">
            <div class="drawer-section-title">文件变化</div>
            <button
              class="compact-button"
              data-focus-return="commit"
              :disabled="selectedRepository.staged === 0 || commitBusy"
              @click="openCommitDialog"
            ><LoaderCircle v-if="commitBusy" :size="14" class="spinning" /><GitCommitHorizontal v-else :size="14" />Commit {{ selectedRepository.staged || '' }}</button>
          </div>
          <div class="file-list">
            <div v-if="filesLoading" class="file-empty"><LoaderCircle :size="16" class="spinning" />读取文件状态…</div>
            <div v-else-if="repositoryFiles.length === 0" class="file-empty"><Check :size="16" />工作区干净</div>
            <div v-for="file in repositoryFiles" v-else :key="file.id" class="file-row">
              <button class="file-path" :data-focus-return="`diff:${file.path}`" :disabled="file.untracked || diffLoading" @click="showFileDiff(file)">
                <span class="file-status" :class="{ staged: file.staged, conflict: file.conflicted }">{{ file.untracked ? 'U' : file.indexStatus !== ' ' ? file.indexStatus : file.worktreeStatus }}</span>
                <span>{{ file.path }}</span>
              </button>
              <button
                v-if="fileDiscardAction(file)"
                class="file-action file-discard"
                :class="{ trash: fileDiscardAction(file) === 'trash' }"
                :disabled="fileDiscardId !== null || fileActionId !== null || !selectedRepository.config.capabilities.stage"
                :title="fileDiscardAction(file) === 'trash' ? '移到废纸篓' : '丢弃本地修改'"
                :aria-label="`${fileDiscardAction(file) === 'trash' ? '移到废纸篓' : '丢弃本地修改'} ${file.path}`"
                @click="discardRepositoryFile(file)"
              ><LoaderCircle v-if="fileDiscardId === file.id" :size="13" class="spinning" /><Trash2 v-else-if="fileDiscardAction(file) === 'trash'" :size="13" /><RotateCcw v-else :size="13" /></button>
              <button
                v-if="file.staged"
                class="file-action"
                :disabled="fileActionId === file.id"
                title="取消暂存"
                :aria-label="`取消暂存 ${file.path}`"
                @click="updateFileStage(file, 'unstage')"
              ><LoaderCircle v-if="fileActionId === file.id" :size="13" class="spinning" /><Minus v-else :size="13" /></button>
              <button
                v-else
                class="file-action"
                :disabled="fileActionId === file.id"
                title="暂存"
                :aria-label="`暂存 ${file.path}`"
                @click="updateFileStage(file, 'stage')"
              ><LoaderCircle v-if="fileActionId === file.id" :size="13" class="spinning" /><Plus v-else :size="13" /></button>
            </div>
          </div>
        </div>
        <details class="drawer-section stash-section" data-accent="purple">
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
        <div class="drawer-section" data-accent="cyan">
          <div class="drawer-section-title">最近提交</div>
          <div class="commit-card">
            <GitCommitHorizontal :size="18" />
            <div><strong>{{ selectedRepository.lastCommit?.subject || '暂无提交' }}</strong><span>{{ selectedRepository.lastCommit?.author || '—' }} · {{ relativeTime(selectedRepository.lastCommit?.committedAt) }}</span></div>
            <a
              v-if="selectedRemoteCommitUrl"
              class="commit-link"
              :href="selectedRemoteCommitUrl"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="`在 ${selectedRemoteLinks?.provider || '远端'} 查看 ${selectedRepository.config.name} 最近提交`"
            ><ExternalLink :size="13" />查看提交</a>
          </div>
        </div>
        <div v-if="selectedRepository.error" class="drawer-error"><AlertTriangle :size="16" />{{ selectedRepository.error }}</div>
        <div class="repository-context repository-context-bottom">
          <dl class="detail-grid">
            <div><dt>LOCAL PATH</dt><dd class="copyable-value"><span :title="selectedRepository.absolutePath">{{ selectedRepository.absolutePath }}</span><button title="复制本地路径" aria-label="复制本地路径" @click="copyToClipboard(selectedRepository.absolutePath, '本地路径')"><Copy :size="12" /></button></dd></div>
            <div><dt>BRANCH / UPSTREAM</dt><dd>{{ selectedRepository.branch || 'DETACHED HEAD' }} · {{ selectedRepository.upstream || '未配置' }}</dd></div>
            <div><dt>REMOTE URL</dt><dd class="copyable-value"><span :title="selectedRepository.remoteUrl || '未配置'">{{ selectedRepository.remoteUrl || '未配置' }}</span><a v-if="selectedRemoteLinks" class="metadata-link" :href="selectedRemoteLinks.repositoryUrl" target="_blank" rel="noopener noreferrer" :aria-label="`在 ${selectedRemoteLinks.provider} 打开 ${selectedRepository.config.name}`"><ExternalLink :size="12" />{{ selectedRemoteLinks.provider }} 主页</a><button title="复制 Remote URL" aria-label="复制 Remote URL" :disabled="!selectedRepository.remoteUrl" @click="copyToClipboard(selectedRepository.remoteUrl, 'Remote URL')"><Copy :size="12" /></button></dd></div>
          </dl>
          <div class="repository-dock" :data-identity-complete="selectedRepository.gitIdentity.complete">
            <div class="dock-identity">
              <span class="identity-icon"><UserRound :size="16" /></span>
              <div>
                <span>COMMIT IDENTITY</span>
                <strong>{{ selectedRepository.gitIdentity.name || '未配置 user.name' }}</strong>
                <code>{{ selectedRepository.gitIdentity.email || '未配置 user.email' }}</code>
              </div>
              <span class="identity-state">{{ selectedRepository.gitIdentity.complete ? 'READY' : 'CHECK' }}</span>
            </div>
            <div class="dock-local-actions">
              <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('finder')"><LoaderCircle v-if="openBusy === 'finder'" :size="14" class="spinning" /><FolderGit2 v-else :size="14" />Finder</button>
              <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('terminal')"><LoaderCircle v-if="openBusy === 'terminal'" :size="14" class="spinning" /><TerminalSquare v-else :size="14" />Terminal</button>
              <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('vscode')"><LoaderCircle v-if="openBusy === 'vscode'" :size="14" class="spinning" /><Code2 v-else :size="14" />VS Code</button>
              <button class="secondary-button" @click="copyToClipboard(cdCommand(selectedRepository.absolutePath), 'cd 命令')"><Copy :size="14" />复制 cd</button>
            </div>
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
          <button class="icon-button" title="关闭操作记录" aria-label="关闭操作记录" data-dialog-initial @click="closeDrawers"><X :size="18" /></button>
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
            v-for="operation in filteredOperations"
            v-else
            :key="operation.id"
            class="operation-row"
            :data-state="operation.state"
          >
            <span class="operation-state-dot" />
            <div class="operation-main">
              <div><button class="operation-repository-link" @click="openOperationRepository(operation)">{{ operation.repositoryName }}</button><span>{{ operationTypeLabel(operation.type) }}</span></div>
              <p>{{ operation.message }}</p>
            </div>
            <div class="operation-meta">
              <span>{{ operationStateLabel(operation.state) }}</span>
              <time>{{ operation.finishedAt ? relativeTime(operation.finishedAt) : operation.startedAt ? '执行中' : '等待中' }}</time>
              <button
                v-if="['failed', 'skipped'].includes(operation.state) && ['fetch', 'pull', 'push'].includes(operation.type)"
                class="operation-retry"
                title="安全重试"
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
              <p>所有配置仅保存在这台电脑，移出列表不会删除任何代码。</p>
            </div>
            <button class="icon-button" title="关闭管理仓库" aria-label="关闭管理仓库" @click="closeManage"><X :size="18" /></button>
          </div>

          <div class="setup-scroll">
            <div class="setup-grid">
              <section class="setup-card profile-card">
              <div class="card-heading"><UserRound :size="18" /><div><strong>本机个人信息</strong><span>用于界面和 AI Commit 偏好</span></div></div>
              <label class="form-field"><span>显示名称</span><input v-model="profileForm.displayName" data-dialog-initial /></label>
              <label class="form-field"><span>Commit 语言</span><select v-model="profileForm.preferredCommitLanguage"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
              <label class="form-field"><span>AI Commit 模式</span><select v-model="profileForm.aiCommitMode"><option value="review">生成后确认</option><option value="auto-commit">一键生成并提交</option></select></label>
              <div class="auto-fetch-preference" :data-enabled="profileForm.autoFetchIntervalMinutes !== 0">
                <span class="preference-icon"><RefreshCw :size="16" /></span>
                <div><strong>自动 Fetch</strong><span>{{ autoFetchDescription }}</span></div>
                <select v-model.number="profileForm.autoFetchIntervalMinutes" aria-label="自动 Fetch 周期">
                  <option v-for="interval in autoFetchIntervals" :key="interval" :value="interval">{{ autoFetchIntervalLabel(interval) }}</option>
                </select>
              </div>
              <div class="theme-preview"><span class="theme-orb"><Sparkles :size="15" /></span><div><strong>Moon / One Dark Pro</strong><span>默认本地工程主题</span></div><Check :size="17" /></div>
              <div
                class="notification-preference"
                :data-enabled="notificationsActive"
                :data-blocked="notificationPermission === 'denied' || notificationPermission === 'unsupported'"
              >
                <span class="preference-icon"><Bell v-if="notificationsActive" :size="16" /><BellOff v-else :size="16" /></span>
                <div><strong>批量完成通知</strong><span>{{ notificationDescription }}</span></div>
                <button
                  class="preference-toggle"
                  type="button"
                  :aria-pressed="notificationsActive"
                  :disabled="savingProfile || notificationPermission === 'unsupported'"
                  @click="toggleNotifications"
                ><span />{{ notificationsActive ? '已开启' : profileForm.notificationsEnabled ? '重新授权' : '开启' }}</button>
              </div>
              <button class="secondary-button full-width" :disabled="savingProfile" @click="saveProfile"><LoaderCircle v-if="savingProfile" :size="16" class="spinning" /><Check v-else :size="16" />保存个人配置</button>
              </section>

              <section class="setup-card repositories-card">
              <div class="card-heading"><Code2 :size="18" /><div><strong>添加本地仓库</strong><span>只扫描允许的根目录</span></div></div>
              <div class="repository-step-heading"><span>01</span><strong>配置扫描根目录</strong><small>选择电脑中的项目上级目录</small></div>
              <div class="root-manager">
                <div class="root-list">
                  <div v-for="(rootPath, rootId) in query.data.value?.roots" :key="rootId" class="root-row">
                    <span>{{ rootId }}</span><code>{{ rootPath }}</code><small>{{ rootUsageCount(String(rootId)) }} 仓库</small>
                    <button
                      class="table-icon-button"
                      title="移除根目录"
                      :aria-label="`移除根目录 ${String(rootId)}`"
                      :disabled="rootUsageCount(String(rootId)) > 0 || rootBusy !== null"
                      @click="removeRoot(String(rootId))"
                    ><LoaderCircle v-if="rootBusy === rootId" :size="13" class="spinning" /><Trash2 v-else :size="13" /></button>
                  </div>
                </div>
                <div class="root-add-row">
                  <input v-model="rootForm.id" aria-label="根目录标识" placeholder="标识，如 work" />
                  <div class="root-path-control">
                    <input v-model="rootForm.path" aria-label="根目录绝对路径" placeholder="本地绝对路径" @keydown.enter="addRoot" />
                    <button
                      type="button"
                      class="directory-picker-button"
                      :disabled="directoryPicking || rootBusy !== null"
                      title="从电脑选择文件夹"
                      @click="chooseRootDirectory"
                    ><LoaderCircle v-if="directoryPicking" :size="14" class="spinning" /><FolderOpen v-else :size="14" />浏览</button>
                  </div>
                  <button class="compact-button" :disabled="rootBusy !== null || !rootForm.id.trim() || !rootForm.path.trim()" @click="addRoot"><LoaderCircle v-if="rootBusy === 'add'" :size="13" class="spinning" /><Plus v-else :size="13" />添加根目录</button>
                </div>
              </div>
              <div class="repository-step-heading"><span>02</span><strong>扫描并接入仓库</strong><small>扫描后按需加入工作台</small></div>
              <div class="scan-toolbar">
                <select v-model="scanRootId" aria-label="选择扫描根目录">
                  <option v-for="(rootPath, rootId) in query.data.value?.roots" :key="rootId" :value="rootId">{{ rootId }} · {{ rootPath }}</option>
                </select>
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
            <span v-if="hasUnsavedProfileChanges" class="setup-unsaved"><CircleDot :size="14" />个人配置有未保存更改</span>
            <span v-else><Minus :size="14" />配置文件位于本机 config/，不会上传个人路径</span>
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
      <div v-if="diffDialog" class="modal-backdrop" @click.self="diffDialog = null">
        <section class="code-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div><div class="section-kicker">{{ diffDialog.kind === 'staged' ? '已暂存差异' : '未暂存差异' }}</div><h2 id="diff-title">{{ diffDialog.path }}</h2></div>
            <button class="icon-button" title="关闭 Diff 预览" aria-label="关闭 Diff 预览" data-dialog-initial @click="diffDialog = null"><X :size="18" /></button>
          </div>
          <pre class="diff-view"><code>{{ diffDialog.diff }}</code></pre>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="commitOpen && commitData" class="modal-backdrop" @click.self="closeCommitDialog">
        <section class="commit-modal" role="dialog" aria-modal="true" aria-labelledby="commit-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div class="commit-modal-title"><h2 id="commit-title">{{ selectedRepository?.config.name }}</h2><span v-if="hasCommitDraft"><CircleDot :size="11" />草稿</span></div>
            <button class="icon-button" title="关闭 Commit 弹窗" aria-label="关闭 Commit 弹窗" :disabled="commitBusy || suggestBusy" @click="closeCommitDialog"><X :size="18" /></button>
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
                <textarea v-model="commitMessage" data-dialog-initial placeholder="填写文案，或让 DeepSeek / 本地规则生成" />
              </label>
              <div v-if="commitSuggestion" class="suggestion-meta">
                <Sparkles :size="15" /><div><strong>{{ commitSuggestion.source }}</strong><span>{{ commitSuggestion.summary }}</span></div>
              </div>
              <button class="secondary-button full-width" :disabled="suggestBusy || commitBusy" @click="generateCommitSuggestion">
                <LoaderCircle v-if="suggestBusy" :size="16" class="spinning" /><Bot v-else :size="16" />生成 Commit 文案
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
                <button class="secondary-button" :disabled="commitBusy || !commitMessage.trim()" @click="submitCommit(false)"><GitCommitHorizontal :size="16" />确认提交</button>
                <button class="primary-button" :disabled="commitBusy" @click="submitCommit(true)"><LoaderCircle v-if="commitBusy" :size="16" class="spinning" /><Sparkles v-else :size="16" />生成并提交</button>
              </div>
              <p class="action-hint">只提交当前 staged 内容，不会自动 Stage。后置 Push 失败时 Commit 仍安全保留在本地。</p>
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
        <button aria-label="关闭通知" @click="dismissGlobalToast"><X :size="14" /></button>
        <i class="toast-progress" aria-hidden="true" />
      </div>
    </transition>
  </div>
</template>
