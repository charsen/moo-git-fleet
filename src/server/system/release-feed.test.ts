import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLatestRelease, resetReleaseCheckCache, tagFromRedirect } from './release-feed.js';

const originalUrl = process.env.GIT_FLEET_RELEASE_LATEST_URL;

function redirect(location: string | null, status = 302): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}

describe('tagFromRedirect', () => {
  it('reads the tag out of the release location', () => {
    expect(tagFromRedirect('https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.35')).toBe('0.1.35');
    expect(tagFromRedirect('/charsen/moo-git-fleet/releases/tag/0.2.0')).toBe('0.2.0');
  });

  it('ignores anything that is not a tag page', () => {
    expect(tagFromRedirect('https://github.com/charsen/moo-git-fleet/releases')).toBeNull();
    expect(tagFromRedirect(null)).toBeNull();
  });
});

describe('checkLatestRelease', () => {
  beforeEach(() => {
    resetReleaseCheckCache();
    process.env.GIT_FLEET_RELEASE_LATEST_URL = 'http://127.0.0.1:1/releases/latest';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.GIT_FLEET_RELEASE_LATEST_URL;
    else process.env.GIT_FLEET_RELEASE_LATEST_URL = originalUrl;
    resetReleaseCheckCache();
  });

  it('reports the latest tag from the redirect without the v prefix', async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => redirect('https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.36'));
    vi.stubGlobal('fetch', fetcher);

    const result = await checkLatestRelease();
    expect(result.latest).toBe('0.1.36');
    expect(result.releaseUrl).toBe('https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.36');
    expect(result.reason).toBeNull();
    // 必须手动接管跳转，否则跟到 tag 页面就只剩 HTML 了。
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('keeps a failure reason instead of pretending there is no new version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));

    const result = await checkLatestRelease();
    expect(result.latest).toBeNull();
    expect(result.reason).toContain('还没有发布记录');
  });

  it('turns a rejected request into a readable reason', async () => {
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort; }));

    expect((await checkLatestRelease()).reason).toBe('连接 GitHub 超时');
  });

  it('does not cache failures, so a retry can succeed', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await checkLatestRelease()).reason).toContain('限流');

    fetcher.mockImplementationOnce(async () => redirect('https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.36'));
    expect((await checkLatestRelease()).latest).toBe('0.1.36');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('serves a cached success without hitting the network again', async () => {
    const fetcher = vi.fn(async () => redirect('https://github.com/charsen/moo-git-fleet/releases/tag/v0.1.36'));
    vi.stubGlobal('fetch', fetcher);

    await checkLatestRelease();
    await checkLatestRelease();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
