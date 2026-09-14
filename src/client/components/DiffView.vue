<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next';
import type { PresentedDiff } from '../diff-presentation';

defineProps<{
  presentation: PresentedDiff;
  /** 无障碍标签，说明这份 diff 属于哪个文件或哪次提交。 */
  label: string;
  /** 传了就在每个 hunk 上方显示一个操作按钮，例如「暂存此块」。 */
  hunkActionLabel?: string;
  /** 正在处理中的 hunk 序号；非 null 时全部按钮禁用。 */
  pendingHunkIndex?: number | null;
}>();

const emit = defineEmits<{ hunkAction: [hunkIndex: number] }>();
</script>

<template>
  <div class="diff-view" role="table" :aria-label="label">
    <template v-for="line in presentation.lines" :key="line.id">
      <div v-if="line.kind === 'hunk' && hunkActionLabel" class="diff-hunk-bar" role="row">
        <code class="diff-hunk-text" role="cell">{{ line.tokens.map((token) => token.text).join('') }}</code>
        <button
          class="diff-hunk-action"
          type="button"
          :disabled="(pendingHunkIndex ?? null) !== null"
          :aria-label="`${hunkActionLabel}：${line.tokens.map((token) => token.text).join('')}`"
          @click="emit('hunkAction', line.hunkIndex ?? 0)"
        ><LoaderCircle v-if="pendingHunkIndex === line.hunkIndex" :size="12" class="spinning" /><span v-else>{{ hunkActionLabel }}</span></button>
      </div>
      <div v-else class="diff-line" :data-kind="line.kind" role="row">
        <span class="diff-line-number old" role="cell">{{ line.oldLine ?? '' }}</span>
        <span class="diff-line-number new" role="cell">{{ line.newLine ?? '' }}</span>
        <span
          class="diff-line-marker"
          role="cell"
          :aria-label="line.kind === 'addition' ? '新增行' : line.kind === 'deletion' ? '删除行' : undefined"
        >{{ line.marker }}</span>
        <code class="diff-line-code" role="cell"><span
          v-for="(token, tokenIndex) in line.tokens"
          :key="`${line.id}:${tokenIndex}`"
          :class="`syntax-${token.kind}`"
        >{{ token.text }}</span></code>
      </div>
    </template>
  </div>
</template>
