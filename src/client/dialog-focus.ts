/**
 * 弹层与抽屉的焦点管理。
 *
 * 约定：可聚焦层在根元素上标 `data-focus-layer`，同一时刻只应存在一个；
 * 关闭后要还焦点的触发器标 `data-focus-return="<layer>"`，弹窗内首选聚焦项标 `data-dialog-initial`。
 */

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** 最上层的焦点层；后挂载的层在 DOM 里更靠后，所以取最后一个。 */
export function activeFocusLayer(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-layer]')].at(-1) ?? null;
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
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const collapsedDetails = element.closest('details:not([open])');
    return !collapsedDetails || element.tagName === 'SUMMARY';
  });
}

export function focusInitialControl(): void {
  const layer = activeFocusLayer();
  if (!layer) return;
  const preferred = layer.querySelector<HTMLElement>('[data-dialog-initial]');
  (preferred ?? focusableControls(layer)[0] ?? layer).focus();
}

/** 把 Tab 循环限制在当前焦点层内；返回 true 表示事件已被处理。 */
export function trapDialogFocus(event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false;
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
