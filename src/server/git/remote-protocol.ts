import type { RepositoriesConfig, RepositoryConfig, RepositoryStatus } from '../../shared/contracts.js';
import { ensureRemoteName } from './guards.js';
import { classifyRemoteProbe, type RemoteProbeVerdict } from '../../shared/git-failure.js';
import { convertRemoteUrl, type RemoteProtocol } from '../../shared/remote-url.js';
import { conflictError, invalidRequestError, safetyBlockedError } from '../errors.js';
import { runGit, runGitText } from './runner.js';
import { scanRepository } from './scanner.js';

/** remote 名会进入 git 参数位，只接受 git 允许的安全字符。 */
/** 切换后的连通性结论。 */
export type RemoteSwitchVerification =
  /** `ls-remote` 成功，新地址确认可用。 */
  | 'reachable'
  /** 地址可达但需要凭证 / 密钥；这是正常状态，不算失败。 */
  | 'needs-credential'
  /** 未能完成校验（网络、主机指纹等）；不武断回滚。 */
  | 'unverified';

export interface RemoteProtocolSwitch {
  status: RepositoryStatus;
  /** 切换前的地址（原样回读，便于确认框与结果提示）。 */
  from: string;
  /** 切换后的地址。 */
  to: string;
  verification: RemoteSwitchVerification;
  /** 需要向用户补充的说明；无需补充时为 null。 */
  note: string | null;
}

const probeTimeoutMs = 20_000;

/**
 * 只读探活：直接问远端这个地址是否可访问。
 * 走 `git ls-remote`（不写任何东西），并沿用 runner 的 `GIT_TERMINAL_PROMPT=0`，
 * 因此缺凭证时会立即失败而不是卡住等输入。
 */
export type RemoteProbe = (cwd: string, url: string) => Promise<RemoteProbeVerdict>;

const probeRemote: RemoteProbe = async (cwd, url) => {
  const result = await runGit(cwd, ['ls-remote', '--exit-code', url], probeTimeoutMs).catch(() => null);
  if (!result) return 'unverified';
  return classifyRemoteProbe(result.exitCode, result.stderr);
};

/**
 * 把仓库默认 remote 的地址在 SSH 与 HTTPS 之间切换，并做一次只读探活。
 *
 * 只改写 `.git/config` 里的一行：不碰工作区、不碰历史、不碰远端，因而可随时切回；
 * 因此这里不做「工作区必须干净」之类的限制。写入后立即回读校验，避免 git 静默改写。
 * 只处理配置里的默认 remote（`settings.defaultRemote`），其它 remote 不动。
 *
 * 探活结论决定后续动作（见 `classifyRemoteProbe`）：
 *   可达 → 保留；需凭证 → 保留（地址是对的）；地址不存在 → 回滚为原地址并报错；
 *   网络类未能确认 → 保留并提示未校验（避免因一次抖动把正确地址改回去）。
 */
export async function switchRemoteProtocol(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  target: RemoteProtocol,
  options: { verify?: boolean; probe?: RemoteProbe } = {},
): Promise<RemoteProtocolSwitch> {
  const remote = config.settings.defaultRemote;
  ensureRemoteName(remote);

  const before = await scanRepository(config, repository);
  if (!before.available) throw safetyBlockedError('仓库当前不可用，无法切换远端协议');

  const current = (await runGitText(cwd, ['remote', 'get-url', remote]).catch(() => '')).trim();
  if (!current) throw safetyBlockedError(`仓库没有名为 ${remote} 的 remote`);

  const conversion = convertRemoteUrl(current, target);
  if (!conversion.ok) throw invalidRequestError(conversion.reason);

  await runGitText(cwd, ['remote', 'set-url', remote, conversion.url], 30_000);
  const verified = (await runGitText(cwd, ['remote', 'get-url', remote]).catch(() => '')).trim();
  if (verified !== conversion.url) {
    throw new Error(`远端地址写入后校验失败：期望 ${conversion.url}，实际 ${verified || '空'}`);
  }

  if (options.verify === false) {
    return {
      status: await scanRepository(config, repository),
      from: current,
      to: conversion.url,
      verification: 'unverified',
      note: null,
    };
  }

  const probe = options.probe ?? probeRemote;
  const verdict = await probe(cwd, conversion.url);
  if (verdict === 'address-missing') {
    const reason = `远端地址 ${conversion.url} 在远端不存在`;
    // 只在当前值仍是我们刚写入的地址时才回滚，避免覆盖并发改动。
    const live = (await runGitText(cwd, ['remote', 'get-url', remote]).catch(() => '')).trim();
    if (live !== conversion.url) {
      throw conflictError(`${reason}；当前地址已被其它操作改为 ${live || '空'}，未自动回滚，请手动确认`);
    }
    const restored = await runGitText(cwd, ['remote', 'set-url', remote, current], 30_000)
      .then(() => true)
      .catch(() => false);
    // 消息必须反映真实结果：回滚失败时不能宣称已回滚。
    throw conflictError(
      restored
        ? `${reason}，已回滚为 ${current}`
        : `${reason}；自动回滚失败，当前仍是 ${conversion.url}，请手动改回 ${current}`,
    );
  }

  return {
    status: await scanRepository(config, repository),
    from: current,
    to: conversion.url,
    verification: verdict === 'reachable' ? 'reachable' : verdict === 'needs-credential' ? 'needs-credential' : 'unverified',
    note:
      verdict === 'needs-credential'
        ? '该地址需要凭证或密钥，录入后即可访问'
        : verdict === 'unverified'
          ? '未能完成连通性校验（可能是网络或主机指纹问题）'
          : null,
  };
}
