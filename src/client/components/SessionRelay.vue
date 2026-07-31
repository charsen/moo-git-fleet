<script setup lang="ts">
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Cloud,
  CloudOff,
  Code2,
  CopyPlus,
  Download,
  Eye,
  FolderOpen,
  Copy,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionContentPreview, SessionProvider } from '../../shared/sessions';
import { isKeptCopy } from '../../shared/session-sync';
import type {
  BackupStatus,
  LocalSessionItem,
  LocalSessionList,
  SessionSyncDecision,
  SessionSyncItem,
} from '../../shared/session-sync';
import { buildResumeCommand, providerPermissionBypassFlag } from '../../shared/provider-command';
import { api } from '../api';
import { relativeTime as sharedRelativeTime } from '../relative-time';

const emit = defineEmits<{
  syncBusy: [busy: boolean];
}>();

type Feedback = { tone: 'success' | 'warning' | 'error'; message: string };

const status = ref<BackupStatus | null>(null);
const list = ref<LocalSessionList | null>(null);
const pending = ref<SessionSyncItem[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const syncing = ref(false);
const loadError = ref('');
const feedback = ref<Feedback | null>(null);
const search = ref('');
const provider = ref<SessionProvider | null>(null);
const resolvingKey = ref<string | null>(null);

const selected = ref<LocalSessionItem | null>(null);
const preview = ref<SessionContentPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref('');

const deleteTarget = ref<LocalSessionItem | null>(null);
const deleteBusy = ref(false);
const deleteError = ref('');
const deleteFromBackup = ref(false);

// 跳过权限确认是很多人的日常用法，记住上次的选择，免得每次都勾。
const bypassStorageKey = 'moo-fleet:resume-bypass-permissions';
const bypassPermissions = ref(localStorage.getItem(bypassStorageKey) === 'true');
watch(bypassPermissions, (value) => localStorage.setItem(bypassStorageKey, String(value)));
const copied = ref(false);
// 首次同步要把全部会话写进 Git，可能要几秒到十几秒；给个走字的计时，别让人以为卡死了。
const syncElapsed = ref(0);
let syncTimer: number | null = null;

const setupOpen = ref(false);
const setupRemoteUrl = ref('');
const setupBusy = ref(false);
const setupError = ref('');

let refreshTimer: number | null = null;

function sessionKey(session: { provider: SessionProvider; providerSessionId: string }): string {
  return `${session.provider}:${session.providerSessionId}`;
}

/** 会话列表里超过 30 天的会话显示日期，比“三百多天前”好认。 */
function relativeTime(value: string | null): string {
  return sharedRelativeTime(value, { longAgo: 'date' });
}

function providerLabel(value: SessionProvider): string {
  return value === 'claude' ? 'Claude' : 'Codex';
}

function projectLabel(session: LocalSessionItem): string {
  if (session.repositoryName) return session.repositoryName;
  if (session.projectPath) return session.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? session.projectId;
  return '未识别项目';
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

const backupLabels: Record<LocalSessionItem['backupState'], { label: string; tone: string }> = {
  'not-backed-up': { label: '待备份', tone: 'local' },
  changed: { label: '有新内容', tone: 'warning' },
  'backed-up': { label: '已备份', tone: 'synced' },
  'deleted-in-backup': { label: '另一台已删除', tone: 'warning' },
};

const sessions = computed(() => list.value?.items ?? []);

const filteredSessions = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return sessions.value.filter((session) => {
    if (provider.value && session.provider !== provider.value) return false;
    if (!needle) return true;
    return [session.title, session.projectPath, session.repositoryName, session.providerSessionId]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
  });
});

const totalLocalBytes = computed(() => sessions.value.reduce((sum, session) => sum + session.bytes, 0));

const waitingCount = computed(() => sessions.value.filter((session) => session.backupState !== 'backed-up').length);

/** 上班 / 下班各同步一次是这个工具的正常节奏，超过半天没同步就该提醒一下。 */
const staleAfterMs = 12 * 60 * 60 * 1_000;

const syncIsStale = computed(() => {
  if (!status.value?.configured || waitingCount.value === 0) return false;
  const lastSyncAt = status.value.lastSyncAt;
  if (!lastSyncAt) return true;
  return Date.now() - new Date(lastSyncAt).getTime() > staleAfterMs;
});

