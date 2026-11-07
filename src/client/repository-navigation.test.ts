import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「进入仓库后 Esc 回不去」的结构断言。
 *
 * 实际现象：从「批量队列与操作记录」点进某个仓库之后，返回按钮与 Esc 都会回到操作记录。
 * 这本身是对的——但那个返回目标**没有被清掉**，于是之后从仓库列表点行进来的仓库
 * 也带着它：按 Esc 不回到列表，而是弹出操作记录，看起来就是「Esc 失效了」。
 *
 * 为什么用源码断言而不是组件测试：这条链要把 `selectedRepository`、`historyOpen`、
 * `historyReturnOperationId` 三个状态走一遍才看得出来，而它漏接的后果（返回目标串台）
 * 在类型上完全合法——`selectRepository` 少写一行不会报错。这里守的是「那行还在」。
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

describe('进入仓库时的返回目标', () => {
  it('直接进入仓库（点行 / 克隆 / 键盘）会清掉「返回操作记录」', () => {
    const body = syncFunctionBody('selectRepository');
    // 默认必须是 null：只要有一条入口漏清，那个仓库的 Esc 就会把人送到操作记录。
    expect(body).toContain('historyReturnOperationId.value = options.returnToHistory ?? null');
  });

  it('从操作记录进入时才设置返回目标，且通过参数传', () => {
    const body = syncFunctionBody('openOperationRepository');
    expect(body).toContain('selectRepository(repository, { returnToHistory: operation.id })');
    // 不能在调用前自己赋值：那样 `selectRepository` 会立刻把它清成 null，
    // 或者反过来——顺序一变行为就变，这正是原来出问题的写法。
    expect(body).not.toContain('historyReturnOperationId.value =');
  });

  it('其它入口不再自己动这个字段（避免两处写法不一致）', () => {
    // 只允许三处出现赋值：`openHistory`（清空）、`selectRepository`（按参数）、
    // `closeDrawers`（回到列表时清空）。
    const assignments = [...source.matchAll(/historyReturnOperationId\.value =/g)];
    expect(assignments).toHaveLength(3);
  });
});
