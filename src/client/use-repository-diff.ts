import { computed, ref, watch, type Ref } from 'vue';
import type { FileChange } from '../shared/contracts';
import { reconcileFileSelection, type DiffKind, type FileSelection } from './repository-workspace';

export type RepositoryDiff = FileSelection & {
  fileId: string;
  diff: string;
  stagedAvailable: boolean;
  unstagedAvailable: boolean;
};

export function useRepositoryDiff(options: {
  repositoryId: () => string | null;
  files: Ref<FileChange[]>;
  busy: () => boolean;
  read: (
    repositoryId: string,
    fileId: string,
    kind: DiffKind,
  ) => Promise<{ path: string; diff: string }>;
}) {
  const dialog = ref<RepositoryDiff | null>(null);
  const loading = ref(false);
  const error = ref('');
  const loadingFileId = computed(() => (loading.value ? (dialog.value?.fileId ?? null) : null));
  let request = 0;

  function clear(): void {
    request += 1;
    dialog.value = null;
    loading.value = false;
    error.value = '';
  }

  async function select(file: FileChange, requestedKind?: DiffKind): Promise<void> {
    const repositoryId = options.repositoryId();
    if (!repositoryId || options.busy()) return;
    const current = options.files.value.find((item) => item.path === file.path);
    const kind = requestedKind ?? (current?.unstaged ? 'unstaged' : 'staged');
    if (!current || !current[kind]) return;
    const token = ++request;
    dialog.value = {
      path: current.path,
      kind,
      fileId: current.id,
      diff: '',
      stagedAvailable: current.staged,
      unstagedAvailable: current.unstaged,
    };
    loading.value = true;
    error.value = '';
    try {
      const output = await options.read(repositoryId, current.id, kind);
      if (token !== request || options.repositoryId() !== repositoryId) return;
      if (output.path !== current.path) throw new Error('文件身份已变化，请刷新后重试');
      dialog.value!.diff = output.diff || '该文件没有可显示的文本 diff。';
    } catch (cause) {
      if (token === request && options.repositoryId() === repositoryId) {
        error.value = cause instanceof Error ? cause.message : '读取 Diff 失败';
      }
    } finally {
      if (token === request && options.repositoryId() === repositoryId) loading.value = false;
    }
  }

  watch(options.repositoryId, clear, { flush: 'sync' });
  watch(
    [options.files, options.busy],
    () => {
      const previous = dialog.value;
      if (!previous) return;
      const next = reconcileFileSelection(options.files.value, previous);
      if (!next) {
        clear();
        return;
      }
      const file = options.files.value.find((item) => item.path === next.path)!;
      if (previous.fileId === file.id && previous.kind === next.kind) return;
      // Invalidate immediately while a write is finishing; never offer actions on stale content.
      request += 1;
      previous.diff = '';
      loading.value = false;
      if (!options.busy()) void select(file, next.kind);
    },
    { flush: 'post' },
  );

  async function switchKind(kind: DiffKind): Promise<void> {
    const current = dialog.value;
    if (!current || current.kind === kind) return;
    const file = options.files.value.find((item) => item.path === current.path);
    if (file) await select(file, kind);
  }

  return { dialog, loading, loadingFileId, error, clear, select, switchKind };
}
