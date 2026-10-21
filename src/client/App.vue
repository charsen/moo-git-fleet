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
  History,
  Keyboard,
  Link2,
  ListTodo,
  LoaderCircle,
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
  OperationsPayload,
  ProfileConfig,
  ProfileViewPreferences,
  RemoteBranch,
  RemoteCredentialHost,
  RemoteCredentialOverview,
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
import { api, ApiError } from './api';
import { defaultDarkTheme, defaultInterfaceFont, mergePausedErrorCode, type DarkTheme } from '../shared/contracts';
import { isSafeRemoteName } from '../shared/remote-name';
import {
  convertRemoteUrl,
  parseRemoteTarget,
  parseRemoteUrl,
  protocolLabel,
  suggestedDirectoryName,
  type RemoteProtocol,
} from '../shared/remote-url';
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
  operationCredentialHost,
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
  fetchAvailability as repositoryFetchAvailability,
  pullAvailability as repositoryPullAvailability,
  pushAvailability as repositoryPushAvailability,
  syncAvailability as repositorySyncAvailability,
} from './repository-action-availability';
import { rootNameFromPath } from './root-identity';
import { cloneAuthState as detectCloneAuth, cleanCloneError } from './clone-auth';
import { presentGlobalToast } from './toast-presentation';
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
import SelectMenu from './components/SelectMenu.vue';
import DiffView from './components/DiffView.vue';
import RepositoryWorkspace from './components/RepositoryWorkspace.vue';
import BranchMergeDialog from './components/BranchMergeDialog.vue';
import CommitComposer from './components/CommitComposer.vue';
import { useCommitComposer } from './use-commit-composer';
import { useRepositoryDiff } from './use-repository-diff';
import type { DiffKind, FileMenuAction } from './repository-workspace';
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
/** 后台 tick 的静默刷新同一时间只跑一次，避免慢请求叠加。 */
let backgroundRefreshInFlight = false;

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
const interfaceFont = ref(cachedViewPreferences.interfaceFont ?? defaultInterfaceFont);
const interfaceFontSize = ref(cachedViewPreferences.interfaceFontSize ?? 14);
const codeFont = ref(cachedViewPreferences.codeFont ?? 'jetbrains-mono');
const codeFontSize = ref<number | null>(cachedViewPreferences.codeFontSize ?? null);
/** 文件清单的平铺 / 树形偏好；工作区中栏与各处提交文件清单共用（见 file-list-view.ts）。 */
const fileListView = ref<FileListView>(cachedViewPreferences.fileListView ?? 'flat');
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
const shortcutHelpOpen = ref(false);
const manageOpen = ref(false);
const manageSection = ref<ManageSection>('profile');
const managePane = ref<HTMLElement | null>(null);
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
const fileActionId = ref<string | null>(null);
const fileDiscardId = ref<string | null>(null);
const fileMutationBusy = computed(() => fileActionId.value !== null || fileDiscardId.value !== null);
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
/** 冲突文件、被截断的差异与禁用 Stage 的仓库不给按块操作入口。 */
const diffHunkActionLabel = computed(() => {
  const dialog = diffDialog.value;
  const repository = selectedRepository.value;
  if (!dialog || !repository || !repository.config.capabilities.stage) return undefined;
  const file = repositoryFiles.value.find((item) => item.path === dialog.path);
  // 截断时补丁尾部不完整，按块暂存会漏掉后半段，所以不给入口。
  if (!file || file.conflicted || dialog.truncated) return undefined;
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
let persistedTheme: DarkTheme = theme.value;
let themeSaveChain: Promise<void> = Promise.resolve();
watch(theme, (next) => {
  applyTheme(next);
  cacheTheme(next);
  // 同步给表单，否则「保存个人配置」会拿旧主题把刚选的这一套覆盖回去。
  profileForm.theme = next;
  if (next === persistedTheme) return;
  themeSaveChain = themeSaveChain
    .catch(() => undefined)
    .then(async () => {
      const saved = await api.saveTheme(next);
      persistedTheme = saved.profile.theme;
    })
    .catch((error) => {
      actionError.value = error instanceof Error ? `主题保存失败：${error.message}` : '主题保存失败';
    });
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
/** 克隆失败详情：只在弹窗内联显示，不占用全局 toast。 */
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
  const raw = cloneForm.url.trim();
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
/** 正在应用历史提交（回退 / 拣选）。与历史改写分开，因为两者的忙碌入口不同。 */
const replayBusy = ref<'revert' | 'cherry-pick' | null>(null);
const selectedScanRootPath = computed(() => query.data.value?.roots[scanRootId.value] ?? '');

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
const cloneDirectory = computed(() => cloneForm.directory.trim() || suggestedDirectoryName(cloneForm.url) || '');

const cloneProblem = computed(() => {
  if (!cloneForm.rootId) return '请选择要克隆到哪个目录';
  if (!cloneForm.url.trim()) return '';
  const parsed = parseRemoteTarget(cloneForm.url);
  if (!parsed.ok) return parsed.reason;
  if (!cloneDirectory.value) return '无法从地址推断目录名，请手动填写';
  if (/[/\\]/.test(cloneForm.directory)) return '目录名只能是单层，不能包含路径分隔符';
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
      // 主题只在首次同步时对齐服务端：之后再赋值会把用户在别处改过的缓存又压回去。
      theme.value = dashboard.profile.profile.theme;
      persistedTheme = theme.value;
      persistedViewPreferences = JSON.stringify(currentViewPreferences());
      viewPreferencesHydrated = true;
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
  [sortMode, stateFilter, groupFilter, interfaceFont, interfaceFontSize, codeFont, codeFontSize, fileListView],
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
const branchWriteBlocker = computed(() => {
  const repository = selectedRepository.value;
  if (!repository) return '仓库详情已关闭';
  if (composer.reading.value) return '正在核对提交内容';
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
  if (composer.reading.value) return '正在核对提交内容';
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

const autoFetchDescription = computed(() => {
  const interval = profileForm.autoFetchIntervalMinutes;
  if (interval === 0) return '关闭时只刷新本地状态，不主动访问远端';
  return `浏览器打开期间每 ${autoFetchIntervalLabel(interval)} Fetch 全部已启用仓库`;
});

type ManageSection = 'profile' | 'appearance' | 'ai' | 'remote' | 'repositories';

// 设置弹窗的分区导航沿用仓库工作台侧栏同一套写法（RepositoryWorkspace 的 nav）：
// button + aria-current="page" + 计数徽标，不引入第二套标签页语义。
const manageNav = computed(() => [
  { id: 'profile' as const, label: '个人信息', icon: UserRound, count: null },
  { id: 'appearance' as const, label: '界面显示', icon: Palette, count: null },
  { id: 'ai' as const, label: 'AI 服务', icon: Bot, count: null },
    // 计数即「缺凭证的 https 主机数」：让用户在 Fetch 失败之前就能看到待处理项。
    { id: 'remote' as const, label: '远端', icon: Link2, count: missingCredentialCount.value || null },
  { id: 'repositories' as const, label: '仓库接入', icon: FolderGit2, count: repositories.value.length },
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
  historyReturnOperationId.value = operation.id;
  selectRepository(repository);
}

async function retryOperation(operation: OperationRecord): Promise<void> {
  if (!['fetch', 'pull', 'sync', 'push'].includes(operation.type)) return;
  // 单仓重试覆盖 sync；它不在 BatchOperationType 里，两者不是一回事。
  const type = operation.type as RetryableOperationType;
  if (type !== 'fetch') {
    const action = type === 'sync' ? '同步' : type.toUpperCase();
    const accepted = await requestConfirmation({
      title: `重试 ${action}`,
      summary: `将重新执行这条失败或被安全条件阻止的 ${action} 操作。`,
      target: operation.repositoryName,
      details: type === 'pull'
        ? ['默认 merge，可勾选 rebase；工作区不满足条件时可勾选自动 Stash。']
        : type === 'sync'
          ? ['整合远端后自动推送；默认 merge，可勾选 rebase；冲突会暂停处理。']
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
          : type === 'sync'
            ? await api.syncRepository(operation.repositoryId)
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
            '批量 Pull 默认 merge 整合，工作区不干净的仓库会跳过。',
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
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
      actionError.value = `${repository.config.name}：${message}`;
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

/** `background` 语义同 `loadRepositoryFiles`：静默刷新不改加载态、不弹错误。 */
async function loadRepositoryBranches(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryBranchesRequest;
  if (!options.background) branchesLoading.value = true;
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
    if (!options.background && requestId === repositoryBranchesRequest) branchesLoading.value = false;
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
  const force: ConfirmationCheckbox = {
    id: 'force',
    label: '我确认强制删除；这些提交之后只留在 reflog 里',
    required: losesCommits,
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
      title: losesCommits ? '强制删除未合并的本地分支' : '删除本地分支',
      summary: losesCommits
        ? `这个分支有 ${preview.lostCount} 个提交不会被其他分支或远端引用，普通删除会被 Git 拒绝。`
        : '这个分支的提交仍被其他 ref 引用，删除不会丢掉内容。',
      target: `${repository.config.name} · ${branch.name} · ${preview.head.slice(0, 7)}`,
      details: losesCommits
        ? [
          ...preview.lostCommits.map((commit) => `${commit.hash.slice(0, 7)} ${commit.subject}`),
          ...(preview.lostTruncated ? [`还有 ${preview.lostCount - preview.lostCommits.length} 条未列出`] : []),
        ]
        : ['只删除分支引用；当前分支与被其他 Worktree 占用的分支仍会被拒绝。'],
      confirmLabel: losesCommits ? '强制删除分支' : '删除分支',
      tone: 'danger',
      checkboxes: losesCommits ? [force, backup] : undefined,
    },
    execute: (repositoryId) =>
      api.deleteBranch(repositoryId, {
        ...base,
        force: losesCommits && force.value,
        backupTag: backup.value,
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

/** `background` 用于定时静默刷新：不置加载态、失败不弹全局提示，避免每分钟级别的抖动与噪音。 */
async function loadRepositoryFiles(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryFilesRequest;
  if (!options.background) filesLoading.value = true;
  try {
    const files = (await api.repositoryFiles(repositoryId)).files;
    if (requestId === repositoryFilesRequest && selectedRepository.value?.config.id === repositoryId) {
      repositoryFiles.value = files;
    }
  } catch (error) {
    if (!options.background && requestId === repositoryFilesRequest && selectedRepository.value?.config.id === repositoryId) {
      actionError.value = error instanceof Error ? error.message : '读取文件状态失败';
    }
  } finally {
    if (!options.background && requestId === repositoryFilesRequest) filesLoading.value = false;
  }
}

/** 已忽略清单是只读展示，仅在用户打开「显示已忽略文件」时按需拉取。 */
async function loadRepositoryIgnoredFiles(repositoryId: string, options: { background?: boolean } = {}): Promise<void> {
  const requestId = ++repositoryIgnoredRequest;
  if (!options.background) ignoredLoading.value = true;
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
    if (!options.background && requestId === repositoryIgnoredRequest) ignoredLoading.value = false;
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
  if (!options.background) markedLoading.value = true;
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
    if (!options.background && requestId === repositoryMarkedRequest) markedLoading.value = false;
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
  // 远端标签是另一个网络往返，不阻塞列表：先出本地标签，探测结果回来再合并。
  void loadRemoteTagNames(repositoryId, requestId);
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
      // 刚推成功：远端已经有这个标签，不必等下一次探测。
      remoteTagNames.value = new Set([...remoteTagNames.value, tag.name]);
      remoteTagsKnown.value = true;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
      const next = new Set(remoteTagNames.value);
      next.delete(tag.name);
      remoteTagNames.value = next;
      remoteTagsKnown.value = true;
    }
    await Promise.all([query.refetch(), operationsQuery.refetch()]);
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '删除远端标签失败'}`;
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
  if (!repository || workspaceBusy.value || composer.reading.value || !repository.config.capabilities.stage) return;
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
    await query.refetch();
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
  if (!repository || workspaceBusy.value || composer.reading.value || assumeBusyId.value) return;
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
    await query.refetch();
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
    await query.refetch();
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
      // `⚠` 前缀是既有的「警告 tone」协议：这不是失败，但结果需要用户另找地方处理。
      actionMessage.value = output.result.removed ? output.message : `⚠ ${output.message}`;
    }
    await query.refetch();
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
  if (branchMerge.value || confirmation.value || repositoryEdit.value || upstreamRepair.value
    || manageOpen.value || shortcutHelpOpen.value || branchPanelOpen.value) return;
  backgroundRefreshInFlight = true;
  try {
    await Promise.all([
      loadRepositoryFiles(repository.config.id, { background: true }),
      loadRepositoryBranches(repository.config.id, { background: true }),
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
    actionError.value = `${repository.config.name}：${snapshot?.blocked ?? '当前无法修正提交（可能还没有提交）'}`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
      composer.clearDraft();
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion))
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '修正提交失败'}`;
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
    actionError.value = `${repository.config.name}：${snapshot?.blocked ?? '当前无法撤销提交（可能还没有提交）'}`;
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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion))
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '撤销提交失败'}`;
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

  let subject = '';
  let parents = 0;
  try {
    const detail = await api.commitDetail(repository.config.id, hash);
    subject = detail.subject;
    parents = detail.parents.length;
  } catch (error) {
    actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : '无法读取该提交'}`;
    actionMessage.value = '';
    return;
  }

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
      actionMessage.value = `${repository.config.name}：${output.operation.message}`;
    }
  } catch (error) {
    if (isCurrentRepositoryContext(repository.config.id, contextVersion)) {
      actionError.value = `${repository.config.name}：${error instanceof Error ? error.message : `${label}失败`}`;
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
  const url = cloneForm.url.trim();
  const directory = cloneForm.directory.trim();
  const rootLabel = cloneRootOptions.value.find((option) => option.value === cloneForm.rootId)?.label ?? cloneForm.rootId;

  // 补填凭证后的重试不再弹一次确认：用户刚刚已经确认过同一次克隆。
  if (options.confirm !== false) {
    const accepted = await requestConfirmation({
      title: '克隆远端仓库',
      summary: `把 ${url} 克隆到「${rootLabel}」下，并加入舰队。`,
      target: cloneDirectory.value,
      details: [
        `目标目录：${cloneDirectory.value}（相对所选根目录）`,
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
  try {
    const result = await api.cloneRepository({
      rootId: cloneForm.rootId,
      url,
      ...(directory ? { directory } : {}),
    });
    // 克隆只有弹窗一个入口：成功即收起弹窗，结果交给全局 toast。
    actionMessage.value = `${result.repository.name}：已克隆到 ${result.directory} 并加入舰队`;
    cloneForm.url = '';
    cloneForm.directory = '';
    cloneDialogOpen.value = false;
    resetCloneAuth();
    await query.refetch();
  } catch (error) {
    // 失败时弹窗保持打开，错误内联显示，不再叠一层 toast。
    // 这里存原始 stderr：认证分类要靠它，展示时再经 cloneErrorText 去掉进度行。
    cloneError.value = error instanceof Error ? error.message : '未知错误';
    // 缺凭证 / 凭证过期：直接在弹窗里补填，不必让用户自己去设置里找主机。
    const failure = cloneAuthStatus.value;
    if (failure?.fixable && failure.host) await openCloneAuth(failure.host);
  } finally {
    cloneBusy.value = false;
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
              :aria-label="`Pull，当前预计可执行 ${batchAvailability.pull.eligible} 个仓库。${batchAvailability.pull.detail}`"
              :title="batchAvailability.pull.detail"
              @click="runBatch('pull')"
            >
              <LoaderCircle v-if="batchStarting === 'pull'" :size="14" class="spinning" /><ArrowDown v-else :size="14" />Pull <span class="batch-action-count">{{ batchAvailability.pull.eligible }}</span>
            </button>
            <button
              class="compact-button batch-action-button"
              :disabled="batchStarting !== null || activeBatch?.state === 'running' || batchAvailability.push.total === 0"
              :aria-disabled="batchAvailability.push.eligible === 0"
              :aria-label="`Push，当前预计可执行 ${batchAvailability.push.eligible} 个仓库。${batchAvailability.push.detail}`"
              :title="batchAvailability.push.detail"
              @click="runBatch('push')"
            >
              <LoaderCircle v-if="batchStarting === 'push'" :size="14" class="spinning" /><ArrowUp v-else :size="14" />Push <span class="batch-action-count">{{ batchAvailability.push.eligible }}</span>
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
                @click="selectRepository(repository)"
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
          :branches="branchSnapshot" :branches-loading="branchesLoading" :branch-blocker="localBranchSwitchBlocker" :remote-branch-blocker="branchPanelBlocker"
          :busy="workspaceBusy || workspaceRefreshing || composer.reading.value" :commit-busy="commitBusy" :refreshing="workspaceRefreshing"
          @merge-branch="openBranchMerge"
          @delete-branch="deleteRepositoryBranch"
          @delete-remote-branch="deleteRepositoryRemoteBranch"
          @checkout-remote-branch="checkoutRepositoryRemoteBranch"
          @resolve-conflict="resolveRepositoryConflict"
          :diff="diffDialog" :presentation="diffPresentation" :diff-loading="diffLoading" :diff-error="diffError"
          :hunk-action-label="diffHunkActionLabel" :pending-hunk="hunkActionBusy" :message="actionMessage" :error="actionError"
          :ignored-files="repositoryIgnoredFiles" :ignored-loading="ignoredLoading" :ignored-truncated="ignoredTruncated" :show-ignored-files="showIgnoredFiles"
          :marked-files="markedFiles" :marked-loading="markedLoading" :show-marked-files="showMarkedFiles"
          @file-action="handleRepositoryFileAction" @ignored-action="handleIgnoredFileAction" @marked-action="handleMarkedFileAction" @toggle-ignored="toggleIgnoredFiles" @toggle-marked="toggleMarkedFiles"
          @refresh-stashes="loadRepositoryStashes(selectedRepository.config.id)" @refresh-tags="loadRepositoryTags(selectedRepository.config.id)"
          @select="showFileDiff" @stage="updateFilesStage" @switch-branch="switchRepositoryBranch"
          @revert-commit="hash => replayHistoryCommit(hash, 'revert')" @cherry-pick-commit="hash => replayHistoryCommit(hash, 'cherry-pick')"
          @switch-kind="switchDiffKind" @hunk="applyDiffHunks" @refresh="refreshRepositoryWorkspace" @clear-diff="closeDiffDialog" @dismiss-feedback="dismissGlobalToast"
        >
          <template #commit>
            <CommitComposer ref="commitComposer" :message="composer.message.value" :preview="composer.preview.value" :loading="composer.loading.value" :error="composer.error.value || composer.suggestionError.value" :ready="composer.ready.value" :busy="commitBusy" :suggesting="composer.suggesting.value" :suggestion="composer.suggestion.value" :needs-review="composer.needsReview.value" :blocker="commitBlocker" :staged-count="repositoryFiles.filter(file => file.staged && !file.conflicted).length" :last-commit="lastCommitSnapshot" :rewrite-busy="rewriteBusy" @update:message="composer.updateMessage" @generate="composer.generate" @refresh="composer.refresh" @submit="submitCommit" @amend="amendLastCommit" @undo="undoLastCommit" />
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
            <div class="workspace-action-row">
            <div class="git-action-grid">
              <button
                class="secondary-button git-action-button git-action-fetch"
                :disabled="workspaceBusy || workspaceRefreshing || !fetchAvailability.available"
                :title="fetchAvailability.detail"
                @click="runRepositoryAction('fetch')"
              ><LoaderCircle v-if="repositoryAction === 'fetch'" :size="16" class="spinning" /><RefreshCw v-else :size="16" />Fetch</button>
              <button
                class="secondary-button git-action-button git-action-pull"
                :disabled="workspaceBusy || workspaceRefreshing || !pullAvailability.available"
                :title="pullAvailability.detail"
                @click="runRepositoryAction('pull')"
              ><LoaderCircle v-if="repositoryAction === 'pull'" :size="16" class="spinning" /><ArrowDown v-else :size="16" />Pull<span class="git-action-count" :title="`落后远端 ${selectedRepository.behind ?? 0} 个提交`">{{ selectedRepository.behind ?? 0 }}</span></button>
              <button
                class="secondary-button git-action-button git-action-push"
                :disabled="workspaceBusy || workspaceRefreshing || !pushAvailability.available"
                :title="pushAvailability.detail"
                @click="runRepositoryAction('push')"
              ><LoaderCircle v-if="repositoryAction === 'push'" :size="16" class="spinning" /><ArrowUp v-else :size="16" />Push<span class="git-action-count" :title="`领先远端 ${selectedRepository.ahead ?? 0} 个提交`">{{ selectedRepository.ahead ?? 0 }}</span></button>
              <button
                class="secondary-button git-action-button git-action-sync"
                :disabled="workspaceBusy || workspaceRefreshing || !syncAvailability.available"
                :title="syncAvailability.detail"
                @click="runRepositoryAction('sync')"
              ><LoaderCircle v-if="repositoryAction === 'sync'" :size="16" class="spinning" /><GitMerge v-else :size="16" />同步<span v-if="(selectedRepository.behind ?? 0) > 0" class="git-action-count" :title="`落后远端 ${selectedRepository.behind ?? 0} 个提交`">{{ selectedRepository.behind ?? 0 }}</span></button>
            </div>
                <button class="compact-button workspace-header-refresh" :disabled="workspaceRefreshing || workspaceBusy || composer.reading.value" title="立即重读文件、分支、Stash 与标签 · 每 15 秒也会自动刷新" @click="refreshRepositoryWorkspace"><RefreshCw :size="14" :class="{ spinning: workspaceRefreshing }" />刷新</button>
            </div>
            <!--
              没有 upstream 时三个按钮全灰，而禁用控件的 title 弹不出来（本仓已知坑），
              等于把原因藏死。这里给一条可见的出口，复用仓库列表那个 UPSTREAM REPAIR 弹窗。
            -->
            <p v-if="!selectedRepository.detached && !selectedRepository.upstream" class="git-action-blocker" role="status">
              <Link2 :size="12" aria-hidden="true" />
              <span v-if="selectedRepository.remoteUrl">当前分支还没有 upstream，Pull / Push / 同步都用不了。</span>
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
        <section class="setup-modal manage-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" data-focus-layer tabindex="-1">
          <div class="setup-header">
            <div>
              <h2 id="setup-title">个人配置与仓库接入</h2>
            </div>
            <button class="icon-button" title="关闭管理仓库" aria-label="关闭管理仓库" @click="closeManage"><X :size="18" /></button>
          </div>

          <div class="manage-body">
            <nav class="manage-nav" aria-label="设置分区">
              <button
                v-for="(item, index) in manageNav"
                :key="item.id"
                class="manage-nav-item"
                :aria-current="manageSection === item.id ? 'page' : undefined"
                @click="selectManageSection(item.id, $event)"
                @keydown="moveManageSectionFocus($event, index)"
              ><component :is="item.icon" :size="16" /><span>{{ item.label }}</span><b v-if="item.count !== null">{{ item.count }}</b></button>
            </nav>

            <div ref="managePane" class="setup-scroll">
              <section v-if="manageSection === 'profile'" class="manage-section">
                <div class="manage-pane-heading"><UserRound :size="18" /><div><strong>个人信息</strong><small>本机显示名称与 Commit 约定</small></div></div>
                <label class="form-field"><span>显示名称</span><input v-model="profileForm.displayName" data-dialog-initial /></label>
                <label class="form-field"><span>Commit 语言</span><SelectMenu v-model="commitLanguageModel" :options="commitLanguageOptions" aria-label="Commit 语言" class="select-menu--field" /></label>
                <label class="form-field"><span>AI Commit 模式</span><SelectMenu v-model="aiCommitModeModel" :options="aiCommitModeOptions" aria-label="AI Commit 模式" class="select-menu--field" /></label>
              </section>

              <section v-else-if="manageSection === 'appearance'" class="manage-section">
                <div class="manage-pane-heading">
                  <Palette :size="18" />
                  <div><strong>界面显示</strong><small>字体与字号在界面、代码区域分别生效</small></div>
                  <button type="button" class="manage-pane-action" @click="resetAppearance">恢复默认</button>
                </div>
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
                <section class="appearance-preference" aria-label="字体与字号">
                  <div class="manage-field-pair">
                    <label class="form-field"><span>界面字体</span><SelectMenu v-model="interfaceFontModel" :options="interfaceFontOptions" aria-label="界面字体" class="select-menu--field" data-dialog-initial /></label>
                    <label class="form-field"><span>代码字体</span><SelectMenu v-model="codeFontModel" :options="codeFontOptions" aria-label="代码字体" class="select-menu--field" /></label>
                    <label class="form-field"><span>界面字号</span><SelectMenu v-model="interfaceFontSizeModel" :options="interfaceFontSizeOptions" aria-label="界面字号" class="select-menu--field" /></label>
                    <label class="form-field"><span>代码字号</span><SelectMenu v-model="codeFontSizeModel" :options="codeFontSizeOptions" aria-label="代码字号" class="select-menu--field" /></label>
                  </div>
                  <p class="appearance-sample">清晰阅读，从容操作 <span>Moo Fleet · Aa 0123</span></p>
                  <small>自动保存到本机。代码与等宽区域始终等宽；系统字体缺失时自动回退。</small>
                </section>
              </section>

              <section v-else-if="manageSection === 'ai'" class="manage-section">
                <div class="manage-pane-heading"><Bot :size="18" /><div><strong>AI 服务</strong><small>DeepSeek Key 用于生成 Commit 文案</small></div></div>
                <label class="form-field">
                  <span>DeepSeek API Key · {{ query.data.value?.ai.configured ? '已配置' : '未配置' }}</span>
                  <span class="secret-input-control">
                    <input v-model="deepSeekApiKey" data-dialog-initial :type="deepSeekApiKeyVisible ? 'text' : 'password'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入或粘贴 API Key" @keydown.enter.prevent="saveDeepSeekKey" />
                    <button type="button" :title="deepSeekApiKeyVisible ? '隐藏 Key' : '显示 Key'" :aria-label="deepSeekApiKeyVisible ? '隐藏 DeepSeek API Key' : '显示 DeepSeek API Key'" @click="deepSeekApiKeyVisible = !deepSeekApiKeyVisible"><EyeOff v-if="deepSeekApiKeyVisible" :size="15" /><Eye v-else :size="15" /></button>
                    <button type="button" title="从 macOS 剪贴板粘贴" aria-label="粘贴 DeepSeek API Key" @click="pasteDeepSeekKey"><ClipboardPaste :size="15" /></button>
                  </span>
                </label>
                <p v-if="query.data.value?.ai.keyError" class="action-hint ai-key-error" role="status">
                  <AlertTriangle :size="14" />{{ query.data.value.ai.keyError }}。重新保存会覆盖该文件；若它已不是普通文件，请先手动删除。
                </p>
                <button class="secondary-button" :disabled="loadingDeepSeekApiKey || savingDeepSeekApiKey || deepSeekApiKey.trim().length < 8" @click="saveDeepSeekKey"><LoaderCircle v-if="loadingDeepSeekApiKey || savingDeepSeekApiKey" :size="16" class="spinning" /><ShieldCheck v-else :size="16" />保存 DeepSeek Key</button>
              </section>

              <section v-else-if="manageSection === 'remote'" class="manage-section">
                <div class="manage-pane-heading"><Link2 :size="18" /><div><strong>远端</strong><small>凭证、协议与地址；改动都只落在本机 .git/config</small></div></div>

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
                    <GitBranch :size="18" />
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
                            <label class="form-field"><span>地址</span><input v-model="remoteAddForm.url" placeholder="git@gitee.com:组/仓库.git 或 https://…" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
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

              <section v-else class="manage-section">
                <div class="manage-pane-heading"><FolderGit2 :size="18" /><div><strong>仓库接入</strong><small>配置扫描目录，把仓库加入工作台</small></div></div>
                <div class="auto-fetch-preference" :data-enabled="profileForm.autoFetchIntervalMinutes !== 0">
                  <span class="preference-icon"><RefreshCw :size="16" /></span>
                  <div><strong>自动 Fetch</strong><span>{{ autoFetchDescription }}</span></div>
                  <SelectMenu v-model="autoFetchIntervalModel" :options="autoFetchIntervalOptions" aria-label="自动 Fetch 周期" class="select-menu--compact" />
                </div>
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
                <p class="repository-clone-hint"><Download :size="14" />要接入还不存在的仓库，用工作台工具栏的「克隆远端」。</p>
              </section>

              <div v-if="actionError || actionMessage" class="setup-feedback" :class="{ error: actionError }" :role="actionError ? 'alert' : 'status'" :aria-live="actionError ? 'assertive' : 'polite'">
                <AlertTriangle v-if="actionError" :size="16" /><Check v-else :size="16" />{{ actionError || actionMessage }}
              </div>
            </div>
          </div>

          <div class="setup-footer">
            <div class="setup-footer-note">
              <span v-if="hasUnsavedProfileChanges" class="setup-unsaved"><CircleDot :size="14" />个人配置有未保存更改</span>
              <span><ShieldCheck :size="14" />配置仅保存在本机 config/，不会上传个人路径；把仓库移出工作台不会删除代码</span>
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
      <div v-if="cloneDialogOpen" class="modal-backdrop" @click.self="closeCloneDialog">
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
              <label class="form-field">
                <span>克隆到哪个目录</span>
                <SelectMenu v-model="cloneForm.rootId" :options="cloneRootOptions" aria-label="选择克隆到的根目录" />
              </label>
              <label class="form-field">
                <span>远端地址</span>
                <input v-model="cloneForm.url" data-dialog-initial placeholder="git@gitee.com:组/仓库.git 或 https://…" autocomplete="off" autocapitalize="off" spellcheck="false" @keydown.enter.prevent="submitClone()" />
              </label>
              <label class="form-field">
                <span>目录名（可选）</span>
                <input v-model="cloneForm.directory" :placeholder="cloneDirectory || '按地址末段自动命名'" autocomplete="off" autocapitalize="off" spellcheck="false" @keydown.enter.prevent="submitClone()" />
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
          <div class="clone-dialog-footer">
            <small v-if="cloneError && !cloneAuth.open" class="clone-dialog-error" role="alert">克隆失败：{{ cloneErrorText }}</small>
            <small v-else-if="cloneDirectory" class="clone-hint">将创建：<code>{{ cloneDirectory }}</code></small>
            <span v-else class="clone-dialog-spacer" />
            <div class="clone-dialog-buttons">
              <button class="secondary-button" @click="closeCloneDialog">取消</button>
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
