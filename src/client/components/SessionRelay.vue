<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock3,
  Cloud,
  CloudOff,
  Code2,
  Copy,
  CopyPlus,
  Database,
  Download,
  FileDiff,
  FolderOpen,
  GitBranch,
  GitFork,
  GitMerge,
  HardDrive,
  Inbox,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Pin,
  PinOff,
  RotateCcw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  Checkpoint,
  SessionVaultStatus,
  SessionCheckpointPayload,
  SessionDetail,
  SessionLifecycleFilter,
  SessionLifecycleMutationAction,
  SessionListItem,
  SessionProvider,
  SessionTrashEmptyPreview,
  SessionVaultEpoch,
  SessionVaultSyncState,
} from '../../shared/sessions';
import { sessionVaultPrivateRemoteConfirmation } from '../../shared/sessions';
import type { RecoveryPlan } from '../../shared/recovery';
import type { NativeRestorePlan, NativeRestoreResult } from '../../shared/native-capsule';
import type { CmuxSettingsStatus } from '../../shared/cmux';
import type { ProviderPermissionMode } from '../../shared/provider-command';
import { api } from '../api';
import SessionSaveDrawer from './SessionSaveDrawer.vue';

const emit = defineEmits<{
  syncBusy: [busy: boolean];
  pullAvailable: [available: boolean];
}>();

const page = ref(1);
const pageSize = 50;
const searchDraft = ref('');
const search = ref('');
const provider = ref<SessionProvider | null>(null);
const lifecycle = ref<SessionLifecycleFilter>('active');
const syncBusy = ref<'pull' | 'push' | null>(null);
const saveOpen = ref(false);
const saveBusy = ref(false);
const saveButton = ref<HTMLElement | null>(null);
const continueBusy = ref(false);
const continueMode = ref(false);
const continueRemoteUpdatedIds = ref<Set<string>>(new Set());
const sessionManagementOpen = ref(false);
interface LifecycleIntent {
  sessionId: string;
  title: string;
  action: SessionLifecycleMutationAction;
  expectedLifecycleVersion: string | null;
}
interface RelayFeedback {
  tone: 'success' | 'warning' | 'error';
  message: string;
  retry?: Pick<LifecycleIntent, 'sessionId' | 'action'>;
  undo?: LifecycleIntent;
}
type RelayOverlay =
  | 'vault-setup'
  | 'native-restore'
  | 'cmux-open'
  | 'cmux-settings'
  | 'epoch-manager'
  | 'trash-conflict'
  | 'trash-empty'
  | 'fork-split'
  | 'fork-merge'
  | 'lifecycle';
const feedback = ref<RelayFeedback | null>(null);
const vaultSetupOpen = ref(false);
const vaultSetupPath = ref('');
const vaultSetupRemoteEnabled = ref(false);
const vaultSetupRemoteName = ref('origin');
const vaultSetupRemoteUrl = ref('');
const vaultSetupBusy = ref(false);
const vaultSetupDirectoryPicking = ref(false);
const vaultSetupError = ref('');
const lifecycleBusy = ref<Pick<LifecycleIntent, 'sessionId' | 'action'> | null>(null);
const pendingLifecycle = ref<LifecycleIntent | null>(null);
const trashPreview = ref<SessionTrashEmptyPreview | null>(null);
const trashPreviewOpen = ref(false);
const trashPreviewLoading = ref(false);
const trashPreviewError = ref('');
const trashEmptyBusy = ref(false);
const trashConflictSaveOpen = ref(false);
const trashConflictGoal = ref('');
const trashConflictNextSteps = ref('');
const trashConflictSourceCheckpointId = ref('');
const trashConflictSaveBusy = ref(false);
const trashConflictSaveError = ref('');
const selectedSessionId = ref<string | null>(null);
const detail = ref<SessionDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const recoveryPlan = ref<RecoveryPlan | null>(null);
const recoveryLoading = ref(false);
const recoveryError = ref('');
const recoveryFeedback = ref('');
const recoveryPermissionMode = ref<ProviderPermissionMode>('standard');
const cmuxSettingsOpen = ref(false);
const cmuxSettings = ref<CmuxSettingsStatus | null>(null);
const cmuxSettingsLoading = ref(false);
const cmuxSettingsSaving = ref(false);
const cmuxSettingsError = ref('');
const cmuxClaudeTemplate = ref('');
const cmuxCodexTemplate = ref('');
const cmuxOpenConfirm = ref(false);
const cmuxOpenBusy = ref(false);
const cmuxOpenError = ref('');
const nativeRestoreConfirm = ref(false);
const nativeRestoreBusy = ref(false);
const nativeRestoreError = ref('');
const nativeRestoreResult = ref<NativeRestoreResult | null>(null);
const selectedHeadCheckpointId = ref<string | null>(null);
const selectedCheckpointPayload = ref<SessionCheckpointPayload | null>(null);
const checkpointPayloadLoading = ref(false);
const checkpointPayloadError = ref('');
const forkSelectBusy = ref(false);
const forkMergeOpen = ref(false);
const forkMergeGoal = ref('');
const forkMergeNextSteps = ref('');
const forkMergeBaseCheckpointId = ref('');
const forkMergeBusy = ref(false);
const forkMergeError = ref('');
const forkSplitOpen = ref(false);
const forkSplitGoal = ref('');
const forkSplitNextSteps = ref('');
const forkSplitKeepCheckpointId = ref('');
const forkSplitBusy = ref(false);
const forkSplitError = ref('');
const sessionRows = ref<HTMLElement[]>([]);
const detailElement = ref<HTMLElement | null>(null);
const epochManagerOpen = ref(false);
const epochRotateOpen = ref(false);
const epochRotateButton = ref<HTMLElement | null>(null);
const epochRotatePathInput = ref<HTMLInputElement | null>(null);
const epochRotatePath = ref('');
const epochRotateRemoteName = ref('origin');
const epochRotateRemoteUrl = ref('');
const epochRotateRemoteEnabled = ref(false);
const epochRotateConfirmation = ref('');
const epochRotateBusy = ref(false);
const epochRotateError = ref('');
const epochDirectoryPicking = ref(false);
const archivedEpochId = ref<string | null>(null);
const epochExportBusy = ref(false);
let pendingRelayOverlayTrigger: HTMLElement | null = null;
let relayOverlayReturnTarget: HTMLElement | null = null;
let searchTimer: number | null = null;
let detailRequest = 0;
let recoveryRequest = 0;

const activeRelayOverlay = computed<RelayOverlay | null>(() => {
  if (vaultSetupOpen.value) return 'vault-setup';
  if (nativeRestoreConfirm.value) return 'native-restore';
  if (cmuxOpenConfirm.value) return 'cmux-open';
  if (cmuxSettingsOpen.value) return 'cmux-settings';
  if (epochManagerOpen.value) return 'epoch-manager';
  if (trashConflictSaveOpen.value) return 'trash-conflict';
  if (trashPreviewOpen.value) return 'trash-empty';
  if (forkSplitOpen.value) return 'fork-split';
  if (forkMergeOpen.value) return 'fork-merge';
  if (pendingLifecycle.value) return 'lifecycle';
  return null;
});

function rememberRelayOverlayTrigger(event?: Event): void {
  const currentTarget = event?.currentTarget;
  pendingRelayOverlayTrigger = currentTarget instanceof HTMLElement
    ? currentTarget
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
}

function relayOverlayControls(layer: HTMLElement): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], summary, input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => {
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const collapsedDetails = element.closest('details:not([open])');
    return !collapsedDetails || element.tagName === 'SUMMARY';
  });
}

function focusRelayOverlay(overlay: RelayOverlay): void {
  const layer = document.querySelector<HTMLElement>(`[data-relay-focus-layer="${overlay}"]`);
  if (!layer) return;
  const preferred = layer.querySelector<HTMLElement>('[data-dialog-initial]');
  (preferred ?? relayOverlayControls(layer)[0] ?? layer).focus({ preventScroll: true });
}

watch(
  activeRelayOverlay,
  async (overlay, previousOverlay) => {
    if (overlay && !previousOverlay) {
      relayOverlayReturnTarget = pendingRelayOverlayTrigger?.isConnected
        ? pendingRelayOverlayTrigger
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      pendingRelayOverlayTrigger = null;
    }
    const returnTarget = !overlay && previousOverlay ? relayOverlayReturnTarget : null;
    if (!overlay && previousOverlay) relayOverlayReturnTarget = null;
    await nextTick();
    if (overlay) {
      requestAnimationFrame(() => {
        if (activeRelayOverlay.value === overlay) focusRelayOverlay(overlay);
      });
      return;
    }
    if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
  },
  { flush: 'sync' },
);

const vaultStatusQuery = useQuery({
  queryKey: ['session-vault-status'],
  queryFn: api.sessionVaultStatus,
  staleTime: 5_000,
});

const epochQuery = useQuery({
  queryKey: ['session-vault-epochs'],
  queryFn: api.sessionVaultEpochs,
  staleTime: 5_000,
});

const queryKey = computed(() => [
  'session-vault-sessions',
  archivedEpochId.value ?? 'active',
  page.value,
  search.value,
  provider.value,
  lifecycle.value,
] as const);
const sessionsQuery = useQuery({
  queryKey,
  queryFn: () => archivedEpochId.value
    ? api.archivedEpochSessions(archivedEpochId.value, {
        page: page.value,
        pageSize,
        search: search.value,
        provider: provider.value,
        lifecycle: lifecycle.value,
      })
    : api.sessions({
        page: page.value,
        pageSize,
        search: search.value,
        provider: provider.value,
        lifecycle: lifecycle.value,
      }),
  staleTime: 5_000,
});

const payload = computed(() => sessionsQuery.data.value ?? null);
const sessions = computed(() => payload.value?.items ?? []);
const displayedSessions = computed(() => {
  if (!continueMode.value) return sessions.value;
  const remoteUpdated = continueRemoteUpdatedIds.value;
  return [...sessions.value].sort((left, right) => {
    const priorities = [
      Number(!remoteUpdated.has(left.sessionId)) - Number(!remoteUpdated.has(right.sessionId)),
      Number(left.capabilities.codeReachable) - Number(right.capabilities.codeReachable),
      Number(!left.forked) - Number(!right.forked),
      Number(!left.deletionConflict) - Number(!right.deletionConflict),
    ];
    for (const priority of priorities) {
      if (priority !== 0) return priority;
    }
    return right.latestCheckpointAt.localeCompare(left.latestCheckpointAt);
  });
});
const sync = computed(() => payload.value?.sync ?? null);
const primarySaveLabel = computed(() => sync.value?.remoteSyncEnabled ? '保存并同步' : '保存会话');
const vaultStatus = computed<SessionVaultStatus | null>(() => vaultStatusQuery.data.value ?? null);
const vaultStatusError = computed(() => vaultStatusQuery.error.value instanceof Error
  ? vaultStatusQuery.error.value.message
  : '');
const vaultStateRefreshing = computed(() => Boolean(
  vaultStatusQuery.isFetching.value || sessionsQuery.isFetching.value || epochQuery.isFetching.value,
));
const vaultConfigurationKnown = computed(() => Boolean(
  vaultStatus.value !== null || sync.value !== null || vaultStatusError.value,
));
const vaultUnconfigured = computed(() => !vaultStatusError.value && (vaultStatus.value !== null
  ? !vaultStatus.value.configured
  : sync.value?.state === 'unconfigured'));
const vaultPrivacyLabel = computed(() => vaultStatusError.value
  ? '隐私边界状态未知'
  : vaultStatus.value?.configured
    ? vaultStatus.value.privacyLabel
    : '尚未建立隐私边界');
const total = computed(() => payload.value?.total ?? 0);
const totalPages = computed(() => payload.value?.totalPages ?? 0);
const lifecycleCounts = computed(() => payload.value?.counts ?? { active: 0, archived: 0, trashed: 0, all: 0 });
const queryError = computed(() => sessionsQuery.error.value instanceof Error ? sessionsQuery.error.value.message : '');
const epochStatus = computed(() => epochQuery.data.value ?? null);
const activeEpoch = computed(() => epochStatus.value?.activeEpoch ?? null);
const archivedEpoch = computed(() =>
  epochStatus.value?.archivedEpochs.find((epoch) => epoch.epochId === archivedEpochId.value) ?? null,
);
const viewingArchivedEpoch = computed(() => Boolean(archivedEpochId.value));
const selectedItem = computed(() => sessions.value.find((item) => item.sessionId === selectedSessionId.value) ?? detail.value?.session ?? null);
const codeUnavailableCount = computed(() => sessions.value.filter((item) => !item.capabilities.codeReachable).length);
const forkedCount = computed(() => sessions.value.filter((item) => item.forked).length);
const canPull = computed(() => Boolean(
  sync.value?.remoteSyncEnabled &&
  !['unconfigured', 'local-only', 'unconfirmed', 'diverged'].includes(sync.value.state),
));
const canPush = computed(() => Boolean(
  sync.value?.remoteSyncEnabled &&
  sync.value.pendingLocal &&
  !['unconfigured', 'local-only', 'unconfirmed', 'remote-ahead', 'diverged'].includes(sync.value.state),
));
const canAutoPushAfterSave = computed(() => Boolean(
  sync.value?.remoteSyncEnabled &&
  !['unconfigured', 'local-only', 'unconfirmed', 'remote-ahead', 'diverged'].includes(sync.value.state),
));
const lifecycleLocked = computed(() =>
  (sync.value?.behind ?? 0) > 0 || ['remote-ahead', 'diverged'].includes(sync.value?.state ?? 'unconfigured'),
);
const continueRemoteUpdateCount = computed(() => continueRemoteUpdatedIds.value.size);

watch(canPull, (available) => emit('pullAvailable', available), { immediate: true });

const syncPresentation: Record<SessionVaultSyncState, { label: string; tone: string; icon: typeof Cloud }> = {
  unconfigured: { label: '尚未开始', tone: 'muted', icon: HardDrive },
  'local-only': { label: '仅保存在本机', tone: 'yellow', icon: HardDrive },
  unconfirmed: { label: '同步尚未启用', tone: 'yellow', icon: ShieldCheck },
  'remote-unknown': { label: '等待首次同步', tone: 'cyan', icon: CircleDashed },
  synced: { label: '会话已同步', tone: 'green', icon: CheckCircle2 },
  'local-ahead': { label: '等待同步', tone: 'yellow', icon: ArrowUpFromLine },
  'remote-ahead': { label: '发现新内容', tone: 'cyan', icon: ArrowDownToLine },
  diverged: { label: '同步需要处理', tone: 'red', icon: GitFork },
  'sync-failed': { label: '同步失败', tone: 'red', icon: CloudOff },
};

const syncMeta = computed(() => syncPresentation[sync.value?.state ?? 'unconfigured']);
const syncUserMessage = computed(() => {
  switch (sync.value?.state ?? 'unconfigured') {
    case 'local-only': return '当前交接内容只保存在这台电脑';
    case 'unconfirmed': return '完成私有仓库设置后即可跨电脑使用';
    case 'remote-unknown': return '已连接私有仓库，等待第一次同步';
    case 'synced': return '本机与私有仓库内容一致';
    case 'local-ahead': return '本机有尚未同步的交接内容';
    case 'remote-ahead': return '另一台电脑保存了新的交接内容';
    case 'diverged': return '两台电脑都有新内容，需要先整理';
    case 'sync-failed': return '本机内容已保留，可以直接重试';
    default: return '完成快速设置后即可保存和接着工作';
  }
});
const vaultSetupRemoteNameValid = computed(() => /^[A-Za-z0-9._-]+$/.test(vaultSetupRemoteName.value.trim()));
const vaultSetupRemoteReady = computed(() =>
  !vaultSetupRemoteEnabled.value || (
    vaultSetupRemoteNameValid.value &&
    vaultSetupRemoteUrl.value.trim().length > 0
  ),
);
const vaultSetupCanSubmit = computed(() => Boolean(
  vaultSetupPath.value.trim() &&
  vaultSetupRemoteReady.value,
));
const recentCheckpoints = computed(() => [...(detail.value?.checkpoints ?? [])].reverse().slice(0, 20));
const recoveryBlockingCount = computed(() => recoveryPlan.value?.blockers.filter((item) => item.severity === 'blocking').length ?? 0);
function nativeRestoreTone(native: NativeRestorePlan): 'green' | 'cyan' | 'yellow' | 'red' | 'muted' {
  if (native.status === 'restore-failed') return 'red';
  if (native.status === 'unsupported') return 'yellow';
  if (native.status === 'not-captured') return 'muted';
  return native.action === 'already-present' ? 'green' : native.available ? 'cyan' : 'yellow';
}

function nativeRestoreLabel(native: NativeRestorePlan): string {
  if (native.status === 'restore-failed') return '原生还原失败';
  if (native.status === 'unsupported') return '原生恢复已降级';
  if (native.status === 'not-captured') return '未捕获原生胶囊';
  if (native.action === 'already-present') return '原生会话已就位';
  return native.available ? '原生胶囊可还原' : '原生胶囊等待项目映射';
}
const cmuxCapabilityLabel = computed(() => {
  const capability = recoveryPlan.value?.launch?.cmux ?? cmuxSettings.value?.capability;
  if (!capability || capability.state === 'unavailable') return '未安装 · 复制模式';
  if (capability.state === 'unknown') return '能力未确认 · 复制模式';
  return capability.version ?? 'cmux ready';
});
const headCheckpoints = computed(() => {
  const headIds = new Set(detail.value?.session.headCheckpointIds ?? []);
  return [...(detail.value?.checkpoints ?? [])]
    .filter((checkpoint) => headIds.has(checkpoint.checkpointId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId));
});
const deletionConflictCheckpoints = computed(() => {
  const conflictIds = new Set(detail.value?.session.deletionConflictCheckpointIds ?? []);
  return [...(detail.value?.checkpoints ?? [])]
    .filter((checkpoint) => conflictIds.has(checkpoint.checkpointId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId));
});
const selectedCheckpoint = computed(() => {
  if (!detail.value || !selectedHeadCheckpointId.value) return null;
  return detail.value.checkpoints.find((checkpoint) => checkpoint.checkpointId === selectedHeadCheckpointId.value) ?? null;
});
const activeWorkspace = computed(() => {
  if (!detail.value) return null;
  if (selectedCheckpointPayload.value?.checkpoint.checkpointId === selectedHeadCheckpointId.value) {
    return selectedCheckpointPayload.value.workspace;
  }
  if (selectedHeadCheckpointId.value === detail.value.session.latestCheckpointId) return detail.value.latestWorkspace;
  return null;
});
const activeHandoffMarkdown = computed(() => {
  if (!detail.value) return '';
  if (selectedCheckpointPayload.value?.checkpoint.checkpointId === selectedHeadCheckpointId.value) {
    return selectedCheckpointPayload.value.handoffMarkdown;
  }
  if (selectedHeadCheckpointId.value === detail.value.session.latestCheckpointId) return detail.value.latestHandoffMarkdown;
  return '';
});
function handoffSection(markdown: string, title: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) break;
    section.push(lines[index]);
  }
  return section;
}
function handoffListItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    const bullet = text.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      if (bullet[1] !== '无') items.push(bullet[1]);
    } else if (items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${text}`;
    } else if (text !== '无') {
      items.push(text);
    }
  }
  return items;
}
const activeHandoffFocus = computed(() => {
  const markdown = activeHandoffMarkdown.value ?? '';
  const goal = handoffSection(markdown, '目标')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return {
    goal: goal && goal !== '未填写' ? goal : '尚未写明当前目标',
    nextSteps: handoffListItems(handoffSection(markdown, '下一步')),
  };
});
const forkSelectionRequired = computed(() => Boolean(detail.value?.session.forked && !selectedHeadCheckpointId.value));

watch(searchDraft, (value) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    search.value = value.trim();
    page.value = 1;
    searchTimer = null;
  }, 220);
});

watch([page, search, provider, lifecycle, archivedEpochId], () => {
  closeDetail(false);
  sessionRows.value = [];
});

function providerLabel(value: SessionProvider): string {
  return value === 'claude' ? 'Claude' : 'Codex';
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '时间未知';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(value < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(value / 1_024 ** 2).toFixed(value < 10 * 1_024 ** 2 ? 1 : 0)} MB`;
}

function retentionLabel(item: SessionListItem): string {
  if (!item.retentionUntil) return '保留期限未知';
  const remainingMs = new Date(item.retentionUntil).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '已到清理期限';
  const days = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1_000)));
  return `剩余 ${days} 天`;
}

function shortProject(item: SessionListItem): string {
  return item.repositoryId ?? item.projectId.replace(/^(remote|local):/, '').slice(0, 18);
}

function shortHash(value: string | null): string {
  return value?.slice(0, 8) ?? 'NO HEAD';
}

function setProvider(value: SessionProvider | null): void {
  if (provider.value === value) return;
  provider.value = value;
  page.value = 1;
}

function setLifecycle(value: SessionLifecycleFilter): void {
  if (lifecycle.value === value) return;
  lifecycle.value = value;
  page.value = 1;
}

function toggleSessionManagement(): void {
  const nextOpen = !sessionManagementOpen.value;
  sessionManagementOpen.value = nextOpen;
  if (nextOpen) {
    exitContinueMode();
    return;
  }
  if (viewingArchivedEpoch.value) {
    returnToActiveEpoch();
    return;
  }
  lifecycle.value = 'active';
  provider.value = null;
  searchDraft.value = '';
  search.value = '';
  page.value = 1;
}

function epochLabel(epoch: SessionVaultEpoch | null): string {
  return epoch ? `纪元 #${String(epoch.sequence).padStart(2, '0')}` : '纪元目录';
}

function epochDate(value: string | null): string {
  if (!value) return '仍在写入';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间未知';
}

async function loadSessionDetail(sessionId: string): Promise<SessionDetail> {
  const epochId = archivedEpochId.value;
  return epochId
    ? api.archivedEpochSessionDetail(epochId, sessionId)
    : api.sessionDetail(sessionId);
}

async function loadCheckpointPayload(sessionId: string, checkpointId: string): Promise<SessionCheckpointPayload> {
  const epochId = archivedEpochId.value;
  return epochId
    ? api.archivedEpochCheckpointPayload(epochId, sessionId, checkpointId)
    : api.sessionCheckpointPayload(sessionId, checkpointId);
}

function openEpochManager(event?: Event): void {
  rememberRelayOverlayTrigger(event);
  epochRotateOpen.value = false;
  epochRotateError.value = '';
  epochManagerOpen.value = true;
  void epochQuery.refetch();
}

function closeEpochManager(): void {
  if (epochRotateBusy.value) return;
  epochManagerOpen.value = false;
  epochRotateOpen.value = false;
  epochRotateError.value = '';
}

function openEpochRotation(): void {
  const epoch = activeEpoch.value;
  if (!epoch) return;
  epochRotatePath.value = `${epoch.vaultPath}-epoch-${epoch.sequence + 1}`;
  epochRotateRemoteName.value = 'origin';
  epochRotateRemoteUrl.value = '';
  epochRotateRemoteEnabled.value = epoch.remoteSyncEnabled;
  epochRotateConfirmation.value = '';
  epochRotateError.value = '';
  epochRotateOpen.value = true;
  void nextTick(() => epochRotatePathInput.value?.focus({ preventScroll: true }));
}

function closeEpochRotation(): void {
  if (epochRotateBusy.value) return;
  epochRotateOpen.value = false;
  epochRotateError.value = '';
  void nextTick(() => epochRotateButton.value?.focus({ preventScroll: true }));
}

async function selectEpochDirectory(): Promise<void> {
  if (epochDirectoryPicking.value) return;
  epochDirectoryPicking.value = true;
  epochRotateError.value = '';
  try {
    const selected = await api.selectDirectory(activeEpoch.value?.vaultPath);
    if (selected.path) epochRotatePath.value = selected.path;
  } catch (error) {
    epochRotateError.value = error instanceof Error ? error.message : '选择新 Vault 目录失败';
  } finally {
    epochDirectoryPicking.value = false;
  }
}

async function submitEpochRotation(): Promise<void> {
  const epoch = activeEpoch.value;
  if (!epoch || epochRotateBusy.value) return;
  const vaultPath = epochRotatePath.value.trim();
  const remoteUrl = epochRotateRemoteUrl.value.trim();
  if (!vaultPath) {
    epochRotateError.value = '请填写新纪元的独立 Vault 目录';
    return;
  }
  if (epochRotateRemoteEnabled.value && !remoteUrl) {
    epochRotateError.value = '启用跨设备同步时，必须填写一个全新的空私有远端';
    return;
  }
  if (epochRotateRemoteEnabled.value && epochRotateConfirmation.value.trim() !== '这是我控制的私有远端') {
    epochRotateError.value = '请输入完整私有远端确认短语';
    return;
  }
  epochRotateBusy.value = true;
  epochRotateError.value = '';
  try {
    const result = await api.rotateSessionVaultEpoch({
      vaultPath,
      remoteName: epochRotateRemoteName.value.trim() || 'origin',
      remoteUrl: remoteUrl || null,
      enableRemoteSync: epochRotateRemoteEnabled.value,
      confirmationPhrase: epochRotateConfirmation.value,
      expectedActiveEpochId: epoch.epochId,
      acknowledgeReadOnlyArchive: true,
    });
    archivedEpochId.value = null;
    lifecycle.value = 'active';
    page.value = 1;
    epochRotateOpen.value = false;
    epochManagerOpen.value = false;
    feedback.value = { tone: 'success', message: result.message };
    await epochQuery.refetch();
    await nextTick();
    await sessionsQuery.refetch();
  } catch (error) {
    epochRotateError.value = error instanceof Error ? error.message : 'Vault 纪元轮换失败';
    await epochQuery.refetch();
  } finally {
    epochRotateBusy.value = false;
  }
}

function browseArchivedEpoch(epoch: SessionVaultEpoch): void {
  closeDetail(false);
  exitContinueMode();
  sessionManagementOpen.value = true;
  archivedEpochId.value = epoch.epochId;
  lifecycle.value = 'all';
  page.value = 1;
  epochManagerOpen.value = false;
  epochRotateOpen.value = false;
}

function returnToActiveEpoch(): void {
  closeDetail(false);
  exitContinueMode();
  archivedEpochId.value = null;
  lifecycle.value = 'active';
  page.value = 1;
}

