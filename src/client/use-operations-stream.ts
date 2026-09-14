import { ref, type Ref } from 'vue';
import type { OperationsPayload } from '../shared/contracts';

const reconnectDelayMs = 2_000;

export interface OperationsStreamOptions {
  /** 收到一份合法快照时写入查询缓存。 */
  applyPayload: (payload: OperationsPayload) => void;
  /** 断线或解析失败时兜底拉一次，保证界面最终一致。 */
  refetch: () => void;
}

export interface OperationsStream {
  /** 事件流是否处于已连接状态；界面用它区分「SSE 实时」与「轮询兜底」。 */
  connected: Ref<boolean>;
  connect: () => void;
  disconnect: () => void;
}

function isOperationsPayload(value: unknown): value is OperationsPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Partial<OperationsPayload>;
  return Array.isArray(payload.batches) && Array.isArray(payload.operations);
}

/**
 * 操作记录事件流。
 *
 * 解析失败与网络错误走同一条恢复路径：关闭当前连接、延迟 2 秒重连，
 * 重连期间由调用方的查询轮询兜底。`EventSource` 在非浏览器环境不存在时静默跳过。
 */
export function useOperationsStream(options: OperationsStreamOptions): OperationsStream {
  const connected = ref(false);
  let eventSource: EventSource | null = null;
  let reconnectTimer: number | null = null;

  function scheduleReconnect(source: EventSource): void {
    if (eventSource !== source) return;
    connected.value = false;
    source.close();
    eventSource = null;
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect(): void {
    if (typeof EventSource === 'undefined' || eventSource) return;
    const source = new EventSource('/api/operations/events');
    eventSource = source;
    source.addEventListener('open', () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connected.value = true;
    });
    source.addEventListener('operations', (event) => {
      try {
        const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!isOperationsPayload(payload)) throw new Error('invalid SSE payload');
        options.applyPayload(payload);
        connected.value = true;
      } catch {
        scheduleReconnect(source);
      }
    });
    source.addEventListener('error', () => {
      options.refetch();
      scheduleReconnect(source);
    });
  }

  function disconnect(): void {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    connected.value = false;
  }

  return { connected, connect, disconnect };
}
