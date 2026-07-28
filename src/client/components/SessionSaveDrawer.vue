<script setup lang="ts">
import {
  AlertTriangle,
  ArrowUpFromLine,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Cloud,
  CloudOff,
  Code2,
  Database,
  GitBranch,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  CheckpointCaptureProgress,
  CheckpointDiscoveryPayload,
  CheckpointJob,
  CheckpointJobsPayload,
  CheckpointPreview,
  DiscoveredSession,
  HandoffSummary,
  SessionProvider,
  SourceSyncChoice,
} from '../../shared/sessions';
import { api } from '../api';

const props = defineProps<{
  open: boolean;
  autoPushAvailable: boolean;
  remoteSyncEnabled: boolean;
}>();

const emit = defineEmits<{
  close: [];
  busy: [busy: boolean];
  saved: [result: { tone: 'success' | 'warning'; message: string }];
}>();

interface SummaryDraft {
  goal: string;
  completed: string;
  decisions: string;
  nextSteps: string;
  blockers: string;
  commands: string;
  risks: string;
}

const emptySummaryDraft = (): SummaryDraft => ({
  goal: '',
  completed: '',
  decisions: '',
  nextSteps: '',
  blockers: '',
  commands: '',
  risks: '',
});

const discovery = ref<CheckpointDiscoveryPayload | null>(null);
const discoveryLoading = ref(false);
const discoveryError = ref('');
const searchDraft = ref('');
const providerFilter = ref<SessionProvider | null>(null);
const selectedKey = ref<string | null>(null);
const preview = ref<CheckpointPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref('');
const previewRequest = ref(0);
const summaryDraft = ref<SummaryDraft>(emptySummaryDraft());
const summaryEdited = ref(false);
const sourceSyncChoice = ref<SourceSyncChoice>('handoff-only');
const captureNativeCapsule = ref(false);
const acknowledgeNativePlaintext = ref(false);
const providerConfirmOpen = ref(false);
const providerSummaryBusy = ref(false);
const captureBusy = ref(false);
const captureError = ref('');
const checkpointJob = ref<CheckpointJob | null>(null);
const completion = ref<{ tone: 'success' | 'warning'; message: string } | null>(null);
const drawerElement = ref<HTMLElement | null>(null);
const providerSummaryButton = ref<HTMLElement | null>(null);
const providerConfirmElement = ref<HTMLElement | null>(null);
let checkpointStream: EventSource | null = null;
let finalizedOperationId: string | null = null;

