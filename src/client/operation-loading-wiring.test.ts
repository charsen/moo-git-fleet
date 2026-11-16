import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「操作进行中的就地提示」结构断言。
 *
 * 这批行为大多长在模板与 computed 里：漏掉一个 class、或某条分支又写着 historyOpen.value = true，
 * 类型检查都发现不了，只有真机点下去才知道。这里用源码断言把几条关键约束钉住：
 *  - 批量开始不再自动弹操作记录抽屉；
 *  - 批量按钮用 x/y 进度、仓库名字旁显示活动；
 *  - 行内活动不覆盖真实状态；
 *  - 批量运行时顶栏历史入口跨工作区保留；
 *  - 抽屉状态行覆盖没有操作流记录的单仓写操作。
 */
const source = readFileSync(fileURLToPath(new URL('./App.vue', import.meta.url)), 'utf8');

function functionBody(name: string, keyword = 'function'): string {
  const marker = '\n' + keyword + ' ' + name + '(';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('App.vue 里找不到 ' + name + '，断言的前提已经不成立');
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(name + ' 的结尾没找到，改成别的写法后要同步更新这条断言');
  return source.slice(start, end);
}

function computedBody(name: string): string {
  const marker = 'const ' + name + ' = computed(';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('App.vue 里找不到 computed ' + name);
  const end = source.indexOf('\n});', start);
  if (end < 0) throw new Error('computed ' + name + ' 的结尾没找到');
  return source.slice(start, end);
}

describe('操作进行中的就地提示', () => {
  it('批量开始不再自动弹操作记录抽屉', () => {
    for (const name of ['runBatch', 'executeBatchPushBranches', 'executeBatchMerge', 'executeBatchPull']) {
      const body = functionBody(name, 'async function');
      expect(body, name + ' 不应自动打开操作记录抽屉').not.toContain('historyOpen.value = true');
    }
    // 手动入口仍然保留：顶栏按钮与「查看进度」要能打开它。
    expect(source).toContain('historyOpen.value = true');
  });

  it('批量按钮显示真实进度、仓库名字旁显示活动', () => {
    expect(source).toContain("batchIsBusy('pull')");
    expect(source).toContain('batchActionCount(');
    expect(source).toContain('batch-action-count--running');
    expect(source).toContain('class="repo-activity"');
    expect(source).toContain('repositoryActivityRunning(repository.config.id)');
  });

  it('行内活动不替换真实状态', () => {
    const statusStart = source.indexOf('class="status-cell"');
    expect(statusStart).toBeGreaterThan(-1);
    const statusSeg = source.slice(statusStart, statusStart + 900);
    expect(statusSeg).toContain('statusMeta[repository.state].label');
    expect(statusSeg).not.toContain('repositoryActivityText');
  });

  it('批量运行时顶栏历史入口跨工作区保留', () => {
    expect(source).toContain("activeWorkspace === 'repositories' || foregroundBatchRunning");
  });

  it('抽屉状态行覆盖没有操作流记录的单仓写操作', () => {
    const body = computedBody('repositoryActionLabel');
    expect(body).toContain('fileDiscardBatchBusy');
    expect(body).toContain('fileActionId');
    expect(body).toContain('commitBusy');
    expect(body).toContain('branchSwitchBusy');
    expect(body).toContain('repositoryActivities');
  });
});
