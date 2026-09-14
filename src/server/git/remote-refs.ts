export interface ParsedRemoteRef {
  /** 形如 `origin/main`。 */
  upstream: string;
  remote: string;
  branch: string;
  head: string;
}

/**
 * 解析 `for-each-ref --format=%(refname)%00%(objectname) refs/remotes` 的输出。
 * 只保留已知 remote 下的真实分支，过滤 `refs/remotes/<remote>/HEAD` 这类符号引用。
 */
export function parseRemoteRefs(buffer: Buffer, remotes: string[]): ParsedRemoteRef[] {
  const remoteSet = new Set(remotes);
  return buffer
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((record) => {
      const [ref = '', head = ''] = record.split('\0');
      if (!ref.startsWith('refs/remotes/') || !head) return [];
      const shortRef = ref.slice('refs/remotes/'.length);
      const separator = shortRef.indexOf('/');
      if (separator <= 0) return [];
      const remote = shortRef.slice(0, separator);
      const branch = shortRef.slice(separator + 1);
      if (!remoteSet.has(remote) || !branch || branch === 'HEAD') return [];
      return [{ upstream: `${remote}/${branch}`, remote, branch, head }];
    });
}
