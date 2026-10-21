/**
 * 远端地址工具：解析、协议互转、以及「新增/修改远端」时的地址校验。
 *
 * ## 一、协议互转（convertRemoteUrl）
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
 * ## 二、新增/修改远端的地址校验（parseRemoteTarget）
 *
 * 与上面相反：那个只接受能 1:1 往返的形式，这个必须更宽（否则用户连 `git remote add`
 * 都做不到），但每一种危险形态都明确拒绝（控制字符、前导 `-`、裸空格、`ext::` 远程助手、
 * 白名单之外的协议）。
 *
 * 纯函数，无副作用：客户端用它做即时反馈，服务端用它做强制校验，两侧判定一致。
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
 * 去掉复制地址时常见的包裹符号与命令前缀。
 *
 * 从聊天窗口、Markdown 或文档里复制的地址经常带着壳：`"https://…"`、`<git@…>`、
 * `` `https://…` ``。直接解析会得到「不支持的协议："https」——而提示里还列着 https 可用，
 * 看上去像自相矛盾，用户也很难意识到问题出在引号上。
 *
 * 仓库首页与 README 上给的又常常是整条命令：`git clone https://…`、
 * `git clone --depth 1 …`。用户选中复制时，`git clone` 和选项会一起进来。
 *
 * 只剥离**成对**的包裹符号，且最多剥一层：避免把地址本身合法的首尾字符吃掉。
 * 纯字符串处理，客户端与服务端共用同一份判定。
 */
/**
 * 剥掉成对的包裹符号（引号、反引号、尖括号）。
 *
 * 允许剥多层（`'<https://…>'` 这种从 Markdown 表格里抄出来的双层壳），但设上限：
 * 合法地址不会以引号开头又以引号结尾，因此多层剥离不会误伤，上限只是防病态输入。
 */
