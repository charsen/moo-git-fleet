<script setup lang="ts">
import { FileDiff, LoaderCircle } from 'lucide-vue-next';
import type { PresentedDiff } from '../diff-presentation';

defineProps<{
  presentation: PresentedDiff;
  /** 无障碍标签，说明这份 diff 属于哪个文件或哪次提交。 */
  label: string;
  /** 传了就在每个 hunk 上方显示一个操作按钮，例如「暂存此块」。 */
  hunkActionLabel?: string;
  /** 正在处理中的 hunk 序号；非 null 时全部按钮禁用。 */
  pendingHunkIndex?: number | null;
  /**
   * 有别的写操作在跑（提交、切分支、丢弃…），此时块按钮要禁用。
   * 刻意不包含「正在执行的那一块」——那由 `pendingHunkIndex` 表达，好让 spinner 显示出来；
   * 也不该包含只读的提交预览读取，否则每点一块整排按钮就消失一百多毫秒。
   */
  hunkActionBlocked?: boolean;
}>();

const emit = defineEmits<{ hunkAction: [hunkIndex: number] }>();
</script>

<template>
  <!-- 二进制 diff 只有补丁头（diff --git / index / Binary files …），把它当正文渲染没有意义。 -->
  <div v-if="presentation.binary" class="diff-binary" :aria-label="label">
    <FileDiff :size="22" aria-hidden="true" />
    <div><strong>二进制文件</strong><span>{{ presentation.binaryNote ?? '二进制内容已变化' }} · 没有文本差异可显示</span></div>
  </div>
  <div v-else class="diff-view" role="table" :aria-label="label">
    <template v-for="line in presentation.lines" :key="line.id">
      <div v-if="line.kind === 'hunk' && hunkActionLabel" class="diff-hunk-bar" role="row">
        <code class="diff-hunk-text" role="cell">{{ line.tokens.map((token) => token.text).join('') }}</code>
        <button
          class="diff-hunk-action"
          type="button"
          :disabled="hunkActionBlocked || (pendingHunkIndex ?? null) !== null"
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