const syncPresentation = computed(() => {
  if (!status.value?.configured) {
    return { tone: 'idle', label: '还没有设置备份', detail: '点「同步会话」完成一次设置即可' };
  }
  if (status.value.lastError) {
    return { tone: 'warning', label: '上次同步没完成', detail: status.value.lastError };
  }
  if (syncIsStale.value) {
    return {
      tone: 'warning',
      label: `有 ${waitingCount.value} 条还没备份`,
      detail: status.value.lastSyncAt ? `上次同步 ${relativeTime(status.value.lastSyncAt)}` : '还没有备份过',
    };
  }
  if (!status.value.remoteUrl) {
    return { tone: 'synced', label: '只备份在本机', detail: status.value.backupPath ?? '' };
  }
  return {
    tone: 'synced',
    label: status.value.lastSyncAt ? `上次同步 ${relativeTime(status.value.lastSyncAt)}` : '已连接私人仓库',
    detail: status.value.remoteUrl,
  };
});

async function refreshAll(silent = false): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  if (!silent) loading.value = true;
  loadError.value = '';
  try {
    const [statusResult, listResult] = await Promise.all([api.sessionBackupStatus(), api.localSessions()]);
    status.value = statusResult;
    list.value = listResult;
    const keys = new Set(listResult.items.map(sessionKey));
    if (selected.value && !keys.has(sessionKey(selected.value))) closeDetail();
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '本机会话读取失败';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function syncSessions(): Promise<void> {
  if (!status.value?.configured) {
    setupRemoteUrl.value = '';
    setupError.value = '';
    setupOpen.value = true;
    return;
  }
  syncing.value = true;
  emit('syncBusy', true);
  feedback.value = null;
  syncElapsed.value = 0;
  syncTimer = window.setInterval(() => { syncElapsed.value += 1; }, 1_000);
  try {
    const result = await api.syncSessions();
    pending.value = result.pending;
    // 只有"要你处理"才是警告：待决定项，或者配了远端却没推上去。
    // 体积提示这类纯告知的说明照常显示，但不该把整条消息变成警告色。
    const notUploaded = Boolean(status.value?.remoteUrl) && !result.pushed;
    feedback.value = {
      tone: result.pending.length || notUploaded ? 'warning' : 'success',
      message: [result.message, ...result.notes].join('；'),
    };
    await refreshAll(true);
  } catch (error) {
    feedback.value = { tone: 'error', message: error instanceof Error ? error.message : '同步没有完成' };
  } finally {
    if (syncTimer !== null) window.clearInterval(syncTimer);
    syncTimer = null;
    syncing.value = false;
    emit('syncBusy', false);
  }
}

const decisionLabels: Record<SessionSyncDecision, string> = {
  'keep-local': '用这台电脑的',
  'keep-backup': '用另一台电脑的',
  'keep-both': '两份都留',
  'delete-local': '本机也删除',
};

function decisionHint(item: SessionSyncItem): string {
  if (item.relation === 'backup-deleted') {
    return `${item.backupDevice ?? '另一台电脑'}删除了这条会话，本机这份还在。`;
  }
  return `第 ${item.commonLines} 条之后两边各写各的：这台 ${item.localLines ?? 0} 条，另一台 ${item.backupLines ?? 0} 条。`;
}

async function resolve(item: SessionSyncItem, decision: SessionSyncDecision): Promise<void> {
  resolvingKey.value = `${sessionKey(item)}:${decision}`;
  try {
    const result = await api.resolveSessionSync({
      provider: item.provider,
      providerSessionId: item.providerSessionId,
      decision,
    });
    pending.value = pending.value.filter((candidate) => sessionKey(candidate) !== sessionKey(item));
    feedback.value = { tone: 'success', message: result.message };
    await refreshAll(true);
  } catch (error) {
    feedback.value = { tone: 'error', message: error instanceof Error ? error.message : '处理失败' };
  } finally {
    resolvingKey.value = null;
  }
}

const resumeCommand = computed(() => (
  selected.value
    ? buildResumeCommand({
        provider: selected.value.provider,
        providerSessionId: selected.value.providerSessionId,
        projectPath: selected.value.projectPath,
        mode: bypassPermissions.value ? 'dangerous-bypass' : 'standard',
      })
    : ''
));

async function copyResumeCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(resumeCommand.value);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2_000);
  } catch {
    feedback.value = { tone: 'error', message: '复制失败，请检查浏览器剪贴板权限' };
  }
}

