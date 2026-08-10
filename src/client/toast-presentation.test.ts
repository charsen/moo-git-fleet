import { describe, expect, it } from 'vitest';
import { presentGlobalToast } from './toast-presentation.js';

describe('presentGlobalToast', () => {
  it('presents ordinary messages as success feedback', () => {
    expect(presentGlobalToast('', '操作已完成')).toEqual({
      tone: 'success',
      text: '操作已完成',
      duration: 4_200,
    });
  });

  it.each([
    '⚠ 当前范围没有可安全推送的仓库',
    '⚠️ 当前范围没有可安全推送的仓库',
    '⚠ ⚠️ 当前范围没有可安全推送的仓库',
  ])('removes warning symbols already represented by the toast icon', (message) => {
    expect(presentGlobalToast('', message)).toEqual({
      tone: 'warning',
      text: '当前范围没有可安全推送的仓库',
      duration: 6_500,
    });
  });

  it('gives errors precedence and still avoids a duplicate warning symbol', () => {
    expect(presentGlobalToast('⚠ 请求失败，请稍后重试', '操作已完成')).toEqual({
      tone: 'error',
      text: '请求失败，请稍后重试',
      duration: 9_000,
    });
  });
});
