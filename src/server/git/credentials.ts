/**
 * 远端凭证能力：让界面能为 https remote 录入一次凭证，同主机的仓库自动复用。
 *
 * 存储层刻意不自建。git 的 `credential.helper` 已经指向系统钥匙串
 * （macOS 上是 `osxkeychain`），直接调用 `git credential approve/reject`
 * 就能读写同一份记录。这样 Moo Fleet、终端与其它 Git 客户端共享一份凭证：
 * 任何一方录入，其余立刻可用；用户换机器时也只需沿用系统既有的凭证习惯。
 *
 * 安全约束（改动此文件时必须保持）：
 * - 凭证只经 stdin 传给 git，绝不进 argv（`ps` 可见）、不写配置文件、不进日志；
 * - 任何回显给用户的 stderr 都要先做脱敏。
 */
import type {
  RemoteCredentialHost,
  RemoteCredentialOverview,
  RepositoryConfig,
  SaveRemoteCredentialRequest,
} from '../../shared/contracts.js';
import { appRoot } from '../config/store.js';
import { mapWithConcurrency } from '../concurrency.js';
import { invalidRequestError } from '../errors.js';
import { runGit, runGitText } from './runner.js';

/** git 认证类失败的语义分类；界面据此给出不同的下一步动作。 */
export type { GitAuthFailure, GitAuthFailureKind } from '../../shared/git-failure.js';

export interface RemoteTarget {
  protocol: 'https' | 'ssh' | 'other';
  host: string;
}

/** 主机名白名单：挡住会被拼进 stdin 负载的换行与其它字符。 */
const hostPattern = /^[A-Za-z0-9.-]+(?::\d+)?$/;

/**
 * 从 remote 地址解析协议与主机。
 *
 * 同时支持 URL 形式（`https://gitee.com/x/y.git`）与 scp 形式
 * （`git@gitee.com:x/y.git`）——后者没有 `://`，`new URL` 会直接抛错。
 */
export function parseRemoteTarget(remote: string): RemoteTarget | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('://')) {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):[^\s]+$/.exec(trimmed);
    if (!scp) return null;
    return { protocol: 'ssh', host: scp[1] };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const protocol = url.protocol === 'https:' ? 'https' : url.protocol === 'ssh:' ? 'ssh' : 'other';
  // 用 `host` 而非 `hostname`：git 的 credential 键包含端口，
  // 丢掉端口会让同一主机不同端口的凭证互相覆盖。
  return { protocol, host: url.host };
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function credentialPayload(host: string, username: string, secret: string): string {
  return `protocol=https\nhost=${host}\nusername=${username}\npassword=${secret}\n\n`;
}

/** 把可能被回显的凭证从错误文案里抹掉，再交给界面或日志。 */
function redact(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('<已隐藏>');
  }
  return output;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
}

function parseCredentialOutput(output: string): { username: string | null; password: string | null } {
  let username: string | null = null;
  let password: string | null = null;
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'username' && !username) username = value;
    if (key === 'password' && !password) password = value;
  }
  return { username, password };
}

/**
 * 读取该主机已存的凭证。
 *
 * 未命中时 git 会尝试转向终端提示，而 runner 固定 `GIT_TERMINAL_PROMPT=0`，
 * 于是以非零码退出（`could not read Username ...`）——正好可当作「没有凭证」的判据，
 * 无需依赖平台特有的钥匙串命令。
 */
export async function readStoredCredential(host: string): Promise<{ username: string; password: string } | null> {
  const normalized = normalizeHost(host);
  if (!hostPattern.test(normalized)) return null;
  const result = await runGit(appRoot, ['credential', 'fill'], 10_000, `protocol=https\nhost=${normalized}\n\n`);
  if (result.exitCode !== 0) return null;
  const fields = parseCredentialOutput(result.stdout.toString('utf8'));
  if (!fields.username) return null;
  return { username: fields.username, password: fields.password ?? '' };
}

async function hasStoredCredential(host: string): Promise<boolean> {
  return (await readStoredCredential(host)) !== null;
}

async function readCredentialHelper(): Promise<string | null> {
  const value = await runGitText(appRoot, ['config', '--get', 'credential.helper']).catch(() => '');
  return value || null;
}

