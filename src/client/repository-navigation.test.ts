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
    // 合并预览要留着：它开在抽屉内部，抽屉关了状态就没人回收。
    expect(body).toContain('branchMerge.value');
  });

  it('Esc 分支的兜底仍然是 closeDrawers', () => {
    const body = syncFunctionBody('handleGlobalShortcut');
    expect(body).toContain('else closeDrawers();');
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
