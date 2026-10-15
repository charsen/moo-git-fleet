/**
 * 远端地址协议转换：在 SSH 与 HTTPS 两种远程形式之间互转。
 *
 * 用途：把仓库的 remote 从 SSH 切到 HTTPS，以便复用系统钥匙串里的凭证
 * （凭证能力只对 HTTPS 生效）；也支持切回 SSH。
 *
 * 只重写「协议 + 凭据形式」，主机名与仓库路径原样保留：
 *   git@gitee.com:charsen/moo-like.git         ⇄  https://gitee.com/charsen/moo-like.git
 *   ssh://git@gitee.com/charsen/moo-like.git   ⇄  https://gitee.com/charsen/moo-like.git
 *
 * **对主机不做任何假设**：不硬编码任何托管商，只要该主机遵循「同主机 + 同路径 +
 * `git@` 用户」这一主流约定即可（gitee / github / gitlab / bitbucket，以及自建的
 * Gitea、GitLab、GitHub Enterprise 均如此）。
 *
 * 两类情况会**拒绝而不是猜**，因为猜错会把仓库指向错误的远端：
 *   1. 地址本身无法无损往返：自定义端口、URL 编码路径、查询串 / 锚点、无法识别的协议；
 *   2. 主机已知不满足上述约定：Azure DevOps、AWS CodeCommit（见 nonMappableHosts）。
 * 拒绝时返回可解释的原因，交由用户手动 `git remote set-url`。
 *
 * 纯函数，无副作用：客户端用它预览目标地址，服务端用它执行切换，两侧行为一致。
 */

export type RemoteProtocol = 'https' | 'ssh';

export interface RemoteUrlShape {
  protocol: RemoteProtocol;
  /** scp / ssh 形式里的显式用户名；HTTPS 的 userinfo。缺省为 null（转 SSH 时按 git 处理）。 */
  user: string | null;
  /** 主机名，不含端口。 */
  host: string;
  /** 显式端口；缺省为 null。 */
  port: string | null;
  /** 仓库路径，不含前导斜杠；保留 `.git` 后缀。 */
  path: string;
}

export type RemoteUrlParse = { ok: true; shape: RemoteUrlShape } | { ok: false; reason: string };

export type RemoteProtocolConversion =
  | { ok: true; url: string; from: RemoteProtocol; to: RemoteProtocol }
  | { ok: false; reason: string };

// 只接受 git 远端常见的字符集：任何更宽的范围都可能把换行、空格或前导 `-`
// 带进 `git remote set-url` 的参数位，造成注入或误解析。
// `~` 是 SourceHut 这类主机的仓库路径前缀（`~user/repo`），对 git 参数是安全的。
const hostPattern = /^[A-Za-z0-9.-]+$/;
const userPattern = /^[A-Za-z0-9._-]+$/;
const pathPattern = /^[A-Za-z0-9._/~-]+$/;

/**
 * 少数主机的 SSH 与 HTTPS 地址**不是**「同主机 + 同路径」，只换前缀会得到错误地址。
 * 这些主机一律拒绝自动转换，把选择权交回用户，而不是静默写坏 remote。
 *
 * 判据是「已知的命名/路径约定差异」，不是「不认识的主机」——自建 Gitea / GitLab /
 * GitHub Enterprise 等仍是同主机同路径，正常转换。
 */
const nonMappableHosts: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(^|\.)(dev\.azure\.com|visualstudio\.com)$/i,
    reason: 'Azure DevOps 的 SSH 地址改用 ssh.dev.azure.com 且路径带 v3/ 前缀，与 HTTPS 不一一对应',
  },
  {
    pattern: /^git-codecommit\.[a-z0-9-]+\.amazonaws\.com$/i,
    reason: 'AWS CodeCommit 的 SSH 地址使用 ssh:// 形式且不含 git@ 用户，与 HTTPS 不一一对应',
  },
];

function nonMappableReason(host: string): string | null {
  for (const rule of nonMappableHosts) {
    if (rule.pattern.test(host)) return rule.reason;
  }
  return null;
}