/** 校验并归一化用户输入；任何非法输入都在触碰 git 之前拦下。 */
function normalizeCredentialInput(input: SaveRemoteCredentialRequest): { host: string; username: string; secret: string } {
  const host = normalizeHost(input.host);
  if (!hostPattern.test(host)) throw invalidRequestError('主机名无效');
  const username = input.username.trim();
  if (!username) throw invalidRequestError('用户名不能为空');
  if (/[\r\n]/.test(username)) throw invalidRequestError('用户名不能包含换行');
  if (!input.secret) throw invalidRequestError('凭证不能为空');
  if (/[\r\n]/.test(input.secret)) throw invalidRequestError('凭证不能包含换行');
  return { host, username, secret: input.secret };
}

/** 把凭证交给 git 的凭证助手持久化（macOS 上即写入登录钥匙串）。 */
export async function saveRemoteCredential(input: SaveRemoteCredentialRequest): Promise<void> {
  const { host, username, secret } = normalizeCredentialInput(input);
  const result = await runGit(appRoot, ['credential', 'approve'], 10_000, credentialPayload(host, username, secret));
  if (result.exitCode !== 0) {
    const reason = firstLine(redact(result.stderr, [secret]));
    throw new Error(`写入凭证失败：${reason || '未知错误'}`);
  }
}

/** 擦除该主机已存的凭证。返回是否真的删掉了一条。 */
export async function removeRemoteCredential(host: string): Promise<boolean> {
  const normalized = normalizeHost(host);
  if (!hostPattern.test(normalized)) throw invalidRequestError('主机名无效');
  const stored = await readStoredCredential(normalized);
  if (!stored) return false;
  const result = await runGit(
    appRoot,
    ['credential', 'reject'],
    10_000,
    credentialPayload(normalized, stored.username, stored.password),
  );
  return result.exitCode === 0;
}

const protocolRank: Record<RemoteTarget['protocol'], number> = { https: 0, ssh: 1, other: 2 };

/** 需要处理的排前面：https 缺凭证 → https 有凭证 → ssh → other，同档按主机名。 */
function compareCredentialHosts(left: RemoteCredentialHost, right: RemoteCredentialHost): number {
  const leftMissing = left.protocol === 'https' && left.hasCredential === false;
  const rightMissing = right.protocol === 'https' && right.hasCredential === false;
  if (leftMissing !== rightMissing) return leftMissing ? -1 : 1;
  const rank = protocolRank[left.protocol] - protocolRank[right.protocol];
  if (rank !== 0) return rank;
  return left.host.localeCompare(right.host);
}

/**
 * 汇总所有已启用仓库的远端主机与凭证状态。
 *
 * 归并键是 `protocol://host` 而不是单独的 host：git 的 credential 键本身就包含
 * 协议，`https://gitee.com` 与 `ssh://gitee.com` 是两条互不相干的记录——
 * 前者要凭证、后者走密钥。若只按 host 归并，同主机下两种协议的仓库会互相吞并，
 * 用户会看到一条既像缺凭证又像不需要凭证的模糊记录。
 *
 * 逐仓读取 remote 会各起一个 git 进程，因此并发必须有界：50 个仓库无界并发
 * 会瞬间拉起 50 个进程，既拖慢机器也污染 `activeGitProcessCount()` 的读数。
 * 并发上限由调用方传入（通常沿用 `settings.localScanConcurrency`）。
 *
 * 仓库路径由调用方注入，便于测试时不碰真实磁盘。
 */
export async function listRemoteCredentialHosts(
  repositories: RepositoryConfig[],
  absolutePathOf: (repository: RepositoryConfig) => string,
  defaultRemote: string,
  concurrency = 6,
): Promise<RemoteCredentialOverview> {
  const scanned = await mapWithConcurrency(repositories, concurrency, async (repository) => {
    const remote = await runGitText(absolutePathOf(repository), ['remote', 'get-url', defaultRemote]).catch(() => '');
    const target = parseRemoteTarget(remote);
    if (!target) return null;
    return { key: `${target.protocol}://${target.host}`, target, name: repository.name };
  });

  const grouped = new Map<string, { target: RemoteTarget; repositories: string[] }>();
  for (const entry of scanned) {
    if (!entry) continue;
    const existing = grouped.get(entry.key);
    if (existing) existing.repositories.push(entry.name);
    else grouped.set(entry.key, { target: entry.target, repositories: [entry.name] });
  }

  const hosts = await Promise.all(
    [...grouped.values()].map(
      async ({ target, repositories: names }): Promise<RemoteCredentialHost> => ({
        host: target.host,
        protocol: target.protocol,
        repositoryCount: names.length,
        repositories: [...names].sort().slice(0, 3),
        hasCredential: target.protocol === 'https' ? await hasStoredCredential(target.host) : null,
      }),
    ),
  );

  hosts.sort(compareCredentialHosts);
  return { hosts, credentialHelper: await readCredentialHelper() };
}
