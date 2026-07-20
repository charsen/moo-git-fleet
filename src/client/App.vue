<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
  UserRound,
  X,
} from 'lucide-vue-next';
import { computed, reactive, ref, watch } from 'vue';
import type { ProfileConfig, RepositoryState, RepositoryStatus, ScanCandidate } from '../shared/contracts';
import { api } from './api';

const query = useQuery({
  queryKey: ['dashboard'],
  queryFn: api.dashboard,
  refetchInterval: 15_000,
});

const search = ref('');
const stateFilter = ref<'all' | 'attention' | RepositoryState>('all');
const manageOpen = ref(false);
const selectedRepository = ref<RepositoryStatus | null>(null);
const scanRootId = ref('');
const scanCandidates = ref<ScanCandidate[]>([]);
const scanning = ref(false);
const savingProfile = ref(false);
const addingPath = ref<string | null>(null);
const actionError = ref('');
const actionMessage = ref('');

const profileForm = reactive<ProfileConfig['profile']>({
  displayName: '',
  avatar: null,
  locale: 'zh-CN',
  theme: 'moon',
  preferredCommitLanguage: 'zh-CN',
  aiCommitMode: 'review',
});

watch(
  () => query.data.value,
  (dashboard) => {
    if (!dashboard) return;
    Object.assign(profileForm, dashboard.profile.profile);
    if (!scanRootId.value) scanRootId.value = Object.keys(dashboard.roots)[0] ?? '';
    if (dashboard.repositories.length === 0) manageOpen.value = true;
    if (selectedRepository.value) {
      selectedRepository.value =
        dashboard.repositories.find((repository) => repository.config.id === selectedRepository.value?.config.id) ?? null;
    }
  },
  { immediate: true },
);

const repositories = computed(() => query.data.value?.repositories ?? []);
const filteredRepositories = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return repositories.value.filter((repository) => {
    const matchesKeyword =
      !keyword ||
      [repository.config.name, repository.config.group, repository.config.path, ...repository.config.tags]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    const matchesState =
      stateFilter.value === 'all' ||
      (stateFilter.value === 'attention'
        ? repository.state !== 'clean'
        : repository.state === stateFilter.value);
    return matchesKeyword && matchesState;
  });
});

const summary = computed(() => ({
  total: repositories.value.length,
  attention: repositories.value.filter((repository) => repository.state !== 'clean').length,
  dirty: repositories.value.filter((repository) => repository.state === 'dirty').length,
  ahead: repositories.value.reduce((total, repository) => total + (repository.ahead ?? 0), 0),
  behind: repositories.value.reduce((total, repository) => total + (repository.behind ?? 0), 0),
}));

const statusMeta: Record<RepositoryState, { label: string; tone: string }> = {
  conflict: { label: '冲突', tone: 'red' },
  'operation-in-progress': { label: '操作进行中', tone: 'red' },
  diverged: { label: '已分叉', tone: 'red' },
  dirty: { label: '有改动', tone: 'yellow' },
  ahead: { label: '待推送', tone: 'blue' },
  behind: { label: '待拉取', tone: 'cyan' },
  clean: { label: '已同步', tone: 'green' },
  'remote-unknown': { label: '未跟踪', tone: 'muted' },
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

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || 'GF';
}

async function refresh(): Promise<void> {
  actionError.value = '';
  await query.refetch();
}