const filteredSessions = computed(() => {
  const query = searchDraft.value.trim().toLocaleLowerCase();
  return (discovery.value?.sessions ?? []).filter((session) => {
    if (providerFilter.value && session.provider !== providerFilter.value) return false;
    if (!query) return true;
    return [
      session.title,
      session.repositoryName,
      session.repositoryId,
      session.projectPath,
      session.providerSessionId,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
});

const selectedSession = computed(() => {
  if (!selectedKey.value) return null;
  return discovery.value?.sessions.find((session) => sessionKey(session) === selectedKey.value) ?? null;
});

const nativeAvailable = computed(() => Boolean(
  preview.value?.providerCapabilities.state === 'supported' &&
  preview.value.providerCapabilities.nativeResume,
));

const summaryValidation = computed(() => {
  if (!summaryDraft.value.goal.trim()) return '交接目标不能为空';
  if (summaryDraft.value.goal.length > 10_000) return '交接目标超过 10,000 字符';
  for (const [label, value] of [
    ['已完成', summaryDraft.value.completed],
    ['关键决策', summaryDraft.value.decisions],
    ['下一步', summaryDraft.value.nextSteps],
    ['阻塞', summaryDraft.value.blockers],
    ['命令', summaryDraft.value.commands],
    ['风险', summaryDraft.value.risks],
  ] as const) {
    const lines = splitLines(value);
    if (lines.length > 200) return `${label}超过 200 条`;
    if (lines.some((line) => line.length > 2_000)) return `${label}中存在超过 2,000 字符的单条记录`;
  }
  return '';
});

const canCapture = computed(() => Boolean(
  preview.value?.workspace &&
  preview.value.workspaceFingerprint &&
  preview.value.sourceSyncGate &&
  preview.value.sourceSyncGate.choices.includes(sourceSyncChoice.value) &&
  !summaryValidation.value &&
  (!captureNativeCapsule.value || acknowledgeNativePlaintext.value) &&
  !captureBusy.value,
));

const currentProgress = computed(() => checkpointJob.value?.progress ?? []);
const currentStep = computed(() => currentProgress.value.at(-1)?.step ?? null);

watch(captureBusy, (busy) => emit('busy', busy));

watch(
  () => props.open,
  (open) => {
    if (open) {
      resetWorkflow();
      void nextTick(() => {
        drawerElement.value?.querySelector<HTMLElement>('[data-dialog-initial]')?.focus();
        void loadDiscovery();
      });
    } else {
      closeCheckpointStream();
    }
  },
  { immediate: true },
);

function sessionKey(session: Pick<DiscoveredSession, 'provider' | 'providerSessionId'>): string {
  return `${session.provider}:${session.providerSessionId}`;
}

function providerLabel(provider: SessionProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
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
  return `${Math.floor(hours / 24)} 天前`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_024 ** 2).toFixed(1)} MB`;
}

function projectLabel(session: DiscoveredSession): string {
  if (session.repositoryName) return session.repositoryName;
  if (session.projectPath) return session.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? session.projectId;
  return '未关联项目';
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function draftFromSummary(summary: HandoffSummary): SummaryDraft {
  return {
    goal: summary.goal,
    completed: summary.completed.join('\n'),
    decisions: summary.decisions.join('\n'),
    nextSteps: summary.nextSteps.join('\n'),
    blockers: summary.blockers.join('\n'),
    commands: summary.commands.join('\n'),
    risks: summary.risks.join('\n'),
  };
}

function reviewedSummary(): HandoffSummary {
  const source = summaryEdited.value ? 'manual' : (preview.value?.summary.source ?? 'manual');
  return {
    goal: summaryDraft.value.goal.trim(),
    completed: splitLines(summaryDraft.value.completed),
    decisions: splitLines(summaryDraft.value.decisions),
    nextSteps: splitLines(summaryDraft.value.nextSteps),
    blockers: splitLines(summaryDraft.value.blockers),
    commands: splitLines(summaryDraft.value.commands),
    risks: splitLines(summaryDraft.value.risks),
    source,
    reviewedAt: new Date().toISOString(),
  };
}

function markSummaryEdited(): void {
  summaryEdited.value = true;
  captureError.value = '';
  completion.value = null;
}

function defaultSourceChoice(nextPreview: CheckpointPreview): SourceSyncChoice {
  const choices = nextPreview.sourceSyncGate?.choices ?? ['handoff-only'];
  if (nextPreview.sourceSyncGate?.dirty && choices.includes('push-wip-ref')) return 'push-wip-ref';
  if (!nextPreview.sourceSyncGate?.headReachable && choices.includes('push-branch')) return 'push-branch';
  return choices[0] ?? 'handoff-only';
}

function applyPreview(nextPreview: CheckpointPreview): void {
  preview.value = nextPreview;
  summaryDraft.value = draftFromSummary(nextPreview.summary);
  summaryEdited.value = false;
  sourceSyncChoice.value = defaultSourceChoice(nextPreview);
  captureNativeCapsule.value = false;
  acknowledgeNativePlaintext.value = false;
  checkpointJob.value = null;
  completion.value = null;
  captureError.value = '';
}

function resetWorkflow(): void {
  previewRequest.value += 1;
  discovery.value = null;
  discoveryLoading.value = false;
  discoveryError.value = '';
  searchDraft.value = '';
  providerFilter.value = null;
  selectedKey.value = null;
  preview.value = null;
  previewLoading.value = false;
  previewError.value = '';
  summaryDraft.value = emptySummaryDraft();
  summaryEdited.value = false;
  sourceSyncChoice.value = 'handoff-only';
  captureNativeCapsule.value = false;
  acknowledgeNativePlaintext.value = false;
  providerConfirmOpen.value = false;
  providerSummaryBusy.value = false;
  captureBusy.value = false;
  captureError.value = '';
  checkpointJob.value = null;
  completion.value = null;
  finalizedOperationId = null;
  closeCheckpointStream();
}

async function loadDiscovery(): Promise<void> {
  if (discoveryLoading.value) return;
  discoveryLoading.value = true;
  discoveryError.value = '';
  try {
    discovery.value = await api.sessionDiscovery();
  } catch (error) {
    discoveryError.value = error instanceof Error ? error.message : '本机会话扫描失败';
  } finally {
    discoveryLoading.value = false;
  }
}

async function selectSession(session: DiscoveredSession): Promise<void> {
  if (!session.readable || !session.repositoryId || previewLoading.value || captureBusy.value) return;
  const key = sessionKey(session);
  const requestId = ++previewRequest.value;
  selectedKey.value = key;
  preview.value = null;
  previewError.value = '';
  captureError.value = '';
  completion.value = null;
  previewLoading.value = true;
  try {
    const nextPreview = await api.sessionCheckpointPreview(session.provider, session.providerSessionId);
    if (requestId === previewRequest.value && selectedKey.value === key) applyPreview(nextPreview);
  } catch (error) {
    if (requestId === previewRequest.value) {
      previewError.value = error instanceof Error ? error.message : '交接预览生成失败';
    }
  } finally {
    if (requestId === previewRequest.value) previewLoading.value = false;
  }
}

function requestProviderSummary(): void {
  if (!preview.value?.summaryGeneration.providerInvocationAvailable || providerSummaryBusy.value) return;
  providerConfirmOpen.value = true;
  void nextTick(() => {
    providerConfirmElement.value?.querySelector<HTMLElement>('[data-dialog-initial]')?.focus();
  });
}

function closeProviderConfirmation(restoreFocus = true): void {
  providerConfirmOpen.value = false;
  if (restoreFocus) {
    void nextTick(() => providerSummaryButton.value?.focus({ preventScroll: true }));
  }
}

async function generateProviderSummary(): Promise<void> {
  const session = selectedSession.value;
  if (!session || providerSummaryBusy.value) return;
  closeProviderConfirmation(false);
  providerSummaryBusy.value = true;
  previewError.value = '';
  try {
    const nextPreview = await api.sessionProviderSummaryPreview(session.provider, session.providerSessionId);
    applyPreview(nextPreview);
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : 'Provider 自摘要失败；本地草稿仍已保留';
  } finally {
    providerSummaryBusy.value = false;
  }
}

function choiceLabel(choice: SourceSyncChoice): string {
  if (choice === 'push-branch') return '推送当前分支';
  if (choice === 'push-wip-ref') return '推送 WIP ref';
  if (preview.value?.sourceSyncGate?.headReachable && !preview.value.sourceSyncGate.dirty) return '源码已在远端';
  return '仅保存交接';
}

function choiceDescription(choice: SourceSyncChoice): string {
  if (choice === 'push-branch') return '把当前 HEAD 推到同名远端分支；不包含未提交文件。';
  if (choice === 'push-wip-ref') return '用临时索引打包 staged、unstaged 与 untracked，不触碰当前工作区。';
  if (preview.value?.sourceSyncGate?.headReachable && !preview.value.sourceSyncGate.dirty) {
    return '当前 HEAD 已可从远端取得，无需额外推送源码。';
  }
  return '只保存摘要与元数据；另一台电脑可能拿不到当前代码。';
}

function progressLabel(step: CheckpointCaptureProgress['step']): string {
  const labels: Record<CheckpointCaptureProgress['step'], string> = {
    'native-capture': '原生胶囊',
    'source-sync-check': '源码复核',
    'source-sync-push': '源码同步',
    preparing: '准备对象',
    'writing-staging': '写入暂存',
    'secret-scan': '秘密扫描',
    'publishing-object': '发布对象',
    'writing-event': '追加事件',
    committing: '提交 Vault',
    complete: '本机完成',
    failed: '执行失败',
  };
  return labels[step];
}

function closeCheckpointStream(): void {
  checkpointStream?.close();
  checkpointStream = null;
}

function connectCheckpointStream(operationId: string): void {
  closeCheckpointStream();
  checkpointStream = new EventSource('/api/session-checkpoint-jobs/events');
  checkpointStream.addEventListener('session-checkpoint-jobs', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as CheckpointJobsPayload;
      const current = payload.jobs.find((item) => item.operationId === operationId);
      if (!current) return;
      checkpointJob.value = current;
      if (current.state === 'success' || current.state === 'failed') void finalizeCheckpoint(current);
    } catch {
      captureError.value = '保存进度消息无法解析；后台任务仍在继续';
    }
  });
  checkpointStream.onerror = () => {
    void api.sessionCheckpointJob(operationId).then((current) => {
      checkpointJob.value = current;
      if (current.state === 'success' || current.state === 'failed') void finalizeCheckpoint(current);
    }).catch(() => undefined);
  };
}

async function startCapture(): Promise<void> {
  const session = selectedSession.value;
  const currentPreview = preview.value;
  if (!session || !currentPreview || !canCapture.value) return;
  captureBusy.value = true;
  captureError.value = '';
  completion.value = null;
  checkpointJob.value = null;
  finalizedOperationId = null;
  try {
    const started = await api.startSessionCheckpoint(session.provider, session.providerSessionId, {
      summary: reviewedSummary(),
      expectedWorkspaceFingerprint: currentPreview.workspaceFingerprint!,
      expectedSourceSyncFingerprint: currentPreview.sourceSyncGate!.fingerprint,
      sourceSyncChoice: sourceSyncChoice.value,
      machine: discovery.value?.machine,
      captureNativeCapsule: captureNativeCapsule.value,
      acknowledgeNativePlaintext: captureNativeCapsule.value ? true : undefined,
    });
    checkpointJob.value = started;
    connectCheckpointStream(started.operationId);
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : 'Checkpoint 保存未能启动';
    captureBusy.value = false;
  }
}

async function finalizeCheckpoint(job: CheckpointJob): Promise<void> {
  if (finalizedOperationId === job.operationId) return;
  finalizedOperationId = job.operationId;
  closeCheckpointStream();
  if (job.state === 'failed') {
    captureError.value = job.error?.message ?? 'Checkpoint 保存失败；已编辑摘要仍保留';
    captureBusy.value = false;
    finalizedOperationId = null;
    return;
  }
  if (!job.result) {
    captureError.value = 'Checkpoint 已结束但缺少结果；请刷新 Vault 列表确认';
    captureBusy.value = false;
    return;
  }
  let result: { tone: 'success' | 'warning'; message: string };
  if (props.autoPushAvailable) {
    try {
      const synced = await api.pushSessionVault();
      result = { tone: 'success', message: `保存并同步完成 · ${synced.message}` };
    } catch (error) {
      result = {
        tone: 'warning',
        message: `Checkpoint 已保留在本机；远端同步失败：${error instanceof Error ? error.message : '请稍后重试'}`,
      };
    }
  } else if (props.remoteSyncEnabled) {
    result = { tone: 'warning', message: 'Checkpoint 已保留在本机；当前远端状态不允许自动 Push，请先处理同步状态' };
  } else {
    result = { tone: 'success', message: 'Checkpoint 已保存到本机 Vault；当前未启用远端同步' };
  }
  completion.value = result;
  captureBusy.value = false;
  emit('saved', result);
}

async function retryPush(): Promise<void> {
  if (!completion.value || captureBusy.value) return;
  captureBusy.value = true;
  captureError.value = '';
  try {
    const synced = await api.pushSessionVault();
    const result = { tone: 'success' as const, message: `同步完成 · ${synced.message}` };
    completion.value = result;
    emit('saved', result);
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '同步重试失败';
  } finally {
    captureBusy.value = false;
  }
}

function requestClose(): void {
  if (captureBusy.value) return;
  providerConfirmOpen.value = false;
  emit('close');
}

function handleEscape(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (providerConfirmOpen.value) {
    closeProviderConfirmation();
    return;
  }
  requestClose();
}

onMounted(() => window.addEventListener('keydown', handleEscape));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  closeCheckpointStream();
  emit('busy', false);
});
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <button class="drawer-backdrop relay-detail-backdrop save-backdrop" aria-label="关闭保存并同步" @click="requestClose" />
      <aside ref="drawerElement" class="save-drawer" role="dialog" aria-modal="true" aria-labelledby="save-drawer-title" :aria-busy="captureBusy" data-focus-layer tabindex="-1">
        <header class="save-header">
          <div>
            <span class="save-kicker"><Sparkles :size="12" />DEPARTURE CHECKLIST / LOCAL PROVIDERS</span>
            <h2 id="save-drawer-title">保存并同步</h2>
            <p>选择一条本机会话，复核真正要带走的工作，再由 Fleet 保存 checkpoint。</p>
          </div>
          <button class="icon-button" data-dialog-initial aria-label="关闭保存并同步" :disabled="captureBusy" @click="requestClose"><X :size="18" /></button>
        </header>

        <nav class="save-stage-strip" aria-label="保存并同步步骤">
          <span :class="{ active: !preview, complete: Boolean(selectedSession) }"><b>01</b>发现本机会话</span>
          <ChevronRight :size="14" />
          <span :class="{ active: Boolean(preview) && !checkpointJob, complete: Boolean(checkpointJob) }"><b>02</b>复核交接清单</span>
          <ChevronRight :size="14" />
          <span :class="{ active: Boolean(checkpointJob), complete: Boolean(completion) }"><b>03</b>保存与同步</span>
        </nav>

        <div class="save-body">
          <section class="save-session-rail" aria-label="本机会话">
            <header>
              <div>
                <strong>本机会话</strong>
                <small>{{ discovery?.sessions.length ?? 0 }} 条 · 最近 30 天</small>
              </div>
              <button class="rail-refresh" :disabled="discoveryLoading || captureBusy" aria-label="重新扫描本机会话" @click="loadDiscovery"><RefreshCw :size="14" :class="{ spinning: discoveryLoading }" /></button>
            </header>
            <label class="save-search">
              <Code2 :size="13" />
              <input v-model="searchDraft" placeholder="标题 / 项目 / session id" aria-label="搜索本机会话" />
              <button v-if="searchDraft" aria-label="清除搜索" @click="searchDraft = ''"><X :size="12" /></button>
            </label>
            <div class="save-provider-tabs" role="group" aria-label="筛选 provider">
              <button :class="{ active: providerFilter === null }" @click="providerFilter = null">全部</button>
              <button :class="{ active: providerFilter === 'claude' }" @click="providerFilter = 'claude'">Claude</button>
              <button :class="{ active: providerFilter === 'codex' }" @click="providerFilter = 'codex'">Codex</button>
            </div>

            <div v-if="discoveryLoading" class="rail-state"><LoaderCircle :size="18" class="spinning" /><span>只读扫描 provider JSONL…</span></div>
            <div v-else-if="discoveryError" class="rail-state error"><AlertTriangle :size="18" /><span>{{ discoveryError }}</span><button @click="loadDiscovery">重试</button></div>
            <div v-else-if="filteredSessions.length === 0" class="rail-state"><Bot :size="18" /><span>没有匹配的本机会话</span></div>
            <div v-else class="local-session-list">
              <button
                v-for="session in filteredSessions"
                :key="sessionKey(session)"
                class="local-session-row"
                :class="{ selected: selectedKey === sessionKey(session), blocked: !session.readable || !session.repositoryId }"
                :data-provider="session.provider"
                :disabled="captureBusy"
                @click="selectSession(session)"
              >
                <span class="local-provider"><Bot :size="14" />{{ providerLabel(session.provider) }}</span>
                <span class="local-copy">
                  <strong>{{ session.title || '未命名本机会话' }}</strong>
                  <small><Code2 :size="10" />{{ projectLabel(session) }}</small>
                  <small><CircleDashed :size="10" />{{ relativeTime(session.lastActivityAt ?? session.createdAt) }} · {{ session.messageCount }} 条 · {{ formatBytes(session.bytes) }}</small>
                  <em v-if="!session.repositoryId"><AlertTriangle :size="10" />未关联 Fleet 仓库</em>
                  <em v-else-if="!session.readable"><AlertTriangle :size="10" />会话不可读</em>
                  <em v-else-if="session.tailTruncated"><CircleDashed :size="10" />尾行写入中，将忽略截断记录</em>
                </span>
                <ChevronRight :size="14" />
              </button>
            </div>
            <p v-if="discovery?.errors.length" class="rail-warning"><AlertTriangle :size="12" />{{ discovery.errors.length }} 个文件扫描异常；未影响的会话仍可保存。</p>
          </section>

          <section class="save-review">
            <div v-if="!selectedSession" class="review-state">
              <span class="review-orbit"><HardDrive :size="23" /></span>
              <strong>先选择这次要带走的会话</strong>
              <p>这里只读取 Claude / Codex 的白名单 JSONL；不会启动 AI，也不会修改 provider 目录。</p>
            </div>
            <div v-else-if="previewLoading" class="review-state"><LoaderCircle :size="22" class="spinning" /><strong>正在生成交接预览</strong><p>复核工作区、远端可达性与 provider 能力…</p></div>
            <div v-else-if="previewError && !preview" class="review-state error"><AlertTriangle :size="22" /><strong>预览失败</strong><p>{{ previewError }}</p><button class="secondary-button" @click="selectSession(selectedSession)"><RefreshCw :size="14" />重新预览</button></div>
            <form v-else-if="preview" class="save-manifest" @submit.prevent="startCapture">
              <section class="manifest-identity">
                <span class="identity-provider"><Bot :size="15" />{{ providerLabel(preview.session.provider) }}</span>
                <div><strong>{{ preview.session.title || '未命名本机会话' }}</strong><small>{{ projectLabel(preview.session) }} · {{ discovery?.machine }}</small></div>
                <code>{{ preview.session.providerSessionId.slice(0, 12) }}</code>
              </section>

              <p v-if="previewError" class="manifest-alert warning"><AlertTriangle :size="14" />{{ previewError }}</p>
              <p v-if="preview.secretFindings.length" class="manifest-alert warning"><ShieldCheck :size="14" />预览发现 {{ preview.secretFindings.length }} 处敏感格式，已在草稿中替换为脱敏标记。</p>

              <section class="manifest-section summary-section">
                <header>
                  <div><span>01 / HANDOFF SUMMARY</span><strong>交接摘要</strong></div>
                  <div class="summary-source">
                    <small>{{ summaryEdited ? 'MANUAL' : preview.summary.source.toUpperCase() }}</small>
                    <button v-if="preview.summaryGeneration.providerInvocationAvailable" ref="providerSummaryButton" type="button" :disabled="providerSummaryBusy || captureBusy" @click="requestProviderSummary"><LoaderCircle v-if="providerSummaryBusy" :size="12" class="spinning" /><Sparkles v-else :size="12" />让 {{ providerLabel(preview.session.provider) }} 自己总结</button>
                  </div>
                </header>
                <label class="manifest-field goal-field"><span>当前目标</span><textarea v-model="summaryDraft.goal" rows="3" maxlength="10000" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                <div class="manifest-field-grid">
                  <label class="manifest-field"><span>已完成 <small>每行一项</small></span><textarea v-model="summaryDraft.completed" rows="5" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                  <label class="manifest-field"><span>下一步 <small>每行一项</small></span><textarea v-model="summaryDraft.nextSteps" rows="5" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                </div>
                <label class="manifest-field"><span>关键决策 <small>每行一项</small></span><textarea v-model="summaryDraft.decisions" rows="3" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                <details class="manifest-advanced">
                  <summary>补充阻塞、命令与风险</summary>
                  <div class="manifest-field-grid triple">
                    <label class="manifest-field"><span>阻塞</span><textarea v-model="summaryDraft.blockers" rows="3" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                    <label class="manifest-field"><span>命令</span><textarea v-model="summaryDraft.commands" rows="3" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                    <label class="manifest-field"><span>风险</span><textarea v-model="summaryDraft.risks" rows="3" :disabled="captureBusy" @input="markSummaryEdited" /></label>
                  </div>
                </details>
                <p v-if="summaryValidation" class="field-error"><AlertTriangle :size="12" />{{ summaryValidation }}</p>
              </section>

              <section class="manifest-section">
                <header><div><span>02 / SOURCE REACHABILITY</span><strong>代码怎么带走</strong></div><small :data-tone="preview.sourceSyncGate?.dirty ? 'warning' : 'ok'">{{ preview.sourceSyncGate?.dirty ? `${preview.workspace?.changedFiles ?? 0} 个改动文件` : '工作区 clean' }}</small></header>
                <p class="section-note">{{ preview.sourceSyncGate?.message }}</p>
                <div class="source-choice-grid">
                  <label v-for="choice in preview.sourceSyncGate?.choices" :key="choice" :class="{ selected: sourceSyncChoice === choice }">
                    <input v-model="sourceSyncChoice" type="radio" name="source-sync-choice" :value="choice" :disabled="captureBusy" />
                    <span><strong>{{ choiceLabel(choice) }}</strong><small>{{ choiceDescription(choice) }}</small></span>
                    <CheckCircle2 v-if="sourceSyncChoice === choice" :size="15" />
                  </label>
                </div>
              </section>

              <section class="manifest-section native-section" :data-enabled="captureNativeCapsule">
                <header>
                  <div><span>03 / NATIVE CAPSULE</span><strong>原生会话胶囊</strong></div>
                  <label class="switch-control"><input v-model="captureNativeCapsule" type="checkbox" aria-label="捕获原生会话胶囊" :disabled="!nativeAvailable || captureBusy" /><span /></label>
                </header>
                <p class="section-note">{{ nativeAvailable ? `可选增强：只捕获一份 ${providerLabel(preview.session.provider)} JSONL；通用交接始终保留。` : preview.providerCapabilities.reason ?? '当前 provider 原生恢复能力未通过探测，自动使用通用交接。' }}</p>
                <label v-if="captureNativeCapsule" class="native-ack" :class="{ checked: acknowledgeNativePlaintext }">
                  <input v-model="acknowledgeNativePlaintext" type="checkbox" :disabled="captureBusy" />
                  <ShieldCheck :size="15" />
                  <span><strong>我确认脱敏后的原生会话会以明文进入私有 Vault</strong><small>不会复制凭据、SQLite、WAL 或 SHM；仍需把 Vault 当作敏感私有数据管理。</small></span>
                </label>
              </section>

              <section v-if="checkpointJob" class="manifest-progress" :data-state="checkpointJob.state">
                <header><div><span>CHECKPOINT JOB</span><strong>{{ checkpointJob.state === 'success' ? '本机 checkpoint 已完成' : checkpointJob.state === 'failed' ? '保存未完成' : '正在执行交接清单' }}</strong></div><LoaderCircle v-if="captureBusy" :size="16" class="spinning" /><CheckCircle2 v-else-if="completion" :size="16" /><AlertTriangle v-else :size="16" /></header>
                <ol>
                  <li v-for="item in currentProgress" :key="`${item.step}:${item.occurredAt}`" :data-state="item.state" :class="{ current: currentStep === item.step }"><span /><div><strong>{{ progressLabel(item.step) }}</strong><small>{{ item.message }}</small></div></li>
                </ol>
              </section>

              <p v-if="captureError" class="manifest-alert error"><AlertTriangle :size="14" />{{ captureError }}</p>
              <p v-if="completion" class="manifest-complete" :data-tone="completion.tone"><CheckCircle2 v-if="completion.tone === 'success'" :size="16" /><CloudOff v-else :size="16" /><span><strong>{{ completion.tone === 'success' ? '交接完成' : '已保存，待同步' }}</strong><small>{{ completion.message }}</small></span><button v-if="completion.tone === 'warning' && remoteSyncEnabled" type="button" class="secondary-button" :disabled="captureBusy" @click="retryPush"><ArrowUpFromLine :size="13" />重试同步</button></p>

              <footer class="manifest-footer">
                <span><ShieldCheck :size="13" />保存前会再次核对工作区指纹并执行最终秘密扫描</span>
                <button v-if="completion" type="button" class="primary-button" @click="requestClose"><CheckCircle2 :size="14" />完成</button>
                <button v-else class="primary-button save-primary" :disabled="!canCapture" type="submit"><LoaderCircle v-if="captureBusy" :size="14" class="spinning" /><Cloud v-else-if="autoPushAvailable" :size="14" /><HardDrive v-else :size="14" />{{ captureBusy ? '正在保存…' : autoPushAvailable ? '确认保存并同步' : '确认保存到本机' }}</button>
              </footer>
            </form>
          </section>
        </div>

        <div v-if="providerConfirmOpen" class="save-confirm-layer" @mousedown.self="closeProviderConfirmation()">
          <section ref="providerConfirmElement" class="save-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="provider-summary-confirm-title" data-focus-layer tabindex="-1">
            <span class="confirm-mark"><Sparkles :size="18" /></span>
            <div><span>PROVIDER INVOCATION / TOKEN USAGE</span><h3 id="provider-summary-confirm-title">让原会话自己生成交接摘要？</h3><p>Fleet 会调用同一个 {{ selectedSession ? providerLabel(selectedSession.provider) : 'provider' }} 会话执行一次无头 fork-resume。该操作会消耗 provider token，但不会调用另一家 provider，也不会覆盖当前草稿。</p><div><button type="button" class="secondary-button" data-dialog-initial @click="closeProviderConfirmation()">取消</button><button type="button" class="primary-button" @click="generateProviderSummary"><Sparkles :size="14" />确认调用</button></div></div>
          </section>
        </div>
      </aside>
    </template>
  </Teleport>
</template>

<style scoped>
.save-backdrop { z-index: 48; background: rgb(5 7 8 / 54%); backdrop-filter: blur(4px); }
.save-drawer { --save-cyan: #52c8de; --save-amber: #e2b85b; --save-red: #ed6675; position: fixed; z-index: 50; top: 0; right: 0; width: min(960px, calc(100vw - 28px)); height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; color: var(--color-text); border-left: 1px solid color-mix(in srgb, var(--save-cyan) 24%, var(--color-border)); background: radial-gradient(circle at 82% -8%, color-mix(in srgb, var(--save-cyan) 7%, transparent), transparent 30%), #181a1c; box-shadow: -34px 0 90px rgb(0 0 0 / 58%); animation: save-drawer-in 180ms ease-out both; }
@keyframes save-drawer-in { from { opacity: .4; transform: translateX(28px); } to { opacity: 1; transform: translateX(0); } }
.save-header { min-height: 106px; padding: 22px 24px 18px; display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--color-border-subtle); background: rgb(25 27 29 / 94%); backdrop-filter: blur(18px); }
.save-header > div { min-width: 0; }
.save-kicker { display: inline-flex; align-items: center; gap: 6px; color: var(--save-cyan); font: 500 10px 'JetBrains Mono', monospace; letter-spacing: .14em; }
.save-header h2 { margin: 7px 0 0; color: var(--color-text-strong); font-size: 27px; letter-spacing: -.035em; }
.save-header p { margin: 5px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.save-stage-strip { min-height: 46px; padding: 0 24px; display: flex; align-items: center; gap: 10px; color: #687077; border-bottom: 1px solid var(--color-border-subtle); background: rgb(8 10 11 / 24%); }
.save-stage-strip span { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; }
.save-stage-strip b { font: 10px 'JetBrains Mono', monospace; }
.save-stage-strip span.active { color: var(--save-cyan); }
.save-stage-strip span.complete { color: var(--color-success); }
.save-stage-strip > svg { color: #4f565c; }
.save-body { min-height: 0; flex: 1; display: grid; grid-template-columns: 310px minmax(0, 1fr); overflow: hidden; }
.save-session-rail { min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--color-border-subtle); background: linear-gradient(180deg, rgb(255 255 255 / 1.5%), transparent 34%), #141618; }
.save-session-rail > header { min-height: 68px; padding: 13px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--color-border-subtle); }
.save-session-rail > header div { display: flex; flex-direction: column; gap: 3px; }
.save-session-rail > header strong { color: var(--color-text-strong); font-size: 13px; }
.save-session-rail > header small { color: var(--color-text-muted); font: 10px 'JetBrains Mono', monospace; }
.rail-refresh { width: 30px; height: 30px; display: grid; place-items: center; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 22%, var(--color-border)); border-radius: 5px; background: color-mix(in srgb, var(--save-cyan) 5%, transparent); cursor: pointer; }
.save-search { height: 35px; margin: 11px 12px 7px; padding: 0 7px 0 10px; display: flex; align-items: center; gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 5px; background: #101214; }
.save-search:focus-within { color: var(--save-cyan); border-color: var(--save-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--save-cyan) 8%, transparent); }
.save-search input { min-width: 0; flex: 1; color: var(--color-text); border: 0; outline: 0; background: transparent; font-size: 11px; }
.save-search button { width: 22px; height: 22px; display: grid; place-items: center; color: var(--color-text-muted); border: 0; background: transparent; cursor: pointer; }
.save-provider-tabs { height: 31px; margin: 0 12px 10px; padding: 3px; display: flex; border: 1px solid var(--color-border-subtle); border-radius: 5px; background: #101214; }
.save-provider-tabs button { min-width: 0; flex: 1; color: var(--color-text-muted); border: 0; border-radius: 3px; background: transparent; cursor: pointer; font-size: 10px; }
.save-provider-tabs button.active { color: var(--color-text-strong); background: var(--color-surface-hover); }
.local-session-list { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; }
.local-session-row { --provider-color: var(--save-cyan); width: 100%; min-height: 108px; padding: 12px; display: grid; grid-template-columns: 54px minmax(0, 1fr) auto; align-items: start; gap: 9px; color: var(--color-text); border: 0; border-bottom: 1px solid var(--color-border-subtle); background: transparent; cursor: pointer; text-align: left; transition: background 140ms ease, box-shadow 140ms ease; }
.local-session-row[data-provider='claude'] { --provider-color: var(--save-amber); }
.local-session-row:hover, .local-session-row.selected { background: color-mix(in srgb, var(--provider-color) 7%, transparent); box-shadow: inset 3px 0 var(--provider-color); }
.local-session-row.blocked { opacity: .62; }
.local-provider { padding-top: 2px; display: flex; align-items: center; flex-direction: column; gap: 5px; color: var(--provider-color); font: 10px 'JetBrains Mono', monospace; }
.local-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.local-copy strong { overflow: hidden; color: var(--color-text-strong); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.local-copy small { display: flex; align-items: center; gap: 4px; overflow: hidden; color: var(--color-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.local-copy em { width: fit-content; margin-top: 2px; padding: 2px 5px; display: inline-flex; align-items: center; gap: 4px; color: var(--save-amber); border: 1px solid color-mix(in srgb, var(--save-amber) 26%, transparent); border-radius: 3px; background: color-mix(in srgb, var(--save-amber) 6%, transparent); font-size: 9px; font-style: normal; }
.local-session-row > svg { margin-top: 4px; color: var(--provider-color); }
.rail-state { min-height: 180px; padding: 20px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--color-text-muted); text-align: center; font-size: 11px; }
.rail-state.error { color: var(--save-red); }
.rail-state button { color: currentColor; border: 0; background: transparent; cursor: pointer; text-decoration: underline; }
.rail-warning { margin: 0; padding: 8px 12px; display: flex; align-items: center; gap: 6px; color: var(--save-amber); border-top: 1px solid var(--color-border-subtle); font-size: 10px; line-height: 1.45; }
.save-review { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; background: radial-gradient(circle at 94% 4%, color-mix(in srgb, var(--save-cyan) 4%, transparent), transparent 28%); }
.review-state { min-height: 100%; padding: 60px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--color-text-muted); text-align: center; }
.review-state strong { color: var(--color-text-strong); font-size: 14px; }
.review-state p { max-width: 430px; margin: 0; font-size: 12px; line-height: 1.65; }
.review-state.error > svg { color: var(--save-red); }
.review-orbit { width: 54px; height: 54px; display: grid; place-items: center; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 28%, transparent); border-radius: 50%; background: color-mix(in srgb, var(--save-cyan) 5%, transparent); box-shadow: 0 0 42px color-mix(in srgb, var(--save-cyan) 8%, transparent); }
.save-manifest { padding: 20px 22px 24px; }
.manifest-identity { min-height: 66px; padding: 11px 13px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; border: 1px solid var(--color-border); border-radius: 7px; background: linear-gradient(100deg, color-mix(in srgb, var(--save-cyan) 5%, transparent), rgb(0 0 0 / 11%)); }
.identity-provider { min-height: 31px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 25%, transparent); border-radius: 4px; font: 10px 'JetBrains Mono', monospace; text-transform: uppercase; }
.manifest-identity > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.manifest-identity strong { overflow: hidden; color: var(--color-text-strong); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.manifest-identity small { color: var(--color-text-muted); font-size: 10px; }
.manifest-identity code { color: #828b91; font: 10px 'JetBrains Mono', monospace; }
.manifest-section { margin-top: 13px; padding: 15px; border: 1px solid var(--color-border); border-radius: 7px; background: rgb(9 11 12 / 27%); }
.manifest-section > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.manifest-section > header > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.manifest-section > header span { color: var(--save-cyan); font: 9px 'JetBrains Mono', monospace; letter-spacing: .12em; }
.manifest-section > header strong { color: var(--color-text-strong); font-size: 13px; }
.manifest-section > header > small { color: var(--color-success); font-size: 10px; }
.manifest-section > header > small[data-tone='warning'] { color: var(--save-amber); }
.summary-source { display: flex; align-items: center; gap: 7px; }
.summary-source small { padding: 3px 6px; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 22%, transparent); border-radius: 3px; font: 9px 'JetBrains Mono', monospace; }
.summary-source button { min-height: 28px; padding: 0 8px; display: inline-flex; align-items: center; gap: 5px; color: var(--save-amber); border: 1px solid color-mix(in srgb, var(--save-amber) 28%, var(--color-border)); border-radius: 4px; background: color-mix(in srgb, var(--save-amber) 6%, transparent); cursor: pointer; font-size: 10px; }
.manifest-field { margin-top: 11px; display: flex; flex-direction: column; gap: 5px; }
.manifest-field > span { display: flex; align-items: center; justify-content: space-between; color: var(--color-text-muted); font-size: 11px; }
.manifest-field > span small { color: #697177; font-size: 9px; }
.manifest-field textarea { width: 100%; padding: 9px 10px; resize: vertical; color: var(--color-text); border: 1px solid var(--color-border-subtle); border-radius: 5px; outline: 0; background: #101214; font: 11px/1.55 'JetBrains Mono', monospace; }
.manifest-field textarea:focus { border-color: var(--save-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--save-cyan) 7%, transparent); }
.goal-field textarea { font-family: inherit; font-size: 12px; }
.manifest-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.manifest-field-grid.triple { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.manifest-advanced { margin-top: 11px; border-top: 1px solid var(--color-border-subtle); }
.manifest-advanced summary { padding-top: 10px; color: var(--color-text-muted); cursor: pointer; font-size: 11px; }
.field-error { margin: 9px 0 0; display: flex; align-items: center; gap: 5px; color: var(--save-red); font-size: 10px; }
.section-note { margin: 9px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.55; }
.source-choice-grid { margin-top: 11px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.source-choice-grid label { min-width: 0; min-height: 82px; padding: 10px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(255 255 255 / 1.2%); cursor: pointer; }
.source-choice-grid label.selected { color: var(--save-cyan); border-color: color-mix(in srgb, var(--save-cyan) 45%, var(--color-border)); background: color-mix(in srgb, var(--save-cyan) 7%, transparent); box-shadow: inset 0 0 22px color-mix(in srgb, var(--save-cyan) 4%, transparent); }
.source-choice-grid input { position: absolute; opacity: 0; pointer-events: none; }
.source-choice-grid span { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.source-choice-grid strong { color: var(--color-text-strong); font-size: 11px; }
.source-choice-grid small { color: var(--color-text-muted); font-size: 10px; line-height: 1.5; }
.switch-control { position: relative; width: 38px; height: 22px; }
.switch-control input { position: absolute; z-index: 1; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.switch-control input:disabled { cursor: not-allowed; }
.switch-control span { position: absolute; inset: 0; border: 1px solid var(--color-border); border-radius: 12px; background: #101214; pointer-events: none; }
.switch-control span::after { position: absolute; width: 16px; height: 16px; top: 2px; left: 2px; border-radius: 50%; background: #717980; content: ''; transition: transform 140ms ease, background 140ms ease; }
.switch-control input:checked + span { border-color: color-mix(in srgb, var(--save-cyan) 44%, var(--color-border)); background: color-mix(in srgb, var(--save-cyan) 13%, #101214); }
.switch-control input:checked + span::after { background: var(--save-cyan); transform: translateX(16px); }
.switch-control input:focus-visible + span { outline: 2px solid var(--save-cyan); outline-offset: 3px; }
.native-section[data-enabled='true'] { border-color: color-mix(in srgb, var(--save-cyan) 30%, var(--color-border)); }
.native-ack { margin-top: 11px; padding: 10px; display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 9px; color: var(--save-amber); border: 1px solid color-mix(in srgb, var(--save-amber) 28%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--save-amber) 5%, transparent); cursor: pointer; }
.native-ack.checked { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 30%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 5%, transparent); }
.native-ack span { display: flex; flex-direction: column; gap: 3px; }
.native-ack strong { color: var(--color-text-strong); font-size: 11px; }
.native-ack small { color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.manifest-alert { margin: 11px 0 0; padding: 8px 10px; display: flex; align-items: flex-start; gap: 7px; border: 1px solid color-mix(in srgb, currentColor 28%, var(--color-border)); border-radius: 5px; background: color-mix(in srgb, currentColor 5%, transparent); font-size: 10px; line-height: 1.5; }
.manifest-alert.warning { color: var(--save-amber); }
.manifest-alert.error { color: var(--save-red); }
.manifest-progress { margin-top: 13px; padding: 14px; color: var(--save-cyan); border: 1px solid color-mix(in srgb, currentColor 30%, var(--color-border)); border-radius: 7px; background: color-mix(in srgb, currentColor 4%, rgb(9 11 12 / 35%)); }
.manifest-progress[data-state='failed'] { color: var(--save-red); }
.manifest-progress[data-state='success'] { color: var(--color-success); }
.manifest-progress > header { display: flex; align-items: center; justify-content: space-between; }
.manifest-progress > header div { display: flex; flex-direction: column; gap: 3px; }
.manifest-progress > header span { font: 9px 'JetBrains Mono', monospace; letter-spacing: .12em; }
.manifest-progress > header strong { color: var(--color-text-strong); font-size: 12px; }
.manifest-progress ol { margin: 12px 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; list-style: none; }
.manifest-progress li { min-width: 0; padding: 7px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 4px; background: rgb(0 0 0 / 12%); }
.manifest-progress li > span { width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: currentColor; }
.manifest-progress li[data-state='completed'] { color: var(--color-success); }
.manifest-progress li[data-state='failed'] { color: var(--save-red); }
.manifest-progress li.current { border-color: color-mix(in srgb, currentColor 38%, var(--color-border)); }
.manifest-progress li div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.manifest-progress li strong { color: currentColor; font-size: 10px; }
.manifest-progress li small { overflow: hidden; color: var(--color-text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.manifest-complete { margin: 13px 0 0; padding: 10px 11px; display: flex; align-items: center; gap: 9px; color: var(--color-success); border: 1px solid color-mix(in srgb, currentColor 30%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); }
.manifest-complete[data-tone='warning'] { color: var(--save-amber); }
.manifest-complete > span { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 3px; }
.manifest-complete strong { color: currentColor; font-size: 11px; }
.manifest-complete small { color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }
.manifest-complete .secondary-button { min-height: 31px; font-size: 10px; }
.manifest-footer { position: sticky; z-index: 2; bottom: 0; margin: 15px -22px 0; padding: 13px 22px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--color-border-subtle); background: rgb(24 26 28 / 96%); backdrop-filter: blur(17px); }
.manifest-footer > span { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 10px; }
.manifest-footer .primary-button { min-width: 168px; }
.save-primary { color: #102126; border-color: color-mix(in srgb, var(--save-cyan) 82%, white); background: var(--save-cyan); }
.save-confirm-layer { position: absolute; z-index: 5; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(4 6 7 / 68%); backdrop-filter: blur(6px); }
.save-confirm-card { width: min(520px, 100%); padding: 20px; display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 13px; border: 1px solid color-mix(in srgb, var(--save-amber) 38%, var(--color-border)); border-radius: 9px; background: radial-gradient(circle at 100% 0, color-mix(in srgb, var(--save-amber) 9%, transparent), transparent 35%), #1b1d1f; box-shadow: 0 28px 90px rgb(0 0 0 / 62%); }
.confirm-mark { width: 42px; height: 42px; display: grid; place-items: center; color: var(--save-amber); border: 1px solid color-mix(in srgb, var(--save-amber) 32%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--save-amber) 7%, transparent); }
.save-confirm-card > div > span { color: var(--save-amber); font: 9px 'JetBrains Mono', monospace; letter-spacing: .12em; }
.save-confirm-card h3 { margin: 7px 0 0; color: var(--color-text-strong); font-size: 17px; }
.save-confirm-card p { margin: 8px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.65; }
.save-confirm-card > div > div { margin-top: 15px; display: flex; justify-content: flex-end; gap: 7px; }
button:disabled, input:disabled, textarea:disabled { opacity: .48; cursor: not-allowed; }
@media (max-width: 1120px) {
  .save-body { grid-template-columns: 270px minmax(0, 1fr); }
  .source-choice-grid { grid-template-columns: 1fr; }
  .manifest-field-grid.triple { grid-template-columns: 1fr; }
}
</style>
