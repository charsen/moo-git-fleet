import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 两处「接线型」修复的结构断言。
 *
 * 它们的行为要在真机上点出来才知道（重试弹窗里有没有勾选框、15 秒后列表有没有跟着变），
 * 而这两件事都不便宜：前者要造一次失败的操作，后者要等一个完整周期。这里守的是
 * 「线有没有接上」——漏接的后果分别是「重试静默换了策略」和「计数变了列表没变」。
 */
const source = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');

/** 取出 `async function name(...) { … }` 的函数体（按行首 `}` 收尾）。 */
function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`App.vue 里找不到 ${name}，断言的前提已经不成立`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name} 的结尾没找到，改成别的写法后要同步更新这条断言`);
  return source.slice(start, end);
}

describe('重试与静默刷新的接线', () => {
  it('操作记录里的重试带上首次操作的选项', () => {
    const body = functionBody('retryOperation');
    // 确认框里要有勾选框，否则文案写着「可勾选 rebase」而界面上没有勾选框。
    expect(body).toContain('checkboxes:');
    expect(body).toContain('id: \'use-rebase\'');
    expect(body).toContain('id: \'auto-stash\'');
    // 勾选结果必须真的传下去：漏传就是「用 Rebase 的人重试一次变成 merge」。
    expect(body).toContain('api.pullRepository(operation.repositoryId, { stashFirst, rebase })');
    expect(body).toContain('api.syncRepository(operation.repositoryId, { stashFirst, rebase })');
  });

  it('后台静默刷新同时刷 Stash 与 Tag，且不动加载态', () => {
    const body = functionBody('refreshRepositoryWorkspaceInBackground');
    expect(body).toContain('loadRepositoryStashes(repository.config.id, { background: true })');
    expect(body).toContain('loadRepositoryTags(repository.config.id, { background: true })');
  });
});

describe('列表里的复制按钮', () => {
  it('点复制不会顺带打开详情抽屉', () => {
    // 这枚按钮嵌在一整行都可点击的 <tr> 里。漏掉 `.stop`，点复制会连着 `selectRepositoryFromRow`
    // 一起触发：抽屉盖住列表，用户既看不到「已复制」也看不到刚才复制的是哪一行。
    const start = source.indexOf('class="table-icon-button repo-copy-button"');
    expect(start).toBeGreaterThan(-1);
    const button = source.slice(start, source.indexOf('</button>', start));
    expect(button).toContain('@click.stop="copyRepositoryName(repository)"');
    // 复制的是这一行的名字，不是第一行、也不是当前选中的那个。
    expect(button).toContain('copyRepositoryName(repository)');
  });

  it('成功反馈留在行内，失败才走整页消息条', () => {
    const body = functionBody('copyRepositoryName');
    expect(body).toContain('copiedRepositoryId.value = repository.config.id');
    // 失败必须说出来：静默失败会让用户拿着上一次剪贴板内容去粘贴。
    const cleared = body.indexOf('actionError.value = \'\'');
    const failed = body.indexOf('actionError.value = `复制');
    expect(cleared).toBeGreaterThan(-1);
    // 清空要在真正尝试复制之前：连续复制时，上一条「复制失败」必须被这一次的成功清掉。
    // 消息按容器存放、留到下一次操作接替它，而成功分支不写消息条，不清就永远挂在那儿。
    expect(cleared).toBeLessThan(body.indexOf('await copyText'));
    expect(failed).toBeGreaterThan(cleared);
  });
});
