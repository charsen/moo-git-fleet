<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Tag,
  X,
} from 'lucide-vue-next';
import type { BranchesSnapshot, FileChange, RepositoryStatus } from '../../shared/contracts';
import type { PresentedDiff } from '../diff-presentation';
import type { RepositoryDiff } from '../use-repository-diff';
import { filesForScope, selectionKey, type DiffKind } from '../repository-workspace';
import { presentGlobalToast } from '../toast-presentation';
import DiffView from './DiffView.vue';
import '../repository-workspace.css';

const props = defineProps<{
  repository: RepositoryStatus;
  files: FileChange[];
  filesLoading: boolean;
  branches: BranchesSnapshot | null;
  branchesLoading: boolean;
  branchBlocker: string | null;
  busy: boolean;
  commitBusy: boolean;
  refreshing: boolean;
  diff: RepositoryDiff | null;
  presentation: PresentedDiff | null;
  diffLoading: boolean;
  diffError: string;
  hunkActionLabel?: string;
  pendingHunk: number | null;
  message: string;
  error: string;
}>();
const emit = defineEmits<{
  select: [file: FileChange, kind?: DiffKind];
  stage: [paths: string[], action: 'stage' | 'unstage'];
  switchBranch: [branch: BranchesSnapshot['branches'][number]];
  switchKind: [kind: DiffKind];
  hunk: [index: number];
  commit: [];
  refresh: [];
  clearDiff: [];
  dismissFeedback: [];
}>();
type View = 'working' | 'history' | 'stash' | 'tags';
const view = ref<View>('working');
const search = ref('');
const selectedBranch = ref<string | null>(null);
const checked = ref(new Set<string>());
const searchInput = ref<HTMLInputElement | null>(null);
const root = ref<HTMLElement | null>(null);
const preview = ref<HTMLElement | null>(null);
const sidebarWidth = ref(210);
const filesWidth = ref(340);
const workspaceWidth = ref(1440);
const sidebarLimit = computed(() => (workspaceWidth.value <= 1150 ? 190 : 300));
const actualSidebarWidth = computed(() =>
  Math.max(180, Math.min(sidebarLimit.value, sidebarWidth.value)),
);
const filesLimit = computed(() =>
  Math.min(
    workspaceWidth.value <= 1150 ? 300 : 520,
    workspaceWidth.value - actualSidebarWidth.value - 380,
  ),
);
const actualFilesWidth = computed(() =>
  Math.max(280, Math.min(filesLimit.value, filesWidth.value)),
);
let widthObserver: ResizeObserver | null = null;
onMounted(() => {
  widthObserver = new ResizeObserver(([entry]) => {
    if (entry) workspaceWidth.value = entry.contentRect.width;
  });
  if (root.value) widthObserver.observe(root.value);
});
const scopes: DiffKind[] = ['unstaged', 'staged'];
const scopeLabel = (kind: DiffKind) => (kind === 'staged' ? '已暂存' : '未暂存');
const filteredFiles = computed(() =>
  props.files.filter((file) =>
    file.path.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const hiddenCheckedCount = computed(() => {
  const visible = new Set(
    scopes.flatMap((kind) =>
      filesForScope(filteredFiles.value, kind).map((file) =>
        selectionKey({ path: file.path, kind }),
      ),
    ),
  );
  return [...checked.value].filter((key) => !visible.has(key)).length;
});
const hiddenFileCount = computed(() => props.files.length - filteredFiles.value.length);
const conflicts = computed(() => filteredFiles.value.filter((file) => file.conflicted));
const localBranches = computed(() => props.branches?.branches ?? []);
const remoteBranches = computed(() => props.branches?.remoteBranches ?? []);
const branchInfo = computed(() =>
  props.branches?.branches.find((branch) => branch.name === selectedBranch.value),
);
const currentFile = computed(() => props.files.find((file) => file.path === props.diff?.path));
const previewHiddenBySearch = computed(
  () => props.diff && !filteredFiles.value.some((file) => file.path === props.diff!.path),
);
const showPatchHeaders = ref(false);
const canCollapsePatchHeaders = computed(
  () =>
    props.presentation?.lines.some((line) => line.kind === 'hunk') &&
    props.presentation.lines.some((line) => line.kind === 'header'),
);
const inlinePresentation = computed(() => {
  const presentation = props.presentation;
  if (!presentation || showPatchHeaders.value || !canCollapsePatchHeaders.value)
    return presentation;
  return { ...presentation, lines: presentation.lines.filter((line) => line.kind !== 'header') };
});
const feedback = computed(() =>
  presentGlobalToast(props.error || props.repository.error || '', props.message),
);
const nav = computed(() => [
  { id: 'working' as const, label: '工作区', icon: FileDiff, count: props.files.length },
  { id: 'history' as const, label: '提交历史', icon: History, count: null },
  { id: 'stash' as const, label: 'Stash 备份', icon: Archive, count: props.repository.stashCount },
  { id: 'tags' as const, label: '标签', icon: Tag, count: null },
]);
function fileName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}
function fileDirectory(filePath: string): string {
  return filePath.slice(0, Math.max(0, filePath.lastIndexOf('/')));
}
let initialPreviewRequested = false;
watch(
  [() => props.files, () => props.filesLoading, () => props.busy, view, () => props.diff],
  () => {
    if (initialPreviewRequested) return;
    if (props.diff) {
      initialPreviewRequested = true;
      return;
    }
    if (props.filesLoading || props.busy || view.value !== 'working') return;
    const first =
      conflicts.value[0] ??
      filesForScope(filteredFiles.value, 'unstaged')[0] ??
      filesForScope(filteredFiles.value, 'staged')[0];
    if (!first) return;
    initialPreviewRequested = true;
    emit('select', first, first.unstaged ? 'unstaged' : 'staged');
  },
  { flush: 'post', immediate: true },
);
function toggle(file: FileChange, kind: DiffKind): void {
  const key = selectionKey({ path: file.path, kind });
  const next = new Set(checked.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  checked.value = next;
}
function selectedPaths(kind: DiffKind): string[] {
  return filesForScope(props.files, kind)
    .filter((file) => checked.value.has(selectionKey({ path: file.path, kind })))
    .map((file) => file.path);
}
function scopeAction(kind: DiffKind): void {
  const selected = selectedPaths(kind);
  // "全部" always means the full scope, including files hidden by a search.
  emit(
    'stage',
    selected.length ? selected : filesForScope(props.files, kind).map((file) => file.path),
    kind === 'staged' ? 'unstage' : 'stage',
  );
}
function switchSelectedBranch(): void {
  if (branchInfo.value && !switchBlocker(branchInfo.value)) emit('switchBranch', branchInfo.value);
}
function switchBlocker(branch: BranchesSnapshot['branches'][number]): string | null {
  if (branch.current) return '当前分支';
  if (branch.worktreePath) return '分支已被其他 Worktree 占用';
  return props.busy ? '正在执行仓库操作' : props.branchBlocker;
}
function moveFile(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (
    event.code === 'Space' &&
    event.target instanceof HTMLElement &&
    event.target.matches('.workspace-file-select')
  ) {
    event.preventDefault();
    const row = event.target.closest<HTMLElement>('.workspace-file-row');
    const file = props.files.find((item) => item.path === row?.dataset.path);
    if (file && !file.conflicted && !props.busy) toggle(file, row!.dataset.kind as DiffKind);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.workspace-file-select'))
    return;
  const controls = [...root.value!.querySelectorAll<HTMLButtonElement>('.workspace-file-select')];
  const index = controls.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  controls[next]?.focus();
  controls[next]?.click();
}
function enterFileList(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const first = root.value?.querySelector<HTMLButtonElement>('.workspace-file-select');
  if (!first) return;
  event.preventDefault();
  first.focus();
  first.click();
}
function moveBranch(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.workspace-branch')) return;
  const controls = [...root.value!.querySelectorAll<HTMLButtonElement>('.workspace-branch')];
  const index = controls.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  controls[next]?.focus();
  // Arrow navigation selects information; only Enter or double-click switches branches.
  controls[next]?.click();
}
const scrollPositions = new Map<string, { top: number; left: number }>();
function rememberScroll(): void {
  if (!preview.value || !props.diff?.diff || props.diffLoading || props.busy) return;
  scrollPositions.set(selectionKey(props.diff), {
    top: preview.value.scrollTop,
    left: preview.value.scrollLeft,
  });
}
let mutationFocus: { element: HTMLElement; path?: string; kind?: string } | null = null;
watch(
  () => props.busy,
  async (busy) => {
    if (busy) {
      if (props.diff && preview.value) {
        scrollPositions.set(selectionKey(props.diff), {
          top: preview.value.scrollTop,
          left: preview.value.scrollLeft,
        });
      }
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || !root.value?.contains(element)) {
        mutationFocus = null;
        return;
      }
      const row = element.closest<HTMLElement>('.workspace-file-row');
      mutationFocus = {
        element,
        path:
          row?.dataset.path ??
          (element.matches('.diff-hunk-action') ? props.diff?.path : undefined),
        kind: row?.dataset.kind ?? props.diff?.kind,
      };
      return;
    }
    const target = mutationFocus;
    mutationFocus = null;
    await nextTick();
    if (
      !target ||
      (document.activeElement !== document.body && document.activeElement !== root.value)
    )
      return;
    if (target.element.isConnected && !target.element.matches(':disabled')) {
      target.element.focus({ preventScroll: true });
      return;
    }
    const rows = [...root.value!.querySelectorAll<HTMLElement>('.workspace-file-row')];
    const replacement =
      rows.find((row) => row.dataset.path === target.path && row.dataset.kind === target.kind) ??
      rows.find((row) => row.dataset.path === target.path);
    (
      replacement?.querySelector<HTMLButtonElement>('.workspace-file-select') ?? searchInput.value
    )?.focus({ preventScroll: true });
  },
);
let previousSelection: string | null = null;
watch(view, async (next, previous) => {
  if (previous === 'working') rememberScroll();
  await nextTick();
  if (next !== 'working' || view.value !== next || !preview.value || !props.diff) return;
  const position = scrollPositions.get(selectionKey(props.diff));
  preview.value.scrollTop = position?.top ?? 0;
  preview.value.scrollLeft = position?.left ?? 0;
});
watch(
  [() => (props.diff ? selectionKey(props.diff) : null), () => props.diffLoading],
  async ([key, loading]) => {
    if (key !== previousSelection) {
      if (previousSelection && preview.value)
        scrollPositions.set(previousSelection, {
          top: preview.value.scrollTop,
          left: preview.value.scrollLeft,
        });
      previousSelection = key;
    }
    if (loading) return;
    await nextTick();
    if (key !== previousSelection || props.diffLoading) return;
    const position = key ? scrollPositions.get(key) : null;
    if (preview.value) {
      preview.value.scrollTop = position?.top ?? 0;
      preview.value.scrollLeft = position?.left ?? 0;
    }
  },
);
watch(
  () => props.files,
  () => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const row = focused?.closest<HTMLElement>('.workspace-file-row');
    const path = row?.dataset.path;
    const kind = row?.dataset.kind;
    const available = new Set(
      scopes.flatMap((kind) =>
        filesForScope(props.files, kind).map((file) => selectionKey({ path: file.path, kind })),
      ),
    );
    checked.value = new Set([...checked.value].filter((key) => available.has(key)));
    if (path === undefined) return;
    void nextTick(() => {
      if (
        focused?.isConnected ||
        (document.activeElement !== document.body && document.activeElement !== focused)
      )
        return;
      const rows = [...root.value!.querySelectorAll<HTMLElement>('.workspace-file-row')];
      const replacement =
        rows.find((item) => item.dataset.path === path && item.dataset.kind === kind) ??
        rows.find((item) => item.dataset.path === path);
      (
        replacement?.querySelector<HTMLButtonElement>('.workspace-file-select') ?? searchInput.value
      )?.focus({ preventScroll: true });
    });
  },
);
let stopResize: (() => void) | null = null;
function resize(event: PointerEvent, pane: 'sidebar' | 'files'): void {
  if (event.button !== 0) return;
  event.preventDefault();
  workspaceWidth.value = root.value?.clientWidth ?? workspaceWidth.value;
  stopResize?.();
  const startX = event.clientX;
  const initial = pane === 'sidebar' ? actualSidebarWidth.value : actualFilesWidth.value;
  const move = (pointer: PointerEvent) => {
    if (pane === 'sidebar')
      sidebarWidth.value = Math.max(
        180,
        Math.min(
          sidebarLimit.value,
          workspaceWidth.value - actualFilesWidth.value - 380,
          initial + pointer.clientX - startX,
        ),
      );
    else
      filesWidth.value = Math.max(
        280,
        Math.min(filesLimit.value, initial + pointer.clientX - startX),
      );
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    stopResize = null;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  stopResize = stop;
}
function resizeByKey(event: KeyboardEvent, pane: 'sidebar' | 'files'): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault();
  workspaceWidth.value = root.value?.clientWidth ?? workspaceWidth.value;
  const delta = event.key === 'ArrowLeft' ? -20 : 20;
  if (pane === 'sidebar')
    sidebarWidth.value =
      event.key === 'Home'
        ? 210
        : Math.max(
            180,
            Math.min(
              sidebarLimit.value,
              workspaceWidth.value - actualFilesWidth.value - 380,
              actualSidebarWidth.value + delta,
            ),
          );
  else
    filesWidth.value =
      event.key === 'Home'
        ? 340
        : Math.max(280, Math.min(filesLimit.value, actualFilesWidth.value + delta));
}
function focusSearch(): void {
  view.value = 'working';
  void nextTick(() => searchInput.value?.focus());
}
defineExpose({ focusSearch });
onBeforeUnmount(() => {
  stopResize?.();
  widthObserver?.disconnect();
});
</script>

<template>
  <section
    ref="root"
    class="repository-workspace"
    :style="{
      '--workspace-sidebar': `${actualSidebarWidth}px`,
      '--workspace-files': `${actualFilesWidth}px`,
    }"
  >
    <div class="workspace-header"><slot name="header" /></div>
    <div class="workspace-toolbar">
      <slot name="actions" />
      <span v-if="busy && !refreshing" class="workspace-busy" role="status"
        ><LoaderCircle :size="13" class="spinning" />正在执行仓库操作…</span
      >
      <button class="compact-button" :disabled="refreshing || busy" @click="emit('refresh')">
        <RefreshCw :size="14" :class="{ spinning: refreshing }" />刷新
      </button>
    </div>
    <div class="workspace-body">
      <aside class="workspace-sidebar" aria-label="仓库导航与分支">
        <p class="workspace-section-label">仓库</p>
        <nav class="workspace-nav" aria-label="仓库视图">
          <button
            v-for="item in nav"
            :key="item.id"
            :class="{ active: view === item.id }"
            :aria-current="view === item.id ? 'page' : undefined"
            @click="view = item.id"
          >
            <component :is="item.icon" :size="15" /><span>{{ item.label }}</span
            ><b v-if="item.count !== null">{{ item.count }}</b>
          </button>
        </nav>
        <div class="workspace-branches" @keydown="moveBranch">
          <p class="workspace-section-label">
            本地分支 <span>{{ branches?.branches.length ?? '—' }}</span>
          </p>
          <p v-if="branchesLoading && !branches" class="workspace-muted">
            <LoaderCircle :size="13" class="spinning" />读取分支…
          </p>
          <p v-else-if="!localBranches.length" class="workspace-muted">暂无本地分支</p>
          <button
            v-for="branch in localBranches"
            :key="branch.name"
            class="workspace-branch"
            :class="{ current: branch.current, selected: selectedBranch === branch.name }"
            :aria-current="branch.current ? 'true' : undefined"
            :title="`${branch.name}\n${switchBlocker(branch) ?? '双击切换分支'}`"
            @click="selectedBranch = branch.name"
            @dblclick="!switchBlocker(branch) && emit('switchBranch', branch)"
            @keydown.enter.prevent="
              selectedBranch = branch.name;
              !switchBlocker(branch) && emit('switchBranch', branch);
            "
          >
            <GitBranch :size="13" /><span>{{ branch.name }}</span
            ><small v-if="branch.current">HEAD</small
            ><small v-else-if="branch.worktreePath">WT</small>
          </button>
          <p class="workspace-section-label">
            远端分支 <span>{{ branches?.remoteBranches.length ?? '—' }}</span>
          </p>
          <p v-if="!remoteBranches.length" class="workspace-muted">暂无远端分支</p>
          <div
            v-for="branch in remoteBranches"
            :key="branch.name"
            class="workspace-remote"
            :title="branch.name"
          >
            <GitBranch :size="12" /><span>{{ branch.name }}</span>
          </div>
          <template v-if="branches?.worktrees.some((tree) => !tree.current)"
            ><p class="workspace-section-label">关联 Worktree</p>
            <div
              v-for="tree in branches.worktrees.filter((item) => !item.current)"
              :key="tree.path"
              class="workspace-remote"
              :title="tree.path"
            >
              <GitBranch :size="12" /><span>{{ tree.branch ?? 'DETACHED' }}</span
              ><small v-if="tree.prunable">失效</small>
            </div></template
          >
        </div>
        <div v-if="branchInfo" class="workspace-branch-info">
          <strong :title="branchInfo.name">{{ branchInfo.name }}</strong
          ><span :title="branchInfo.upstream ?? undefined">{{
            branchInfo.upstream ?? '未关联 upstream'
          }}</span
          ><span
            ><ArrowUp :size="11" />{{ branchInfo.ahead ?? '—' }} <ArrowDown :size="11" />{{
              branchInfo.behind ?? '—'
            }}</span
          ><button
            class="compact-button"
            :disabled="Boolean(switchBlocker(branchInfo))"
            :title="switchBlocker(branchInfo) ?? undefined"
            @click="switchSelectedBranch"
          >
            {{ branchInfo.current ? '当前分支' : '切换到此分支' }}</button
          ><small v-if="!branchInfo.current && switchBlocker(branchInfo)">{{
            switchBlocker(branchInfo)
          }}</small>
        </div>
        <p v-else class="workspace-sidebar-hint">双击分支或按 Enter 切换</p>
      </aside>
      <div
        class="workspace-splitter"
        role="separator"
        aria-label="调整分支栏宽度"
        aria-orientation="vertical"
        :aria-valuenow="actualSidebarWidth"
        aria-valuemin="180"
        :aria-valuemax="sidebarLimit"
        tabindex="0"
        @pointerdown="resize($event, 'sidebar')"
        @keydown="resizeByKey($event, 'sidebar')"
      />
      <template v-if="view === 'working'">
        <section class="workspace-files" aria-label="工作区文件" @keydown="moveFile">
          <div class="workspace-pane-heading">
            <div>
              <strong>工作区</strong
              ><small>{{ repository.branch ?? 'DETACHED' }} · {{ files.length }} 个文件</small>
            </div>
            <button
              class="compact-button"
              data-focus-return="commit"
              :disabled="
                busy ||
                commitBusy ||
                !repository.config.capabilities.commit ||
                !files.some((file) => file.staged) ||
                Boolean(repository.inProgressOperation)
              "
              @click="emit('commit')"
            >
              <LoaderCircle v-if="commitBusy" :size="13" class="spinning" /><GitCommitHorizontal
                v-else
                :size="13"
              />提交
            </button>
          </div>
          <label class="workspace-file-search"
            ><Search :size="14" /><input
              ref="searchInput"
              v-model="search"
              aria-label="筛选变化文件"
              placeholder="搜索文件路径 ⌘K"
              @keydown.down="enterFileList" /><button
              v-if="search"
              aria-label="清除文件搜索"
              @click="
                search = '';
                searchInput?.focus();
              "
            >
              <X :size="13" /></button
          ></label>
          <div
            v-if="hiddenCheckedCount || (search.trim() && hiddenFileCount)"
            class="workspace-selection-notice"
            role="status"
          >
            <span>{{
              hiddenCheckedCount
                ? `${hiddenCheckedCount} 项勾选被搜索隐藏`
                : '搜索仅影响展示；“全部”包含隐藏项'
            }}</span>
            <button
              @click="
                search = '';
                searchInput?.focus();
              "
            >
              清除筛选
            </button>
          </div>
          <slot name="operation" />
          <div class="workspace-file-scroll" :aria-busy="filesLoading || busy">
            <p v-if="filesLoading && !files.length" class="workspace-empty">
              <LoaderCircle :size="18" class="spinning" />读取文件状态…
            </p>
            <p v-else-if="!files.length" class="workspace-empty">
              <Check :size="22" />工作区干净<span>所有改动均已提交</span>
            </p>
            <p v-else-if="!filteredFiles.length" class="workspace-empty">
              <Search :size="20" />没有匹配的文件
            </p>
            <template v-if="conflicts.length"
              ><div class="workspace-group-heading conflict">
                <strong>冲突</strong><span>{{ conflicts.length }}</span>
              </div>
              <div
                v-for="file in conflicts"
                :key="selectionKey({ path: file.path, kind: 'unstaged' })"
                class="workspace-file-row conflict"
                :data-path="file.path"
                data-kind="unstaged"
              >
                <button
                  class="workspace-file-select"
                  :title="file.path"
                  :aria-label="`查看冲突差异 ${file.path}`"
                  @click="emit('select', file)"
                >
                  <b>!</b
                  ><span class="workspace-file-label"
                    ><span>{{ fileName(file.path) }}</span
                    ><small v-if="fileDirectory(file.path)">{{
                      fileDirectory(file.path)
                    }}</small></span
                  ></button
                ><slot name="file-actions" :file="file" /></div
            ></template>
            <template v-for="kind in scopes" :key="kind">
              <div class="workspace-group-heading" :data-kind="kind">
                <strong>{{ scopeLabel(kind) }}</strong
                ><span
                  >{{ search.trim() ? `${filesForScope(filteredFiles, kind).length} / ` : ''
                  }}{{ filesForScope(files, kind).length }}</span
                ><button
                  :disabled="
                    busy ||
                    filesLoading ||
                    !repository.config.capabilities.stage ||
                    !filesForScope(files, kind).length
                  "
                  :title="
                    selectedPaths(kind).length
                      ? `操作此组勾选的 ${selectedPaths(kind).length} 个文件`
                      : `操作全部${scopeLabel(kind)}文件，包含搜索隐藏的文件`
                  "
                  @click="scopeAction(kind)"
                >
                  {{
                    selectedPaths(kind).length
                      ? kind === 'staged'
                        ? '取消所选'
                        : '暂存所选'
                      : kind === 'staged'
                        ? '取消全部'
                        : '暂存全部'
                  }}
                  <span v-if="selectedPaths(kind).length"> · {{ selectedPaths(kind).length }}</span>
                </button>
              </div>
              <div
                v-for="file in filesForScope(filteredFiles, kind)"
                :key="selectionKey({ path: file.path, kind })"
                class="workspace-file-row"
                :data-path="file.path"
                :data-kind="kind"
                :class="{
                  active: diff?.path === file.path && diff.kind === kind,
                  checked: checked.has(selectionKey({ path: file.path, kind })),
                }"
              >
                <input
                  type="checkbox"
                  :checked="checked.has(selectionKey({ path: file.path, kind }))"
                  :aria-label="`选择${scopeLabel(kind)}文件 ${file.path}`"
                  :disabled="busy"
                  @change="toggle(file, kind)"
                />
                <button
                  class="workspace-file-select"
                  :aria-pressed="diff?.path === file.path && diff.kind === kind"
                  :aria-label="`查看${scopeLabel(kind)}差异 ${file.path}`"
                  :title="file.originalPath ? `${file.originalPath} → ${file.path}` : file.path"
                  @click="emit('select', file, kind)"
                >
                  <b
                    :class="{
                      staged: kind === 'staged',
                      untracked: file.untracked,
                      deleted: (kind === 'staged' ? file.indexStatus : file.worktreeStatus) === 'D',
                    }"
                    >{{
                      file.untracked
                        ? 'U'
                        : kind === 'staged'
                          ? file.indexStatus
                          : file.worktreeStatus
                    }}</b
                  ><span class="workspace-file-label"
                    ><span>{{ fileName(file.path) }}</span
                    ><small v-if="fileDirectory(file.path)">{{
                      fileDirectory(file.path)
                    }}</small></span
                  ><i v-if="file.staged && file.unstaged" title="此文件还有另一范围的改动">●</i>
                </button>
                <slot v-if="kind === 'unstaged'" name="file-actions" :file="file" />
                <button
                  class="workspace-file-stage"
                  :disabled="busy || filesLoading || !repository.config.capabilities.stage"
                  :aria-label="`${kind === 'staged' ? '取消暂存' : '暂存'} ${file.path}`"
                  :title="kind === 'staged' ? '取消暂存' : '暂存'"
                  @click="emit('stage', [file.path], kind === 'staged' ? 'unstage' : 'stage')"
                >
                  <Minus v-if="kind === 'staged'" :size="13" /><Plus v-else :size="13" />
                </button>
              </div>
              <p
                v-if="files.length && !filesForScope(filteredFiles, kind).length"
                class="workspace-scope-empty"
              >
                {{
                  search
                    ? '此范围没有匹配文件'
                    : kind === 'staged'
                      ? '暂存文件后即可提交'
                      : '没有未暂存改动'
                }}
              </p>
            </template>
          </div>
          <div class="workspace-file-summary">
            <span
              >{{ checked.size ? `已勾选 ${checked.size} 项` : '↑ ↓ 浏览 · 空格勾选'
              }}<button
                v-if="checked.size"
                @click="
                  checked = new Set();
                  searchInput?.focus();
                "
              >
                清空勾选
              </button></span
            ><span v-if="filesLoading"><LoaderCircle :size="11" class="spinning" />刷新中</span
            ><span v-else>{{ filteredFiles.length }} / {{ files.length }} 个文件</span>
          </div>
        </section>
        <div
          class="workspace-splitter"
          role="separator"
          aria-label="调整文件栏宽度"
          aria-orientation="vertical"
          :aria-valuenow="actualFilesWidth"
          aria-valuemin="280"
          :aria-valuemax="filesLimit"
          tabindex="0"
          @pointerdown="resize($event, 'files')"
          @keydown="resizeByKey($event, 'files')"
        />
        <section class="workspace-preview" aria-label="文件差异预览" :aria-busy="diffLoading">
          <template v-if="diff"
            ><div class="workspace-diff-heading">
              <strong :title="diff.path"
                ><FileDiff :size="15" /><span>{{ diff.path }}</span></strong
              ><button
                class="table-icon-button"
                aria-label="清除 Diff 预览"
                title="清除 Diff 预览"
                @click="emit('clearDiff')"
              >
                <X :size="14" />
              </button>
            </div>
            <div class="workspace-diff-meta">
              <div class="diff-kind-tabs" aria-label="差异范围">
                <button
                  v-for="kind in scopes"
                  :key="kind"
                  class="diff-kind-tab"
                  :class="{ active: diff.kind === kind }"
                  :aria-pressed="diff.kind === kind"
                  :disabled="busy || !currentFile?.[kind]"
                  @click="emit('switchKind', kind)"
                >
                  {{ scopeLabel(kind) }}
                </button>
              </div>
              <button
                v-if="canCollapsePatchHeaders"
                class="workspace-patch-toggle"
                :aria-pressed="showPatchHeaders"
                :aria-label="showPatchHeaders ? '隐藏补丁信息' : '显示补丁信息'"
                @click="showPatchHeaders = !showPatchHeaders"
              >
                补丁信息
              </button>
              <template v-if="presentation && !diffLoading && !diffError"
                ><span>{{ presentation.languageLabel }}</span
                ><span class="addition">+{{ presentation.additions }}</span
                ><span class="deletion">−{{ presentation.deletions }}</span></template
              >
            </div>
            <p v-if="previewHiddenBySearch" class="workspace-preview-notice">
              此文件被当前搜索隐藏，预览仍保留。
            </p>
            <div ref="preview" class="workspace-diff-scroll" @scroll.passive="rememberScroll">
              <p v-if="diffLoading" class="workspace-empty" role="status">
                <LoaderCircle :size="20" class="spinning" />读取差异…
              </p>
              <div v-else-if="diffError" class="workspace-empty" role="alert">
                <span>{{ diffError }}</span
                ><button
                  class="compact-button"
                  :disabled="refreshing || busy"
                  @click="emit('refresh')"
                >
                  刷新后重试
                </button>
              </div>
              <DiffView
                v-else-if="inlinePresentation"
                :presentation="inlinePresentation"
                :label="`${diff.path} Git Diff`"
                :hunk-action-label="
                  busy || filesLoading || !diff.diff ? undefined : hunkActionLabel
                "
                :pending-hunk-index="pendingHunk"
                @hunk-action="emit('hunk', $event)"
              /></div
          ></template>
          <div v-else class="workspace-empty workspace-preview-empty">
            <FileDiff :size="36" /><strong>选择文件，查看变化</strong
            ><span>已暂存与未暂存差异分别展示</span>
          </div>
        </section>
      </template>
      <section
        v-else
        class="workspace-secondary"
        :aria-label="nav.find((item) => item.id === view)?.label"
      >
        <slot v-if="view === 'history'" name="history" /><slot
          v-else-if="view === 'stash'"
          name="stash"
        /><slot v-else name="tags" />
      </section>
    </div>
    <div
      v-if="feedback.text"
      class="workspace-feedback"
      :class="feedback.tone"
      :role="feedback.tone === 'error' ? 'alert' : 'status'"
    >
      <AlertTriangle v-if="feedback.tone !== 'success'" :size="13" /><Check v-else :size="13" />
      <span>{{ feedback.text }}</span>
      <button
        v-if="error || message"
        class="table-icon-button"
        aria-label="关闭工作台提示"
        @click="emit('dismissFeedback')"
      >
        <X :size="13" />
      </button>
    </div>
    <footer class="workspace-footer"><slot name="footer" /></footer>
  </section>
</template>
