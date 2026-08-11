import { describe, expect, it } from 'vitest';
import {
  reconcileSessionSelection,
  setVisibleSessionSelection,
  toggleSessionSelection,
} from './session-selection.js';

describe('会话列表多选', () => {
  it('单条勾选不会改动其他已选项', () => {
    const selected = new Set(['claude:a']);
    expect([...toggleSessionSelection(selected, 'codex:b', true)]).toEqual(['claude:a', 'codex:b']);
    expect([...toggleSessionSelection(selected, 'claude:a', false)]).toEqual([]);
    expect([...selected]).toEqual(['claude:a']);
  });

  it('全选或取消只作用于当前可见结果', () => {
    const selected = new Set(['claude:hidden']);
    const visible = ['claude:a', 'codex:b'];
    const all = setVisibleSessionSelection(selected, visible, true);
    expect([...all]).toEqual(['claude:hidden', 'claude:a', 'codex:b']);
    expect([...setVisibleSessionSelection(all, visible, false)]).toEqual(['claude:hidden']);
  });

  it('刷新后移除已经不存在的会话身份', () => {
    expect([...reconcileSessionSelection(
      new Set(['claude:gone', 'codex:kept']),
      new Set(['codex:kept', 'claude:new']),
    )]).toEqual(['codex:kept']);
  });
});
