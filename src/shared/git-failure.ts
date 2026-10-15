/**
 * git 认证类失败的语义分类。
 *
 * 放在 shared 是刻意的：服务端需要它把失败归因，界面需要它决定
 * 「这条失败是不是该引导用户去录入凭证」。两边共用一份规则，
 * 才不会有朝一日出现「服务端认为是认证问题、界面却当成网络错误」的错位。
 *
 * 只做纯字符串判定，不碰磁盘、不联网、不依赖 Node API。
 */

export type GitAuthFailureKind = 'auth-required' | 'auth-failed' | 'ssh-host-key' | 'ssh-publickey' | 'network';

export interface GitAuthFailure {
  kind: GitAuthFailureKind;
  /** 失败涉及的主机；stderr 里解析不出时为 null。 */
  host: string | null;
  /** 面向用户的下一步提示。 */
  hint: string;
}

const authRequiredPattern = /could not read Username for '(?:[a-z+]+):\/\/([^/']+)/i;
const authFailedPattern = /Authentication failed for '(?:[a-z+]+):\/\/([^/']+)/i;
const resolveHostPattern = /Could not resolve host(?::\s*)?([^\s'"]+)/i;
const hostKeyPattern = /Host key verification failed/i;
const publicKeyPattern = /Permission denied \(publickey\)/i;

/**
 * 把 git 的 stderr 归类成可行动的失败语义。
 *
 * 顺序有意义：SSH 类先判——`Host key verification failed` 的 stderr 里
 * 同样带 `Could not read from remote repository`，若先匹配网络类会误判。
 */
export function classifyGitAuthFailure(stderr: string): GitAuthFailure | null {
  if (hostKeyPattern.test(stderr)) {
    return {
      kind: 'ssh-host-key',
      host: null,
      hint: '目标主机的指纹不在 known_hosts 中，非交互环境下无法确认',
    };
  }
  if (publicKeyPattern.test(stderr)) {
    return {
      kind: 'ssh-publickey',
      host: null,
      hint: 'SSH 公钥被远端拒绝，请确认本机公钥已加入该账号',
    };
  }
  const required = authRequiredPattern.exec(stderr);
  if (required) {
    return { kind: 'auth-required', host: required[1], hint: '该主机尚未保存凭证' };
  }
  const failed = authFailedPattern.exec(stderr);
  if (failed) {
    return { kind: 'auth-failed', host: failed[1], hint: '已保存的凭证被远端拒绝，可能已过期' };
  }
  const resolve = resolveHostPattern.exec(stderr);
  if (resolve) {
    return { kind: 'network', host: resolve[1], hint: '无法解析主机名，请检查网络与 DNS' };
  }
  return null;
}

/** 该失败能否通过「录入 / 更新凭证」解决。 */
export function isCredentialFixable(kind: GitAuthFailureKind): boolean {
  return kind === 'auth-required' || kind === 'auth-failed';
}
