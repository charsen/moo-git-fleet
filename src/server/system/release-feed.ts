import type { ReleaseCheckResult } from '../../shared/contracts.js';
import { latestReleaseUrl, releasesUrl } from '../../shared/app-links.js';

/**
 * 查询上游最新发布版本。
 *
 * 取版本号的路径是 **GitHub 的 `releases/latest` 页面跳转**，不是 api.github.com：
 * 官方 API 对匿名请求按 IP 限流 60 次/小时，实测本机连第一次都会 403；而
 * HTML 跳转不需要认证、不占配额，`location` 末尾就是 tag（`/releases/tag/v0.1.35`）。
 *
 * 其余几条约束：
 * - **失败不抛错**，统一落在 `reason` 里。检查更新是顶栏上的可选能力，断网、限流、
 *   上游还没发版都不该让界面报错，更不该被说成「已是最新」。
 * - **只缓存成功结果**。失败若被缓存住，用户修好网络再点还是同一句原因。
 * - 超时 4 秒：这是前台小动作，不能挂着转圈等 GitHub。
 *
 * 地址可用 `GIT_FLEET_RELEASE_LATEST_URL` 覆盖，方便离线验证。
 */

const REQUEST_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 5 * 60_000;

let cached: { at: number; result: ReleaseCheckResult } | null = null;

function latestUrl(): string {
  return process.env.GIT_FLEET_RELEASE_LATEST_URL ?? latestReleaseUrl;
}

function failure(checkedAt: string, reason: string): ReleaseCheckResult {
  return { latest: null, releaseUrl: releasesUrl, checkedAt, reason };
}

/** 从跳转地址里取 tag：`…/releases/tag/v0.1.35` → `0.1.35`。 */
export function tagFromRedirect(location: string | null): string | null {
  if (!location) return null;
  const match = /\/releases\/tag\/([^/?#]+)\/?$/.exec(location);
  return match?.[1] ? decodeURIComponent(match[1]).replace(/^v/i, '') : null;
}

export async function checkLatestRelease(): Promise<ReleaseCheckResult> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.result;
  const checkedAt = new Date(now).toISOString();

  let response: Response;
  try {
    response = await fetch(latestUrl(), {
      // 手动接管跳转：跟到 tag 页面就只剩一页 HTML，拿不到版本号了。
      redirect: 'manual',
      headers: { 'user-agent': 'moo-fleet-update-check' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // 超时与 DNS/连接失败在这里是同一类：用户只需要知道「没连上」。
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return failure(checkedAt, timedOut ? '连接 GitHub 超时' : '无法连接 GitHub，请检查网络或代理');
  }

  if (response.status === 404) return failure(checkedAt, '上游还没有发布记录');
  if (response.status === 403 || response.status === 429) {
    return failure(checkedAt, 'GitHub 请求被限流，请稍后再试');
  }

  const tag = tagFromRedirect(response.headers.get('location'));
  if (!tag) {
    return failure(checkedAt, response.ok ? '上游还没有发布记录' : `GitHub 返回 ${response.status}`);
  }

  cached = { at: now, result: { latest: tag, releaseUrl: `${releasesUrl}/tag/v${tag}`, checkedAt, reason: null } };
  return cached.result;
}

/** 测试用：清掉进程内缓存，避免用例之间互相喂养。 */
export function resetReleaseCheckCache(): void {
  cached = null;
}
