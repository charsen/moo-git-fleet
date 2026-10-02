<script setup lang="ts">
import { computed } from 'vue';
import type { BlameLine } from '../../shared/contracts';
import { presentCodeContent } from '../diff-presentation';
const props = defineProps<{ content: string; path: string; label: string; blame?: BlameLine[] }>();
const emit = defineEmits<{ commit: [hash: string] }>();
const code = computed(() => presentCodeContent(props.content, props.path));
</script>
<template>
  <div class="code-content" :class="{ 'code-content--blame': blame }" role="table" :aria-label="label">
    <div v-for="(tokens, index) in code.lines" :key="index" class="code-content-line" role="row">
      <button v-if="blame?.[index]" class="code-blame" :class="{ 'code-blame--continuation': index > 0 && blame[index - 1]?.hash === blame[index]!.hash }" role="cell" :aria-label="`查看第 ${index + 1} 行归属提交 ${blame[index]!.hash.slice(0, 7)}`" :title="`${blame[index]!.author} · ${new Date(blame[index]!.authoredAt).toLocaleString()}\n${blame[index]!.subject}\n原路径 ${blame[index]!.originalPath} · ${blame[index]!.originalLine} 行`" @click="emit('commit', blame[index]!.hash)"><span>{{ blame[index]!.author }}</span><code>{{ blame[index]!.hash.slice(0, 7) }}</code></button>
      <span class="code-line-number" role="cell">{{ index + 1 }}</span>
      <code role="cell" class="code-line-text"><span v-for="(token, i) in tokens" :key="i" :class="`syntax-${token.kind}`">{{ token.text }}</span></code>
    </div>
    <p v-if="!code.lines.length" class="workspace-history-note code-empty">空文件</p>
  </div>
</template>
