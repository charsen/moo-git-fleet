import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ReleaseCheckResult } from '../../shared/contracts.js';
import { releasesUrl } from '../../shared/app-links.js';

/**
 * 查询云端最新发布版本。
 *
 * 统一走 `GET /api/v1/updates/check`；install_id 存在用户数据目录，
 * 升级/重装后保持稳定。旧的 GitHub `releases/latest` 跳转检查已废弃。
 *
 * 约束：
 * - 失败不抛错，统一落在 `reason` 里；检查更新不该让界面报错。
 * - 不做服务端缓存：结果依赖当前版本/平台/架构/install_id，缓存会串人。
 * - 超时 5 秒；前台小动作，不能挂着等。
 * - 地址可用 `GIT_FLEET_UPDATE_BASE_URL` 覆盖，数据目录可用
 *   `GIT_FLEET_DATA_HOME` 覆盖，方便离线验证。
 */

const REQUEST_TIMEOUT_MS = 5_000;

interface ApiPayload {
  ok?: boolean;
  update_available?: boolean;
  mandatory?: boolean;
  action?: string;
  reason?: string | null;
  latest?: { version?: string; notes?: string | null } | null;
  download?: { url?: string } | null;
  store_url?: string | null;
  error?: { code?: string; message?: string } | null;
}

function dataHome(): string {
  const override = process.env.GIT_FLEET_DATA_HOME?.trim();
  if (override) return override;

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Moo Fleet');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Moo Fleet');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'moo-fleet');
}

/** 匿名安装标识；文件权限 0600，内容只是一个 UUID。 */
async function installId(): Promise<string> {
  const directory = dataHome();
  const file = path.join(directory, 'install-id');

  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // 首次运行或文件被清理：下面生成。
  }

  const value = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  return value;
}

function platform(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

function failure(checkedAt: string, reason: string): ReleaseCheckResult {
  return { latest: null, releaseUrl: releasesUrl, checkedAt, reason };
}

function reasonText(payload: ApiPayload): string {
  if (payload.error?.message) return payload.error.message;

  switch (payload.reason) {
    case 'no_package_for_platform':
      return '当前平台还没有发布包';
    case 'arch_required':
      return '缺少芯片架构信息';
    case 'restricted':
      return '当前版本暂未对你开放';
    default:
      return '检查更新失败';
  }
}

export async function checkLatestRelease(currentVersion: string): Promise<ReleaseCheckResult> {
  const checkedAt = new Date().toISOString();

  let id: string;
  try {
    id = await installId();
  } catch {
    // 数据目录不可写时仍然检查，只是这次换一个临时 ID。
    id = randomUUID();
  }

  let url: URL;
  try {
    url = new URL('/api/v1/updates/check', process.env.GIT_FLEET_UPDATE_BASE_URL ?? 'https://c.mooeen.com');
  } catch {
    return failure(checkedAt, '更新服务地址配置不正确');
  }

  url.search = new URLSearchParams({
    app: 'moo-git-fleet',
    current_version: currentVersion,
    platform: platform(),
    arch: process.arch,
    channel: 'stable',
    install_id: id,
  }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': `moo-fleet/${currentVersion}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return failure(checkedAt, timedOut ? '连接更新服务器超时' : '无法连接更新服务器，请检查网络或代理');
  }

  if (response.status === 404) return failure(checkedAt, '软件还没有在更新服务登记');
  if (response.status === 429) return failure(checkedAt, '检查过于频繁，请稍后再试');
  if (!response.ok) return failure(checkedAt, `更新服务返回 ${response.status}`);

  let payload: ApiPayload;
  try {
    payload = (await response.json()) as ApiPayload;
  } catch {
    return failure(checkedAt, '更新服务返回了无法识别的内容');
  }

  if (!payload || payload.ok !== true) {
    return failure(checkedAt, reasonText(payload ?? {}));
  }

  if (payload.update_available !== true) {
    if (payload.reason === 'no_package_for_platform' || payload.reason === 'arch_required' || payload.reason === 'restricted') {
      return failure(checkedAt, reasonText(payload));
    }

    return {
      latest: payload.latest?.version ?? null,
      releaseUrl: releasesUrl,
      checkedAt,
      reason: null,
    };
  }

  const version = payload.latest?.version;
  const downloadUrl = payload.action === 'open_store' ? payload.store_url : payload.download?.url;

  if (!version || !downloadUrl) {
    return failure(checkedAt, '更新服务没有返回版本或下载地址');
  }

  return { latest: version, releaseUrl: downloadUrl, checkedAt, reason: null };
}
