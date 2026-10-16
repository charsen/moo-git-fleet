import { isSafeRemoteName } from '../../shared/remote-name.js';
import { invalidRequestError } from '../errors.js';

/**
 * 传给 git 的「名称类」参数守卫。
 *
 * 这些值最终会拼进 `git` 的参数位（`shell = false` 已挡住 shell 注入，
 * 但挡不住「参数位注入」——例如以 `-` 开头的值会被 git 当成选项解析）。
 * 因此凡是要落进参数位的名字，都必须先过这里。
 *
 * 集中在一处是刻意的：这是安全相关的判定，此前散成 6 份副本
 * （4 个同名函数 + 2 处内联正则），改一处漏一处就会留下缺口。
 * 判定本身（正则）现放在 `shared/remote-name.ts`，因为客户端也要用它做即时校验；
 * 这里只负责把它包成对应来源的错误类型。
 */

const remoteNameMessage = 'Git remote 名称不安全';

/**
 * 校验**配置来源**的 remote 名（如 `settings.defaultRemote`）。
 * 不合法说明本机配置有问题，不是调用方传错了，因此抛普通错误。
 */
export function ensureRemoteName(remote: string): void {
  if (!isSafeRemoteName(remote)) throw new Error(remoteNameMessage);
}

/**
 * 校验**请求来源**的 remote 名。不合法属于客户端输入问题，抛 400，
 * 与 `branches.ts` / `tags.ts` / `remote-deletions.ts` 原有的对外语义一致。
 */
export function ensureRequestedRemoteName(remote: string): void {
  if (!isSafeRemoteName(remote)) throw invalidRequestError(remoteNameMessage);
}
