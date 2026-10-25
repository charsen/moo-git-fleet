import { computed, onScopeDispose, ref, watch } from 'vue';
import type { CommitPreview, CommitSuggestion } from '../shared/contracts';
import { ApiError } from './api.js';

/** Inline drafts stay local to this window; Git remains the source of selection state. */
export function useCommitComposer(options: {
  repositoryId: () => string | null;
  draftKey: () => string;
  revision: () => string;
  paused: () => boolean;
  hasStaged: () => boolean;
  readPreview: (id: string) => Promise<CommitPreview>;
  suggest: (id: string, fingerprint: string, signal: AbortSignal) => Promise<CommitSuggestion>;
}) {
  const message = ref('');
  const preview = ref<CommitPreview | null>(null);
  const loading = ref(false);
  const reading = ref(false);
  let readTail = Promise.resolve();
  const error = ref('');
  const suggestionError = ref('');
  let aiFingerprint: string | null = null;
  const suggesting = ref(false);
  const suggestion = ref<CommitSuggestion | null>(null);
  const needsReview = ref(false);
  const drafts = new Map<string, { message: string; aiFingerprint: string | null }>();
  const contextRevision = ref(0);
  let previewRequest = 0;
  let suggestionRequest = 0;
  let abort: AbortController | null = null;
  const ready = computed(() => Boolean(preview.value) && !loading.value && !error.value && !options.paused());

  function cancelSuggestion(): void {
    suggestionRequest += 1;
    abort?.abort();
    abort = null;
    suggesting.value = false;
  }
  function invalidate(): void {
    previewRequest += 1;
    loading.value = false;
    cancelSuggestion();
  }
  /**
   * 预览撞车（409）后的延时重读。
   *
   * 预览不占仓库锁，所以它可能和一次并发的暂存重叠——期间暂存区指纹变了，服务端
   * 会拒绝这次预览。文件列表更新后本来也会触发重读，这里只是补一拍，免得界面在
   * 「勾一个文件」的瞬间闪一句「暂存区已变化」。连撞三次就放弃，等下一次 revision
   * 变化（那时界面已经稳定了）。
   */
  let retryTimer: number | null = null;
  let retryCount = 0;
  function scheduleRetry(): void {
    if (retryTimer !== null || retryCount >= 3) return;
    retryCount += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void refresh();
    }, 200);
  }
  function updateMessage(value: string): void {
    message.value = value;
    needsReview.value = false;
  }
  function clearDraft(): void {
    message.value = '';
    aiFingerprint = null;
    drafts.delete(options.draftKey());
    suggestion.value = null;
    needsReview.value = false;
    preview.value = null;
    invalidate();
  }
  async function refresh(): Promise<void> {
    const id = options.repositoryId();
    const key = options.draftKey();
    const token = ++previewRequest;
    error.value = '';
    suggestionError.value = '';
    if (!id || !options.hasStaged()) {
      if (aiFingerprint) needsReview.value = true;
      preview.value = null;
      suggestion.value = null;
      loading.value = false;
      cancelSuggestion();
      return;
    }
    if (options.paused()) return;
    loading.value = true;
    const previousRead = readTail;
    let release!: () => void;
    readTail = new Promise<void>(resolve => { release = resolve; });
    await previousRead;
    if (token !== previewRequest || key !== options.draftKey() || options.paused()) { release(); return; }
    reading.value = true;
    try {
      const next = await options.readPreview(id);
      if (token !== previewRequest || key !== options.draftKey()) return;
      retryCount = 0;
      if (preview.value?.fingerprint !== next.fingerprint) {
        if (aiFingerprint && aiFingerprint !== next.fingerprint) needsReview.value = true;
        suggestion.value = null;
        cancelSuggestion();
      }
      preview.value = next;
    } catch (cause) {
      if (token === previewRequest && key === options.draftKey()) {
        preview.value = null;
        // 预览与并发的暂存/取消暂存撞车时，暂存区指纹必然变化，服务端会回 409。
        // 这不是用户需要处理的错误——下一次 revision 变化会重新读；这里只补一次
        // 延时重试，避免「勾一个文件就闪一句『暂存区已变化』」。
        if (cause instanceof ApiError && cause.status === 409) scheduleRetry();
        else error.value = cause instanceof Error ? cause.message : '读取提交内容失败';
      }
    } finally {
      reading.value = false;
      release();
      if (token === previewRequest && key === options.draftKey()) loading.value = false;
    }
  }
  async function generate(): Promise<void> {
    const id = options.repositoryId();
    const current = preview.value;
    if (!id || !current || !ready.value || suggesting.value) return;
    const key = options.draftKey();
    const originalMessage = message.value;
    const token = ++suggestionRequest;
    const controller = new AbortController();
    abort = controller;
    suggesting.value = true;
    suggestionError.value = '';
    try {
      const result = await options.suggest(id, current.fingerprint, controller.signal);
      if (token !== suggestionRequest || key !== options.draftKey()) return;
      if (preview.value?.fingerprint !== current.fingerprint || result.fingerprint !== current.fingerprint)
        throw new Error('提交内容已变化，请重新生成文案');
      if (message.value !== originalMessage) return;
      aiFingerprint = result.fingerprint;
      suggestion.value = result;
      message.value = result.message;
      needsReview.value = false;
    } catch (cause) {
      if (token === suggestionRequest && key === options.draftKey() && !controller.signal.aborted)
        suggestionError.value = cause instanceof Error ? cause.message : '生成提交文案失败';
    } finally {
      if (token === suggestionRequest && key === options.draftKey()) {
        abort = null;
        suggesting.value = false;
      }
    }
  }

  watch(options.draftKey, (key, previous) => {
    if (previous) drafts.set(previous, { message: message.value, aiFingerprint });
    invalidate();
    contextRevision.value += 1;
    const draft = drafts.get(key);
    message.value = draft?.message ?? '';
    aiFingerprint = draft?.aiFingerprint ?? null;
    preview.value = null;
    suggestion.value = null;
    needsReview.value = false;
    error.value = '';
    suggestionError.value = '';
  }, { flush: 'sync' });
  watch([contextRevision, options.revision, options.paused, options.hasStaged], () => {
    if (options.paused()) invalidate();
    else void refresh();
  }, { immediate: true, flush: 'post' });
  onScopeDispose(() => {
    invalidate();
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  });
  return { message, preview, loading, reading, error, suggestionError, suggesting, suggestion, needsReview, ready, updateMessage, clearDraft, refresh, generate };
}
