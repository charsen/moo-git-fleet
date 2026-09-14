import { describe, expect, it } from 'vitest';
import { classifyErrorStatus, isBatchSafetySkip } from './app.js';
import {
  type AppError,
  aiUpstreamError,
  conflictError,
  invalidRequestError,
  notFoundError,
  safetyBlockedError,
} from './errors.js';
import { BatchAlreadyRunningError } from './operations/service.js';

/**
 * 改造前后等价性的唯一基准是「同一条文案走旧正则兜底」的结果。
 * 因为类型化改造逐字保留了原抛出点的文案，`new Error(error.message)` 精确复现了改造前的输入，
 * 所以 `classifyErrorStatus(typed) === classifyErrorStatus(new Error(typed.message))`
 * 就等价于「状态码与改造前一致」。
 */
interface ConvertedSite {
  error: AppError;
  /**
   * 该错误实际可能出现在哪些批量操作里。
   * 只有列在这里的操作才断言跳过语义——同一条文案在 pull 与 push 下的旧判定本就不同
   * （例如「工作区不干净」只在 Pull 的列表里），而该错误在另一个操作里根本不会出现。
   * 省略表示两个操作都断言。
   */
  batchedFor?: Array<'pull' | 'push'>;
}

const convertedSites: ConvertedSite[] = [
  // git/actions.ts
  { error: safetyBlockedError('仓库配置禁止 push 操作') },
  { error: safetyBlockedError('Detached HEAD 禁止 Pull'), batchedFor: ['pull'] },
  { error: safetyBlockedError('当前分支没有 upstream') },
  { error: safetyBlockedError('工作区不干净，安全 Pull 已阻止'), batchedFor: ['pull'] },
  { error: conflictError('仓库缺少 remote：origin') },
  { error: safetyBlockedError('当前分支或 HEAD 已变化，安全 Pull 已阻止'), batchedFor: ['pull'] },
  { error: safetyBlockedError('本地与远端已分叉，禁止自动 Pull'), batchedFor: ['pull'] },
  { error: safetyBlockedError('Pull 执行期间当前分支或 HEAD 已变化，请检查仓库状态') },
  { error: safetyBlockedError('Detached HEAD 禁止 Push'), batchedFor: ['push'] },
  { error: safetyBlockedError('远端存在新提交或已经分叉，禁止 Push'), batchedFor: ['push'] },

  // git/branches.ts
  { error: conflictError('目标分支名称无效') },
  { error: safetyBlockedError('当前分支或 HEAD 已变化，请刷新后重试') },
  { error: conflictError('目标分支已经是当前分支') },
  { error: conflictError('目标分支已被其他 Worktree 占用') },
  { error: safetyBlockedError('工作区不干净，不能切换分支'), batchedFor: [] },
  { error: conflictError('仓库正在进行 merge，不能切换分支') },

  // git/upstream.ts
  { error: safetyBlockedError('当前分支或 HEAD 已变化，请重新预览 upstream 修复方案') },
  { error: safetyBlockedError('Detached HEAD 不能设置 upstream') },
  { error: conflictError('当前分支尚无 Commit，无法设置 upstream') },
  { error: conflictError('upstream 写入后校验失败，请检查仓库配置') },
  { error: conflictError('当前分支已有 upstream：origin/main') },
  { error: conflictError('Upstream 候选已变化，请重新预览') },
  { error: safetyBlockedError('仓库配置禁止 fetch 操作') },
  { error: conflictError('远端分支 origin/main 已出现，请重新预览后关联已有分支') },

  // git/stash.ts
  { error: invalidRequestError('Stash 参数无效') },
  { error: safetyBlockedError('工作区不干净，应用 Stash 已阻止'), batchedFor: [] },
  { error: conflictError('Stash 列表已变化，误删条目恢复失败：fatal') },
  { error: conflictError('工作区没有可 Stash 的改动') },
  { error: conflictError('Stash 列表已变化，请刷新后重试') },
  { error: conflictError('Stash 应用产生冲突或失败，工作区可能已部分修改：fatal') },
  { error: conflictError('Stash 列表已变化，已恢复误删条目，请刷新后重试') },

  // git/files.ts
  { error: invalidRequestError('Git 文件路径不安全') },
  { error: invalidRequestError('Git 文件路径超出仓库') },
  { error: conflictError('文件列表已过期，请刷新仓库详情') },
  { error: conflictError('文件内容或状态已变化，请刷新仓库详情') },
  { error: conflictError('暂存区已变化，请重新预览') },
  { error: conflictError('暂存区为空，没有可提交内容') },
  { error: conflictError('暂存区已变化，请重新预览后提交') },
  { error: invalidRequestError('Commit 文案包含非法字符') },

  // git/commit-push.ts
  { error: safetyBlockedError('仓库配置禁止 Push，未执行 Commit') },

  // operations/service.ts
  { error: conflictError('该仓库已有 Git 操作正在执行') },

  // config/store.ts
  { error: notFoundError('未知仓库根目录：dev') },

  // repositories/service.ts
  { error: notFoundError('本地目录不存在：/x') },
  { error: invalidRequestError('候选仓库超出允许的根目录') },
  { error: invalidRequestError('配置路径不是 Git worktree 根目录：/x') },
  { error: conflictError('该仓库已经在列表中') },

  // import/packages.ts
  { error: notFoundError('清单文件不存在：/x') },
  { error: invalidRequestError('清单路径必须是文件') },
  { error: invalidRequestError('清单文件必须使用 .md 扩展名') },
  { error: invalidRequestError('清单文件超过 1 MB，已拒绝读取') },
  { error: invalidRequestError('清单文件必须位于受信任根目录中') },
  { error: invalidRequestError('清单中未识别到任何仓库') },
  { error: invalidRequestError('清单仓库数量超过 100 个，已拒绝预览') },

  // app.ts
  { error: notFoundError('仓库不存在') },
  { error: invalidRequestError('仓库路径超出允许的根目录') },
  { error: invalidRequestError('仓库配置路径不是 Git worktree 根目录') },
  { error: invalidRequestError('仓库根目录必须是目录') },
  { error: conflictError('根目录标识已存在：dev') },
  { error: conflictError('仍有仓库使用该根目录，请先移出对应仓库') },
  { error: conflictError('清单候选已变化，请重新预览') },
  { error: invalidRequestError('批量仓库列表包含重复项') },
  { error: invalidRequestError('批量仓库范围包含未知或已禁用项：x') },
  { error: safetyBlockedError('仓库配置禁止切换分支') },
  { error: safetyBlockedError('仓库配置禁止 Stash') },
  { error: invalidRequestError('Diff 参数无效') },
  { error: notFoundError('文件不存在') },
  { error: safetyBlockedError('仓库配置禁止 Stage') },
  { error: safetyBlockedError('仓库配置禁止 Unstage') },
  { error: safetyBlockedError('仓库配置禁止文件修改') },
  { error: safetyBlockedError('仓库配置禁止 Commit') },
  { error: conflictError('暂存区已变化，请重新预览后生成文案') },
  { error: conflictError('暂存区已变化，请重新预览') },
];