async function saveProfile(): Promise<void> {
  savingProfile.value = true;
  actionError.value = '';
  try {
    await api.saveProfile({ ...profileForm });
    actionMessage.value = '个人配置已保存';
    await query.refetch();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '保存失败';
  } finally {
    savingProfile.value = false;
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
  await api.updateRepository(repository.config.id, { pinned: !repository.config.pinned });
  await query.refetch();
}

async function removeRepository(repository: RepositoryStatus): Promise<void> {
  if (!window.confirm(`只把 ${repository.config.name} 移出列表，不会删除磁盘文件。继续吗？`)) return;
  await api.removeRepository(repository.config.id);
  selectedRepository.value = null;
  await query.refetch();
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
        <button class="icon-button" title="管理仓库" @click="manageOpen = true"><Settings2 :size="18" /></button>
        <button class="primary-button" :disabled="query.isFetching.value" @click="refresh">
          <RefreshCw :size="16" :class="{ spinning: query.isFetching.value }" />
          刷新状态
        </button>
        <button class="profile-chip" @click="manageOpen = true">
          <span class="avatar">{{ initials(profileForm.displayName) }}</span>
          <span>{{ profileForm.displayName || 'Developer' }}</span>
        </button>
      </div>
    </header>

    <main class="workspace">
      <section class="command-strip">
        <div class="summary-block summary-total">
          <span class="summary-icon"><FolderGit2 :size="17" /></span>
          <div><strong>{{ summary.total }}</strong><span>仓库总数</span></div>
        </div>
        <div class="summary-block summary-attention">
          <span class="summary-icon"><Activity :size="17" /></span>
          <div><strong>{{ summary.attention }}</strong><span>需要处理</span></div>
        </div>
        <div class="summary-block summary-dirty">
          <span class="summary-icon"><CircleDot :size="17" /></span>
          <div><strong>{{ summary.dirty }}</strong><span>工作区改动</span></div>
        </div>
        <div class="summary-block summary-ahead">
          <span class="summary-icon"><ArrowUp :size="17" /></span>
          <div><strong>{{ summary.ahead }}</strong><span>待推送 commits</span></div>
        </div>
        <div class="summary-block summary-behind">
          <span class="summary-icon"><ArrowDown :size="17" /></span>
          <div><strong>{{ summary.behind }}</strong><span>待拉取 commits</span></div>
        </div>
        <div class="command-meta">
          <span><Clock3 :size="14" />15s 自动扫描</span>
          <span><Bot :size="14" />AI {{ profileForm.aiCommitMode === 'auto-commit' ? 'AUTO' : 'REVIEW' }}</span>
        </div>
      </section>

      <section class="fleet-panel">
        <div class="panel-heading">
          <div>
            <div class="section-kicker">REPOSITORY SIGNALS</div>
            <h2>仓库工作台</h2>
          </div>
          <div class="panel-controls">
            <label class="search-field">
              <Search :size="16" />
              <input v-model="search" placeholder="搜索仓库、路径或标签" />
            </label>
            <div class="filter-tabs">
              <button :class="{ active: stateFilter === 'all' }" @click="stateFilter = 'all'">全部</button>
              <button :class="{ active: stateFilter === 'attention' }" @click="stateFilter = 'attention'">有动静</button>
              <button :class="{ active: stateFilter === 'dirty' }" @click="stateFilter = 'dirty'">Dirty</button>
              <button :class="{ active: stateFilter === 'ahead' }" @click="stateFilter = 'ahead'">待推送</button>
              <button :class="{ active: stateFilter === 'behind' }" @click="stateFilter = 'behind'">待拉取</button>
            </div>
          </div>
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
          <button class="primary-button" @click="manageOpen = true"><Plus :size="16" />添加仓库</button>
        </div>
        <div v-else class="table-wrap">
          <table class="repo-table">
            <thead>
              <tr>
                <th class="pin-column" />
                <th>仓库</th>
                <th>分支 / Upstream</th>
                <th>工作区</th>
                <th>远端</th>
                <th>最近提交</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="repository in filteredRepositories"
                :key="repository.config.id"
                tabindex="0"
                @click="selectedRepository = repository"
                @keydown.enter="selectedRepository = repository"
              >
                <td class="pin-column">
                  <button
                    class="table-icon-button"
                    :class="{ pinned: repository.config.pinned }"
                    title="收藏"
                    @click.stop="togglePinned(repository)"
                  ><Pin :size="15" /></button>
                </td>
                <td>
                  <div class="repo-name">{{ repository.config.name }}</div>
                  <div class="repo-subline"><span>{{ repository.config.group }}</span><code>{{ repository.config.path }}</code></div>
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
                </td>
                <td>
                  <div class="commit-subject">{{ repository.lastCommit?.subject || '暂无提交' }}</div>
                  <div class="cell-muted mono">{{ repository.lastCommit?.hash.slice(0, 7) || '—' }} · {{ relativeTime(repository.lastCommit?.committedAt) }}</div>
                </td>
                <td><span class="status-pill" :data-tone="statusMeta[repository.state].tone"><span />{{ statusMeta[repository.state].label }}</span></td>
                <td><ChevronRight :size="16" class="row-chevron" /></td>
              </tr>
            </tbody>
          </table>
          <div v-if="filteredRepositories.length === 0" class="no-results">没有匹配当前筛选条件的仓库</div>
        </div>
      </section>
    </main>

    <transition name="drawer">
      <aside v-if="selectedRepository" class="repo-drawer">
        <div class="drawer-header">
          <div>
            <div class="section-kicker">REPOSITORY DETAIL</div>
            <h2>{{ selectedRepository.config.name }}</h2>
          </div>
          <button class="icon-button" @click="selectedRepository = null"><X :size="18" /></button>
        </div>
        <div class="drawer-status" :data-tone="statusMeta[selectedRepository.state].tone">
          <span class="status-pulse" />
          <div><strong>{{ statusMeta[selectedRepository.state].label }}</strong><span>扫描于 {{ relativeTime(selectedRepository.scannedAt) }}</span></div>
        </div>
        <dl class="detail-grid">
          <div><dt>LOCAL PATH</dt><dd>{{ selectedRepository.absolutePath }}</dd></div>
          <div><dt>BRANCH</dt><dd>{{ selectedRepository.branch || 'DETACHED HEAD' }}</dd></div>
          <div><dt>UPSTREAM</dt><dd>{{ selectedRepository.upstream || '未配置' }}</dd></div>
          <div><dt>STASHES</dt><dd>{{ selectedRepository.stashCount }}</dd></div>
        </dl>
        <div class="drawer-section">
          <div class="drawer-section-title">工作区信号</div>
          <div class="signal-grid">
            <div><span>Staged</span><strong>{{ selectedRepository.staged }}</strong></div>
            <div><span>Modified</span><strong>{{ selectedRepository.modified }}</strong></div>
            <div><span>Untracked</span><strong>{{ selectedRepository.untracked }}</strong></div>
            <div><span>Conflicts</span><strong>{{ selectedRepository.conflicted }}</strong></div>
          </div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-title">最近提交</div>
          <div class="commit-card">
            <GitCommitHorizontal :size="18" />
            <div><strong>{{ selectedRepository.lastCommit?.subject || '暂无提交' }}</strong><span>{{ selectedRepository.lastCommit?.author || '—' }} · {{ relativeTime(selectedRepository.lastCommit?.committedAt) }}</span></div>
          </div>
        </div>
        <div v-if="selectedRepository.error" class="drawer-error"><AlertTriangle :size="16" />{{ selectedRepository.error }}</div>
        <div class="drawer-spacer" />
        <div class="drawer-actions">
          <button class="secondary-button" @click="togglePinned(selectedRepository)"><Pin :size="16" />{{ selectedRepository.config.pinned ? '取消收藏' : '收藏' }}</button>
          <button class="danger-button" @click="removeRepository(selectedRepository)"><Trash2 :size="16" />移出列表</button>
        </div>
      </aside>
    </transition>

    <transition name="fade">
      <div v-if="manageOpen" class="modal-backdrop" @click.self="manageOpen = false">
        <section class="setup-modal">
          <div class="setup-header">
            <div>
              <div class="section-kicker">LOCAL SETUP</div>
              <h2>个人配置与仓库接入</h2>
              <p>所有配置仅保存在这台电脑，移出列表不会删除任何代码。</p>
            </div>
            <button class="icon-button" @click="manageOpen = false"><X :size="18" /></button>
          </div>

          <div class="setup-grid">
            <section class="setup-card profile-card">
              <div class="card-heading"><UserRound :size="18" /><div><strong>本机个人信息</strong><span>用于界面和 AI Commit 偏好</span></div></div>
              <label class="form-field"><span>显示名称</span><input v-model="profileForm.displayName" /></label>
              <label class="form-field"><span>Commit 语言</span><select v-model="profileForm.preferredCommitLanguage"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
              <label class="form-field"><span>AI Commit 模式</span><select v-model="profileForm.aiCommitMode"><option value="review">生成后确认</option><option value="auto-commit">一键生成并提交</option></select></label>
              <div class="theme-preview"><span class="theme-orb"><Sparkles :size="15" /></span><div><strong>Moon / One Dark Pro</strong><span>默认本地工程主题</span></div><Check :size="17" /></div>
              <button class="secondary-button full-width" :disabled="savingProfile" @click="saveProfile"><LoaderCircle v-if="savingProfile" :size="16" class="spinning" /><Check v-else :size="16" />保存个人配置</button>
            </section>

            <section class="setup-card repositories-card">
              <div class="card-heading"><Code2 :size="18" /><div><strong>添加本地仓库</strong><span>只扫描允许的根目录</span></div></div>
              <div class="scan-toolbar">
                <select v-model="scanRootId">
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
            </section>
          </div>

          <div v-if="actionError || actionMessage" class="setup-feedback" :class="{ error: actionError }">
            <AlertTriangle v-if="actionError" :size="16" /><Check v-else :size="16" />{{ actionError || actionMessage }}
          </div>
          <div class="setup-footer">
            <span><Minus :size="14" />配置文件位于本机 config/，不会上传个人路径</span>
            <button class="primary-button" :disabled="repositories.length === 0" @click="manageOpen = false">进入工作台<ChevronRight :size="16" /></button>
          </div>
        </section>
      </div>
    </transition>
  </div>
</template>
