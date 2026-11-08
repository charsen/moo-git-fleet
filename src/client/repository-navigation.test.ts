import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「进入仓库后 Esc 回不去」的结构断言。
 *
 * 这条反馈出现过两次，成因有两条，都写在这里守着：
 *
 * 1. 返回目标串台：从「批量队列与操作记录」点进仓库后，`historyReturnOperationId`
 *    没有被清掉，之后从列表点行进来的仓库也带着它，Esc 就弹出操作记录。
 * 2. 返回目标本身就不对：即使只有一次，Esc 也是把抽屉内容换成操作记录而不是关掉抽屉。
 *    两个抽屉都在右侧同一位置，用户看到的是「抽屉还在」，于是反馈「Esc 不能返回」。
 *
 * 现在只有一个语义：**Esc / 返回 一律回到仓库列表**。这条不变量靠源码断言守住——
 * 漏掉一行在类型上完全合法，跑起来也不报错，只有用户按 Esc 时才会发现。
 */
const source = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');

/** 取出同步函数 `function name(...) { … }` 的函数体（按行首 `}` 收尾）。 */
function syncFunctionBody(name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`App.vue 里找不到 ${name}，断言的前提已经不成立`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name} 的结尾没找到，改成别的写法后要同步更新这条断言`);
  return source.slice(start, end);
}

describe('Esc / 返回 的落点', () => {
  it('closeDrawers 同时关掉仓库抽屉与操作记录', () => {
    const body = syncFunctionBody('closeDrawers');
    expect(body).toContain('selectedRepository.value = null');
    expect(body).toContain('historyOpen.value = false');
    // 不许改道去开另一个抽屉：那会让「关掉」看起来没发生。
    expect(body).not.toContain('historyOpen.value = true');
  });

  it('closeDrawers 不因忙态提前返回', () => {
    const body = syncFunctionBody('closeDrawers');
    expect(body).not.toContain('commitBusy');
    expect(body).not.toContain('branchSwitchBusy');
    // 合并预览要回收：它开在抽屉内部，抽屉关了状态就没人管。
    expect(body).toContain('branchMerge.value');
  });

  /**
   * `branchMerge` 曾经是一对锁：`closeDrawers` 里 `if (branchMerge.value) return;`，
   * 返回按钮上 `:disabled="Boolean(branchMerge)"`。合并预览一旦常驻（预览请求没回来、
   * 或者忙态卡在 merge），Esc / 返回 / 点遮罩三条退路**同时**失效，界面上却没有任何提示。
   * 现在改成顺手回收预览，关闭本身不再等它。
   */
  it('合并预览不能反过来挡住关闭', () => {
    const body = syncFunctionBody('closeDrawers');
    expect(body).not.toContain('if (branchMerge.value) return');
    expect(body).toContain('closeBranchMerge()');
    expect(source).not.toContain(':disabled="Boolean(branchMerge)"');
  });

  it('返回按钮永远可点', () => {
    const button = source.match(/<button[^>]*workspace-back-button[^>]*>/);
    expect(button, '返回按钮的标签没找到，改动结构后要同步更新这条断言').not.toBeNull();
    expect(button![0]).not.toContain('disabled');
    expect(button![0]).toContain('@click="closeDrawers"');
  });

  /**
   * 三条退路（Esc / 返回 / ⌘[）都走 `closeDrawers`。清场环节里任何一处抛异常，
   * 后面清状态的两行就跑不到，抽屉永远关不掉——而界面看上去完全正常，
   * 用户只会说「Esc 和返回都没反应」。所以清状态必须放在 `finally`。
   */
  it('清场环节抛异常也必须关掉抽屉', () => {
    const body = syncFunctionBody('closeDrawers');
    const finallyAt = body.indexOf('} finally {');
    expect(finallyAt, 'closeDrawers 里没有 finally，异常会让抽屉永久关不掉').toBeGreaterThan(-1);
    expect(body.indexOf('selectedRepository.value = null')).toBeGreaterThan(finallyAt);
    expect(body.indexOf('historyOpen.value = false')).toBeGreaterThan(finallyAt);
    // 清场（可能抛）要排在 finally 之前，不能混进去。
    expect(body.indexOf('closeDiffDialog()')).toBeLessThan(finallyAt);
  });

  /**
   * 外壳兜底：Esc 可能在到达网页之前就被吞掉（输入法的事件 tap、WebKit 的
   * `cancelOperation:` 响应链）。
   *
   * 判据必须是「有没有人真的处理」，不是「页面有没有收到」。这两个曾经被混成一个：
   * 时间戳记在捕获阶段，键一到页面就算「处理过」，于是「到了页面却被某个子层
   * `stopPropagation` 吞掉、什么也没发生」这种情况，兜底会误判成已处理而袖手旁观——
   * 用户看到的正是「返回和 ⌘[ 都行，只有 Esc 没反应」。
   */
  it('Esc 兜底看的是「有人处理过」而不是「页面收到过」', () => {
    const body = syncFunctionBody('installEscapeFallback');
    expect(body).toContain('__fleetEscapeFallback');
    expect(body).toContain('escapeFallbackGraceMs');
    expect(body).toContain('selectedRepository.value');
    expect(body).toContain('closeDrawers()');
    expect(body).toContain('lastEscapeHandledAt');
    expect(body).not.toContain('lastEscapeKeydownAt');

    // 监听仍在捕获阶段：子层 stopPropagation 之后冒泡阶段什么都看不到。
    expect(source).toContain("window.addEventListener('keydown', noteEscapeKeydown, true)");
    const note = syncFunctionBody('noteEscapeKeydown');
    expect(note).toContain('isEscapeKey');
    // 抽屉里处理 Esc 的层都会 preventDefault，被吞掉那条路不会——用这个区分。
    expect(note).toContain('event.defaultPrevented');
    expect(note).toContain('lastEscapeHandledAt');
  });

  /**
   * 输入法会把 Esc 报成 `'Process'` / `'Unidentified'`（`keyCode` 仍是 27）。
   * 只认 `event.key === 'Escape'` 会让这颗键**静默失效**，而 `⌘[`、返回照常——
   * 正好是「其他两个都正常，只有 Esc 不行」。
   */
  it('Esc 的判定不吃输入法的亏', () => {
    const body = syncFunctionBody('isEscapeKey');
    expect(body).toContain("event.key === 'Escape'");
    expect(body).toContain("event.code === 'Escape'");
    expect(body).toContain('event.keyCode === 27');
    // 全局快捷键链必须走这个判定，不能再各自写 event.key。
    const shortcut = syncFunctionBody('handleGlobalShortcut');
    expect(shortcut).toContain('isEscapeKey(event)');
    expect(shortcut).not.toContain("event.key === 'Escape'");
  });

  it('Esc 分支的兜底仍然是 closeDrawers', () => {
    const body = syncFunctionBody('handleGlobalShortcut');
    expect(body).toContain('else closeDrawers();');
  });

  /**
   * Esc 可能在到达网页之前就被吞掉（输入法的事件 tap、WebKit 的 `cancelOperation:`）。
   * 这条键盘退路要绕开 Esc：`⌘[` 是普通组合键，不会被当成「取消」。
   */
  it('⌘[ 也能回到仓库列表', () => {
    const body = syncFunctionBody('handleGlobalShortcut');
    expect(body).toContain("event.key === '['");
    expect(body).toContain('closeDrawers()');
    // 必须排在「有焦点层就 return」之前，否则抽屉开着时按了没用。
    expect(body.indexOf("event.key === '['")).toBeLessThan(body.indexOf('if (activeFocusLayer()) return;'));
  });

  it('进入仓库时不带任何「返回目标」', () => {
    const body = syncFunctionBody('selectRepository');
    expect(body).toContain('historyOpen.value = false');
    expect(body).toContain('selectedRepository.value = repository');
    // 曾经按入口分叉（从操作记录进来就回操作记录），就是这条分叉造成的困惑。
    expect(body).not.toContain('returnToHistory');
    const open = syncFunctionBody('openOperationRepository');
    expect(open).toContain('selectRepository(repository)');
  });

  it('返回目标这个状态已经彻底移除', () => {
    expect(source).not.toContain('historyReturnOperationId');
  });
});