describe('类型化错误分类等价性', () => {
  it('覆盖了每个已改造的抛出点', () => {
    expect(convertedSites.length).toBeGreaterThan(60);
    for (const site of convertedSites) {
      expect(site.error).toBeInstanceOf(Error);
      expect(site.error.message.length).toBeGreaterThan(0);
    }
  });

  it('状态码与改造前的文案匹配结果逐条一致', () => {
    for (const { error } of convertedSites) {
      expect(classifyErrorStatus(error), `状态码不一致：${error.message}`).toBe(
        classifyErrorStatus(new Error(error.message)),
      );
    }
  });

  it('批量跳过语义与改造前逐条一致', () => {
    for (const { error, batchedFor } of convertedSites) {
      for (const type of batchedFor ?? (['pull', 'push'] as const)) {
        expect(isBatchSafetySkip(type, error), `${type} 跳过语义不一致：${error.message}`).toBe(
          isBatchSafetySkip(type, new Error(error.message)),
        );
      }
    }
  });

  it('批量批次租约冲突仍返回 409', () => {
    expect(classifyErrorStatus(new BatchAlreadyRunningError())).toBe(409);
  });
});

describe('文案与状态码解耦', () => {
  it('类型化错误换成完全无关的文案后状态码不变', () => {
    const cases: Array<[AppError, number]> = [
      [notFoundError('zzz 与任何关键词都无关'), 404],
      [invalidRequestError('zzz 与任何关键词都无关'), 400],
      [conflictError('zzz 与任何关键词都无关'), 409],
      [safetyBlockedError('zzz 与任何关键词都无关'), 409],
      [aiUpstreamError('zzz 与任何关键词都无关'), 502],
    ];
    for (const [error, status] of cases) {
      expect(classifyErrorStatus(error)).toBe(status);
    }
  });

  it('未类型化的普通 Error 继续走兜底文案匹配', () => {
    expect(classifyErrorStatus(new Error('仓库不存在'))).toBe(404);
    expect(classifyErrorStatus(new Error('工作区不干净，安全 Pull 已阻止'))).toBe(409);
    expect(classifyErrorStatus(new Error('Diff 参数无效'))).toBe(400);
    expect(classifyErrorStatus(new Error('AI 请求失败：429'))).toBe(502);
    expect(classifyErrorStatus(new Error('zzz 与任何关键词都无关'))).toBe(500);
  });

  it('安全阻止标记只由类型化错误携带，普通 Error 走文案兜底', () => {
    expect(isBatchSafetySkip('pull', safetyBlockedError('任意文案'))).toBe(true);
    expect(isBatchSafetySkip('pull', conflictError('任意文案'))).toBe(false);
    expect(isBatchSafetySkip('pull', new Error('任意文案'))).toBe(false);
    expect(isBatchSafetySkip('push', new Error('远端存在新提交或已经分叉，禁止 Push'))).toBe(true);
  });
});

