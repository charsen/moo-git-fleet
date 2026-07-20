<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  Activity,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FileText,
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
  RepositoryManifestCandidate,
  RepositoryManifestPreview,
  RepositoryState,
  RepositoryStatus,
  ScanCandidate,
  StashEntry,
} from '../shared/contracts';
import { api } from './api';
import { autoFetchIntervalLabel, autoFetchIntervals, isAutoFetchDue, parseLastAutoFetchAt } from './auto-fetch';
import { remoteLinks } from './remote-links';
import { cdCommand } from './shell-command';
import {
  hasWorktreeChanges,
  isRemoteStale,
  matchesRepositoryStateFilter,
  repositoryFilterCounts,
} from './repository-signals';
import { defaultViewPreferences, parseViewPreferences } from './view-preferences';

const queryClient = useQueryClient();
const operationsStreamConnected = ref(false);
let operationsEventSource: EventSource | null = null;
let operationsReconnectTimer: number | null = null;
let autoFetchTimer: number | null = null;

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
const shortcutHelpOpen = ref(false);
const manageOpen = ref(false);
const historyOpen = ref(false);
const selectedRepository = ref<RepositoryStatus | null>(null);
const scanRootId = ref('');
const scanCandidates = ref<ScanCandidate[]>([]);
const scanning = ref(false);
const repositoryDiscoveryMode = ref<'scan' | 'manifest'>('scan');
const manifestPath = ref('/Volumes/dev/wwwroot/wisdomcity/PACKAGES.md');
const manifestPreview = ref<RepositoryManifestPreview | null>(null);
const manifestSelectedKeys = ref<string[]>([]);
const manifestBusy = ref<'preview' | 'import' | null>(null);
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
const repositoryEditBusy = ref(false);
const repositoryAction = ref<'fetch' | 'pull' | 'push' | null>(null);
const openBusy = ref<'finder' | 'terminal' | 'vscode' | null>(null);
const batchStarting = ref<BatchOperationType | null>(null);
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
const actionError = ref('');
const actionMessage = ref('');
const notificationPermission = ref<NotificationPermission | 'unsupported'>('unsupported');

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
    Object.assign(profileForm, dashboard.profile.profile);
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
const selectedRemoteCommitUrl = computed(() => {
  const hash = selectedRepository.value?.lastCommit?.hash;
  return hash ? selectedRemoteLinks.value?.commitUrl(hash) ?? null : null;
});
const configuredAutoFetchInterval = computed<AutoFetchIntervalMinutes>(
  () => query.data.value?.profile.profile.autoFetchIntervalMinutes ?? 0,
);
const selectedManifestCandidates = computed(() => {
  const selected = new Set(manifestSelectedKeys.value);
  return (manifestPreview.value?.candidates ?? []).filter(
    (candidate) => candidate.status === 'ready' && selected.has(manifestCandidateKey(candidate)),
  );
});
const filteredRepositories = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  const filtered = repositories.value.filter((repository) => {
    const matchesKeyword =
      !keyword ||
      [repository.config.name, repository.config.group, repository.config.path, ...repository.config.tags]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    const matchesState = matchesRepositoryStateFilter(repository, stateFilter.value);
    const matchesGroup = groupFilter.value === null || repository.config.group === groupFilter.value;
    return matchesKeyword && matchesState && matchesGroup;
  });
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
  attention: repositories.value.filter(
    (repository) => repository.state !== 'clean' || !repository.gitIdentity.complete || isRemoteStale(repository),
  ).length,
  dirty: repositories.value.filter(hasWorktreeChanges).length,
  ahead: repositories.value.reduce((total, repository) => total + (repository.ahead ?? 0), 0),
  behind: repositories.value.reduce((total, repository) => total + (repository.behind ?? 0), 0),
}));
const filterCounts = computed(() => repositoryFilterCounts(repositories.value));
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

const activeCommitAiPolicy = computed(() => commitSuggestion.value?.aiPolicy ?? commitData.value?.aiPolicy ?? null);
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
  return type === 'commit' ? 'COMMIT' : type.toUpperCase();
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

