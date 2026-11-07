import { describe, expect, it } from 'vitest';
import { hasNativeShell } from './native-shell';

describe('hasNativeShell', () => {
  it('有 appearance 消息通道就是原生外壳', () => {
    expect(hasNativeShell({ webkit: { messageHandlers: { appearance: { postMessage: () => undefined } } } })).toBe(true);
  });

  it('浏览器里没有 webkit 通道', () => {
    expect(hasNativeShell({})).toBe(false);
    expect(hasNativeShell(undefined)).toBe(false);
  });

  it('只有半截通道不算：通道存在但不可调用，说明注入没成功', () => {
    expect(hasNativeShell({ webkit: { messageHandlers: { appearance: {} } } })).toBe(false);
    expect(hasNativeShell({ webkit: { messageHandlers: { appearance: { postMessage: 'nope' } } } })).toBe(false);
    expect(hasNativeShell({ webkit: { messageHandlers: {} } })).toBe(false);
  });
});