/**
 * 第 152 节复盘记录的状态码历史不一致：这几条文案在改造前不含任何关键词，
 * 落到兜底分支的 500。类型化之后按真实语义修正为 409——它们是状态冲突，
 * 不是服务端故障，前端也不该对它们重试（`shouldRetryApiQuery` 对 4xx 返回 false）。
 */
describe('已修正的历史状态码', () => {
  it('冲突态与竞态错误现在返回 409', () => {
    expect(classifyErrorStatus(safetyBlockedError('仓库存在冲突或进行中的 Git 操作'))).toBe(409);
    expect(classifyErrorStatus(conflictError('目标本地分支不存在'))).toBe(409);
    expect(classifyErrorStatus(conflictError('Stash 已创建，但列表同时发生变化，请刷新后确认'))).toBe(409);
  });

  it('未类型化的同名文案仍走兜底给 500，未转换站点行为不变', () => {
    expect(classifyErrorStatus(new Error('仓库存在冲突或进行中的 Git 操作'))).toBe(500);
    expect(classifyErrorStatus(new Error('目标本地分支不存在'))).toBe(500);
    expect(classifyErrorStatus(new Error('Stash 已创建，但列表同时发生变化，请刷新后确认'))).toBe(500);
  });

  it('冲突态仍然被判定为批量可跳过', () => {
    expect(isBatchSafetySkip('pull', safetyBlockedError('仓库存在冲突或进行中的 Git 操作'))).toBe(true);
    expect(isBatchSafetySkip('push', safetyBlockedError('仓库存在冲突或进行中的 Git 操作'))).toBe(true);
  });
});
