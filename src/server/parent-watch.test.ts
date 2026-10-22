import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARENT_WATCH_INTERVAL_MS, shouldWatchParent, startParentWatch } from './parent-watch.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('shouldWatchParent', () => {
  it('ppid 为 1 时跳过看护（已是被收养的孤儿或由 launchd 直启）', () => {
    expect(shouldWatchParent(1, {})).toBe(false);
    expect(shouldWatchParent(0, {})).toBe(false);
  });

  it('有真实父进程时默认开启', () => {
    expect(shouldWatchParent(8_888, {})).toBe(true);
  });

  it('MOO_FLEET_PARENT_WATCH=0 可以显式关闭', () => {
    expect(shouldWatchParent(8_888, { MOO_FLEET_PARENT_WATCH: '0' })).toBe(false);
    expect(shouldWatchParent(8_888, { MOO_FLEET_PARENT_WATCH: '1' })).toBe(true);
  });
});

describe('startParentWatch', () => {
  it('父进程消失后回调一次，之后的轮询不再重复触发', () => {
    vi.useFakeTimers();
    let ppid = 900;
    const onParentGone = vi.fn();
    startParentWatch({ initialPpid: 900, readPpid: () => ppid, onParentGone });

    vi.advanceTimersByTime(PARENT_WATCH_INTERVAL_MS * 3);
    expect(onParentGone).not.toHaveBeenCalled();

    ppid = 1; // 被 init 收养
    vi.advanceTimersByTime(PARENT_WATCH_INTERVAL_MS);
    expect(onParentGone).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARENT_WATCH_INTERVAL_MS * 5);
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it('ppid 不变时永不触发', () => {
    vi.useFakeTimers();
    const onParentGone = vi.fn();
    startParentWatch({ initialPpid: 900, readPpid: () => 900, onParentGone });
    vi.advanceTimersByTime(PARENT_WATCH_INTERVAL_MS * 10);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it('停止后不再触发', () => {
    vi.useFakeTimers();
    let ppid = 900;
    const onParentGone = vi.fn();
    const stop = startParentWatch({ initialPpid: 900, readPpid: () => ppid, onParentGone });
    stop();
    ppid = 1;
    vi.advanceTimersByTime(PARENT_WATCH_INTERVAL_MS * 5);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it('启动时 ppid 已是 1 则完全不安装轮询', () => {
    vi.useFakeTimers();
    const onParentGone = vi.fn();
    const stop = startParentWatch({ initialPpid: 1, onParentGone });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PARENT_WATCH_INTERVAL_MS * 5);
    expect(onParentGone).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('看护定时器带 unref，不会独自撑住事件循环', () => {
    const realSetInterval = globalThis.setInterval;
    let captured: NodeJS.Timeout | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
      captured = realSetInterval(handler, ms);
      return captured;
    }) as typeof setInterval);

    const stop = startParentWatch({ initialPpid: 900, readPpid: () => 900, onParentGone: () => {} });
    expect(captured?.hasRef()).toBe(false);
    stop();
    vi.restoreAllMocks();
  });
});
