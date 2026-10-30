<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  Ban,
  Bookmark,
  Check,
  ChevronRight,
  Code2,
  Copy,
  EyeOff,
  FolderGit2,
  FolderOpen,
  FolderClosed,
  FileDiff,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Fingerprint,
  History,
  List,
  ListTree,
  LoaderCircle,
  Minus,
  Search,
  Tag,
  Trash2,
  Undo2,
  Unlock,
  X,
} from 'lucide-vue-next';
import type { CommitPageQuery, BranchesSnapshot, FileChange, IgnoredEntry, MarkedFile, MergeSource, RepositoryStatus, StashEntry, TagEntry } from '../../shared/contracts';
import type { PresentedDiff } from '../diff-presentation';
import type { RepositoryDiff } from '../use-repository-diff';
import { buildFileTree, collapsedDuringSearch, flattenTree, type FileTreeNode } from '../file-tree';
import { useFileListView } from '../file-list-view';
import { checkedUncommittedPaths, commitSelection, fileExistsInWorktree, fileMenuItems, fileStageAction, filesForScope, selectionKey, type DiffKind, type FileMenuAction } from '../repository-workspace';
import type { Notice } from '../notices';
import { workspacePaneWidths } from '../workspace-layout';
import { branchDivergenceLabel, compareBranchNames } from '../branch-presentation';
import { historyReferencesRevision } from '../history-revision';
import ActionMenu from './ActionMenu.vue';
import SurfaceNotice from './SurfaceNotice.vue';
import DiffView from './DiffView.vue';
import RepositoryHistory from './RepositoryHistory.vue';
import RepositoryReferences from './RepositoryReferences.vue';
import RepositoryTree from './RepositoryTree.vue';
import RepositoryReflog from './RepositoryReflog.vue';
import ConflictPreview from './ConflictPreview.vue';
import { useReadingNavigation, type WorkspaceReading, type RevisionReading, type ReflogReading } from '../workspace-reading';
import '../repository-workspace.css';

const props = defineProps<{
  repository: RepositoryStatus;
  files: FileChange[];
  filesLoading: boolean;
  /** 文件列表读取失败的原因；为空表示读取成功。 */
  filesError: string;
  stashes: StashEntry[];
  tags: TagEntry[];
  stashesLoading: boolean;
  tagsLoading: boolean;
  branches: BranchesSnapshot | null;
  branchesLoading: boolean;
  branchBlocker: string | null;
  remoteBranchBlocker: string | null;
  busy: boolean;
  /**
   * 是否有「会改索引或工作区」的操作在跑（提交、切分支、丢弃、Stash…）。
   *
   * 勾选框不能跟着 `busy` 一起禁用：`busy` 还包括暂存自己与提交预览的读取，
   * 而暂存是要排队执行的、预览读取是只读的。禁用会让连续勾选被静默丢掉
   * （用户以为两个文件都进了提交，实际只有一个）。
   */
  stageLocked?: boolean;
  /** 正在批量删除未提交文件；只用于按钮内的忙碌反馈。 */
  discardBusy?: boolean;
  commitBusy: boolean;
  refreshing: boolean;
  diff: RepositoryDiff | null;
  presentation: PresentedDiff | null;
  diffLoading: boolean;
  diffError: string;
  hunkActionLabel?: string;
  pendingHunk: number | null;
  /** 别的写操作在跑时禁用块按钮；不含「正在执行的那一块」与只读的提交预览。 */
  hunkActionBlocked?: boolean;
  /** 属于这个仓库的一条消息，由父级按 `repository:<id>` 取好再传进来。 */
  notice?: Notice;
  ignoredFiles: IgnoredEntry[];
  ignoredLoading: boolean;
  ignoredTruncated: boolean;
  showIgnoredFiles: boolean;
  markedFiles: MarkedFile[];
  markedLoading: boolean;
  showMarkedFiles: boolean;
}>();
/** 右键菜单的主体：三种清单的条目形状不同，用受判别联合避免类型断言。 */
type FileMenuTarget =
  | { kind: 'file'; file: FileChange }
  | { kind: 'ignored'; entry: IgnoredEntry }
  | { kind: 'marked'; entry: MarkedFile };
