import { describe, expect, it } from 'vitest';
import { acceptsNotice, useNotices, type NoticeOwner } from './notices.js';

describe('acceptsNotice', () => {
  it('accepts the first message for an owner', () => {
    expect(acceptsNotice(undefined, { severity: 'success', text: '已复制' })).toBe(true);
  });

  it('ignores a repeat of the same message', () => {
    expect(acceptsNotice({ severity: 'success', text: '已复制' }, { severity: 'success', text: '已复制' })).toBe(false);
  });

  it.each(['success', 'warning', 'error'] as const)('never lets background progress replace a %s receipt', (severity) => {
    expect(acceptsNotice({ severity, text: '批量 FETCH 完成' }, { severity: 'progress', text: '自动 Fetch 已加入队列' })).toBe(false);
  });

  it('lets progress replace progress', () => {
    expect(acceptsNotice({ severity: 'progress', text: '正在克隆' }, { severity: 'progress', text: '正在扫描' })).toBe(true);
  });

  it('lets a user action replace background progress', () => {
    expect(acceptsNotice({ severity: 'progress', text: '自动 Fetch 已加入队列' }, { severity: 'success', text: '已推送' })).toBe(true);
  });

  it('lets a heavier message replace a lighter one', () => {
    expect(acceptsNotice({ severity: 'warning', text: '2 个跳过' }, { severity: 'error', text: '推送失败' })).toBe(true);
  });
});

describe('useNotices', () => {
  function setup(initial: NoticeOwner = 'workspace:repositories') {
    let current: NoticeOwner = initial;
    const store = useNotices(() => current);
    return {
      ...store,
      setActive: (owner: NoticeOwner) => { current = owner; },
    };
  }

  it('files a message under the container the user is looking at', () => {
    const store = setup('settings');
    store.notify('success', '个人配置已保存');
    expect(store.noticeFor('settings')?.text).toBe('个人配置已保存');
    expect(store.noticeFor('workspace:repositories')).toBeUndefined();
  });

  it('keeps two containers from overwriting each other', () => {
    const store = setup('repository:acme');
    store.notify('error', '暂存失败');
    store.setActive('workspace:repositories');
    store.notify('success', '批量 FETCH 完成');
    expect(store.noticeFor('repository:acme')?.text).toBe('暂存失败');
    expect(store.noticeFor('workspace:repositories')?.text).toBe('批量 FETCH 完成');
    expect(store.noticeFor('repository:acme')?.severity).toBe('error');
  });

  it('lets a background job address another container without stealing its message', () => {
    const store = setup('repository:acme');
    store.notify('success', '已暂存 3 / 3');
    const written = store.notify('progress', '自动 Fetch 已加入队列', 'workspace:repositories');
    expect(written).toBe(true);
    expect(store.noticeFor('repository:acme')?.text).toBe('已暂存 3 / 3');
    expect(store.noticeFor('workspace:repositories')?.severity).toBe('progress');
  });

  it('refuses background progress when the page already holds a receipt', () => {
    const store = setup('workspace:repositories');
    store.notify('success', '批量 FETCH 完成 · 6 个仓库');
    const written = store.notify('progress', '自动 Fetch 已加入队列');
    expect(written).toBe(false);
    expect(store.noticeFor('workspace:repositories')?.text).toBe('批量 FETCH 完成 · 6 个仓库');
  });

  it('marks a message unread only when its container is out of sight', () => {
    const store = setup('settings');
    store.notify('error', '保存失败', 'repository:acme');
    expect(store.hasUnread('repository:acme')).toBe(true);
    store.notify('success', '个人配置已保存');
    expect(store.hasUnread('settings')).toBe(false);
  });

  it('clears the unread mark once the container is looked at', () => {
    const store = setup('settings');
    store.notify('error', '保存失败', 'repository:acme');
    store.markRead('repository:acme');
    expect(store.hasUnread('repository:acme')).toBe(false);
    expect(store.noticeFor('repository:acme')?.text).toBe('保存失败');
  });

  it('dismisses one container without touching the others', () => {
    const store = setup('settings');
    store.notify('success', '已保存');
    store.notify('error', '推送失败', 'repository:acme');
    store.dismiss('settings');
    expect(store.noticeFor('settings')).toBeUndefined();
    expect(store.noticeFor('repository:acme')?.text).toBe('推送失败');
  });
});
