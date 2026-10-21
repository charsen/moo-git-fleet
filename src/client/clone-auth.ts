/**
 * 克隆失败时，判断这次失败是不是「缺凭证 / 凭证过期」，以及界面该给出什么下一步。
 *
 * 为什么单独成模块：判断规则在 shared 里已有一份（`classifyGitAuthFailure`），
 * 但界面还需要决定**能不能内联补填**、以及 SSH 这类无法内联修复的失败该怎么引导。
 * 把这段映射写成纯函数，App.vue 只负责渲染，测试也不必拉起整个组件。
 */
import {
  classifyGitAuthFailure,
  isCredentialFixable,
  type GitAuthFailureKind,
} from '../shared/git-failure';

export interface CloneAuthState {
  kind: GitAuthFailureKind;
  /** 失败涉及的主机；git 没在 stderr 里给出时用地址里的主机兜底。 */
  host: string | null;
  /** 能否通过「用户名 + 令牌」当场补救（只有 https 的两种认证失败可以）。 */
  fixable: boolean;
  /** 面向用户的一句话说明与下一步。 */
  guidance: string;
}

function guidanceFor(kind: GitAuthFailureKind, host: string | null): string {
  // 凭证键含端口，但 `ssh -T` 的命令行不能带端口；给用户的命令只取主机名。
  const sshHost = host?.replace(/:\d+$/, '') ?? '主机';
  switch (kind) {
    case 'auth-required':
      return '该主机还没有可用凭证：填入用户名与访问令牌，保存到系统钥匙串后会自动重试。';
    case 'auth-failed':
      return '已保存的凭证被远端拒绝，可能已过期：填入新的访问令牌后重试。';
    case 'ssh-host-key':
      return `SSH 主机指纹未信任：先在终端执行 ssh -T git@${sshHost} 确认一次，再回来重试。`;
    case 'ssh-publickey':
      return 'SSH 公钥被远端拒绝：确认本机公钥（~/.ssh/id_*.pub）已加入该账号，再回来重试。';
    case 'network':
      return '无法解析主机名：检查网络与地址拼写后重试。';
    default:
      return '请检查远端地址与访问权限后重试。';
  }
}

/**
 * 从克隆失败信息里推导认证状态；不是认证问题就返回 null（界面按普通错误处理）。
 *
 * `hostFromUrl` 只作兜底：`Authentication failed` 的 stderr 带主机，
 * 但 SSH 类失败的 stderr 里没有，只能从用户填的地址取。
 *
 * `protocol` 用于排除未加密的 http：凭证层固定按 `protocol=https` 存取
 * （见 server/git/credentials.ts），给 http 地址填了也只会写进一条永远命不中的记录，
 * 与其让用户白填一次，不如直接说清「请改用 https」。
 */
export function cloneAuthState(
  message: string,
  hostFromUrl?: string | null,
  protocol?: string | null,
): CloneAuthState | null {
  const failure = classifyGitAuthFailure(message);
  if (!failure) return null;
  const host = failure.host ?? hostFromUrl ?? null;
  const httpsOnly = protocol === 'http' && isCredentialFixable(failure.kind);
  return {
    kind: failure.kind,
    host,
    fixable: Boolean(host) && isCredentialFixable(failure.kind) && !httpsOnly,
    guidance: httpsOnly
      ? '该地址使用未加密的 http，凭证能力只支持 https：请改用 https 地址后重试。'
      : guidanceFor(failure.kind, host),
  };
}

/** git 往 stderr 里写的进度行：既不是错误原因，也不该占满弹窗底部。 */
const PROGRESS_LINE = /^(remote:\s*)?(Cloning into|Counting|Compressing|Receiving|Resolving|Enumerating|Total)\b/i;
/**
 * 把 git 的原始 stderr 压成一句可读的原因。
 *
 * 克隆失败时 stderr 的第一行几乎总是进度行（`Cloning into 'demo'...`），
 * 原样塞进底部会变成「克隆失败：Cloning into 'demo'... fatal: repository … not found」。
 * 这里丢掉进度行、把剩下的行拼成一句，并去掉开头的 `fatal:`——外面已经写了「克隆失败」。
 *
 * 只在展示时用：认证分类要拿原始文本，别把可能带关键信息的行提前删掉。
 */
export function cleanCloneError(message: string): string {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !PROGRESS_LINE.test(line))
    // 每行都去一次 `fatal:`：多行错误里它可能出现在中间那行，只在开头去会漏。
    .map((line) => line.replace(/^fatal:\s*/i, ''));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  // 万一整段都只是进度行（极少见），退回原始文本，别让错误行变成空白。
  return joined || message.trim();
}

/**
 * 把「认证类之外」的常见克隆失败翻成一句人话；翻不了就返回 null，交给原始 stderr。
 *
 * 克隆真正会失败的就那么几种，而 git 的原文对普通用户不可读：
 * 连不上时是 `LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to …`，
 * 仓库不存在时是 `remote: Repository not found.`。这两条给出可操作的中文，
 * 原文仍然保留在后面——排查时还是得看它。
 *
 * 认证类失败不在这里处理：它们有更具体的下一步（补填凭证 / 确认公钥），
 * 走 `cloneAuthState` 那条路。
 */
export function cloneFailureHint(message: string): string | null {
  if (/repository .*not found|Repository not found|does not appear to be a git repository/i.test(message)) {
    return '远端没有这个仓库：检查地址拼写，或确认当前账号有访问权限。';
  }
  if (/SSL_connect|SSL_ERROR|Connection refused|Connection timed out|Failed to connect|Could not connect|Operation timed out|unable to access/i.test(message)) {
    return '连不上远端主机：检查网络、代理，以及地址里的端口是否正确。';
  }
  // 空仓库不算失败：git 会正常克隆并只给一句 warning，所以这里不必覆盖。
  return null;
}
