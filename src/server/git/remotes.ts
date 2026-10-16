import type {
  RepositoriesConfig,
  RepositoryConfig,
  RepositoryRemote,
  RepositoryRemoteMutation,
} from '../../shared/contracts.js';
import { parseRemoteTarget, parseRemoteUrl } from '../../shared/remote-url.js';
import { conflictError, invalidRequestError, notFoundError, safetyBlockedError } from '../errors.js';
import { ensureRemoteName, ensureRequestedRemoteName } from './guards.js';
import { runGitText } from './runner.js';
import { scanRepository } from './scanner.js';

/**
 * 远端（remote）管理：列出 / 新增 / 改地址 / 重命名 / 删除。
 *
 * 为什么需要这一层：舰队级操作全部以配置里的默认远端（`settings.defaultRemote`）为目标，
 * 但此前**没有任何入口能修改远端本身**——仓库没有 `origin`、或者地址写错时，
 * 所有联网操作都会被前置校验挡下，而应用内无解，只能回终端敲 `git remote`。
 * 协议切换（remote-protocol）只解决「协议不同」，不解决「地址不对」。
 *
 * 安全边界：
 * 1. 远端名走 `guards.ts` 的统一守卫，不在这里另写一份正则；
 * 2. 地址走共享的 `parseRemoteTarget`（客户端预览与服务端强制同一份判定）；
 * 3. 每次写入后**立即回读校验**，git 静默改写或写失败都必须当场暴露，而不是留到下次 fetch；
 * 4. 这些操作只改本机 `.git/config`，**不碰远端服务器**；删除远端会一并删掉该远端的
 *    remote-tracking 引用（git 的既定行为），界面的确认框会说明这一点。
 */

const writeTimeoutMs = 30_000;

/** `git remote -v` 的一行：`<name>\t<url> (fetch|push)`。 */
function parseRemoteVerbose(output: string): Array<{ name: string; url: string; kind: 'fetch' | 'push' }> {
  const rows: Array<{ name: string; url: string; kind: 'fetch' | 'push' }> = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    rows.push({ name: match[1], url: match[2], kind: match[3] as 'fetch' | 'push' });
  }
  return rows;
}

