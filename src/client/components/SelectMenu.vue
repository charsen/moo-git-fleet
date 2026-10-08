<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, watch } from 'vue';
import { ChevronDown, Search } from 'lucide-vue-next';
import type { SelectMenuOption } from '../select-options';

const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    options: SelectMenuOption[];
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
    searchable?: boolean;
    searchPlaceholder?: string;
  }>(),
  {
    ariaLabel: '',
    disabled: false,
    placeholder: undefined,
    searchable: false,
    searchPlaceholder: '搜索选项',
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
const popoverEl = ref<HTMLElement | null>(null);
/** 下方放不下时向上弹出；就地弹层会被最近的滚动/裁剪容器切掉（例如设置弹窗底部的下拉）。 */
const dropUp = ref(false);
/** 两侧都放不下时用它把弹层压到可用高度，改成弹层内部滚动，而不是被容器裁掉。 */
const popoverMaxHeight = ref<number | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const search = ref('');
const searchText = (option: SelectMenuOption): string =>
  `${option.label} ${option.hint ?? ''} ${option.keywords ?? ''}`.toLocaleLowerCase();
const visibleOptions = computed(() => {
  const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return props.options.filter(option => terms.every(term => searchText(option).includes(term)));
});
const listboxId = `select-menu-${useId()}`;
/** 选项右侧的状态/计数标记；只有「快速切换项目」这类下拉会用到。 */
function hasMeta(option: SelectMenuOption): boolean {
  return Boolean(option.status || option.counts?.length);
}
function optionAriaLabel(option: SelectMenuOption): string {
  const extra = [option.hint, ...(option.counts ?? []).map(count => count.label), option.status?.label].filter(Boolean);
  return extra.length > 0 ? `${option.label}，${extra.join('，')}` : option.label;
}
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
    .map((element, index) => ({ element, option: visibleOptions.value[index] }))
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
  (element ?? optionElements()[visibleOptions.value.indexOf(option)])?.focus({ preventScroll: true });
}

function close(restoreFocus = false): void {
  open.value = false;
  search.value = '';
  activeOptionValue.value = null;
  resetTypeahead();
  if (restoreFocus) requestAnimationFrame(() => triggerEl.value?.focus({ preventScroll: true }));
}

/** 取最近的滚动/裁剪容器的可见范围，没有就用视口；弹层不能越过它。 */
function clippingBounds(): { top: number; bottom: number } {
  for (let node = rootEl.value?.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * 弹层是就地绝对定位，会被滚动容器裁掉：下方空间不足且上方更宽裕时改为向上弹出；
 * 两侧都装不下时再把它压到可用高度、靠内部滚动显示剩余选项。
 * 高度取 `scrollHeight`（不受内联上限影响），并在 `nextTick` 后、同一次绘制前完成，避免看到跳变。
 */
function placePopover(): void {
  const popover = popoverEl.value;
  const trigger = triggerEl.value;
  if (!popover || !trigger) return;
  const bounds = clippingBounds();
  const limit = Number.parseFloat(getComputedStyle(popover).maxHeight);
  const natural = Math.min(popover.scrollHeight + 2, Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY);
  const triggerRect = trigger.getBoundingClientRect();
  const gap = 6;
  const below = bounds.bottom - triggerRect.bottom - gap;
  const above = triggerRect.top - bounds.top - gap;
  dropUp.value = below < natural && above > below;
  const available = Math.round(Math.max(dropUp.value ? above : below, 0));
  popoverMaxHeight.value = available < natural ? available : null;
}

async function toggle(): Promise<void> {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  await nextTick();
  placePopover();
  if (props.searchable) { searchEl.value?.focus({ preventScroll: true }); return; }
  const options = optionElements();
  const current = options.find((option) => option.classList.contains('current') && !option.disabled);
  const target = current ?? options.find((option) => !option.disabled);
  if (target) {
    const targetOption = visibleOptions.value[options.indexOf(target)];
    if (targetOption) focusOption(targetOption, target);
  }
}

async function openWithArrow(offset: number): Promise<void> {
  if (props.disabled || open.value) return;
  open.value = true;
  await nextTick();
  placePopover();
  if (props.searchable) { searchEl.value?.focus({ preventScroll: true }); return; }
  const enabled = optionElements().filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((option) => option.classList.contains('current'));
  const start = currentIndex >= 0 ? currentIndex : offset > 0 ? -1 : 0;
  const target = enabled[(start + offset + enabled.length) % enabled.length];
  if (target) {
    const targetOption = visibleOptions.value[optionElements().indexOf(target)];
    if (targetOption) focusOption(targetOption, target);
  }
}

function moveOption(event: KeyboardEvent, offset: number): void {
  const enabled = optionElements().filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((option) => option === event.currentTarget);
  // 可搜索时，从第一项再往上应当回到搜索框，而不是绕到最后一项把头一条盖住。
  if (props.searchable && offset < 0 && currentIndex === 0) {
    activeOptionValue.value = null;
    searchEl.value?.focus({ preventScroll: true });
    return;
  }
  if (currentIndex < 0) {
    const target = enabled[offset > 0 ? 0 : enabled.length - 1];
    if (target) {
      const targetOption = visibleOptions.value[optionElements().indexOf(target)];
      if (targetOption) focusOption(targetOption, target);
    }
    return;
  }
  const target = enabled[(currentIndex + offset + enabled.length) % enabled.length];
  if (target) {
    const targetOption = visibleOptions.value[optionElements().indexOf(target)];
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
  const match = ordered.find((entry) => searchText(entry.option).startsWith(typeaheadBuffer))
    ?? (typeaheadBuffer.length > 1
      ? ordered.find((entry) => searchText(entry.option).startsWith(character))
      : undefined);
  if (match) {
    event.preventDefault();
    focusOption(match.option, match.element);
  }
}

function handleOptionTab(event: KeyboardEvent): void {
  if (!event.shiftKey) return;
  // 可搜索时 Shift+Tab 回到搜索框，而不是直接关掉整个下拉。
  if (props.searchable && searchEl.value) {
    event.preventDefault();
    activeOptionValue.value = null;
    searchEl.value.focus({ preventScroll: true });
    return;
  }
  event.preventDefault();
  close(true);
}

function handleFocusOut(event: FocusEvent): void {
  if (!open.value) return;
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && rootEl.value?.contains(nextTarget)) return;
  close();
}

function selectOption(option: SelectMenuOption): void {
  if (props.disabled || option.disabled) return;
  if (option.value !== props.modelValue) emit('update:modelValue', option.value);
  close(true);
}

function handleSearchKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveToBoundary(event.key === 'ArrowDown' ? 'start' : 'end');
  } else if (event.key === 'Enter') {
    const first = visibleOptions.value.find(option => !option.disabled);
    event.preventDefault();
    if (first) selectOption(first);
  }
}

