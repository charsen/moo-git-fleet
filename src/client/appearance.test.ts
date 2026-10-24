import { describe, expect, it } from 'vitest';
import { nativeChromeMessage } from './appearance';

/**
 * 原窗口标题栏透出的是 `NSWindow` 底色，网页没办法用 CSS 管住它，
 * 只能在切主题时把计算值发回外壳。这里守两件事：
 * 1. 两个色值都拿到才发——半条消息会让原生只改一半，标题栏和内容区对不上；
 * 2. 去掉 `getComputedStyle` 带出来的空格，否则原生解析十六进制会失败。
 */
describe('原生外壳配色通报', () => {
  const readFrom = (values: Record<string, string>) => (name: string) => values[name] ?? '';

  it('两层底色都在时给出完整消息', () => {
    expect(nativeChromeMessage(readFrom({ '--color-navigation': '#181818', '--color-canvas': '#181818' })))
      .toEqual({ navigation: '#181818', canvas: '#181818' });
  });

  it('缺任意一层就整条不发', () => {
    expect(nativeChromeMessage(readFrom({ '--color-navigation': '#181818' }))).toBeNull();
    expect(nativeChromeMessage(readFrom({ '--color-canvas': '#181818' }))).toBeNull();
    expect(nativeChromeMessage(readFrom({ '--color-navigation': '  ', '--color-canvas': '#181818' }))).toBeNull();
  });

  it('去掉计算样式里的前后空白', () => {
    expect(nativeChromeMessage(readFrom({ '--color-navigation': ' #0b0f17\n', '--color-canvas': ' #0b0f17 ' })))
      .toEqual({ navigation: '#0b0f17', canvas: '#0b0f17' });
  });
});