const emit = defineEmits<{
  select: [file: FileChange, kind?: DiffKind];
  stage: [paths: string[], action: 'stage' | 'unstage'];
  discardUntracked: [paths: string[]];
  deleteBranch: [branch: BranchesSnapshot['branches'][number]];
  switchBranch: [branch: BranchesSnapshot['branches'][number]];
  checkoutRemoteBranch: [branch: BranchesSnapshot['remoteBranches'][number]];
  deleteRemoteBranch: [branch: BranchesSnapshot['remoteBranches'][number]];
  mergeBranch: [source: MergeSource];
  switchKind: [kind: DiffKind];
  hunk: [index: number];
  refresh: [];
  refreshStashes: [];
  refreshTags: [];
  clearDiff: [];
  dismissFeedback: [];
  resolveConflict: [file: FileChange, strategy: 'ours' | 'theirs', fingerprint: string];
  fileAction: [file: FileChange, action: FileMenuAction];
  ignoredAction: [entry: IgnoredEntry, action: FileMenuAction];
  markedAction: [entry: MarkedFile, action: FileMenuAction];
  toggleIgnored: [visible: boolean];
  toggleMarked: [visible: boolean];
  /** 把某条提交应用到当前分支：回退（反向）/ 拣选（正向）。 */
  revertCommit: [hash: string];
  cherryPickCommit: [hash: string];
}>();
type View = WorkspaceReading['view'];
const view = ref<View>('working');
let initialViewResolved = false;
function chooseView(next: View): void {
  initialViewResolved = true;
  navigate(() => { view.value = next; });
}
const search = ref('');
const selectedBranch = ref<string | null>(null);
const historyReference = ref<string | undefined>();
const historyScope = ref<NonNullable<CommitPageQuery['scope']>>('all');
const comparisonBase = ref<string | undefined>();
const historyFilePath = ref<string | undefined>();
const historyStartTip = ref<string | undefined>();
const referencesPanel = ref<InstanceType<typeof RepositoryReferences> | null>(null);
const historyPanel = ref<InstanceType<typeof RepositoryHistory> | null>(null);
const treePanel = ref<InstanceType<typeof RepositoryTree> | null>(null);
const reflogPanel = ref<InstanceType<typeof RepositoryReflog> | null>(null);
const treeCommit = ref(''), treePath = ref<string>(), treeBlame = ref(false);
function browseTree(commit: string, path?: string, blame = false): void {
  const current = captureReading(); const token = ++navigationRestore;
  initialViewResolved = true; treeCommit.value = commit; treePath.value = path; treeBlame.value = blame; view.value = 'tree';
  preserveReadingFocus();
  const next: RevisionReading = { commit, directory: path?.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', path: path ?? null, blame, skip: 0, search: '', listTop: 0, previewTop: 0, previewLeft: 0 };
  readingNavigation.visit(current, { ...captureReading(), tree: next });
  void nextTick(() => { if (token === navigationRestore) void treePanel.value?.restore(next); });
}
function browseCommit(hash: string): void { navigate(() => setHistory(undefined, 'ref', null, undefined, hash)); }
function recordTree(reading: RevisionReading): void { navigationRestore++; readingNavigation.visit(captureReading(), { ...captureReading(), tree: reading }); }
function recordReflog(reading: ReflogReading): void { navigationRestore++; readingNavigation.visit(captureReading(), { ...captureReading(), reflog: reading }); }
const historyBranchLabel = computed(() => historyStartTip.value ? `提交 ${historyStartTip.value.slice(0, 7)}` : historyScope.value === 'all' ? '所有本地分支、远端分支与标签' : historyReference.value?.replace(/^refs\/(heads|remotes)\//, '') ?? props.branches?.currentBranch ?? 'HEAD');
const historyRevision = computed(() => {
  if (historyStartTip.value) return historyStartTip.value;
  if (historyScope.value === 'outgoing' || historyScope.value === 'incoming') {
    const branch = props.branches?.branches.find(branch => `refs/heads/${branch.name}` === historyReference.value);
    const upstreamHead = props.branches?.remoteBranches.find(item => item.name === branch?.upstream)?.head ?? props.branches?.branches.find(item => item.name === branch?.upstream)?.head;
    return JSON.stringify([branch?.head, branch?.upstream, upstreamHead]);
  }
  if (historyScope.value === 'compare') return JSON.stringify([historyReferencesRevision(props.branches, [], null), comparisonBase.value]);
  if (historyScope.value === 'all') return historyReferencesRevision(props.branches, props.tags, props.repository.latestTag);
  if (!historyReference.value) return props.branches?.head ?? '';
  if (historyReference.value.startsWith('refs/heads/')) return props.branches?.branches.find(branch => `refs/heads/${branch.name}` === historyReference.value)?.head ?? '';
  return props.branches?.remoteBranches.find(branch => `refs/remotes/${branch.name}` === historyReference.value)?.head ?? '';
});
function setHistory(reference?: string, scope: NonNullable<CommitPageQuery['scope']> = 'ref', branch: string | null = null, filePath?: string, tip?: string): void {
  initialViewResolved = true;
  selectedBranch.value = branch; historyReference.value = reference; historyScope.value = scope;
  comparisonBase.value = undefined;
  historyFilePath.value = filePath; historyStartTip.value = tip; view.value = 'history';
}
function browseBranch(name: string, remote = false): void {
  navigate(() => setHistory(`refs/${remote ? 'remotes' : 'heads'}/${name}`, 'ref', remote ? null : name));
}
function browseOutgoing(name: string): void { navigate(() => setHistory(`refs/heads/${name}`, 'outgoing', name)); }
function browseIncoming(name: string): void { navigate(() => setHistory(`refs/heads/${name}`, 'incoming', name)); }
const comparisonOptions = computed(() => [
  ...(props.branches?.branches ?? []).slice().sort((a, b) => compareBranchNames(a.name, b.name)).map(branch => ({ value: `refs/heads/${branch.name}`, label: branch.name, hint: '本地分支' })),
  ...(props.branches?.remoteBranches ?? []).slice().sort((a, b) => compareBranchNames(a.name, b.name)).map(branch => ({ value: `refs/remotes/${branch.name}`, label: branch.name, hint: '远端跟踪分支' })),
]);
function compareBranches(source?: string, base?: string): void {
  const current = props.branches?.currentBranch ? `refs/heads/${props.branches.currentBranch}` : undefined;
  const valid = (value?: string) => comparisonOptions.value.some(option => option.value === value);
  const sourceRef = valid(source) ? source! : valid(historyReference.value) ? historyReference.value! : current ?? comparisonOptions.value[0]?.value;
  const baseRef = valid(base) ? base! : current && current !== sourceRef ? current : comparisonOptions.value.find(option => option.value !== sourceRef)?.value;
  if (!sourceRef || !baseRef) return;
  navigate(() => { setHistory(sourceRef, 'compare', sourceRef.startsWith('refs/heads/') ? sourceRef.slice(11) : null); comparisonBase.value = baseRef; });
}
function browseHead(): void { navigate(() => setHistory()); }
function browseAll(): void { navigate(() => setHistory(undefined, 'all')); }
function browseFile(filePath: string, tip?: string): void {
  navigate(() => setHistory(tip ? historyReference.value : undefined, 'ref', tip ? selectedBranch.value : null, filePath, tip));
  void nextTick(() => historyPanel.value?.focusSearch());
}
const searchInput = ref<HTMLInputElement | null>(null);
const root = ref<HTMLElement | null>(null);
const preview = ref<HTMLElement | null>(null);
const workingList = ref<HTMLElement | null>(null);
let workingListTop = 0;
const sidebarWidth = ref<number | null>(null);
const filesWidth = ref<number | null>(null);
const workspaceWidth = ref(1440);
const paneWidths = computed(() => workspacePaneWidths(workspaceWidth.value, sidebarWidth.value, filesWidth.value));
const sidebarLimit = computed(() => paneWidths.value.sidebarMax);
const actualSidebarWidth = computed(() => paneWidths.value.sidebarWidth);
const filesLimit = computed(() => paneWidths.value.filesMax);
const actualFilesWidth = computed(() => paneWidths.value.filesWidth);
let widthObserver: ResizeObserver | null = null;
onMounted(() => {
  widthObserver = new ResizeObserver(([entry]) => {
    if (entry) workspaceWidth.value = entry.contentRect.width;
  });
  if (root.value) widthObserver.observe(root.value);
  window.addEventListener('keydown', selectFileByArrow);
});
const scopes: DiffKind[] = ['unstaged', 'staged'];
const scopeLabel = (kind: DiffKind) => (kind === 'staged' ? '已暂存' : '未暂存');
const filteredFiles = computed(() =>
  props.files.filter((file) =>
    file.path.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const ordinaryFiles = computed(() => filteredFiles.value.filter(file => !file.conflicted));
const selection = computed(() => commitSelection(ordinaryFiles.value));
/** 勾选（已暂存）且全部是未提交新文件时，才提供批量删除；混入已跟踪文件时为空。 */
const deletablePaths = computed(() => checkedUncommittedPaths(props.files));
const fileListView = useFileListView();
type WorkspaceRow =
  | { kind: 'directory'; node: FileTreeNode; depth: number }
  /** `skipDirectory`：这一行的目录已经从上下文看得出来，不再重复渲染路径小字。 */
  | { kind: 'file'; file: FileChange; depth: number; skipDirectory: boolean };
/** 用户折叠过的目录，默认全展开。仓库切换时本组件以仓库 id 为 key 重建，所以不需要额外重置。 */
const collapsedDirectories = ref<string[]>([]);
const ordinaryTree = computed(() => buildFileTree(ordinaryFiles.value.map((file) => file.path)));
/** 搜索时把命中文件的祖先目录全部展开，否则命中结果可能藏在折叠目录里看不见。 */
const searchCollapsedOverrides = ref<string[]>([]);
// 搜索词一改，命中集合就换了，上一轮的临时折叠不再有意义。
watch(search, () => { searchCollapsedOverrides.value = []; });
const effectiveCollapsed = computed(() =>
  search.value.trim()
    ? collapsedDuringSearch(collapsedDirectories.value, ordinaryFiles.value.map((file) => file.path), searchCollapsedOverrides.value)
    : new Set(collapsedDirectories.value),
);
const workspaceRows = computed<WorkspaceRow[]>(() => {
  if (fileListView.view.value !== 'tree') {
    // 平铺清单里连续同目录的文件不再重复第三行路径：`src/client` 连写四遍只是噪声，
    // 目录一变（或回到根目录）才重新标出来。
    let previousDirectory = '';
    return ordinaryFiles.value.map((file) => {
      const directory = fileDirectory(file.path);
      const skipDirectory = Boolean(directory) && directory === previousDirectory;
      previousDirectory = directory;
      return { kind: 'file' as const, file, depth: 0, skipDirectory };
    });
  }
  const filesByPath = new Map(ordinaryFiles.value.map((file) => [file.path, file]));
  // 树形视图的目录行已经交代了层级，文件行再写一遍完整路径是纯重复。
  return flattenTree(ordinaryTree.value, effectiveCollapsed.value).flatMap(({ node, depth }): WorkspaceRow[] => {
    if (node.kind === 'directory') return [{ kind: 'directory', node, depth }];
    const file = filesByPath.get(node.path);
    return file ? [{ kind: 'file', file, depth, skipDirectory: true }] : [];
  });
});
function isDirectoryOpen(node: FileTreeNode): boolean {
  return !effectiveCollapsed.value.has(node.path);
}
function toggleDirectory(node: FileTreeNode): void {
  // 搜索期间的折叠只作用于这一次搜索：改动记在 overrides 上，不清洗用户的持久折叠状态，
  // 清掉搜索后目录回到搜索前的样子。
  if (search.value.trim()) {
    const next = new Set(searchCollapsedOverrides.value);
    if (next.has(node.path)) next.delete(node.path);
    else next.add(node.path);
    searchCollapsedOverrides.value = [...next];
    return;
  }
  const next = new Set(collapsedDirectories.value);
  if (next.has(node.path)) next.delete(node.path);
  else next.add(node.path);
  collapsedDirectories.value = [...next];
}
/** ← → 折叠/展开，空格与 Enter 等价于点击（preventDefault 阻止浏览器再合成一次 click）。 */
function directoryKey(event: KeyboardEvent, node: FileTreeNode): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowRight' && !isDirectoryOpen(node)) event.preventDefault();
  else if (event.key === 'ArrowLeft' && isDirectoryOpen(node)) event.preventDefault();
  else if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
  else return;
  toggleDirectory(node);
}
function toggleFileListView(): void {
  fileListView.set(fileListView.view.value === 'tree' ? 'flat' : 'tree');
}
const stagedCount = computed(() => props.files.filter(file => file.staged && !file.conflicted).length);
const hiddenStagedCount = computed(() => props.files.filter(file => file.staged && !file.conflicted && !filteredFiles.value.includes(file)).length);
// 暂存自己正在跑时不锁勾选框：调用方会把后续点击排进队列，执行时再取最新文件 ID。
const stageBlocked = computed(() => Boolean(props.stageLocked) || props.filesLoading || props.refreshing || !props.repository.config.capabilities.stage);
const conflicts = computed(() => filteredFiles.value.filter((file) => file.conflicted));
const localBranches = computed(() => {
  const branches = props.branches?.branches ?? [];
  const primary = branches.some(branch => branch.name === 'main') ? 'main' : 'master';
  return [...branches].sort((a, b) => compareBranchNames(a.name, b.name, primary));
});
const remoteGroups = computed(() => {
  const groups = new Map<string, BranchesSnapshot['remoteBranches']>();
  for (const branch of props.branches?.remoteBranches ?? []) {
    const group = groups.get(branch.remote) ?? [];
    group.push(branch);
    groups.set(branch.remote, group);
  }
  return [...groups].sort(([a], [b]) => Number(b === 'origin') - Number(a === 'origin') || a.localeCompare(b))
    .map(([name, branches]) => ({ name, branches: [...branches].sort((a, b) =>
      compareBranchNames(a.branch, b.branch, branches.some(branch => branch.branch === 'main') ? 'main' : 'master')) }));
});
const branchInfo = computed(() =>
  props.branches?.branches.find((branch) => branch.name === selectedBranch.value),
);
const mergeSource = computed<MergeSource | null>(() => {
  if (view.value !== 'history' || !historyReference.value || historyScope.value !== 'ref') return null;
  if (historyReference.value.startsWith('refs/heads/')) return { kind: 'local', name: historyReference.value.slice(11) };
  if (historyReference.value.startsWith('refs/remotes/')) return { kind: 'remote', name: historyReference.value.slice(13) };
  return null;
});
const mergeEnabled = computed(() => !props.busy && !props.refreshing && !props.branchesLoading && !props.filesLoading && Boolean(props.branches?.currentBranch) && props.repository.config.capabilities.stage && props.repository.config.capabilities.commit);
const draggedBranch = ref<MergeSource | null>(null);
const dragTarget = ref<string | null>(null);
let stopBranchDrag: (() => void) | null = null;
let suppressBranchClick = false;
let branchClickTimer: ReturnType<typeof setTimeout> | null = null;
function clickBranch(name: string, remote = false): void {
  if (!suppressBranchClick) browseBranch(name, remote);
}
function startBranchDrag(event: PointerEvent, source: MergeSource): void {
  if (event.button !== 0 || !event.isPrimary || !mergeEnabled.value) return;
  stopBranchDrag?.();
  const origin = event.currentTarget as HTMLElement;
  const repositoryId = props.repository.config.id;
  const startX = event.clientX, startY = event.clientY;
  let canceled = false;
  origin.setPointerCapture(event.pointerId);
  const targetAt = (pointer: PointerEvent): string | null => {
    const row = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>('[data-merge-target]');
    return row && root.value?.contains(row) ? row.dataset.mergeTarget ?? null : null;
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', drop);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('blur', stop);
    window.removeEventListener('keydown', escape, true);
    if (origin.hasPointerCapture(event.pointerId)) origin.releasePointerCapture(event.pointerId);
    draggedBranch.value = null; dragTarget.value = null; stopBranchDrag = null;
    suppressBranchClick = false;
  };
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== event.pointerId || canceled) return;
    if (!mergeEnabled.value || repositoryId !== props.repository.config.id) { stop(); return; }
    if (!draggedBranch.value && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
    if (!draggedBranch.value) origin.focus({ preventScroll: true });
    draggedBranch.value = source; dragTarget.value = targetAt(pointer);
    suppressBranchClick = true;
    pointer.preventDefault();
  };
  const drop = (pointer: PointerEvent) => {
    if (pointer.pointerId !== event.pointerId) return;
    const active = Boolean(draggedBranch.value), target = targetAt(pointer);
    stop();
    if (active || canceled) {
      suppressBranchClick = true;
      if (branchClickTimer) clearTimeout(branchClickTimer);
      branchClickTimer = setTimeout(() => { suppressBranchClick = false; branchClickTimer = null; }, 0);
    }
    if (active && !canceled) {
      if (mergeEnabled.value && repositoryId === props.repository.config.id && target === props.branches?.currentBranch && !(source.kind === 'local' && source.name === target)) emit('mergeBranch', source);
    }
  };
  const escape = (key: KeyboardEvent) => {
    if (key.key !== 'Escape' || !draggedBranch.value) return;
    key.preventDefault(); key.stopImmediatePropagation();
    canceled = true; draggedBranch.value = null; dragTarget.value = null;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', drop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  window.addEventListener('keydown', escape, true);
  stopBranchDrag = stop;
}
function branchTrackingLabel(branch: BranchesSnapshot['branches'][number]): string {
  if (!branch.upstream) return '未关联 upstream，无法确定待推送或待拉取数量';
  if (branch.ahead === null || branch.behind === null) return `upstream ${branch.upstream} 不可用，待推送或待拉取数量未知`;
  return `${branchDivergenceLabel(branch)}\n相对 ${branch.upstream}，基于最近 Fetch 的本地引用`;
}
watch(
  [() => props.filesLoading, () => props.branchesLoading, () => props.branches, () => props.files, () => props.busy, () => props.notice],
  () => {
    if (initialViewResolved || props.filesLoading || props.branchesLoading || !props.branches || props.busy) return;
    initialViewResolved = true;
    if (props.notice?.severity === 'error' || props.files.length || props.repository.inProgressOperation || !props.branches.head) return;
    setHistory(props.branches.currentBranch ? `refs/heads/${props.branches.currentBranch}` : undefined, 'ref', props.branches.currentBranch);
  },
  { immediate: true, flush: 'post' },
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
function focusClickedControl(event: MouseEvent): void {
  // WKWebView does not focus buttons on mouse click by default. Keep subsequent
  // arrow/Space navigation and mutation focus restoration on the chosen control.
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>('button');
  if (button && !button.disabled && root.value?.contains(button))
    button.focus({ preventScroll: true });
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
function toggle(file: FileChange): void {
  if (stageBlocked.value || file.conflicted) return;
  emit('stage', [file.path], fileStageAction(file));
}
function toggleAll(): void {
  if (stageBlocked.value) return;
  const action = selection.value.all ? 'unstage' : 'stage';
  const paths = ordinaryFiles.value.filter(file => action === 'stage' ? file.unstaged : file.staged).map(file => file.path);
  if (paths.length) emit('stage', paths, action);
}
function uncheckVisible(): void {
  if (stageBlocked.value) return;
  const paths = ordinaryFiles.value.filter(file => file.staged).map(file => file.path);
  if (paths.length) emit('stage', paths, 'unstage');
}
const branchMenu = ref<InstanceType<typeof ActionMenu> | null>(null);
const menuBranchName = ref('');
const menuBranchRemote = ref(false);
const menuBranch = computed(() => localBranches.value.find(branch => branch.name === menuBranchName.value));
const menuRemoteBranch = computed(() => props.branches?.remoteBranches.find(branch => branch.name === menuBranchName.value));
function remoteCheckoutBlocker(): string | null {
  if (props.busy || props.refreshing || props.branchesLoading || props.filesLoading) return '正在读取或操作仓库';
  return props.remoteBranchBlocker;
}
/** 删除远端分支只受「远端写入」能力、忙碌与进行中操作限制；不由本地工作区状态决定。 */
function remoteDeleteBlocker(): string | null {
  if (!props.repository.config.capabilities.push) return '仓库配置禁止远端写入';
  if (props.busy || props.refreshing || props.branchesLoading) return '正在读取或操作仓库';
  if (props.repository.inProgressOperation) return '请先完成进行中的 Git 操作';
  return null;
}
function deleteBlocker(branch: BranchesSnapshot['branches'][number]): string | null {
  if (branch.current) return '当前分支不能删除，请先切换分支';
  if (branch.worktreePath) return '分支被其他 Worktree 占用';
  if (props.busy || props.refreshing || props.branchesLoading) return '正在读取或操作仓库';
  if (props.repository.inProgressOperation) return '请先完成进行中的 Git 操作';
  return null;
}
const branchMenuItems = computed(() => menuBranchRemote.value ? [
  { id: 'browse', label: '查看提交历史', icon: History },
  { id: 'checkout-remote', label: '创建本地分支并切换…', icon: GitBranch, disabled: menuRemoteBranch.value ? remoteCheckoutBlocker() : '远端分支已不存在' },
  { id: 'delete-remote', label: '删除远端分支…', icon: Trash2, danger: true, disabled: menuRemoteBranch.value ? remoteDeleteBlocker() : '远端分支已不存在' },
] : [
  { id: 'browse', label: '查看提交历史', icon: History },
  { id: 'switch', label: '切换到此分支', icon: GitBranch, disabled: menuBranch.value ? switchBlocker(menuBranch.value) : '分支已不存在' },
  { id: 'delete', label: '删除本地分支…', icon: Trash2, danger: true, disabled: menuBranch.value ? deleteBlocker(menuBranch.value) : '分支已不存在' },
]);
function openBranchMenu(event: MouseEvent | KeyboardEvent, name: string, remote = false): void {
  menuBranchName.value = name;
  menuBranchRemote.value = remote;
  void branchMenu.value?.open(event);
}
function branchMenuAction(action: string): void {
  if (menuBranchRemote.value) {
    const branch = menuRemoteBranch.value;
    if (!branch) return;
    if (action === 'browse') browseBranch(branch.name, true);
    else if (action === 'checkout-remote' && !remoteCheckoutBlocker()) emit('checkoutRemoteBranch', branch);
    else if (action === 'delete-remote' && !remoteDeleteBlocker()) emit('deleteRemoteBranch', branch);
    return;
  }
  const branch = menuBranch.value;
  if (!branch) return;
  if (action === 'browse') browseBranch(branch.name);
  else if (action === 'switch' && !switchBlocker(branch)) emit('switchBranch', branch);
  else if (action === 'delete' && !deleteBlocker(branch)) emit('deleteBranch', branch);
}
const fileMenu = ref<InstanceType<typeof ActionMenu> | null>(null);
const menuTarget = ref<FileMenuTarget | null>(null);
const fileMenuIcons: Record<FileMenuAction, Component> = {
  'ignore-path': Ban,
  'ignore-name': Ban,
  'ignore-pattern': Ban,
  'exclude-path': Ban,
  'exclude-name': Ban,
  'exclude-pattern': Ban,
  unignore: Undo2,
  assume: EyeOff,
  unassume: Unlock,
  reveal: FolderOpen,
  editor: Code2,
  'copy-path': Copy,
};
const fileMenuTitle = computed(() => menuTarget.value ? (menuTarget.value.kind === 'file' ? menuTarget.value.file.path : menuTarget.value.entry.path) : '文件操作');
const fileMenuNavItems = computed(() => {
  const target = menuTarget.value;
  if (!target) return [];
  const items = target.kind === 'ignored'
    ? fileMenuItems({ path: target.entry.path, ignored: true })
    : target.kind === 'marked'
      ? fileMenuItems({ path: target.entry.path, marked: true })
      : fileMenuItems({
        path: target.file.path,
        untracked: target.file.untracked,
        conflicted: target.file.conflicted,
        exists: fileExistsInWorktree(target.file),
      });
  return items.map((item) => ({ ...item, icon: fileMenuIcons[item.id] }));
});
function openFileMenu(event: MouseEvent | KeyboardEvent, target: FileMenuTarget): void {
  menuTarget.value = target;
  void fileMenu.value?.open(event);
}
function fileMenuAction(action: string): void {
  const target = menuTarget.value;
  if (!target) return;
  const typed = action as FileMenuAction;
  if (target.kind === 'ignored') emit('ignoredAction', target.entry, typed);
  else if (target.kind === 'marked') emit('markedAction', target.entry, typed);
  else emit('fileAction', target.file, typed);
}
/** 已忽略条目可能以 `/` 结尾（被折叠的目录），展示前去掉。 */
function ignoredLabelParts(relativePath: string): { name: string; directory: string } {
  const trimmed = relativePath.replace(/\/+$/, '');
  return { name: fileName(trimmed), directory: fileDirectory(trimmed) };
}
watch(() => props.branches, snapshot => {
  if (!snapshot || !selectedBranch.value || snapshot.branches.some(branch => branch.name === selectedBranch.value)) return;
  // Deleting the branch being read must not leave a dangling history reference.
  if (snapshot.currentBranch) browseBranch(snapshot.currentBranch);
  else browseHead();
});
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
    // 只靠 `toggle()` 自己的 `stageBlocked` 判定。这里以前还多加一条 `!props.busy`，
    // 而 `busy` 含「暂存自己」——勾完一个文件马上按空格勾下一个，那次按键会被静默吞掉。
    // 鼠标走的是 `:disabled="stageBlocked"` 的 checkbox，两条路径必须同一个口径。
    if (file) toggle(file);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.workspace-file-select, .file-tree-directory'))
    return;
  const controls = [...root.value!.querySelectorAll<HTMLButtonElement>('.workspace-file-select, .file-tree-directory')];
  const index = controls.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  controls[next]?.focus();
  // 目录行只移动焦点，不因为「路过」就展开/折叠；文件行仍按既有行为预览差异。
  if (controls[next]?.matches('.workspace-file-select')) controls[next]?.click();
}
function enterFileList(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const first = root.value?.querySelector<HTMLButtonElement>('.workspace-file-select, .file-tree-directory');
  if (!first) return;
  event.preventDefault();
  first.focus();
  first.click();
}
/**
 * 焦点落在空白处（阅读差异时点了背景、或刚打开工作区）时，上下键不该是死键：
 * 空预览上写着「↑↓ 选择文件」，那这个键位就得真的能进列表。焦点已经在任何控件里时直接让行，
 * 分支列表、菜单、输入框各有自己的上下键语义。
 */
function selectFileByArrow(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (!root.value?.getClientRects().length) return;
  if (event.target instanceof Element) {
    if (event.target.closest('button, input, textarea, select, a[href], summary, [role="menu"], [contenteditable="true"]')) return;
    // 别的浮层（提交历史、对话框）浮在上面时，上下键属于它，不属于文件列表。
    const layer = event.target.closest('[data-focus-layer]');
    if (layer && !layer.classList.contains('repo-workspace-shell')) return;
  }
  const controls = [...(root.value.querySelectorAll<HTMLButtonElement>('.workspace-file-row .workspace-file-select') ?? [])];
  if (!controls.length) return;
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const current = controls.findIndex(
    (control) => control.closest<HTMLElement>('.workspace-file-row')?.dataset.path === props.diff?.path,
  );
  const next = current < 0 ? (step > 0 ? 0 : controls.length - 1) : Math.max(0, Math.min(controls.length - 1, current + step));
  event.preventDefault();
  if (next === current) return;
  controls[next].focus();
  controls[next].click();
}
function moveBranch(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!(event.target instanceof HTMLElement) || !event.target.matches('.workspace-branch, .workspace-remote-toggle')) return;
  const group = event.target.closest<HTMLDetailsElement>('.workspace-remote-group');
  if (group && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'ArrowLeft') {
      group.open = false;
      group.querySelector<HTMLElement>('summary')?.focus();
    } else if (!group.open) group.open = true;
    else if (event.target.matches('summary')) group.querySelector<HTMLButtonElement>('.workspace-branch')?.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const controls = [...root.value!.querySelectorAll<HTMLElement>('.workspace-branch, .workspace-remote-toggle')]
    .filter(control => control.getClientRects().length > 0 && (control.matches('summary') || !control.closest('details:not([open])')));
  const index = controls.indexOf(event.target);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  controls[next]?.focus();
  // Arrow navigation reads branches without toggling groups or checking out.
  if (controls[next]?.matches('.workspace-branch')) controls[next].click();
}
const scrollPositions = new Map<string, { top: number; left: number }>();
function rememberScroll(): void {
  if (!preview.value || !props.diff?.diff || props.diffLoading || props.busy) return;
  scrollPositions.set(selectionKey(props.diff), {
    top: preview.value.scrollTop,
    left: preview.value.scrollLeft,
  });
}
const readingNavigation = useReadingNavigation<WorkspaceReading>();
let navigationRestore = 0;
function preserveReadingFocus(): void {
  const origin = document.activeElement;
  const wasInside = origin instanceof HTMLElement && root.value?.contains(origin);
  void nextTick(() => {
    if (wasInside && origin instanceof HTMLElement && !origin.getClientRects().length && (document.activeElement === document.body || document.activeElement === origin)) root.value?.focus({ preventScroll: true });
  });
}
function captureReading(): WorkspaceReading {
  return { view: view.value, reference: historyReference.value, scope: historyScope.value, baseRef: comparisonBase.value, filePath: historyFilePath.value, startTip: historyStartTip.value, branch: selectedBranch.value,
    ...(view.value === 'tree' ? { tree: treePanel.value?.capture() ?? { commit: treeCommit.value, directory: '', path: treePath.value ?? null, blame: treeBlame.value, skip: 0, search: '', listTop: 0, previewTop: 0, previewLeft: 0 } } : {}),
    ...(view.value === 'reflog' ? { reflog: reflogPanel.value?.capture() } : {}),
    ...(view.value === 'history' ? { history: historyPanel.value?.capture() } : {}),
    ...(view.value === 'stash' || view.value === 'tags' ? { references: referencesPanel.value?.capture() } : {}),
    ...(view.value === 'working' ? { working: { path: props.diff?.path, kind: props.diff?.kind, search: search.value, listTop: workingList.value?.scrollTop ?? workingListTop, previewTop: preview.value?.scrollTop ?? 0, previewLeft: preview.value?.scrollLeft ?? 0 } } : {}) };
}
function navigate(change: () => void): void {
  const current = captureReading(); navigationRestore++; change(); preserveReadingFocus();
  const next = captureReading();
  const identity = (reading: WorkspaceReading) => JSON.stringify([reading.view, reading.reference, reading.scope, reading.baseRef, reading.filePath, reading.startTip, reading.tree?.commit, reading.tree?.path, reading.tree?.blame]);
  if (identity(current) !== identity(next)) readingNavigation.visit(current, next);
}
function recordCommit(hash: string): void {
  const current = captureReading();
  if (!current.history) return;
  navigationRestore++;
  readingNavigation.visit(current, { ...current, history: { ...current.history, hash, comparisonPreview: 'commit', previewTop: 0, previewLeft: 0 } });
}
function recordReference(key: string): void {
  const current = captureReading(); navigationRestore++;
  readingNavigation.visit(current, { ...current, references: { key, listTop: current.references?.listTop ?? 0, previewTop: 0, expanded: [] } });
}
function selectFile(file: FileChange, kind?: DiffKind): void {
  const nextKind = kind ?? (file.unstaged ? 'unstaged' : 'staged');
  const current = captureReading();
  if (current.working && (current.working.path !== file.path || current.working.kind !== nextKind)) {
    navigationRestore++;
    readingNavigation.visit(current, { ...current, working: { ...current.working, path: file.path, kind: nextKind, previewTop: 0, previewLeft: 0 } });
  }
  emit('select', file, kind);
}
async function moveReading(direction: -1 | 1): Promise<void> {
  const reading = readingNavigation.move(captureReading(), direction);
  if (!reading) return;
  const token = ++navigationRestore;
  initialViewResolved = true;
  selectedBranch.value = reading.branch; historyReference.value = reading.reference; historyScope.value = reading.scope; comparisonBase.value = reading.baseRef;
  historyFilePath.value = reading.filePath; historyStartTip.value = reading.startTip; view.value = reading.view;
  preserveReadingFocus();
  if (reading.tree) { treeCommit.value = reading.tree.commit; treePath.value = reading.tree.path ?? undefined; treeBlame.value = reading.tree.blame; }
  if (reading.working) {
    search.value = reading.working.search; workingListTop = reading.working.listTop;
    const file = props.files.find(file => file.path === reading.working?.path);
    if (file) {
      const kind = reading.working.kind ?? (file.unstaged ? 'unstaged' : 'staged');
      scrollPositions.set(selectionKey({ path: file.path, kind }), { top: reading.working.previewTop, left: reading.working.previewLeft });
      emit('select', file, kind);
    } else emit('clearDiff');
  }
  await nextTick();
  if (token !== navigationRestore) return;
  if (reading.view === 'tree') void treePanel.value?.restore(reading.tree);
  else if (reading.view === 'reflog') void reflogPanel.value?.restore(reading.reflog);
  else if (reading.view === 'history') void historyPanel.value?.restore(reading.history);
  else if (reading.view === 'stash' || reading.view === 'tags') referencesPanel.value?.restore(reading.references);
  else {
    if (workingList.value) workingList.value.scrollTop = reading.working?.listTop ?? 0;
    if (preview.value) { preview.value.scrollTop = reading.working?.previewTop ?? 0; preview.value.scrollLeft = reading.working?.previewLeft ?? 0; }
  }
}
function readingKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.shiftKey || event.ctrlKey || !event.altKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  if (event.target instanceof Element && (event.target.closest('input, textarea, select, [contenteditable="true"]') || event.target.closest('[data-focus-layer]')?.classList.contains('repo-workspace-shell') !== true)) return;
  event.preventDefault(); void moveReading(event.key === 'ArrowLeft' ? -1 : 1);
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
  if (next === 'working' && workingList.value) workingList.value.scrollTop = workingListTop;
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
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
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
          workspaceWidth.value - actualFilesWidth.value - 390,
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
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  workspaceWidth.value = root.value?.clientWidth ?? workspaceWidth.value;
  const delta = event.key === 'ArrowLeft' ? -20 : 20;
  // 「分支栏 / 文件栏」是左右并列的竖向分隔条，所以按 ← / → 调整宽度（与 aria-orientation 一致）；
  // Home 恢复默认宽度，End 直接拉到当前窗口允许的最宽。
  const sidebarCeiling = Math.max(180, Math.min(sidebarLimit.value, workspaceWidth.value - actualFilesWidth.value - 390));
  if (pane === 'sidebar') {
    if (event.key === 'Home') sidebarWidth.value = null;
    else if (event.key === 'End') sidebarWidth.value = sidebarCeiling;
    else sidebarWidth.value = Math.max(180, Math.min(sidebarCeiling, actualSidebarWidth.value + delta));
    return;
  }
  const filesCeiling = Math.max(280, filesLimit.value);
  if (event.key === 'Home') filesWidth.value = null;
  else if (event.key === 'End') filesWidth.value = filesCeiling;
  else filesWidth.value = Math.max(280, Math.min(filesCeiling, actualFilesWidth.value + delta));
}
function focusSearch(): void {
  initialViewResolved = true;
  if (view.value === 'tree') { treePanel.value?.focusSearch(); return; }
  if (view.value === 'reflog') { reflogPanel.value?.focusSearch(); return; }
  if (view.value === 'history') {
    historyPanel.value?.focusSearch();
    return;
  }
  chooseView('working');
  void nextTick(() => searchInput.value?.focus());
}
defineExpose({ showWorking: () => chooseView('working'), showCurrentBranch: () => {
  const name = props.branches?.currentBranch;
  if (name) browseBranch(name);
  else browseHead();
  void nextTick(() => historyPanel.value?.restore({ search: '', searchField: 'message', hash: props.branches?.head ?? null, listTop: 0, previewTop: 0, previewLeft: 0, expanded: [] }));
}, focusSearch });
onBeforeUnmount(() => {
  stopResize?.();
  stopBranchDrag?.();
  if (branchClickTimer) clearTimeout(branchClickTimer);
  widthObserver?.disconnect();
  window.removeEventListener('keydown', selectFileByArrow);
});
</script>

<template>
  <section
    ref="root"
    tabindex="-1"
    class="repository-workspace"
    :class="{ 'branch-dragging': draggedBranch }"
    @click.capture="focusClickedControl"
    @keydown="readingKey"
    :style="{
      '--workspace-sidebar': `${actualSidebarWidth}px`,
      '--workspace-files': `${actualFilesWidth}px`,
    }"
  >
    <div class="workspace-header"><slot name="header" /></div>
    <!-- 常驻提示放在视图切换之外：干净工作区默认打开提交历史，只在工作区视图里提示等于看不见。 -->
    <slot name="notice" />
    <div class="workspace-body">
      <aside class="workspace-sidebar" aria-label="仓库导航与分支">
        <p class="workspace-section-label">仓库</p>
        <nav class="workspace-nav" aria-label="仓库视图">
          <button
            v-for="item in nav"
            :key="item.id"
            :class="{ active: view === item.id && (item.id !== 'history' || historyScope === 'all') }"
            :aria-current="view === item.id && (item.id !== 'history' || historyScope === 'all') ? 'page' : undefined"
            @click="item.id === 'history' ? browseAll() : chooseView(item.id)"
          >
            <component :is="item.icon" :size="15" /><span>{{ item.label }}</span
            ><b v-if="item.count !== null">{{ item.count }}</b>
          </button>
          <button v-if="comparisonOptions.length > 1" :class="{ active: view === 'history' && historyScope === 'compare' }" :aria-current="view === 'history' && historyScope === 'compare' ? 'page' : undefined" @click="compareBranches()"><GitCompareArrows :size="15" /><span>分支对比</span></button>
          <button :class="{ active: view === 'reflog' }" :aria-current="view === 'reflog' ? 'page' : undefined" @click="chooseView('reflog')"><History :size="15" /><span>Reflog</span></button>
        </nav>
        <div class="workspace-section-label workspace-local-branches-heading">
          <span>本地分支</span>
          <div class="workspace-local-branches-actions"><span>{{ branches?.branches.length ?? '—' }}</span><slot name="branch-manager" /></div>
        </div>
        <div class="workspace-branches" @keydown="moveBranch">
          <p v-if="branchesLoading && !branches" class="workspace-muted">
            <LoaderCircle :size="13" class="spinning" />读取分支…
          </p>
          <p v-else-if="!localBranches.length" class="workspace-muted">暂无本地分支</p>
          <div v-for="branch in localBranches" :key="branch.name" class="workspace-branch-row" :class="{ current: branch.current, selected: view === 'history' && historyReference === `refs/heads/${branch.name}`, 'merge-drop-target': draggedBranch && branch.current && !(draggedBranch.kind === 'local' && draggedBranch.name === branch.name), 'merge-drop-over': dragTarget === branch.name && branch.current }" :data-merge-target="branch.name">
          <button class="workspace-branch"
            aria-haspopup="menu"
            @contextmenu="openBranchMenu($event, branch.name)"
            @keydown.shift.f10.prevent.stop="openBranchMenu($event, branch.name)"
            @keydown.exact="($event.key === 'ContextMenu') && openBranchMenu($event, branch.name)"
            :draggable="false"
            @pointerdown="startBranchDrag($event, { kind: 'local', name: branch.name })"
            :aria-current="branch.current ? 'true' : undefined"
            :aria-pressed="view === 'history' && historyScope === 'ref' && historyReference === `refs/heads/${branch.name}`"
            :aria-label="`${branch.name}${branch.current ? '，当前分支 HEAD' : branch.worktreePath ? '，其他 Worktree 占用' : ''}，${branchTrackingLabel(branch)}`"
            :title="`${branch.name}\n${branchTrackingLabel(branch)}\n${switchBlocker(branch) ?? '双击切换分支'}`"
            @click="clickBranch(branch.name)"
            @dblclick="!switchBlocker(branch) && emit('switchBranch', branch)"
            @keydown.enter.prevent="
              browseBranch(branch.name);
              !switchBlocker(branch) && emit('switchBranch', branch);
            "
          >
            <GitBranch :size="13" /><span class="workspace-branch-name">{{ branch.name }}</span>
          </button>
            <span v-if="branch.current || branch.worktreePath || (branch.ahead ?? 0) > 0 || (branch.behind ?? 0) > 0" class="workspace-branch-badges">
              <small v-if="branch.current" class="workspace-branch-head">HEAD</small>
              <small v-else-if="branch.worktreePath">WT</small>
              <button v-if="(branch.ahead ?? 0) > 0" class="workspace-branch-outgoing" :aria-pressed="view === 'history' && historyScope === 'outgoing' && historyReference === `refs/heads/${branch.name}`" :class="{ active: view === 'history' && historyScope === 'outgoing' && historyReference === `refs/heads/${branch.name}` }" :aria-label="`查看 ${branch.name} 的 ${branch.ahead} 条待推送提交`" :title="`查看待推送提交\n${branchTrackingLabel(branch)}`" @click="browseOutgoing(branch.name)"><ArrowUpRight aria-hidden="true" />{{ branch.ahead }}</button>
              <button v-if="(branch.behind ?? 0) > 0" class="workspace-branch-outgoing workspace-branch-incoming" :aria-pressed="view === 'history' && historyScope === 'incoming' && historyReference === `refs/heads/${branch.name}`" :class="{ active: view === 'history' && historyScope === 'incoming' && historyReference === `refs/heads/${branch.name}` }" :aria-label="`查看 ${branch.name} 的 ${branch.behind} 条待拉取提交`" :title="`查看待拉取提交\n${branchTrackingLabel(branch)}`" @click="browseIncoming(branch.name)"><ArrowDownLeft aria-hidden="true" />{{ branch.behind }}</button>
            </span>
          </div>
          <p class="workspace-section-label">
            远端分支 <span>{{ branches?.remoteBranches.length ?? '—' }}</span>
          </p>
          <p v-if="!remoteGroups.length" class="workspace-muted">暂无远端分支</p>
          <details v-for="group in remoteGroups" :key="group.name" class="workspace-remote-group" open
            :class="{ selected: view === 'history' && group.branches.some(branch => historyReference === `refs/remotes/${branch.name}`) }">
            <summary class="workspace-remote-toggle" :title="`${group.name} · ${group.branches.length} 个远端分支`">
              <ChevronRight :size="12" class="workspace-remote-chevron" aria-hidden="true" />
              <FolderGit2 :size="14" aria-hidden="true" /><span>{{ group.name }}</span><small>{{ group.branches.length }}</small>
            </summary>
            <button v-for="branch in group.branches" :key="branch.name"
              class="workspace-remote workspace-branch"
              aria-haspopup="menu"
              @contextmenu="openBranchMenu($event, branch.name, true)"
              @keydown.shift.f10.prevent.stop="openBranchMenu($event, branch.name, true)"
              @keydown.exact="($event.key === 'ContextMenu') && openBranchMenu($event, branch.name, true)"
              :class="{ selected: view === 'history' && historyReference === `refs/remotes/${branch.name}` }"
              :aria-pressed="view === 'history' && historyReference === `refs/remotes/${branch.name}`"
              :aria-label="`浏览远端分支 ${branch.name}`" :title="branch.name"
              :draggable="false" @pointerdown="startBranchDrag($event, { kind: 'remote', name: branch.name })"
              @click="clickBranch(branch.name, true)">
              <GitBranch :size="12" aria-hidden="true" /><span>{{ branch.branch }}</span>
            </button>
          </details>
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
        <p v-if="draggedBranch" class="workspace-merge-hint" role="status"><GitMerge :size="14" /><span>{{ dragTarget && dragTarget !== branches?.currentBranch ? '请先切换到目标分支再合并' : `拖到 ${branches?.currentBranch}（HEAD）合并` }}</span></p>
        <div v-if="view === 'history' && (branchInfo || mergeSource)" class="workspace-branch-info" aria-label="所浏览分支的信息与操作">
          <div class="workspace-branch-info-heading"><GitBranch :size="13" /><strong :title="branchInfo?.name || mergeSource?.name">{{ branchInfo?.name || mergeSource?.name }}</strong><small v-if="branchInfo?.current" class="workspace-branch-current">HEAD</small></div>
          <span :title="branchInfo?.upstream ?? undefined">{{ branchInfo ? branchInfo.upstream ?? '未关联 upstream' : '远端跟踪分支' }}</span>
          <div v-if="branchInfo" class="workspace-branch-tracking-actions">
            <button :disabled="branchInfo.ahead === null || !branchInfo.upstream" :title="branchTrackingLabel(branchInfo)" @click="browseOutgoing(branchInfo.name)"><ArrowUp :size="12" />{{ branchInfo.ahead ?? '—' }} 待推送</button>
            <button :disabled="branchInfo.behind === null || !branchInfo.upstream" :title="branchTrackingLabel(branchInfo)" @click="browseIncoming(branchInfo.name)"><ArrowDown :size="12" />{{ branchInfo.behind ?? '—' }} 待拉取</button>
          </div>
          <div class="workspace-branch-info-actions">
            <button v-if="branchInfo && !branchInfo.current" :disabled="Boolean(switchBlocker(branchInfo))" :title="switchBlocker(branchInfo) ?? undefined" aria-label="切换到此分支" @click="switchSelectedBranch"><GitBranch :size="13" /><span>切换</span></button>
            <button v-if="mergeSource && !(mergeSource.kind === 'local' && mergeSource.name === branches?.currentBranch)" :disabled="!mergeEnabled" aria-label="合并到当前分支" :title="`合并到 ${branches?.currentBranch}`" @click="emit('mergeBranch', mergeSource)"><GitMerge :size="13" /><span>合并</span></button>
            <button v-if="historyScope !== 'compare' && historyReference && comparisonOptions.length > 1" aria-label="与其他分支对比" title="与其他分支对比" @click="compareBranches(historyReference)"><GitCompareArrows :size="13" /><span>对比</span></button>
            <button v-if="branchInfo" class="workspace-branch-delete" aria-label="删除本地分支" :disabled="Boolean(deleteBlocker(branchInfo))" :title="deleteBlocker(branchInfo) ?? '删除本地分支引用，保留已合并的提交'" @click="emit('deleteBranch', branchInfo)"><Trash2 :size="13" /><span>删除</span></button>
          </div>
          <small v-if="branchInfo && !branchInfo.current && switchBlocker(branchInfo)" class="workspace-branch-blocker">{{ switchBlocker(branchInfo) }}</small>
        </div>
        <p v-else-if="!draggedBranch" class="workspace-sidebar-hint">单击浏览历史 · 双击本地分支切换</p>
      </aside>
      <div
        class="workspace-splitter"
        role="separator"
        aria-label="调整分支栏宽度"
        aria-orientation="vertical"
        :aria-valuenow="actualSidebarWidth"
        aria-valuemin="180"
        :aria-valuemax="sidebarLimit"
        title="← → 调整宽度 · Home 恢复默认 · End 拉到最宽"
        tabindex="0"
        @pointerdown="resize($event, 'sidebar')"
        @keydown="resizeByKey($event, 'sidebar')"
      />
      <template v-if="view === 'working'">
        <section class="workspace-files" aria-label="工作区文件" @keydown="moveFile">
          <div class="workspace-pane-heading">
            <div>
              <strong>工作区</strong
              ><small :title="`${repository.branch ?? 'DETACHED'} · ${files.length} 个文件`"
                ><span>{{ repository.branch ?? 'DETACHED' }}</span></small
              >
            </div>
            <div class="workspace-pane-actions">
              <button
                class="file-tree-toggle"
                :aria-pressed="fileListView.view.value === 'tree'"
                :title="fileListView.view.value === 'tree' ? '切回平铺清单' : '按目录折叠显示文件'"
                @click="toggleFileListView"
              >
                <ListTree v-if="fileListView.view.value === 'tree'" :size="13" /><List v-else :size="13" />
                <span>{{ fileListView.view.value === 'tree' ? '树形' : '平铺' }}</span>
              </button>
              <button
                class="workspace-ignored-toggle"
                :class="{ active: showMarkedFiles }"
                :aria-pressed="showMarkedFiles"
                :title="showMarkedFiles ? '隐藏被标记的文件' : '显示被标记 assume-unchanged 的文件'"
                @click="emit('toggleMarked', !showMarkedFiles)"
              >
                <LoaderCircle v-if="markedLoading" :size="13" class="spinning" /><Bookmark v-else :size="13" />
                <span>已标记{{ showMarkedFiles && markedFiles.length ? ` ${markedFiles.length}` : '' }}</span>
              </button>
              <button
                class="workspace-ignored-toggle"
                :class="{ active: showIgnoredFiles }"
                :aria-pressed="showIgnoredFiles"
                :title="showIgnoredFiles ? '隐藏被 Git 忽略的文件' : '显示被 Git 忽略的文件'"
                @click="emit('toggleIgnored', !showIgnoredFiles)"
              >
                <LoaderCircle v-if="ignoredLoading" :size="13" class="spinning" /><EyeOff v-else :size="13" />
                <span>已忽略{{ showIgnoredFiles && ignoredFiles.length ? ` ${ignoredFiles.length}` : '' }}</span>
              </button>
            </div>
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
            v-if="search.trim()"
            class="workspace-selection-notice"
            role="status"
          >
            <span>{{
              hiddenStagedCount
                ? `提交包含 ${hiddenStagedCount} 个搜索隐藏的已勾选文件`
                : '全选仅影响匹配文件；提交包含所有已勾选内容'
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
          <div ref="workingList" class="workspace-file-scroll" :aria-busy="filesLoading || busy" @scroll.passive="workingListTop = workingList?.scrollTop ?? 0">
            <p v-if="filesLoading && !files.length" class="workspace-empty">
              <LoaderCircle :size="18" class="spinning" />读取文件状态…
            </p>
            <!-- 读不到文件时不能说「工作区干净」：那会让用户以为没有待提交的改动。 -->
            <div v-else-if="!files.length && filesError" class="workspace-empty" role="alert">
              <AlertTriangle :size="20" /><span>{{ filesError }}</span
              ><button
                class="compact-button"
                :disabled="refreshing || busy"
                @click="emit('refresh')"
              >
                刷新后重试
              </button>
            </div>
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
                @contextmenu.prevent="openFileMenu($event, { kind: 'file', file })"
                @keydown.shift.f10.prevent.stop="openFileMenu($event, { kind: 'file', file })"
                @keydown.exact="($event.key === 'ContextMenu') && openFileMenu($event, { kind: 'file', file })"
              >
                <button
                  class="workspace-file-select"
                  :title="file.path"
                  :aria-label="`查看冲突差异 ${file.path}`"
                  @click="selectFile(file)"
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
            <template v-if="ordinaryFiles.length">
              <div class="workspace-group-heading">
                <label class="workspace-group-select" title="全选当前显示的文件，纳入本次提交">
                  <input type="checkbox" :checked="selection.all" :indeterminate="selection.partial" aria-label="全选提交文件" :disabled="stageBlocked" @change="toggleAll" />
                  <strong>变化文件</strong>
                </label><span>{{ ordinaryFiles.length }}</span>
                <button :disabled="stageBlocked || !ordinaryFiles.some(file => file.staged)" title="取消当前显示文件的勾选，保留搜索隐藏的暂存内容" @click="uncheckVisible">取消勾选</button>
                <button
                  v-if="deletablePaths.length"
                  class="workspace-group-delete"
                  :disabled="stageBlocked"
                  :title="`把勾选的 ${deletablePaths.length} 个未提交文件移到废纸篓`"
                  @click="emit('discardUntracked', deletablePaths)"
                ><LoaderCircle v-if="discardBusy" :size="12" class="spinning" />{{ discardBusy ? '删除中…' : `删除 ${deletablePaths.length} 个` }}</button>
              </div>
              <template v-for="row in workspaceRows" :key="row.kind === 'file' ? row.file.path : `dir:${row.node.path}`">
                <button
                  v-if="row.kind === 'directory'"
                  type="button"
                  class="file-tree-directory"
                  :aria-expanded="isDirectoryOpen(row.node)"
                  :style="{ '--tree-depth': row.depth }"
                  :title="row.node.path"
                  @click="toggleDirectory(row.node)"
                  @keydown="directoryKey($event, row.node)"
                >
                  <ChevronRight :size="12" class="file-tree-chevron" :class="{ open: isDirectoryOpen(row.node) }" aria-hidden="true" />
                  <FolderOpen v-if="isDirectoryOpen(row.node)" :size="13" aria-hidden="true" /><FolderClosed v-else :size="13" aria-hidden="true" />
                  <span>{{ row.node.name }}</span><small>{{ row.node.fileCount }}</small>
                </button>
                <div
                  v-else
                  class="workspace-file-row"
                  :data-path="row.file.path"
                  :data-kind="row.file.unstaged ? 'unstaged' : 'staged'"
                  :class="{ active: diff?.path === row.file.path, checked: row.file.staged, 'file-tree-file': fileListView.view.value === 'tree' }"
                  :style="{ '--tree-depth': row.depth }"
                  @contextmenu.prevent="openFileMenu($event, { kind: 'file', file: row.file })"
                  @keydown.shift.f10.prevent.stop="openFileMenu($event, { kind: 'file', file: row.file })"
                  @keydown.exact="($event.key === 'ContextMenu') && openFileMenu($event, { kind: 'file', file: row.file })"
                >
                  <input type="checkbox" :checked="row.file.staged && !row.file.unstaged" :indeterminate="row.file.staged && row.file.unstaged" :aria-label="`纳入提交 ${row.file.path}`" :title="row.file.staged && row.file.unstaged ? '部分内容已纳入提交；勾选可纳入全部' : row.file.staged ? '取消纳入提交' : '纳入本次提交'" :disabled="stageBlocked" @change="toggle(row.file)" />
                  <button class="workspace-file-select" :aria-pressed="diff?.path === row.file.path" :aria-label="`查看差异 ${row.file.path}`" :title="row.file.originalPath ? `${row.file.originalPath} → ${row.file.path}` : row.file.path" @click="selectFile(row.file)">
                    <b :class="{ staged: row.file.staged && !row.file.unstaged, untracked: row.file.untracked, deleted: row.file.indexStatus === 'D' || row.file.worktreeStatus === 'D' }">{{ row.file.untracked ? 'U' : row.file.worktreeStatus.trim() || row.file.indexStatus }}</b>
                    <span class="workspace-file-label"><span>{{ fileName(row.file.path) }}</span><small v-if="!row.skipDirectory && fileDirectory(row.file.path)">{{ fileDirectory(row.file.path) }}</small></span>
                    <small v-if="row.file.staged && row.file.unstaged" class="workspace-partial-label" title="只有已暂存的部分会提交">部分</small>
                  </button>
                  <slot name="file-actions" :file="row.file" />
                  <button v-if="row.file.staged && row.file.unstaged" class="workspace-file-stage" :disabled="stageBlocked" :aria-label="`取消部分暂存 ${row.file.path}`" title="取消此文件全部暂存" @click="emit('stage', [row.file.path], 'unstage')"><Minus :size="13" /></button>
                </div>
              </template>
            </template>
            <template v-if="showMarkedFiles">
              <div class="workspace-group-heading ignored">
                <strong>已标记</strong><span>{{ markedFiles.length }}</span>
              </div>
              <p v-if="markedLoading && !markedFiles.length" class="workspace-muted">
                <LoaderCircle :size="13" class="spinning" />读取已标记文件…
              </p>
              <p v-else-if="!markedFiles.length" class="workspace-muted">没有 assume-unchanged 标记</p>
              <p v-else class="workspace-muted">这些文件的本地修改不会进提交；标记只在本机，文件一旦被提交就会失效。</p>
              <div
                v-for="entry in markedFiles"
                :key="entry.id"
                class="workspace-file-row ignored"
                :data-path="entry.path"
                data-kind="marked"
                @contextmenu.prevent="openFileMenu($event, { kind: 'marked', entry })"
                @keydown.shift.f10.prevent.stop="openFileMenu($event, { kind: 'marked', entry })"
                @keydown.exact="($event.key === 'ContextMenu') && openFileMenu($event, { kind: 'marked', entry })"
              >
                <button
                  class="workspace-file-select"
                  :title="`${entry.path}（已标记 assume-unchanged，右键可取消标记）`"
                  :aria-label="`已标记 ${entry.path}，右键可取消标记`"
                >
                  <b class="untracked">A</b>
                  <span class="workspace-file-label"
                    ><span>{{ ignoredLabelParts(entry.path).name }}</span
                    ><small v-if="ignoredLabelParts(entry.path).directory">{{ ignoredLabelParts(entry.path).directory }}</small></span
                  >
                </button>
              </div>
            </template>
            <template v-if="showIgnoredFiles">
              <div class="workspace-group-heading ignored">
                <strong>已忽略</strong><span>{{ ignoredFiles.length }}</span>
              </div>
              <p v-if="ignoredLoading && !ignoredFiles.length" class="workspace-muted">
                <LoaderCircle :size="13" class="spinning" />读取已忽略文件…
              </p>
              <p v-else-if="!ignoredFiles.length" class="workspace-muted">没有被忽略的文件</p>
              <div
                v-for="entry in ignoredFiles"
                :key="entry.id"
                class="workspace-file-row ignored"
                :data-path="entry.path"
                data-kind="ignored"
                @contextmenu.prevent="openFileMenu($event, { kind: 'ignored', entry })"
                @keydown.shift.f10.prevent.stop="openFileMenu($event, { kind: 'ignored', entry })"
                @keydown.exact="($event.key === 'ContextMenu') && openFileMenu($event, { kind: 'ignored', entry })"
              >
                <button
                  class="workspace-file-select"
                  :title="`${entry.path}（已忽略，右键查看操作）`"
                  :aria-label="`已忽略 ${entry.path}，右键查看操作`"
                >
                  <b class="untracked">I</b>
                  <span class="workspace-file-label"
                    ><span>{{ ignoredLabelParts(entry.path).name }}<template v-if="entry.directory">/</template></span
                    ><small v-if="ignoredLabelParts(entry.path).directory">{{ ignoredLabelParts(entry.path).directory }}</small></span
                  >
                </button>
              </div>
              <p v-if="ignoredTruncated" class="workspace-muted">仅显示前 {{ ignoredFiles.length }} 条已忽略文件</p>
            </template>
          </div>
          <div class="workspace-file-summary">
            <span>↑ ↓ 浏览 · 空格勾选</span><span v-if="filesLoading"><LoaderCircle :size="11" class="spinning" />刷新中</span><span v-else>已勾选 {{ stagedCount }} / {{ files.filter(file => !file.conflicted).length }}</span>
          </div>
          <slot name="commit" />
        </section>
        <div
          class="workspace-splitter"
          role="separator"
          aria-label="调整文件栏宽度"
          aria-orientation="vertical"
          :aria-valuenow="actualFilesWidth"
          aria-valuemin="280"
          :aria-valuemax="filesLimit"
          title="← → 调整宽度 · Home 恢复默认 · End 拉到最宽"
          tabindex="0"
          @pointerdown="resize($event, 'files')"
          @keydown="resizeByKey($event, 'files')"
        />
        <section class="workspace-preview" aria-label="文件差异预览" :aria-busy="diffLoading">
          <ConflictPreview v-if="currentFile?.conflicted" :repository-id="repository.config.id" :file="currentFile" :busy="busy || filesLoading" :can-resolve="repository.config.capabilities.stage" @resolve="(file, strategy, fingerprint) => emit('resolveConflict', file, strategy, fingerprint)" />
          <template v-else-if="diff"
            ><div class="workspace-diff-heading">
              <strong :title="diff.path"
                :aria-label="diff.path"
                ><FileDiff :size="15" /><span class="workspace-diff-path"
                  ><span>{{ fileName(diff.path) }}</span
                  ><small v-if="fileDirectory(diff.path)">{{ fileDirectory(diff.path) }}</small
                ></span></strong
              ><button v-if="branches?.head && !currentFile?.untracked" class="table-icon-button" aria-label="查看 HEAD 版本行归属" title="Blame · HEAD 版本，不含未提交修改" @click="browseTree(branches!.head, diff.path, true)"><Fingerprint :size="14" /></button><button class="table-icon-button" aria-label="查看当前文件历史" title="查看文件历史" @click="browseFile(diff.path)"><History :size="14" /></button><button
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
                ><template v-if="!diff.truncated"
                  ><span class="addition">+{{ presentation.additions }}</span
                  ><span class="deletion">−{{ presentation.deletions }}</span></template
                ></template
              >
            </div>
            <p v-if="diff.truncated && !diffLoading && !diffError" class="workspace-preview-notice" role="status">
              文件差异过大，仅显示前 120 KB，增删行数已省略。完整差异请在本地 Git 中查看。
            </p>
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
                :hunk-action-label="!diff.diff ? undefined : hunkActionLabel"
                :pending-hunk-index="pendingHunk"
                :hunk-action-blocked="hunkActionBlocked"
                @hunk-action="emit('hunk', $event)"
              /></div
          ></template>
          <div v-else class="workspace-empty workspace-preview-empty">
            <Check v-if="!files.length && !filesLoading" :size="36" />
            <FileDiff v-else :size="36" />
            <strong>{{ !files.length && !filesLoading ? '没有待审阅的改动' : '选择文件，查看变化' }}</strong>
            <span>{{ !files.length && !filesLoading ? '查看提交历史，或切换分支继续工作' : '已暂存与未暂存差异分别展示' }}</span>
            <div v-if="files.length && !filesLoading" class="workspace-preview-shortcuts" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd>选择文件</span>
              <span><kbd>⌘K</kbd>搜索路径</span>
            </div>
            <button v-if="!files.length && !filesLoading" class="compact-button" @click="browseAll">
              <History :size="13" />查看提交历史
            </button>
          </div>
        </section>
      </template>
      <RepositoryReferences v-show="view === 'stash' || view === 'tags'" ref="referencesPanel" :repository-id="repository.config.id" :kind="view === 'stash' ? 'stash' : 'tags'" :stashes="stashes" :tags="tags" :loading="view === 'stash' ? stashesLoading : tagsLoading" :active="view === 'stash' || view === 'tags'" :pane-width="actualFilesWidth" :pane-max="filesLimit" @resize="resize($event, 'files')" @resize-key="resizeByKey($event, 'files')" @refresh="view === 'stash' ? emit('refreshStashes') : emit('refreshTags')" @select-entry="recordReference">
        <template #create><slot v-if="view === 'stash'" name="stash-create" /><slot v-else name="tags-create" /></template>
        <template #actions="{ tag, stash }"><slot v-if="view === 'stash' && stash" name="stash-actions" :stash="stash" /><slot v-else-if="tag" name="tags-actions" :tag="tag" /></template>
      </RepositoryReferences>
      <RepositoryHistory
        v-show="view === 'history'"
        ref="historyPanel"
        :repository-id="repository.config.id"
        :remote-url="repository.remoteUrl"
        :reference="historyReference"
        :scope="historyScope"
        :base-reference="comparisonBase"
        :upstream-label="branchInfo?.upstream ?? undefined"
        :comparison-options="comparisonOptions"
        :file-path="historyFilePath"
        :start-tip="historyStartTip"
        :revision="historyRevision"
        :branch-label="historyBranchLabel"
        :head="branches?.head ?? ''"
        :active="view === 'history'"
        :pane-width="actualFilesWidth"
        :pane-max="filesLimit"
        @resize="resize($event, 'files')"
        @resize-key="resizeByKey($event, 'files')"
        @select-commit="recordCommit"
        @browse-head="browseHead"
        @browse-all="browseAll"
        @browse-file="browseFile"
          @compare="compareBranches"
          @browse-tree="browseTree"
          @revert="emit('revertCommit', $event)"
          @cherry-pick="emit('cherryPickCommit', $event)"
        />
      <RepositoryTree v-show="view === 'tree'" ref="treePanel" :repository-id="repository.config.id" :commit="treeCommit" :initial-path="treePath" :initial-blame="treeBlame" :active="view === 'tree'" :pane-width="actualFilesWidth" :pane-max="filesLimit" @resize="resize($event, 'files')" @resize-key="resizeByKey($event, 'files')" @navigate="recordTree" @commit="browseCommit" @file-history="browseFile" />
      <RepositoryReflog v-show="view === 'reflog'" ref="reflogPanel" :repository-id="repository.config.id" :active="view === 'reflog'" :options="comparisonOptions" :pane-width="actualFilesWidth" :pane-max="filesLimit" @resize="resize($event, 'files')" @resize-key="resizeByKey($event, 'files')" @navigate="recordReflog" @tree="browseTree" @file-history="browseFile" />
    </div>
    <SurfaceNotice
      v-if="notice"
      class="workspace-feedback"
      :notice="notice"
      @dismiss="emit('dismissFeedback')"
    />
    <ActionMenu ref="branchMenu" :label="menuBranchName" :items="branchMenuItems" @select="branchMenuAction" />
    <ActionMenu ref="fileMenu" :label="fileMenuTitle" :items="fileMenuNavItems" @select="fileMenuAction" />
    <footer class="workspace-footer"><slot name="footer" /></footer>
  </section>
</template>
