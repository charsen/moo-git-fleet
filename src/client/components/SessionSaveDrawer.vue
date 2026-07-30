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
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  CheckpointDiscoveryPayload,
  CheckpointPreview,
  DiscoveredSession,
  SessionBackupJob,
  SessionProvider,
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

const discovery = ref<CheckpointDiscoveryPayload | null>(null);
const discoveryLoading = ref(false);
const discoveryError = ref('');
const searchDraft = ref('');
const providerFilter = ref<SessionProvider | null>(null);
const sessionPickerOpen = ref(false);
const selectedKey = ref<string | null>(null);
const preview = ref<CheckpointPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref('');
const previewRequest = ref(0);
const captureBusy = ref(false);
const captureError = ref('');
const backupJob = ref<SessionBackupJob | null>(null);
const completion = ref<{ tone: 'success' | 'warning'; message: string } | null>(null);
const drawerElement = ref<HTMLElement | null>(null);
let backupPollTimer: number | null = null;
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

const recommendedSessionKey = computed(() => {
  const recommended = discovery.value?.sessions.find((session) => session.readable);
  return recommended ? sessionKey(recommended) : null;
});

const readableSessionCount = computed(() => (
  discovery.value?.sessions.filter((session) => session.readable).length ?? 0
));

const nativeAvailable = computed(() => Boolean(
  preview.value?.providerCapabilities.state === 'supported' &&
  preview.value.providerCapabilities.nativeResume,
));

const canCapture = computed(() => Boolean(
  readableSessionCount.value > 0 &&
  !captureBusy.value,
));

const processedSessionCount = computed(() => {
  const job = backupJob.value;
  return job ? job.backedUp + job.unchanged + job.skipped + job.failed : 0;
});
const summaryNextSteps = computed(() => preview.value?.summary.nextSteps ?? []);
const saveActionLabel = computed(() => {
  if (props.autoPushAvailable) return '备份全部并同步';
  if (props.remoteSyncEnabled) return '备份全部到本机';
  return '备份全部';
});

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
      closeBackupPoll();
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

function projectLabel(session: DiscoveredSession): string {
  if (session.repositoryName) return session.repositoryName;
  if (session.projectPath) return session.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? session.projectId;
  return '未关联项目';
}

function applyPreview(nextPreview: CheckpointPreview): void {
  preview.value = nextPreview;
}

function resetWorkflow(): void {
  previewRequest.value += 1;
  discovery.value = null;
  discoveryLoading.value = false;
  discoveryError.value = '';
  searchDraft.value = '';
  providerFilter.value = null;
  sessionPickerOpen.value = false;
  selectedKey.value = null;
  preview.value = null;
  previewLoading.value = false;
  previewError.value = '';
  captureBusy.value = false;
  captureError.value = '';
  backupJob.value = null;
  completion.value = null;
  finalizedOperationId = null;
  closeBackupPoll();
}

async function loadDiscovery(): Promise<void> {
  if (discoveryLoading.value) return;
  discoveryLoading.value = true;
  discoveryError.value = '';
  try {
    const result = await api.sessionDiscovery();
    discovery.value = result;
    const current = result.sessions.find((session) => (
      selectedKey.value === sessionKey(session) && session.readable
    ));
    const recommended = current ?? result.sessions.find((session) => session.readable);
    if (recommended) {
      await selectSession(recommended);
    } else {
      selectedKey.value = null;
      preview.value = null;
      sessionPickerOpen.value = true;
    }
  } catch (error) {
    discoveryError.value = error instanceof Error ? error.message : '本机会话扫描失败';
  } finally {
    discoveryLoading.value = false;
  }
}

