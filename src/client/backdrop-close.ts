/**
 * 遮罩层点击关闭。
 *
 * 不能用 `@click.self`。`click` 的 target 是「按下目标与松开目标的最近公共祖先」，
 * 而弹窗是遮罩的子节点，所以「在弹窗里按下 → 拖到遮罩上松开」时公共祖先正是遮罩，
 * `target === currentTarget` 成立，`@click.self` 照样被触发。用户在有输入框的弹窗里
 * 按住鼠标选中文字往窗口外一拖，弹窗就关了，未保存的编辑一起丢掉。
 *
 * 正确的判据是「按下与松开都发生在遮罩上」。把按下、松开、点击三步拆成纯函数，
 * 方便单测；`vBackdropClose` 指令只负责把 DOM 事件喂进来。
 */

import type { Directive } from 'vue';

export interface BackdropGesture {
  /** 按下点是否落在遮罩本身，而不是弹窗内容里。 */
  pressedOnBackdrop: boolean;
  /** 松开点是否落在遮罩本身。 */
  releasedOnBackdrop: boolean;
}

export const IDLE_BACKDROP_GESTURE: BackdropGesture = {
  pressedOnBackdrop: false,
  releasedOnBackdrop: false,
};

export function beginBackdropGesture(targetIsBackdrop: boolean): BackdropGesture {
  return { pressedOnBackdrop: targetIsBackdrop, releasedOnBackdrop: false };
}

export function endBackdropGesture(gesture: BackdropGesture, targetIsBackdrop: boolean): BackdropGesture {
  // 按下点不在遮罩上，这次手势与遮罩无关，松开点在哪都不该把它变成一次「点外部」。
  if (!gesture.pressedOnBackdrop) return IDLE_BACKDROP_GESTURE;
  return { pressedOnBackdrop: true, releasedOnBackdrop: targetIsBackdrop };
}

/** 按下、松开、点击三者都落在遮罩上才关闭。 */
export function resolvesBackdropClick(gesture: BackdropGesture, targetIsBackdrop: boolean): boolean {
  return targetIsBackdrop && gesture.pressedOnBackdrop && gesture.releasedOnBackdrop;
}

interface BackdropBinding {
  gesture: BackdropGesture;
  handler: () => void;
  pointerDown: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: () => void;
  click: (event: MouseEvent) => void;
}

const bindings = new WeakMap<HTMLElement, BackdropBinding>();

/**
 * 用法：`<div class="modal-backdrop" v-backdrop-close="closeDialog">`。
 * 指令值是要执行的关闭动作；`updated` 时会换成最新闭包，所以可以直接传内联箭头函数。
 */
export const vBackdropClose: Directive<HTMLElement, () => void> = {
  mounted(element, binding) {
    const record: BackdropBinding = {
      gesture: IDLE_BACKDROP_GESTURE,
      handler: binding.value,
      pointerDown(event) {
        record.gesture = beginBackdropGesture(event.target === element);
      },
      pointerUp(event) {
        record.gesture = endBackdropGesture(record.gesture, event.target === element);
      },
      pointerCancel() {
        record.gesture = IDLE_BACKDROP_GESTURE;
      },
      click(event) {
        const dismiss = resolvesBackdropClick(record.gesture, event.target === element);
        record.gesture = IDLE_BACKDROP_GESTURE;
        if (dismiss) record.handler();
      },
    };
    // 用捕获阶段：弹窗内部哪怕 stopPropagation，也不能漏掉「按下点在弹窗里」这个事实。
    element.addEventListener('pointerdown', record.pointerDown, true);
    element.addEventListener('pointerup', record.pointerUp, true);
    element.addEventListener('pointercancel', record.pointerCancel, true);
    element.addEventListener('click', record.click);
    bindings.set(element, record);
  },
  updated(element, binding) {
    const record = bindings.get(element);
    if (record) record.handler = binding.value;
  },
  unmounted(element) {
    const record = bindings.get(element);
    if (!record) return;
    element.removeEventListener('pointerdown', record.pointerDown, true);
    element.removeEventListener('pointerup', record.pointerUp, true);
    element.removeEventListener('pointercancel', record.pointerCancel, true);
    element.removeEventListener('click', record.click);
    bindings.delete(element);
  },
};