async function exportArchivedCheckpoint(): Promise<void> {
  const currentDetail = detail.value;
  const epoch = archivedEpoch.value;
  const checkpointId = selectedHeadCheckpointId.value;
  if (!currentDetail || !epoch || !checkpointId || epochExportBusy.value) return;
  epochExportBusy.value = true;
  checkpointPayloadError.value = '';
  try {
    const checkpointPayload = selectedCheckpointPayload.value?.checkpoint.checkpointId === checkpointId
      ? selectedCheckpointPayload.value
      : await loadCheckpointPayload(currentDetail.session.sessionId, checkpointId);
    const contents = JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      epoch: {
        epochId: epoch.epochId,
        sequence: epoch.sequence,
        archivedAt: epoch.archivedAt,
        head: epoch.head,
      },
      session: currentDetail.session,
      payload: checkpointPayload,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([`${contents}\n`], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `moo-fleet-epoch-${epoch.sequence}-${checkpointId.slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    checkpointPayloadError.value = error instanceof Error ? error.message : '导出归档 checkpoint 失败';
  } finally {
    epochExportBusy.value = false;
  }
}

function setRowRef(element: unknown, index: number): void {
  if (element instanceof HTMLElement) sessionRows.value[index] = element;
}

function moveRowFocus(index: number, offset: number): void {
  const next = Math.min(Math.max(index + offset, 0), displayedSessions.value.length - 1);
  sessionRows.value[next]?.focus({ preventScroll: true });
}

function applySessionDetail(nextDetail: SessionDetail, preferredHeadId: string | null = selectedHeadCheckpointId.value): void {
  detail.value = nextDetail;
  const headIds = new Set(nextDetail.session.headCheckpointIds);
  const nextHeadId = nextDetail.session.forked
    ? (preferredHeadId && headIds.has(preferredHeadId) ? preferredHeadId : null)
    : nextDetail.session.latestCheckpointId;
  selectedHeadCheckpointId.value = nextHeadId;
  if (selectedCheckpointPayload.value?.checkpoint.checkpointId !== nextHeadId) selectedCheckpointPayload.value = null;
  checkpointPayloadLoading.value = false;
  checkpointPayloadError.value = '';
  if (!forkMergeOpen.value || !nextDetail.session.forked) {
    forkMergeOpen.value = false;
    forkMergeGoal.value = `合并：${nextDetail.session.title || '未命名交接'}`;
    forkMergeNextSteps.value = '';
    forkMergeBaseCheckpointId.value = nextHeadId ?? nextDetail.session.latestCheckpointId;
    forkMergeError.value = '';
  }
  if (!forkSplitOpen.value || !nextDetail.session.forked) {
    forkSplitOpen.value = false;
    forkSplitGoal.value = '';
    forkSplitNextSteps.value = '';
    forkSplitKeepCheckpointId.value = nextHeadId ?? nextDetail.session.latestCheckpointId;
    forkSplitError.value = '';
  }
  const nextConflictIds = new Set(nextDetail.session.deletionConflictCheckpointIds);
  const nextConflictSource = nextDetail.checkpoints
    .filter((checkpoint) => nextConflictIds.has(checkpoint.checkpointId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId))[0];
  if (!trashConflictSaveOpen.value || !nextDetail.session.deletionConflict) {
    trashConflictSaveOpen.value = false;
    trashConflictGoal.value = `继续：${nextConflictSource?.title || nextDetail.session.title || '未命名交接'}`;
    trashConflictNextSteps.value = '';
    trashConflictSourceCheckpointId.value = nextConflictSource?.checkpointId ?? '';
    trashConflictSaveError.value = '';
  } else if (!nextConflictIds.has(trashConflictSourceCheckpointId.value)) {
    trashConflictSourceCheckpointId.value = nextConflictSource?.checkpointId ?? '';
  }
}

function canPrepareRecovery(nextDetail: SessionDetail | null = detail.value): boolean {
  return Boolean(
    nextDetail &&
    !viewingArchivedEpoch.value &&
    nextDetail.session.lifecycleState !== 'trashed' &&
    nextDetail.session.payloadState === 'available'
  );
}

async function selectForkHead(checkpoint: Checkpoint): Promise<void> {
  if (!detail.value || checkpointPayloadLoading.value) return;
  const sessionId = detail.value.session.sessionId;
  selectedHeadCheckpointId.value = checkpoint.checkpointId;
  recoveryRequest += 1;
  recoveryPlan.value = null;
  recoveryError.value = '';
  recoveryFeedback.value = '';
  resetNativeRestoreState();
  checkpointPayloadError.value = '';
  if (checkpoint.checkpointId === detail.value.session.latestCheckpointId) {
    selectedCheckpointPayload.value = null;
    if (canPrepareRecovery()) await runRecoveryPlan();
    return;
  }
  checkpointPayloadLoading.value = true;
  let payloadReady = false;
  try {
    const payload = await loadCheckpointPayload(sessionId, checkpoint.checkpointId);
    if (selectedSessionId.value === sessionId && selectedHeadCheckpointId.value === checkpoint.checkpointId) {
      selectedCheckpointPayload.value = payload;
      payloadReady = true;
    }
  } catch (error) {
    if (selectedSessionId.value === sessionId && selectedHeadCheckpointId.value === checkpoint.checkpointId) {
      selectedHeadCheckpointId.value = null;
      selectedCheckpointPayload.value = null;
      checkpointPayloadError.value = error instanceof Error ? error.message : '读取分支交接内容失败';
    }
  } finally {
    if (selectedSessionId.value === sessionId) checkpointPayloadLoading.value = false;
  }
  if (payloadReady && canPrepareRecovery()) await runRecoveryPlan();
}

async function confirmForkSelection(): Promise<void> {
  const currentDetail = detail.value;
  const selectedId = selectedHeadCheckpointId.value;
  if (!currentDetail?.session.forked || !selectedId || forkSelectBusy.value || lifecycleLocked.value) return;
  forkSelectBusy.value = true;
  checkpointPayloadError.value = '';
  try {
    const result = await api.selectSessionForkHead(currentDetail.session.sessionId, {
      expectedHeadCheckpointIds: currentDetail.session.headCheckpointIds,
      selectedHeadCheckpointId: selectedId,
    });
    feedback.value = { tone: result.auditRecorded ? 'success' : 'warning', message: result.message };
    await sessionsQuery.refetch();
    const nextDetail = await loadSessionDetail(currentDetail.session.sessionId);
    if (selectedSessionId.value === currentDetail.session.sessionId) applySessionDetail(nextDetail, selectedId);
  } catch (error) {
    checkpointPayloadError.value = error instanceof Error ? error.message : '记录继续使用的会话 head 失败';
    await sessionsQuery.refetch();
  } finally {
    forkSelectBusy.value = false;
  }
}

function resetNativeRestoreState(): void {
  nativeRestoreConfirm.value = false;
  nativeRestoreBusy.value = false;
  nativeRestoreError.value = '';
  nativeRestoreResult.value = null;
}

async function openDetail(item: SessionListItem): Promise<void> {
  selectedSessionId.value = item.sessionId;
  recoveryPermissionMode.value = 'standard';
  detail.value = null;
  detailError.value = '';
  recoveryRequest += 1;
  recoveryPlan.value = null;
  recoveryError.value = '';
  recoveryFeedback.value = '';
  resetNativeRestoreState();
  detailLoading.value = true;
  await nextTick();
  detailElement.value?.querySelector<HTMLElement>('[data-dialog-initial]')?.focus();
  const requestId = ++detailRequest;
  try {
    const nextDetail = await loadSessionDetail(item.sessionId);
    if (requestId === detailRequest && selectedSessionId.value === item.sessionId) {
      applySessionDetail(nextDetail, null);
      if (canPrepareRecovery(nextDetail) && !nextDetail.session.forked) void runRecoveryPlan();
    }
  } catch (error) {
    if (requestId === detailRequest) detailError.value = error instanceof Error ? error.message : '读取会话详情失败';
  } finally {
    if (requestId === detailRequest) detailLoading.value = false;
  }
}

function closeDetail(restoreFocus = true): void {
  const previousId = selectedSessionId.value;
  detailRequest += 1;
  selectedSessionId.value = null;
  detail.value = null;
  detailError.value = '';
  detailLoading.value = false;
  recoveryRequest += 1;
  recoveryPlan.value = null;
  recoveryLoading.value = false;
  recoveryError.value = '';
  recoveryFeedback.value = '';
  recoveryPermissionMode.value = 'standard';
  resetNativeRestoreState();
  cmuxSettingsOpen.value = false;
  cmuxSettingsError.value = '';
  cmuxOpenConfirm.value = false;
  cmuxOpenError.value = '';
  selectedHeadCheckpointId.value = null;
  selectedCheckpointPayload.value = null;
  checkpointPayloadLoading.value = false;
  checkpointPayloadError.value = '';
  forkSelectBusy.value = false;
  forkMergeOpen.value = false;
  forkMergeGoal.value = '';
  forkMergeNextSteps.value = '';
  forkMergeBaseCheckpointId.value = '';
  forkMergeBusy.value = false;
  forkMergeError.value = '';
  forkSplitOpen.value = false;
  forkSplitGoal.value = '';
  forkSplitNextSteps.value = '';
  forkSplitKeepCheckpointId.value = '';
  forkSplitBusy.value = false;
  forkSplitError.value = '';
  trashConflictSaveOpen.value = false;
  trashConflictGoal.value = '';
  trashConflictNextSteps.value = '';
  trashConflictSourceCheckpointId.value = '';
  trashConflictSaveBusy.value = false;
  trashConflictSaveError.value = '';
  if (!restoreFocus || !previousId) return;
  const index = displayedSessions.value.findIndex((item) => item.sessionId === previousId);
  if (index >= 0) void nextTick(() => sessionRows.value[index]?.focus({ preventScroll: true }));
}

async function runRecoveryPlan(localPath?: string | null, refreshRemote = true): Promise<void> {
  const sessionId = selectedSessionId.value;
  if (!sessionId || recoveryLoading.value) return;
  if (detail.value?.session.forked && !selectedHeadCheckpointId.value) {
    recoveryError.value = '会话已分叉，请先在上方选择一条 head 作为恢复基线';
    return;
  }
  const requestId = ++recoveryRequest;
  recoveryLoading.value = true;
  recoveryError.value = '';
  recoveryFeedback.value = '';
  cmuxOpenError.value = '';
  try {
    const plan = await api.sessionRecoveryPlan(sessionId, {
      localPath: localPath ?? undefined,
      checkpointId: selectedHeadCheckpointId.value ?? undefined,
      permissionMode: recoveryPermissionMode.value,
      refreshRemote,
    });
    if (requestId === recoveryRequest && selectedSessionId.value === sessionId) recoveryPlan.value = plan;
  } catch (error) {
    if (requestId === recoveryRequest) recoveryError.value = error instanceof Error ? error.message : '恢复预检失败';
  } finally {
    if (requestId === recoveryRequest) recoveryLoading.value = false;
  }
}

async function setRecoveryPermissionMode(mode: ProviderPermissionMode): Promise<void> {
  if (recoveryPermissionMode.value === mode || recoveryLoading.value) return;
  recoveryPermissionMode.value = mode;
  recoveryFeedback.value = '';
  if (recoveryPlan.value) await runRecoveryPlan(recoveryPlan.value.mapping.localPath, false);
}

async function selectRecoveryDirectory(): Promise<void> {
  if (recoveryLoading.value) return;
  recoveryLoading.value = true;
  recoveryError.value = '';
  try {
    const selected = await api.selectDirectory(recoveryPlan.value?.mapping.localPath ?? undefined);
    recoveryLoading.value = false;
    if (selected.path) await runRecoveryPlan(selected.path);
  } catch (error) {
    recoveryLoading.value = false;
    recoveryError.value = error instanceof Error ? error.message : '选择项目目录失败';
  }
}

function requestNativeRestore(event?: Event): void {
  const native = recoveryPlan.value?.native;
  if (!native?.available || !native.fingerprint || native.action === 'already-present') return;
  rememberRelayOverlayTrigger(event);
  nativeRestoreError.value = '';
  nativeRestoreConfirm.value = true;
}

function closeNativeRestoreConfirmation(): void {
  if (nativeRestoreBusy.value) return;
  nativeRestoreConfirm.value = false;
  nativeRestoreError.value = '';
}

async function confirmNativeRestore(): Promise<void> {
  const sessionId = selectedSessionId.value;
  const plan = recoveryPlan.value;
  if (!sessionId || !plan?.native.fingerprint || nativeRestoreBusy.value) return;
  nativeRestoreBusy.value = true;
  nativeRestoreError.value = '';
  try {
    const result = await api.executeNativeRestore(sessionId, {
      localPath: plan.mapping.localPath,
      checkpointId: selectedHeadCheckpointId.value ?? undefined,
      permissionMode: recoveryPermissionMode.value,
      expectedNativeFingerprint: plan.native.fingerprint,
      confirmNativeRestore: true,
    });
    nativeRestoreConfirm.value = false;
    nativeRestoreResult.value = result;
    await runRecoveryPlan(plan.mapping.localPath);
    nativeRestoreResult.value = result;
    recoveryFeedback.value = result.message;
  } catch (error) {
    nativeRestoreError.value = error instanceof Error ? error.message : '原生会话还原失败';
  } finally {
    nativeRestoreBusy.value = false;
  }
}

async function rollbackNativeRestore(): Promise<void> {
  const sessionId = selectedSessionId.value;
  const result = nativeRestoreResult.value;
  const localPath = recoveryPlan.value?.mapping.localPath;
  if (
    !sessionId ||
    !result?.rollbackAvailable ||
    !result.backupId ||
    !result.installedSha256 ||
    nativeRestoreBusy.value
  ) return;
  nativeRestoreBusy.value = true;
  nativeRestoreError.value = '';
  try {
    const rolledBack = await api.rollbackNativeRestore(sessionId, {
      backupId: result.backupId,
      expectedInstalledSha256: result.installedSha256,
      confirmRollback: true,
    });
    nativeRestoreResult.value = null;
    await runRecoveryPlan(localPath);
    recoveryFeedback.value = rolledBack.message;
  } catch (error) {
    nativeRestoreError.value = error instanceof Error ? error.message : '原生会话回滚失败';
  } finally {
    nativeRestoreBusy.value = false;
  }
}

async function copyRecovery(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    recoveryFeedback.value = `${label}已复制`;
  } catch {
    recoveryFeedback.value = `${label}复制失败，请检查浏览器剪贴板权限`;
  }
}

async function loadCmuxSettings(): Promise<void> {
  if (cmuxSettingsLoading.value) return;
  cmuxSettingsLoading.value = true;
  cmuxSettingsError.value = '';
  try {
    const settings = await api.cmuxSettings();
    cmuxSettings.value = settings;
    cmuxClaudeTemplate.value = settings.config.providerTemplates.claude;
    cmuxCodexTemplate.value = settings.config.providerTemplates.codex;
  } catch (error) {
    cmuxSettingsError.value = error instanceof Error ? error.message : '读取 cmux 设置失败';
  } finally {
    cmuxSettingsLoading.value = false;
  }
}

function openCmuxSettings(event?: Event): void {
  rememberRelayOverlayTrigger(event);
  cmuxSettingsOpen.value = true;
  cmuxSettingsError.value = '';
  void loadCmuxSettings();
}

function closeCmuxSettings(): void {
  if (cmuxSettingsSaving.value) return;
  cmuxSettingsOpen.value = false;
  cmuxSettingsError.value = '';
}

async function saveCmuxSettings(): Promise<void> {
  if (cmuxSettingsSaving.value) return;
  cmuxSettingsSaving.value = true;
  cmuxSettingsError.value = '';
  try {
    const settings = await api.saveCmuxSettings({
      version: 1,
      providerTemplates: {
        claude: cmuxClaudeTemplate.value,
        codex: cmuxCodexTemplate.value,
      },
    });
    cmuxSettings.value = settings;
    cmuxClaudeTemplate.value = settings.config.providerTemplates.claude;
    cmuxCodexTemplate.value = settings.config.providerTemplates.codex;
    cmuxSettingsOpen.value = false;
    if (recoveryPlan.value) await runRecoveryPlan(recoveryPlan.value.mapping.localPath);
    recoveryFeedback.value = '命令模板已保存，恢复指令已重新生成';
  } catch (error) {
    cmuxSettingsError.value = error instanceof Error ? error.message : '保存 cmux 设置失败';
  } finally {
    cmuxSettingsSaving.value = false;
  }
}

async function requestCmuxOpen(event?: Event): Promise<void> {
  const launch = recoveryPlan.value?.launch;
  if (!launch || !recoveryPlan.value?.command?.available) return;
  if (!launch.canOpenInCmux) {
    await copyRecovery(launch.shellCommand, '恢复指令');
    return;
  }
  rememberRelayOverlayTrigger(event);
  cmuxOpenError.value = '';
  cmuxOpenConfirm.value = true;
}

function closeCmuxConfirmation(): void {
  if (cmuxOpenBusy.value) return;
  cmuxOpenConfirm.value = false;
  cmuxOpenError.value = '';
}

async function confirmCmuxOpen(): Promise<void> {
  const sessionId = selectedSessionId.value;
  const plan = recoveryPlan.value;
  if (!sessionId || !plan?.launch || cmuxOpenBusy.value) return;
  cmuxOpenBusy.value = true;
  cmuxOpenError.value = '';
  try {
    const result = await api.openRecoveryInCmux(sessionId, {
      localPath: plan.mapping.localPath,
      checkpointId: selectedHeadCheckpointId.value ?? undefined,
      permissionMode: recoveryPermissionMode.value,
      expectedLaunchFingerprint: plan.launch.fingerprint,
      confirmOpenInCmux: true,
    });
    cmuxOpenConfirm.value = false;
    recoveryFeedback.value = result.message;
  } catch (error) {
    cmuxOpenError.value = error instanceof Error ? error.message : '打开 cmux workspace 失败';
  } finally {
    cmuxOpenBusy.value = false;
  }
}

function checkpointBranchLabel(checkpoint: Checkpoint): string {
  return `${checkpoint.machine} · ${relativeTime(checkpoint.createdAt)} · ${checkpoint.checkpointId.slice(0, 8)}`;
}

function resetVaultSetupForm(): void {
  vaultSetupPath.value = vaultStatus.value?.suggestedVaultPath ?? '';
  vaultSetupRemoteEnabled.value = false;
  vaultSetupRemoteName.value = 'origin';
  vaultSetupRemoteUrl.value = '';
  vaultSetupError.value = '';
}

function openVaultSetup(event?: Event): void {
  if (vaultSetupBusy.value) return;
  rememberRelayOverlayTrigger(event);
  resetVaultSetupForm();
  vaultSetupOpen.value = true;
}

function closeVaultSetup(): void {
  if (vaultSetupBusy.value || vaultSetupDirectoryPicking.value) return;
  vaultSetupOpen.value = false;
  vaultSetupError.value = '';
}

async function selectVaultSetupDirectory(): Promise<void> {
  if (vaultSetupDirectoryPicking.value || vaultSetupBusy.value) return;
  vaultSetupDirectoryPicking.value = true;
  vaultSetupError.value = '';
  try {
    const selected = await api.selectDirectory(vaultSetupPath.value.trim() || undefined);
    if (selected.path) vaultSetupPath.value = selected.path;
  } catch (error) {
    vaultSetupError.value = error instanceof Error ? error.message : '选择 Session Vault 目录失败';
  } finally {
    vaultSetupDirectoryPicking.value = false;
  }
}

async function initializeVaultFromSetup(): Promise<void> {
  if (!vaultSetupCanSubmit.value || vaultSetupBusy.value) {
    if (!vaultSetupPath.value.trim()) {
      vaultSetupError.value = '请选择或填写一个独立的 Session Vault 目录';
    } else if (!vaultSetupRemoteReady.value) {
      vaultSetupError.value = vaultSetupRemoteName.value.trim() && !vaultSetupRemoteNameValid.value
        ? 'Remote 名称只能包含字母、数字、点、下划线和连字符'
        : '请补全独立私有远端信息';
    }
    return;
  }
  vaultSetupBusy.value = true;
  vaultSetupError.value = '';
  emit('syncBusy', true);
  try {
    const status = await api.initializeSessionVault({
      vaultPath: vaultSetupPath.value.trim(),
      remoteName: vaultSetupRemoteName.value.trim() || 'origin',
      remoteUrl: vaultSetupRemoteEnabled.value ? vaultSetupRemoteUrl.value.trim() : null,
      enableRemoteSync: vaultSetupRemoteEnabled.value,
      confirmationPhrase: vaultSetupRemoteEnabled.value ? sessionVaultPrivateRemoteConfirmation : '',
    });
    await Promise.all([
      vaultStatusQuery.refetch(),
      sessionsQuery.refetch(),
      epochQuery.refetch(),
    ]);
    feedback.value = {
      tone: 'success',
      message: vaultSetupRemoteEnabled.value
        ? `会话保存已启用 · ${status.privacyLabel} · 保存后会自动同步`
        : '会话保存已启用 · 内容只保存在这台电脑',
    };
    vaultSetupOpen.value = false;
    await nextTick();
    requestAnimationFrame(() => saveButton.value?.focus({ preventScroll: true }));
  } catch (error) {
    vaultSetupError.value = error instanceof Error ? error.message : '会话保存设置失败';
  } finally {
    vaultSetupBusy.value = false;
    emit('syncBusy', false);
  }
}

async function retryVaultState(): Promise<void> {
  if (vaultStateRefreshing.value) return;
  feedback.value = null;
  await Promise.all([
    vaultStatusQuery.refetch(),
    sessionsQuery.refetch(),
    epochQuery.refetch(),
  ]);
}

function openForkMerge(event?: Event): void {
  if (!detail.value?.session.forked || lifecycleLocked.value) return;
  rememberRelayOverlayTrigger(event);
  forkMergeOpen.value = true;
  forkMergeError.value = '';
  forkMergeBaseCheckpointId.value = selectedHeadCheckpointId.value ?? detail.value.session.latestCheckpointId;
  if (!forkMergeGoal.value.trim()) forkMergeGoal.value = `合并：${detail.value.session.title || '未命名交接'}`;
}

function closeForkMerge(): void {
  if (forkMergeBusy.value) return;
  forkMergeOpen.value = false;
  forkMergeError.value = '';
}

async function submitForkMerge(): Promise<void> {
  const currentDetail = detail.value;
  if (!currentDetail?.session.forked || forkMergeBusy.value || lifecycleLocked.value) return;
  const goal = forkMergeGoal.value.trim();
  const nextSteps = forkMergeNextSteps.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!goal) {
    forkMergeError.value = '请填写合并后的目标';
    return;
  }
  if (nextSteps.length === 0) {
    forkMergeError.value = '请至少填写一条合并后的下一步，每行一条';
    return;
  }
  if (!currentDetail.session.headCheckpointIds.includes(forkMergeBaseCheckpointId.value)) {
    forkMergeError.value = '请选择一个当前 head 作为恢复基线';
    return;
  }
  forkMergeBusy.value = true;
  forkMergeError.value = '';
  try {
    const base = currentDetail.checkpoints.find(
      (checkpoint) => checkpoint.checkpointId === forkMergeBaseCheckpointId.value,
    );
    const result = await api.mergeSessionFork(currentDetail.session.sessionId, {
      expectedHeadCheckpointIds: currentDetail.session.headCheckpointIds,
      baseCheckpointId: forkMergeBaseCheckpointId.value,
      summary: {
        goal,
        completed: headCheckpoints.value.map((checkpoint) => `已复核分支：${checkpointBranchLabel(checkpoint)}`),
        decisions: [
          `合并 ${currentDetail.session.headCheckpointIds.length} 条会话分支`,
          `恢复基线采用 ${base ? checkpointBranchLabel(base) : forkMergeBaseCheckpointId.value.slice(0, 8)}`,
        ],
        nextSteps,
        blockers: [],
        commands: [],
        risks: ['本操作合并交接上下文与 lineage，不会自动合并各分支的项目源码或 provider 原生会话。'],
        source: 'manual',
        reviewedAt: new Date().toISOString(),
      },
    });
    forkMergeOpen.value = false;
    feedback.value = {
      tone: result.auditRecorded ? 'success' : 'warning',
      message: result.message,
    };
    await sessionsQuery.refetch();
    const nextDetail = await loadSessionDetail(currentDetail.session.sessionId);
    if (selectedSessionId.value === currentDetail.session.sessionId) {
      applySessionDetail(nextDetail, result.checkpoint.checkpointId);
    }
  } catch (error) {
    forkMergeError.value = error instanceof Error ? error.message : '生成合并交接点失败';
    await sessionsQuery.refetch();
  } finally {
    forkMergeBusy.value = false;
  }
}

function openForkSplit(event?: Event): void {
  if (!detail.value?.session.forked || headCheckpoints.value.length !== 2 || lifecycleLocked.value) return;
  rememberRelayOverlayTrigger(event);
  forkSplitOpen.value = true;
  forkSplitError.value = '';
  forkSplitKeepCheckpointId.value = selectedHeadCheckpointId.value ?? detail.value.session.latestCheckpointId;
  const splitHead = headCheckpoints.value.find(
    (checkpoint) => checkpoint.checkpointId !== forkSplitKeepCheckpointId.value,
  );
  forkSplitGoal.value = `拆分：${splitHead?.title || detail.value.session.title || '未命名交接'}`;
}

function closeForkSplit(): void {
  if (forkSplitBusy.value) return;
  forkSplitOpen.value = false;
  forkSplitError.value = '';
}

async function submitForkSplit(): Promise<void> {
  const currentDetail = detail.value;
  if (!currentDetail?.session.forked || forkSplitBusy.value || lifecycleLocked.value) return;
  const splitHead = headCheckpoints.value.find(
    (checkpoint) => checkpoint.checkpointId !== forkSplitKeepCheckpointId.value,
  );
  const goal = forkSplitGoal.value.trim();
  const nextSteps = forkSplitNextSteps.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (headCheckpoints.value.length !== 2 || !splitHead) {
    forkSplitError.value = '拆分仅适用于恰好两个当前 head；请刷新详情或先合并多余分支';
    return;
  }
  if (!goal || nextSteps.length === 0) {
    forkSplitError.value = '请填写新会话的目标，并至少填写一条下一步';
    return;
  }
  forkSplitBusy.value = true;
  forkSplitError.value = '';
  try {
    const result = await api.splitSessionFork(currentDetail.session.sessionId, {
      expectedHeadCheckpointIds: currentDetail.session.headCheckpointIds,
      selectedHeadCheckpointId: forkSplitKeepCheckpointId.value,
      splitHeadCheckpointId: splitHead.checkpointId,
      newSessionSummary: {
        goal,
        completed: [`从 ${checkpointBranchLabel(splitHead)} 拆分为独立逻辑会话`],
        decisions: [
          `原会话继续沿 ${forkSplitKeepCheckpointId.value.slice(0, 10)} 前进`,
          '拆出会话保留原 checkpoint 作为只读 lineage 来源',
        ],
        nextSteps,
        blockers: [],
        commands: [],
        risks: ['拆分只改变 Fleet 逻辑会话归属，不移动 provider 原始会话，也不修改项目源码。'],
        source: 'manual',
        reviewedAt: new Date().toISOString(),
      },
    });
    forkSplitOpen.value = false;
    feedback.value = {
      tone: result.auditRecorded ? 'success' : 'warning',
      message: `${result.message} · 新会话 ${result.newSessionId.slice(-10)}`,
    };
    await sessionsQuery.refetch();
    const nextDetail = await loadSessionDetail(currentDetail.session.sessionId);
    if (selectedSessionId.value === currentDetail.session.sessionId) {
      applySessionDetail(nextDetail, forkSplitKeepCheckpointId.value);
    }
  } catch (error) {
    forkSplitError.value = error instanceof Error ? error.message : '拆分会话失败';
    await sessionsQuery.refetch();
  } finally {
    forkSplitBusy.value = false;
  }
}

function openTrashConflictSave(event?: Event): void {
  const currentDetail = detail.value;
  if (!currentDetail?.session.deletionConflict || lifecycleLocked.value) return;
  rememberRelayOverlayTrigger(event);
  const source = deletionConflictCheckpoints.value[0];
  trashConflictSaveOpen.value = true;
  trashConflictSaveError.value = '';
  if (!currentDetail.session.deletionConflictCheckpointIds.includes(trashConflictSourceCheckpointId.value)) {
    trashConflictSourceCheckpointId.value = source?.checkpointId ?? '';
  }
  if (!trashConflictGoal.value.trim()) {
    trashConflictGoal.value = `继续：${source?.title || currentDetail.session.title || '未命名交接'}`;
  }
}

function closeTrashConflictSave(): void {
  if (trashConflictSaveBusy.value) return;
  trashConflictSaveOpen.value = false;
  trashConflictSaveError.value = '';
}

async function submitTrashConflictSave(): Promise<void> {
  const currentDetail = detail.value;
  if (!currentDetail?.session.deletionConflict || trashConflictSaveBusy.value || lifecycleLocked.value) return;
  const goal = trashConflictGoal.value.trim();
  const nextSteps = trashConflictNextSteps.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const source = deletionConflictCheckpoints.value.find(
    (checkpoint) => checkpoint.checkpointId === trashConflictSourceCheckpointId.value,
  );
  if (!currentDetail.session.lifecycleVersion) {
    trashConflictSaveError.value = '删除状态版本缺失，请先刷新详情或拉取 Vault 更新';
    return;
  }
  if (!source) {
    trashConflictSaveError.value = '请选择一条已删除后新增的 checkpoint';
    return;
  }
  if (!goal) {
    trashConflictSaveError.value = '请填写新会话目标';
    return;
  }
  if (nextSteps.length === 0) {
    trashConflictSaveError.value = '请至少填写一条新会话下一步，每行一条';
    return;
  }
  trashConflictSaveBusy.value = true;
  trashConflictSaveError.value = '';
  try {
    const result = await api.saveDeletionConflictAsNew(currentDetail.session.sessionId, {
      expectedLifecycleVersion: currentDetail.session.lifecycleVersion,
      expectedConflictCheckpointIds: currentDetail.session.deletionConflictCheckpointIds,
      sourceCheckpointId: source.checkpointId,
      summary: {
        goal,
        completed: [`从已删除会话的新增内容另存：${checkpointBranchLabel(source)}`],
        decisions: [
          '原逻辑会话继续保留在废纸篓',
          `新逻辑会话从 checkpoint ${source.checkpointId.slice(0, 10)} 独立继续`,
        ],
        nextSteps,
        blockers: [],
        commands: [],
        risks: ['另存只复制 Fleet 交接对象与 lineage，不移动 provider 原始会话，也不修改项目源码。'],
        source: 'manual',
        reviewedAt: new Date().toISOString(),
      },
    });
    trashConflictSaveOpen.value = false;
    feedback.value = {
      tone: result.resolution.auditRecorded ? 'success' : 'warning',
      message: `${result.message} · 新会话 ${result.newSessionId.slice(-10)}`,
    };
    await sessionsQuery.refetch();
    const nextDetail = await loadSessionDetail(currentDetail.session.sessionId);
    if (selectedSessionId.value === currentDetail.session.sessionId) applySessionDetail(nextDetail);
  } catch (error) {
    trashConflictSaveError.value = error instanceof Error ? error.message : '另存删除后的新增内容失败';
    await sessionsQuery.refetch();
  } finally {
    trashConflictSaveBusy.value = false;
  }
}

function lifecycleLabel(action: SessionLifecycleMutationAction): string {
  return {
    pin: '置顶',
    unpin: '取消置顶',
    archive: '归档',
    restore: '恢复归档',
    trash: '移入废纸篓',
    untrash: '恢复废纸篓会话',
  }[action];
}

function inverseLifecycleAction(action: SessionLifecycleMutationAction): SessionLifecycleMutationAction {
  return {
    pin: 'unpin',
    unpin: 'pin',
    archive: 'restore',
    restore: 'archive',
    trash: 'untrash',
    untrash: 'trash',
  }[action] as SessionLifecycleMutationAction;
}

function lifecycleIntent(item: SessionListItem, action: SessionLifecycleMutationAction): LifecycleIntent {
  return {
    sessionId: item.sessionId,
    title: item.title || '未命名交接',
    action,
    expectedLifecycleVersion: item.lifecycleVersion,
  };
}

function cancelLifecycleConfirmation(): void {
  pendingLifecycle.value = null;
}

function requestLifecycle(
  item: SessionListItem,
  action: SessionLifecycleMutationAction,
  event?: Event,
): void {
  if (lifecycleBusy.value || lifecycleLocked.value) return;
  const intent = lifecycleIntent(item, action);
  if (action !== 'archive' && action !== 'trash') {
    void runLifecycleMutation(intent);
    return;
  }
  rememberRelayOverlayTrigger(event);
  pendingLifecycle.value = intent;
}

async function refreshLifecycleSession(sessionId: string): Promise<SessionListItem | null> {
  await sessionsQuery.refetch();
  const visible = sessionsQuery.data.value?.items.find((item) => item.sessionId === sessionId);
  if (visible) return visible;
  const nextDetail = await loadSessionDetail(sessionId).catch(() => null);
  return nextDetail?.session ?? null;
}

async function runLifecycleMutation(intent: LifecycleIntent): Promise<void> {
  if (lifecycleBusy.value || lifecycleLocked.value) return;
  lifecycleBusy.value = { sessionId: intent.sessionId, action: intent.action };
  feedback.value = null;
  try {
    const result = await api.mutateSessionLifecycle(
      intent.sessionId,
      intent.action,
      intent.expectedLifecycleVersion,
    );
    cancelLifecycleConfirmation();
    const leavesCurrentFilter =
      (intent.action === 'archive' && lifecycle.value === 'active') ||
      (intent.action === 'restore' && lifecycle.value === 'archived') ||
      (intent.action === 'trash' && lifecycle.value !== 'all' && lifecycle.value !== 'trashed') ||
      (intent.action === 'untrash' && lifecycle.value === 'trashed');
    if (selectedSessionId.value === intent.sessionId && leavesCurrentFilter) closeDetail(false);
    const refreshed = await sessionsQuery.refetch();
    const nextTotalPages = refreshed.data?.totalPages ?? 0;
    if (page.value > 1 && page.value > nextTotalPages) page.value = Math.max(1, nextTotalPages);
    if (selectedSessionId.value === intent.sessionId) {
      const nextDetail = await loadSessionDetail(intent.sessionId).catch(() => null);
      if (nextDetail) applySessionDetail(nextDetail);
    }
    feedback.value = {
      tone: result.auditRecorded ? 'success' : 'warning',
      message: result.message,
      undo: {
        sessionId: intent.sessionId,
        title: intent.title,
        action: inverseLifecycleAction(intent.action),
        expectedLifecycleVersion: result.event.eventId,
      },
    };
  } catch (error) {
    cancelLifecycleConfirmation();
    feedback.value = {
      tone: 'error',
      message: error instanceof Error ? error.message : `会话${lifecycleLabel(intent.action)}失败`,
      retry: { sessionId: intent.sessionId, action: intent.action },
    };
    await sessionsQuery.refetch();
  } finally {
    lifecycleBusy.value = null;
  }
}

async function openTrashEmptyPreview(event?: Event): Promise<void> {
  if (trashPreviewLoading.value || trashEmptyBusy.value) return;
  rememberRelayOverlayTrigger(event);
  trashPreviewOpen.value = true;
  trashPreview.value = null;
  trashPreviewError.value = '';
  trashPreviewLoading.value = true;
  try {
    trashPreview.value = await api.sessionTrashEmptyPreview();
  } catch (error) {
    trashPreviewError.value = error instanceof Error ? error.message : '读取废纸篓清理预览失败';
  } finally {
    trashPreviewLoading.value = false;
  }
}

function closeTrashEmptyPreview(): void {
  if (trashEmptyBusy.value) return;
  trashPreviewOpen.value = false;
  trashPreview.value = null;
  trashPreviewError.value = '';
}

async function confirmTrashEmpty(): Promise<void> {
  if (!trashPreview.value?.canEmpty || trashEmptyBusy.value) return;
  trashEmptyBusy.value = true;
  trashPreviewError.value = '';
  try {
    const result = await api.emptySessionTrash(trashPreview.value.fingerprint);
    trashPreviewOpen.value = false;
    trashPreview.value = null;
    feedback.value = { tone: result.auditRecorded ? 'success' : 'warning', message: result.message };
    await sessionsQuery.refetch();
  } catch (error) {
    trashPreviewError.value = error instanceof Error ? error.message : '清空废纸篓失败';
    await sessionsQuery.refetch();
  } finally {
    trashEmptyBusy.value = false;
  }
}

async function retryLifecycleMutation(input: Pick<LifecycleIntent, 'sessionId' | 'action'>): Promise<void> {
  if (lifecycleBusy.value) return;
  const item = await refreshLifecycleSession(input.sessionId);
  if (!item) {
    feedback.value = { tone: 'error', message: '会话状态已变化且无法重新读取，请先拉取 Vault 更新' };
    return;
  }
  await runLifecycleMutation(lifecycleIntent(item, input.action));
}

async function synchronize(mode: 'pull' | 'push'): Promise<void> {
  if (syncBusy.value) return;
  syncBusy.value = mode;
  emit('syncBusy', true);
  feedback.value = null;
  try {
    const result = mode === 'pull' ? await api.pullSessionVault() : await api.pushSessionVault();
    feedback.value = {
      tone: 'success',
      message: mode === 'pull' ? `拉取完成 · ${result.message}` : `同步完成 · ${result.message}`,
    };
    await sessionsQuery.refetch();
    if (selectedSessionId.value) {
      const current = selectedSessionId.value;
      const nextDetail = await loadSessionDetail(current).catch(() => null);
      if (selectedSessionId.value === current && nextDetail) applySessionDetail(nextDetail);
    }
  } catch (error) {
    feedback.value = { tone: 'error', message: error instanceof Error ? error.message : 'Session Vault 同步失败' };
    await sessionsQuery.refetch();
  } finally {
    syncBusy.value = null;
    emit('syncBusy', false);
  }
}

async function pullUpdates(): Promise<void> {
  if (canPull.value) await synchronize('pull');
}

async function continueWork(): Promise<void> {
  if (continueBusy.value || syncBusy.value || saveBusy.value) return;
  continueBusy.value = true;
  sessionManagementOpen.value = false;
  continueMode.value = false;
  continueRemoteUpdatedIds.value = new Set();
  feedback.value = null;
  if (selectedSessionId.value) closeDetail(false);
  archivedEpochId.value = null;
  lifecycle.value = 'active';
  provider.value = null;
  searchDraft.value = '';
  search.value = '';
  page.value = 1;
  await nextTick();

  const before = await sessionsQuery.refetch();
  const previousCheckpoints = new Map(
    (before.data?.items ?? []).map((item) => [item.sessionId, item.latestCheckpointId]),
  );
  let pullError = '';
  if (canPull.value) {
    syncBusy.value = 'pull';
    emit('syncBusy', true);
    try {
      await api.pullSessionVault();
    } catch (error) {
      pullError = error instanceof Error ? error.message : 'Session Vault 拉取失败';
    } finally {
      syncBusy.value = null;
      emit('syncBusy', false);
    }
  }

  const refreshed = await sessionsQuery.refetch();
  continueRemoteUpdatedIds.value = new Set(
    (refreshed.data?.items ?? [])
      .filter((item) => previousCheckpoints.get(item.sessionId) !== item.latestCheckpointId)
      .map((item) => item.sessionId),
  );
  continueMode.value = true;
  feedback.value = pullError
    ? { tone: 'warning', message: `拉取未完成，仍保留本机列表 · ${pullError}` }
    : {
        tone: 'success',
        message: canPull.value
          ? `已拉取并整理可继续会话 · ${continueRemoteUpdatedIds.value.size} 条来自远端的新变化`
          : '已按可行动状态整理本机会话；当前 Vault 未启用可拉取远端',
      };
  await nextTick();
  const recommended = displayedSessions.value[0];
  if (recommended) await openDetail(recommended);
  continueBusy.value = false;
}

function exitContinueMode(): void {
  continueMode.value = false;
  continueRemoteUpdatedIds.value = new Set();
}

function openSaveDrawer(): void {
  if (viewingArchivedEpoch.value || saveBusy.value) return;
  if (selectedSessionId.value) closeDetail(false);
  sessionManagementOpen.value = false;
  exitContinueMode();
  feedback.value = null;
  saveOpen.value = true;
}

function closeSaveDrawer(): void {
  if (saveBusy.value) return;
  saveOpen.value = false;
  void nextTick(() => saveButton.value?.focus({ preventScroll: true }));
}

function handleSaveBusy(busy: boolean): void {
  saveBusy.value = busy;
  emit('syncBusy', busy);
}

async function handleSessionSaved(result: { tone: 'success' | 'warning'; message: string }): Promise<void> {
  exitContinueMode();
  feedback.value = { tone: result.tone, message: result.message };
  await Promise.all([sessionsQuery.refetch(), epochQuery.refetch()]);
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (saveOpen.value) {
    return;
  }
  if (!activeRelayOverlay.value && !selectedSessionId.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (vaultSetupOpen.value) {
    closeVaultSetup();
    return;
  }
  if (nativeRestoreConfirm.value) {
    closeNativeRestoreConfirmation();
    return;
  }
  if (cmuxOpenConfirm.value) {
    closeCmuxConfirmation();
    return;
  }
  if (cmuxSettingsOpen.value) {
    closeCmuxSettings();
    return;
  }
  if (epochRotateOpen.value) {
    closeEpochRotation();
    return;
  }
  if (epochManagerOpen.value) {
    closeEpochManager();
    return;
  }
  if (trashConflictSaveOpen.value) {
    closeTrashConflictSave();
    return;
  }
  if (trashPreviewOpen.value) {
    closeTrashEmptyPreview();
    return;
  }
  if (forkSplitOpen.value) {
    closeForkSplit();
    return;
  }
  if (forkMergeOpen.value) {
    closeForkMerge();
    return;
  }
  if (pendingLifecycle.value) {
    if (!lifecycleBusy.value) cancelLifecycleConfirmation();
    return;
  }
  if (selectedSessionId.value) closeDetail();
}

onMounted(() => window.addEventListener('keydown', handleEscape));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  emit('syncBusy', false);
  emit('pullAvailable', false);
});

defineExpose({ pullUpdates });
</script>

<template>
  <main class="workspace relay-workspace" :class="{ 'detail-open': selectedSessionId }">
    <section class="relay-command-deck" aria-labelledby="relay-heading">
      <div class="relay-intro">
        <span class="relay-kicker"><Sparkles :size="12" />AI WORK HANDOFF / LOCAL FIRST</span>
        <div class="relay-title-line">
          <div>
            <h1 id="relay-heading">会话接力</h1>
          </div>
        </div>
      </div>

      <div class="relay-actions" :class="{ unconfigured: vaultUnconfigured || Boolean(vaultStatusError) }">
        <div class="relay-sync-chip" :data-tone="vaultStatusError ? 'red' : syncMeta.tone" role="status" aria-live="polite">
          <AlertTriangle v-if="vaultStatusError" :size="15" />
          <component :is="syncMeta.icon" v-else :size="15" :class="{ spinning: syncBusy === 'pull' }" />
          <span v-if="vaultStatusError"><strong>会话仓库不可用</strong><small>{{ vaultStatusError }} · {{ vaultPrivacyLabel }}</small></span>
          <span v-else><strong>{{ syncMeta.label }}</strong><small>{{ sessionManagementOpen ? (sync?.message ?? '正在读取同步状态') : syncUserMessage }} · {{ vaultPrivacyLabel }}</small></span>
        </div>
        <button v-if="vaultStatusError" class="secondary-button relay-vault-retry-button" :disabled="vaultStateRefreshing" @click="retryVaultState">
          <LoaderCircle v-if="vaultStateRefreshing" :size="15" class="spinning" /><RotateCw v-else :size="15" />重新读取
        </button>
        <button v-else-if="!vaultConfigurationKnown" class="secondary-button relay-vault-loading-button" disabled>
          <LoaderCircle :size="15" class="spinning" />读取同步状态
        </button>
        <button v-else-if="vaultUnconfigured" class="primary-button relay-vault-setup-button" :disabled="vaultSetupBusy" @click="openVaultSetup($event)">
          <LoaderCircle v-if="vaultSetupBusy" :size="15" class="spinning" /><Database v-else :size="15" />开始使用
        </button>
        <template v-else>
          <button ref="saveButton" class="primary-button relay-save-button" :disabled="viewingArchivedEpoch || saveBusy || syncBusy !== null" @click="openSaveDrawer">
            <LoaderCircle v-if="saveBusy" :size="15" class="spinning" /><Cloud v-else-if="sync?.remoteSyncEnabled" :size="15" /><HardDrive v-else :size="15" />{{ primarySaveLabel }}
          </button>
          <button class="primary-button relay-continue-button" :disabled="viewingArchivedEpoch || continueBusy || saveBusy || syncBusy !== null" @click="continueWork">
            <LoaderCircle v-if="continueBusy" :size="15" class="spinning" /><TerminalSquare v-else :size="15" />接着工作
          </button>
          <button v-if="canPush" class="primary-button" :disabled="syncBusy !== null || saveBusy" @click="synchronize('push')">
            <LoaderCircle v-if="syncBusy === 'push'" :size="15" class="spinning" /><ArrowUpFromLine v-else :size="15" />重试同步
          </button>
          <button class="secondary-button relay-management-button" :class="{ active: sessionManagementOpen }" @click="toggleSessionManagement">
            <Settings2 :size="15" />{{ sessionManagementOpen ? '收起管理' : '管理与历史' }}
          </button>
          <button v-if="sessionManagementOpen" class="secondary-button" :disabled="!canPull || syncBusy !== null || saveBusy" @click="synchronize('pull')">
            <LoaderCircle v-if="syncBusy === 'pull'" :size="15" class="spinning" /><ArrowDownToLine v-else :size="15" />拉取更新
          </button>
          <button v-if="sessionManagementOpen" class="relay-epoch-button" :class="{ suggested: epochStatus?.rotationSuggested }" :disabled="saveBusy" @click="openEpochManager($event)">
            <Database :size="15" /><span>{{ epochLabel(activeEpoch) }}</span><b>{{ epochStatus?.archivedEpochs.length ?? 0 }}</b>
          </button>
        </template>
      </div>

      <div v-if="sessionManagementOpen" class="relay-metrics" aria-label="会话接力摘要">
        <div><span>逻辑会话</span><strong>{{ total }}</strong><small>当前筛选总数</small></div>
        <div><span>本机待同步</span><strong>{{ sync?.ahead ?? 0 }}</strong><small>Vault commits</small></div>
        <div><span>代码不可达</span><strong>{{ codeUnavailableCount }}</strong><small>当前页 checkpoint</small></div>
        <div><span>已分叉</span><strong>{{ forkedCount }}</strong><small>当前页接力链</small></div>
      </div>
    </section>

    <p v-if="feedback" class="relay-feedback" :data-tone="feedback.tone" role="status">
      <CheckCircle2 v-if="feedback.tone === 'success'" :size="15" /><AlertTriangle v-else :size="15" />{{ feedback.message }}
      <span class="relay-feedback-actions">
        <button v-if="feedback.retry" class="relay-feedback-action" :disabled="lifecycleBusy !== null" @click="retryLifecycleMutation(feedback.retry)"><RotateCcw :size="12" />重试</button>
        <button v-if="feedback.undo" class="relay-feedback-action" :disabled="lifecycleBusy !== null || lifecycleLocked" @click="runLifecycleMutation(feedback.undo)"><RotateCcw :size="12" />撤销</button>
        <button class="relay-feedback-close" aria-label="关闭提示" @click="feedback = null"><X :size="13" /></button>
      </span>
    </p>

    <section v-if="continueMode" class="relay-continue-banner" aria-label="接着工作模式">
      <span class="relay-continue-mark"><TerminalSquare :size="16" /></span>
      <span><strong>{{ selectedItem ? `已为你打开：${selectedItem.title || '未命名交接'}` : '已整理可继续会话' }}</strong><small>优先远端新变化与最近活动；只有选错时才需要返回列表更换。</small></span>
      <b>{{ continueRemoteUpdateCount }} 条新内容</b>
      <button class="secondary-button" @click="exitContinueMode"><X :size="13" />退出排序</button>
    </section>

    <section v-if="viewingArchivedEpoch" class="relay-epoch-view-banner" aria-label="当前正在查看归档 Vault 纪元">
      <LockKeyhole :size="16" />
      <span><strong>{{ epochLabel(archivedEpoch) }} · 只读归档</strong><small>可搜索、查看和导出 checkpoint；不会接收新内容，也不会改写旧 Vault。</small></span>
      <code>{{ archivedEpoch?.head?.slice(0, 10) ?? 'NO HEAD' }}</code>
      <button class="secondary-button" @click="returnToActiveEpoch"><RotateCw :size="14" />返回当前纪元</button>
    </section>

    <section class="relay-ledger">
      <div class="relay-list-panel">
        <header class="relay-list-toolbar" :class="{ compact: !sessionManagementOpen }">
          <div>
            <span class="relay-section-index">{{ viewingArchivedEpoch ? `ARCHIVE ${String(archivedEpoch?.sequence ?? 0).padStart(2, '0')} / READ ONLY` : sessionManagementOpen ? '01 / CHECKPOINT INDEX' : 'RECENT HANDOFFS' }}</span>
            <h2>{{ viewingArchivedEpoch ? '旧纪元交接记录' : sessionManagementOpen ? '交接记录' : '最近交接' }}</h2>
          </div>
          <div v-if="sessionManagementOpen" class="relay-filters">
            <label class="relay-search">
              <Search :size="15" />
              <input v-model="searchDraft" aria-label="搜索会话、项目、分支或设备" placeholder="会话 / 项目 / 分支 / 设备" />
              <button v-if="searchDraft" aria-label="清除会话搜索" @click="searchDraft = ''"><X :size="13" /></button>
            </label>
            <div class="relay-provider-filter" role="group" aria-label="按 AI provider 筛选">
              <button :class="{ active: provider === null }" :aria-pressed="provider === null" @click="setProvider(null)">全部</button>
              <button :class="{ active: provider === 'claude' }" :aria-pressed="provider === 'claude'" @click="setProvider('claude')">Claude</button>
              <button :class="{ active: provider === 'codex' }" :aria-pressed="provider === 'codex'" @click="setProvider('codex')">Codex</button>
            </div>
          </div>
        </header>

        <nav v-if="sessionManagementOpen" class="relay-lifecycle-tabs" aria-label="按会话生命周期筛选">
          <button :class="{ active: lifecycle === 'active' }" :aria-pressed="lifecycle === 'active'" @click="setLifecycle('active')">
            <Inbox :size="14" /><span>活跃</span><b>{{ lifecycleCounts.active }}</b>
          </button>
          <button :class="{ active: lifecycle === 'archived' }" :aria-pressed="lifecycle === 'archived'" @click="setLifecycle('archived')">
            <Archive :size="14" /><span>已归档</span><b>{{ lifecycleCounts.archived }}</b>
          </button>
          <button :class="{ active: lifecycle === 'trashed' }" :aria-pressed="lifecycle === 'trashed'" @click="setLifecycle('trashed')">
            <Trash2 :size="14" /><span>废纸篓</span><b>{{ lifecycleCounts.trashed }}</b>
          </button>
          <button :class="{ active: lifecycle === 'all' }" :aria-pressed="lifecycle === 'all'" @click="setLifecycle('all')">
            <Layers3 :size="14" /><span>全部</span><b>{{ lifecycleCounts.all }}</b>
          </button>
          <button v-if="lifecycle === 'trashed' && !viewingArchivedEpoch" class="relay-empty-trash" :disabled="trashPreviewLoading || trashEmptyBusy || lifecycleLocked || lifecycleCounts.trashed === 0" @click="openTrashEmptyPreview($event)">
            <LoaderCircle v-if="trashPreviewLoading" :size="13" class="spinning" /><Trash2 v-else :size="13" />清理到期内容
          </button>
          <small v-if="viewingArchivedEpoch"><LockKeyhole :size="12" />旧纪元固定在归档 HEAD，只提供只读检索</small>
          <small v-else-if="lifecycleLocked"><AlertTriangle :size="12" />远端状态未合并，先拉取更新后再管理</small>
          <small v-else>生命周期操作只改变 Vault 状态，不触碰 provider 原始会话或项目源码</small>
        </nav>

        <div v-if="sessionsQuery.isLoading.value" class="relay-state" role="status">
          <LoaderCircle :size="22" class="spinning" /><strong>{{ sessionManagementOpen ? '正在重建本机会话索引' : '正在读取交接记录' }}</strong><span>{{ sessionManagementOpen ? '只读取 Vault HEAD 中已跟踪的事件…' : '稍候即可继续最近的工作。' }}</span>
        </div>
        <div v-else-if="queryError" class="relay-state relay-state-error">
          <AlertTriangle :size="22" /><strong>{{ sessionManagementOpen ? '会话索引不可用' : '交接记录暂时不可用' }}</strong><span>{{ sessionManagementOpen ? queryError : '本机内容没有丢失，可以重新读取。' }}</span>
          <button class="secondary-button" @click="sessionsQuery.refetch()"><CircleDashed :size="14" />重新读取</button>
        </div>
        <div v-else-if="sessions.length === 0" class="relay-state relay-state-empty">
          <CloudOff v-if="sync?.state === 'unconfigured'" :size="24" />
          <Archive v-else-if="lifecycle === 'archived'" :size="24" />
          <Trash2 v-else-if="lifecycle === 'trashed'" :size="24" />
          <Inbox v-else :size="24" />
          <strong>{{ sync?.state === 'unconfigured' ? '还没有开始保存会话' : lifecycle === 'archived' ? '暂无已归档会话' : lifecycle === 'trashed' ? '废纸篓是空的' : '没有匹配的交接记录' }}</strong>
          <span>{{ sync?.state === 'unconfigured' ? '完成一次快速设置后，交接记录会出现在这里。' : lifecycle === 'archived' ? '归档会话仍完整保留，并会在这里提供恢复入口。' : lifecycle === 'trashed' ? '移入废纸篓的会话默认保留 30 天，并同步到其他设备。' : '调整关键词、Provider 或生命周期条件后再试。' }}</span>
          <button v-if="vaultUnconfigured" class="primary-button relay-vault-empty-setup" @click="openVaultSetup($event)"><Database :size="14" />开始设置</button>
        </div>
        <div v-else class="relay-session-list" role="list" aria-label="AI 会话交接列表">
          <article
            v-for="(item, index) in displayedSessions"
            :key="item.sessionId"
            class="relay-session-row"
            :class="{ selected: selectedSessionId === item.sessionId, pinned: item.pinned, archived: item.lifecycleState === 'archived', trashed: item.lifecycleState === 'trashed', conflicted: item.deletionConflict, compact: !sessionManagementOpen || continueMode }"
            :data-provider="item.provider"
            :data-session-id="item.sessionId"
            data-testid="session-row"
            role="listitem"
          >
            <button
              :ref="(element) => setRowRef(element, index)"
              class="relay-session-open"
              @click="openDetail(item)"
              @keydown.up.prevent="moveRowFocus(index, -1)"
              @keydown.down.prevent="moveRowFocus(index, 1)"
            >
              <span class="relay-provider-mark"><Bot :size="16" /><small>{{ providerLabel(item.provider) }}</small></span>
              <span class="relay-session-copy">
                <span class="relay-session-title">
                  <Pin v-if="item.pinned" :size="12" class="relay-pinned-mark" aria-label="已置顶" />
                  <strong>{{ item.title || '未命名交接' }}</strong>
                  <em v-if="continueMode && index === 0" data-tone="recommended"><TerminalSquare :size="11" />推荐继续</em>
                  <em v-if="continueRemoteUpdatedIds.has(item.sessionId)" data-tone="remote"><ArrowDownToLine :size="11" />刚从远端更新</em>
                  <em v-if="item.lifecycleState === 'archived'" data-tone="archive"><Archive :size="11" />已归档</em>
                  <em v-else-if="item.lifecycleState === 'trashed'" data-tone="trash"><Trash2 :size="11" />废纸篓</em>
                  <em v-if="item.deletionConflict" data-tone="conflict"><AlertTriangle :size="11" />已删除会话产生新内容</em>
                  <em v-if="item.forked"><GitFork :size="11" />已分叉</em>
                </span>
                <span class="relay-session-context">
                  <span><Code2 :size="11" />{{ shortProject(item) }}</span>
                  <span v-if="sessionManagementOpen"><GitBranch :size="11" />{{ item.branch ?? 'DETACHED' }}</span>
                  <code v-if="sessionManagementOpen">{{ shortHash(item.head) }}</code>
                </span>
                <span v-if="sessionManagementOpen || !item.capabilities.codeReachable || item.capabilities.wipRef || item.lifecycleState === 'trashed'" class="relay-capabilities">
                  <small v-if="sessionManagementOpen" data-tone="green"><ShieldCheck :size="10" />可继续工作</small>
                  <small v-if="sessionManagementOpen && item.capabilities.nativeResume" data-tone="cyan">可恢复原会话</small>
                  <small v-if="sessionManagementOpen || !item.capabilities.codeReachable" :data-tone="item.capabilities.codeReachable ? 'cyan' : 'red'">{{ item.capabilities.codeReachable ? '代码已准备' : '代码未带上' }}</small>
                  <small v-if="item.capabilities.wipRef" data-tone="yellow">含未提交改动</small>
                  <small v-if="item.lifecycleState === 'trashed'" :data-tone="item.payloadState === 'available' ? 'yellow' : 'red'">{{ item.payloadState === 'available' ? retentionLabel(item) : '当前 Vault 内容已清理' }}</small>
                  <small v-if="item.lifecycleState === 'trashed'">{{ formatBytes(item.payloadBytes) }}</small>
                </span>
              </span>
              <span class="relay-session-meta">
                <time :datetime="item.latestCheckpointAt"><Clock3 :size="11" />{{ relativeTime(item.latestCheckpointAt) }}</time>
                <small v-if="sessionManagementOpen">{{ item.machine }}</small>
                <span v-if="sessionManagementOpen">{{ item.checkpointCount }} 次保存<ChevronRight :size="13" /></span>
                <ChevronRight v-else :size="14" />
              </span>
            </button>
            <div v-if="sessionManagementOpen && !continueMode" class="relay-session-management" aria-label="会话管理操作">
              <button v-if="viewingArchivedEpoch" class="readonly" @click="openDetail(item)">
                <LockKeyhole :size="14" /><span>只读查看</span>
              </button>
              <button
                v-else
                class="pin"
                :class="{ active: item.pinned }"
                :title="item.pinned ? '取消置顶' : '置顶会话'"
                :aria-label="`${item.pinned ? '取消置顶' : '置顶'} ${item.title || '未命名交接'}`"
                :aria-pressed="item.pinned"
                :disabled="lifecycleBusy !== null || lifecycleLocked || item.lifecycleState === 'trashed'"
                @click="requestLifecycle(item, item.pinned ? 'unpin' : 'pin', $event)"
              >
                <LoaderCircle v-if="lifecycleBusy?.sessionId === item.sessionId && ['pin', 'unpin'].includes(lifecycleBusy.action)" :size="14" class="spinning" />
                <PinOff v-else-if="item.pinned" :size="14" />
                <Pin v-else :size="14" />
                <span>{{ item.pinned ? '取消' : '置顶' }}</span>
              </button>
              <button
                v-if="!viewingArchivedEpoch && item.lifecycleState !== 'trashed'"
                class="archive"
                :class="{ restore: item.lifecycleState === 'archived' }"
                :title="item.lifecycleState === 'archived' ? '恢复到活跃列表' : '归档会话'"
                :aria-label="`${item.lifecycleState === 'archived' ? '恢复归档' : '归档'} ${item.title || '未命名交接'}`"
                :disabled="lifecycleBusy !== null || lifecycleLocked"
                @click="requestLifecycle(item, item.lifecycleState === 'archived' ? 'restore' : 'archive', $event)"
              >
                <LoaderCircle v-if="lifecycleBusy?.sessionId === item.sessionId && ['archive', 'restore'].includes(lifecycleBusy.action)" :size="14" class="spinning" />
                <ArchiveRestore v-else-if="item.lifecycleState === 'archived'" :size="14" />
                <Archive v-else :size="14" />
                <span>{{ item.lifecycleState === 'archived' ? '恢复' : '归档' }}</span>
              </button>
              <button
                v-if="!viewingArchivedEpoch && item.lifecycleState !== 'trashed'"
                class="trash"
                :aria-label="`移入废纸篓 ${item.title || '未命名交接'}`"
                :disabled="lifecycleBusy !== null || lifecycleLocked"
                @click="requestLifecycle(item, 'trash', $event)"
              >
                <LoaderCircle v-if="lifecycleBusy?.sessionId === item.sessionId && lifecycleBusy.action === 'trash'" :size="14" class="spinning" />
                <Trash2 v-else :size="14" /><span>删除</span>
              </button>
              <button
                v-else-if="!viewingArchivedEpoch"
                class="restore"
                :disabled="lifecycleBusy !== null || lifecycleLocked || item.payloadState !== 'available'"
                :title="item.payloadState === 'available' ? '从废纸篓恢复' : '当前 Vault 对象已清理，只能从 Git 历史或备份人工恢复'"
                @click="requestLifecycle(item, 'untrash', $event)"
              >
                <LoaderCircle v-if="lifecycleBusy?.sessionId === item.sessionId && lifecycleBusy.action === 'untrash'" :size="14" class="spinning" />
                <ArchiveRestore v-else :size="14" /><span>恢复</span>
              </button>
            </div>
          </article>
        </div>

        <footer v-if="totalPages > 1" class="relay-pagination" aria-label="会话列表分页">
          <span>PAGE {{ page.toString().padStart(2, '0') }} / {{ totalPages.toString().padStart(2, '0') }}</span>
          <div>
            <button class="icon-button" aria-label="上一页" :disabled="page <= 1 || sessionsQuery.isFetching.value" @click="page -= 1"><ChevronLeft :size="16" /></button>
            <button class="icon-button" aria-label="下一页" :disabled="page >= totalPages || sessionsQuery.isFetching.value" @click="page += 1"><ChevronRight :size="16" /></button>
          </div>
        </footer>
      </div>

      <Transition name="fade">
        <button v-if="selectedSessionId" class="drawer-backdrop relay-detail-backdrop" aria-label="关闭会话详情" @click="closeDetail()" />
      </Transition>
      <Transition name="drawer">
        <aside
          v-if="selectedSessionId"
          ref="detailElement"
          class="relay-detail"
          role="dialog"
          aria-modal="true"
          aria-labelledby="relay-detail-title"
          data-focus-layer
          tabindex="-1"
        >
          <header class="relay-detail-header">
            <div>
              <span class="relay-section-index">{{ sessionManagementOpen ? '02 / HANDOFF LEDGER' : continueMode ? 'CONTINUE WORK' : 'HANDOFF SUMMARY' }}</span>
              <h2 id="relay-detail-title">{{ selectedItem?.title || '会话交接详情' }}</h2>
              <p>{{ selectedItem ? `${providerLabel(selectedItem.provider)} · ${shortProject(selectedItem)} · ${selectedItem.machine}` : '正在读取 checkpoint' }}</p>
            </div>
            <div class="relay-detail-header-actions">
              <button
                v-if="selectedItem && selectedItem.lifecycleState !== 'trashed' && !viewingArchivedEpoch && !continueMode && sessionManagementOpen"
                class="ghost-button pin-action"
                :class="{ active: selectedItem.pinned }"
                :disabled="lifecycleBusy !== null || lifecycleLocked"
                @click="requestLifecycle(selectedItem, selectedItem.pinned ? 'unpin' : 'pin', $event)"
              ><LoaderCircle v-if="lifecycleBusy?.sessionId === selectedItem.sessionId && ['pin', 'unpin'].includes(lifecycleBusy.action)" :size="13" class="spinning" /><PinOff v-else-if="selectedItem.pinned" :size="13" /><Pin v-else :size="13" />{{ selectedItem.pinned ? '取消置顶' : '置顶' }}</button>
              <button
                v-if="selectedItem && selectedItem.lifecycleState !== 'trashed' && !viewingArchivedEpoch && !continueMode && sessionManagementOpen"
                class="ghost-button archive-action"
                :class="{ restore: selectedItem.lifecycleState === 'archived' }"
                :disabled="lifecycleBusy !== null || lifecycleLocked"
                @click="requestLifecycle(selectedItem, selectedItem.lifecycleState === 'archived' ? 'restore' : 'archive', $event)"
              ><LoaderCircle v-if="lifecycleBusy?.sessionId === selectedItem.sessionId && ['archive', 'restore'].includes(lifecycleBusy.action)" :size="13" class="spinning" /><ArchiveRestore v-else-if="selectedItem.lifecycleState === 'archived'" :size="13" /><Archive v-else :size="13" />{{ selectedItem.lifecycleState === 'archived' ? '恢复归档' : '归档' }}</button>
              <button
                v-if="selectedItem && selectedItem.lifecycleState !== 'trashed' && !viewingArchivedEpoch && !continueMode && sessionManagementOpen"
                class="ghost-button danger"
                :disabled="lifecycleBusy !== null || lifecycleLocked"
                @click="requestLifecycle(selectedItem, 'trash', $event)"
              ><LoaderCircle v-if="lifecycleBusy?.sessionId === selectedItem.sessionId && lifecycleBusy.action === 'trash'" :size="13" class="spinning" /><Trash2 v-else :size="13" />移入废纸篓</button>
              <button
                v-else-if="selectedItem && !selectedItem.deletionConflict && !viewingArchivedEpoch && !continueMode && sessionManagementOpen"
                class="ghost-button restore"
                :disabled="lifecycleBusy !== null || lifecycleLocked || selectedItem.payloadState !== 'available'"
                :title="selectedItem.payloadState === 'available' ? '恢复到移入废纸篓前的状态' : '当前 Vault 对象已清理，只能从 Git 历史或备份人工恢复'"
                @click="requestLifecycle(selectedItem, 'untrash', $event)"
              ><LoaderCircle v-if="lifecycleBusy?.sessionId === selectedItem.sessionId && lifecycleBusy.action === 'untrash'" :size="13" class="spinning" /><ArchiveRestore v-else :size="13" />恢复会话</button>
              <span v-if="viewingArchivedEpoch" class="relay-detail-readonly"><LockKeyhole :size="13" />只读纪元</span>
              <button v-if="viewingArchivedEpoch" class="ghost-button export-action" :disabled="!selectedHeadCheckpointId || epochExportBusy" @click="exportArchivedCheckpoint">
                <LoaderCircle v-if="epochExportBusy" :size="13" class="spinning" /><Download v-else :size="13" />导出交接
              </button>
              <button class="icon-button" aria-label="关闭会话详情" data-dialog-initial @click="closeDetail()"><X :size="16" /></button>
            </div>
          </header>

          <div v-if="detailLoading" class="relay-detail-state"><LoaderCircle :size="22" class="spinning" /><span>正在读取已跟踪交接对象…</span></div>
          <div v-else-if="detailError" class="relay-detail-state relay-state-error"><AlertTriangle :size="22" /><span>{{ detailError }}</span></div>
          <template v-else-if="detail">
            <section v-if="detail.session.lifecycleState === 'trashed'" class="relay-trash-panel" :class="{ conflict: detail.session.deletionConflict }">
              <span class="relay-trash-mark"><AlertTriangle v-if="detail.session.deletionConflict" :size="18" /><Trash2 v-else :size="18" /></span>
              <div>
                <template v-if="detail.session.deletionConflict">
                  <span class="relay-section-index">TRASH CONFLICT / {{ detail.session.deletionConflictCheckpointIds.length }} NEW CHECKPOINT{{ detail.session.deletionConflictCheckpointIds.length > 1 ? 'S' : '' }}</span>
                  <h3>已删除会话产生新内容</h3>
                  <p>另一台尚未看到删除标记的设备继续写入了 checkpoint。Fleet 不会静默删除这些内容，也不会擅自把原会话恢复；请明确选择一种处理方式。</p>
                  <div v-if="!viewingArchivedEpoch" class="relay-trash-conflict-actions">
                    <button
                      class="conflict-restore-button"
                      :disabled="lifecycleBusy !== null || lifecycleLocked || detail.session.payloadState !== 'available'"
                      @click="requestLifecycle(detail.session, 'untrash', $event)"
                    >
                      <LoaderCircle v-if="lifecycleBusy?.sessionId === detail.session.sessionId && lifecycleBusy.action === 'untrash'" :size="14" class="spinning" />
                      <ArchiveRestore v-else :size="14" />
                      <span><strong>恢复原会话</strong><small>删除标记撤销，新增内容继续留在原接力线</small></span>
                    </button>
                    <button class="conflict-save-button" :disabled="trashConflictSaveBusy || lifecycleLocked" @click="openTrashConflictSave($event)">
                      <CopyPlus :size="14" />
                      <span><strong>另存为新会话</strong><small>原会话留在废纸篓，新增内容独立继续</small></span>
                    </button>
                  </div>
                  <p v-else class="relay-archive-inline-note"><LockKeyhole :size="13" />这是旧纪元在归档 HEAD 上的历史状态，只允许查看和导出。</p>
                </template>
                <template v-else>
                  <span class="relay-section-index">TRASH / {{ detail.session.payloadState.toUpperCase() }}</span>
                  <h3>{{ detail.session.payloadState === 'available' ? '这条会话正在废纸篓保留期内' : '当前 Vault 的交接对象已经清理' }}</h3>
                  <p v-if="detail.session.payloadState === 'available'">保留至 {{ detail.session.retentionUntil ? new Date(detail.session.retentionUntil).toLocaleString() : '未知时间' }}。恢复只追加生命周期事件，不会改动 provider 原始目录。</p>
                  <p v-else>列表元数据与生命周期事件仍在，但交接正文已不在当前工作树中；Git 历史或备份仍可能保留旧版本，Fleet 不承诺一键恢复。</p>
                </template>
              </div>
            </section>

            <section v-if="detail.session.forked && detail.session.lifecycleState !== 'trashed'" class="relay-fork-panel" aria-labelledby="relay-fork-title">
              <div class="relay-fork-heading">
                <span class="relay-fork-mark"><GitFork :size="18" /></span>
                <div>
                  <span class="relay-section-index">DIVERGENCE / {{ headCheckpoints.length }} HEADS</span>
                  <h3 id="relay-fork-title">这条接力线已在多台设备上分叉</h3>
                  <p>时间只用于辨认，不决定谁覆盖谁。选择一条继续只影响本次恢复；生成合并交接点才会把全部 head 连接成新的共同起点。</p>
                </div>
              </div>

              <div v-if="!viewingArchivedEpoch" class="relay-fork-choices" aria-label="分叉处理方式">
                <div class="continue-choice" :class="{ active: selectedHeadCheckpointId }">
                  <span>01</span><GitBranch :size="15" /><strong>继续其中一条</strong><small>先在下方选择恢复基线</small>
                </div>
                <button class="merge-choice" :disabled="forkMergeBusy || lifecycleLocked" @click="openForkMerge($event)">
                  <span>02</span><GitMerge :size="15" /><strong>合并为新交接点</strong><small>保留全部 lineage，不合并源码</small>
                </button>
                <button class="split-choice" :disabled="headCheckpoints.length !== 2 || forkSplitBusy || lifecycleLocked" :title="headCheckpoints.length === 2 ? '把两条 head 拆成两个独立逻辑会话' : '仅支持恰好两个当前 head'" @click="openForkSplit($event)">
                  <span>03</span><Layers3 :size="15" /><strong>拆成两个会话</strong><small>{{ headCheckpoints.length === 2 ? '一条留在原会话，一条独立出去' : '仅支持两个当前 head' }}</small>
                </button>
              </div>

              <div class="relay-fork-heads" role="radiogroup" aria-label="选择要继续的 checkpoint head">
                <button
                  v-for="(checkpoint, index) in headCheckpoints"
                  :key="checkpoint.checkpointId"
                  :class="{ selected: selectedHeadCheckpointId === checkpoint.checkpointId }"
                  :aria-checked="selectedHeadCheckpointId === checkpoint.checkpointId"
                  :disabled="checkpointPayloadLoading || forkSelectBusy"
                  role="radio"
                  @click="selectForkHead(checkpoint)"
                >
                  <span class="relay-fork-head-index">HEAD {{ String(index + 1).padStart(2, '0') }}</span>
                  <strong>{{ checkpoint.title || '未命名交接' }}</strong>
                  <span><Clock3 :size="11" />{{ checkpoint.machine }} · {{ relativeTime(checkpoint.createdAt) }}</span>
                  <code>{{ checkpoint.branch ?? 'DETACHED' }} · {{ shortHash(checkpoint.head) }} · {{ checkpoint.checkpointId.slice(0, 10) }}</code>
                  <em>{{ selectedHeadCheckpointId === checkpoint.checkpointId ? '已选为恢复基线' : '选择这条继续' }}</em>
                </button>
              </div>
              <p v-if="checkpointPayloadLoading" class="relay-fork-state"><LoaderCircle :size="14" class="spinning" />正在读取所选分支的交接对象…</p>
              <p v-else-if="checkpointPayloadError" class="relay-fork-state error"><AlertTriangle :size="14" />{{ checkpointPayloadError }}</p>
              <p v-else-if="selectedCheckpoint" class="relay-fork-state selected">
                <CheckCircle2 :size="14" />已选择 {{ selectedCheckpoint.machine }} 的 head；可先预览恢复，也可将它确认为这条逻辑会话今后的唯一主线。
                <button v-if="!viewingArchivedEpoch" :disabled="forkSelectBusy || lifecycleLocked" @click="confirmForkSelection">
                  <LoaderCircle v-if="forkSelectBusy" :size="12" class="spinning" /><GitBranch v-else :size="12" />确认沿这条继续
                </button>
              </p>
            </section>

            <section v-if="sessionManagementOpen" class="relay-detail-signals">
              <div><span>Provider</span><strong>{{ providerLabel(detail.session.provider) }}</strong></div>
              <div><span>Branch</span><strong>{{ activeWorkspace?.branch ?? (forkSelectionRequired ? 'SELECT HEAD' : 'DETACHED') }}</strong></div>
              <div><span>Workspace</span><strong>{{ activeWorkspace ? (activeWorkspace.dirty ? `${activeWorkspace.changedFiles} changed` : 'clean') : 'pending' }}</strong></div>
              <div><span>Code</span><strong :data-tone="selectedCheckpoint?.capabilities.codeReachable === false ? 'red' : 'green'">{{ selectedCheckpoint ? (selectedCheckpoint.capabilities.codeReachable ? 'reachable' : 'unreachable') : 'pending' }}</strong></div>
            </section>

            <section class="relay-handoff">
              <div class="relay-detail-section-heading"><span>{{ sessionManagementOpen ? '交接摘要' : '当前工作' }}</span><small>{{ sessionManagementOpen ? `${selectedCheckpoint ? selectedCheckpoint.checkpointId.slice(0, 10) : '先选择 HEAD'} · 已秘密扫描` : '已安全检查' }}</small></div>
              <template v-if="activeHandoffMarkdown">
                <pre v-if="sessionManagementOpen">{{ activeHandoffMarkdown }}</pre>
                <div v-else class="relay-handoff-brief">
                  <div class="relay-handoff-brief-row goal">
                    <span>当前目标</span>
                    <p>{{ activeHandoffFocus.goal }}</p>
                  </div>
                  <div class="relay-handoff-brief-row next">
                    <span>接下来</span>
                    <ol v-if="activeHandoffFocus.nextSteps.length">
                      <li v-for="step in activeHandoffFocus.nextSteps" :key="step">{{ step }}</li>
                    </ol>
                    <p v-else>暂无明确下一步，继续前先确认当前目标。</p>
                  </div>
                  <details class="relay-handoff-full">
                    <summary><span>查看完整交接记录</span><small>已完成、决定、阻塞和风险</small><ChevronRight :size="14" /></summary>
                    <pre>{{ activeHandoffMarkdown }}</pre>
                  </details>
                </div>
              </template>
              <div v-else-if="detail.session.payloadState !== 'available'" class="relay-handoff-pending"><Trash2 :size="18" /><span>交接正文已从当前 Vault 工作树清理；Git 历史或备份中仍可能保留旧版本。</span></div>
              <div v-else class="relay-handoff-pending"><GitFork :size="18" /><span>请选择上方一条 head，避免把较新的时间误当成正确分支。</span></div>
            </section>

            <section v-if="detail.session.lifecycleState !== 'trashed' && detail.session.payloadState === 'available' && !viewingArchivedEpoch" class="relay-recovery-panel" aria-labelledby="relay-recovery-title">
              <div class="relay-recovery-heading">
                <div>
                  <span class="relay-section-index">READY TO CONTINUE</span>
                  <h3 id="relay-recovery-title">准备继续</h3>
                  <p>Fleet 会自动确认项目位置和代码状态，不会切换分支或覆盖文件。</p>
                </div>
                <button v-if="recoveryPlan" class="secondary-button" :disabled="recoveryLoading || forkSelectionRequired || checkpointPayloadLoading" @click="runRecoveryPlan()">
                  <LoaderCircle v-if="recoveryLoading" :size="14" class="spinning" /><ShieldCheck v-else :size="14" />重新检查
                </button>
              </div>

              <div v-if="recoveryLoading" class="relay-recovery-state"><LoaderCircle :size="18" class="spinning" />正在准备本机项目…</div>
              <div v-else-if="recoveryError" class="relay-recovery-error"><AlertTriangle :size="16" /><span>{{ recoveryError }}</span><button class="link-button" @click="runRecoveryPlan()">重试</button></div>
              <div v-else-if="!recoveryPlan" class="relay-recovery-empty"><span>{{ forkSelectionRequired ? '先选择上方一条工作线，Fleet 会自动准备对应内容。' : '正在等待交接内容准备完成。' }}</span></div>
              <template v-else>
                <div class="relay-recovery-status" :data-tone="recoveryBlockingCount === 0 ? 'green' : 'red'">
                  <span class="relay-recovery-status-dot" />
                  <strong>{{ recoveryBlockingCount === 0 ? '检查通过，可以继续' : `还需处理 ${recoveryBlockingCount} 项` }}</strong>
                  <small>{{ recoveryPlan.mapping.message }}</small>
                </div>

                <div class="relay-recovery-path">
                  <div><span>本机项目目录</span><code>{{ recoveryPlan.mapping.localPath ?? '尚未选择' }}</code></div>
                  <button v-if="recoveryPlan.mapping.state !== 'matched-registered' && recoveryPlan.mapping.state !== 'matched-manual'" class="secondary-button" :disabled="recoveryLoading" @click="selectRecoveryDirectory"><FolderOpen :size="14" />选择目录</button>
                  <button v-else class="ghost-button" :disabled="recoveryLoading" @click="selectRecoveryDirectory"><FolderOpen :size="14" />更换目录</button>
                </div>

                <ul v-if="recoveryPlan.blockers.length" class="relay-recovery-blockers">
                  <li v-for="item in recoveryPlan.blockers" :key="`${item.code}-${item.message}`" :data-severity="item.severity"><AlertTriangle :size="14" /><span><strong>{{ item.severity === 'blocking' ? '需处理' : '提醒' }}</strong>{{ item.message }}</span></li>
                </ul>

                <div v-if="recoveryBlockingCount === 0 && recoveryPlan.launch" class="relay-recovery-primary">
                  <span class="relay-recovery-primary-mark"><TerminalSquare :size="18" /></span>
                  <span>
                    <small>推荐下一步</small>
                    <strong>{{ providerLabel(detail.session.provider) }} · {{ shortProject(detail.session) }}</strong>
                    <em>{{ recoveryPermissionMode === 'standard' ? '使用标准权限，不自动改动工作区' : '已启用跳过权限确认' }}</em>
                  </span>
                  <button class="primary-button" :disabled="!recoveryPlan.command?.available" :title="recoveryPlan.launch.message ?? recoveryPlan.command?.message" @click="requestCmuxOpen($event)">
                    <TerminalSquare :size="15" />{{ recoveryPlan.launch.canOpenInCmux ? '立即继续' : '复制启动指令' }}
                  </button>
                </div>

                <details class="relay-recovery-advanced">
                  <summary>
                    <Settings2 :size="14" />
                    <span><strong>恢复设置与技术详情</strong><small>分支、WIP、原生恢复、权限和 cmux</small></span>
                    <ChevronRight :size="14" />
                  </summary>
                  <div class="relay-recovery-advanced-body">
                    <div v-if="recoveryPlan.workspace" class="relay-recovery-grid">
                      <div><span>当前分支</span><strong :data-tone="recoveryPlan.workspace.branchMatchesCheckpoint ? 'green' : 'red'">{{ recoveryPlan.workspace.branch ?? 'DETACHED' }}</strong><small>{{ recoveryPlan.workspace.branchMatchesCheckpoint ? '与 checkpoint 一致' : '与 checkpoint 不一致' }}</small></div>
                      <div><span>当前 HEAD</span><strong :data-tone="recoveryPlan.workspace.headMatchesCheckpoint ? 'green' : 'red'">{{ shortHash(recoveryPlan.workspace.head) }}</strong><small>{{ recoveryPlan.workspace.headMatchesCheckpoint ? '基线一致' : '需要人工确认' }}</small></div>
                      <div><span>工作区</span><strong :data-tone="recoveryPlan.workspace.dirty ? 'red' : 'green'">{{ recoveryPlan.workspace.dirty ? `${recoveryPlan.workspace.changedFiles} 个文件 Dirty` : 'clean' }}</strong><small>{{ recoveryPlan.workspace.dirty ? '恢复已停在预检' : '可继续查看指令' }}</small></div>
                      <div><span>WIP ref</span><strong :data-tone="recoveryPlan.wip.present ? (recoveryPlan.wip.reachable ? 'cyan' : 'red') : 'green'">{{ recoveryPlan.wip.present ? (recoveryPlan.wip.reachable ? `${recoveryPlan.wip.files.length} files` : 'unreachable') : 'none' }}</strong><small>{{ recoveryPlan.wip.present ? recoveryPlan.wip.message : '无未提交源码快照' }}</small></div>
                    </div>

                    <div v-if="recoveryPlan.wip.present || recoveryPlan.workspace?.dirty" class="relay-recovery-previews">
                      <details>
                        <summary><FileDiff :size="14" />差异预览 <small>{{ recoveryPlan.wip.present ? `${recoveryPlan.wip.files.length} 个 WIP 文件` : `${recoveryPlan.workspace?.files.length ?? 0} 个本机文件` }}</small></summary>
                        <div v-if="recoveryPlan.wip.present && recoveryPlan.wip.files.length" class="relay-diff-files"><code v-for="file in recoveryPlan.wip.files" :key="`${file.status}-${file.path}`"><b>{{ file.status }}</b>{{ file.path }}</code></div>
                        <pre v-if="recoveryPlan.wip.diff">{{ recoveryPlan.wip.diff }}</pre>
                        <pre v-else-if="recoveryPlan.workspace?.diff">{{ recoveryPlan.workspace.diff }}</pre>
                        <p v-else class="relay-recovery-muted">当前没有可显示的 patch 内容，只能提供文件状态。</p>
                      </details>
                    </div>

                    <div class="relay-native-restore" :data-tone="nativeRestoreTone(recoveryPlan.native)" data-testid="native-restore-card">
                      <div class="relay-native-mark"><Database :size="16" /></div>
                      <div class="relay-native-copy">
                        <span>NATIVE CAPSULE</span>
                        <strong>{{ nativeRestoreLabel(recoveryPlan.native) }}</strong>
                        <small>{{ recoveryPlan.native.message }}</small>
                      </div>
                      <div class="relay-native-meta">
                        <span><b>版本</b><code>{{ recoveryPlan.native.providerVersionAtCapture ?? '未记录' }} → {{ recoveryPlan.native.localProviderVersion ?? '未检测' }}</code></span>
                        <span><b>落点</b><code :title="recoveryPlan.native.targetDisplayPath ?? undefined">{{ recoveryPlan.native.targetDisplayPath ?? '等待兼容性校验' }}</code></span>
                      </div>
                      <div class="relay-native-actions">
                        <button
                          v-if="recoveryPlan.native.available && recoveryPlan.native.action !== 'already-present'"
                          class="primary-button relay-native-button"
                          :disabled="nativeRestoreBusy || !recoveryPlan.native.fingerprint"
                          @click="requestNativeRestore($event)"
                        ><LoaderCircle v-if="nativeRestoreBusy" :size="13" class="spinning" /><Database v-else :size="13" />还原原生会话</button>
                        <button
                          v-else-if="recoveryPlan.native.action === 'already-present' && recoveryPlan.native.nativeCommand"
                          class="secondary-button"
                          @click="copyRecovery(recoveryPlan.native.nativeCommand, '原生 resume 指令')"
                        ><Copy :size="13" />复制 resume</button>
                        <span v-else class="relay-native-fallback"><ShieldCheck :size="12" />通用恢复保留</span>
                      </div>
                    </div>

                    <div v-if="nativeRestoreResult" class="relay-native-result" :data-status="nativeRestoreResult.status">
                  <CheckCircle2 v-if="nativeRestoreResult.status === 'verified'" :size="15" />
                  <AlertTriangle v-else :size="15" />
                  <span><strong>{{ nativeRestoreResult.status === 'verified' ? '原生会话已写入' : '原生还原未完成' }}</strong><small>{{ nativeRestoreResult.message }}</small></span>
                  <button v-if="nativeRestoreResult.rollbackAvailable" class="secondary-button" :disabled="nativeRestoreBusy" @click="rollbackNativeRestore"><RotateCcw :size="13" />一键回滚</button>
                  <button v-else-if="nativeRestoreResult.nativeCommand" class="secondary-button" @click="copyRecovery(nativeRestoreResult.nativeCommand, '原生 resume 指令')"><Copy :size="13" />复制 resume</button>
                    </div>
                    <p v-if="nativeRestoreError && !nativeRestoreConfirm" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ nativeRestoreError }}</p>

                    <div v-if="recoveryPlan.launch" class="relay-permission-selector" :data-mode="recoveryPermissionMode">
                  <span class="relay-permission-mark"><ShieldCheck v-if="recoveryPermissionMode === 'standard'" :size="16" /><AlertTriangle v-else :size="16" /></span>
                  <div class="relay-permission-copy">
                    <span>PROVIDER PERMISSIONS</span>
                    <strong>恢复会话启动权限</strong>
                    <small v-if="recoveryPermissionMode === 'standard'">Provider 保留自身审批与沙箱确认。</small>
                    <small v-else>跳过 Provider 的权限确认；复制指令、原生 resume 与 cmux 桥接都会加入下方参数。</small>
                  </div>
                  <div class="relay-permission-options" role="radiogroup" aria-label="恢复会话启动权限">
                    <button type="button" :class="{ active: recoveryPermissionMode === 'standard' }" :aria-checked="recoveryPermissionMode === 'standard'" role="radio" :disabled="recoveryLoading || cmuxOpenBusy || nativeRestoreBusy" @click="setRecoveryPermissionMode('standard')">标准权限</button>
                    <button type="button" class="dangerous" :class="{ active: recoveryPermissionMode === 'dangerous-bypass' }" :aria-checked="recoveryPermissionMode === 'dangerous-bypass'" role="radio" :disabled="recoveryLoading || cmuxOpenBusy || nativeRestoreBusy" @click="setRecoveryPermissionMode('dangerous-bypass')">跳过权限确认</button>
                  </div>
                  <code v-if="recoveryPlan.launch.permissionFlag">{{ recoveryPlan.launch.permissionFlag }}</code>
                    </div>

                    <div v-if="recoveryPlan.launch" class="relay-cmux-bridge" :data-state="recoveryPlan.launch.cmux.state">
                  <div class="relay-cmux-bridge-mark"><TerminalSquare :size="16" /></div>
                  <div>
                    <span>CMUX BRIDGE</span>
                    <strong>{{ cmuxCapabilityLabel }}</strong>
                    <small>{{ recoveryPlan.launch.canOpenInCmux ? '确认后新建独立 workspace' : '保留 shell 指令，不显示错误态' }}</small>
                  </div>
                  <div class="relay-cmux-runtime">
                    <span>Shell executable</span>
                    <code :title="recoveryPlan.launch.shellExecutable">{{ recoveryPlan.launch.shellExecutableSource === 'real-binary' ? recoveryPlan.launch.shellExecutable : `${recoveryPlan.launch.shellExecutable} · 待用户确认 PATH` }}</code>
                  </div>
                  <button class="relay-template-button" type="button" @click="openCmuxSettings($event)"><Settings2 :size="13" />命令模板</button>
                    </div>

                    <div class="relay-recovery-actions">
                      <button class="secondary-button" @click="copyRecovery(recoveryPlan.recoveryPrompt, '恢复提示词')"><Copy :size="14" />复制恢复提示词</button>
                      <button v-if="recoveryPlan.launch" class="secondary-button relay-copy-command" :disabled="!recoveryPlan.command?.available" :title="recoveryPlan.command?.message" @click="copyRecovery(recoveryPlan.launch.shellCommand, '恢复指令')"><Copy :size="14" />复制恢复指令</button>
                    </div>
                    <details v-if="recoveryPlan.launch" class="relay-command-preview">
                      <summary>查看经 shell quoting 的命令 <small>提示词仅引用本机文件</small></summary>
                      <pre>{{ recoveryPlan.launch.shellCommand }}</pre>
                    </details>
                  </div>
                </details>
                <p v-if="recoveryFeedback" class="relay-recovery-feedback" role="status"><CheckCircle2 :size="14" />{{ recoveryFeedback }}</p>
              </template>
            </section>

            <section v-if="sessionManagementOpen" class="relay-timeline">
              <div class="relay-detail-section-heading"><span>Checkpoint 时间线</span><small>最近 {{ recentCheckpoints.length }} / {{ detail.checkpoints.length }}</small></div>
              <ol>
                <li v-for="checkpoint in recentCheckpoints" :key="checkpoint.checkpointId" :class="{ head: detail.session.headCheckpointIds.includes(checkpoint.checkpointId), selected: selectedHeadCheckpointId === checkpoint.checkpointId }">
                  <i />
                  <div><strong>{{ checkpoint.title }}</strong><span>{{ checkpoint.machine }} · {{ relativeTime(checkpoint.createdAt) }}</span></div>
                  <code>{{ detail.session.headCheckpointIds.includes(checkpoint.checkpointId) ? 'HEAD · ' : '' }}{{ checkpoint.checkpointId.slice(0, 10) }}</code>
                </li>
              </ol>
            </section>

            <footer class="relay-readonly-note"><LockKeyhole v-if="viewingArchivedEpoch" :size="14" /><ShieldCheck v-else :size="14" />{{ viewingArchivedEpoch ? '旧纪元固定在归档 HEAD；Fleet 只读取已跟踪对象，不执行 Pull、Push、生命周期变更或 checkpoint 写入。' : sessionManagementOpen ? '生命周期事件只作用于 Session Vault；不会删除 provider 原始会话、项目源码或 cmux workspace。清理当前对象也不等于抹除 Git 历史。' : '这里只管理交接记录，不会改动项目源码或原始 AI 会话。' }}</footer>
          </template>
        </aside>
      </Transition>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="vaultSetupOpen" class="relay-confirm-layer" @mousedown.self="closeVaultSetup">
            <form
              class="relay-vault-setup-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="relay-vault-setup-title"
              aria-describedby="relay-vault-setup-description"
              data-focus-layer
              data-relay-focus-layer="vault-setup"
              tabindex="-1"
              @submit.prevent="initializeVaultFromSetup"
            >
              <header>
                <span class="relay-confirm-icon"><Database :size="19" /></span>
                <div>
                  <span class="relay-section-index">AI HANDOFF / QUICK START</span>
                  <h2 id="relay-vault-setup-title">开始保存 AI 会话</h2>
                  <p id="relay-vault-setup-description">默认直接保存在这台电脑，不需要配置目录或仓库。</p>
                </div>
                <button type="button" class="icon-button" aria-label="关闭开始设置" :disabled="vaultSetupBusy || vaultSetupDirectoryPicking" @click="closeVaultSetup"><X :size="16" /></button>
              </header>

              <div class="relay-vault-setup-body">
                <section class="relay-vault-setup-panel">
                  <div class="relay-vault-setup-heading">
                    <span><HardDrive :size="17" /></span>
                    <div><strong>直接开始</strong><small>Fleet 会自动使用专用位置，不会混入项目源码或 AI 登录目录。</small></div>
                  </div>
                  <label class="relay-vault-remote-toggle" :class="{ selected: vaultSetupRemoteEnabled }">
                    <input v-model="vaultSetupRemoteEnabled" data-dialog-initial type="checkbox" :disabled="vaultSetupBusy" />
                    <span class="relay-vault-mode-icon"><Cloud v-if="vaultSetupRemoteEnabled" :size="18" /><HardDrive v-else :size="18" /></span>
                    <span><strong>在其他电脑也能继续</strong><small>{{ vaultSetupRemoteEnabled ? '填写你的私有 Git 地址，保存后会自动同步。' : '当前只保存在这台电脑；以后仍可开启。' }}</small></span>
                    <span class="relay-vault-toggle-switch" aria-hidden="true"><i /></span>
                  </label>
                  <label v-if="vaultSetupRemoteEnabled" class="relay-vault-remote-url-field">
                    <span>私有 Git 地址</span>
                    <input v-model="vaultSetupRemoteUrl" data-testid="vault-setup-remote-url" maxlength="2000" :disabled="vaultSetupBusy" placeholder="git@host:me/session-vault.git" />
                    <small>继续使用电脑现有的 Git 登录；Fleet 不保存密码或 Token。</small>
                  </label>
                  <p class="relay-vault-storage-note"><LockKeyhole :size="14" /><span>交接内容会以明文保存在专用 Git 仓库；点击开始即表示你了解拥有访问权的人可以阅读。</span></p>
                  <p class="relay-vault-privacy-result" :data-remote="vaultSetupRemoteEnabled"><LockKeyhole :size="14" />{{ vaultSetupRemoteEnabled ? '将标记为：私有（用户确认，未经 Fleet 验证）' : '当前选择：仅保存在这台电脑' }}</p>

                  <details class="relay-vault-advanced-settings">
                    <summary><Settings2 :size="13" />更改保存位置与高级设置</summary>
                    <div class="relay-vault-location-card">
                      <span class="relay-vault-location-icon"><Database :size="17" /></span>
                      <span><small>保存位置</small><strong>Moo Fleet 专用会话仓库</strong><code :title="vaultSetupPath">{{ vaultSetupPath || '正在读取推荐位置…' }}</code></span>
                      <button type="button" class="secondary-button" :disabled="vaultSetupBusy || vaultSetupDirectoryPicking" @click="selectVaultSetupDirectory"><LoaderCircle v-if="vaultSetupDirectoryPicking" :size="13" class="spinning" /><FolderOpen v-else :size="13" />更换</button>
                    </div>
                    <div class="relay-vault-advanced-grid">
                      <label class="relay-vault-path-field">
                        <span>绝对路径</span>
                        <input v-model="vaultSetupPath" data-testid="vault-setup-path" maxlength="4000" :disabled="vaultSetupBusy || vaultSetupDirectoryPicking" placeholder="/Users/me/Library/Application Support/Moo Fleet/session-vault" />
                      </label>
                      <label v-if="vaultSetupRemoteEnabled" class="relay-vault-path-field">
                        <span>Remote 名称</span>
                        <input v-model="vaultSetupRemoteName" maxlength="255" :disabled="vaultSetupBusy" aria-describedby="relay-vault-remote-name-help" />
                      </label>
                    </div>
                    <p id="relay-vault-remote-name-help"><ShieldCheck :size="13" />Fleet 会在开始前复核目录隔离、嵌套仓库、远端归属和凭据 URL；不安全的设置会被服务端阻止。</p>
                  </details>
                </section>

                <p v-if="vaultSetupError" class="relay-merge-error relay-vault-setup-error" role="alert"><AlertTriangle :size="14" />{{ vaultSetupError }}</p>
              </div>

              <footer>
                <button type="button" class="secondary-button" :disabled="vaultSetupBusy || vaultSetupDirectoryPicking" @click="closeVaultSetup">稍后设置</button>
                <span><ShieldCheck :size="12" />不会改动项目源码或 AI 原始会话</span>
                <button type="submit" class="primary-button relay-vault-create-button" :disabled="vaultSetupBusy || vaultSetupDirectoryPicking || !vaultSetupCanSubmit">
                  <LoaderCircle v-if="vaultSetupBusy" :size="14" class="spinning" /><Cloud v-else-if="vaultSetupRemoteEnabled" :size="14" /><Database v-else :size="14" />{{ vaultSetupRemoteEnabled ? '开始并同步' : '立即开始' }}
                </button>
              </footer>
            </form>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="nativeRestoreConfirm && recoveryPlan?.native" class="relay-confirm-layer" @mousedown.self="closeNativeRestoreConfirmation">
            <section class="relay-confirm-card relay-native-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="relay-native-confirm-title" data-focus-layer data-relay-focus-layer="native-restore" tabindex="-1">
              <span class="relay-confirm-icon"><Database :size="18" /></span>
              <div>
                <span class="relay-section-index">NATIVE CAPSULE / EXPLICIT PROVIDER WRITE</span>
                <h2 id="relay-native-confirm-title">把原生会话写入本机 provider 目录？</h2>
                <p>这是恢复流程中唯一会写入 <code>~/.claude</code> 或 <code>~/.codex</code> 的操作。Fleet 只写一份已校验 JSONL，不会读取或修改 SQLite、WAL、SHM。</p>
                <dl class="relay-cmux-confirm-grid">
                  <div><dt>目标文件</dt><dd><code>{{ recoveryPlan.native.targetDisplayPath }}</code></dd></div>
                  <div><dt>动作</dt><dd>{{ recoveryPlan.native.action === 'replace-with-backup' ? '先备份，再替换' : '创建新会话文件' }}</dd></div>
                </dl>
                <ul>
                  <li><ShieldCheck :size="13" />Provider 版本已按捕获版本逐字匹配</li>
                  <li><HardDrive :size="13" />写入前创建 Fleet 本机备份；成功后可一键回滚</li>
                  <li><CheckCircle2 :size="13" />失败时保留通用交接，并尽力自动恢复写入前状态</li>
                  <li v-if="recoveryPermissionMode === 'dangerous-bypass'" class="relay-dangerous-confirm"><AlertTriangle :size="13" />后续复制的原生 resume 指令会跳过 Provider 权限确认</li>
                </ul>
                <p v-if="nativeRestoreError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ nativeRestoreError }}</p>
                <div class="relay-confirm-actions">
                  <button class="secondary-button" :disabled="nativeRestoreBusy" @click="closeNativeRestoreConfirmation">取消</button>
                  <button class="primary-button relay-native-button" :disabled="nativeRestoreBusy" @click="confirmNativeRestore">
                    <LoaderCircle v-if="nativeRestoreBusy" :size="14" class="spinning" /><Database v-else :size="14" />确认并写入
                  </button>
                </div>
              </div>
            </section>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="cmuxSettingsOpen" class="relay-confirm-layer" @mousedown.self="closeCmuxSettings">
            <form class="relay-cmux-settings-card" role="dialog" aria-modal="true" aria-labelledby="relay-cmux-settings-title" data-focus-layer data-relay-focus-layer="cmux-settings" tabindex="-1" @submit.prevent="saveCmuxSettings">
              <header>
                <span class="relay-confirm-icon"><Settings2 :size="18" /></span>
                <div>
                  <span class="relay-section-index">LOCAL LAUNCHER / PROVIDER TEMPLATES</span>
                  <h2 id="relay-cmux-settings-title">恢复命令模板</h2>
                  <p>同一模板会按目标环境注入不同 executable：普通 shell 使用已确认的真实路径，cmux workspace 使用 provider shim。</p>
                </div>
                <button class="icon-button" type="button" aria-label="关闭命令模板设置" :disabled="cmuxSettingsSaving" @click="closeCmuxSettings"><X :size="16" /></button>
              </header>

              <div v-if="cmuxSettingsLoading" class="relay-cmux-settings-state"><LoaderCircle :size="17" class="spinning" />正在检测 cmux 并读取本机模板…</div>
              <template v-else>
                <div v-if="cmuxSettings" class="relay-cmux-capability" :data-state="cmuxSettings.capability.state">
                  <TerminalSquare :size="16" />
                  <span><strong>{{ cmuxSettings.capability.state === 'available' ? (cmuxSettings.capability.version ?? 'cmux ready') : '复制模式' }}</strong><small>{{ cmuxSettings.capability.message }}</small></span>
                  <code v-if="cmuxSettings.capability.executablePath">{{ cmuxSettings.capability.executablePath }}</code>
                </div>

                <label class="relay-cmux-template-field">
                  <span><b>Claude</b><small>在新 workspace 中启动 Claude 接力</small></span>
                  <textarea v-model="cmuxClaudeTemplate" rows="4" maxlength="4000" :disabled="cmuxSettingsSaving" spellcheck="false" />
                </label>
                <label class="relay-cmux-template-field">
                  <span><b>Codex</b><small>在新 workspace 中启动 Codex 接力</small></span>
                  <textarea v-model="cmuxCodexTemplate" rows="4" maxlength="4000" :disabled="cmuxSettingsSaving" spellcheck="false" />
                </label>

                <div class="relay-cmux-placeholders">
                  <span>可用占位符</span>
                  <code v-for="token in ['executable', 'cwd', 'promptFile', 'providerSessionId', 'title']" :key="token" v-text="'{{' + token + '}}'" />
                  <small>长提示词写入 Fleet 本机数据目录；模板中只出现文件路径，不会写入 API Key 或完整 transcript。</small>
                </div>
              </template>

              <p v-if="cmuxSettingsError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ cmuxSettingsError }}</p>
              <footer>
                <button type="button" class="secondary-button" :disabled="cmuxSettingsSaving" @click="closeCmuxSettings">取消</button>
                <button type="submit" class="primary-button relay-cmux-save-button" :disabled="cmuxSettingsLoading || cmuxSettingsSaving || !cmuxClaudeTemplate.trim() || !cmuxCodexTemplate.trim()">
                  <LoaderCircle v-if="cmuxSettingsSaving" :size="14" class="spinning" /><Settings2 v-else :size="14" />保存并重新生成
                </button>
              </footer>
            </form>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="cmuxOpenConfirm && recoveryPlan?.launch" class="relay-confirm-layer" @mousedown.self="closeCmuxConfirmation">
            <section class="relay-confirm-card relay-cmux-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="relay-cmux-confirm-title" data-focus-layer data-relay-focus-layer="cmux-open" tabindex="-1">
              <span class="relay-confirm-icon"><TerminalSquare :size="18" /></span>
              <div>
                <span class="relay-section-index">CMUX BRIDGE / EXPLICIT LAUNCH</span>
                <h2 id="relay-cmux-confirm-title">在 cmux 中创建新 workspace？</h2>
                <p>Fleet 将直接调用已检测到的 cmux CLI。不会注入现有终端，也不会修改项目文件、provider 会话目录或 Git 状态。</p>
                <dl class="relay-cmux-confirm-grid">
                  <div><dt>Workspace</dt><dd>{{ recoveryPlan.launch.workspaceName }}</dd></div>
                  <div><dt>项目目录</dt><dd><code>{{ recoveryPlan.launch.cwd }}</code></dd></div>
                </dl>
                <div class="relay-cmux-command-review">
                  <span>cmux 内执行的 provider 命令</span>
                  <pre>{{ recoveryPlan.launch.cmuxCommand }}</pre>
                </div>
                <ul>
                  <li><CheckCircle2 :size="13" />参数通过 argv 传入 cmux，不经 Fleet 的 shell 拼接执行</li>
                  <li><ShieldCheck :size="13" />命令只引用本机恢复提示词文件，不含 API Key 或完整 transcript</li>
                  <li v-if="recoveryPlan.launch.permissionFlag" class="relay-dangerous-confirm"><AlertTriangle :size="13" />已加入 <code>{{ recoveryPlan.launch.permissionFlag }}</code>，Provider 将跳过自身权限确认</li>
                </ul>
                <p v-if="cmuxOpenError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ cmuxOpenError }}</p>
                <div class="relay-confirm-actions">
                  <button class="secondary-button" :disabled="cmuxOpenBusy" @click="closeCmuxConfirmation">取消</button>
                  <button class="primary-button relay-cmux-open-button" :disabled="cmuxOpenBusy" @click="confirmCmuxOpen">
                    <LoaderCircle v-if="cmuxOpenBusy" :size="14" class="spinning" /><TerminalSquare v-else :size="14" />确认并打开
                  </button>
                </div>
              </div>
            </section>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="epochManagerOpen" class="relay-confirm-layer" @mousedown.self="closeEpochManager">
            <section class="relay-epoch-card" role="dialog" aria-modal="true" aria-labelledby="relay-epoch-title" data-focus-layer data-relay-focus-layer="epoch-manager" tabindex="-1">
              <header>
                <span class="relay-confirm-icon"><Database :size="19" /></span>
                <div>
                  <span class="relay-section-index">VAULT EPOCH CONTROL / APPEND ONLY</span>
                  <h2 id="relay-epoch-title">{{ epochRotateOpen ? '开启新的 Vault 纪元' : 'Vault 纪元目录' }}</h2>
                  <p>{{ epochRotateOpen ? '旧 Vault 会固定为只读目录；新 checkpoint 只写入新仓库。' : '一个当前写入仓库，加上可检索、可查看、可导出的只读历史。' }}</p>
                </div>
                <button class="icon-button" aria-label="关闭 Vault 纪元目录" :disabled="epochRotateBusy" @click="closeEpochManager"><X :size="16" /></button>
              </header>

              <div v-if="epochQuery.isLoading.value" class="relay-epoch-loading"><LoaderCircle :size="18" class="spinning" />正在读取本机纪元目录…</div>
              <div v-else-if="epochQuery.error.value" class="relay-epoch-loading error"><AlertTriangle :size="18" />{{ epochQuery.error.value instanceof Error ? epochQuery.error.value.message : '纪元目录不可用' }}</div>
              <template v-else-if="activeEpoch">
                <section class="relay-epoch-current" :class="{ suggested: epochStatus?.rotationSuggested }">
                  <div class="relay-epoch-current-heading">
                    <span><i />CURRENT WRITABLE EPOCH</span>
                    <strong>{{ epochLabel(activeEpoch) }}</strong>
                  </div>
                  <code>{{ activeEpoch.vaultPath }}</code>
                  <div class="relay-epoch-current-grid">
                    <div><span>Git 对象</span><strong>{{ formatBytes(activeEpoch.storageBytes) }}</strong></div>
                    <div><span>逻辑会话</span><strong>{{ activeEpoch.sessionCount }}</strong></div>
                    <div><span>当前 HEAD</span><strong>{{ activeEpoch.head?.slice(0, 10) ?? 'NO HEAD' }}</strong></div>
                    <div><span>远端</span><strong>{{ activeEpoch.remoteSyncEnabled ? 'PRIVATE SYNC' : 'LOCAL ONLY' }}</strong></div>
                  </div>
                  <p v-if="epochStatus?.rotationSuggested" class="relay-epoch-suggestion"><AlertTriangle :size="13" />{{ epochStatus.rotationReason }}</p>
                  <p v-else class="relay-epoch-threshold">建议阈值 {{ formatBytes(epochStatus?.rotationThresholdBytes ?? 0) }}；这是提醒，不会自动轮换。</p>
                </section>

                <template v-if="!epochRotateOpen">
                  <div class="relay-epoch-actions">
                    <span><LockKeyhole :size="14" />轮换不重写历史，不运行 GC，也不 force push。</span>
                    <button ref="epochRotateButton" class="primary-button" data-testid="epoch-rotate-open" @click="openEpochRotation"><RotateCw :size="14" />开启新纪元</button>
                  </div>

                  <section class="relay-epoch-history">
                    <header><span>只读历史</span><small>{{ epochStatus?.archivedEpochs.length ?? 0 }} EPOCHS</small></header>
                    <div v-if="!epochStatus?.archivedEpochs.length" class="relay-epoch-empty"><Database :size="18" />首次轮换后，旧 Vault 会出现在这里。</div>
                    <article v-for="epoch in epochStatus?.archivedEpochs ?? []" :key="epoch.epochId">
                      <span class="relay-epoch-lock"><LockKeyhole :size="15" /></span>
                      <div>
                        <strong>{{ epochLabel(epoch) }}</strong>
                        <code>{{ epoch.vaultPath }}</code>
                        <small>归档 {{ epochDate(epoch.archivedAt) }} · {{ epoch.sessionCount }} 会话 · {{ formatBytes(epoch.storageBytes) }}</small>
                      </div>
                      <code>{{ epoch.head?.slice(0, 10) ?? 'NO HEAD' }}</code>
                      <button class="secondary-button" :data-testid="`epoch-browse-${epoch.sequence}`" @click="browseArchivedEpoch(epoch)"><Search :size="13" />检索</button>
                    </article>
                  </section>
                </template>

                <form v-else class="relay-epoch-rotate-form" @submit.prevent="submitEpochRotation">
                  <label class="relay-merge-field">
                    <span>新 Vault 目录 <small>必须独立于所有现有纪元</small></span>
                    <span class="relay-epoch-path-input"><input ref="epochRotatePathInput" v-model="epochRotatePath" data-testid="epoch-vault-path" maxlength="4000" :disabled="epochRotateBusy" /><button type="button" class="secondary-button" :disabled="epochDirectoryPicking || epochRotateBusy" @click="selectEpochDirectory"><LoaderCircle v-if="epochDirectoryPicking" :size="13" class="spinning" /><FolderOpen v-else :size="13" />选择</button></span>
                  </label>

                  <label class="relay-epoch-remote-toggle">
                    <input v-model="epochRotateRemoteEnabled" type="checkbox" :disabled="epochRotateBusy" />
                    <span><strong>为新纪元启用私有远端同步</strong><small>新远端必须为空，且不能复用任何旧纪元仓库。</small></span>
                  </label>

                  <div v-if="epochRotateRemoteEnabled" class="relay-epoch-remote-fields">
                    <label class="relay-merge-field"><span>Remote 名称</span><input v-model="epochRotateRemoteName" maxlength="255" :disabled="epochRotateBusy" /></label>
                    <label class="relay-merge-field"><span>全新私有远端 URL</span><input v-model="epochRotateRemoteUrl" data-testid="epoch-remote-url" maxlength="2000" :disabled="epochRotateBusy" placeholder="git@host:me/session-vault-epoch-02.git" /></label>
                    <label class="relay-merge-field"><span>私有远端确认短语</span><input v-model="epochRotateConfirmation" maxlength="200" :disabled="epochRotateBusy" placeholder="这是我控制的私有远端" /></label>
                  </div>

                  <ul class="relay-epoch-guarantees">
                    <li><CheckCircle2 :size="13" />旧纪元固定在当前 HEAD，并从写入 binding 中移除。</li>
                    <li><CheckCircle2 :size="13" />旧纪元继续支持搜索、详情查看和 JSON 导出。</li>
                    <li><CheckCircle2 :size="13" />轮换只使用普通 fetch / pull / push；不会 force push。</li>
                    <li><CheckCircle2 :size="13" />任一步中断都会由 journal 恢复；不会删除旧、新 Vault。</li>
                  </ul>
                  <p v-if="epochRotateError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ epochRotateError }}</p>
                  <footer>
                    <button type="button" class="secondary-button" :disabled="epochRotateBusy" @click="closeEpochRotation">返回目录</button>
                    <button type="submit" class="primary-button" data-testid="epoch-rotate-submit" :disabled="epochRotateBusy">
                      <LoaderCircle v-if="epochRotateBusy" :size="14" class="spinning" /><RotateCw v-else :size="14" />同步旧库并轮换
                    </button>
                  </footer>
                </form>
              </template>
            </section>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="pendingLifecycle" class="relay-confirm-layer" @mousedown.self="!lifecycleBusy && cancelLifecycleConfirmation()">
            <section class="relay-confirm-card" :class="{ 'relay-trash-confirm': pendingLifecycle.action === 'trash' }" role="alertdialog" aria-modal="true" aria-labelledby="relay-confirm-title" aria-describedby="relay-confirm-description" data-focus-layer data-relay-focus-layer="lifecycle" tabindex="-1">
              <span class="relay-confirm-icon"><Trash2 v-if="pendingLifecycle.action === 'trash'" :size="18" /><Archive v-else :size="18" /></span>
              <div>
                <span class="relay-section-index">LIFECYCLE EVENT / {{ pendingLifecycle.action === 'trash' ? 'TRASH' : 'ARCHIVE' }}</span>
                <h2 id="relay-confirm-title">{{ pendingLifecycle.action === 'trash' ? '把这条会话移入废纸篓？' : '归档这条会话接力？' }}</h2>
                <p id="relay-confirm-description"><strong>{{ pendingLifecycle.title }}</strong> {{ pendingLifecycle.action === 'trash' ? '会从活跃与归档列表隐藏，并在当前 Vault 中默认保留 30 天。' : '将从“活跃”列表隐藏，但 checkpoint、交接摘要与恢复能力都会完整保留。' }}</p>
                <ul v-if="pendingLifecycle.action === 'trash'">
                  <li><CheckCircle2 :size="13" />写入可跨设备同步的删除标记，30 天内可恢复</li>
                  <li><ShieldCheck :size="13" />不会删除 Claude / Codex 原始会话、项目源码或 cmux workspace</li>
                  <li><AlertTriangle :size="13" />以后清理当前对象也不等于从 Git 历史彻底抹除</li>
                </ul>
                <ul v-else>
                  <li><CheckCircle2 :size="13" />会写入可跨设备同步的 Vault 归档事件</li>
                  <li><ShieldCheck :size="13" />不会删除 Claude / Codex 原始会话或项目源码</li>
                </ul>
                <div class="relay-confirm-actions">
                  <button class="secondary-button" :disabled="lifecycleBusy !== null" @click="cancelLifecycleConfirmation()">取消</button>
                  <button class="primary-button" :class="{ danger: pendingLifecycle.action === 'trash' }" :disabled="lifecycleBusy !== null || lifecycleLocked" @click="runLifecycleMutation(pendingLifecycle)">
                    <LoaderCircle v-if="lifecycleBusy" :size="14" class="spinning" /><Trash2 v-else-if="pendingLifecycle.action === 'trash'" :size="14" /><Archive v-else :size="14" />{{ pendingLifecycle.action === 'trash' ? '移入废纸篓' : '确认归档' }}
                  </button>
                </div>
              </div>
            </section>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="trashPreviewOpen" class="relay-confirm-layer" @mousedown.self="closeTrashEmptyPreview">
            <section class="relay-confirm-card relay-trash-empty-card" role="alertdialog" aria-modal="true" aria-labelledby="relay-trash-empty-title" data-focus-layer data-relay-focus-layer="trash-empty" tabindex="-1">
              <span class="relay-confirm-icon"><Trash2 :size="18" /></span>
              <div>
                <span class="relay-section-index">VAULT MAINTENANCE / EXPIRED OBJECTS</span>
                <h2 id="relay-trash-empty-title">清理已到期的废纸篓内容</h2>
                <p>这里只移除当前 Vault 工作树中的到期交接对象。生命周期索引继续保留，Git 历史和远端旧版本也可能仍有内容。</p>
                <div v-if="trashPreviewLoading" class="relay-trash-preview-state"><LoaderCircle :size="17" class="spinning" />正在核对保留期、同步状态和对象清单…</div>
                <p v-else-if="trashPreviewError" class="relay-merge-error"><AlertTriangle :size="14" />{{ trashPreviewError }}</p>
                <template v-else-if="trashPreview">
                  <div class="relay-trash-preview-grid">
                    <div><span>废纸篓会话</span><strong>{{ trashPreview.totalTrashed }}</strong></div>
                    <div><span>达到期限</span><strong>{{ trashPreview.eligibleSessions }}</strong></div>
                    <div><span>继续保留</span><strong data-tone="muted">{{ trashPreview.retainedSessions }}</strong></div>
                    <div><span>分叉会话</span><strong data-tone="warning">{{ trashPreview.forkedSessions }}</strong></div>
                    <div><span>删除冲突</span><strong data-tone="warning">{{ trashPreview.deletionConflictSessions }}</strong></div>
                    <div><span>待移除内容</span><strong>{{ trashPreview.removableObjects }} · {{ formatBytes(trashPreview.removableBytes) }}</strong></div>
                  </div>
                  <p class="relay-trash-sync-status" :data-ready="trashPreview.syncReady"><Cloud v-if="trashPreview.syncReady" :size="14" /><CloudOff v-else :size="14" />{{ trashPreview.syncMessage }}</p>
                  <ul v-if="trashPreview.blockers.length" class="relay-trash-blockers">
                    <li v-for="blocker in trashPreview.blockers" :key="blocker"><AlertTriangle :size="13" />{{ blocker }}</li>
                  </ul>
                  <p class="relay-trash-history-warning"><AlertTriangle :size="14" />{{ trashPreview.historyWarning }}</p>
                </template>
                <div class="relay-confirm-actions">
                  <button class="secondary-button" :disabled="trashEmptyBusy" @click="closeTrashEmptyPreview">取消</button>
                  <button class="primary-button danger" :disabled="trashEmptyBusy || !trashPreview?.canEmpty" @click="confirmTrashEmpty">
                    <LoaderCircle v-if="trashEmptyBusy" :size="14" class="spinning" /><Trash2 v-else :size="14" />确认移除当前对象
                  </button>
                </div>
              </div>
            </section>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="trashConflictSaveOpen && detail" class="relay-confirm-layer" @mousedown.self="closeTrashConflictSave">
            <form class="relay-merge-card relay-trash-conflict-card" role="dialog" aria-modal="true" aria-labelledby="relay-trash-conflict-title" data-focus-layer data-relay-focus-layer="trash-conflict" tabindex="-1" @submit.prevent="submitTrashConflictSave">
              <header>
                <span class="relay-confirm-icon"><CopyPlus :size="18" /></span>
                <div>
                  <span class="relay-section-index">TRASH CONFLICT / SAVE AS NEW</span>
                  <h2 id="relay-trash-conflict-title">把新增内容另存为独立会话</h2>
                  <p>原会话继续留在废纸篓；选择的 checkpoint 会复制为新逻辑会话的起点，并保留它来自哪条已删除接力线。</p>
                </div>
              </header>

              <fieldset class="relay-merge-baseline relay-conflict-sources">
                <legend>选择要另存的新增 checkpoint</legend>
                <p v-if="deletionConflictCheckpoints.length > 1">检测到多条新增工作线，请明确选择其中一条作为新会话起点；其余内容不会被静默处置。</p>
                <p v-else>这条 checkpoint 是删除标记之后新增的内容。</p>
                <label v-for="checkpoint in deletionConflictCheckpoints" :key="checkpoint.checkpointId" :class="{ selected: trashConflictSourceCheckpointId === checkpoint.checkpointId }">
                  <input v-model="trashConflictSourceCheckpointId" type="radio" name="trash-conflict-source" :value="checkpoint.checkpointId" :disabled="trashConflictSaveBusy" />
                  <span><strong>{{ checkpoint.title || checkpoint.machine }}</strong><small>{{ checkpoint.machine }} · {{ checkpoint.branch ?? 'DETACHED' }} · {{ checkpoint.checkpointId.slice(0, 10) }}</small></span>
                  <CheckCircle2 v-if="trashConflictSourceCheckpointId === checkpoint.checkpointId" :size="15" />
                </label>
              </fieldset>

              <label class="relay-merge-field">
                <span>新会话目标</span>
                <input v-model="trashConflictGoal" maxlength="10000" :disabled="trashConflictSaveBusy" autofocus placeholder="这条新增工作线接下来要完成什么？" />
              </label>
              <label class="relay-merge-field">
                <span>新会话下一步 <small>每行一条</small></span>
                <textarea v-model="trashConflictNextSteps" maxlength="20000" :disabled="trashConflictSaveBusy" rows="5" placeholder="确认新会话的代码基线&#10;继续尚未完成的任务" />
              </label>

              <p class="relay-merge-warning"><ShieldCheck :size="14" />不会恢复原会话，不会移动 Claude / Codex 原始会话，也不会修改项目仓库；只复制交接对象并追加精确的冲突处置事件。</p>
              <p v-if="trashConflictSaveError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ trashConflictSaveError }}</p>
              <footer>
                <button type="button" class="secondary-button" :disabled="trashConflictSaveBusy" @click="closeTrashConflictSave">取消</button>
                <button type="submit" class="primary-button conflict-save-submit" :disabled="trashConflictSaveBusy || lifecycleLocked">
                  <LoaderCircle v-if="trashConflictSaveBusy" :size="14" class="spinning" /><CopyPlus v-else :size="14" />另存为新会话
                </button>
              </footer>
            </form>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="forkMergeOpen && detail" class="relay-confirm-layer" @mousedown.self="closeForkMerge">
            <form class="relay-merge-card" role="dialog" aria-modal="true" aria-labelledby="relay-merge-title" data-focus-layer data-relay-focus-layer="fork-merge" tabindex="-1" @submit.prevent="submitForkMerge">
              <header>
                <span class="relay-confirm-icon"><GitMerge :size="18" /></span>
                <div>
                  <span class="relay-section-index">FORK RESOLUTION / MERGE CHECKPOINT</span>
                  <h2 id="relay-merge-title">生成一个共同交接点</h2>
                  <p>新 checkpoint 会同时引用 {{ detail.session.headCheckpointIds.length }} 个当前 head。旧分支保持不可变，不会自动合并项目源码。</p>
                </div>
              </header>

              <label class="relay-merge-field">
                <span>合并后的目标</span>
                <input v-model="forkMergeGoal" maxlength="10000" :disabled="forkMergeBusy" autofocus placeholder="接下来要共同推进什么？" />
              </label>

              <fieldset class="relay-merge-baseline">
                <legend>选择恢复基线</legend>
                <p>工作区、分支、代码可达性与恢复指令沿用这一条；另一条只合并上下文 lineage。</p>
                <label v-for="checkpoint in headCheckpoints" :key="checkpoint.checkpointId" :class="{ selected: forkMergeBaseCheckpointId === checkpoint.checkpointId }">
                  <input v-model="forkMergeBaseCheckpointId" type="radio" name="fork-merge-base" :value="checkpoint.checkpointId" :disabled="forkMergeBusy" />
                  <span><strong>{{ checkpoint.machine }}</strong><small>{{ checkpoint.branch ?? 'DETACHED' }} · {{ checkpoint.checkpointId.slice(0, 10) }}</small></span>
                  <CheckCircle2 v-if="forkMergeBaseCheckpointId === checkpoint.checkpointId" :size="15" />
                </label>
              </fieldset>

              <label class="relay-merge-field">
                <span>合并后的下一步 <small>每行一条</small></span>
                <textarea v-model="forkMergeNextSteps" maxlength="20000" :disabled="forkMergeBusy" rows="5" placeholder="复核两个分支的差异&#10;确认源码基线&#10;继续实现下一项" />
              </label>

              <p class="relay-merge-warning"><AlertTriangle :size="14" />该操作只合并会话交接和父子关系；如果两条分支的源码不同，仍需在项目仓库中单独处理。</p>
              <p v-if="forkMergeError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ forkMergeError }}</p>

              <footer>
                <button type="button" class="secondary-button" :disabled="forkMergeBusy" @click="closeForkMerge">取消</button>
                <button type="submit" class="primary-button" :disabled="forkMergeBusy || lifecycleLocked">
                  <LoaderCircle v-if="forkMergeBusy" :size="14" class="spinning" /><GitMerge v-else :size="14" />生成合并交接点
                </button>
              </footer>
            </form>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="forkSplitOpen && detail" class="relay-confirm-layer" @mousedown.self="closeForkSplit">
            <form class="relay-merge-card relay-split-card" role="dialog" aria-modal="true" aria-labelledby="relay-split-title" data-focus-layer data-relay-focus-layer="fork-split" tabindex="-1" @submit.prevent="submitForkSplit">
              <header>
                <span class="relay-confirm-icon"><Layers3 :size="18" /></span>
                <div>
                  <span class="relay-section-index">FORK RESOLUTION / SPLIT SESSION</span>
                  <h2 id="relay-split-title">把两条工作线拆开管理</h2>
                  <p>一条 head 留在当前逻辑会话，另一条复制为新的根 checkpoint；原始对象不移动，跨会话来源会保留在 lineage 中。</p>
                </div>
              </header>

              <fieldset class="relay-merge-baseline">
                <legend>哪一条留在当前会话？</legend>
                <p>另一条会自动成为新会话。两个会话后续可以分别置顶、归档、恢复和同步。</p>
                <label v-for="checkpoint in headCheckpoints" :key="checkpoint.checkpointId" :class="{ selected: forkSplitKeepCheckpointId === checkpoint.checkpointId }">
                  <input v-model="forkSplitKeepCheckpointId" type="radio" name="fork-split-keep" :value="checkpoint.checkpointId" :disabled="forkSplitBusy" />
                  <span><strong>{{ checkpoint.machine }}</strong><small>{{ checkpoint.branch ?? 'DETACHED' }} · {{ checkpoint.checkpointId.slice(0, 10) }}</small></span>
                  <CheckCircle2 v-if="forkSplitKeepCheckpointId === checkpoint.checkpointId" :size="15" />
                </label>
              </fieldset>

              <label class="relay-merge-field">
                <span>新会话目标</span>
                <input v-model="forkSplitGoal" maxlength="10000" :disabled="forkSplitBusy" autofocus placeholder="拆出的工作线接下来做什么？" />
              </label>
              <label class="relay-merge-field">
                <span>新会话下一步 <small>每行一条</small></span>
                <textarea v-model="forkSplitNextSteps" maxlength="20000" :disabled="forkSplitBusy" rows="5" placeholder="确认这条工作线的代码基线&#10;继续独立任务" />
              </label>

              <p class="relay-merge-warning"><ShieldCheck :size="14" />不会移动或删除 Claude / Codex 原始会话，不会修改项目仓库；只追加一个新 checkpoint 和一条拆分 lineage 事件。</p>
              <p v-if="forkSplitError" class="relay-merge-error" role="alert"><AlertTriangle :size="14" />{{ forkSplitError }}</p>
              <footer>
                <button type="button" class="secondary-button" :disabled="forkSplitBusy" @click="closeForkSplit">取消</button>
                <button type="submit" class="primary-button" :disabled="forkSplitBusy || lifecycleLocked">
                  <LoaderCircle v-if="forkSplitBusy" :size="14" class="spinning" /><Layers3 v-else :size="14" />确认拆成两个会话
                </button>
              </footer>
            </form>
          </div>
        </Transition>
      </Teleport>
    </section>
    <SessionSaveDrawer
      :open="saveOpen"
      :remote-sync-enabled="Boolean(sync?.remoteSyncEnabled)"
      :auto-push-available="canAutoPushAfterSave"
      @close="closeSaveDrawer"
      @busy="handleSaveBusy"
      @saved="handleSessionSaved"
    />
  </main>
</template>

<style scoped>
.relay-workspace { --relay-cyan: #52c8de; --relay-amber: #e2b85b; --relay-red: #ed6675; padding-top: 22px; }
.relay-workspace.detail-open { z-index: 25; }
.relay-command-deck { position: relative; padding: 22px; overflow: hidden; border: 1px solid var(--color-border); border-radius: 10px 10px 0 0; background: linear-gradient(120deg, rgb(255 255 255 / 2.2%), transparent 42%), #1c1e20; box-shadow: 0 22px 55px rgb(0 0 0 / 27%); }
.relay-command-deck::after { position: absolute; width: 340px; height: 340px; top: -250px; right: 8%; border: 1px solid color-mix(in srgb, var(--relay-cyan) 14%, transparent); border-radius: 50%; box-shadow: 0 0 90px color-mix(in srgb, var(--relay-cyan) 8%, transparent), inset 0 0 70px color-mix(in srgb, var(--relay-cyan) 5%, transparent); content: ''; pointer-events: none; }
.relay-intro { position: relative; z-index: 1; }
.relay-kicker, .relay-section-index { display: inline-flex; align-items: center; gap: 6px; color: var(--relay-cyan); font: 500 10px 'JetBrains Mono', monospace; letter-spacing: .14em; }
.relay-title-line { margin-top: 9px; }
.relay-title-line h1 { margin: 0; color: var(--color-text-strong); font-size: clamp(26px, 3vw, 38px); font-weight: 600; letter-spacing: -.045em; }
.relay-sync-chip { min-width: 0; min-height: 40px; padding: 7px 11px; display: flex; align-items: center; gap: 9px; overflow: hidden; border: 1px solid color-mix(in srgb, currentColor 28%, var(--color-border)); border-radius: 7px; background: color-mix(in srgb, currentColor 6%, var(--color-canvas)); }
.relay-sync-chip[data-tone='green'] { color: var(--color-success); }
.relay-sync-chip[data-tone='cyan'] { color: var(--relay-cyan); }
.relay-sync-chip[data-tone='yellow'] { color: var(--relay-amber); }
.relay-sync-chip[data-tone='red'] { color: var(--relay-red); }
.relay-sync-chip[data-tone='muted'] { color: var(--color-text-muted); }
.relay-sync-chip > svg { flex: none; }
.relay-sync-chip span { min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.relay-sync-chip strong { color: currentColor; font-size: 13px; font-weight: 600; }
.relay-sync-chip small { min-width: 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.45; }
.relay-actions { position: relative; z-index: 2; margin-top: 12px; display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto auto auto; align-items: center; gap: 8px; }
.relay-actions.unconfigured { grid-template-columns: minmax(0, 1fr) auto; }
.relay-management-button.active { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 30%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 7%, var(--color-surface-raised)); }
.relay-vault-setup-button { min-height: 40px; color: #102125; border-color: color-mix(in srgb, var(--relay-cyan) 85%, white); background: var(--relay-cyan); box-shadow: 0 8px 24px color-mix(in srgb, var(--relay-cyan) 17%, transparent); }
.relay-vault-setup-button:hover:not(:disabled) { background: color-mix(in srgb, var(--relay-cyan) 86%, white); box-shadow: 0 10px 30px color-mix(in srgb, var(--relay-cyan) 23%, transparent); }
.relay-vault-loading-button { min-height: 40px; cursor: wait; }
.relay-vault-retry-button { min-height: 40px; color: var(--relay-red); border-color: color-mix(in srgb, var(--relay-red) 36%, var(--color-border)); background: color-mix(in srgb, var(--relay-red) 5%, var(--color-canvas)); }
.relay-vault-retry-button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--relay-red) 58%, var(--color-border)); background: color-mix(in srgb, var(--relay-red) 9%, var(--color-canvas)); }
.relay-save-button { color: #0d2025; border-color: color-mix(in srgb, var(--relay-cyan) 86%, white); background: var(--relay-cyan); box-shadow: 0 8px 22px color-mix(in srgb, var(--relay-cyan) 14%, transparent); }
.relay-save-button:hover:not(:disabled) { background: color-mix(in srgb, var(--relay-cyan) 88%, white); box-shadow: 0 10px 26px color-mix(in srgb, var(--relay-cyan) 20%, transparent); }
.relay-continue-button { color: #231b0c; border-color: color-mix(in srgb, var(--relay-amber) 84%, white); background: var(--relay-amber); box-shadow: 0 8px 22px color-mix(in srgb, var(--relay-amber) 13%, transparent); }
.relay-continue-button:hover:not(:disabled) { background: color-mix(in srgb, var(--relay-amber) 88%, white); box-shadow: 0 10px 26px color-mix(in srgb, var(--relay-amber) 19%, transparent); }
.relay-epoch-button { min-height: 40px; padding: 0 11px; display: inline-flex; align-items: center; gap: 7px; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 28%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--relay-cyan) 6%, var(--color-canvas)); cursor: pointer; font-size: 12px; }
.relay-epoch-button:hover { border-color: color-mix(in srgb, var(--relay-cyan) 52%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 10%, var(--color-canvas)); }
.relay-epoch-button.suggested { color: var(--relay-amber); border-color: color-mix(in srgb, var(--relay-amber) 40%, var(--color-border)); background: color-mix(in srgb, var(--relay-amber) 7%, var(--color-canvas)); }
.relay-epoch-button b { min-width: 20px; height: 20px; padding: 0 5px; display: inline-grid; place-items: center; border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: 10px; font: 9px 'JetBrains Mono', monospace; }
.relay-metrics { position: relative; z-index: 1; margin-top: 16px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 8px; background: rgb(11 12 13 / 28%); }
.relay-metrics > div { min-height: 74px; padding: 13px 16px; display: grid; grid-template-columns: 1fr auto; align-content: center; gap: 2px 12px; border-right: 1px solid var(--color-border-subtle); }
.relay-metrics > div:last-child { border-right: 0; }
.relay-metrics span { color: var(--color-text-muted); font-size: 12px; }
.relay-metrics strong { grid-row: 1 / 3; grid-column: 2; align-self: center; color: var(--relay-cyan); font: 500 24px 'JetBrains Mono', monospace; }
.relay-metrics > div:nth-child(2) strong, .relay-metrics > div:nth-child(3) strong { color: var(--relay-amber); }
.relay-metrics > div:nth-child(4) strong { color: var(--relay-red); }
.relay-metrics small { color: #737b82; font: 10px 'JetBrains Mono', monospace; letter-spacing: .05em; text-transform: uppercase; }
.relay-feedback { min-height: 40px; margin: 0; padding: 8px 13px; display: flex; align-items: center; gap: 8px; border-inline: 1px solid color-mix(in srgb, currentColor 25%, var(--color-border)); background: color-mix(in srgb, currentColor 6%, transparent); font-size: 13px; }
.relay-feedback[data-tone='success'] { color: var(--color-success); }
.relay-feedback[data-tone='warning'] { color: var(--relay-amber); }
.relay-feedback[data-tone='error'] { color: var(--relay-red); }
.relay-feedback-actions { margin-left: auto; display: flex; align-items: center; gap: 5px; }
.relay-feedback-action { min-height: 27px; padding: 0 8px; display: inline-flex; align-items: center; gap: 5px; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 4px; background: color-mix(in srgb, currentColor 5%, transparent); cursor: pointer; font-size: 11px; }
.relay-feedback-close { width: 27px; height: 27px; display: grid; place-items: center; color: currentColor; border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
.relay-feedback button:disabled { opacity: .45; cursor: not-allowed; }
.relay-continue-banner { min-height: 56px; padding: 9px 13px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 10px; color: var(--relay-amber); border-inline: 1px solid color-mix(in srgb, var(--relay-amber) 28%, var(--color-border)); border-bottom: 1px solid color-mix(in srgb, var(--relay-amber) 24%, var(--color-border)); background: linear-gradient(90deg, color-mix(in srgb, var(--relay-amber) 8%, transparent), rgb(0 0 0 / 5%)); }
.relay-continue-mark { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--relay-amber) 30%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--relay-amber) 7%, transparent); }
.relay-continue-banner > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-continue-banner strong { color: var(--color-text-strong); font-size: 12px; }
.relay-continue-banner small { color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.relay-continue-banner b { color: var(--relay-amber); font: 9px 'JetBrains Mono', monospace; letter-spacing: .08em; }
.relay-continue-banner .secondary-button { min-height: 31px; font-size: 10px; }
.relay-epoch-view-banner { min-height: 54px; padding: 9px 13px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 10px; color: var(--relay-cyan); border-inline: 1px solid color-mix(in srgb, var(--relay-cyan) 28%, var(--color-border)); border-bottom: 1px solid color-mix(in srgb, var(--relay-cyan) 22%, var(--color-border)); background: linear-gradient(90deg, color-mix(in srgb, var(--relay-cyan) 8%, transparent), rgb(0 0 0 / 5%)); }
.relay-epoch-view-banner > svg { flex: none; }
.relay-epoch-view-banner > span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.relay-epoch-view-banner strong { color: var(--color-text-strong); font-size: 12px; }
.relay-epoch-view-banner small { color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.relay-epoch-view-banner code { color: var(--relay-cyan); font: 10px 'JetBrains Mono', monospace; }
.relay-epoch-view-banner .secondary-button { min-height: 32px; font-size: 11px; }
.relay-ledger { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); border: 1px solid var(--color-border-subtle); border-top: 0; border-radius: 0 0 10px 10px; background: rgb(29 31 33 / 98%); box-shadow: var(--shadow-panel); }
.relay-list-panel { min-width: 0; min-height: 560px; }
.relay-list-toolbar { min-height: 86px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--color-border-subtle); }
.relay-list-toolbar.compact { min-height: 66px; }
.relay-list-toolbar h2 { margin: 4px 0 0; color: var(--color-text-strong); font-size: 20px; }
.relay-filters { display: flex; align-items: center; gap: 8px; }
.relay-search { width: min(310px, 30vw); height: 38px; padding: 0 7px 0 11px; display: flex; align-items: center; gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-canvas); }
.relay-search:focus-within { border-color: var(--relay-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--relay-cyan) 9%, transparent); }
.relay-search input { min-width: 0; flex: 1; color: var(--color-text); border: 0; outline: 0; background: transparent; font-size: 13px; }
.relay-search button { width: 24px; height: 24px; padding: 0; display: grid; place-items: center; color: var(--color-text-muted); border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
.relay-provider-filter { height: 38px; padding: 3px; display: flex; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-canvas); }
.relay-provider-filter button { padding: 0 11px; color: var(--color-text-muted); border: 0; border-radius: 4px; background: transparent; cursor: pointer; font-size: 12px; }
.relay-provider-filter button.active { color: var(--color-text-strong); background: var(--color-surface-hover); box-shadow: 0 1px 4px rgb(0 0 0 / 24%); }
.relay-lifecycle-tabs { min-height: 52px; padding: 7px 20px; display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--color-border-subtle); background: rgb(12 14 15 / 22%); }
.relay-lifecycle-tabs > button { min-height: 34px; padding: 0 10px; display: inline-flex; align-items: center; gap: 7px; color: var(--color-text-muted); border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; font-size: 12px; }
.relay-lifecycle-tabs > button:hover { color: var(--color-text); background: rgb(255 255 255 / 2%); }
.relay-lifecycle-tabs > button.active { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 25%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 7%, transparent); box-shadow: inset 0 0 18px color-mix(in srgb, var(--relay-cyan) 4%, transparent); }
.relay-lifecycle-tabs > button.relay-empty-trash { margin-left: 4px; color: var(--relay-red); border-color: color-mix(in srgb, var(--relay-red) 24%, var(--color-border)); background: color-mix(in srgb, var(--relay-red) 4%, transparent); }
.relay-lifecycle-tabs > button.relay-empty-trash:hover:not(:disabled) { color: #ff8290; border-color: color-mix(in srgb, var(--relay-red) 42%, var(--color-border)); background: color-mix(in srgb, var(--relay-red) 8%, transparent); }
.relay-lifecycle-tabs > button:disabled { opacity: .42; cursor: not-allowed; }
.relay-lifecycle-tabs b { min-width: 21px; height: 19px; padding: 0 5px; display: inline-grid; place-items: center; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 10px; font: 9px 'JetBrains Mono', monospace; }
.relay-lifecycle-tabs > small { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: #747c82; font-size: 10px; }
.relay-lifecycle-tabs > small:has(svg) { color: var(--relay-amber); }
.relay-state { min-height: 410px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--color-text-muted); text-align: center; }
.relay-state strong { color: var(--color-text-strong); font-size: 14px; }
.relay-state span { max-width: 460px; font-size: 13px; line-height: 1.6; }
.relay-state-error > svg { color: var(--relay-red); }
.relay-state-empty > svg { color: var(--relay-cyan); }
.relay-state .secondary-button { margin-top: 5px; }
.relay-state .relay-vault-empty-setup { margin-top: 7px; color: #102125; border-color: var(--relay-cyan); background: var(--relay-cyan); }
.relay-session-list { display: flex; flex-direction: column; }
.relay-session-row { --provider-color: var(--relay-cyan); width: 100%; min-height: 118px; display: grid; grid-template-columns: minmax(0, 1fr) clamp(218px, 21vw, 258px); color: var(--color-text); border-bottom: 1px solid var(--color-border-subtle); background: transparent; text-align: left; transition: background 130ms ease, box-shadow 130ms ease; }
.relay-session-row.compact { min-height: 88px; grid-template-columns: minmax(0, 1fr); }
.relay-session-row[data-provider='claude'] { --provider-color: var(--relay-amber); }
.relay-session-row:hover, .relay-session-row.selected { background: color-mix(in srgb, var(--provider-color) 4.5%, transparent); box-shadow: inset 3px 0 var(--provider-color); }
.relay-session-row.pinned { background-image: linear-gradient(90deg, color-mix(in srgb, var(--relay-amber) 6%, transparent), transparent 30%); }
.relay-session-row.archived { --provider-color: #8f9ba3; }
.relay-session-row.trashed { --provider-color: #697177; background-image: linear-gradient(90deg, rgb(255 255 255 / 1.5%), transparent 38%); }
.relay-session-row.conflicted { --provider-color: var(--relay-red); background-image: linear-gradient(90deg, color-mix(in srgb, var(--relay-red) 7%, transparent), transparent 42%); }
.relay-session-open { min-width: 0; padding: 0; display: grid; grid-template-columns: 92px minmax(0, 1fr) 184px; color: inherit; border: 0; background: transparent; cursor: pointer; text-align: left; }
.relay-session-row.compact .relay-session-open { grid-template-columns: 64px minmax(0, 1fr) 132px; }
.relay-session-open:focus-visible { position: relative; z-index: 1; outline-offset: -3px; }
.relay-provider-mark { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--provider-color); border-right: 1px solid var(--color-border-subtle); background: color-mix(in srgb, var(--provider-color) 3%, transparent); }
.relay-provider-mark small { font: 10px 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
.relay-session-row.compact .relay-provider-mark { gap: 4px; }
.relay-session-row.compact .relay-provider-mark small { font-size: 9px; letter-spacing: .04em; }
.relay-session-copy { min-width: 0; padding: 15px 18px; display: flex; justify-content: center; flex-direction: column; }
.relay-session-row.compact .relay-session-copy { padding-block: 12px; }
.relay-session-title { min-width: 0; display: flex; align-items: center; gap: 8px; }
.relay-session-title strong { min-width: 0; overflow: hidden; color: var(--color-text-strong); font-size: 15px; font-weight: 600; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.relay-pinned-mark { flex: none; color: var(--relay-amber); fill: color-mix(in srgb, var(--relay-amber) 23%, transparent); transform: rotate(-12deg); }
.relay-session-title em { min-height: 22px; padding: 0 7px; display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--relay-red); border: 1px solid color-mix(in srgb, var(--relay-red) 26%, transparent); border-radius: 4px; background: color-mix(in srgb, var(--relay-red) 7%, transparent); font-size: 10px; font-style: normal; }
.relay-session-title em[data-tone='archive'] { color: #a6b2ba; border-color: color-mix(in srgb, #a6b2ba 25%, transparent); background: color-mix(in srgb, #a6b2ba 6%, transparent); }
.relay-session-title em[data-tone='trash'] { color: var(--color-text-muted); border-color: var(--color-border); background: rgb(255 255 255 / 2%); }
.relay-session-title em[data-tone='conflict'] { color: #ff8b71; border-color: color-mix(in srgb, #ff8b71 38%, transparent); background: color-mix(in srgb, #ff8b71 10%, transparent); }
.relay-session-title em[data-tone='remote'] { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 32%, transparent); background: color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-session-title em[data-tone='recommended'] { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 30%, transparent); background: color-mix(in srgb, var(--color-success) 8%, transparent); }
.relay-session-context { min-width: 0; margin-top: 8px; display: flex; align-items: center; gap: 12px; color: var(--color-text-muted); font-size: 12px; }
.relay-session-context span { min-width: 0; display: inline-flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.relay-session-context code { color: #80888f; font: 10px 'JetBrains Mono', monospace; }
.relay-capabilities { margin-top: 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.relay-capabilities small { min-height: 22px; padding: 0 7px; display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 4px; background: rgb(255 255 255 / 1.5%); font-size: 10px; }
.relay-capabilities small[data-tone='green'] { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 22%, transparent); }
.relay-capabilities small[data-tone='cyan'] { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 22%, transparent); }
.relay-capabilities small[data-tone='yellow'] { color: var(--relay-amber); border-color: color-mix(in srgb, var(--relay-amber) 22%, transparent); }
.relay-capabilities small[data-tone='red'] { color: var(--relay-red); border-color: color-mix(in srgb, var(--relay-red) 22%, transparent); }
.relay-session-meta { padding: 15px 18px; display: flex; align-items: flex-end; justify-content: center; flex-direction: column; gap: 7px; color: var(--color-text-muted); border-left: 1px solid var(--color-border-subtle); }
.relay-session-row.compact .relay-session-meta { padding-inline: 14px; flex-direction: row; align-items: center; justify-content: flex-end; gap: 8px; }
.relay-session-meta time, .relay-session-meta > span { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.relay-session-meta small { max-width: 154px; overflow: hidden; color: #858c92; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relay-session-meta > span { color: var(--provider-color); font-family: 'JetBrains Mono', monospace; }
.relay-session-management { padding: 12px 10px; display: flex; align-items: center; justify-content: center; gap: 6px; border-left: 1px solid var(--color-border-subtle); background: rgb(0 0 0 / 8%); }
.relay-session-management button { min-width: 0; min-height: 42px; padding: 0 8px; display: flex; align-items: center; justify-content: center; gap: 5px; flex: 1; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 5px; background: rgb(255 255 255 / 1.5%); cursor: pointer; font-size: 10px; white-space: nowrap; transition: color 130ms ease, border-color 130ms ease, background 130ms ease, box-shadow 130ms ease, transform 130ms ease; }
.relay-session-management button.pin { color: var(--relay-amber); border-color: color-mix(in srgb, var(--relay-amber) 34%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--relay-amber) 13%, transparent), color-mix(in srgb, var(--relay-amber) 7%, transparent)); }
.relay-session-management button.archive { color: #9ec9dc; border-color: color-mix(in srgb, #80bad1 32%, transparent); background: linear-gradient(180deg, color-mix(in srgb, #80bad1 12%, transparent), color-mix(in srgb, #80bad1 6%, transparent)); }
.relay-session-management button.archive.restore, .relay-session-management button.restore { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 34%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--color-success) 13%, transparent), color-mix(in srgb, var(--color-success) 7%, transparent)); }
.relay-session-management button.trash { color: #ff7887; border-color: color-mix(in srgb, var(--relay-red) 36%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--relay-red) 14%, transparent), color-mix(in srgb, var(--relay-red) 7%, transparent)); }
.relay-session-management button.readonly { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 34%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--relay-cyan) 12%, transparent), color-mix(in srgb, var(--relay-cyan) 6%, transparent)); }
.relay-session-management button:hover:not(:disabled), .relay-session-management button.active { filter: brightness(1.16); border-color: currentColor; background: color-mix(in srgb, currentColor 17%, transparent); box-shadow: 0 5px 14px color-mix(in srgb, currentColor 8%, transparent); transform: translateY(-1px); }
.relay-session-management button:disabled { opacity: .38; cursor: not-allowed; }
.relay-pagination { min-height: 60px; padding: 10px 18px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--color-border-subtle); }
.relay-pagination > span { color: var(--color-text-muted); font: 10px 'JetBrains Mono', monospace; letter-spacing: .12em; }
.relay-pagination > div { display: flex; gap: 7px; }
.relay-pagination .icon-button { width: 32px; height: 32px; }
.relay-detail { position: fixed; z-index: 35; top: 0; right: 0; width: min(880px, calc(100vw - 48px)); height: 100vh; height: 100dvh; padding: 26px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; border-left: 1px solid var(--color-border); background: radial-gradient(circle at 82% -10%, color-mix(in srgb, var(--relay-cyan) 5%, transparent), transparent 32%), rgb(25 26 28 / 99%); backdrop-filter: blur(20px); box-shadow: -30px 0 80px rgb(0 0 0 / 48%); }
.relay-detail-header { position: sticky; z-index: 2; top: -26px; margin: -26px -26px 0; padding: 26px 26px 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--color-border-subtle); background: rgb(25 27 29 / 96%); backdrop-filter: blur(18px); }
.relay-detail-header > div { min-width: 0; }
.relay-detail-header h2 { margin: 6px 0 0; overflow-wrap: anywhere; color: var(--color-text-strong); font-size: 22px; line-height: 1.3; }
.relay-detail-header p { margin: 6px 0 0; overflow: hidden; color: var(--color-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.relay-detail-header-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.relay-detail-readonly { min-height: 31px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 25%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--relay-cyan) 6%, transparent); font-size: 10px; }
.relay-detail-header-actions .export-action { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 30%, transparent); background: color-mix(in srgb, var(--color-success) 6%, transparent); }
.relay-detail-header-actions .ghost-button { white-space: nowrap; }
.relay-detail-header-actions .ghost-button { transition: color 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease, transform 140ms ease; }
.relay-detail-header-actions .ghost-button.pin-action { color: var(--relay-amber); border-color: color-mix(in srgb, var(--relay-amber) 30%, var(--color-border)); background: color-mix(in srgb, var(--relay-amber) 8%, transparent); }
.relay-detail-header-actions .ghost-button.pin-action.active { border-color: color-mix(in srgb, var(--relay-amber) 48%, var(--color-border)); background: color-mix(in srgb, var(--relay-amber) 15%, transparent); box-shadow: inset 0 0 15px color-mix(in srgb, var(--relay-amber) 7%, transparent); }
.relay-detail-header-actions .ghost-button.archive-action { color: #9ec9dc; border-color: color-mix(in srgb, #80bad1 30%, var(--color-border)); background: color-mix(in srgb, #80bad1 8%, transparent); }
.relay-detail-header-actions .ghost-button.archive-action.restore, .relay-detail-header-actions .ghost-button.restore { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 32%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 9%, transparent); }
.relay-detail-header-actions .ghost-button.danger { color: #ff7887; border-color: color-mix(in srgb, var(--relay-red) 34%, var(--color-border)); background: color-mix(in srgb, var(--relay-red) 9%, transparent); }
.relay-detail-header-actions .ghost-button:hover:not(:disabled) { border-color: currentColor; background: color-mix(in srgb, currentColor 15%, transparent); box-shadow: 0 5px 14px color-mix(in srgb, currentColor 8%, transparent); transform: translateY(-1px); }
.relay-detail-header .icon-button { flex: none; }
.relay-detail-state { min-height: 360px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--color-text-muted); font-size: 13px; }
.relay-trash-panel { margin-top: 18px; padding: 16px; display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 12px; border: 1px solid color-mix(in srgb, var(--relay-red) 24%, var(--color-border)); border-radius: 8px; background: radial-gradient(circle at 100% 0, color-mix(in srgb, var(--relay-red) 6%, transparent), transparent 36%), rgb(12 14 16 / 54%); }
.relay-trash-mark { width: 38px; height: 38px; display: grid; place-items: center; color: var(--relay-red); border: 1px solid color-mix(in srgb, var(--relay-red) 28%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--relay-red) 7%, transparent); }
.relay-trash-panel h3 { margin: 5px 0 0; color: var(--color-text-strong); font-size: 16px; }
.relay-trash-panel p { margin: 6px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.65; }
.relay-trash-panel.conflict { border-color: color-mix(in srgb, #ff8b71 44%, var(--color-border)); background: radial-gradient(circle at 100% 0, color-mix(in srgb, #ff8b71 12%, transparent), transparent 40%), linear-gradient(145deg, color-mix(in srgb, var(--relay-amber) 5%, transparent), transparent 58%), rgb(14 13 14 / 70%); box-shadow: inset 0 1px rgb(255 255 255 / 3%), 0 14px 36px rgb(0 0 0 / 18%); }
.relay-trash-panel.conflict .relay-trash-mark { color: #ff8b71; border-color: color-mix(in srgb, #ff8b71 42%, transparent); background: color-mix(in srgb, #ff8b71 11%, transparent); box-shadow: 0 0 22px color-mix(in srgb, #ff8b71 10%, transparent); }
.relay-trash-conflict-actions { margin-top: 13px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.relay-trash-conflict-actions > button { min-width: 0; min-height: 58px; padding: 9px 11px; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 9px; border: 1px solid color-mix(in srgb, currentColor 36%, var(--color-border)); border-radius: 7px; background: color-mix(in srgb, currentColor 9%, transparent); cursor: pointer; text-align: left; transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease, transform 140ms ease; }
.relay-trash-conflict-actions > button > svg { flex: none; }
.relay-trash-conflict-actions > button > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-trash-conflict-actions strong { color: currentColor; font-size: 11px; font-weight: 600; }
.relay-trash-conflict-actions small { overflow: hidden; color: var(--color-text-muted); font-size: 9px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.relay-archive-inline-note { margin-top: 12px !important; display: flex; align-items: center; gap: 6px; color: var(--relay-cyan) !important; }
.relay-trash-conflict-actions .conflict-restore-button { color: var(--color-success); }
.relay-trash-conflict-actions .conflict-save-button { color: var(--relay-cyan); }
.relay-trash-conflict-actions > button:hover:not(:disabled) { border-color: currentColor; background: color-mix(in srgb, currentColor 16%, transparent); box-shadow: 0 8px 20px color-mix(in srgb, currentColor 9%, transparent); transform: translateY(-1px); }
.relay-trash-conflict-actions > button:disabled { opacity: .42; cursor: not-allowed; }
.relay-fork-panel { margin-top: 18px; padding: 16px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--relay-red) 30%, var(--color-border)); border-radius: 8px; background: radial-gradient(circle at 100% 0, color-mix(in srgb, var(--relay-red) 8%, transparent), transparent 35%), linear-gradient(145deg, color-mix(in srgb, var(--relay-amber) 4%, transparent), transparent 56%), rgb(12 14 16 / 58%); box-shadow: inset 0 1px rgb(255 255 255 / 2%); }
.relay-fork-heading { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: start; gap: 12px; }
.relay-fork-mark { width: 38px; height: 38px; display: grid; place-items: center; color: var(--relay-red); border: 1px solid color-mix(in srgb, var(--relay-red) 30%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--relay-red) 7%, transparent); box-shadow: 0 0 26px color-mix(in srgb, var(--relay-red) 8%, transparent); }
.relay-fork-heading h3 { margin: 5px 0 0; color: var(--color-text-strong); font-size: 16px; letter-spacing: -.015em; }
.relay-fork-heading p { max-width: 690px; margin: 6px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.6; }
.relay-fork-choices { margin-top: 14px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 7px; background: rgb(0 0 0 / 14%); }
.relay-fork-choices > div, .relay-fork-choices > button { min-width: 0; min-height: 74px; padding: 10px 11px; display: grid; grid-template-columns: auto auto minmax(0, 1fr); grid-template-rows: auto auto; align-content: center; align-items: center; gap: 3px 7px; color: var(--color-text-muted); border: 0; border-right: 1px solid var(--color-border-subtle); background: transparent; text-align: left; }
.relay-fork-choices > :last-child { border-right: 0; }
.relay-fork-choices > button { cursor: pointer; }
.relay-fork-choices > .continue-choice { color: var(--relay-cyan); background: color-mix(in srgb, var(--relay-cyan) 4%, transparent); }
.relay-fork-choices > .merge-choice { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 4%, transparent); }
.relay-fork-choices > .split-choice { color: var(--relay-amber); background: color-mix(in srgb, var(--relay-amber) 4%, transparent); }
.relay-fork-choices > button:hover:not(:disabled), .relay-fork-choices > div.active { background: color-mix(in srgb, currentColor 11%, transparent); box-shadow: inset 0 -2px currentColor; }
.relay-fork-choices > button:disabled { opacity: .48; cursor: not-allowed; }
.relay-fork-choices span { color: currentColor; font: 9px 'JetBrains Mono', monospace; letter-spacing: .12em; }
.relay-fork-choices svg { color: currentColor; }
.relay-fork-choices strong { min-width: 0; overflow: hidden; color: var(--color-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relay-fork-choices small { grid-column: 2 / 4; color: #7d858b; font-size: 9px; line-height: 1.35; }
.relay-fork-heads { margin-top: 10px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.relay-fork-heads > button { position: relative; min-width: 0; min-height: 126px; padding: 12px; display: flex; align-items: flex-start; flex-direction: column; gap: 5px; overflow: hidden; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 7px; background: rgb(0 0 0 / 14%); cursor: pointer; text-align: left; transition: border-color 140ms ease, background 140ms ease, transform 140ms ease; }
.relay-fork-heads > button::before { position: absolute; width: 2px; inset: 0 auto 0 0; background: var(--relay-red); opacity: .4; content: ''; }
.relay-fork-heads > button:hover:not(:disabled) { transform: translateY(-1px); border-color: color-mix(in srgb, var(--relay-cyan) 30%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 4%, transparent); }
.relay-fork-heads > button.selected { border-color: color-mix(in srgb, var(--color-success) 36%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 5%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-success) 8%, transparent); }
.relay-fork-heads > button.selected::before { background: var(--color-success); opacity: 1; box-shadow: 0 0 14px var(--color-success); }
.relay-fork-head-index { color: var(--relay-red); font: 9px 'JetBrains Mono', monospace; letter-spacing: .1em; }
.relay-fork-heads strong { width: 100%; overflow: hidden; color: var(--color-text-strong); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.relay-fork-heads span:not(.relay-fork-head-index) { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; }
.relay-fork-heads code { width: 100%; overflow: hidden; color: #818990; font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-fork-heads em { margin-top: auto; color: var(--relay-cyan); font-size: 9px; font-style: normal; }
.relay-fork-heads > button.selected em { color: var(--color-success); }
.relay-fork-state { margin: 9px 0 0; padding: 8px 9px; display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 5px; background: rgb(0 0 0 / 10%); font-size: 10px; }
.relay-fork-state.selected { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 20%, transparent); background: color-mix(in srgb, var(--color-success) 4%, transparent); }
.relay-fork-state.error { color: var(--relay-red); border-color: color-mix(in srgb, var(--relay-red) 22%, transparent); }
.relay-fork-state > button { min-height: 27px; margin-left: auto; padding: 0 8px; display: inline-flex; align-items: center; gap: 5px; flex: none; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: 4px; background: color-mix(in srgb, currentColor 5%, transparent); cursor: pointer; font-size: 9px; }
.relay-fork-state > button:disabled { opacity: .45; cursor: not-allowed; }
.relay-detail-signals { margin-top: 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--color-border); border-radius: 7px; }
.relay-detail-signals div { min-width: 0; padding: 10px; display: flex; flex-direction: column; border-right: 1px solid var(--color-border-subtle); }
.relay-detail-signals div:last-child { border-right: 0; }
.relay-detail-signals span { color: var(--color-text-muted); font: 10px 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
.relay-detail-signals strong { margin-top: 6px; overflow: hidden; color: var(--relay-cyan); font: 12px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-detail-signals strong[data-tone='green'] { color: var(--color-success); }
.relay-detail-signals strong[data-tone='red'] { color: var(--relay-red); }
.relay-recovery-panel { margin-top: 18px; padding: 16px; border: 1px solid color-mix(in srgb, var(--relay-cyan) 22%, var(--color-border)); border-radius: 8px; background: linear-gradient(145deg, color-mix(in srgb, var(--relay-cyan) 4%, transparent), transparent 58%), rgb(12 15 17 / 52%); box-shadow: inset 0 1px rgb(255 255 255 / 2%); }
.relay-recovery-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.relay-recovery-heading h3 { margin: 5px 0 0; color: var(--color-text-strong); font-size: 16px; letter-spacing: -.01em; }
.relay-recovery-heading p { max-width: 510px; margin: 5px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.55; }
.relay-recovery-heading .secondary-button { flex: none; }
.relay-recovery-empty, .relay-recovery-state { min-height: 64px; margin-top: 12px; padding: 13px; display: flex; align-items: center; gap: 8px; color: var(--color-text-muted); border: 1px dashed var(--color-border); border-radius: 6px; font-size: 11px; line-height: 1.55; }
.relay-recovery-state { justify-content: center; }
.relay-recovery-error { margin-top: 12px; padding: 11px 12px; display: flex; align-items: center; gap: 8px; color: var(--relay-red); border: 1px solid color-mix(in srgb, var(--relay-red) 24%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--relay-red) 5%, transparent); font-size: 11px; line-height: 1.5; }
.relay-recovery-error span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.link-button { padding: 0; color: currentColor; border: 0; background: transparent; cursor: pointer; font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
.ghost-button { min-height: 32px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 5px; background: transparent; cursor: pointer; font-size: 11px; }
.ghost-button:hover { color: var(--color-text-strong); border-color: var(--relay-cyan); }
.relay-recovery-status { margin-top: 13px; padding: 10px 11px; display: grid; grid-template-columns: 8px minmax(0, auto) minmax(0, 1fr); align-items: center; gap: 7px; border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 5%, transparent); }
.relay-recovery-status[data-tone='green'] { color: var(--color-success); }
.relay-recovery-status[data-tone='red'] { color: var(--relay-red); }
.relay-recovery-status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
.relay-recovery-status strong { overflow: hidden; color: currentColor; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.relay-recovery-status small { min-width: 0; overflow: hidden; color: var(--color-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.relay-recovery-path { margin-top: 10px; padding: 9px 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 15%); }
.relay-recovery-path > div { min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.relay-recovery-path span { flex: none; color: var(--color-text-muted); font-size: 10px; }
.relay-recovery-path code { min-width: 0; overflow: hidden; color: var(--color-text); font: 10px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-recovery-path button { flex: none; }
.relay-recovery-grid { margin-top: 10px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; }
.relay-recovery-grid > div { min-width: 0; min-height: 70px; padding: 9px 10px; display: flex; justify-content: center; flex-direction: column; border-right: 1px solid var(--color-border-subtle); }
.relay-recovery-grid > div:last-child { border-right: 0; }
.relay-recovery-grid span { color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
.relay-recovery-grid strong { margin-top: 5px; overflow: hidden; color: var(--relay-cyan); font: 11px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-recovery-grid strong[data-tone='green'] { color: var(--color-success); }
.relay-recovery-grid strong[data-tone='red'] { color: var(--relay-red); }
.relay-recovery-grid strong[data-tone='yellow'] { color: var(--relay-amber); }
.relay-recovery-grid small { margin-top: 3px; overflow: hidden; color: #7f878e; font-size: 9px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.relay-recovery-blockers { margin: 10px 0 0; padding: 0; display: grid; gap: 5px; list-style: none; }
.relay-recovery-blockers li { padding: 8px 9px; display: flex; align-items: flex-start; gap: 7px; color: var(--relay-red); border: 1px solid color-mix(in srgb, var(--relay-red) 18%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--relay-red) 4%, transparent); font-size: 10px; line-height: 1.5; }
.relay-recovery-blockers li[data-severity='warning'] { color: var(--relay-amber); border-color: color-mix(in srgb, var(--relay-amber) 20%, transparent); background: color-mix(in srgb, var(--relay-amber) 4%, transparent); }
.relay-recovery-blockers li svg { margin-top: 2px; flex: none; }
.relay-recovery-blockers li span { min-width: 0; overflow-wrap: anywhere; }
.relay-recovery-blockers li strong { margin-right: 5px; font-weight: 600; }
.relay-recovery-primary { margin-top: 12px; padding: 12px; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 11px; color: var(--color-success); border: 1px solid color-mix(in srgb, var(--color-success) 30%, var(--color-border)); border-radius: 7px; background: linear-gradient(100deg, color-mix(in srgb, var(--color-success) 8%, transparent), rgb(0 0 0 / 12%)); }
.relay-recovery-primary-mark { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--color-success) 28%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--color-success) 8%, transparent); }
.relay-recovery-primary > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-recovery-primary small { color: var(--color-success); font: 9px 'JetBrains Mono', monospace; letter-spacing: .1em; text-transform: uppercase; }
.relay-recovery-primary strong { overflow: hidden; color: var(--color-text-strong); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.relay-recovery-primary em { color: var(--color-text-muted); font-size: 10px; font-style: normal; }
.relay-recovery-primary .primary-button { min-width: 126px; min-height: 38px; color: #07150e; border-color: var(--color-success); background: var(--color-success); font-size: 11px; }
.relay-recovery-primary .primary-button:hover:not(:disabled) { background: color-mix(in srgb, var(--color-success) 88%, white); box-shadow: 0 8px 22px color-mix(in srgb, var(--color-success) 18%, transparent); }
.relay-recovery-advanced { margin-top: 10px; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 10%); }
.relay-recovery-advanced > summary { min-height: 44px; padding: 0 11px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; color: var(--color-text-muted); cursor: pointer; list-style: none; }
.relay-recovery-advanced > summary::-webkit-details-marker { display: none; }
.relay-recovery-advanced > summary > span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.relay-recovery-advanced > summary strong { color: var(--color-text); font-size: 11px; }
.relay-recovery-advanced > summary small { color: #747d83; font-size: 9px; }
.relay-recovery-advanced > summary > svg:last-child { transition: transform 140ms ease; }
.relay-recovery-advanced[open] > summary > svg:last-child { transform: rotate(90deg); }
.relay-recovery-advanced-body { padding: 0 10px 10px; border-top: 1px solid var(--color-border-subtle); }
.relay-recovery-advanced-body > .relay-recovery-grid { margin-top: 10px; }
.relay-recovery-previews { margin-top: 10px; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 13%); }
.relay-recovery-previews details, .relay-command-preview { min-width: 0; }
.relay-recovery-previews summary, .relay-command-preview summary { min-height: 34px; padding: 0 10px; display: flex; align-items: center; gap: 6px; color: var(--color-text); cursor: pointer; font-size: 11px; list-style: none; }
.relay-recovery-previews summary::-webkit-details-marker, .relay-command-preview summary::-webkit-details-marker { display: none; }
.relay-recovery-previews summary small { margin-left: auto; color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; }
.relay-diff-files { max-height: 130px; padding: 7px 10px; display: flex; flex-direction: column; gap: 4px; overflow: auto; border-top: 1px solid var(--color-border-subtle); }
.relay-diff-files code { color: #aeb5ba; font: 10px 'JetBrains Mono', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-diff-files b { width: 20px; display: inline-block; color: var(--relay-cyan); font-weight: 600; }
.relay-recovery-previews pre, .relay-command-preview pre { max-height: 260px; margin: 0; padding: 10px; overflow: auto; color: #bfc6ca; border-top: 1px solid var(--color-border-subtle); background: #0b0d0e; font: 10px/1.55 'JetBrains Mono', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-recovery-muted { margin: 0; padding: 10px; color: var(--color-text-muted); border-top: 1px solid var(--color-border-subtle); font-size: 10px; }
.relay-native-restore { margin-top: 10px; padding: 10px; display: grid; grid-template-columns: 34px minmax(145px, .72fr) minmax(225px, 1.28fr) auto; align-items: center; gap: 10px; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, currentColor 24%, var(--color-border)); border-radius: 6px; background: linear-gradient(90deg, color-mix(in srgb, currentColor 6%, transparent), rgb(0 0 0 / 13%)); }
.relay-native-restore[data-tone='green'] { color: var(--color-success); }
.relay-native-restore[data-tone='yellow'] { color: var(--relay-amber); }
.relay-native-restore[data-tone='red'] { color: var(--relay-red); }
.relay-native-restore[data-tone='muted'] { color: #8b949a; border-color: var(--color-border-subtle); background: linear-gradient(90deg, rgb(255 255 255 / 2.4%), rgb(0 0 0 / 11%)); }
.relay-native-mark { width: 34px; height: 34px; display: grid; place-items: center; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 27%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
.relay-native-copy, .relay-native-meta, .relay-native-meta > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-native-copy > span { color: currentColor; font: 9px 'JetBrains Mono', monospace; letter-spacing: .1em; }
.relay-native-copy strong { overflow: hidden; color: var(--color-text-strong); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relay-native-copy small { color: var(--color-text-muted); font-size: 9px; line-height: 1.4; }
.relay-native-meta { padding-left: 10px; border-left: 1px solid var(--color-border-subtle); }
.relay-native-meta > span { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: baseline; gap: 7px; }
.relay-native-meta b { color: var(--color-text-muted); font-size: 9px; font-weight: 500; }
.relay-native-meta code { min-width: 0; overflow: hidden; color: #aeb6bb; font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-native-actions { display: flex; align-items: center; justify-content: flex-end; }
.relay-native-actions .primary-button, .relay-native-actions .secondary-button { min-height: 32px; padding-inline: 10px; font-size: 10px; white-space: nowrap; }
.relay-native-button { color: #071519; border-color: var(--relay-cyan); background: var(--relay-cyan); }
.relay-native-button:hover:not(:disabled) { background: color-mix(in srgb, var(--relay-cyan) 88%, white); box-shadow: 0 7px 20px color-mix(in srgb, var(--relay-cyan) 18%, transparent); }
.relay-native-fallback { display: inline-flex; align-items: center; gap: 5px; color: var(--color-text-muted); font-size: 9px; white-space: nowrap; }
.relay-native-result { margin-top: 7px; padding: 9px 10px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; color: var(--color-success); border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 5%, transparent); }
.relay-native-result[data-status='restore-failed'] { color: var(--relay-red); }
.relay-native-result > svg { flex: none; }
.relay-native-result > span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.relay-native-result strong { color: currentColor; font-size: 10px; }
.relay-native-result small { color: var(--color-text-muted); font-size: 9px; line-height: 1.45; }
.relay-native-result .secondary-button { min-height: 30px; font-size: 10px; }
.relay-permission-selector { margin-top: 10px; padding: 10px; display: grid; grid-template-columns: 34px minmax(170px, .8fr) auto; align-items: center; gap: 10px; color: var(--color-success); border: 1px solid color-mix(in srgb, currentColor 24%, var(--color-border)); border-radius: 6px; background: linear-gradient(90deg, color-mix(in srgb, currentColor 5%, transparent), rgb(0 0 0 / 13%)); }
.relay-permission-selector[data-mode='dangerous-bypass'] { color: var(--relay-amber); border-color: color-mix(in srgb, var(--relay-amber) 35%, var(--color-border)); background: linear-gradient(90deg, color-mix(in srgb, var(--relay-amber) 8%, transparent), rgb(0 0 0 / 13%)); }
.relay-permission-mark { width: 34px; height: 34px; display: grid; place-items: center; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
.relay-permission-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-permission-copy > span { color: currentColor; font: 10px 'JetBrains Mono', monospace; letter-spacing: .1em; }
.relay-permission-copy strong { color: var(--color-text-strong); font-size: 12px; }
.relay-permission-copy small { color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.relay-permission-options { padding: 3px; display: grid; grid-template-columns: repeat(2, auto); border: 1px solid var(--color-border); border-radius: 5px; background: #101214; }
.relay-permission-options button { min-height: 30px; padding: 0 10px; color: var(--color-text-muted); border: 0; border-radius: 3px; background: transparent; cursor: pointer; font-size: 10px; white-space: nowrap; }
.relay-permission-options button.active { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 9%, var(--color-surface-hover)); }
.relay-permission-options button.dangerous.active { color: var(--relay-amber); background: color-mix(in srgb, var(--relay-amber) 10%, var(--color-surface-hover)); }
.relay-permission-options button:disabled { opacity: .45; cursor: not-allowed; }
.relay-permission-selector > code { grid-column: 2 / -1; margin-top: -3px; padding: 6px 8px; color: var(--relay-amber); border: 1px solid color-mix(in srgb, var(--relay-amber) 22%, transparent); border-radius: 4px; background: rgb(0 0 0 / 16%); font: 10px 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
.relay-cmux-bridge { margin-top: 10px; padding: 10px; display: grid; grid-template-columns: 34px minmax(145px, .72fr) minmax(210px, 1.28fr) auto; align-items: center; gap: 10px; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 24%, var(--color-border)); border-radius: 6px; background: linear-gradient(90deg, color-mix(in srgb, var(--relay-cyan) 6%, transparent), rgb(0 0 0 / 13%)); }
.relay-cmux-bridge[data-state='unavailable'], .relay-cmux-bridge[data-state='unknown'] { color: #98a1a8; border-color: var(--color-border-subtle); background: linear-gradient(90deg, rgb(255 255 255 / 2.4%), rgb(0 0 0 / 11%)); }
.relay-cmux-bridge-mark { width: 34px; height: 34px; display: grid; place-items: center; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 27%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
.relay-cmux-bridge > div:nth-child(2), .relay-cmux-runtime { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-cmux-bridge span { color: currentColor; font: 9px 'JetBrains Mono', monospace; letter-spacing: .1em; text-transform: uppercase; }
.relay-cmux-bridge strong { overflow: hidden; color: var(--color-text-strong); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relay-cmux-bridge small { color: var(--color-text-muted); font-size: 9px; line-height: 1.4; }
.relay-cmux-runtime { padding-left: 10px; border-left: 1px solid var(--color-border-subtle); }
.relay-cmux-runtime code { overflow: hidden; color: #aeb6bb; font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-template-button { min-height: 32px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--relay-amber); border: 1px solid color-mix(in srgb, var(--relay-amber) 32%, var(--color-border)); border-radius: 5px; background: color-mix(in srgb, var(--relay-amber) 7%, transparent); cursor: pointer; font-size: 10px; }
.relay-template-button:hover { border-color: color-mix(in srgb, var(--relay-amber) 54%, var(--color-border)); background: color-mix(in srgb, var(--relay-amber) 12%, transparent); }
.relay-recovery-actions { margin-top: 11px; display: flex; flex-wrap: wrap; gap: 7px; }
.relay-recovery-actions .primary-button, .relay-recovery-actions .secondary-button { min-height: 34px; font-size: 11px; }
.relay-copy-command { color: #a7d7e3; border-color: color-mix(in srgb, var(--relay-cyan) 24%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 5%, var(--color-surface-raised)); }
.relay-cmux-open-button { color: #071519; border-color: var(--relay-cyan); background: var(--relay-cyan); }
.relay-cmux-open-button:hover:not(:disabled) { background: color-mix(in srgb, var(--relay-cyan) 88%, white); box-shadow: 0 7px 20px color-mix(in srgb, var(--relay-cyan) 18%, transparent); }
.relay-recovery-feedback { margin: 8px 0 0; display: flex; align-items: center; gap: 6px; color: var(--color-success); font-size: 10px; }
.relay-command-preview { margin-top: 8px; border: 1px solid var(--color-border-subtle); border-radius: 5px; }
.relay-command-preview summary { color: var(--color-text-muted); }
.relay-command-preview summary small { margin-left: auto; color: #727b81; font: 9px 'JetBrains Mono', monospace; }
.relay-command-preview pre { max-height: 150px; }
.relay-handoff, .relay-timeline { margin-top: 18px; }
.relay-detail-section-heading { min-height: 35px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-border-subtle); }
.relay-detail-section-heading span { color: var(--color-text-strong); font-size: 13px; font-weight: 600; }
.relay-detail-section-heading small { color: var(--color-text-muted); font: 10px 'JetBrains Mono', monospace; letter-spacing: .06em; text-transform: uppercase; }
.relay-handoff pre { max-height: 430px; margin: 12px 0 0; padding: 16px; overflow: auto; color: #d5d9dc; border: 1px solid var(--color-border-subtle); border-radius: 7px; background: #111315; font: 13px/1.72 'JetBrains Mono', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-handoff-brief { margin-top: 12px; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 7px; background: linear-gradient(135deg, color-mix(in srgb, var(--relay-cyan) 4%, transparent), rgb(0 0 0 / 12%) 48%); }
.relay-handoff-brief-row { min-height: 68px; padding: 14px 15px; display: grid; grid-template-columns: 82px minmax(0, 1fr); align-items: start; gap: 14px; border-bottom: 1px solid var(--color-border-subtle); }
.relay-handoff-brief-row > span { padding-top: 2px; color: var(--relay-cyan); font: 10px 'JetBrains Mono', monospace; letter-spacing: .08em; }
.relay-handoff-brief-row.next > span { color: var(--color-success); }
.relay-handoff-brief-row p { margin: 0; color: var(--color-text-strong); font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
.relay-handoff-brief-row ol { margin: 0; padding: 0; display: grid; gap: 8px; list-style: none; counter-reset: relay-next-step; }
.relay-handoff-brief-row li { position: relative; min-height: 24px; padding-left: 29px; color: var(--color-text); font-size: 13px; line-height: 1.6; counter-increment: relay-next-step; overflow-wrap: anywhere; }
.relay-handoff-brief-row li::before { content: counter(relay-next-step); position: absolute; top: 0; left: 0; width: 20px; height: 20px; display: grid; place-items: center; color: var(--color-success); border: 1px solid color-mix(in srgb, var(--color-success) 34%, var(--color-border)); border-radius: 50%; background: color-mix(in srgb, var(--color-success) 7%, transparent); font: 9px 'JetBrains Mono', monospace; }
.relay-handoff-full > summary { min-height: 43px; padding: 0 15px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; color: var(--color-text-muted); cursor: pointer; list-style: none; }
.relay-handoff-full > summary::-webkit-details-marker { display: none; }
.relay-handoff-full > summary span { color: var(--color-text); font-size: 11px; }
.relay-handoff-full > summary small { font-size: 10px; }
.relay-handoff-full > summary svg { transition: transform 140ms ease; }
.relay-handoff-full[open] > summary svg { transform: rotate(90deg); }
.relay-handoff-full pre { margin: 0 12px 12px; }
.relay-handoff-pending { min-height: 116px; margin-top: 12px; padding: 18px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--color-text-muted); border: 1px dashed color-mix(in srgb, var(--relay-red) 24%, var(--color-border)); border-radius: 7px; background: rgb(0 0 0 / 10%); font-size: 11px; text-align: center; }
.relay-timeline ol { margin: 0; padding: 4px 0 0; list-style: none; }
.relay-timeline li { min-height: 64px; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 10px; border-bottom: 1px solid var(--color-border-subtle); }
.relay-timeline li > i { width: 7px; height: 7px; justify-self: center; border-radius: 50%; background: var(--relay-cyan); box-shadow: 0 0 10px color-mix(in srgb, var(--relay-cyan) 45%, transparent); }
.relay-timeline li.head > i { background: var(--relay-red); box-shadow: 0 0 10px color-mix(in srgb, var(--relay-red) 50%, transparent); }
.relay-timeline li.selected { background: linear-gradient(90deg, color-mix(in srgb, var(--color-success) 5%, transparent), transparent 70%); }
.relay-timeline li.selected > i { background: var(--color-success); box-shadow: 0 0 10px color-mix(in srgb, var(--color-success) 50%, transparent); }
.relay-timeline li > div { min-width: 0; display: flex; flex-direction: column; }
.relay-timeline strong { overflow: hidden; color: var(--color-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.relay-timeline span { margin-top: 4px; color: var(--color-text-muted); font-size: 11px; }
.relay-timeline code { color: #858c92; font: 9px 'JetBrains Mono', monospace; }
.relay-readonly-note { margin-top: 18px; padding: 12px 13px; display: flex; align-items: flex-start; gap: 8px; color: var(--color-success); border: 1px solid color-mix(in srgb, var(--color-success) 22%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--color-success) 5%, transparent); font-size: 11px; line-height: 1.6; }
.relay-readonly-note svg { margin-top: 1px; flex: none; }
.relay-confirm-layer { --relay-cyan: #52c8de; --relay-amber: #e2b85b; --relay-red: #ed6675; position: fixed; z-index: 80; inset: 0; padding: 22px; display: grid; place-items: center; background: rgb(4 6 7 / 72%); backdrop-filter: blur(8px); }
.relay-vault-setup-card { width: min(720px, 100%); max-height: calc(100dvh - 44px); display: flex; flex-direction: column; overflow: hidden; color: var(--color-text); border: 1px solid color-mix(in srgb, var(--relay-cyan) 34%, var(--color-border)); border-radius: 11px; background: radial-gradient(circle at 88% -7%, color-mix(in srgb, var(--relay-cyan) 10%, transparent), transparent 34%), #1b1d1f; box-shadow: 0 32px 110px rgb(0 0 0 / 66%); }
.relay-vault-setup-card > header { min-height: 96px; padding: 19px 22px; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: start; gap: 14px; border-bottom: 1px solid var(--color-border-subtle); background: linear-gradient(90deg, color-mix(in srgb, var(--relay-cyan) 5%, transparent), transparent 48%); }
.relay-vault-setup-card > header .relay-confirm-icon { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 35%, transparent); background: color-mix(in srgb, var(--relay-cyan) 9%, transparent); }
.relay-vault-setup-card > header h2 { margin: 7px 0 0; color: var(--color-text-strong); font-size: 22px; letter-spacing: -.03em; }
.relay-vault-setup-card > header p { max-width: 580px; margin: 6px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.55; }
.relay-vault-setup-steps { min-height: 62px; padding: 9px 24px; display: grid; grid-template-columns: auto minmax(24px, 1fr) auto minmax(24px, 1fr) auto; align-items: center; gap: 10px; border-bottom: 1px solid var(--color-border-subtle); background: rgb(0 0 0 / 11%); }
.relay-vault-setup-steps > span { display: grid; grid-template-columns: 27px auto; align-items: center; gap: 7px; color: #737c82; }
.relay-vault-setup-steps b { width: 27px; height: 27px; display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; font: 9px 'JetBrains Mono', monospace; }
.relay-vault-setup-steps small { font-size: 10px; white-space: nowrap; }
.relay-vault-setup-steps > span.active { color: var(--relay-cyan); }
.relay-vault-setup-steps > span.done { color: var(--color-success); }
.relay-vault-setup-steps > i { height: 1px; background: linear-gradient(90deg, color-mix(in srgb, var(--relay-cyan) 35%, var(--color-border)), var(--color-border)); }
.relay-vault-setup-body { min-height: 0; padding: 20px 22px; overflow-y: auto; }
.relay-vault-setup-panel { display: grid; gap: 14px; }
.relay-vault-setup-heading { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: center; gap: 11px; }
.relay-vault-setup-heading > span { width: 38px; height: 38px; display: grid; place-items: center; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 28%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--relay-cyan) 7%, transparent); }
.relay-vault-setup-heading > div { display: flex; flex-direction: column; gap: 3px; }
.relay-vault-setup-heading strong { color: var(--color-text-strong); font-size: 14px; }
.relay-vault-setup-heading small { color: var(--color-text-muted); font-size: 11px; line-height: 1.5; }
.relay-vault-location-card { min-height: 72px; padding: 11px 12px; display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 11px; border: 1px solid color-mix(in srgb, var(--relay-cyan) 24%, var(--color-border)); border-radius: 7px; background: linear-gradient(100deg, color-mix(in srgb, var(--relay-cyan) 6%, transparent), rgb(0 0 0 / 11%)); }
.relay-vault-location-icon { width: 38px; height: 38px; display: grid; place-items: center; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 27%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--relay-cyan) 7%, transparent); }
.relay-vault-location-card > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-vault-location-card small { color: var(--color-text-muted); font-size: 9px; }
.relay-vault-location-card strong { color: var(--color-text-strong); font-size: 12px; }
.relay-vault-location-card code { overflow: hidden; color: #7e8990; font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-vault-path-field { display: grid; gap: 7px; }
.relay-vault-path-field > span:first-child, .relay-vault-remote-url-field > span { color: var(--color-text-muted); font: 10px 'JetBrains Mono', monospace; letter-spacing: .05em; }
.relay-vault-path-field > span:last-child { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.relay-vault-path-field input, .relay-vault-remote-url-field input { width: 100%; min-height: 39px; padding: 0 11px; color: var(--color-text); border: 1px solid var(--color-border); border-radius: 5px; outline: 0; background: #121416; font: 11px 'JetBrains Mono', monospace; }
.relay-vault-path-field input:focus, .relay-vault-remote-url-field input:focus { border-color: var(--relay-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--relay-cyan) 9%, transparent); }
.relay-vault-remote-url-field { display: grid; gap: 7px; }
.relay-vault-remote-url-field > small { color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.relay-vault-remote-toggle { min-height: 76px; padding: 11px 12px; display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 11px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 7px; background: rgb(255 255 255 / 1.5%); cursor: pointer; }
.relay-vault-remote-toggle.selected { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 48%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 7%, transparent); }
.relay-vault-remote-toggle:has(input:focus-visible) { outline: 2px solid var(--relay-cyan); outline-offset: 2px; }
.relay-vault-remote-toggle:has(input:disabled) { cursor: not-allowed; opacity: .58; }
.relay-vault-remote-toggle > input { position: absolute; opacity: 0; pointer-events: none; }
.relay-vault-mode-icon { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, currentColor 27%, transparent); border-radius: 7px; background: color-mix(in srgb, currentColor 7%, transparent); }
.relay-vault-remote-toggle > span:nth-child(3) { display: flex; flex-direction: column; gap: 5px; }
.relay-vault-remote-toggle strong { color: var(--color-text-strong); font-size: 13px; }
.relay-vault-remote-toggle small { color: var(--color-text-muted); font-size: 10px; line-height: 1.5; }
.relay-vault-toggle-switch { width: 36px; height: 20px; padding: 2px; display: flex; align-items: center; border: 1px solid var(--color-border); border-radius: 11px; background: #111315; transition: border-color 140ms ease, background 140ms ease; }
.relay-vault-toggle-switch i { width: 14px; height: 14px; border-radius: 50%; background: #717a80; transition: transform 140ms ease, background 140ms ease; }
.relay-vault-remote-toggle.selected .relay-vault-toggle-switch { border-color: color-mix(in srgb, var(--relay-cyan) 58%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 14%, #111315); }
.relay-vault-remote-toggle.selected .relay-vault-toggle-switch i { background: var(--relay-cyan); transform: translateX(16px); }
.relay-vault-storage-note { margin: 0; padding: 9px 11px; display: flex; align-items: flex-start; gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(255 255 255 / 1.5%); font-size: 10px; line-height: 1.5; }
.relay-vault-storage-note svg { margin-top: 1px; flex: none; color: var(--relay-amber); }
.relay-vault-privacy-result { margin: 0; padding: 9px 11px; display: flex; align-items: center; gap: 7px; color: var(--color-success); border: 1px solid color-mix(in srgb, var(--color-success) 24%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--color-success) 5%, transparent); font-size: 10px; }
.relay-vault-privacy-result[data-remote='true'] { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 27%, var(--color-border)); background: color-mix(in srgb, var(--relay-cyan) 6%, transparent); }
.relay-vault-advanced-settings { border-top: 1px solid var(--color-border-subtle); }
.relay-vault-advanced-settings > summary { padding-top: 12px; display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); cursor: pointer; font-size: 10px; list-style: none; }
.relay-vault-advanced-settings > summary::-webkit-details-marker { display: none; }
.relay-vault-advanced-settings[open] > summary { color: var(--relay-cyan); }
.relay-vault-advanced-settings .relay-vault-location-card { margin-top: 12px; }
.relay-vault-advanced-grid { margin-top: 12px; display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 10px; }
.relay-vault-advanced-grid > label:only-child { grid-column: 1 / -1; }
.relay-vault-advanced-settings > p { margin: 10px 0 0; display: flex; align-items: flex-start; gap: 6px; color: var(--color-text-muted); font-size: 10px; line-height: 1.5; }
.relay-vault-advanced-settings > p svg { margin-top: 1px; flex: none; color: var(--relay-cyan); }
.relay-vault-setup-error { margin: 15px 0 0; overflow-wrap: anywhere; }
.relay-vault-setup-card > footer { min-height: 68px; padding: 12px 23px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 9px; border-top: 1px solid var(--color-border-subtle); background: rgb(0 0 0 / 12%); }
.relay-vault-setup-card > footer > span { justify-self: center; display: inline-flex; align-items: center; gap: 5px; color: #737b81; font-size: 9px; }
.relay-vault-setup-card > footer .primary-button { min-width: 154px; }
.relay-vault-next-button, .relay-vault-create-button { color: #102125; border-color: var(--relay-cyan); background: var(--relay-cyan); }
.relay-cmux-settings-card { width: min(720px, 100%); max-height: calc(100dvh - 44px); padding: 22px; overflow: auto; color: var(--color-text); border: 1px solid color-mix(in srgb, var(--relay-cyan) 30%, var(--color-border)); border-radius: 10px; background: radial-gradient(circle at 92% -6%, color-mix(in srgb, var(--relay-cyan) 9%, transparent), transparent 34%), #1b1d1f; box-shadow: 0 30px 100px rgb(0 0 0 / 62%); }
.relay-cmux-settings-card > header { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: start; gap: 14px; }
.relay-cmux-settings-card > header .relay-confirm-icon { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 32%, transparent); background: color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-cmux-settings-card h2 { margin: 7px 0 0; color: var(--color-text-strong); font-size: 21px; letter-spacing: -.025em; }
.relay-cmux-settings-card header p { max-width: 560px; margin: 6px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.55; }
.relay-cmux-settings-state { min-height: 180px; margin-top: 18px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-muted); border: 1px dashed var(--color-border); border-radius: 7px; font-size: 11px; }
.relay-cmux-capability { margin-top: 18px; padding: 10px 11px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 24%, var(--color-border)); border-radius: 7px; background: color-mix(in srgb, var(--relay-cyan) 5%, transparent); }
.relay-cmux-capability[data-state='unavailable'], .relay-cmux-capability[data-state='unknown'] { color: var(--color-text-muted); border-color: var(--color-border-subtle); background: rgb(255 255 255 / 2%); }
.relay-cmux-capability > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.relay-cmux-capability strong { color: currentColor; font-size: 11px; }
.relay-cmux-capability small { color: var(--color-text-muted); font-size: 9px; line-height: 1.45; }
.relay-cmux-capability code { max-width: 280px; overflow: hidden; color: #8f989e; font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-cmux-template-field { margin-top: 13px; display: grid; grid-template-columns: 118px minmax(0, 1fr); align-items: stretch; gap: 10px; }
.relay-cmux-template-field > span { padding: 10px; display: flex; justify-content: center; flex-direction: column; gap: 4px; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 11%); }
.relay-cmux-template-field b { color: var(--color-text-strong); font-size: 12px; }
.relay-cmux-template-field small { color: var(--color-text-muted); font-size: 9px; line-height: 1.4; }
.relay-cmux-template-field textarea { width: 100%; min-height: 82px; padding: 10px 11px; resize: vertical; color: #cdd3d6; border: 1px solid var(--color-border); border-radius: 6px; outline: 0; background: #0e1011; font: 10px/1.6 'JetBrains Mono', monospace; }
.relay-cmux-template-field textarea:focus { border-color: var(--relay-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-cmux-placeholders { margin-top: 13px; padding: 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 10%); }
.relay-cmux-placeholders > span { margin-right: 3px; font-size: 10px; }
.relay-cmux-placeholders code { padding: 3px 5px; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 20%, transparent); border-radius: 4px; background: color-mix(in srgb, var(--relay-cyan) 5%, transparent); font: 9px 'JetBrains Mono', monospace; }
.relay-cmux-placeholders small { width: 100%; margin-top: 3px; color: #7c848a; font-size: 9px; line-height: 1.5; }
.relay-cmux-settings-card > footer { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.relay-cmux-save-button { color: #071519; border-color: var(--relay-cyan); background: var(--relay-cyan); }
.relay-native-confirm-card { width: min(620px, 100%); border-color: color-mix(in srgb, var(--relay-cyan) 34%, var(--color-border)); background: radial-gradient(circle at 90% 0, color-mix(in srgb, var(--relay-cyan) 9%, transparent), transparent 36%), #1c1e20; }
.relay-native-confirm-card .relay-confirm-icon { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 32%, transparent); background: color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-native-confirm-card p code { color: var(--relay-cyan); font: 10px 'JetBrains Mono', monospace; }
.relay-cmux-confirm-card { width: min(620px, 100%); border-color: color-mix(in srgb, var(--relay-cyan) 34%, var(--color-border)); background: radial-gradient(circle at 90% 0, color-mix(in srgb, var(--relay-cyan) 9%, transparent), transparent 36%), #1c1e20; }
.relay-cmux-confirm-card .relay-confirm-icon { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 32%, transparent); background: color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-cmux-confirm-grid { margin: 13px 0 0; display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; }
.relay-cmux-confirm-grid > div { min-width: 0; padding: 9px 10px; border-right: 1px solid var(--color-border-subtle); background: rgb(0 0 0 / 11%); }
.relay-cmux-confirm-grid > div:last-child { border-right: 0; }
.relay-cmux-confirm-grid dt { color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
.relay-cmux-confirm-grid dd { margin: 5px 0 0; overflow: hidden; color: var(--color-text); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.relay-cmux-confirm-grid code { font: 9px 'JetBrains Mono', monospace; }
.relay-cmux-command-review { margin-top: 10px; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: #0d0f10; }
.relay-cmux-command-review > span { min-height: 30px; padding: 0 9px; display: flex; align-items: center; color: var(--color-text-muted); border-bottom: 1px solid var(--color-border-subtle); font-size: 9px; }
.relay-cmux-command-review pre { max-height: 150px; margin: 0; padding: 10px; overflow: auto; color: #c5ccd0; font: 10px/1.55 'JetBrains Mono', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.relay-epoch-card { width: min(780px, 100%); max-height: calc(100dvh - 44px); display: flex; flex-direction: column; overflow: hidden; color: var(--color-text); border: 1px solid color-mix(in srgb, var(--relay-cyan) 30%, var(--color-border)); border-radius: 10px; background: radial-gradient(circle at 88% -8%, color-mix(in srgb, var(--relay-cyan) 9%, transparent), transparent 34%), #1b1d1f; box-shadow: 0 30px 100px rgb(0 0 0 / 62%); }
.relay-epoch-card > header { min-height: 96px; padding: 20px 22px; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: start; gap: 14px; border-bottom: 1px solid var(--color-border-subtle); background: rgb(255 255 255 / 1.5%); }
.relay-epoch-card > header .relay-confirm-icon { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 32%, transparent); background: color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-epoch-card > header h2 { margin: 7px 0 0; color: var(--color-text-strong); font-size: 21px; letter-spacing: -.025em; }
.relay-epoch-card > header p { margin: 6px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.55; }
.relay-epoch-card > header .icon-button { margin-top: 2px; }
.relay-epoch-loading { min-height: 250px; padding: 30px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-muted); }
.relay-epoch-loading.error { color: var(--relay-red); }
.relay-epoch-current { margin: 18px 22px 0; padding: 15px; border: 1px solid color-mix(in srgb, var(--relay-cyan) 25%, var(--color-border)); border-radius: 8px; background: linear-gradient(135deg, color-mix(in srgb, var(--relay-cyan) 7%, transparent), transparent 48%), rgb(0 0 0 / 13%); }
.relay-epoch-current.suggested { border-color: color-mix(in srgb, var(--relay-amber) 34%, var(--color-border)); background: linear-gradient(135deg, color-mix(in srgb, var(--relay-amber) 7%, transparent), transparent 48%), rgb(0 0 0 / 13%); }
.relay-epoch-current-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.relay-epoch-current-heading > span { display: inline-flex; align-items: center; gap: 7px; color: var(--color-success); font: 9px 'JetBrains Mono', monospace; letter-spacing: .11em; }
.relay-epoch-current-heading i { width: 7px; height: 7px; border-radius: 50%; background: var(--color-success); box-shadow: 0 0 10px color-mix(in srgb, var(--color-success) 55%, transparent); }
.relay-epoch-current-heading strong { color: var(--relay-cyan); font: 12px 'JetBrains Mono', monospace; }
.relay-epoch-current > code { margin-top: 10px; display: block; overflow: hidden; color: var(--color-text); font: 10px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-epoch-current-grid { margin-top: 13px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; }
.relay-epoch-current-grid > div { min-width: 0; min-height: 60px; padding: 9px 10px; display: flex; justify-content: center; flex-direction: column; gap: 5px; border-right: 1px solid var(--color-border-subtle); }
.relay-epoch-current-grid > div:last-child { border-right: 0; }
.relay-epoch-current-grid span { color: var(--color-text-muted); font-size: 9px; }
.relay-epoch-current-grid strong { overflow: hidden; color: var(--relay-cyan); font: 10px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-epoch-suggestion, .relay-epoch-threshold { margin: 10px 0 0; display: flex; align-items: flex-start; gap: 6px; color: var(--relay-amber); font-size: 10px; line-height: 1.5; }
.relay-epoch-threshold { color: var(--color-text-muted); }
.relay-epoch-actions { min-height: 60px; margin: 0 22px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--color-border-subtle); }
.relay-epoch-actions > span { display: inline-flex; align-items: center; gap: 7px; color: var(--color-text-muted); font-size: 10px; }
.relay-epoch-actions .primary-button { min-height: 35px; }
.relay-epoch-history { min-height: 0; margin: 0 22px 22px; overflow-y: auto; }
.relay-epoch-history > header { min-height: 44px; display: flex; align-items: center; justify-content: space-between; }
.relay-epoch-history > header span { color: var(--color-text-strong); font-size: 12px; font-weight: 600; }
.relay-epoch-history > header small { color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; letter-spacing: .1em; }
.relay-epoch-empty { min-height: 74px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-muted); border: 1px dashed var(--color-border); border-radius: 7px; font-size: 11px; }
.relay-epoch-history article { min-height: 82px; padding: 10px 11px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; border: 1px solid var(--color-border-subtle); border-bottom: 0; background: rgb(0 0 0 / 10%); }
.relay-epoch-history article:first-of-type { border-radius: 7px 7px 0 0; }
.relay-epoch-history article:last-child { border-bottom: 1px solid var(--color-border-subtle); border-radius: 0 0 7px 7px; }
.relay-epoch-lock { width: 34px; height: 34px; display: grid; place-items: center; color: var(--relay-cyan); border: 1px solid color-mix(in srgb, var(--relay-cyan) 24%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--relay-cyan) 6%, transparent); }
.relay-epoch-history article > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.relay-epoch-history article strong { color: var(--color-text-strong); font-size: 12px; }
.relay-epoch-history article code { max-width: 350px; overflow: hidden; color: #8d959b; font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-epoch-history article small { color: var(--color-text-muted); font-size: 9px; }
.relay-epoch-history article > code { color: var(--relay-cyan); }
.relay-epoch-history article .secondary-button { min-height: 31px; font-size: 10px; }
.relay-epoch-rotate-form { min-height: 0; padding: 0 22px 22px; overflow-y: auto; }
.relay-epoch-path-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.relay-epoch-path-input .secondary-button { min-height: 39px; }
.relay-epoch-remote-toggle { margin-top: 15px; padding: 11px; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; color: var(--color-text); border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 11%); cursor: pointer; }
.relay-epoch-remote-toggle input { accent-color: var(--relay-cyan); }
.relay-epoch-remote-toggle span { display: flex; flex-direction: column; gap: 3px; }
.relay-epoch-remote-toggle strong { font-size: 11px; }
.relay-epoch-remote-toggle small { color: var(--color-text-muted); font-size: 9px; line-height: 1.45; }
.relay-epoch-remote-fields { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 0 10px; }
.relay-epoch-remote-fields .relay-merge-field:first-child { grid-column: 1; }
.relay-epoch-remote-fields .relay-merge-field:nth-child(2) { grid-column: 2; }
.relay-epoch-remote-fields .relay-merge-field:last-child { grid-column: 1 / -1; }
.relay-epoch-guarantees { margin: 15px 0 0; padding: 11px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; color: var(--color-text-muted); border: 1px solid color-mix(in srgb, var(--color-success) 18%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--color-success) 4%, transparent); font-size: 10px; list-style: none; }
.relay-epoch-guarantees li { display: flex; align-items: flex-start; gap: 6px; line-height: 1.5; }
.relay-epoch-guarantees svg { margin-top: 1px; flex: none; color: var(--color-success); }
.relay-epoch-rotate-form > footer { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.relay-confirm-card { width: min(520px, 100%); padding: 22px; display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 15px; color: var(--color-text); border: 1px solid color-mix(in srgb, var(--relay-amber) 28%, var(--color-border)); border-radius: 10px; background: radial-gradient(circle at 90% 0, color-mix(in srgb, var(--relay-amber) 7%, transparent), transparent 34%), #1c1e20; box-shadow: 0 28px 90px rgb(0 0 0 / 55%); }
.relay-confirm-icon { width: 44px; height: 44px; display: grid; place-items: center; color: var(--relay-amber); border: 1px solid color-mix(in srgb, var(--relay-amber) 30%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--relay-amber) 7%, transparent); }
.relay-confirm-card h2 { margin: 8px 0 0; color: var(--color-text-strong); font-size: 20px; letter-spacing: -.025em; }
.relay-confirm-card p { margin: 10px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.65; }
.relay-confirm-card p strong { color: var(--color-text); font-weight: 600; }
.relay-confirm-card ul { margin: 13px 0 0; padding: 10px 11px; display: grid; gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 12%); font-size: 11px; list-style: none; }
.relay-confirm-card li { display: flex; align-items: flex-start; gap: 7px; line-height: 1.5; }
.relay-confirm-card li svg { margin-top: 2px; flex: none; color: var(--color-success); }
.relay-confirm-card li.relay-dangerous-confirm { color: var(--relay-amber); }
.relay-confirm-card li.relay-dangerous-confirm svg { color: var(--relay-amber); }
.relay-confirm-card li.relay-dangerous-confirm code { color: var(--relay-amber); font: 9px 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
.relay-trash-confirm, .relay-trash-empty-card { border-color: color-mix(in srgb, var(--relay-red) 32%, var(--color-border)); background: radial-gradient(circle at 90% 0, color-mix(in srgb, var(--relay-red) 8%, transparent), transparent 36%), #1c1e20; }
.relay-trash-confirm .relay-confirm-icon, .relay-trash-empty-card .relay-confirm-icon { color: var(--relay-red); border-color: color-mix(in srgb, var(--relay-red) 30%, transparent); background: color-mix(in srgb, var(--relay-red) 7%, transparent); }
.relay-trash-confirm li:last-child svg { color: var(--relay-red); }
.primary-button.danger { border-color: color-mix(in srgb, var(--relay-red) 55%, transparent); background: var(--relay-red); color: #160608; }
.primary-button.danger:hover:not(:disabled) { filter: brightness(1.08); }
.relay-trash-empty-card { width: min(620px, 100%); }
.relay-trash-preview-state { min-height: 92px; margin-top: 14px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-muted); border: 1px dashed var(--color-border); border-radius: 7px; font-size: 11px; }
.relay-trash-preview-grid { margin-top: 14px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 7px; background: rgb(0 0 0 / 13%); }
.relay-trash-preview-grid > div { min-width: 0; padding: 11px; display: flex; flex-direction: column; gap: 5px; border-right: 1px solid var(--color-border-subtle); border-bottom: 1px solid var(--color-border-subtle); }
.relay-trash-preview-grid > div:nth-child(3n) { border-right: 0; }
.relay-trash-preview-grid > div:nth-last-child(-n + 3) { border-bottom: 0; }
.relay-trash-preview-grid span { color: var(--color-text-muted); font-size: 10px; }
.relay-trash-preview-grid strong { overflow: hidden; color: var(--relay-red); font: 13px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-trash-preview-grid strong[data-tone='muted'] { color: var(--color-text); }
.relay-trash-preview-grid strong[data-tone='warning'] { color: var(--relay-amber); }
.relay-trash-sync-status { margin-top: 10px !important; padding: 9px 10px; display: flex; align-items: flex-start; gap: 7px; color: var(--relay-amber) !important; border: 1px solid color-mix(in srgb, var(--relay-amber) 24%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--relay-amber) 5%, transparent); }
.relay-trash-sync-status[data-ready='true'] { color: var(--color-success) !important; border-color: color-mix(in srgb, var(--color-success) 24%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 5%, transparent); }
.relay-trash-sync-status svg { margin-top: 2px; flex: none; }
.relay-trash-blockers { margin-top: 10px !important; color: var(--relay-amber) !important; border-color: color-mix(in srgb, var(--relay-amber) 22%, var(--color-border)) !important; }
.relay-trash-blockers li svg { color: var(--relay-amber); }
.relay-trash-history-warning { margin-top: 10px !important; padding: 10px 11px; display: flex; align-items: flex-start; gap: 7px; color: var(--relay-red) !important; border: 1px solid color-mix(in srgb, var(--relay-red) 22%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--relay-red) 4%, transparent); }
.relay-trash-history-warning svg { margin-top: 2px; flex: none; }
.relay-confirm-actions { margin-top: 17px; display: flex; justify-content: flex-end; gap: 8px; }
.relay-merge-card { width: min(660px, 100%); max-height: calc(100dvh - 44px); padding: 22px; overflow: auto; color: var(--color-text); border: 1px solid color-mix(in srgb, var(--relay-cyan) 30%, var(--color-border)); border-radius: 10px; background: radial-gradient(circle at 94% 0, color-mix(in srgb, var(--relay-cyan) 8%, transparent), transparent 32%), #1c1e20; box-shadow: 0 30px 100px rgb(0 0 0 / 62%); }
.relay-merge-card > header { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 14px; }
.relay-merge-card .relay-confirm-icon { color: var(--relay-cyan); border-color: color-mix(in srgb, var(--relay-cyan) 30%, transparent); background: color-mix(in srgb, var(--relay-cyan) 7%, transparent); }
.relay-trash-conflict-card { border-color: color-mix(in srgb, #ff8b71 34%, var(--color-border)); background: radial-gradient(circle at 94% 0, color-mix(in srgb, #ff8b71 10%, transparent), transparent 34%), #1c1e20; }
.relay-trash-conflict-card .relay-confirm-icon { color: #ff8b71; border-color: color-mix(in srgb, #ff8b71 36%, transparent); background: color-mix(in srgb, #ff8b71 9%, transparent); }
.relay-trash-conflict-card .relay-section-index { color: #ff9a81; }
.relay-conflict-sources { grid-template-columns: 1fr; }
.conflict-save-submit { color: #071417; border-color: var(--relay-cyan); background: var(--relay-cyan); }
.conflict-save-submit:hover:not(:disabled) { background: color-mix(in srgb, var(--relay-cyan) 88%, white); box-shadow: 0 7px 20px color-mix(in srgb, var(--relay-cyan) 18%, transparent); }
.relay-merge-card h2 { margin: 6px 0 0; color: var(--color-text-strong); font-size: 20px; letter-spacing: -.025em; }
.relay-merge-card header p { margin: 7px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.6; }
.relay-merge-field { margin-top: 16px; display: grid; gap: 7px; }
.relay-merge-field > span, .relay-merge-baseline legend { color: var(--color-text); font-size: 11px; font-weight: 600; }
.relay-merge-field > span small { margin-left: 5px; color: var(--color-text-muted); font-weight: 400; }
.relay-merge-field input, .relay-merge-field textarea { width: 100%; padding: 10px 11px; color: var(--color-text); border: 1px solid var(--color-border); border-radius: 6px; outline: 0; background: #111315; font: inherit; font-size: 12px; line-height: 1.55; resize: vertical; }
.relay-merge-field input:focus, .relay-merge-field textarea:focus { border-color: var(--relay-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--relay-cyan) 8%, transparent); }
.relay-merge-baseline { margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; border: 0; }
.relay-merge-baseline legend { grid-column: 1 / -1; padding: 0; }
.relay-merge-baseline > p { grid-column: 1 / -1; margin: -2px 0 2px; color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.relay-merge-baseline label { min-width: 0; min-height: 54px; padding: 8px 10px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 12%); cursor: pointer; }
.relay-merge-baseline label.selected { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 30%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 4%, transparent); }
.relay-merge-baseline input { accent-color: var(--color-success); }
.relay-merge-baseline label > span { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.relay-merge-baseline strong { overflow: hidden; color: var(--color-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relay-merge-baseline small { overflow: hidden; color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
.relay-merge-warning, .relay-merge-error { margin: 13px 0 0; padding: 9px 10px; display: flex; align-items: flex-start; gap: 7px; color: var(--relay-amber); border: 1px solid color-mix(in srgb, var(--relay-amber) 22%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--relay-amber) 4%, transparent); font-size: 10px; line-height: 1.5; }
.relay-merge-warning svg, .relay-merge-error svg { margin-top: 1px; flex: none; }
.relay-merge-error { color: var(--relay-red); border-color: color-mix(in srgb, var(--relay-red) 22%, transparent); background: color-mix(in srgb, var(--relay-red) 4%, transparent); }
.relay-merge-card > footer { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 1180px) {
  .relay-actions { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .relay-sync-chip { grid-column: 1 / -1; }
  .relay-actions > button { justify-content: center; }
  .relay-list-toolbar { align-items: flex-start; flex-direction: column; }
  .relay-filters { width: 100%; }
  .relay-search { width: 100%; flex: 1; }
  .relay-lifecycle-tabs { flex-wrap: wrap; }
  .relay-lifecycle-tabs > small { width: 100%; margin: 0; padding: 2px 3px 4px; }
}

@media (max-width: 1024px) {
  .relay-command-deck { padding: 18px; }
  .relay-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-metrics > div:nth-child(2) { border-right: 0; }
  .relay-metrics > div:nth-child(-n + 2) { border-bottom: 1px solid var(--color-border-subtle); }
  .relay-session-row { grid-template-columns: minmax(0, 1fr) 218px; }
  .relay-session-open { grid-template-columns: 78px minmax(0, 1fr) 166px; }
  .relay-session-copy { padding-inline: 14px; }
  .relay-session-meta { padding-inline: 12px; }
  .relay-session-management { padding-inline: 8px; }
  .relay-detail-header { align-items: stretch; flex-direction: column; }
  .relay-detail-header-actions { justify-content: flex-end; }
}

@media (max-width: 760px) {
  .relay-workspace { padding-top: 14px; }
  .relay-filters { align-items: stretch; flex-direction: column; }
  .relay-provider-filter { width: 100%; }
  .relay-provider-filter button { flex: 1; }
  .relay-lifecycle-tabs > button { flex: 1; justify-content: center; }
  .relay-session-row { grid-template-columns: minmax(0, 1fr); }
  .relay-session-open { grid-template-columns: 62px minmax(0, 1fr); }
  .relay-session-meta { grid-column: 2; padding-top: 0; align-items: center; justify-content: flex-start; flex-direction: row; flex-wrap: wrap; border-left: 0; }
  .relay-session-management { padding: 8px; flex-direction: row; border-top: 1px solid var(--color-border-subtle); border-left: 0; }
  .relay-session-management button { flex: 1; }
  .relay-detail { width: 100vw; padding: 20px 18px; }
  .relay-detail-header { top: -20px; margin: -20px -18px 0; padding: 20px 18px 13px; }
  .relay-detail-signals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-detail-signals div:nth-child(2) { border-right: 0; }
  .relay-detail-signals div:nth-child(-n + 2) { border-bottom: 1px solid var(--color-border-subtle); }
  .relay-recovery-heading { align-items: stretch; flex-direction: column; }
  .relay-recovery-heading .secondary-button { align-self: flex-start; }
  .relay-recovery-status { grid-template-columns: 8px minmax(0, 1fr); }
  .relay-recovery-status small { grid-column: 2; }
  .relay-recovery-path { align-items: stretch; flex-direction: column; }
  .relay-recovery-path > div { align-items: flex-start; flex-direction: column; gap: 4px; }
  .relay-recovery-path code { width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .relay-recovery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-recovery-grid > div:nth-child(2) { border-right: 0; }
  .relay-recovery-grid > div:nth-child(-n + 2) { border-bottom: 1px solid var(--color-border-subtle); }
  .relay-detail-header-actions { justify-content: flex-start; flex-wrap: wrap; }
  .relay-detail-header-actions .icon-button { margin-left: auto; }
  .relay-confirm-card { padding: 18px; grid-template-columns: 36px minmax(0, 1fr); }
  .relay-confirm-icon { width: 36px; height: 36px; }
}
</style>