const detailBody = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

async function openDetail(session: LocalSessionItem): Promise<void> {
  selected.value = session;
  copied.value = false;
  preview.value = null;
  previewError.value = '';
  previewLoading.value = true;
  try {
    const payload = await api.localSession(session.provider, session.providerSessionId);
    if (!selected.value || sessionKey(selected.value) !== sessionKey(session)) return;
    preview.value = payload.preview;
    // 打开一条会话是想知道"我最后在干什么"，所以直接停在最新一条，
    // 而不是让人从几百条里手动滚到底。先退出加载态，对话渲染出来才滚得动。
    previewLoading.value = false;
    await nextTick();
    if (detailBody.value) detailBody.value.scrollTop = detailBody.value.scrollHeight;
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : '内容读取失败';
  } finally {
    previewLoading.value = false;
  }
}

function closeDetail(): void {
  selected.value = null;
  preview.value = null;
  previewError.value = '';
}

function requestDelete(session: LocalSessionItem): void {
  deleteTarget.value = session;
  deleteError.value = '';
  deleteFromBackup.value = false;
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleteBusy.value = true;
  deleteError.value = '';
  try {
    await api.trashLocalSession(target.provider, target.providerSessionId, deleteFromBackup.value);
    feedback.value = {
      tone: 'success',
      message: deleteFromBackup.value ? '已移到废纸篓，并在备份里记下删除' : '已移到系统废纸篓，备份保持不变',
    };
    deleteTarget.value = null;
    if (selected.value && sessionKey(selected.value) === sessionKey(target)) closeDetail();
    await refreshAll(true);
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : '删除失败';
  } finally {
    deleteBusy.value = false;
  }
}

async function completeSetup(): Promise<void> {
  setupBusy.value = true;
  setupError.value = '';
  try {
    status.value = await api.initializeSessionBackup({ remoteUrl: setupRemoteUrl.value.trim() || null });
    setupOpen.value = false;
    await syncSessions();
  } catch (error) {
    setupError.value = error instanceof Error ? error.message : '设置失败';
  } finally {
    setupBusy.value = false;
  }
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (deleteTarget.value && !deleteBusy.value) deleteTarget.value = null;
  else if (setupOpen.value && !setupBusy.value) setupOpen.value = false;
  else if (selected.value) closeDetail();
}

onMounted(() => {
  window.addEventListener('keydown', handleEscape);
  void refreshAll();
  refreshTimer = window.setInterval(() => void refreshAll(true), 30_000);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  if (syncTimer !== null) window.clearInterval(syncTimer);
  emit('syncBusy', false);
});

function focusSearch(): void {
  searchInput.value?.focus();
  searchInput.value?.select();
}

defineExpose({ syncSessions, focusSearch, refresh: () => void refreshAll() });
</script>

