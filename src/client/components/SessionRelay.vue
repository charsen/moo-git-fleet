<script setup lang="ts">
import {
  AlertTriangle,
  ArrowDownToLine,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cloud,
  CloudOff,
  Code2,
  CopyPlus,
  Download,
  Eye,
  FolderOpen,
  HardDrive,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  Checkpoint,
  CheckpointDiscoveryPayload,
  DiscoveredSession,
  LocalSessionDetail,
  SessionListItem,
  SessionDetail,
  SessionProvider,
  SessionVaultStatus,
  SessionVaultSyncStatus,
} from '../../shared/sessions';
import { sessionVaultPrivateRemoteConfirmation } from '../../shared/sessions';
import type { RecoveryPlan } from '../../shared/recovery';
import { api } from '../api';
import SessionSaveDrawer from './SessionSaveDrawer.vue';

const emit = defineEmits<{
  syncBusy: [busy: boolean];
  pullAvailable: [available: boolean];
}>();

type Feedback = { tone: 'success' | 'warning' | 'error'; message: string };
type RestoreConfirmation = { session: SessionListItem; plan: RecoveryPlan };

const discovery = ref<CheckpointDiscoveryPayload | null>(null);
const backupSessions = ref<SessionListItem[]>([]);
const vaultStatus = ref<SessionVaultStatus | null>(null);
const sync = ref<SessionVaultSyncStatus | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const loadError = ref('');
const backupError = ref('');
const search = ref('');
const provider = ref<SessionProvider | null>(null);
const feedback = ref<Feedback | null>(null);

const selectedSession = ref<DiscoveredSession | null>(null);
const localDetail = ref<LocalSessionDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const detailElement = ref<HTMLElement | null>(null);
let detailRequest = 0;

const deleteSession = ref<DiscoveredSession | null>(null);
const deleteBusy = ref(false);
const deleteError = ref('');

const saveOpen = ref(false);
const saveBusy = ref(false);
const pullBusy = ref(false);

const setupOpen = ref(false);
const setupRemoteUrl = ref('');
const setupBusy = ref(false);
const setupError = ref('');

const restorePreparingId = ref<string | null>(null);
const restoreConfirmation = ref<RestoreConfirmation | null>(null);
const restoreBusy = ref(false);
const restoreError = ref('');

const conflictDetail = ref<SessionDetail | null>(null);
const conflictSession = ref<SessionListItem | null>(null);
const conflictLocalSession = ref<DiscoveredSession | null>(null);
const conflictLoading = ref(false);
const conflictBusy = ref<'select' | 'split' | null>(null);
const conflictError = ref('');

let refreshTimer: number | null = null;
let previousHtmlOverflow = '';
let previousBodyOverflow = '';

function sessionKey(session: Pick<DiscoveredSession, 'provider' | 'providerSessionId'>): string {
  return `${session.provider}:${session.providerSessionId}`;
}

function providerLabel(value: SessionProvider): string {
  return value === 'claude' ? 'Claude' : 'Codex';
}

function projectLabel(session: Pick<DiscoveredSession, 'repositoryName' | 'projectPath' | 'projectId'>): string {
  if (session.repositoryName) return session.repositoryName;
  if (session.projectPath) return session.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? session.projectId;
  return '未识别项目';
}

