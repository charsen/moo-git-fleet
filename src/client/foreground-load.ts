/**
 * 前台加载的忙态闸门。
 *
 * 加载函数的收尾不能只看请求序号。后台静默刷新也用同一条序号，前台请求返回时序号已经
 * 被推进，`finally` 里的「序号相等才落旗」不成立，加载态就永远为真——工具栏一直灰、
 * 暂存与提交全被挡，只有再触发一次前台加载才能解开。
 *
 * 这里按「还有几个前台请求在跑」计数：最后一个返回时才落旗，和后台刷新彻底解耦。
 * 后台请求不该调用它——它们从来不动加载态，也就不该有资格把它关掉。
 */
export interface ForegroundLoad {
  /** 一个前台请求开始。与 `end()` 必须成对。 */
  begin(): void;
  /** 这个前台请求结束；返回 true 表示这一批前台加载已经全部返回，可以落旗。 */
  end(): boolean;
}

export function createForegroundLoad(): ForegroundLoad {
  let pending = 0;
  return {
    begin(): void {
      pending += 1;
    },
    end(): boolean {
      // 多调用一次 `end()` 不该把计数压成负数，否则接下来真正开始的那个请求
      // 结束时就落不了旗，等于把刚修掉的卡死又请回来。
      if (pending > 0) pending -= 1;
      return pending === 0;
    },
  };
}
