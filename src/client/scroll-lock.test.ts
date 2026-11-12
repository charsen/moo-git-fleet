import { afterEach, describe, expect, it, vi } from 'vitest';
// 静态 import 先让 Vue 在 node 环境完成初始化；之后再替掉 document，只影响被测的 class 操作。
import { setScrollLock } from './scroll-lock';

/** 只测「锁按来源合并」这一层；DOM 用最小桩，不为这点逻辑拉起浏览器环境。 */
function stubDocumentElement(): Set<string> {
  const classes = new Set<string>();
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        toggle(name: string, force: boolean) {
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        },
      },
    },
  });
  return classes;
}

/** 模块级的来源集合是全局状态，用例之间要清干净。 */
afterEach(() => {
  for (const owner of ['app', 'sessions']) setScrollLock(owner, false);
  vi.unstubAllGlobals();
});

describe('setScrollLock', () => {
  it('任一来源要锁就保持锁定，最后一个来源解除时立即摘锁', () => {
    const classes = stubDocumentElement();

    setScrollLock('app', true);
    expect(classes.has('scroll-locked')).toBe(true);
    setScrollLock('sessions', true);
    expect(classes.has('scroll-locked')).toBe(true);

    // 先关的来源不能把另一个还开着的层一起解锁。
    setScrollLock('app', false);
    expect(classes.has('scroll-locked')).toBe(true);
    setScrollLock('sessions', false);
    expect(classes.has('scroll-locked')).toBe(false);
  });

  it('注销一个没有登记过的来源不会误锁主界面', () => {
    const classes = stubDocumentElement();

    setScrollLock('sessions', false);
    expect(classes.has('scroll-locked')).toBe(false);
    setScrollLock('app', true);
    setScrollLock('app', true);
    setScrollLock('app', false);
    expect(classes.has('scroll-locked')).toBe(false);
  });
});
