/**
 * 远端名的合法性判定。
 *
 * 放在 shared 是因为**客户端与服务端都要用**：服务端拿它做强制校验
 * （`guards.ts` 里的两个抛错包装），客户端拿它做输入框的即时校验——
 * 否则用户要等一次往返才知道名字不合法。
 *
 * 判定只此一处。此前这份正则散成 6 份副本（4 个同名函数 + 2 处内联），
 * 改一处漏一处就会留下缺口，所以宁可多一个模块也不再复制。
 */

// 否定式前瞻排除**以 `-` 开头**的名字：这类值会被 git 当成选项解析
// （`--upload-pack=...` 之类）。`-` 出现在中间是正常的（`my-remote`）。
const safeRemoteNamePattern = /^(?!-)[A-Za-z0-9._-]+$/;

/** 该名字能否安全地落进 git 的参数位（`remote` / `branch` 之类的名称位）。 */
export function isSafeRemoteName(name: string): boolean {
  return safeRemoteNamePattern.test(name);
}
