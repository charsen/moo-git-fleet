/**
 * 弹层与抽屉的焦点管理。
 *
 * 约定：可聚焦层在根元素上标 `data-focus-layer`，同一时刻只应存在一个；
 * 关闭后要还焦点的触发器标 `data-focus-return="<layer>"`，弹窗内首选聚焦项标 `data-dialog-initial`。
 */

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/**
 * 正在离场的元素。
 *
 * `<transition>` 会把离场元素留在 DOM 里直到动画结束（`fade-leave-active` 持续 160 ms），
 * 这期间它仍然带着 `data-focus-layer`。若把它当成「最上层」，就会出现这种时序：
 * 弹窗 A 关闭的同时抽屉 B 打开 → 焦点被送进 A 里即将被移除的输入框 → A 移除后焦点掉到 body。
 * 用户看到的是「新面板打开了，但键盘什么都没选中」。
 */
function isLeavingLayer(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if ([...node.classList].some((name) => name.endsWith('-leave-active'))) return true;
  }
  return false;
}

/** 最上层的焦点层；后挂载的层在 DOM 里更靠后，所以取最后一个（跳过正在离场的）。 */
export function activeFocusLayer(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-layer]')]
    .filter((element) => isVisibleControl(element) && !isLeavingLayer(element)).at(-1) ?? null;
}

function isVisibleControl(element: HTMLElement): boolean {
  if (element.closest('[inert], [aria-hidden="true"]') || !element.getClientRects().length) return false;
  return getComputedStyle(element).visibility === 'visible';
}

export function focusReturnFallback(layer: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-return]')]
    .find((element) => element.dataset.focusReturn === layer) ?? null;
}

/** 层内可 Tab 到的控件；跳过 `aria-hidden` 与折叠 `<details>` 里除 summary 之外的内容。 */
export function focusableControls(layer: HTMLElement): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], summary, input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => {
    if (element.tabIndex < 0 || !isVisibleControl(element)) return false;
    const collapsedDetails = element.closest('details:not([open])');
    return !collapsedDetails || element.tagName === 'SUMMARY';
  });
}

export function focusInitialControl(): void {
  const layer = activeFocusLayer();
  if (!layer) return;
  const preferred = layer.querySelector<HTMLElement>('[data-dialog-initial]');
  const controls = focusableControls(layer);
  (preferred && controls.includes(preferred) ? preferred : controls[0] ?? layer).focus({ preventScroll: true });
}

/** 把 Tab 循环限制在当前焦点层内；返回 true 表示事件已被处理。 */
export function trapDialogFocus(event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false;
  // 局部控件（可搜索下拉、管理分支面板）已经接管 Tab 时不要再抢一次焦点，
  // 否则它们刚移好的目标会被这里覆盖掉。
  if (event.defaultPrevented) return true;
  const layer = activeFocusLayer();
  if (!layer) return false;
  const controls = focusableControls(layer);
  if (controls.length === 0) {
    event.preventDefault();
    layer.focus();
    return true;
  }
  const activeIndex = controls.findIndex((control) => control === document.activeElement);
  const nextIndex = event.shiftKey
    ? activeIndex <= 0 ? controls.length - 1 : activeIndex - 1
    : activeIndex < 0 || activeIndex >= controls.length - 1 ? 0 : activeIndex + 1;
  event.preventDefault();
  controls[nextIndex]?.focus();
  return true;
}
