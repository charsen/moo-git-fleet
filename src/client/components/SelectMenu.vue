<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

interface SelectMenuOption {
  value: string | number;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    options: SelectMenuOption[];
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
  }>(),
  {
    ariaLabel: '',
    disabled: false,
    placeholder: undefined,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>();

defineOptions({ inheritAttrs: false });

const attrs = useAttrs();
// aria-* attributes are always treated as raw attrs by Vue, so accept the label
// either through the `ariaLabel` prop or a plain `aria-label="…"` on the tag.
const resolvedAriaLabel = computed(() => props.ariaLabel || String(attrs['aria-label'] ?? ''));
const triggerAttrs = computed(() => {
  const { class: _class, style: _style, 'aria-label': _ariaLabel, ...rest } = attrs;
  return rest;
});

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const listboxId = `select-menu-${useId()}`;

const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const triggerLabel = computed(
  () => selectedOption.value?.label ?? props.placeholder ?? props.options[0]?.label ?? '',
);

function optionElements(): HTMLButtonElement[] {
  return Array.from(rootEl.value?.querySelectorAll<HTMLButtonElement>('.select-menu-option') ?? []);
}

function close(restoreFocus = false): void {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) requestAnimationFrame(() => triggerEl.value?.focus({ preventScroll: true }));
}

async function toggle(): Promise<void> {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  await nextTick();
  const options = optionElements();
  const current = options.find((option) => option.classList.contains('current') && !option.disabled);
  const target = current ?? options.find((option) => !option.disabled);
  target?.focus({ preventScroll: true });
}

async function openWithArrow(offset: number): Promise<void> {
  if (props.disabled || open.value) return;
  open.value = true;
  await nextTick();
  const enabled = optionElements().filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((option) => option.classList.contains('current'));
  const start = currentIndex >= 0 ? currentIndex : offset > 0 ? -1 : 0;
  enabled[(start + offset + enabled.length) % enabled.length]?.focus({ preventScroll: true });
}

function moveOption(event: KeyboardEvent, offset: number): void {
  const enabled = optionElements().filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((option) => option === event.currentTarget);
  if (currentIndex < 0) {
    enabled[offset > 0 ? 0 : enabled.length - 1]?.focus({ preventScroll: true });
    return;
  }
  enabled[(currentIndex + offset + enabled.length) % enabled.length]?.focus({ preventScroll: true });
}

function selectOption(option: SelectMenuOption): void {
  if (option.disabled) return;
  if (option.value !== props.modelValue) emit('update:modelValue', option.value);
  close(true);
}

function handlePointerDown(event: PointerEvent): void {
  if (!open.value) return;
  if (event.target instanceof Node && !rootEl.value?.contains(event.target)) close();
}

function handleScroll(event: Event): void {
  if (!open.value) return;
  if (event.target instanceof Node && rootEl.value?.contains(event.target)) return;
  close();
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('scroll', handleScroll, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true);
  document.removeEventListener('scroll', handleScroll, true);
});
</script>

<template>
  <div ref="rootEl" class="select-menu" :class="attrs.class" :style="attrs.style as any">
    <button
      ref="triggerEl"
      type="button"
      class="select-menu-trigger"
      :class="{ active: open }"
      :disabled="disabled"
      :aria-label="resolvedAriaLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="listboxId"
      v-bind="triggerAttrs"
      @click="toggle"
      @keydown.down.prevent="openWithArrow(1)"
      @keydown.up.prevent="openWithArrow(-1)"
      @keydown.esc.stop.prevent="close(true)"
    >
      <span class="select-menu-value">{{ triggerLabel }}</span>
      <ChevronDown :size="15" />
    </button>
    <transition name="branch-popover">
      <div v-if="open" :id="listboxId" class="select-menu-options" role="listbox" :aria-label="resolvedAriaLabel">
        <button
          v-for="option in options"
          :key="String(option.value)"
          type="button"
          class="select-menu-option"
          :class="{ current: option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue"
          :disabled="option.disabled"
          @click="selectOption(option)"
          @keydown.down.prevent="moveOption($event, 1)"
          @keydown.up.prevent="moveOption($event, -1)"
          @keydown.esc.stop.prevent="close(true)"
        >
          <template v-if="option.hint">
            <strong>{{ option.label }}</strong>
            <small>{{ option.hint }}</small>
          </template>
          <span v-else class="select-menu-option-label">{{ option.label }}</span>
        </button>
      </div>
    </transition>
  </div>
</template>
