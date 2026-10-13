import { ref } from 'vue';

export type ConfirmationTone = 'info' | 'caution' | 'danger';

export interface ConfirmationInput {
  label: string;
  value: string;
  validate?: (value: string) => string | null;
}

export function confirmationInputError(input?: ConfirmationInput): string | null {
  if (!input) return null;
  const value = input.value.trim();
  if (!value) return '请输入' + input.label;
  return input.validate?.(value) ?? null;
}

export interface ConfirmationOptions {
  title: string;
  summary: string;
  target?: string;
  details: string[];
  confirmLabel: string;
  tone?: ConfirmationTone;
  input?: ConfirmationInput;
}

export interface ActiveConfirmation extends ConfirmationOptions {
  id: number;
  tone: ConfirmationTone;
  resolve: (accepted: boolean) => void;
}

/**
 * 全局唯一确认弹窗。
 *
 * 约定：任何写操作在真正执行前都先 `await requestConfirmation(...)`；
 * 弹窗关闭（确认或取消）都会 resolve，调用方必须同时处理 `false`。
 * 若在弹窗未关闭时再次请求，前一个请求会立即以 `false` 结算，避免悬空 Promise。
 */
export function useConfirmation() {
  const confirmation = ref<ActiveConfirmation | null>(null);
  let confirmationId = 0;

  function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
    if (confirmation.value) confirmation.value.resolve(false);
    return new Promise((resolve) => {
      confirmation.value = {
        ...options,
        id: ++confirmationId,
        tone: options.tone ?? 'info',
        resolve,
      };
    });
  }

  function settleConfirmation(accepted: boolean): void {
    const activeConfirmation = confirmation.value;
    if (!activeConfirmation) return;
    if (accepted && confirmationInputError(activeConfirmation.input)) return;
    confirmation.value = null;
    activeConfirmation.resolve(accepted);
  }

  return { confirmation, requestConfirmation, settleConfirmation };
}
