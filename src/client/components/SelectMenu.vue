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
const activeOptionValue = ref<string | number | null>(null);
let typeaheadBuffer = '';
let typeaheadTimer: number | null = null;

const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const triggerLabel = computed(
  () => selectedOption.value?.label ?? props.placeholder ?? props.options[0]?.label ?? '',
);

function optionElements(): HTMLButtonElement[] {
  return Array.from(rootEl.value?.querySelectorAll<HTMLButtonElement>('.select-menu-option') ?? []);
}

function enabledOptionEntries(): Array<{ element: HTMLButtonElement; option: SelectMenuOption }> {
  return optionElements()
    .map((element, index) => ({ element, option: props.options[index] }))
    .filter((entry): entry is { element: HTMLButtonElement; option: SelectMenuOption } => Boolean(entry.option) && !entry.element.disabled);
}

function resetTypeahead(): void {
  typeaheadBuffer = '';
  if (typeaheadTimer !== null) {
    window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }
}

function focusOption(option: SelectMenuOption, element?: HTMLButtonElement): void {
  activeOptionValue.value = option.value;
  (element ?? optionElements()[props.options.indexOf(option)])?.focus({ preventScroll: true });
}

function close(restoreFocus = false): void {
  if (!open.value) return;
  open.value = false;
  activeOptionValue.value = null;
  resetTypeahead();
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
  if (target) {
    const targetOption = props.options[options.indexOf(target)];
    if (targetOption) focusOption(targetOption, target);
  }
}

async function openWithArrow(offset: number): Promise<void> {
  if (props.disabled || open.value) return;
  open.value = true;
  await nextTick();
  const enabled = optionElements().filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((option) => option.classList.contains('current'));
  const start = currentIndex >= 0 ? currentIndex : offset > 0 ? -1 : 0;
  const target = enabled[(start + offset + enabled.length) % enabled.length];
  if (target) {
    const targetOption = props.options[optionElements().indexOf(target)];
    if (targetOption) focusOption(targetOption, target);
  }
}

function moveOption(event: KeyboardEvent, offset: number): void {
  const enabled = optionElements().filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((option) => option === event.currentTarget);
  if (currentIndex < 0) {
    const target = enabled[offset > 0 ? 0 : enabled.length - 1];
    if (target) {
      const targetOption = props.options[optionElements().indexOf(target)];
      if (targetOption) focusOption(targetOption, target);
    }
    return;
  }
  const target = enabled[(currentIndex + offset + enabled.length) % enabled.length];
  if (target) {
    const targetOption = props.options[optionElements().indexOf(target)];
    if (targetOption) focusOption(targetOption, target);
  }
}

function moveToBoundary(position: 'start' | 'end'): void {
  const entries = enabledOptionEntries();
  const target = entries[position === 'start' ? 0 : entries.length - 1];
  if (target) focusOption(target.option, target.element);
}

function handleOptionFocus(option: SelectMenuOption): void {
  activeOptionValue.value = option.value;
}

function handleTypeahead(event: KeyboardEvent): void {
  if (!open.value || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
  const character = event.key.toLocaleLowerCase();
  if (!character.trim()) return;

  typeaheadBuffer += character;
  if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
  typeaheadTimer = window.setTimeout(resetTypeahead, 700);

  const entries = enabledOptionEntries();
  if (entries.length === 0) return;
  const focusedIndex = entries.findIndex((entry) => entry.element === document.activeElement);
  const start = focusedIndex >= 0 ? focusedIndex + 1 : 0;
  const ordered = [...entries.slice(start), ...entries.slice(0, start)];
  const match = ordered.find((entry) => `${entry.option.label} ${entry.option.hint ?? ''}`.toLocaleLowerCase().startsWith(typeaheadBuffer))
    ?? (typeaheadBuffer.length > 1
      ? ordered.find((entry) => `${entry.option.label} ${entry.option.hint ?? ''}`.toLocaleLowerCase().startsWith(character))
      : undefined);
  if (match) {
    event.preventDefault();
    focusOption(match.option, match.element);
  }
}

function handleOptionTab(event: KeyboardEvent): void {
  if (event.shiftKey) {
    event.preventDefault();
    close(true);
  }
}

function handleFocusOut(event: FocusEvent): void {
  if (!open.value) return;
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && rootEl.value?.contains(nextTarget)) return;
  close();
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
  resetTypeahead();
});
</script>

<template>
  <div ref="rootEl" class="select-menu" :class="attrs.class" :style="attrs.style as any" @focusout="handleFocusOut">
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
          :tabindex="option.value === activeOptionValue ? 0 : -1"
          role="option"
          :aria-selected="option.value === modelValue"
          :disabled="option.disabled"
          @click="selectOption(option)"
          @focus="handleOptionFocus(option)"
          @keydown="handleTypeahead"
          @keydown.down.prevent="moveOption($event, 1)"
          @keydown.up.prevent="moveOption($event, -1)"
          @keydown.home.prevent="moveToBoundary('start')"
          @keydown.end.prevent="moveToBoundary('end')"
          @keydown.tab="handleOptionTab"
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
