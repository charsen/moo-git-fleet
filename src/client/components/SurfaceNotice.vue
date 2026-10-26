<script setup lang="ts">
import { AlertTriangle, Check, LoaderCircle, X } from 'lucide-vue-next';
import type { Notice } from '../notices';

/**
 * 一条消息的样子。
 *
 * 只有图标带状态色，正文保持普通文字色：一句话不该把整行染绿或染红。
 * `progress` 用旋转的 loader 代替勾，表示「系统还在动」，不需要用户读到。
 */
defineProps<{ notice: Notice }>();
const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    class="surface-feedback"
    :class="notice.severity"
    :role="notice.severity === 'error' ? 'alert' : 'status'"
    :aria-live="notice.severity === 'error' ? 'assertive' : 'polite'"
  >
    <LoaderCircle v-if="notice.severity === 'progress'" :size="13" class="spinning" />
    <AlertTriangle v-else-if="notice.severity !== 'success'" :size="13" />
    <Check v-else :size="13" />
    <span>{{ notice.text }}</span>
    <button aria-label="关闭提示" @click="emit('dismiss')"><X :size="13" /></button>
  </div>
</template>
