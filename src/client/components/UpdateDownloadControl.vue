<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Check, CloudDownload } from 'lucide-vue-next';
import { api } from '../api';
import type { UpdateDownloadStatus } from '../../shared/contracts';

/**
 * 应用内更新下载控件：点一下由服务端把安装包下到本地并轮询进度，
 * 完成后「打开安装包 / 在访达中显示」。顶栏更新面板与设置页共用这一个组件。
 */
const props = defineProps<{ url: string | null }>();

const status = ref<UpdateDownloadStatus | null>(null);
let timer: number | undefined;

const percent = computed(() => {
  const current = status.value;
  if (!current) return 0;
  if (current.status === 'done') return 100;
  const total = current.totalBytes;
  if (total && total > 0) return Math.min(100, Math.round((current.receivedBytes / total) * 100));
  return 0;
});
const receivedLabel = computed(() => formatSize(status.value?.receivedBytes ?? 0));
const totalLabel = computed(() => (status.value?.totalBytes ? formatSize(status.value.totalBytes) : ''));

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function stopPoll(): void {
  if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
}
function startPoll(): void {
  stopPoll();
  timer = window.setInterval(async () => {
    try {
      status.value = await api.updateDownloadStatus();
      if (status.value.status !== 'downloading') stopPoll();
    } catch { /* 传输抖动：下一轮再试 */ }
  }, 400);
}

async function start(): Promise<void> {
  if (!props.url) return;
  status.value = { status: 'downloading', receivedBytes: 0, totalBytes: null, filePath: null, fileName: null, error: null };
  try {
    status.value = await api.startUpdateDownload(props.url);
    startPoll();
  } catch (error) {
    status.value = {
      status: 'error', receivedBytes: 0, totalBytes: null, filePath: null, fileName: null,
      error: error instanceof Error ? error.message : '下载更新失败',
    };
  }
}

async function open(reveal: boolean): Promise<void> {
  try {
    await api.openUpdateDownload(reveal);
  } catch (error) {
    const message = error instanceof Error ? error.message : '打开安装包失败';
    if (status.value) status.value = { ...status.value, status: 'error', error: message };
  }
}

watch(() => props.url, () => { stopPoll(); status.value = null; });
onBeforeUnmount(stopPoll);
</script>

<template>
  <span class="update-dl">
    <template v-if="!status || status.status === 'idle' || status.status === 'error'">
      <button class="compact-button" :disabled="!url" @click="start"><CloudDownload :size="14" />下载更新</button>
      <span v-if="status?.status === 'error'" class="update-dl-error" role="alert">{{ status.error }}</span>
    </template>
    <template v-else-if="status.status === 'downloading'">
      <span class="update-dl-bar" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100" aria-label="下载进度">
        <span :style="{ width: `${percent}%` }" />
      </span>
      <span class="update-dl-meta">{{ percent }}% · {{ receivedLabel }}<template v-if="totalLabel"> / {{ totalLabel }}</template></span>
    </template>
    <template v-else>
      <span class="update-dl-done"><Check :size="14" />已下载 {{ status.fileName }}</span>
      <button class="compact-button" @click="open(false)">打开安装包</button>
      <button class="compact-button" @click="open(true)">在访达中显示</button>
    </template>
    <a v-if="url" class="update-dl-browser" :href="url" target="_blank" rel="noreferrer">浏览器打开</a>
  </span>
</template>

<style scoped>
.update-dl { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.update-dl-bar { position: relative; width: 140px; height: 6px; border-radius: 999px; background: var(--color-list-muted); overflow: hidden; }
.update-dl-bar > span { display: block; height: 100%; background: var(--color-brand); border-radius: 999px; transition: width 160ms linear; }
.update-dl-meta { color: var(--color-text-muted); font-size: .857143rem; font-variant-numeric: tabular-nums; }
.update-dl-done { display: inline-flex; align-items: center; gap: 4px; color: var(--color-brand); font-size: .928571rem; }
.update-dl-error { color: var(--color-yellow); font-size: .857143rem; }
.update-dl-browser { color: var(--color-text-muted); font-size: .857143rem; text-decoration: underline; }
</style>