watch(() => props.disabled, disabled => { if (disabled) close(); });

function handlePointerDown(event: PointerEvent): void {
  if (!open.value) return;
  if (event.target instanceof Node && !rootEl.value?.contains(event.target)) close();
}

function handleScroll(event: Event): void {
  if (!open.value) return;
  if (event.target instanceof Node && rootEl.value?.contains(event.target)) return;
  close();
}

function handleTriggerEscape(event: KeyboardEvent): void {
  if (!open.value) return;
  event.preventDefault();
  event.stopPropagation();
  close(true);
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
      @keydown.esc="handleTriggerEscape"
    >
      <span class="select-menu-value"><slot name="trigger-label" :label="triggerLabel">{{ triggerLabel }}</slot></span>
      <ChevronDown :size="15" />
    </button>
    <transition name="branch-popover">
      <div v-if="open" ref="popoverEl" class="select-menu-options" :class="{ 'select-menu-options--searchable': searchable, 'select-menu-options--drop-up': dropUp }" :style="popoverMaxHeight === null ? undefined : { maxHeight: `${popoverMaxHeight}px` }" @keydown.esc.stop.prevent="close(true)">
        <label v-if="searchable" class="select-menu-search">
          <Search :size="14" />
          <input ref="searchEl" v-model="search" :aria-label="searchPlaceholder" :placeholder="searchPlaceholder" autocomplete="off" @keydown="handleSearchKey" />
        </label>
        <div :id="listboxId" role="listbox" :aria-label="resolvedAriaLabel">
        <button
          v-for="option in visibleOptions"
          :key="String(option.value)"
          type="button"
          class="select-menu-option"
          :class="{ current: option.value === modelValue, 'has-meta': hasMeta(option) }"
          :tabindex="option.value === activeOptionValue ? 0 : -1"
          role="option"
          :aria-selected="option.value === modelValue"
          :aria-label="optionAriaLabel(option)"
          :title="option.keywords ?? option.hint"
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
          <span class="select-menu-option-text">
            <template v-if="option.hint">
              <strong>{{ option.label }}</strong>
              <small><component :is="option.hintIcon" v-if="option.hintIcon" class="select-menu-hint-icon" :size="12" aria-hidden="true" /><bdi dir="ltr">{{ option.hint }}</bdi></small>
            </template>
            <span v-else class="select-menu-option-label">{{ option.label }}</span>
          </span>
          <span v-if="hasMeta(option)" class="select-menu-option-meta">
            <span v-for="count in option.counts ?? []" :key="count.label" class="count" :class="count.tone">{{ count.label }}</span>
            <span v-if="option.status" class="status-pill" :data-tone="option.status.tone"><span />{{ option.status.label }}</span>
          </span>
        </button>
        </div>
        <p v-if="searchable && !visibleOptions.length" class="select-menu-empty" role="status">没有匹配的项目</p>
      </div>
    </transition>
  </div>
</template>
