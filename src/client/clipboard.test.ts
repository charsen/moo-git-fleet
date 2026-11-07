import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, defaultClipboardDeps } from './clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('复制到剪贴板', () => {
  it('现代接口成功时不碰兜底', async () => {
    const execCopy = vi.fn(() => true);
    const writeText = vi.fn(async () => {});
    await expect(copyText('moo-fleet', { writeText, execCopy })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('moo-fleet');
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('现代接口被拒时落到 execCommand', async () => {
    const execCopy = vi.fn(() => true);
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(copyText('moo-fleet', { writeText, execCopy })).resolves.toBe(true);
    expect(execCopy).toHaveBeenCalledWith('moo-fleet');
  });

  it('兜底也失败就如实返回 false，不假装成功', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(copyText('moo-fleet', { writeText, execCopy: () => false })).resolves.toBe(false);
  });

  it('没有现代接口时直接走兜底', async () => {
    const execCopy = vi.fn(() => true);
    await expect(copyText('moo-fleet', { writeText: null, execCopy })).resolves.toBe(true);
    expect(execCopy).toHaveBeenCalledWith('moo-fleet');
  });

  it('兜底自己抛异常也不把异常漏给调用方', async () => {
    const execCopy = vi.fn(() => {
      throw new Error('document is not defined');
    });
    await expect(copyText('moo-fleet', { writeText: null, execCopy })).resolves.toBe(false);
  });

  it('空文本什么都不做', async () => {
    const execCopy = vi.fn(() => true);
    const writeText = vi.fn(async () => {});
    await expect(copyText('', { writeText, execCopy })).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCopy).not.toHaveBeenCalled();
  });
});

describe('默认依赖', () => {
  it('没有剪贴板接口时 writeText 为 null', () => {
    vi.stubGlobal('navigator', {});
    expect(defaultClipboardDeps().writeText).toBeNull();
  });

  it('转发时保留 clipboard 的 this，不只是把函数摘出来', async () => {
    // `navigator.clipboard.writeText` 是原型上的方法，摘出来直接调用会丢 this，
    // 浏览器里表现为 `TypeError: Illegal invocation`——复制永远失败。
    const writeText = vi.fn(async function (this: unknown, _text: string) {
      if (this !== clipboard) throw new TypeError('Illegal invocation');
    });
    const clipboard = { writeText };
    vi.stubGlobal('navigator', { clipboard });
    const deps = defaultClipboardDeps();
    await expect(deps.writeText?.('moo-fleet')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('moo-fleet');
  });
});