async function selectSession(session: DiscoveredSession): Promise<void> {
  if (!session.readable || previewLoading.value || captureBusy.value) return;
  const key = sessionKey(session);
  const requestId = ++previewRequest.value;
  selectedKey.value = key;
  preview.value = null;
  previewError.value = '';
  captureError.value = '';
  completion.value = null;
  sessionPickerOpen.value = false;
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

function closeBackupPoll(): void {
  if (backupPollTimer !== null) window.clearTimeout(backupPollTimer);
  backupPollTimer = null;
}

function pollBackupJob(operationId: string): void {
  closeBackupPoll();
  const poll = async () => {
    try {
      const current = await api.sessionBackupJob(operationId);
      backupJob.value = current;
      if (current.state === 'success' || current.state === 'failed') {
        await finalizeBackup(current);
        return;
      }
    } catch (error) {
      captureError.value = error instanceof Error ? error.message : '暂时无法读取备份进度，正在重试';
    }
    backupPollTimer = window.setTimeout(() => void poll(), 600);
  };
  void poll();
}

async function startCapture(): Promise<void> {
  if (!canCapture.value) return;
  captureBusy.value = true;
  captureError.value = '';
  completion.value = null;
  backupJob.value = null;
  finalizedOperationId = null;
  try {
    const started = await api.startSessionBackupAll();
    backupJob.value = started;
    pollBackupJob(started.operationId);
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '会话备份未能启动';
    captureBusy.value = false;
  }
}

async function finalizeBackup(job: SessionBackupJob): Promise<void> {
  if (finalizedOperationId === job.operationId) return;
  finalizedOperationId = job.operationId;
  closeBackupPoll();
  if (job.state === 'failed') {
    captureError.value = job.error?.message ?? '批量备份失败，请重试';
    captureBusy.value = false;
    finalizedOperationId = null;
    return;
  }
  const counts = `${job.backedUp} 条已更新，${job.unchanged} 条无需更新`;
  const incomplete = job.skipped + job.failed;
  let result: { tone: 'success' | 'warning'; message: string };
  if (props.autoPushAvailable) {
    try {
      const synced = await api.pushSessionVault();
      result = {
        tone: incomplete > 0 ? 'warning' : 'success',
        message: `${counts}${incomplete > 0 ? `，${incomplete} 条需要查看` : ''} · ${synced.message}`,
      };
    } catch (error) {
      result = {
        tone: 'warning',
        message: `${counts}，已保存在本机；同步失败：${error instanceof Error ? error.message : '请稍后重试'}`,
      };
    }
  } else if (props.remoteSyncEnabled) {
    result = { tone: 'warning', message: `${counts}，已保存在本机；同步状态需要先处理` };
  } else {
    result = {
      tone: incomplete > 0 ? 'warning' : 'success',
      message: `${counts}${incomplete > 0 ? `，${incomplete} 条需要查看` : ''}`,
    };
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
  emit('close');
}

function handleEscape(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  requestClose();
}

onMounted(() => window.addEventListener('keydown', handleEscape));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  closeBackupPoll();
  emit('busy', false);
});
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <button class="drawer-backdrop relay-detail-backdrop save-backdrop" :aria-label="`关闭${saveActionLabel}`" @click="requestClose" />
      <aside ref="drawerElement" class="save-drawer" role="dialog" aria-modal="true" aria-labelledby="save-drawer-title" :aria-busy="captureBusy" data-focus-layer tabindex="-1">
        <header class="save-header">
          <div>
            <h2 id="save-drawer-title">备份全部会话</h2>
            <p>自动检查本机 Claude 和 Codex，只备份新增或有变化的完整会话。</p>
          </div>
          <button class="icon-button" data-dialog-initial :aria-label="`关闭${saveActionLabel}`" :disabled="captureBusy" @click="requestClose"><X :size="18" /></button>
        </header>

        <div class="save-body">
          <section v-if="sessionPickerOpen" class="save-session-picker" aria-label="查看本机会话">
            <header>
              <div>
                <strong>本机会话</strong>
                <small>{{ discovery?.sessions.length ?? 0 }} 条 · 已按最近使用排序</small>
              </div>
              <div class="save-picker-actions">
                <button class="rail-refresh" :disabled="discoveryLoading || captureBusy" aria-label="重新扫描本机会话" @click="loadDiscovery"><RefreshCw :size="14" :class="{ spinning: discoveryLoading }" /></button>
                <button v-if="selectedSession" class="rail-refresh" :disabled="captureBusy" aria-label="收起会话列表" @click="sessionPickerOpen = false"><X :size="14" /></button>
              </div>
            </header>
            <label class="save-search">
              <Code2 :size="13" />
              <input v-model="searchDraft" placeholder="标题 / 项目" aria-label="搜索本机会话" />
              <button v-if="searchDraft" aria-label="清除搜索" @click="searchDraft = ''"><X :size="12" /></button>
            </label>
            <div class="save-provider-tabs" role="group" aria-label="按 AI 类型筛选">
              <button :class="{ active: providerFilter === null }" @click="providerFilter = null">全部</button>
              <button :class="{ active: providerFilter === 'claude' }" @click="providerFilter = 'claude'">Claude</button>
              <button :class="{ active: providerFilter === 'codex' }" @click="providerFilter = 'codex'">Codex</button>
            </div>

            <div v-if="discoveryLoading" class="rail-state"><LoaderCircle :size="18" class="spinning" /><span>正在查找本机会话…</span></div>
            <div v-else-if="discoveryError" class="rail-state error"><AlertTriangle :size="18" /><span>{{ discoveryError }}</span><button @click="loadDiscovery">重试</button></div>
            <div v-else-if="filteredSessions.length === 0" class="rail-state"><Bot :size="18" /><span>没有匹配的本机会话</span></div>
            <div v-else class="local-session-list">
              <button
                v-for="session in filteredSessions"
                :key="sessionKey(session)"
                class="local-session-row"
                :class="{ selected: selectedKey === sessionKey(session), blocked: !session.readable }"
                :data-provider="session.provider"
                :disabled="captureBusy"
                @click="selectSession(session)"
              >
                <span class="local-provider"><Bot :size="14" />{{ providerLabel(session.provider) }}</span>
                <span class="local-copy">
                  <strong>{{ session.title || '未命名本机会话' }}</strong>
                  <small><Code2 :size="10" />{{ projectLabel(session) }}</small>
                  <small><CircleDashed :size="10" />{{ relativeTime(session.lastActivityAt ?? session.createdAt) }}</small>
                  <em v-if="sessionKey(session) === recommendedSessionKey && session.readable" class="recommended"><CheckCircle2 :size="10" />最近使用</em>
                  <em v-if="!session.readable"><AlertTriangle :size="10" />会话不可读</em>
                  <em v-else-if="session.tailTruncated"><CircleDashed :size="10" />会话仍在更新</em>
                </span>
                <ChevronRight :size="14" />
              </button>
            </div>
            <p v-if="discovery?.errors.length" class="rail-warning"><AlertTriangle :size="12" />{{ discovery.errors.length }} 条记录读取异常，其他会话仍可备份。</p>
          </section>

          <section class="save-review">
            <div v-if="discoveryLoading && !selectedSession" class="review-state"><LoaderCircle :size="22" class="spinning" /><strong>正在扫描本机会话</strong><p>系统会查找全部 Claude 和 Codex 会话。</p></div>
            <div v-else-if="discoveryError && !selectedSession" class="review-state error"><AlertTriangle :size="22" /><strong>本机会话扫描失败</strong><p>{{ discoveryError }}</p><button class="secondary-button" @click="loadDiscovery"><RefreshCw :size="14" />重试</button></div>
            <div v-else-if="!selectedSession" class="review-state">
              <span class="review-orbit"><HardDrive :size="23" /></span>
              <strong>没有可备份的会话</strong>
              <p>没有找到可以读取的 Claude 或 Codex 会话。</p>
              <button class="secondary-button" @click="sessionPickerOpen = true">查看本机会话</button>
            </div>
            <div v-else-if="previewLoading" class="review-state"><LoaderCircle :size="22" class="spinning" /><strong>正在读取会话内容</strong><p>准备完整备份和简要预览…</p></div>
            <div v-else-if="previewError && !preview" class="review-state error"><AlertTriangle :size="22" /><strong>预览失败</strong><p>{{ previewError }}</p><button class="secondary-button" @click="selectSession(selectedSession)"><RefreshCw :size="14" />重新预览</button></div>
            <form v-else-if="preview" class="save-manifest" @submit.prevent="startCapture">
              <p class="backup-all-summary"><Cloud :size="15" /><span><strong>将检查 {{ readableSessionCount }} 条本机会话</strong><small>内容相同会自动跳过，不需要逐条选择。</small></span></p>
              <section class="manifest-identity">
                <span class="identity-provider"><Bot :size="15" />{{ providerLabel(preview.session.provider) }}</span>
                <div><strong>{{ preview.session.title || '未命名本机会话' }}</strong><small>{{ projectLabel(preview.session) }} · {{ relativeTime(preview.session.lastActivityAt ?? preview.session.createdAt) }}</small></div>
                <span class="identity-actions"><small>当前预览</small><button type="button" :disabled="captureBusy" @click="sessionPickerOpen = !sessionPickerOpen">查看其他</button></span>
              </section>

              <p v-if="previewError" class="manifest-alert warning"><AlertTriangle :size="14" />{{ previewError }}</p>
              <p v-if="preview.secretFindings.length" class="manifest-alert warning"><ShieldCheck :size="14" />发现 {{ preview.secretFindings.length }} 处敏感格式，备份时会自动过滤。</p>

              <section class="manifest-section backup-preview-section" :data-full="nativeAvailable">
                <header>
                  <div><span>备份内容</span><strong>{{ nativeAvailable ? '完整会话' : '会话摘要' }}</strong></div>
                  <small :data-tone="nativeAvailable ? 'ready' : 'warning'">{{ nativeAvailable ? '可直接恢复' : '兼容模式' }}</small>
                </header>
                <div class="backup-content-note">
                  <HardDrive :size="18" />
                  <div>
                    <strong>{{ nativeAvailable ? `可备份完整 ${providerLabel(preview.session.provider)} 会话记录` : '这条会话暂时不能完整备份' }}</strong>
                    <p>{{ nativeAvailable ? '登录凭据、缓存、SQLite 和运行锁不会进入 Git。' : (preview.providerCapabilities.reason ?? '系统会跳过这条会话，并在备份结果中说明原因。') }}</p>
                  </div>
                </div>
                <section class="session-message-preview" aria-label="最近会话内容预览">
                  <header><strong>最近对话</strong><small>{{ preview.contentPreview.totalMessages }} 条可预览消息</small></header>
                  <div v-if="preview.contentPreview.items.length" class="session-message-list">
                    <article v-for="(item, index) in preview.contentPreview.items" :key="`${index}-${item.occurredAt ?? ''}`" :data-role="item.role">
                      <span>{{ item.role === 'user' ? '你' : 'AI' }}</span>
                      <p>{{ item.text }}</p>
                    </article>
                  </div>
                  <p v-else class="session-message-empty">当前会话没有可安全展示的用户或 AI 文本。</p>
                  <footer v-if="preview.contentPreview.truncated">仅展示最近内容，完整会话仍会进入备份。</footer>
                </section>
                <div class="summary-review">
                  <div><span>当前内容</span><p>{{ preview.summary.goal || '尚未识别到明确目标' }}</p></div>
                  <div><span>接下来</span><ol v-if="summaryNextSteps.length"><li v-for="(step, index) in summaryNextSteps" :key="`${index}-${step}`">{{ step }}</li></ol><p v-else>暂无明确下一步。</p></div>
                </div>
                <p class="session-only-note"><ShieldCheck :size="13" />这里只备份 AI 会话；项目代码继续使用项目自己的 Git。</p>
              </section>

              <section v-if="backupJob" class="manifest-progress" :data-state="backupJob.state">
                <header><div><span>备份进度</span><strong>{{ backupJob.state === 'success' ? '检查完成' : backupJob.state === 'failed' ? '备份未完成' : `正在处理 ${processedSessionCount} / ${backupJob.total}` }}</strong></div><LoaderCircle v-if="captureBusy" :size="16" class="spinning" /><CheckCircle2 v-else-if="completion" :size="16" /><AlertTriangle v-else :size="16" /></header>
                <details class="manifest-progress-details">
                  <summary>查看每条会话结果 <ChevronRight :size="13" /></summary>
                  <ol>
                    <li v-for="item in backupJob.items" :key="`${item.provider}:${item.providerSessionId}`" :data-state="item.state" :class="{ current: item.state === 'running' }"><span /><div><strong>{{ item.title || '未命名会话' }}</strong><small>{{ providerLabel(item.provider) }} · {{ item.message }}</small></div></li>
                  </ol>
                </details>
              </section>

              <p v-if="captureError" class="manifest-alert error"><AlertTriangle :size="14" />{{ captureError }}</p>
              <p v-if="completion" class="manifest-complete" :data-tone="completion.tone"><CheckCircle2 v-if="completion.tone === 'success'" :size="16" /><CloudOff v-else :size="16" /><span><strong>{{ completion.tone === 'success' ? '备份完成' : '已备份，待同步' }}</strong><small>{{ completion.message }}</small></span><button v-if="completion.tone === 'warning' && remoteSyncEnabled" type="button" class="secondary-button" :disabled="captureBusy" @click="retryPush"><ArrowUpFromLine :size="13" />重试同步</button></p>

              <footer class="manifest-footer">
                <span><ShieldCheck :size="13" />不会备份登录凭据、缓存和机器级配置</span>
                <button v-if="completion" type="button" class="primary-button" @click="requestClose"><CheckCircle2 :size="14" />完成</button>
                <button v-else class="primary-button save-primary" :disabled="!canCapture" type="submit"><LoaderCircle v-if="captureBusy" :size="14" class="spinning" /><Cloud v-else-if="autoPushAvailable" :size="14" /><HardDrive v-else :size="14" />{{ captureBusy ? `正在处理 ${processedSessionCount}/${backupJob?.total ?? readableSessionCount}` : saveActionLabel }}</button>
              </footer>
            </form>
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
.save-header { min-height: 88px; padding: 18px 24px; display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--color-border-subtle); background: rgb(25 27 29 / 94%); backdrop-filter: blur(18px); }
.save-header > div { min-width: 0; }
.save-header h2 { margin: 0; color: var(--color-text-strong); font-size: 27px; letter-spacing: -.035em; }
.save-header p { margin: 5px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.save-body { min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.save-session-picker { max-height: min(390px, 46dvh); flex: none; display: flex; flex-direction: column; overflow: hidden; border-bottom: 1px solid color-mix(in srgb, var(--save-cyan) 23%, var(--color-border)); background: linear-gradient(180deg, color-mix(in srgb, var(--save-cyan) 3%, transparent), transparent 46%), #141618; box-shadow: 0 16px 34px rgb(0 0 0 / 22%); }
.save-session-picker > header { min-height: 58px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--color-border-subtle); }
.save-session-picker > header > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.save-session-picker > header strong { color: var(--color-text-strong); font-size: 13px; }
.save-session-picker > header small { color: var(--color-text-muted); font: 10px 'JetBrains Mono', monospace; }
.save-picker-actions { display: flex; gap: 6px; }
.rail-refresh { width: 30px; height: 30px; display: grid; place-items: center; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 22%, var(--color-border)); border-radius: 5px; background: color-mix(in srgb, var(--save-cyan) 5%, transparent); cursor: pointer; }
.save-search { height: 35px; margin: 11px 12px 7px; padding: 0 7px 0 10px; display: flex; align-items: center; gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 5px; background: #101214; }
.save-search:focus-within { color: var(--save-cyan); border-color: var(--save-cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--save-cyan) 8%, transparent); }
.save-search input { min-width: 0; flex: 1; color: var(--color-text); border: 0; outline: 0; background: transparent; font-size: 11px; }
.save-search button { width: 22px; height: 22px; display: grid; place-items: center; color: var(--color-text-muted); border: 0; background: transparent; cursor: pointer; }
.save-provider-tabs { height: 31px; margin: 0 12px 10px; padding: 3px; display: flex; border: 1px solid var(--color-border-subtle); border-radius: 5px; background: #101214; }
.save-provider-tabs button { min-width: 0; flex: 1; color: var(--color-text-muted); border: 0; border-radius: 3px; background: transparent; cursor: pointer; font-size: 10px; }
.save-provider-tabs button.active { color: var(--color-text-strong); background: var(--color-surface-hover); }
.local-session-list { min-height: 0; flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow-y: auto; overscroll-behavior: contain; }
.local-session-row { --provider-color: var(--save-cyan); width: 100%; min-height: 104px; padding: 11px 12px; display: grid; grid-template-columns: 54px minmax(0, 1fr) auto; align-items: start; gap: 9px; color: var(--color-text); border: 0; border-right: 1px solid var(--color-border-subtle); border-bottom: 1px solid var(--color-border-subtle); background: transparent; cursor: pointer; text-align: left; transition: background 140ms ease, box-shadow 140ms ease; }
.local-session-row[data-provider='claude'] { --provider-color: var(--save-amber); }
.local-session-row:hover, .local-session-row.selected { background: color-mix(in srgb, var(--provider-color) 7%, transparent); box-shadow: inset 3px 0 var(--provider-color); }
.local-session-row.blocked { opacity: .62; }
.local-provider { padding-top: 2px; display: flex; align-items: center; flex-direction: column; gap: 5px; color: var(--provider-color); font: 10px 'JetBrains Mono', monospace; }
.local-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.local-copy strong { overflow: hidden; color: var(--color-text-strong); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.local-copy small { display: flex; align-items: center; gap: 4px; overflow: hidden; color: var(--color-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.local-copy em { width: fit-content; margin-top: 2px; padding: 2px 5px; display: inline-flex; align-items: center; gap: 4px; color: var(--save-amber); border: 1px solid color-mix(in srgb, var(--save-amber) 26%, transparent); border-radius: 3px; background: color-mix(in srgb, var(--save-amber) 6%, transparent); font-size: 9px; font-style: normal; }
.local-copy em.recommended { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 28%, transparent); background: color-mix(in srgb, var(--color-success) 6%, transparent); }
.local-session-row > svg { margin-top: 4px; color: var(--provider-color); }
.rail-state { min-height: 140px; padding: 20px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--color-text-muted); text-align: center; font-size: 11px; }
.rail-state.error { color: var(--save-red); }
.rail-state button { color: currentColor; border: 0; background: transparent; cursor: pointer; text-decoration: underline; }
.rail-warning { margin: 0; padding: 8px 12px; display: flex; align-items: center; gap: 6px; color: var(--save-amber); border-top: 1px solid var(--color-border-subtle); font-size: 10px; line-height: 1.45; }
.save-review { min-width: 0; min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; background: radial-gradient(circle at 94% 4%, color-mix(in srgb, var(--save-cyan) 4%, transparent), transparent 28%); }
.review-state { min-height: 100%; padding: 60px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--color-text-muted); text-align: center; }
.review-state strong { color: var(--color-text-strong); font-size: 14px; }
.review-state p { max-width: 430px; margin: 0; font-size: 12px; line-height: 1.65; }
.review-state.error > svg { color: var(--save-red); }
.review-orbit { width: 54px; height: 54px; display: grid; place-items: center; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 28%, transparent); border-radius: 50%; background: color-mix(in srgb, var(--save-cyan) 5%, transparent); box-shadow: 0 0 42px color-mix(in srgb, var(--save-cyan) 8%, transparent); }
.save-manifest { width: min(760px, 100%); margin: 0 auto; padding: 22px 26px 26px; }
.backup-all-summary { margin: 0 0 11px; padding: 10px 12px; display: flex; align-items: center; gap: 9px; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 25%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, var(--save-cyan) 5%, transparent); }
.backup-all-summary > span { display: flex; flex-direction: column; gap: 3px; }
.backup-all-summary strong { color: var(--color-text-strong); font-size: 11px; }
.backup-all-summary small { color: var(--color-text-muted); font-size: 10px; }
.manifest-identity { min-height: 66px; padding: 11px 13px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; border: 1px solid var(--color-border); border-radius: 7px; background: linear-gradient(100deg, color-mix(in srgb, var(--save-cyan) 5%, transparent), rgb(0 0 0 / 11%)); }
.identity-provider { min-height: 31px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px; color: var(--save-cyan); border: 1px solid color-mix(in srgb, var(--save-cyan) 25%, transparent); border-radius: 4px; font: 10px 'JetBrains Mono', monospace; text-transform: uppercase; }
.manifest-identity > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.manifest-identity strong { overflow: hidden; color: var(--color-text-strong); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.manifest-identity small { color: var(--color-text-muted); font-size: 10px; }
.identity-actions { display: flex; align-items: flex-end; flex-direction: column; gap: 5px; }
.identity-actions small { color: var(--color-success); font-size: 9px; }
.identity-actions button { padding: 0; color: var(--save-cyan); border: 0; background: transparent; cursor: pointer; font-size: 10px; }
.identity-actions button:hover:not(:disabled) { text-decoration: underline; }
.manifest-section { margin-top: 13px; padding: 15px; border: 1px solid var(--color-border); border-radius: 7px; background: rgb(9 11 12 / 27%); }
.manifest-section > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.manifest-section > header > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.manifest-section > header span { color: var(--save-cyan); font: 9px 'JetBrains Mono', monospace; letter-spacing: .12em; }
.manifest-section > header strong { color: var(--color-text-strong); font-size: 13px; }
.manifest-section > header > small { color: var(--color-success); font-size: 10px; }
.manifest-section > header > small[data-tone='warning'] { color: var(--save-amber); }
.backup-preview-section[data-full='true'] { border-color: color-mix(in srgb, var(--color-success) 28%, var(--color-border)); }
.backup-content-note { margin-top: 12px; padding: 11px 12px; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; color: var(--save-cyan); border: 1px solid color-mix(in srgb, currentColor 22%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, currentColor 4%, transparent); }
.backup-preview-section[data-full='true'] .backup-content-note { color: var(--color-success); }
.backup-content-note > svg { margin-top: 1px; }
.backup-content-note > div { min-width: 0; }
.backup-content-note strong { color: var(--color-text-strong); font-size: 12px; }
.backup-content-note p { margin: 4px 0 0; color: var(--color-text-muted); font-size: 10px; line-height: 1.55; }
.session-message-preview { margin-top: 11px; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 12%); }
.session-message-preview > header { min-height: 38px; padding: 0 11px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--color-border-subtle); }
.session-message-preview > header strong { color: var(--color-text-strong); font-size: 11px; }
.session-message-preview > header small { color: var(--color-text-muted); font-size: 9px; }
.session-message-list { max-height: 290px; overflow-y: auto; overscroll-behavior: contain; }
.session-message-list article { padding: 10px 11px; display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: start; gap: 9px; border-bottom: 1px solid var(--color-border-subtle); }
.session-message-list article:last-child { border-bottom: 0; }
.session-message-list article > span { min-height: 21px; display: inline-flex; align-items: center; justify-content: center; color: var(--save-cyan); border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: 4px; background: color-mix(in srgb, currentColor 6%, transparent); font-size: 9px; }
.session-message-list article[data-role='assistant'] > span { color: var(--color-success); }
.session-message-list article p { margin: 0; display: -webkit-box; overflow: hidden; color: var(--color-text); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.session-message-empty { margin: 0; padding: 18px 12px; color: var(--color-text-muted); font-size: 10px; text-align: center; }
.session-message-preview > footer { padding: 7px 11px; color: var(--color-text-muted); border-top: 1px solid var(--color-border-subtle); font-size: 9px; }
.summary-review { margin-top: 11px; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 6px; background: rgb(0 0 0 / 12%); }
.summary-review > div { min-height: 58px; padding: 11px 12px; display: grid; grid-template-columns: 82px minmax(0, 1fr); align-items: start; gap: 12px; border-bottom: 1px solid var(--color-border-subtle); }
.summary-review > div:last-child { border-bottom: 0; }
.summary-review > div > span { padding-top: 2px; color: var(--save-cyan); font: 9px 'JetBrains Mono', monospace; letter-spacing: .07em; }
.summary-review > div:last-child > span { color: var(--color-success); }
.summary-review p { margin: 0; color: var(--color-text-strong); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.summary-review ol { margin: 0; padding-left: 19px; display: grid; gap: 5px; color: var(--color-text); font-size: 12px; line-height: 1.55; }
.session-only-note { margin: 11px 0 0; padding-top: 10px; display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); border-top: 1px solid var(--color-border-subtle); font-size: 10px; line-height: 1.5; }
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
.manifest-progress-details { margin-top: 9px; border-top: 1px solid color-mix(in srgb, currentColor 18%, var(--color-border-subtle)); }
.manifest-progress-details > summary { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--color-text-muted); cursor: pointer; font-size: 10px; list-style: none; }
.manifest-progress-details > summary::-webkit-details-marker { display: none; }
.manifest-progress-details > summary svg { transition: transform 140ms ease; }
.manifest-progress-details[open] > summary svg { transform: rotate(90deg); }
.manifest-progress ol { max-height: 250px; margin: 12px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
.manifest-progress li { min-width: 0; padding: 7px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; color: var(--color-text-muted); border: 1px solid var(--color-border-subtle); border-radius: 4px; background: rgb(0 0 0 / 12%); }
.manifest-progress li > span { width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: currentColor; }
.manifest-progress li[data-state='backed-up'], .manifest-progress li[data-state='unchanged'] { color: var(--color-success); }
.manifest-progress li[data-state='skipped'] { color: var(--save-amber); }
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
.manifest-footer { position: sticky; z-index: 2; bottom: 0; margin: 15px -26px 0; padding: 13px 26px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--color-border-subtle); background: rgb(24 26 28 / 96%); backdrop-filter: blur(17px); }
.manifest-footer > span { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 10px; }
.manifest-footer .primary-button { min-width: 168px; }
.save-primary { color: #102126; border-color: color-mix(in srgb, var(--save-cyan) 82%, white); background: var(--save-cyan); }
button:disabled, input:disabled, textarea:disabled { opacity: .48; cursor: not-allowed; }
</style>