function validateShape(shape: RemoteUrlShape): string | null {
  if (!shape.host) return '远端地址缺少主机名';
  if (!hostPattern.test(shape.host)) return `主机名含无法安全转换的字符：${shape.host}`;
  if (shape.user && !userPattern.test(shape.user)) return `用户名含无法安全转换的字符：${shape.user}`;
  if (!shape.path) return '远端地址缺少仓库路径';
  if (!pathPattern.test(shape.path)) return `仓库路径含无法安全转换的字符：${shape.path}`;
  return null;
}

function parseUrlForm(raw: string): RemoteUrlParse {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `无法解析远端地址：${raw}` };
  }
  const protocol: RemoteProtocol | null =
    url.protocol === 'https:' ? 'https' : url.protocol === 'ssh:' ? 'ssh' : null;
  if (!protocol) return { ok: false, reason: `不支持的协议：${url.protocol.replace(/:$/, '')}` };
  if (url.search || url.hash) return { ok: false, reason: '远端地址包含查询串或锚点，无法安全转换' };
  // `new URL` 会把路径做百分号编码，而 scp 形式承载不了这种编码；拒绝而不是静默丢字符。
  if (url.pathname.includes('%')) return { ok: false, reason: '仓库路径包含 URL 编码字符，无法安全转换' };

  const shape: RemoteUrlShape = {
    protocol,
    user: url.username || null,
    host: url.hostname,
    port: url.port || null,
    path: url.pathname.replace(/^\/+/, ''),
  };
  const invalid = validateShape(shape);
  return invalid ? { ok: false, reason: invalid } : { ok: true, shape };
}

function parseScpForm(raw: string): RemoteUrlParse {
  const match = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/.exec(raw);
  if (!match) return { ok: false, reason: `无法识别的远端地址：${raw}` };
  const shape: RemoteUrlShape = {
    protocol: 'ssh',
    user: match[1] ?? null,
    host: match[2]!,
    port: null,
    path: match[3]!.replace(/^\/+/, ''),
  };
  const invalid = validateShape(shape);
  return invalid ? { ok: false, reason: invalid } : { ok: true, shape };
}

/** 解析远端地址；识别不了时返回可解释的原因，而不是抛异常。 */
export function parseRemoteUrl(raw: string): RemoteUrlParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: '远端地址为空' };
  return trimmed.includes('://') ? parseUrlForm(trimmed) : parseScpForm(trimmed);
}

/**
 * 把远端地址转换成目标协议形式。
 * 已经是目标协议、主机不满足 1:1 映射、或无法无损转换时返回 `ok: false` 与原因。
 */
export function convertRemoteUrl(raw: string, target: RemoteProtocol): RemoteProtocolConversion {
  const parsed = parseRemoteUrl(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const { shape } = parsed;
  if (shape.protocol === target) return { ok: false, reason: `远端已经是 ${protocolLabel(target)} 形式` };

  const nonMappable = nonMappableReason(shape.host);
  if (nonMappable) return { ok: false, reason: `${nonMappable}，请手动执行 git remote set-url` };

  if (target === 'https') {
    // ssh 的 22 是默认端口，省略即等价；其它端口无法假定 HTTPS 也监听同一端口。
    if (shape.port && shape.port !== '22') {
      return { ok: false, reason: `SSH 自定义端口 ${shape.port} 无法自动映射为 HTTPS，请手动修改` };
    }
    return { ok: true, url: `https://${shape.host}/${shape.path}`, from: shape.protocol, to: target };
  }

  // 443 是 HTTPS 默认端口，省略即等价。
  if (shape.port && shape.port !== '443') {
    return { ok: false, reason: `HTTPS 自定义端口 ${shape.port} 无法自动映射为 SSH，请手动修改` };
  }
  const user = shape.user ?? 'git';
  return { ok: true, url: `${user}@${shape.host}:${shape.path}`, from: shape.protocol, to: target };
}

export function protocolLabel(protocol: RemoteProtocol): string {
  return protocol === 'https' ? 'HTTPS' : 'SSH';
}
