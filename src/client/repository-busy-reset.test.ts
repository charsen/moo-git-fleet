import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 守住「切仓库时忙态必须清干净」这条不变量。
 *
 * 起因是一处真实死锁：`commitBusy` 只在 `finally` 里清，而 `finally` 的条件是
 * 「还停在同一个仓库上下文」。提交期间点顶栏「操作记录」（`openHistory` 直接置空
 * 选中仓库）或切到别的仓库，条件就不成立，忙态永久为真。偏偏 `workspaceBusy`、
 * `stageLocked`、`hunkActionBlocked`、`composer.paused` 全都含它，于是之后打开的
 * 任何仓库里暂存、提交、按块、Fetch 一律灰着，禁用的按钮还弹不出原因。
 *
 * 这类漏项单看代码很难发现：`watch` 里已经重置了十几个忙态，少两个不会报错，
 * 只在「提交 + 切仓库」这个组合下才显形。所以改成结构断言——**凡是参与禁用判断的
 * `ref` 忙态，都必须在这个 watch 里被重置**，从声明处反查，不靠人记清单。
 */

const source = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');

/** 取出某个 `const X = computed(() => …);` 的表达式体。 */
function computedBody(name: string): string {
  const pattern = new RegExp(`const ${name} = computed\\(\\(\\) =>([\\s\\S]*?)\\);\\n`);
  const match = source.match(pattern);
  if (!match) throw new Error(`App.vue 里找不到 ${name} 的 computed 定义，断言的前提已经不成立`);
  return match[1];
}

/** 取出切仓库 watch 的函数体（从 `watch(` 到对应的 `},);`）。 */
function repositoryWatchBody(): string {
  const start = source.indexOf('() => selectedRepository.value?.config.id,');
  if (start < 0) throw new Error('App.vue 里找不到监听选中仓库的 watch，断言的前提已经不成立');
  const end = source.indexOf('\n  },\n);', start);
  if (end < 0) throw new Error('切仓库 watch 的结尾没找到，改成别的写法后要同步更新这条断言');
  return source.slice(start, end);
}

/**
 * 参与「界面禁用」的三处判断。它们各自排除掉的项不一样（`stageLocked` 不挡只读操作、
 * `hunkActionBlocked` 不挡正在执行的那一块），但**共同的部分必须都能被重置**：
 * 任何一项没清，都会让某个按钮永久灰着。
 */
const gatingComputeds = ['workspaceBusy', 'stageLocked', 'hunkActionBlocked'];

const isRefDeclaration = (identifier: string) =>
  new RegExp(`const ${identifier} = ref[(<]`).test(source);

describe('切仓库时忙态清空', () => {
  it('参与禁用判断的 ref 忙态都在切仓库时被重置', () => {
    const watchBody = repositoryWatchBody();
    const identifiers = new Set<string>();
    for (const name of gatingComputeds) {
      for (const token of computedBody(name).matchAll(/[A-Za-z_$][\w$]*/g)) {
        identifiers.add(token[0]);
      }
    }

    // computed 自身与纯读取（如 `value`）不是需要重置的忙态
    const busyRefs = [...identifiers].filter((identifier) => isRefDeclaration(identifier));
    expect(busyRefs.length).toBeGreaterThan(8);

    const missing = busyRefs.filter((identifier) => !new RegExp(`\\n    ${identifier}\\.value = `).test(watchBody));
    expect(missing, `这些忙态参与禁用判断，但切仓库时没有重置，会永久锁死界面：${missing.join(', ')}`).toEqual([]);
  });

  it('提交与重放的忙态在切仓库时被重置', () => {
    // 这两个不在上面三处 computed 里（`replayBusy` 只挡入口、不参与禁用），
    // 但同样只在带上下文条件的 `finally` 里清，漏掉就是同一个死锁。
    const watchBody = repositoryWatchBody();
    for (const identifier of ['commitBusy', 'replayBusy']) {
      expect(watchBody, `${identifier} 没有在切仓库时重置`).toContain(`${identifier}.value = `);
    }
  });
});
