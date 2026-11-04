import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLatestRelease } from './release-feed.js';

const originalBase = process.env.GIT_FLEET_UPDATE_BASE_URL;
const originalHome = process.env.GIT_FLEET_DATA_HOME;

let dataHome: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function availablePayload(): Record<string, unknown> {
  return {
    ok: true,
    update_available: true,
    mandatory: false,
    action: 'download',
    latest: { version: '0.2.1', notes: '修复若干问题' },
    download: { url: 'https://cdn.test/moo-fleet-0.2.1.dmg' },
    reason: null,
  };
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-update-'));
  process.env.GIT_FLEET_DATA_HOME = dataHome;
  process.env.GIT_FLEET_UPDATE_BASE_URL = 'https://updates.test';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataHome, { recursive: true, force: true });

  if (originalBase === undefined) delete process.env.GIT_FLEET_UPDATE_BASE_URL;
  else process.env.GIT_FLEET_UPDATE_BASE_URL = originalBase;

  if (originalHome === undefined) delete process.env.GIT_FLEET_DATA_HOME;
  else process.env.GIT_FLEET_DATA_HOME = originalHome;
});

describe('checkLatestRelease', () => {
  it('maps an available update and sends install identity', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json(availablePayload()));
    vi.stubGlobal('fetch', fetcher);

    const result = await checkLatestRelease('0.2.0');

    expect(result.latest).toBe('0.2.1');
    expect(result.releaseUrl).toBe('https://cdn.test/moo-fleet-0.2.1.dmg');
    expect(result.reason).toBeNull();

    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.pathname).toBe('/api/v1/updates/check');
    expect(request.searchParams.get('app')).toBe('moo-git-fleet');
    expect(request.searchParams.get('current_version')).toBe('0.2.0');
    expect(request.searchParams.get('channel')).toBe('stable');

    const stored = (await readFile(path.join(dataHome, 'install-id'), 'utf8')).trim();
    expect(stored).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.searchParams.get('install_id')).toBe(stored);
  });

  it('keeps the same install id across checks', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json(availablePayload()));
    vi.stubGlobal('fetch', fetcher);

    await checkLatestRelease('0.2.0');
    await checkLatestRelease('0.2.0');

    const ids = fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('install_id'));
    expect(ids[0]).toBe(ids[1]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports up to date without a failure reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ok: true,
      update_available: false,
      latest: { version: '0.2.0' },
      reason: null,
    })));

    const result = await checkLatestRelease('0.2.0');

    expect(result.latest).toBe('0.2.0');
    expect(result.reason).toBeNull();
  });

  it('does not pretend restricted versions are up to date', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ok: true,
      update_available: false,
      reason: 'restricted',
    })));

    const result = await checkLatestRelease('0.2.0');

    expect(result.latest).toBeNull();
    expect(result.reason).toContain('暂未');
  });

  it('turns an unknown app into a readable reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: { message: '软件不存在' } }, 404)));

    const result = await checkLatestRelease('0.2.0');

    expect(result.latest).toBeNull();
    expect(result.reason).toContain('还没有在更新服务登记');
  });

  it('turns a timeout into a readable reason', async () => {
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort; }));

    expect((await checkLatestRelease('0.2.0')).reason).toContain('超时');
  });

  it('does not expose a version without a download address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ok: true,
      update_available: true,
      action: 'download',
      latest: { version: '0.2.1' },
      download: null,
    })));

    const result = await checkLatestRelease('0.2.0');

    expect(result.latest).toBeNull();
    expect(result.reason).toContain('下载地址');
  });
});