async function filterFromSummary(filter: RepositoryFilterMode): Promise<void> {
  search.value = '';
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
    const safety = type === 'pull' ? '仍然只允许 fast-forward' : '仍会先 Fetch 且不会 force';
    if (!window.confirm(`重试 ${operation.repositoryName} 的 ${type.toUpperCase()}？${safety}。`)) return;
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
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getAttribute('aria-hidden') !== 'true');
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
    if (shortcutHelpOpen.value) shortcutHelpOpen.value = false;
    else if (diffDialog.value) diffDialog.value = null;
    else if (commitOpen.value) commitOpen.value = false;
    else if (repositoryEdit.value) repositoryEdit.value = null;
    else if (manageOpen.value) manageOpen.value = false;
    else closeDrawers();
    return;
  }
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
  operationsEventSource?.close();
  operationsEventSource = null;
  if (operationsReconnectTimer !== null) window.clearTimeout(operationsReconnectTimer);
  operationsReconnectTimer = null;
  if (autoFetchTimer !== null) window.clearInterval(autoFetchTimer);
  autoFetchTimer = null;
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('online', maybeRunAutomaticFetch);
  window.removeEventListener('keydown', handleGlobalShortcut);
});

async function refresh(): Promise<void> {
  actionError.value = '';
  await query.refetch();
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

async function removeRoot(rootId: string): Promise<void> {
  if (!window.confirm(`移除根目录 ${rootId}？只删除 Fleet 配置，不会删除磁盘目录。`)) return;
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

function manifestCandidateKey(candidate: RepositoryManifestCandidate): string {
  return candidate.rootId && candidate.relativePath
    ? `${candidate.rootId}:${candidate.relativePath}`
    : `${candidate.status}:${candidate.name}`;
}

async function previewRepositoryManifest(): Promise<void> {
  if (!manifestPath.value.trim()) return;
  manifestBusy.value = 'preview';
  actionError.value = '';
  try {
    const preview = await api.previewRepositoryManifest(manifestPath.value.trim());
    manifestPreview.value = preview;
    manifestPath.value = preview.sourcePath;
    manifestSelectedKeys.value = preview.candidates
      .filter((candidate) => candidate.status === 'ready')
      .map(manifestCandidateKey);
    actionMessage.value = `清单识别 ${preview.total} 个仓库：${preview.ready} 个可导入，${preview.existing} 个已存在，${preview.missing + preview.ambiguous + preview.mismatch} 个需处理`;
  } catch (error) {
    manifestPreview.value = null;
    manifestSelectedKeys.value = [];
    actionError.value = error instanceof Error ? error.message : '清单预览失败';
  } finally {
    manifestBusy.value = null;
  }
}

function toggleAllManifestCandidates(): void {
  const ready = (manifestPreview.value?.candidates ?? [])
    .filter((candidate) => candidate.status === 'ready')
    .map(manifestCandidateKey);
  manifestSelectedKeys.value = manifestSelectedKeys.value.length === ready.length ? [] : ready;
}

async function importRepositoryManifest(): Promise<void> {
  const candidates = selectedManifestCandidates.value;
  if (!manifestPreview.value || candidates.length === 0) return;
  if (!window.confirm(`确认将 ${candidates.length} 个仓库加入工作台？只修改 Git Fleet 配置，不会更改磁盘代码。`)) return;
  manifestBusy.value = 'import';
  actionError.value = '';
  try {
    const result = await api.importRepositoryManifest(
      manifestPreview.value.sourcePath,
      candidates.map((candidate) => ({
        rootId: candidate.rootId!,
        relativePath: candidate.relativePath!,
        name: candidate.name,
        group: candidate.group,
      })),
    );
    await query.refetch();
    manifestPreview.value = await api.previewRepositoryManifest(manifestPreview.value.sourcePath);
    manifestSelectedKeys.value = [];
    actionMessage.value = `已从清单导入 ${result.repositories.length} 个仓库`;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '清单导入失败';
  } finally {
    manifestBusy.value = null;
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
  await api.updateRepository(repository.config.id, { pinned: !repository.config.pinned });
  await query.refetch();
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
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存仓库配置失败';
  } finally {
    repositoryEditBusy.value = false;
  }
}

async function removeRepository(repository: RepositoryStatus): Promise<void> {
  if (!window.confirm(`只把 ${repository.config.name} 移出列表，不会删除磁盘文件。继续吗？`)) return;
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
    const safety = type === 'pull' ? '只会 fast-forward，工作区有改动会跳过' : '会先 Fetch，远端有新提交会跳过';
    if (!window.confirm(`对${scopeLabel}中的 ${targetRepositories.length} 个仓库执行安全 ${action}？${safety}。`)) return;
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
  if (action === 'pull' && !window.confirm(`对 ${repository.config.name} 执行安全 Pull？只允许 fast-forward。`)) return;
  if (action === 'push' && !window.confirm(`对 ${repository.config.name} 执行安全 Push？不会使用 force。`)) return;
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
  const includeNote = stashIncludeUntracked.value ? '，包含未跟踪文件' : '，不包含未跟踪文件';
  if (!window.confirm(`为 ${repository.config.name} 创建 Stash 备份${includeNote}？当前改动会暂时从工作区移走。`)) return;
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
  if (!window.confirm(`把 ${stash.ref} 应用到 ${repository.config.name}？该条 Stash 会保留；若代码基线变化，仍可能产生冲突。`)) return;
  stashBusy.value = stash.hash;
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
  const confirmation = action === 'trash'
    ? `把 ${file.path} 移到 macOS 废纸篓？之后可以从废纸篓恢复。`
    : `丢弃 ${file.path} 的本地修改并恢复到 Git 版本？该修改不会进入废纸篓。`;
  if (!window.confirm(confirmation)) return;
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

async function submitCommit(auto: boolean): Promise<void> {
  const repository = selectedRepository.value;
  const preview = commitData.value;
  if (!repository || !preview) return;
  if (!auto && !commitMessage.value.trim()) {
    actionError.value = '请填写 Commit 文案';
    return;
  }
  const pushConfirmation = commitPushAfter.value ? '，随后执行安全 Push' : '';
  if (!window.confirm(`${auto ? '生成文案并自动提交' : '提交 staged 内容'}到 ${repository.config.name}${pushConfirmation}？`)) return;
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
        <div class="brand-mark"><GitBranch :size="20" /></div>
        <div>
          <div class="eyebrow">LOCAL COMMAND DECK</div>
          <h1>Git Fleet</h1>
        </div>
      </div>

      <div class="topbar-actions">
        <div class="local-signal"><span class="signal-dot" />127.0.0.1 / ONLINE</div>
        <button class="secondary-button topbar-history" data-focus-return="history" @click="openHistory"><History :size="16" /><span>操作记录</span></button>
        <button class="icon-button" title="快捷键帮助" aria-label="快捷键帮助" data-focus-return="shortcuts" @click="shortcutHelpOpen = true"><Keyboard :size="18" /></button>
        <button class="icon-button" title="管理仓库" aria-label="管理仓库" data-focus-return="manage" @click="manageOpen = true"><Settings2 :size="18" /></button>
        <button class="primary-button" :disabled="query.isFetching.value" @click="refresh">
          <RefreshCw :size="16" :class="{ spinning: query.isFetching.value }" />
          刷新状态
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
        <button class="summary-block summary-attention" :class="{ active: stateFilter === 'attention' }" :aria-pressed="stateFilter === 'attention'" @click="filterFromSummary('attention')">
          <span class="summary-icon"><Activity :size="17" /></span>
          <div><strong>{{ summary.attention }}</strong><span>需要处理</span></div>
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
          <div>
            <div class="section-kicker">REPOSITORY SIGNALS</div>
            <h2>仓库工作台</h2>
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
            <label class="search-field">
              <Search :size="16" />
              <input ref="searchInput" v-model="search" aria-label="搜索仓库、路径或标签" placeholder="搜索仓库、路径或标签" />
            </label>
            <div class="filter-tabs">
              <button :class="{ active: stateFilter === 'all' }" :aria-pressed="stateFilter === 'all'" @click="stateFilter = 'all'">全部 <span>{{ filterCounts.all }}</span></button>
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
            <span class="toolbar-label">BATCH SYNC</span>
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
          <button v-if="activeBatch" class="batch-signal" aria-live="polite" data-focus-return="history" @click="openHistory">
            <LoaderCircle v-if="activeBatch.state === 'running'" :size="14" class="spinning" /><Check v-else :size="14" />
            {{ activeBatch.type.toUpperCase() }} {{ activeBatch.completed }}/{{ activeBatch.total }}
          </button>
        </div>

        <div v-if="query.isLoading.value" class="loading-state">
          <LoaderCircle :size="24" class="spinning" />正在扫描本地 Git 状态…
        </div>
        <div v-else-if="query.error.value" class="error-state">
          <AlertTriangle :size="20" />{{ query.error.value.message }}
        </div>
        <div v-else-if="repositories.length === 0" class="empty-state">
          <div class="empty-glyph"><TerminalSquare :size="32" /></div>
          <div>
            <div class="section-kicker">NO REPOSITORIES WIRED</div>
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
                    @click.stop="togglePinned(repository)"
                  ><Pin :size="15" /></button>
                </td>
                <td>
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
                <td>
                  <div class="branch-line"><GitBranch :size="14" />{{ repository.branch || 'DETACHED' }}</div>
                  <div class="cell-muted">{{ repository.upstream || '无 upstream' }}</div>
                </td>
                <td>
                  <div class="change-counts">
                    <span v-if="repository.staged" class="count staged">S {{ repository.staged }}</span>
                    <span v-if="repository.modified" class="count modified">M {{ repository.modified }}</span>
                    <span v-if="repository.untracked" class="count untracked">U {{ repository.untracked }}</span>
                    <span v-if="repository.conflicted" class="count conflict">C {{ repository.conflicted }}</span>
                    <span v-if="!repository.staged && !repository.modified && !repository.untracked && !repository.conflicted" class="cell-muted">—</span>
                  </div>
                </td>
                <td>
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
                <td>
                  <div class="commit-subject">{{ repository.lastCommit?.subject || '暂无提交' }}</div>
                  <div class="cell-muted mono">{{ repository.lastCommit?.hash.slice(0, 7) || '—' }} · {{ relativeTime(repository.lastCommit?.committedAt) }}</div>
                </td>
                <td><span class="status-pill" :data-tone="statusMeta[repository.state].tone"><span />{{ statusMeta[repository.state].label }}</span></td>
              </tr>
            </tbody>
          </table>
          <div v-if="filteredRepositories.length === 0" class="no-results">没有匹配当前筛选条件的仓库</div>
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
            <div class="section-kicker">REPOSITORY DETAIL</div>
            <div class="drawer-title-line">
              <h2 :id="`repo-drawer-title-${selectedRepository.config.id}`">{{ selectedRepository.config.name }}</h2>
              <span class="repository-state-chip" :data-tone="statusMeta[selectedRepository.state].tone"><i />{{ statusMeta[selectedRepository.state].label }}</span>
            </div>
            <div class="drawer-header-signals">
              <span><GitBranch :size="12" />{{ selectedRepository.branch || 'DETACHED' }}</span>
              <span><CircleDot :size="12" />{{ selectedRepository.staged + selectedRepository.modified + selectedRepository.untracked + selectedRepository.conflicted }} 项改动</span>
              <span><ArrowUp :size="12" />{{ selectedRepository.ahead ?? '—' }}</span>
              <span><ArrowDown :size="12" />{{ selectedRepository.behind ?? '—' }}</span>
              <span><Clock3 :size="12" />{{ relativeTime(selectedRepository.scannedAt) }}</span>
            </div>
          </div>
          <button class="icon-button" title="关闭仓库详情" aria-label="关闭仓库详情" data-dialog-initial @click="closeDrawers"><X :size="18" /></button>
        </div>
        <div class="drawer-section" data-accent="yellow">
          <div class="drawer-section-title">工作区信号</div>
          <div class="signal-grid">
            <div><span>Staged</span><strong>{{ selectedRepository.staged }}</strong></div>
            <div><span>Modified</span><strong>{{ selectedRepository.modified }}</strong></div>
            <div><span>Untracked</span><strong>{{ selectedRepository.untracked }}</strong></div>
            <div><span>Conflicts</span><strong>{{ selectedRepository.conflicted }}</strong></div>
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
        <div class="repository-context">
          <dl class="detail-grid">
            <div><dt>LOCAL PATH</dt><dd class="copyable-value"><span :title="selectedRepository.absolutePath">{{ selectedRepository.absolutePath }}</span><button title="复制本地路径" aria-label="复制本地路径" @click="copyToClipboard(selectedRepository.absolutePath, '本地路径')"><Copy :size="12" /></button></dd></div>
            <div><dt>BRANCH / UPSTREAM</dt><dd>{{ selectedRepository.branch || 'DETACHED HEAD' }} · {{ selectedRepository.upstream || '未配置' }}</dd></div>
            <div><dt>REMOTE URL</dt><dd class="copyable-value"><span :title="selectedRepository.remoteUrl || '未配置'">{{ selectedRepository.remoteUrl || '未配置' }}</span><button title="复制 Remote URL" aria-label="复制 Remote URL" :disabled="!selectedRepository.remoteUrl" @click="copyToClipboard(selectedRepository.remoteUrl, 'Remote URL')"><Copy :size="12" /></button></dd></div>
            <div><dt>LAST FETCH</dt><dd>{{ selectedRepository.lastFetchedAt ? relativeTime(selectedRepository.lastFetchedAt) : '未知' }}</dd></div>
            <div><dt>STASHES</dt><dd>{{ selectedRepository.stashCount }}</dd></div>
            <div><dt>LAST SCAN</dt><dd>{{ relativeTime(selectedRepository.scannedAt) }}</dd></div>
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
            <div v-if="selectedRemoteLinks" class="dock-remote">
              <div class="remote-provider"><span>REMOTE</span><strong>{{ selectedRemoteLinks.provider }}</strong></div>
              <a
                :href="selectedRemoteLinks.repositoryUrl"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="`在 ${selectedRemoteLinks.provider} 打开 ${selectedRepository.config.name}`"
              ><ExternalLink :size="14" />仓库主页</a>
              <a
                v-if="selectedRemoteCommitUrl"
                :href="selectedRemoteCommitUrl"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="`在 ${selectedRemoteLinks.provider} 查看 ${selectedRepository.config.name} 最近提交`"
              ><GitCommitHorizontal :size="14" />最近提交</a>
            </div>
            <div class="dock-local-actions">
              <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('finder')"><LoaderCircle v-if="openBusy === 'finder'" :size="14" class="spinning" /><FolderGit2 v-else :size="14" />Finder</button>
              <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('terminal')"><LoaderCircle v-if="openBusy === 'terminal'" :size="14" class="spinning" /><TerminalSquare v-else :size="14" />Terminal</button>
              <button class="secondary-button" :disabled="openBusy !== null" @click="openRepository('vscode')"><LoaderCircle v-if="openBusy === 'vscode'" :size="14" class="spinning" /><Code2 v-else :size="14" />VS Code</button>
              <button class="secondary-button" @click="copyToClipboard(cdCommand(selectedRepository.absolutePath), 'cd 命令')"><Copy :size="14" />复制 cd</button>
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
                <button
                  class="file-action stash-apply"
                  title="应用并保留该 Stash"
                  :aria-label="`应用并保留 ${stash.ref}`"
                  :disabled="stashBusy !== null || !canApplyStash || !selectedRepository.config.capabilities.stash"
                  @click="applyRepositoryStash(stash)"
                ><LoaderCircle v-if="stashBusy === stash.hash" :size="14" class="spinning" /><ArchiveRestore v-else :size="14" /></button>
              </div>
            </div>
            <p class="action-hint">创建会暂时清空所选改动；应用要求工作区干净，且不会删除原 Stash。</p>
          </div>
        </details>
        <div class="drawer-section" data-accent="cyan">
          <div class="drawer-section-title">最近提交</div>
          <div class="commit-card">
            <GitCommitHorizontal :size="18" />
            <div><strong>{{ selectedRepository.lastCommit?.subject || '暂无提交' }}</strong><span>{{ selectedRepository.lastCommit?.author || '—' }} · {{ relativeTime(selectedRepository.lastCommit?.committedAt) }}</span></div>
          </div>
        </div>
        <div v-if="selectedRepository.error" class="drawer-error"><AlertTriangle :size="16" />{{ selectedRepository.error }}</div>
        <div class="drawer-section" data-accent="green">
          <div class="drawer-section-title">安全操作</div>
          <div class="git-action-grid">
            <button
              class="secondary-button"
              :disabled="repositoryAction !== null || !selectedRepository.config.capabilities.fetch"
              @click="runRepositoryAction('fetch')"
            ><LoaderCircle v-if="repositoryAction === 'fetch'" :size="16" class="spinning" /><RefreshCw v-else :size="16" />Fetch</button>
            <button
              class="secondary-button"
              :disabled="repositoryAction !== null || !selectedRepository.config.capabilities.pull || !['clean', 'behind'].includes(selectedRepository.state)"
              @click="runRepositoryAction('pull')"
            ><LoaderCircle v-if="repositoryAction === 'pull'" :size="16" class="spinning" /><ArrowDown v-else :size="16" />安全 Pull</button>
            <button
              class="secondary-button"
              :disabled="repositoryAction !== null || !selectedRepository.config.capabilities.push || (selectedRepository.ahead ?? 0) === 0"
              @click="runRepositoryAction('push')"
            ><LoaderCircle v-if="repositoryAction === 'push'" :size="16" class="spinning" /><ArrowUp v-else :size="16" />安全 Push</button>
          </div>
          <p class="action-hint">Pull 仅 fast-forward；Push 会先 Fetch 且永不 force。</p>
        </div>
        <div class="drawer-spacer" />
        <div class="drawer-actions">
          <button class="secondary-button" @click="togglePinned(selectedRepository)"><Pin :size="16" />{{ selectedRepository.config.pinned ? '取消收藏' : '收藏' }}</button>
          <button class="secondary-button" :data-focus-return="`repository-edit:${selectedRepository.config.id}`" @click="openRepositoryEditor(selectedRepository)"><Settings2 :size="16" />编辑配置</button>
          <button class="danger-button" @click="removeRepository(selectedRepository)"><Trash2 :size="16" />移出列表</button>
        </div>
      </aside>
    </transition>

    <transition name="drawer">
      <aside v-if="historyOpen" class="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-drawer-title" data-focus-layer tabindex="-1">
        <div class="drawer-header">
          <div>
            <div class="section-kicker">OPERATION LOG</div>
            <h2 id="history-drawer-title">批量队列与操作记录</h2>
          </div>
          <button class="icon-button" title="关闭操作记录" aria-label="关闭操作记录" data-dialog-initial @click="closeDrawers"><X :size="18" /></button>
        </div>

        <div v-if="activeBatch" class="batch-card" :data-state="activeBatch.state">
          <div class="batch-card-heading">
            <div><span>{{ activeBatch.state === 'running' ? 'ACTIVE BATCH' : 'LATEST BATCH' }}</span><strong>{{ activeBatch.type.toUpperCase() }}</strong></div>
            <span>{{ activeBatch.completed }} / {{ activeBatch.total }}</span>
          </div>
          <div class="batch-progress"><span :style="{ width: `${activeBatch.total ? (activeBatch.completed / activeBatch.total) * 100 : 100}%` }" /></div>
          <div class="batch-counts">
            <span class="success">{{ activeBatch.success }} 成功</span>
            <span class="skipped">{{ activeBatch.skipped }} 跳过</span>
            <span class="failed">{{ activeBatch.failed }} 失败</span>
          </div>
        </div>

        <div class="history-heading">
          <span>最近操作 · {{ filteredOperations.length }}/{{ operationsQuery.data.value?.operations.length || 0 }}</span>
          <div class="history-heading-actions">
            <span class="history-stream" :data-live="operationsStreamConnected" aria-live="polite"><i />{{ operationsStreamConnected ? 'SSE 实时' : '轮询兜底' }}</span>
            <button class="table-icon-button" title="刷新操作记录" aria-label="刷新操作记录" :disabled="operationsQuery.isFetching.value" @click="operationsQuery.refetch()"><RefreshCw :size="14" :class="{ spinning: operationsQuery.isFetching.value }" /></button>
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
            <div><div class="section-kicker">KEYBOARD CONTROL</div><h2 id="shortcut-title">快捷键</h2></div>
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
      <div v-if="manageOpen" class="modal-backdrop" @click.self="manageOpen = false">
        <section class="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" data-focus-layer tabindex="-1">
          <div class="setup-header">
            <div>
              <div class="section-kicker">LOCAL SETUP</div>
              <h2 id="setup-title">个人配置与仓库接入</h2>
              <p>所有配置仅保存在这台电脑，移出列表不会删除任何代码。</p>
            </div>
            <button class="icon-button" title="关闭管理仓库" aria-label="关闭管理仓库" @click="manageOpen = false"><X :size="18" /></button>
          </div>

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
                  <input v-model="rootForm.path" aria-label="根目录绝对路径" placeholder="本地绝对路径" @keydown.enter="addRoot" />
                  <button class="compact-button" :disabled="rootBusy !== null || !rootForm.id.trim() || !rootForm.path.trim()" @click="addRoot"><LoaderCircle v-if="rootBusy === 'add'" :size="13" class="spinning" /><Plus v-else :size="13" />根目录</button>
                </div>
              </div>
              <div class="discovery-tabs">
                <button :data-active="repositoryDiscoveryMode === 'scan'" :aria-pressed="repositoryDiscoveryMode === 'scan'" @click="repositoryDiscoveryMode = 'scan'"><FolderGit2 :size="14" />目录扫描</button>
                <button :data-active="repositoryDiscoveryMode === 'manifest'" :aria-pressed="repositoryDiscoveryMode === 'manifest'" @click="repositoryDiscoveryMode = 'manifest'"><FileText :size="14" />PACKAGES.md</button>
              </div>
              <template v-if="repositoryDiscoveryMode === 'scan'">
                <div class="scan-toolbar">
                  <select v-model="scanRootId" aria-label="选择扫描根目录">
                    <option v-for="(rootPath, rootId) in query.data.value?.roots" :key="rootId" :value="rootId">{{ rootId }} · {{ rootPath }}</option>
                  </select>
                  <button class="primary-button" :disabled="scanning || !scanRootId" @click="scanRepositories"><LoaderCircle v-if="scanning" :size="16" class="spinning" /><Search v-else :size="16" />扫描</button>
                </div>
                <div class="candidate-list">
                  <div v-if="!scanCandidates.length" class="candidate-empty"><FolderGit2 :size="24" /><span>点击扫描，发现本地 Git 仓库</span></div>
                  <div v-for="candidate in scanCandidates" :key="candidate.absolutePath" class="candidate-row">
                    <div class="candidate-icon"><GitBranch :size="16" /></div>
                    <div class="candidate-info"><strong>{{ candidate.name }}</strong><span>{{ candidate.relativePath }} · {{ candidate.branch || 'DETACHED' }}</span></div>
                    <span v-if="candidate.alreadyAdded" class="added-label"><Check :size="14" />已添加</span>
                    <button v-else class="compact-button" :disabled="addingPath === candidate.absolutePath" @click="addRepository(candidate)"><LoaderCircle v-if="addingPath === candidate.absolutePath" :size="14" class="spinning" /><Plus v-else :size="14" />加入</button>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="manifest-toolbar">
                  <input v-model="manifestPath" aria-label="PACKAGES.md 文件路径" placeholder="本地 PACKAGES.md 绝对路径" @keydown.enter="previewRepositoryManifest" />
                  <button class="primary-button" :disabled="manifestBusy !== null || !manifestPath.trim()" @click="previewRepositoryManifest"><LoaderCircle v-if="manifestBusy === 'preview'" :size="15" class="spinning" /><Search v-else :size="15" />预览</button>
                </div>
                <div v-if="manifestPreview" class="manifest-summary">
                  <div><strong>{{ manifestPreview.total }}</strong><span>清单仓库</span></div>
                  <div data-tone="blue"><strong>{{ manifestPreview.ready }}</strong><span>可导入</span></div>
                  <div data-tone="green"><strong>{{ manifestPreview.existing }}</strong><span>已存在</span></div>
                  <div data-tone="yellow"><strong>{{ manifestPreview.missing + manifestPreview.ambiguous + manifestPreview.mismatch }}</strong><span>需处理</span></div>
                  <button :disabled="manifestPreview.ready === 0" @click="toggleAllManifestCandidates">{{ manifestSelectedKeys.length > 0 && manifestSelectedKeys.length === manifestPreview.ready ? '取消全选' : '全选可导入' }}</button>
                </div>
                <div class="manifest-list">
                  <div v-if="!manifestPreview" class="candidate-empty"><FileText :size="24" /><span>读取生态清单，先预览再批量接入</span></div>
                  <template v-else>
                    <div
                      v-for="candidate in manifestPreview.candidates"
                      :key="candidate.name"
                      class="manifest-row"
                      :data-status="candidate.status"
                    >
                      <label v-if="candidate.status === 'ready'" class="manifest-check">
                        <input v-model="manifestSelectedKeys" type="checkbox" :value="manifestCandidateKey(candidate)" />
                        <span><Check :size="12" /></span>
                      </label>
                      <span v-else class="manifest-state-icon"><Check v-if="candidate.status === 'existing'" :size="14" /><AlertTriangle v-else-if="candidate.status === 'missing' || candidate.status === 'remote-mismatch'" :size="14" /><CircleDot v-else :size="14" /></span>
                      <div class="manifest-info">
                        <div><strong>{{ candidate.name }}</strong><span>{{ candidate.group }}</span></div>
                        <small>{{ candidate.detail }}</small>
                        <code>{{ candidate.relativePath || candidate.sourceRemote || '本地未匹配' }}<template v-if="candidate.branch"> · {{ candidate.branch }}</template></code>
                      </div>
                      <span class="manifest-status">{{ candidate.status === 'ready' ? '待导入' : candidate.status === 'existing' ? '已存在' : candidate.status === 'missing' ? '未发现' : candidate.status === 'remote-mismatch' ? '远端不符' : '同名冲突' }}</span>
                    </div>
                  </template>
                </div>
                <div class="manifest-footer">
                  <span><ShieldCheck :size="14" />导入时会再次校验路径与 Git worktree</span>
                  <button class="primary-button" :disabled="manifestBusy !== null || selectedManifestCandidates.length === 0" @click="importRepositoryManifest"><LoaderCircle v-if="manifestBusy === 'import'" :size="15" class="spinning" /><Plus v-else :size="15" />导入 {{ selectedManifestCandidates.length }}</button>
                </div>
              </template>
            </section>
          </div>

          <div v-if="actionError || actionMessage" class="setup-feedback" :class="{ error: actionError }" :role="actionError ? 'alert' : 'status'" :aria-live="actionError ? 'assertive' : 'polite'">
            <AlertTriangle v-if="actionError" :size="16" /><Check v-else :size="16" />{{ actionError || actionMessage }}
          </div>
          <div class="setup-footer">
            <span><Minus :size="14" />配置文件位于本机 config/，不会上传个人路径</span>
            <button class="primary-button" :disabled="repositories.length === 0" @click="manageOpen = false">进入工作台<ChevronRight :size="16" /></button>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="repositoryEdit" class="modal-backdrop" @click.self="repositoryEdit = null">
        <section class="repository-config-modal" role="dialog" aria-modal="true" aria-labelledby="repository-config-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div><div class="section-kicker">REPOSITORY POLICY</div><h2 id="repository-config-title">编辑仓库配置</h2></div>
            <button class="icon-button" title="关闭仓库配置" aria-label="关闭仓库配置" @click="repositoryEdit = null"><X :size="18" /></button>
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
            <button class="secondary-button" @click="repositoryEdit = null">取消</button>
            <button class="primary-button" :disabled="repositoryEditBusy || !repositoryEdit.name.trim() || !repositoryEdit.group.trim()" @click="saveRepositoryEditor"><LoaderCircle v-if="repositoryEditBusy" :size="16" class="spinning" /><Check v-else :size="16" />保存配置</button>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="diffDialog" class="modal-backdrop" @click.self="diffDialog = null">
        <section class="code-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div><div class="section-kicker">{{ diffDialog.kind.toUpperCase() }} DIFF</div><h2 id="diff-title">{{ diffDialog.path }}</h2></div>
            <button class="icon-button" title="关闭 Diff 预览" aria-label="关闭 Diff 预览" data-dialog-initial @click="diffDialog = null"><X :size="18" /></button>
          </div>
          <pre class="diff-view"><code>{{ diffDialog.diff }}</code></pre>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="commitOpen && commitData" class="modal-backdrop" @click.self="commitOpen = false">
        <section class="commit-modal" role="dialog" aria-modal="true" aria-labelledby="commit-title" data-focus-layer tabindex="-1">
          <div class="code-modal-header">
            <div><div class="section-kicker">STAGED COMMIT</div><h2 id="commit-title">{{ selectedRepository?.config.name }}</h2></div>
            <button class="icon-button" title="关闭 Commit 弹窗" aria-label="关闭 Commit 弹窗" @click="commitOpen = false"><X :size="18" /></button>
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
                  <strong>提交后安全 Push <small>DEFAULT OFF</small></strong>
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

    <transition name="fade">
      <div v-if="(actionMessage || actionError) && !manageOpen" class="global-toast" :class="{ error: actionError, warning: !actionError && actionMessage.startsWith('⚠') }" :role="actionError ? 'alert' : 'status'" :aria-live="actionError ? 'assertive' : 'polite'">
        <AlertTriangle v-if="actionError || actionMessage.startsWith('⚠')" :size="16" /><Check v-else :size="16" />
        <span>{{ actionError || actionMessage }}</span>
        <button aria-label="关闭通知" @click="actionError = ''; actionMessage = ''"><X :size="14" /></button>
      </div>
    </transition>
  </div>
</template>
