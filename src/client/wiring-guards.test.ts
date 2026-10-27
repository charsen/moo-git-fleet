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