function stripWrappers(raw: string): string {
  let value = raw.trim();
  for (let round = 0; round < 3; round += 1) {
    let stripped = false;
    for (const [open, close] of [['"', '"'], ["'", "'"], ['`', '`'], ['<', '>']] as const) {
      if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(1, -1).trim();
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return value;
}

export function normalizeRemoteUrlInput(raw: string): string {
  const value = stripWrappers(raw);
  // 命令形态：取第一个「看起来是地址」的参数。选项（`--depth`、`-b`）与它们的取值
  // （`1`、`main`）都不含 `://`、`@主机:` 或前导 `/`，因此不会被误当成地址；
  // 若一个都认不出来就原样返回，交给解析器给出可解释的原因。
  const command = /^git\s+clone\s+(.+)$/i.exec(value);
  if (!command) return value;
  const tokens = command[1]!.trim().split(/\s+/).filter(Boolean);
  const address = tokens.find(
    (token) => token.includes('://') || /^[^@\s]+@[^:\s]+:/.test(token) || token.startsWith('/'),
  );
  // 地址自己常常还带着引号：`git clone "git@host:group/repo.git"`。再剥一层。
  return address ? stripWrappers(address) : value;
}

export type RemoteTargetKind =
  /** 带协议的完整地址，如 `https://host/path`、`ssh://user@host:22/path`。 */
  | 'url'
  /** scp 形式，如 `git@host:group/repo.git`。 */
  | 'scp'
  /** 本机绝对路径（含 Windows 盘符），指向本地仓库。 */
  | 'local-path';

export type RemoteTargetParse = { ok: true; kind: RemoteTargetKind } | { ok: false; reason: string };

const maxRemoteTargetLength = 2048;
/**
 * 允许的传输协议。这是一份**白名单**：未知协议一律拒绝，而不是放过——
 * `git remote add` 写进 `.git/config` 的地址会在后续每次 fetch 时被 git 使用。
 */
const allowedRemoteSchemes = new Set(['http', 'https', 'ssh', 'git', 'file']);

/**
 * 校验「新增 / 修改远端地址」时用户输入的地址。
 *
 * 与 `convertRemoteUrl` 的分工：那个是「把已有地址换个协议」，只接受能 1:1 往返的形式；
 * 这个是「用户直接写一个地址」，因此必须更宽（否则连 `git remote add` 都做不到），
 * 但每一种危险形态都要明确拒绝：
 *
 * 1. 控制字符（含换行 / 制表符）——会破坏 `.git/config` 的逐行格式；
 * 2. 以 `-` 开头——会被 git 当成选项解析；
 * 3. 裸空格——git 配置里需要转义，写进去容易读错，要求改用 `%20`；
 * 4. `协议::远程助手`（`ext::` 之类）——git 会在访问远端时**执行本地命令**；
 * 5. 白名单之外的协议。
 *
 * 纯函数：客户端用它先给出即时反馈，服务端用它做强制校验，两侧判定一致。
 */
export function parseRemoteTarget(raw: string): RemoteTargetParse {
  const value = normalizeRemoteUrlInput(raw);
  if (!value) return { ok: false, reason: '远端地址为空' };
  if (value.length > maxRemoteTargetLength) {
    return { ok: false, reason: `远端地址过长（上限 ${maxRemoteTargetLength} 字符）` };
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, reason: '远端地址不能包含控制字符或换行' };
  }
  if (value.startsWith('-')) {
    return { ok: false, reason: '远端地址不能以「-」开头，否则会被 git 当成选项' };
  }
  // 这一条必须排在「空格」之前：`ext::sh -c whoami` 同时命中两者，
  // 但真正的拒绝理由是会执行本地命令，报成空格等于给错原因。
  if (/^[A-Za-z0-9+.-]+::/.test(value)) {
    return { ok: false, reason: '不支持「协议::远程助手」形式的地址：git 会在访问远端时执行本地命令' };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: '远端地址不能包含空格，请改用 URL 编码（%20）' };
  }

  if (value.includes('://')) {
    const scheme = value.slice(0, value.indexOf('://')).toLowerCase();
    if (!allowedRemoteSchemes.has(scheme)) {
      return { ok: false, reason: `不支持的协议：${scheme}（可用 http / https / ssh / git / file）` };
    }
    return { ok: true, kind: 'url' };
  }

  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return { ok: true, kind: 'local-path' };

  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/.exec(value);
  if (scp) {
    if (scp[1] && !userPattern.test(scp[1])) {
      return { ok: false, reason: `用户名含无法安全使用的字符：${scp[1]}` };
    }
    if (!hostPattern.test(scp[2]!)) return { ok: false, reason: `主机名含无法安全使用的字符：${scp[2]!}` };
    if (!pathPattern.test(scp[3]!)) {
      return { ok: false, reason: `仓库路径含无法安全使用的字符：${scp[3]!}` };
    }
    return { ok: true, kind: 'scp' };
  }

  return { ok: false, reason: '无法识别的远端地址：请用 https://… 、ssh://… 或 git@主机:路径 的形式' };
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

/**
 * 从远端地址推断克隆时的默认目录名：取路径最后一段并去掉 `.git` 后缀。
 *
 * 与远端管理一样放在共享层：服务端用它决定落到哪个目录，客户端用它**提前把名字显示出来**，
 * 否则用户只能等提交后才知道被取成了什么。纯字符串处理，不依赖任何运行环境。
 *
 * 推断不出来时返回 null，由调用方要求用户自己填——而不是随便取一个名字。
 */
export function suggestedDirectoryName(raw: string): string | null {
  const value = normalizeRemoteUrlInput(raw).replace(/\/+$/, '');
  if (!value) return null;
  const last = value.split('/').filter(Boolean).at(-1);
  if (!last) return null;
  const withoutSuffix = last.replace(/\.git$/i, '');
  if (!withoutSuffix || withoutSuffix === '.' || withoutSuffix === '..') return null;
  return withoutSuffix;
}
