<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, type Component } from 'vue';

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: Component;
  disabled?: string | null;
  danger?: boolean;
}
const props = defineProps<{ label: string; items: ActionMenuItem[] }>();
const emit = defineEmits<{ select: [id: string] }>();
const visible = ref(false), left = ref(0), top = ref(0);
const panel = ref<HTMLElement | null>(null);
let origin: HTMLElement | null = null;
function close(restore = true): void {
  visible.value = false;
  if (restore && origin?.isConnected) origin.focus({ preventScroll: true });
}
async function open(event: MouseEvent | KeyboardEvent): Promise<void> {
  event.preventDefault();
  origin = event.currentTarget as HTMLElement;
  const box = origin.getBoundingClientRect();
  const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0);
  left.value = pointer ? event.clientX : box.left;
  top.value = pointer ? event.clientY : box.bottom;
  visible.value = true;
  await nextTick();
  if (!visible.value || !panel.value) return;
  const rect = panel.value.getBoundingClientRect();
  left.value = Math.max(8, Math.min(left.value, window.innerWidth - rect.width - 8));
  top.value = Math.max(8, Math.min(top.value, window.innerHeight - rect.height - 8));
  panel.value.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
}
function select(item: ActionMenuItem): void {
  if (item.disabled) return;
  close();
  emit('select', item.id);
}
function key(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault(); event.stopPropagation(); close(); return;
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const items = [...panel.value!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}
function outside(event: PointerEvent): void {
  if (visible.value && !panel.value?.contains(event.target as Node)) close(false);
}
function dismiss(): void { if (visible.value) close(); }
function scroll(event: Event): void { if (!panel.value?.contains(event.target as Node)) dismiss(); }
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('scroll', scroll, true);
  window.removeEventListener('resize', dismiss);
  window.removeEventListener('blur', dismiss);
});
defineExpose({ open, close });
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" ref="panel" class="action-menu" role="menu" :aria-label="label" data-focus-layer :style="{ left: `${left}px`, top: `${top}px` }" @keydown="key" @focusout="!panel?.contains($event.relatedTarget as Node) && close(false)">
      <p class="action-menu-heading">{{ label }}</p>
      <button v-for="item in props.items" :key="item.id" role="menuitem" tabindex="-1" :aria-disabled="Boolean(item.disabled)" :title="item.disabled || undefined" :class="{ danger: item.danger }" @click="select(item)">
        <component :is="item.icon" v-if="item.icon" :size="14" aria-hidden="true" />
        <span>{{ item.label }}<small v-if="item.disabled">{{ item.disabled }}</small></span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.action-menu { position: fixed; z-index: 150; width: 238px; max-width: calc(100vw - 16px); padding: 5px; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-surface-raised); box-shadow: 0 8px 28px #0005; font: 400 .857143rem var(--ui-font-family, system-ui, sans-serif); }
.action-menu-heading { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 3px 4px; padding: 5px 6px 7px; border-bottom: 1px solid var(--color-border-subtle); color: var(--color-text-muted); font-size: .785714rem; }
.action-menu button { width: 100%; min-height: 32px; display: flex; align-items: center; gap: 9px; border: 0; border-radius: 4px; padding: 7px 9px; background: transparent; color: var(--color-text); font: inherit; text-align: left; cursor: pointer; }
.action-menu button span { min-width: 0; flex: 1; }
.action-menu button small { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: .785714rem; }
.action-menu button.danger { color: var(--color-red); }
.action-menu button[aria-disabled="true"] { opacity: .55; cursor: default; }
.action-menu button:hover:not([aria-disabled="true"]), .action-menu button:focus-visible { background: var(--color-surface); outline: 1px solid var(--color-border); outline-offset: -1px; }
</style>