<template>
  <main class="workspace local-session-workspace">
    <section class="session-command-bar" aria-labelledby="session-heading">
      <div class="session-title-block">
        <h1 id="session-heading"><Bot :size="16" />AI 会话</h1>
        <p>查看、搜索和删除这台电脑上的 Claude、Codex 会话；换电脑时点一次「同步会话」。</p>
      </div>
      <div class="session-command-actions">
        <div class="sync-indicator" :data-tone="syncPresentation.tone">
          <CloudOff v-if="syncPresentation.tone === 'idle'" :size="16" />
          <AlertTriangle v-else-if="syncPresentation.tone === 'warning'" :size="16" />
          <CheckCircle2 v-else :size="16" />
          <span><strong>{{ syncPresentation.label }}</strong><small>{{ syncPresentation.detail }}</small></span>
        </div>
        <button class="icon-button refresh-button" aria-label="重新扫描本机会话" :disabled="refreshing || syncing" @click="refreshAll()">
          <RefreshCw :size="17" :class="{ spinning: refreshing }" />
        </button>
      </div>
    </section>

    <p v-if="syncing" class="session-feedback" data-tone="progress" role="status">
      <LoaderCircle :size="15" class="spinning" />
      <span>
        正在同步会话 · 已用 {{ syncElapsed }} 秒
        <small v-if="syncElapsed >= 3">首次同步要把全部会话写进 Git，会话越多越久；完成前请不要关闭页面。</small>
      </span>
    </p>
    <p v-else-if="feedback" class="session-feedback" :data-tone="feedback.tone" role="status">
      <CheckCircle2 v-if="feedback.tone === 'success'" :size="15" />
      <AlertTriangle v-else :size="15" />
      <span>{{ feedback.message }}</span>
      <button aria-label="关闭提示" @click="feedback = null"><X :size="13" /></button>
    </p>

    <section class="session-overview" aria-label="会话概览">
      <div><span>这台电脑</span><strong>{{ sessions.length }}</strong><small>Claude + Codex</small></div>
      <div :data-alert="waitingCount > 0"><span>等待备份</span><strong>{{ waitingCount }}</strong><small>新增或有新内容</small></div>
      <div><span>另一台电脑</span><strong>{{ list?.onlyInBackup ?? 0 }}</strong><small>同步一次自动拿回来</small></div>
      <div :data-alert="pending.length > 0"><span>需要你决定</span><strong>{{ pending.length }}</strong><small>其余都自动处理</small></div>
    </section>

    <section v-if="pending.length" class="incoming-sessions" aria-labelledby="pending-heading">
      <header>
        <div><AlertTriangle :size="17" /><span><strong id="pending-heading">这几条需要你决定</strong><small>两边都写过内容，系统不会替你覆盖任何一份。</small></span></div>
      </header>
      <div class="pending-list">
        <article v-for="item in pending" :key="sessionKey(item)">
          <div class="pending-copy">
            <span class="provider-mark" :data-provider="item.provider">{{ providerLabel(item.provider) }}</span>
            <div>
              <strong>{{ item.title || '未命名会话' }}</strong>
              <small>{{ item.projectName ?? '未识别项目' }} · {{ decisionHint(item) }}</small>
              <div v-if="item.localFirstDiff || item.backupFirstDiff" class="pending-diff">
                <p><span>这台</span>{{ item.localFirstDiff ?? '（没有可显示的内容）' }}</p>
                <p><span>另一台</span>{{ item.backupFirstDiff ?? '（没有可显示的内容）' }}</p>
              </div>
            </div>
          </div>
          <div class="pending-actions">
            <button
              v-for="choice in item.choices"
              :key="choice"
              class="secondary-button"
              :class="{ 'danger-button': choice === 'delete-local' }"
              :disabled="Boolean(resolvingKey)"
              @click="resolve(item, choice)"
            >
              <LoaderCircle v-if="resolvingKey === `${sessionKey(item)}:${choice}`" :size="14" class="spinning" />
              <CopyPlus v-else-if="choice === 'keep-both'" :size="14" />
              <Download v-else-if="choice === 'keep-backup'" :size="14" />
              <Trash2 v-else-if="choice === 'delete-local'" :size="14" />
              <CheckCircle2 v-else :size="14" />
              {{ decisionLabels[choice] }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <section class="session-library" aria-labelledby="library-heading">
      <header class="library-toolbar">
        <div>
          <h2 id="library-heading">本机会话</h2>
          <small>点击任意一条查看完整对话预览</small>
        </div>
        <label v-if="sessions.length > 0" class="session-search">
          <Search :size="15" />
          <input ref="searchInput" v-model="search" placeholder="搜索标题、项目或会话 ID" aria-label="搜索本机会话" />
          <button v-if="search" aria-label="清除搜索" @click="search = ''"><X :size="13" /></button>
        </label>
        <div v-if="sessions.length > 0" class="provider-filter" role="group" aria-label="按 AI 类型筛选">
          <button :class="{ active: provider === null }" @click="provider = null">全部</button>
          <button :class="{ active: provider === 'claude' }" @click="provider = 'claude'">Claude</button>
          <button :class="{ active: provider === 'codex' }" @click="provider = 'codex'">Codex</button>
        </div>
      </header>

      <div v-if="loading" class="library-state"><LoaderCircle :size="24" class="spinning" /><strong>正在扫描本机会话</strong><span>只读取 Claude 和 Codex 的会话文件。</span></div>
      <div v-else-if="loadError" class="library-state error"><AlertTriangle :size="24" /><strong>会话读取失败</strong><span>{{ loadError }}</span><button class="secondary-button" @click="refreshAll()"><RefreshCw :size="14" />重试</button></div>
      <div v-else-if="sessions.length === 0" class="library-state">
        <Inbox :size="26" />
        <strong>这台电脑上还没有 Claude / Codex 会话</strong>
        <span v-if="(list?.onlyInBackup ?? 0) > 0">备份里有 {{ list?.onlyInBackup }} 条来自另一台电脑，点「同步会话」就能拿回来。</span>
        <span v-else>用 Claude 或 Codex 聊过之后，会话会自动出现在这里。</span>
      </div>
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
              <small>
                <Code2 :size="12" />{{ projectLabel(session) }}
                <em v-if="isKeptCopy(session.providerSessionId)" title="「两份都留」时从另一台电脑另存的副本">副本</em>
              </small>
            </span>
            <span class="session-facts">
              <small><Clock3 :size="12" />{{ relativeTime(session.lastActivityAt ?? session.createdAt) }}</small>
              <small>{{ session.messageCount }} 条记录 · {{ formatBytes(session.bytes) }}</small>
            </span>
            <span class="backup-state" :data-tone="backupLabels[session.backupState].tone">{{ backupLabels[session.backupState].label }}</span>
          </button>
          <div class="session-row-actions">
            <button aria-label="查看会话" @click="openDetail(session)"><Eye :size="15" /></button>
            <button class="danger" aria-label="删除会话" @click="requestDelete(session)"><Trash2 :size="15" /></button>
          </div>
        </article>
      </div>
    </section>

    <Teleport to="body">
      <template v-if="selected">
        <button class="local-drawer-backdrop" aria-label="关闭会话详情" @click="closeDetail" />
        <aside class="local-session-drawer" role="dialog" aria-modal="true" aria-labelledby="local-detail-title" tabindex="-1">
          <header>
            <div>
              <span class="provider-mark" :data-provider="selected.provider">{{ providerLabel(selected.provider) }}</span>
              <div><h2 id="local-detail-title">{{ selected.title || '未命名会话' }}</h2><p>{{ projectLabel(selected) }} · {{ relativeTime(selected.lastActivityAt ?? selected.createdAt) }}</p></div>
            </div>
            <button class="icon-button" aria-label="关闭会话详情" @click="closeDetail"><X :size="18" /></button>
          </header>
          <div ref="detailBody" class="local-detail-body">
            <div v-if="previewLoading" class="detail-state"><LoaderCircle :size="23" class="spinning" /><strong>正在读取会话内容</strong></div>
            <div v-else-if="previewError" class="detail-state error"><AlertTriangle :size="23" /><strong>内容读取失败</strong><p>{{ previewError }}</p><button class="secondary-button" @click="openDetail(selected)"><RefreshCw :size="14" />重试</button></div>
            <template v-else-if="preview">
              <section class="detail-summary-strip">
                <div><span>对话记录</span><strong>{{ preview.totalMessages }}</strong></div>
                <div><span>文件大小</span><strong>{{ formatBytes(selected.bytes) }}</strong></div>
                <div><span>备份状态</span><strong :data-tone="backupLabels[selected.backupState].tone">{{ backupLabels[selected.backupState].label }}</strong></div>
              </section>
              <section class="conversation-stream" aria-label="会话内容">
                <article v-for="(item, index) in preview.items" :key="`${index}:${item.occurredAt ?? ''}`" :data-role="item.role">
                  <span>{{ item.role === 'user' ? '你' : 'AI' }}</span>
                  <div><time v-if="item.occurredAt">{{ new Date(item.occurredAt).toLocaleString() }}</time><p>{{ item.text }}</p></div>
                </article>
                <div v-if="preview.items.length === 0" class="conversation-empty">没有可显示的用户或 AI 文本。</div>
              </section>
              <p v-if="preview.truncated" class="conversation-note"><ShieldCheck :size="13" />当前展示最近 200 条可读消息，备份保存完整会话记录。</p>
            </template>
          </div>
          <section class="resume-block" aria-labelledby="resume-heading">
            <div class="resume-copy">
              <strong id="resume-heading">在终端里接着这个会话</strong>
              <code>{{ resumeCommand }}</code>
            </div>
            <label class="resume-option">
              <input v-model="bypassPermissions" type="checkbox" />
              <span>跳过权限确认（<code>{{ providerPermissionBypassFlag(selected.provider) }}</code>）</span>
            </label>
          </section>
          <footer>
            <span><ShieldCheck :size="13" />只读查看，Fleet 不会替你启动 Claude 或 Codex。</span>
            <div class="detail-footer-actions">
              <button class="secondary-button" @click="copyResumeCommand">
                <CheckCircle2 v-if="copied" :size="14" /><Copy v-else :size="14" />
                {{ copied ? '已复制' : '复制继续命令' }}
              </button>
              <button class="secondary-button danger-button" @click="requestDelete(selected)"><Trash2 :size="14" />移到废纸篓</button>
            </div>
          </footer>
        </aside>
      </template>

      <div v-if="deleteTarget" class="session-modal-layer" @mousedown.self="!deleteBusy && (deleteTarget = null)">
        <section class="session-modal danger-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title">
          <header><span><Trash2 :size="18" /></span><div><h2 id="delete-session-title">移到本机废纸篓？</h2><p>{{ deleteTarget.title || '未命名会话' }}</p></div></header>
          <div class="modal-copy">
            <p>只处理这台电脑上的会话文件，可以从系统废纸篓找回。</p>
            <label v-if="deleteTarget.backupState !== 'not-backed-up'" class="synced-delete-option">
              <input v-model="deleteFromBackup" type="checkbox" :disabled="deleteBusy" />
              <span>
                <strong>同时从备份中移除</strong>
                <small>另一台电脑同步时会问你要不要一起删。Git 历史里仍可能保留旧内容。</small>
              </span>
            </label>
            <p v-else class="local-delete-note">这条会话还没有备份，删除不影响备份仓。</p>
          </div>
          <p v-if="deleteError" class="modal-error"><AlertTriangle :size="14" />{{ deleteError }}</p>
          <footer><button class="secondary-button" :disabled="deleteBusy" @click="deleteTarget = null">取消</button><button class="primary-button destructive" :disabled="deleteBusy" @click="confirmDelete"><LoaderCircle v-if="deleteBusy" :size="14" class="spinning" /><Trash2 v-else :size="14" />{{ deleteFromBackup ? '删除并移出备份' : '移到本机废纸篓' }}</button></footer>
        </section>
      </div>

      <div v-if="setupOpen" class="session-modal-layer" @mousedown.self="!setupBusy && (setupOpen = false)">
        <form class="session-modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-session-title" @submit.prevent="completeSetup">
          <header><span><Cloud :size="18" /></span><div><h2 id="setup-session-title">开始同步会话</h2><p>两台电脑各设置一次，填同一个私人仓库地址。</p></div></header>
          <label class="setup-field">
            <span>私人仓库地址</span>
            <input v-model="setupRemoteUrl" autofocus placeholder="git@github.com:you/my-ai-sessions.git" :disabled="setupBusy" />
            <small>先在 GitHub 或 Gitee 新建一个空的私有仓库，把地址粘到这里。留空则只备份在本机。</small>
          </label>
          <div class="setup-target">
            <FolderOpen :size="15" />
            <span>
              <strong>备份会建在这台电脑的这个位置</strong>
              <code>{{ status?.suggestedBackupPath ?? '—' }}</code>
              <small>首次备份写入 {{ sessions.length }} 条会话（约 {{ formatBytes(totalLocalBytes) }}）；Git 会另存一份压缩副本，实际占用约为两倍。</small>
            </span>
          </div>
          <p v-if="setupError" class="modal-error"><AlertTriangle :size="14" />{{ setupError }}</p>
          <footer><button type="button" class="secondary-button" :disabled="setupBusy" @click="setupOpen = false">取消</button><button class="primary-button" :disabled="setupBusy" type="submit"><LoaderCircle v-if="setupBusy" :size="14" class="spinning" /><Cloud v-else :size="14" />开始备份</button></footer>
        </form>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.local-session-workspace { --session-cyan: #59c7d8; --session-amber: #e2b45c; --session-red: #ed6573; --session-green: #7dcc9a; min-height: calc(100vh - 70px); padding-bottom: 56px; color: var(--color-text); }
.session-command-bar { padding: 14px 0 15px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px 24px; border-bottom: 1px solid var(--color-border); }
.session-title-block { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; }
.session-title-block h1 { margin: 0; display: inline-flex; align-items: center; gap: 8px; color: var(--color-text-strong); font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
.session-title-block h1 svg { color: var(--session-cyan); }
.session-title-block p { max-width: 640px; margin: 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.5; }
.session-command-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.sync-indicator { min-width: 230px; min-height: 43px; padding: 7px 10px; display: flex; align-items: center; gap: 9px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 6px; background: rgb(9 11 12 / 30%); }
.sync-indicator[data-tone='synced'] { color: var(--session-green); border-color: color-mix(in srgb, var(--session-green) 30%, var(--color-border)); }
.sync-indicator[data-tone='warning'] { color: var(--session-amber); border-color: color-mix(in srgb, var(--session-amber) 32%, var(--color-border)); }
.sync-indicator > span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sync-indicator strong { color: var(--color-text-strong); font-size: 10px; }
.sync-indicator small { max-width: 250px; overflow: hidden; color: var(--color-text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.refresh-button { width: 39px; height: 39px; }
.session-feedback { margin: 13px 0 0; padding: 9px 11px; display: flex; align-items: center; gap: 8px; color: var(--session-green); border: 1px solid color-mix(in srgb, currentColor 30%, var(--color-border)); border-radius: 6px; background: color-mix(in srgb, currentColor 5%, transparent); font-size: 11px; }
.session-feedback[data-tone='warning'] { color: var(--session-amber); }
.session-feedback[data-tone='progress'] { color: var(--session-cyan); }
.session-feedback[data-tone='progress'] span { display: flex; flex-direction: column; gap: 2px; }
.session-feedback[data-tone='progress'] small { color: var(--color-text-muted); font-size: 9px; }
.session-feedback[data-tone='error'] { color: var(--session-red); }
.session-feedback span { flex: 1; }
.session-feedback button { padding: 2px; display: grid; place-items: center; color: currentColor; border: 0; background: transparent; cursor: pointer; }
.session-overview { margin-top: 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: 8px; background: linear-gradient(110deg, rgb(89 199 216 / 3%), rgb(0 0 0 / 12%)); }
.session-overview > div { min-height: 68px; padding: 11px 16px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: center; gap: 2px 12px; border-right: 1px solid var(--color-border-subtle); }
.session-overview > div:last-child { border-right: 0; }
.session-overview span { color: var(--color-text-strong); font-size: 12px; }
.session-overview strong { grid-row: span 2; color: var(--color-text-strong); font: 500 20px/1.1 'JetBrains Mono', monospace; }
.session-overview small { color: var(--color-text-muted); font-size: 11px; }
.session-overview > div[data-alert='true'] strong { color: var(--session-amber); }
.incoming-sessions { margin-top: 15px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--session-amber) 28%, var(--color-border)); border-radius: 8px; background: color-mix(in srgb, var(--session-amber) 3%, transparent); }
.incoming-sessions > header { min-height: 55px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid color-mix(in srgb, var(--session-amber) 18%, var(--color-border)); }
.incoming-sessions > header > div { display: flex; align-items: center; gap: 10px; color: var(--session-amber); }
.incoming-sessions > header span { display: flex; flex-direction: column; gap: 3px; }
.incoming-sessions > header strong { color: var(--color-text-strong); font-size: 12px; }
.incoming-sessions > header small { color: var(--color-text-muted); font-size: 9px; }
.pending-list { display: flex; flex-direction: column; }
.pending-list article { min-height: 68px; padding: 11px 13px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--color-border-subtle); }
.pending-list article:last-child { border-bottom: 0; }
.pending-copy { min-width: 0; display: flex; align-items: center; gap: 11px; }
.pending-copy > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pending-copy strong { overflow: hidden; color: var(--color-text-strong); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.pending-copy small { color: var(--color-text-muted); font-size: 9px; }
.pending-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.pending-actions button { font-size: 10px; }
.pending-diff { margin-top: 7px; display: flex; flex-direction: column; gap: 4px; }
.pending-diff p { display: flex; align-items: baseline; gap: 8px; margin: 0; overflow: hidden; color: var(--color-text); font-size: 10px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.pending-diff span { flex: none; min-width: 40px; color: var(--color-text-muted); font: 9px 'JetBrains Mono', monospace; }
.pending-diff p:first-child span { color: var(--session-green); }
.pending-diff p:last-child span { color: var(--session-cyan); }
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
.session-row-main { min-width: 0; padding: 10px 12px; display: grid; grid-template-columns: 58px minmax(220px, 1fr) auto auto; align-items: center; gap: 12px 18px; color: var(--color-text); border: 0; background: transparent; cursor: pointer; text-align: left; }
.session-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.session-copy strong { overflow: hidden; color: var(--color-text-strong); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.session-copy small, .session-facts small { display: flex; align-items: center; gap: 5px; color: var(--color-text-muted); font-size: 9px; }
.session-copy em { padding: 1px 5px; color: var(--session-cyan); border: 1px solid color-mix(in srgb, var(--session-cyan) 30%, var(--color-border)); border-radius: 3px; font-size: 8px; font-style: normal; }
.session-facts { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; white-space: nowrap; }
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
.resume-block { margin: 0 18px 12px; padding: 11px 12px; display: flex; flex-direction: column; gap: 9px; border: 1px solid var(--color-border); border-radius: 6px; background: rgb(9 11 12 / 40%); }
.resume-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.resume-copy strong { color: var(--color-text-strong); font-size: 10px; }
.resume-copy code { overflow-x: auto; padding: 7px 8px; display: block; color: var(--session-cyan); border-radius: 4px; background: #0b0d0e; font: 10px/1.5 'JetBrains Mono', monospace; white-space: pre; }
.resume-option { display: flex; align-items: center; gap: 7px; color: var(--color-text-muted); font-size: 10px; cursor: pointer; }
.resume-option code { color: var(--session-amber); font: 9px 'JetBrains Mono', monospace; }
.conversation-note { margin: 11px 20px 20px; display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 9px; }
.local-session-drawer > footer { min-height: 65px; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--color-border); background: rgb(24 26 28 / 96%); }
.local-session-drawer > footer > span { display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 9px; }
.detail-footer-actions { display: flex; align-items: center; gap: 7px; }
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
.synced-delete-option { margin: 12px 0; padding: 12px; display: flex; align-items: flex-start; gap: 10px; cursor: pointer; border: 1px solid var(--color-border); border-radius: 7px; background: rgb(255 255 255 / 2%); }
.synced-delete-option:has(input:checked) { border-color: color-mix(in srgb, var(--session-red) 45%, var(--color-border)); background: color-mix(in srgb, var(--session-red) 7%, transparent); }
.synced-delete-option input { margin: 2px 0 0; accent-color: var(--session-red); }
.synced-delete-option span { display: grid; gap: 4px; }
.synced-delete-option strong { color: var(--color-text-strong); font-size: 11px; font-weight: 600; }
.synced-delete-option small { color: var(--color-text-muted); font-size: 10px; line-height: 1.55; }
.local-delete-note { color: var(--color-text-muted) !important; }
.session-modal > footer { padding: 13px 18px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--color-border); }
.session-modal .destructive { color: white; border-color: var(--session-red); background: color-mix(in srgb, var(--session-red) 82%, #351219); }
.modal-error { margin: 11px 18px; padding: 8px 9px; display: flex; align-items: flex-start; gap: 7px; color: var(--session-red); border: 1px solid color-mix(in srgb, var(--session-red) 30%, var(--color-border)); border-radius: 5px; background: color-mix(in srgb, var(--session-red) 5%, transparent); font-size: 10px; line-height: 1.5; }
.setup-field { margin: 16px 18px 0; display: flex; flex-direction: column; gap: 7px; }
.setup-field > span { color: var(--color-text-strong); font-size: 10px; }
.setup-field input { height: 40px; padding: 0 11px; color: var(--color-text); border: 1px solid var(--color-border); border-radius: 5px; outline: 0; background: #101214; font: 11px 'JetBrains Mono', monospace; }
.setup-field input:focus { border-color: var(--session-cyan); box-shadow: 0 0 0 3px rgb(89 199 216 / 7%); }
.setup-field small { color: var(--color-text-muted); font-size: 9px; line-height: 1.55; }
.setup-target { margin: 0 18px 16px; padding: 11px 12px; display: flex; align-items: flex-start; gap: 10px; color: var(--session-cyan); border: 1px solid var(--color-border); border-radius: 6px; background: rgb(9 11 12 / 40%); }
.setup-target > span { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.setup-target strong { color: var(--color-text-strong); font-size: 10px; }
.setup-target code { overflow-x: auto; color: var(--session-cyan); font: 10px/1.5 'JetBrains Mono', monospace; white-space: nowrap; }
.setup-target small { color: var(--color-text-muted); font-size: 9px; }
button:disabled, input:disabled { opacity: .48; cursor: not-allowed; }
@media (max-width: 1180px) {
  .library-toolbar { grid-template-columns: 1fr auto; }
  .library-toolbar > div:first-child { grid-column: 1 / -1; }
  .session-row-main { grid-template-columns: 58px minmax(190px, 1fr) auto auto; }
}
</style>