/** 默认远端排在最前，其余按名称排序——用户先看到「舰队实际操作的那个」。 */
function compareRemotes(a: RepositoryRemote, b: RepositoryRemote): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function readRemoteNames(cwd: string): Promise<string[]> {
  const output = await runGitText(cwd, ['remote']).catch(() => '');
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function readRemoteUrl(cwd: string, name: string): Promise<string> {
  return (await runGitText(cwd, ['remote', 'get-url', name]).catch(() => '')).trim();
}

/**
 * 列出仓库的全部远端。
 *
 * 用一次 `git remote -v` 拿全（而不是「先列名字再逐个 get-url」）：远端多的时候
 * 后者会按个数起 git 进程，而本模块在批量场景里也会被调用。
 */
export async function listRemotes(cwd: string, defaultRemote: string): Promise<RepositoryRemote[]> {
  const verbose = await runGitText(cwd, ['remote', '-v']).catch(() => '');
  const grouped = new Map<string, { url: string; pushUrl: string | null }>();
  for (const row of parseRemoteVerbose(verbose)) {
    const entry = grouped.get(row.name) ?? { url: '', pushUrl: null };
    if (row.kind === 'fetch') entry.url = entry.url || row.url;
    else if (entry.pushUrl === null) entry.pushUrl = row.url;
    grouped.set(row.name, entry);
  }

  return [...grouped.entries()]
    .map(([name, entry]): RepositoryRemote => {
      const parsed = parseRemoteUrl(entry.url);
      return {
        name,
        url: entry.url,
        // 只把**确实不同**的推送地址暴露出来，否则界面会到处显示重复信息。
        pushUrl: entry.pushUrl && entry.pushUrl !== entry.url ? entry.pushUrl : null,
        protocol: parsed.ok ? parsed.shape.protocol : entry.url ? 'other' : null,
        host: parsed.ok ? parsed.shape.host : null,
        isDefault: name === defaultRemote,
      };
    })
    .sort(compareRemotes);
}

export type RemoteChange =
  | { kind: 'add'; name: string; url: string }
  | { kind: 'url'; name: string; url: string }
  | { kind: 'rename'; name: string; nextName: string }
  | { kind: 'remove'; name: string };

export interface RemoteChangeOutput extends RepositoryRemoteMutation {
  /** 供操作记录与结果提示使用的一句话。 */
  message: string;
}

/** 校验并返回规范化（去除首尾空白）后的地址。 */
function checkedRemoteUrl(raw: string): string {
  const parsed = parseRemoteTarget(raw);
  if (!parsed.ok) throw invalidRequestError(parsed.reason);
  return raw.trim();
}

/**
 * 改动是否触碰到「舰队默认远端」。
 *
 * 默认远端是 fetch / pull / push 与协议切换的唯一目标，改掉它（重命名 / 删除）
 * 会让该仓库暂时没有可用的默认远端——这是允许的（用户可能想删掉错的再建对的），
 * 但必须明确告知，而不是让他在下次 Pull 失败时才发现。
 */
function remoteChangeWarning(
  change: RemoteChange,
  defaultRemote: string,
  remotes: RepositoryRemote[],
): string | null {
  if (change.kind === 'add' || change.name !== defaultRemote) return null;
  if (change.kind === 'url') {
    return `这是舰队默认远端：fetch / pull / push 与协议切换都以它为目标，新地址立即生效。`;
  }
  const remaining = remotes.map((remote) => remote.name).join('、') || '无';
  const action = change.kind === 'rename' ? '重命名' : '删除';
  return `这是舰队默认远端（${defaultRemote}），${action}之后该仓库不再有名为 ${defaultRemote} 的远端，联网操作会先提示缺少远端。当前远端：${remaining}。请新建同名远端，或另行调整默认远端。`;
}

function remoteChangeMessage(change: RemoteChange): string {
  if (change.kind === 'add') return `已添加远端 ${change.name}`;
  if (change.kind === 'url') return `已更新远端 ${change.name} 的地址`;
  if (change.kind === 'rename') return `远端 ${change.name} 已重命名为 ${change.nextName}`;
  return `已删除远端 ${change.name}`;
}

/**
 * 执行一次远端改动，返回最新状态与远端列表。
 *
 * 校验顺序刻意如此：先确认仓库可用与名字合法，再确认目标远端存在（否则给出 404 而不是
 * 让 git 报一句难懂的话），最后写盘并回读。任何一步失败都不留下半成品。
 */
export async function applyRemoteChange(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  cwd: string,
  change: RemoteChange,
): Promise<RemoteChangeOutput> {
  const defaultRemote = config.settings.defaultRemote;
  // 默认远端来自配置：不合法说明本机配置有问题，抛普通错误。
  ensureRemoteName(defaultRemote);
  // 其余名字来自请求：不合法属于调用方输入问题，抛 400。
  ensureRequestedRemoteName(change.name);
  if (change.kind === 'rename') ensureRequestedRemoteName(change.nextName);

  const before = await scanRepository(config, repository);
  if (!before.available) throw safetyBlockedError('仓库当前不可用，无法管理远端');

  const names = await readRemoteNames(cwd);
  const has = (name: string) => names.includes(name);
  if (change.kind !== 'add' && !has(change.name)) {
    throw notFoundError(`仓库没有名为 ${change.name} 的远端`);
  }

  // 重命名/删除前的地址，用于核对「地址没被顺带改写」。
  const previousUrl = change.kind === 'add' ? '' : await readRemoteUrl(cwd, change.name);

  if (change.kind === 'add') {
    if (has(change.name)) throw conflictError(`已存在名为 ${change.name} 的远端`);
    const url = checkedRemoteUrl(change.url);
    await runGitText(cwd, ['remote', 'add', change.name, url], writeTimeoutMs);
    const written = await readRemoteUrl(cwd, change.name);
    if (written !== url) {
      throw new Error(`远端写入后校验失败：期望 ${url}，实际 ${written || '空'}`);
    }
  } else if (change.kind === 'url') {
    const url = checkedRemoteUrl(change.url);
    if (url === previousUrl) throw invalidRequestError('新地址与当前地址相同');
    await runGitText(cwd, ['remote', 'set-url', change.name, url], writeTimeoutMs);
    const written = await readRemoteUrl(cwd, change.name);
    if (written !== url) {
      throw new Error(`远端地址写入后校验失败：期望 ${url}，实际 ${written || '空'}`);
    }
  } else if (change.kind === 'rename') {
    if (change.nextName === change.name) throw invalidRequestError('新名称与当前名称相同');
    if (has(change.nextName)) throw conflictError(`已存在名为 ${change.nextName} 的远端`);
    await runGitText(cwd, ['remote', 'rename', change.name, change.nextName], writeTimeoutMs);
    const after = await readRemoteNames(cwd);
    if (after.includes(change.name) || !after.includes(change.nextName)) {
      throw new Error('远端重命名后校验失败：名称未按预期变化');
    }
    const renamedUrl = await readRemoteUrl(cwd, change.nextName);
    if (renamedUrl !== previousUrl) {
      throw new Error(`远端重命名后地址被改动：期望 ${previousUrl}，实际 ${renamedUrl || '空'}`);
    }
  } else {
    await runGitText(cwd, ['remote', 'remove', change.name], writeTimeoutMs);
    const after = await readRemoteNames(cwd);
    if (after.includes(change.name)) throw new Error('远端删除后校验失败：名称仍在列表中');
  }

  const remotes = await listRemotes(cwd, defaultRemote);
  return {
    status: await scanRepository(config, repository),
    defaultRemote,
    remotes,
    warning: remoteChangeWarning(change, defaultRemote, remotes),
    message: remoteChangeMessage(change),
  };
}