function relativeTime(value: string | null): string {
  if (!value) return '时间未知';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '时间未知';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

async function loadBackupSessions(): Promise<{ items: SessionListItem[]; sync: SessionVaultSyncStatus }> {
  const first = await api.sessions({ page: 1, pageSize: 50, lifecycle: 'all' });
  if (first.totalPages <= 1) return { items: first.items, sync: first.sync };
  const pages = await Promise.all(Array.from({ length: first.totalPages - 1 }, (_, index) => (
    api.sessions({ page: index + 2, pageSize: 50, lifecycle: 'all' })
  )));
  return { items: [first.items, ...pages.map((page) => page.items)].flat(), sync: first.sync };
}

async function refreshAll(silent = false): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  if (!silent) loading.value = true;
  loadError.value = '';
  backupError.value = '';
  try {
    const [discoveryResult, vaultResult, backupsResult] = await Promise.allSettled([
      api.sessionDiscovery(),
      api.sessionVaultStatus(),
      loadBackupSessions(),
    ]);
    if (discoveryResult.status === 'rejected') throw discoveryResult.reason;
    const nextDiscovery = discoveryResult.value;
    discovery.value = nextDiscovery;
    if (vaultResult.status === 'fulfilled') vaultStatus.value = vaultResult.value;
    else backupError.value = vaultResult.reason instanceof Error ? vaultResult.reason.message : '备份设置暂时不可用';
    if (backupsResult.status === 'fulfilled') {
      backupSessions.value = backupsResult.value.items;
      sync.value = backupsResult.value.sync;
    } else {
      backupSessions.value = [];
      sync.value = null;
      backupError.value ||= backupsResult.reason instanceof Error ? backupsResult.reason.message : '备份状态暂时不可用';
    }
    const current = selectedSession.value;
    if (current) {
      const refreshed = nextDiscovery.sessions.find((session) => sessionKey(session) === sessionKey(current));
      if (!refreshed) closeDetail();
      else selectedSession.value = refreshed;
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '本机会话读取失败';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

const localSessions = computed(() => discovery.value?.sessions ?? []);
const localKeys = computed(() => new Set(localSessions.value.map(sessionKey)));
const backupByKey = computed(() => new Map(
  backupSessions.value.map((session) => [`${session.provider}:${session.providerSessionId}`, session]),
));

function backupFor(session: DiscoveredSession): SessionListItem | null {
  return backupByKey.value.get(sessionKey(session)) ?? null;
}

function needsBackup(session: DiscoveredSession): boolean {
  const backup = backupFor(session);
  if (!backup || backup.lifecycleState === 'trashed') return true;
  const localAt = new Date(session.lastActivityAt ?? session.createdAt ?? 0).getTime();
  const backupAt = new Date(backup.latestCheckpointAt).getTime();
  return Number.isFinite(localAt) && Number.isFinite(backupAt) && localAt > backupAt + 1_000;
}

function backupLabel(session: DiscoveredSession): { label: string; tone: string } {
  const backup = backupFor(session);
  if (!backup) return { label: '仅本机', tone: 'local' };
  if (backup.lifecycleState === 'trashed') return { label: '删除待对齐', tone: 'warning' };
  if (backup.forked) return { label: '有两个版本', tone: 'warning' };
  if (needsBackup(session)) return { label: '有新内容', tone: 'warning' };
  return { label: '已备份', tone: 'synced' };
}

const filteredSessions = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return localSessions.value.filter((session) => {
    if (provider.value && session.provider !== provider.value) return false;
    if (!needle) return true;
    return [
      session.title,
      session.projectPath,
      session.repositoryName,
      session.providerSessionId,
    ].some((value) => value?.toLocaleLowerCase().includes(needle));
  });
});

const remoteOnlySessions = computed(() => backupSessions.value.filter((session) => (
  session.lifecycleState === 'active' && !localKeys.value.has(`${session.provider}:${session.providerSessionId}`)
)));
const backedUpCount = computed(() => localSessions.value.filter((session) => {
  const backup = backupFor(session);
  return backup && backup.lifecycleState !== 'trashed' && !needsBackup(session);
}).length);
const pendingBackupCount = computed(() => localSessions.value.filter(needsBackup).length);
const vaultConfigured = computed(() => Boolean(vaultStatus.value?.configured));
const remoteSyncEnabled = computed(() => Boolean(vaultStatus.value?.binding?.remoteSyncEnabled));
const allBusy = computed(() => saveBusy.value || pullBusy.value || deleteBusy.value || restoreBusy.value || conflictLoading.value || Boolean(conflictBusy.value) || Boolean(restorePreparingId.value));
const overlayOpen = computed(() => Boolean(
  selectedSession.value || deleteSession.value || setupOpen.value || restoreConfirmation.value || conflictSession.value || saveOpen.value,
));
const conflictHeads = computed(() => {
  const detail = conflictDetail.value;
  if (!detail) return [];
  const headIds = new Set(detail.session.headCheckpointIds);
  return detail.checkpoints
    .filter((checkpoint) => headIds.has(checkpoint.checkpointId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
});
const conflictLocalHead = computed(() => (
  conflictHeads.value.find((checkpoint) => checkpoint.machine === discovery.value?.machine) ?? null
));

const syncPresentation = computed(() => {
  if (backupError.value) return { label: '备份暂时不可用', detail: backupError.value, tone: 'warning' };
  if (!vaultConfigured.value) return { label: '尚未连接私有 Git', detail: '本机会话仍可查看和删除', tone: 'idle' };
  if (!remoteSyncEnabled.value) return { label: '只备份在这台电脑', detail: '连接私有 Git 后可在两台电脑间同步', tone: 'local' };
  const state = sync.value?.state;
  if (state === 'synced') return { label: '两台电脑已对齐', detail: sync.value?.message ?? '没有待同步内容', tone: 'synced' };
  if (state === 'remote-ahead') return { label: '另一台电脑有新内容', detail: '点击“拉取同步”即可取得', tone: 'warning' };
  if (state === 'local-ahead') return { label: '本机有内容待上传', detail: '点击“备份全部并同步”即可上传', tone: 'warning' };
  if (state === 'diverged') return { label: '两台电脑都发生了变化', detail: '先拉取，系统会保留两边内容', tone: 'warning' };
  return { label: '等待检查同步状态', detail: sync.value?.message ?? '稍后重试', tone: 'idle' };
});

watch(allBusy, (busy) => emit('syncBusy', busy), { immediate: true });
watch(remoteSyncEnabled, (available) => emit('pullAvailable', available), { immediate: true });
watch(overlayOpen, (locked) => {
  if (locked) {
    previousHtmlOverflow = document.documentElement.style.overflow;
    previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  } else {
    document.documentElement.style.overflow = previousHtmlOverflow;
    document.body.style.overflow = previousBodyOverflow;
  }
});

async function openDetail(session: DiscoveredSession): Promise<void> {
  const requestId = ++detailRequest;
  selectedSession.value = session;
  localDetail.value = null;
  detailError.value = '';
  detailLoading.value = true;
  await nextTick();
  detailElement.value?.focus({ preventScroll: true });
  try {
    const detail = await api.localSessionDetail(session.provider, session.providerSessionId);
    if (requestId === detailRequest) localDetail.value = detail;
  } catch (error) {
    if (requestId === detailRequest) detailError.value = error instanceof Error ? error.message : '会话内容读取失败';
  } finally {
    if (requestId === detailRequest) detailLoading.value = false;
  }
}

function closeDetail(): void {
  detailRequest += 1;
  selectedSession.value = null;
  localDetail.value = null;
  detailLoading.value = false;
  detailError.value = '';
}

function requestDelete(session: DiscoveredSession): void {
  deleteSession.value = session;
  deleteError.value = '';
}

async function confirmDelete(): Promise<void> {
  const session = deleteSession.value;
  if (!session || deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = '';
  try {
    const result = await api.deleteLocalSession(session.provider, session.providerSessionId);
    feedback.value = { tone: result.syncPending ? 'warning' : 'success', message: result.message };
    deleteSession.value = null;
    if (selectedSession.value && sessionKey(selectedSession.value) === sessionKey(session)) closeDetail();
    await refreshAll(true);
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : '会话删除失败';
  } finally {
    deleteBusy.value = false;
  }
}

function openBackup(): void {
  feedback.value = null;
  if (!vaultConfigured.value) {
    setupOpen.value = true;
    setupError.value = '';
    return;
  }
  saveOpen.value = true;
}

async function handleSaved(result: { tone: 'success' | 'warning'; message: string }): Promise<void> {
  feedback.value = { tone: result.tone, message: result.message };
  await refreshAll(true);
}

async function initializeBackup(): Promise<void> {
  const remoteUrl = setupRemoteUrl.value.trim();
  const status = vaultStatus.value;
  if (!remoteUrl) {
    setupError.value = '请粘贴你自己的私有 Git 仓库地址';
    return;
  }
  if (!status) {
    setupError.value = '暂时无法读取本机备份目录，请先刷新后再试';
    return;
  }
  setupBusy.value = true;
  setupError.value = '';
  try {
    await api.initializeSessionVault({
      vaultPath: status.suggestedVaultPath,
      remoteName: 'origin',
      remoteUrl,
      enableRemoteSync: true,
      confirmationPhrase: sessionVaultPrivateRemoteConfirmation,
    });
    setupOpen.value = false;
    setupRemoteUrl.value = '';
    await refreshAll(true);
    saveOpen.value = true;
  } catch (error) {
    setupError.value = error instanceof Error ? error.message : '私有 Git 连接失败';
  } finally {
    setupBusy.value = false;
  }
}

async function pullUpdates(): Promise<void> {
  if (pullBusy.value) return;
  if (!vaultConfigured.value || !remoteSyncEnabled.value) {
    setupOpen.value = true;
    return;
  }
  pullBusy.value = true;
  feedback.value = null;
  try {
    const result = await api.pullSessionVault();
    const deletionRetry = await api.retryPendingLocalSessionDeletions().catch(() => null);
    await refreshAll(true);
    const waiting = remoteOnlySessions.value.length;
    feedback.value = {
      tone: deletionRetry?.syncPending ? 'warning' : 'success',
      message: deletionRetry?.syncPending
        ? `会话已拉取；${deletionRetry.message}`
        : waiting > 0
          ? `同步完成，发现 ${waiting} 条会话可恢复到本机`
          : result.message,
    };
  } catch (error) {
    feedback.value = { tone: 'error', message: error instanceof Error ? error.message : '拉取同步失败' };
  } finally {
    pullBusy.value = false;
  }
}

async function prepareRestore(session: SessionListItem): Promise<void> {
  if (restorePreparingId.value || restoreBusy.value) return;
  restorePreparingId.value = session.sessionId;
  restoreError.value = '';
  try {
    let plan = await api.sessionRecoveryPlan(session.sessionId, { refreshRemote: false });
    if (plan.mapping.state === 'needs-selection') {
      const selected = await api.selectDirectory();
      if (!selected.path) return;
      plan = await api.sessionRecoveryPlan(session.sessionId, { localPath: selected.path, refreshRemote: false });
    }
    if (!plan.native.available || !plan.native.fingerprint) {
      feedback.value = { tone: 'warning', message: plan.native.message };
      return;
    }
    restoreConfirmation.value = { session, plan };
  } catch (error) {
    feedback.value = { tone: 'error', message: error instanceof Error ? error.message : '会话恢复准备失败' };
  } finally {
    restorePreparingId.value = null;
  }
}

async function confirmRestore(): Promise<void> {
  const confirmation = restoreConfirmation.value;
  const fingerprint = confirmation?.plan.native.fingerprint;
  if (!confirmation || !fingerprint || restoreBusy.value) return;
  restoreBusy.value = true;
  restoreError.value = '';
  try {
    const result = await api.executeNativeRestore(confirmation.session.sessionId, {
      localPath: confirmation.plan.mapping.localPath,
      checkpointId: confirmation.plan.checkpoint.checkpointId,
      permissionMode: 'standard',
      expectedNativeFingerprint: fingerprint,
      confirmNativeRestore: true,
    });
    restoreConfirmation.value = null;
    feedback.value = { tone: result.action === 'failed' ? 'warning' : 'success', message: result.message };
    await refreshAll(true);
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : '会话恢复失败';
  } finally {
    restoreBusy.value = false;
  }
}

function conflictVersionLabel(checkpoint: Checkpoint): string {
  if (checkpoint.machine === discovery.value?.machine) return '这台电脑';
  return checkpoint.machine || '另一台电脑';
}

function closeConflict(force = false): void {
  if (conflictBusy.value && !force) return;
  conflictSession.value = null;
  conflictDetail.value = null;
  conflictLocalSession.value = null;
  conflictLoading.value = false;
  conflictError.value = '';
}

async function openConflict(local: DiscoveredSession | null, backup: SessionListItem): Promise<void> {
  conflictSession.value = backup;
  conflictLocalSession.value = local;
  conflictDetail.value = null;
  conflictError.value = '';
  conflictLoading.value = true;
  try {
    const detail = await api.sessionDetail(backup.sessionId);
    if (!detail.session.forked || detail.session.headCheckpointIds.length < 2) {
      conflictSession.value = null;
      feedback.value = { tone: 'success', message: '两个版本已经处理完成' };
      await refreshAll(true);
      return;
    }
    conflictDetail.value = detail;
  } catch (error) {
    conflictError.value = error instanceof Error ? error.message : '版本信息读取失败';
  } finally {
    conflictLoading.value = false;
  }
}

function openLocalConflict(session: DiscoveredSession): void {
  const backup = backupFor(session);
  if (backup?.forked) void openConflict(session, backup);
}

async function pushConflictChange(): Promise<string | null> {
  if (!remoteSyncEnabled.value) return null;
  try {
    await api.pushSessionVault();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '远端同步待重试';
  }
}

async function selectConflictVersion(checkpoint: Checkpoint): Promise<void> {
  const detail = conflictDetail.value;
  const local = conflictLocalSession.value;
  if (!detail || conflictBusy.value) return;
  conflictBusy.value = 'select';
  conflictError.value = '';
  try {
    await api.selectSessionForkHead(detail.session.sessionId, {
      expectedHeadCheckpointIds: detail.session.headCheckpointIds,
      selectedHeadCheckpointId: checkpoint.checkpointId,
    });
    const shouldRestore = Boolean(local && checkpoint.machine !== discovery.value?.machine);
    const syncWarning = await pushConflictChange();
    closeConflict(true);
    await refreshAll(true);
    const selected = backupSessions.value.find((item) => item.sessionId === detail.session.sessionId);
    if (shouldRestore && selected) {
      await prepareRestore(selected);
      if (restoreConfirmation.value) {
        feedback.value = syncWarning
          ? { tone: 'warning', message: `版本已选择；${syncWarning}` }
          : { tone: 'success', message: '已选择另一台电脑的版本，确认后会替换本机会话' };
      }
    } else {
      feedback.value = syncWarning
        ? { tone: 'warning', message: `版本已保留；${syncWarning}` }
        : { tone: 'success', message: `已保留${conflictVersionLabel(checkpoint)}的版本` };
    }
  } catch (error) {
    conflictError.value = error instanceof Error ? error.message : '版本选择失败';
  } finally {
    conflictBusy.value = null;
  }
}

async function keepBothConflictVersions(): Promise<void> {
  const detail = conflictDetail.value;
  const heads = conflictHeads.value;
  if (!detail || heads.length !== 2 || conflictBusy.value) return;
  const selected = conflictLocalHead.value ?? heads[0]!;
  const split = heads.find((checkpoint) => checkpoint.checkpointId !== selected.checkpointId)!;
  conflictBusy.value = 'split';
  conflictError.value = '';
  try {
    const result = await api.splitSessionFork(detail.session.sessionId, {
      expectedHeadCheckpointIds: detail.session.headCheckpointIds,
      selectedHeadCheckpointId: selected.checkpointId,
      splitHeadCheckpointId: split.checkpointId,
      newSessionSummary: {
        goal: `${split.title || detail.session.title || '未命名会话'}（${conflictVersionLabel(split)}版本）`,
        completed: [],
        decisions: ['保留双机产生的两个独立版本'],
        nextSteps: [],
        blockers: [],
        commands: [],
        risks: [],
        source: 'manual',
        reviewedAt: new Date().toISOString(),
      },
    });
    const syncWarning = await pushConflictChange();
    closeConflict(true);
    await refreshAll(true);
    const splitSession = backupSessions.value.find((item) => item.sessionId === result.newSessionId);
    if (splitSession) await prepareRestore(splitSession);
    if (restoreConfirmation.value) {
      feedback.value = syncWarning
        ? { tone: 'warning', message: `两份版本都已保留；${syncWarning}` }
        : { tone: 'success', message: '两份版本都已保留，确认后会把第二份恢复为独立本机会话' };
    } else if (syncWarning) {
      feedback.value = { tone: 'warning', message: `两份版本都已保留；${syncWarning}` };
    }
  } catch (error) {
    conflictError.value = error instanceof Error ? error.message : '保留两个版本失败';
  } finally {
    conflictBusy.value = null;
  }
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (deleteSession.value && !deleteBusy.value) deleteSession.value = null;
  else if (restoreConfirmation.value && !restoreBusy.value) restoreConfirmation.value = null;
  else if (conflictSession.value && !conflictBusy.value) closeConflict();
  else if (setupOpen.value && !setupBusy.value) setupOpen.value = false;
  else if (selectedSession.value) closeDetail();
}

onMounted(() => {
  window.addEventListener('keydown', handleEscape);
  void refreshAll();
  refreshTimer = window.setInterval(() => void refreshAll(true), 30_000);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  document.documentElement.style.overflow = previousHtmlOverflow;
  document.body.style.overflow = previousBodyOverflow;
  emit('syncBusy', false);
  emit('pullAvailable', false);
});

defineExpose({ pullUpdates });
</script>

<template>
  <main class="workspace local-session-workspace">
    <section class="session-command-bar" aria-labelledby="session-heading">
      <div class="session-title-block">
        <span class="session-eyebrow"><Bot :size="13" />LOCAL AI SESSION LIBRARY</span>
        <h1 id="session-heading">AI 会话</h1>
        <p>查看和管理这台电脑上的 Claude、Codex 会话；私有 Git 只负责在两台电脑之间备份。</p>
      </div>
      <div class="session-command-actions">
        <div class="sync-indicator" :data-tone="syncPresentation.tone">
          <CloudOff v-if="syncPresentation.tone === 'idle'" :size="16" />
          <AlertTriangle v-else-if="syncPresentation.tone === 'warning'" :size="16" />
          <CheckCircle2 v-else :size="16" />
          <span><strong>{{ syncPresentation.label }}</strong><small>{{ syncPresentation.detail }}</small></span>
        </div>
        <button class="primary-button backup-button" :disabled="allBusy" @click="openBackup">
          <LoaderCircle v-if="saveBusy" :size="15" class="spinning" /><Cloud v-else :size="15" />
          {{ remoteSyncEnabled ? '备份全部并同步' : '备份全部' }}
        </button>
        <button class="secondary-button pull-button" :disabled="allBusy" @click="pullUpdates">
          <LoaderCircle v-if="pullBusy" :size="15" class="spinning" /><ArrowDownToLine v-else :size="15" />拉取同步
        </button>
        <button class="icon-button refresh-button" aria-label="重新扫描本机会话" :disabled="refreshing || allBusy" @click="refreshAll()">
          <RefreshCw :size="17" :class="{ spinning: refreshing }" />
        </button>
      </div>
    </section>

    <p v-if="feedback" class="session-feedback" :data-tone="feedback.tone" role="status">
      <CheckCircle2 v-if="feedback.tone === 'success'" :size="15" />
      <AlertTriangle v-else :size="15" />
      <span>{{ feedback.message }}</span>
      <button aria-label="关闭提示" @click="feedback = null"><X :size="13" /></button>
    </p>

    <section class="session-overview" aria-label="会话概览">
      <div><span>这台电脑</span><strong>{{ localSessions.length }}</strong><small>Claude + Codex</small></div>
      <div><span>已经备份</span><strong>{{ backedUpCount }}</strong><small>内容已进入私有 Git</small></div>
      <div :data-alert="pendingBackupCount > 0"><span>等待备份</span><strong>{{ pendingBackupCount }}</strong><small>新增或有变化</small></div>
      <div :data-alert="remoteOnlySessions.length > 0"><span>另一台电脑</span><strong>{{ remoteOnlySessions.length }}</strong><small>可以恢复到本机</small></div>
    </section>

    <section v-if="remoteOnlySessions.length" class="incoming-sessions" aria-labelledby="incoming-heading">
      <header>
        <div><Download :size="17" /><span><strong id="incoming-heading">另一台电脑的新会话</strong><small>Pull 已完成，选择需要恢复到本机的会话。</small></span></div>
      </header>
      <div class="incoming-list">
        <article v-for="session in remoteOnlySessions" :key="session.sessionId">
          <span class="provider-mark" :data-provider="session.provider">{{ providerLabel(session.provider) }}</span>
          <div><strong>{{ session.title || '未命名会话' }}</strong><small>{{ relativeTime(session.latestCheckpointAt) }} · {{ session.machine }}</small></div>
          <button class="secondary-button" :disabled="allBusy" @click="session.forked ? openConflict(null, session) : prepareRestore(session)">
            <LoaderCircle v-if="restorePreparingId === session.sessionId || (conflictLoading && conflictSession?.sessionId === session.sessionId)" :size="14" class="spinning" /><CopyPlus v-else-if="session.forked" :size="14" /><Download v-else :size="14" />
            {{ session.forked ? '处理两个版本' : '恢复到本机' }}
          </button>
        </article>
      </div>
    </section>

    <section class="session-library" aria-labelledby="library-heading">
      <header class="library-toolbar">
        <div>
          <h2 id="library-heading">本机会话</h2>
          <small>点击任意一条查看完整对话预览</small>
        </div>
        <label class="session-search">
          <Search :size="15" />
          <input v-model="search" placeholder="搜索标题、项目或会话 ID" aria-label="搜索本机会话" />
          <button v-if="search" aria-label="清除搜索" @click="search = ''"><X :size="13" /></button>
        </label>
        <div class="provider-filter" role="group" aria-label="按 AI 类型筛选">
          <button :class="{ active: provider === null }" @click="provider = null">全部</button>
          <button :class="{ active: provider === 'claude' }" @click="provider = 'claude'">Claude</button>
          <button :class="{ active: provider === 'codex' }" @click="provider = 'codex'">Codex</button>
        </div>
      </header>

      <div v-if="loading" class="library-state"><LoaderCircle :size="24" class="spinning" /><strong>正在扫描本机会话</strong><span>只读取 Claude 和 Codex 的会话文件。</span></div>
      <div v-else-if="loadError" class="library-state error"><AlertTriangle :size="24" /><strong>会话读取失败</strong><span>{{ loadError }}</span><button class="secondary-button" @click="refreshAll()"><RefreshCw :size="14" />重试</button></div>
      <div v-else-if="filteredSessions.length === 0" class="library-state"><Inbox :size="26" /><strong>没有匹配的本机会话</strong><span>调整关键词或 AI 类型后再试。</span></div>
      <div v-else class="session-table" role="list">
        <article
          v-for="session in filteredSessions"
          :key="sessionKey(session)"
          class="session-row"
          :data-provider="session.provider"
          role="listitem"
        >
          <button class="session-row-main" @click="openDetail(session)">
            <span class="provider-mark" :data-provider="session.provider">{{ providerLabel(session.provider) }}</span>
            <span class="session-copy">
              <strong>{{ session.title || '未命名会话' }}</strong>
              <small><Code2 :size="12" />{{ projectLabel(session) }}</small>
            </span>
            <span class="session-facts">
              <small><Clock3 :size="12" />{{ relativeTime(session.lastActivityAt ?? session.createdAt) }}</small>
              <small>{{ session.messageCount }} 条记录 · {{ formatBytes(session.bytes) }}</small>
            </span>
            <span class="backup-state" :data-tone="backupLabel(session).tone">{{ backupLabel(session).label }}</span>
            <ChevronRight :size="16" />
          </button>
          <div class="session-row-actions">
            <button v-if="backupFor(session)?.forked" class="warning" aria-label="处理两个版本" @click="openLocalConflict(session)"><CopyPlus :size="15" /></button>
            <button aria-label="查看会话" @click="openDetail(session)"><Eye :size="15" /></button>
            <button class="danger" aria-label="删除会话" @click="requestDelete(session)"><Trash2 :size="15" /></button>
          </div>
        </article>
      </div>
    </section>

    <SessionSaveDrawer
      :open="saveOpen"
      :auto-push-available="remoteSyncEnabled"
      :remote-sync-enabled="remoteSyncEnabled"
      @close="saveOpen = false"
      @busy="saveBusy = $event"
      @saved="handleSaved"
    />

    <Teleport to="body">
      <template v-if="selectedSession">
        <button class="local-drawer-backdrop" aria-label="关闭会话详情" @click="closeDetail" />
        <aside ref="detailElement" class="local-session-drawer" role="dialog" aria-modal="true" aria-labelledby="local-detail-title" tabindex="-1">
          <header>
            <div>
              <span class="provider-mark" :data-provider="selectedSession.provider">{{ providerLabel(selectedSession.provider) }}</span>
              <div><h2 id="local-detail-title">{{ selectedSession.title || '未命名会话' }}</h2><p>{{ projectLabel(selectedSession) }} · {{ relativeTime(selectedSession.lastActivityAt ?? selectedSession.createdAt) }}</p></div>
            </div>
            <button class="icon-button" aria-label="关闭会话详情" @click="closeDetail"><X :size="18" /></button>
          </header>
          <div class="local-detail-body">
            <div v-if="detailLoading" class="detail-state"><LoaderCircle :size="23" class="spinning" /><strong>正在读取会话内容</strong></div>
            <div v-else-if="detailError" class="detail-state error"><AlertTriangle :size="23" /><strong>内容读取失败</strong><p>{{ detailError }}</p><button class="secondary-button" @click="openDetail(selectedSession)"><RefreshCw :size="14" />重试</button></div>
            <template v-else-if="localDetail">
              <section class="detail-summary-strip">
                <div><span>对话记录</span><strong>{{ localDetail.content.totalMessages }}</strong></div>
                <div><span>文件大小</span><strong>{{ formatBytes(localDetail.session.bytes) }}</strong></div>
                <div><span>备份状态</span><strong :data-tone="backupLabel(localDetail.session).tone">{{ backupLabel(localDetail.session).label }}</strong></div>
              </section>
              <section class="conversation-stream" aria-label="会话内容">
                <article v-for="(item, index) in localDetail.content.items" :key="`${index}:${item.occurredAt ?? ''}`" :data-role="item.role">
                  <span>{{ item.role === 'user' ? '你' : 'AI' }}</span>
                  <div><time v-if="item.occurredAt">{{ new Date(item.occurredAt).toLocaleString() }}</time><p>{{ item.text }}</p></div>
                </article>
                <div v-if="localDetail.content.items.length === 0" class="conversation-empty">没有可显示的用户或 AI 文本。</div>
              </section>
              <p v-if="localDetail.content.truncated" class="conversation-note"><ShieldCheck :size="13" />当前展示最近 200 条可读消息，备份仍保存完整会话记录。</p>
            </template>
          </div>
          <footer>
            <span><ShieldCheck :size="13" />只读查看，不会调用 Claude 或 Codex。</span>
            <div class="detail-footer-actions">
              <button v-if="backupFor(selectedSession)?.forked" class="secondary-button warning-button" @click="openLocalConflict(selectedSession)"><CopyPlus :size="14" />处理两个版本</button>
              <button class="secondary-button danger-button" @click="requestDelete(selectedSession)"><Trash2 :size="14" />移到废纸篓</button>
            </div>
          </footer>
        </aside>
      </template>

      <div v-if="deleteSession" class="session-modal-layer" @mousedown.self="!deleteBusy && (deleteSession = null)">
        <section class="session-modal danger-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title">
          <header><span><Trash2 :size="18" /></span><div><h2 id="delete-session-title">删除这条本机会话？</h2><p>{{ deleteSession.title || '未命名会话' }}</p></div></header>
          <div class="modal-copy">
            <p>原始会话文件会移到系统废纸篓，可以从系统废纸篓找回。</p>
            <p>如果它已经备份，系统也会记录删除并同步，避免另一台电脑再次把它带回来。</p>
          </div>
          <p v-if="deleteError" class="modal-error"><AlertTriangle :size="14" />{{ deleteError }}</p>
          <footer><button class="secondary-button" :disabled="deleteBusy" @click="deleteSession = null">取消</button><button class="primary-button destructive" :disabled="deleteBusy" @click="confirmDelete"><LoaderCircle v-if="deleteBusy" :size="14" class="spinning" /><Trash2 v-else :size="14" />移到废纸篓</button></footer>
        </section>
      </div>

      <div v-if="setupOpen" class="session-modal-layer" @mousedown.self="!setupBusy && (setupOpen = false)">
        <form class="session-modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-session-title" @submit.prevent="initializeBackup">
          <header><span><Cloud :size="18" /></span><div><h2 id="setup-session-title">连接私有 Git</h2><p>只需设置一次，两台电脑使用同一个私有仓库。</p></div></header>
          <label class="setup-field"><span>私有仓库地址</span><input v-model="setupRemoteUrl" autofocus placeholder="git@github.com:you/my-ai-sessions.git" :disabled="setupBusy" /><small>会话正文会保存在这个私有仓库中，请不要使用公开仓库。</small></label>
          <p class="setup-path"><HardDrive :size="13" />本机备份目录会自动使用：{{ vaultStatus?.suggestedVaultPath ?? 'Fleet 默认目录' }}</p>
          <p v-if="setupError" class="modal-error"><AlertTriangle :size="14" />{{ setupError }}</p>
          <footer><button type="button" class="secondary-button" :disabled="setupBusy" @click="setupOpen = false">取消</button><button class="primary-button" :disabled="setupBusy" type="submit"><LoaderCircle v-if="setupBusy" :size="14" class="spinning" /><Cloud v-else :size="14" />连接并开始备份</button></footer>
        </form>
      </div>

      <div v-if="restoreConfirmation" class="session-modal-layer" @mousedown.self="!restoreBusy && (restoreConfirmation = null)">
        <section class="session-modal restore-modal" role="dialog" aria-modal="true" aria-labelledby="restore-session-title">
          <header><span><Download :size="18" /></span><div><h2 id="restore-session-title">恢复到这台电脑</h2><p>{{ restoreConfirmation.session.title || '未命名会话' }}</p></div></header>
          <div class="restore-target"><FolderOpen :size="16" /><span><strong>{{ restoreConfirmation.plan.native.action === 'replace-with-backup' ? '本机已有同 ID 会话，将先备份再替换' : '将写入 Claude/Codex 的本机会话目录' }}</strong><small>{{ restoreConfirmation.plan.native.targetDisplayPath }}</small></span></div>
          <p>{{ restoreConfirmation.plan.native.message }}</p>
          <p v-if="restoreError" class="modal-error"><AlertTriangle :size="14" />{{ restoreError }}</p>
          <footer><button class="secondary-button" :disabled="restoreBusy" @click="restoreConfirmation = null">取消</button><button class="primary-button" :disabled="restoreBusy" @click="confirmRestore"><LoaderCircle v-if="restoreBusy" :size="14" class="spinning" /><Download v-else :size="14" />确认恢复</button></footer>
        </section>
      </div>

      <div v-if="conflictSession" class="session-modal-layer" @mousedown.self="!conflictBusy && closeConflict()">
        <section class="session-modal conflict-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-session-title">
          <header><span><CopyPlus :size="18" /></span><div><h2 id="conflict-session-title">同一会话有两个版本</h2><p>选择保留哪一份，或者让两份在本机并存。</p></div></header>
          <div v-if="conflictLoading" class="conflict-state"><LoaderCircle :size="21" class="spinning" /><span>正在读取两个版本…</span></div>
          <div v-else-if="conflictDetail" class="conflict-versions">
            <article v-for="checkpoint in conflictHeads" :key="checkpoint.checkpointId" :data-local="checkpoint.checkpointId === conflictLocalHead?.checkpointId">
              <header><span>{{ conflictVersionLabel(checkpoint) }}</span><small>{{ relativeTime(checkpoint.createdAt) }}</small></header>
              <strong>{{ checkpoint.title || '未命名会话' }}</strong>
              <p>{{ checkpoint.machine }} 保存</p>
              <button class="secondary-button" :disabled="Boolean(conflictBusy)" @click="selectConflictVersion(checkpoint)">
                <LoaderCircle v-if="conflictBusy === 'select'" :size="14" class="spinning" /><CheckCircle2 v-else :size="14" />
                {{ checkpoint.checkpointId === conflictLocalHead?.checkpointId ? '保留本机版本' : `保留 ${conflictVersionLabel(checkpoint)}版本` }}
              </button>
            </article>
          </div>
          <p v-if="conflictError" class="modal-error"><AlertTriangle :size="14" />{{ conflictError }}</p>
          <div v-if="conflictDetail" class="keep-both-action">
            <CopyPlus :size="17" />
            <span><strong>不想丢掉任何内容？</strong><small>第二份会生成新的会话 ID，两份可以同时恢复到本机。</small></span>
            <button class="primary-button" :disabled="Boolean(conflictBusy) || conflictHeads.length !== 2" @click="keepBothConflictVersions"><LoaderCircle v-if="conflictBusy === 'split'" :size="14" class="spinning" /><CopyPlus v-else :size="14" />两份都留</button>
          </div>
          <footer><button class="secondary-button" :disabled="Boolean(conflictBusy)" @click="closeConflict()">稍后处理</button></footer>
        </section>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.local-session-workspace { --session-cyan: #59c7d8; --session-amber: #e2b45c; --session-red: #ed6573; --session-green: #7dcc9a; min-height: calc(100vh - 70px); padding-bottom: 56px; color: var(--color-text); }
.session-command-bar { min-height: 132px; padding: 8px 0 21px; display: flex; align-items: flex-end; justify-content: space-between; gap: 30px; border-bottom: 1px solid var(--color-border); }
.session-title-block { min-width: 0; }
.session-eyebrow { display: inline-flex; align-items: center; gap: 7px; color: var(--session-cyan); font: 10px 'JetBrains Mono', monospace; letter-spacing: .14em; }
.session-title-block h1 { margin: 8px 0 0; color: var(--color-text-strong); font-size: clamp(34px, 4vw, 54px); font-weight: 600; letter-spacing: -.055em; line-height: .95; }
.session-title-block p { max-width: 720px; margin: 11px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.65; }
.session-command-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.sync-indicator { min-width: 230px; min-height: 43px; padding: 7px 10px; display: flex; align-items: center; gap: 9px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 6px; background: rgb(9 11 12 / 30%); }
.sync-indicator[data-tone='synced'] { color: var(--session-green); border-color: color-mix(in srgb, var(--session-green) 30%, var(--color-border)); }
.sync-indicator[data-tone='warning'] { color: var(--session-amber); border-color: color-mix(in srgb, var(--session-amber) 32%, var(--color-border)); }
.sync-indicator > span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sync-indicator strong { color: var(--color-text-strong); font-size: 10px; }
.sync-indicator small { max-width: 250px; overflow: hidden; color: var(--color-text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.backup-button { color: #102126; border-color: color-mix(in srgb, var(--session-cyan) 75%, white); background: var(--session-cyan); }
.pull-button { color: var(--session-cyan); }
.refresh-button { width: 39px; height: 39px; }
.session-feedback { margin: 13px 0 0; padding: 9px 11px; display: flex; align-items: center; gap: 8px; color: var(--session-green); border: 1px solid color-mix(in srgb, currentColor 30%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, currentColor 5%, transparent); font-size: 11px; }
.session-feedback[data-tone='warning'] { color: var(--session-amber); }
.session-feedback[data-tone='error'] { color: var(--session-red); }
.session-feedback span { flex: 1; }
.session-feedback button { padding: 2px; display: grid; place-items: center; color: currentColor; border: 0; background: transparent; cursor: pointer; }
.session-overview { margin-top: 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: 8px; background: linear-gradient(110deg, rgb(89 199 216 / 3%), rgb(0 0 0 / 12%)); }
.session-overview > div { min-height: 92px; padding: 15px 18px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: center; gap: 3px 14px; border-right: 1px solid var(--color-border-subtle); }
.session-overview > div:last-child { border-right: 0; }
.session-overview span { color: var(--color-text-muted); font-size: 10px; }
.session-overview strong { grid-row: span 2; color: var(--color-text-strong); font: 34px/1 'JetBrains Mono', monospace; }
.session-overview small { color: var(--color-text-muted); font-size: 9px; }
.session-overview > div[data-alert='true'] strong { color: var(--session-amber); }
.incoming-sessions { margin-top: 15px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--session-amber) 28%, var(--color-border)); border-radius: 8px; background: color-mix(in srgb, var(--session-amber) 3%, transparent); }
.incoming-sessions > header { min-height: 55px; padding: 10px 14px; display: flex; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--session-amber) 18%, var(--color-border)); }
.incoming-sessions > header > div { display: flex; align-items: center; gap: 10px; color: var(--session-amber); }
.incoming-sessions > header span { display: flex; flex-direction: column; gap: 3px; }
.incoming-sessions > header strong { color: var(--color-text-strong); font-size: 12px; }
.incoming-sessions > header small { color: var(--color-text-muted); font-size: 9px; }
.incoming-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.incoming-list article { min-height: 68px; padding: 10px 12px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 11px; border-right: 1px solid var(--color-border-subtle); border-bottom: 1px solid var(--color-border-subtle); }
.incoming-list article > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.incoming-list article strong { overflow: hidden; color: var(--color-text-strong); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.incoming-list article small { color: var(--color-text-muted); font-size: 9px; }
.provider-mark { min-width: 53px; height: 26px; padding: 0 7px; display: inline-flex; align-items: center; justify-content: center; color: var(--session-cyan); border: 1px solid color-mix(in srgb, currentColor 28%, var(--color-border)); border-radius: 4px; background: color-mix(in srgb, currentColor 5%, transparent); font: 9px 'JetBrains Mono', monospace; text-transform: uppercase; }
.provider-mark[data-provider='claude'] { color: var(--session-amber); }
.session-library { margin-top: 15px; overflow: hidden; border: 1px solid var(--color-border); border-radius: 8px; background: rgb(9 11 12 / 21%); }
.library-toolbar { min-height: 68px; padding: 12px 14px; display: grid; grid-template-columns: minmax(170px, 1fr) minmax(280px, 440px) auto; align-items: center; gap: 14px; border-bottom: 1px solid var(--color-border); }
.library-toolbar > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.library-toolbar h2 { margin: 0; color: var(--color-text-strong); font-size: 16px; }
.library-toolbar small { color: var(--color-text-muted); font-size: 9px; }
.session-search { height: 38px; padding: 0 8px 0 11px; display: flex; align-items: center; gap: 8px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 5px; background: #101214; }
.session-search:focus-within { color: var(--session-cyan); border-color: var(--session-cyan); box-shadow: 0 0 0 3px rgb(89 199 216 / 7%); }
.session-search input { min-width: 0; flex: 1; color: var(--color-text); border: 0; outline: 0; background: transparent; font-size: 11px; }
.session-search button { width: 24px; height: 24px; display: grid; place-items: center; color: var(--color-text-muted); border: 0; background: transparent; cursor: pointer; }
.provider-filter { height: 36px; padding: 3px; display: flex; border: 1px solid var(--color-border); border-radius: 5px; background: #101214; }
.provider-filter button { min-width: 64px; padding: 0 10px; color: var(--color-text-muted); border: 0; border-radius: 3px; background: transparent; cursor: pointer; font-size: 10px; }
.provider-filter button.active { color: var(--color-text-strong); background: var(--color-surface-hover); }
.library-state { min-height: 300px; padding: 40px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--color-text-muted); text-align: center; }
.library-state strong { color: var(--color-text-strong); font-size: 13px; }
.library-state span { max-width: 480px; font-size: 10px; line-height: 1.6; }
.library-state.error > svg { color: var(--session-red); }
.session-table { display: flex; flex-direction: column; }
.session-row { min-height: 72px; display: grid; grid-template-columns: minmax(0, 1fr) auto; border-bottom: 1px solid var(--color-border-subtle); }
.session-row:last-child { border-bottom: 0; }
.session-row:hover { background: rgb(255 255 255 / 1.8%); }
.session-row-main { min-width: 0; padding: 10px 12px; display: grid; grid-template-columns: 58px minmax(220px, 1fr) minmax(160px, .55fr) auto auto; align-items: center; gap: 12px; color: var(--color-text); border: 0; background: transparent; cursor: pointer; text-align: left; }
.session-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.session-copy strong { overflow: hidden; color: var(--color-text-strong); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.session-copy small, .session-facts small { display: flex; align-items: center; gap: 5px; color: var(--color-text-muted); font-size: 9px; }
.session-facts { display: flex; flex-direction: column; gap: 5px; }
.backup-state { min-width: 72px; padding: 4px 7px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 999px; font-size: 9px; text-align: center; }
.backup-state[data-tone='synced'] { color: var(--session-green); border-color: color-mix(in srgb, var(--session-green) 35%, var(--color-border)); }
.backup-state[data-tone='warning'] { color: var(--session-amber); border-color: color-mix(in srgb, var(--session-amber) 35%, var(--color-border)); }
.backup-state[data-tone='local'] { color: var(--session-cyan); }
.session-row-main > svg { color: var(--color-text-muted); }
.session-row-actions { padding: 0 11px; display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--color-border-subtle); }
.session-row-actions button { width: 31px; height: 31px; display: grid; place-items: center; color: var(--color-text-muted); border: 1px solid transparent; border-radius: 4px; background: transparent; cursor: pointer; }
.session-row-actions button:hover { color: var(--session-cyan); border-color: var(--color-border); background: var(--color-surface-hover); }
.session-row-actions button.warning:hover { color: var(--session-amber); }
.session-row-actions button.danger:hover { color: var(--session-red); }
.local-drawer-backdrop { position: fixed; z-index: 68; inset: 0; border: 0; background: rgb(4 6 7 / 58%); backdrop-filter: blur(4px); }
.local-session-drawer { position: fixed; z-index: 70; top: 0; right: 0; width: min(860px, calc(100vw - 120px)); height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; color: var(--color-text); border-left: 1px solid color-mix(in srgb, var(--session-cyan) 25%, var(--color-border)); outline: 0; background: radial-gradient(circle at 88% -8%, rgb(89 199 216 / 8%), transparent 28%), #181a1c; box-shadow: -32px 0 90px rgb(0 0 0 / 58%); animation: session-drawer-in 170ms ease-out both; }
@keyframes session-drawer-in { from { opacity: .5; transform: translateX(30px); } to { opacity: 1; transform: translateX(0); } }
.local-session-drawer > header { min-height: 88px; padding: 17px 20px; display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--color-border); background: rgb(24 26 28 / 94%); }
.local-session-drawer > header > div { min-width: 0; display: flex; align-items: flex-start; gap: 12px; }
.local-session-drawer > header h2 { margin: 1px 0 0; overflow: hidden; color: var(--color-text-strong); font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
.local-session-drawer > header p { margin: 5px 0 0; color: var(--color-text-muted); font-size: 10px; }
.local-detail-body { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.detail-state { min-height: 100%; padding: 50px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--color-text-muted); text-align: center; }
.detail-state strong { color: var(--color-text-strong); }
.detail-state p { margin: 0; font-size: 10px; }
.detail-state.error > svg { color: var(--session-red); }
.detail-summary-strip { margin: 18px 20px 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: 7px; background: rgb(0 0 0 / 12%); }
.detail-summary-strip > div { min-height: 64px; padding: 11px 13px; display: flex; justify-content: center; flex-direction: column; gap: 5px; border-right: 1px solid var(--color-border-subtle); }
.detail-summary-strip > div:last-child { border-right: 0; }
.detail-summary-strip span { color: var(--color-text-muted); font-size: 9px; }
.detail-summary-strip strong { color: var(--color-text-strong); font: 13px 'JetBrains Mono', monospace; }
.detail-summary-strip strong[data-tone='synced'] { color: var(--session-green); }
.detail-summary-strip strong[data-tone='warning'] { color: var(--session-amber); }
.conversation-stream { margin: 15px 20px 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: 7px; background: rgb(0 0 0 / 11%); }
.conversation-stream article { padding: 13px 14px; display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: start; gap: 11px; border-bottom: 1px solid var(--color-border-subtle); }
.conversation-stream article:last-child { border-bottom: 0; }
.conversation-stream article > span { min-height: 24px; display: grid; place-items: center; color: var(--session-cyan); border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: 4px; background: color-mix(in srgb, currentColor 6%, transparent); font-size: 9px; }
.conversation-stream article[data-role='assistant'] > span { color: var(--session-green); }
.conversation-stream article > div { min-width: 0; }
.conversation-stream time { display: block; margin-bottom: 5px; color: var(--color-text-muted); font: 8px 'JetBrains Mono', monospace; }
.conversation-stream p { margin: 0; color: var(--color-text); font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.conversation-empty { padding: 50px 20px; color: var(--color-text-muted); text-align: center; font-size: 10px; }
.conversation-note { margin: 11px 20px 20px; display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 9px; }
.local-session-drawer > footer { min-height: 65px; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--color-border); background: rgb(24 26 28 / 96%); }
.local-session-drawer > footer > span { display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 9px; }
.detail-footer-actions { display: flex; align-items: center; gap: 7px; }
.warning-button { color: var(--session-amber); }
.danger-button { color: var(--session-red); }
.session-modal-layer { position: fixed; z-index: 86; inset: 0; padding: 30px; display: grid; place-items: center; background: rgb(4 6 7 / 68%); backdrop-filter: blur(8px); }
.session-modal { width: min(520px, 100%); overflow: hidden; color: var(--color-text); border: 1px solid var(--color-border); border-radius: 9px; background: #1a1c1e; box-shadow: 0 30px 100px rgb(0 0 0 / 62%); }
.session-modal > header { padding: 17px 18px; display: flex; align-items: flex-start; gap: 11px; border-bottom: 1px solid var(--color-border); }
.session-modal > header > span { width: 34px; height: 34px; display: grid; place-items: center; color: var(--session-cyan); border: 1px solid color-mix(in srgb, currentColor 30%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); }
.danger-modal > header > span { color: var(--session-red); }
.session-modal h2 { margin: 0; color: var(--color-text-strong); font-size: 16px; }
.session-modal header p { margin: 4px 0 0; color: var(--color-text-muted); font-size: 10px; }
.modal-copy { padding: 16px 18px 4px; }
.modal-copy p, .restore-modal > p { margin: 0 0 10px; color: var(--color-text); font-size: 11px; line-height: 1.65; }
.session-modal > footer { padding: 13px 18px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--color-border); }
.session-modal .destructive { color: white; border-color: var(--session-red); background: color-mix(in srgb, var(--session-red) 82%, #351219); }
.modal-error { margin: 11px 18px; padding: 8px 9px; display: flex; align-items: flex-start; gap: 7px; color: var(--session-red); border: 1px solid color-mix(in srgb, var(--session-red) 30%, var(--color-border)); border-radius: 5px; background: color-mix(in srgb, var(--session-red) 5%, transparent); font-size: 10px; line-height: 1.5; }
.setup-field { margin: 16px 18px 0; display: flex; flex-direction: column; gap: 7px; }
.setup-field > span { color: var(--color-text-strong); font-size: 10px; }
.setup-field input { height: 40px; padding: 0 11px; color: var(--color-text); border: 1px solid var(--color-border); border-radius: 5px; outline: 0; background: #101214; font: 11px 'JetBrains Mono', monospace; }
.setup-field input:focus { border-color: var(--session-cyan); box-shadow: 0 0 0 3px rgb(89 199 216 / 7%); }
.setup-field small { color: var(--color-text-muted); font-size: 9px; line-height: 1.55; }
.setup-path { margin: 13px 18px 17px; display: flex; align-items: flex-start; gap: 7px; color: var(--color-text-muted); font-size: 9px; line-height: 1.55; overflow-wrap: anywhere; }
.restore-target { margin: 16px 18px 12px; padding: 11px; display: flex; align-items: flex-start; gap: 9px; color: var(--session-cyan); border: 1px solid color-mix(in srgb, var(--session-cyan) 25%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--session-cyan) 4%, transparent); }
.restore-target span { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.restore-target strong { color: var(--color-text-strong); font-size: 10px; }
.restore-target small { color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
.restore-modal > p { padding: 0 18px; color: var(--color-text-muted); }
.conflict-modal { width: min(660px, 100%); }
.conflict-state { min-height: 190px; padding: 30px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--color-text-muted); font-size: 10px; }
.conflict-versions { padding: 15px 18px 10px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.conflict-versions article { min-width: 0; padding: 13px; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--color-border); border-radius: 7px; background: rgb(0 0 0 / 13%); }
.conflict-versions article[data-local='true'] { border-color: color-mix(in srgb, var(--session-cyan) 34%, var(--color-border)); background: color-mix(in srgb, var(--session-cyan) 4%, transparent); }
.conflict-versions article > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.conflict-versions article > header span { color: var(--session-cyan); font: 9px 'JetBrains Mono', monospace; }
.conflict-versions article:not([data-local='true']) > header span { color: var(--session-amber); }
.conflict-versions article > header small { color: var(--color-text-muted); font-size: 8px; }
.conflict-versions article > strong { overflow: hidden; color: var(--color-text-strong); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.conflict-versions article > p { margin: 0; color: var(--color-text-muted); font-size: 9px; }
.conflict-versions article > button { margin-top: 3px; justify-content: center; }
.keep-both-action { margin: 3px 18px 16px; padding: 11px 12px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; color: var(--session-amber); border: 1px solid color-mix(in srgb, var(--session-amber) 28%, var(--color-border)); border-radius: 7px; background: color-mix(in srgb, var(--session-amber) 4%, transparent); }
.keep-both-action > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.keep-both-action strong { color: var(--color-text-strong); font-size: 10px; }
.keep-both-action small { color: var(--color-text-muted); font-size: 9px; line-height: 1.5; }
button:disabled, input:disabled { opacity: .48; cursor: not-allowed; }
@media (max-width: 1180px) {
  .session-command-bar { align-items: flex-start; flex-direction: column; }
  .session-command-actions { justify-content: flex-start; }
  .session-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .session-overview > div:nth-child(2) { border-right: 0; }
  .session-overview > div:nth-child(-n+2) { border-bottom: 1px solid var(--color-border-subtle); }
  .library-toolbar { grid-template-columns: 1fr auto; }
  .library-toolbar > div:first-child { grid-column: 1 / -1; }
  .session-row-main { grid-template-columns: 58px minmax(190px, 1fr) minmax(140px, .5fr) auto auto; }
}
</style>
