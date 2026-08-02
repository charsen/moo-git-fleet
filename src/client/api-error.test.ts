import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, shouldRetryApiQuery } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client API error contract', () => {
  it('preserves HTTP status and the safe server message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Synthetic backup binding is invalid' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    await expect(api.sessionBackupStatus()).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Synthetic backup binding is invalid',
    });
  });

  it('carries the machine-readable error code through to callers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: '这是旧版 Moo Fleet 的会话备份仓（检测到 vault.yaml）。', code: 'legacy-vault' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    await expect(api.sessionBackupStatus()).rejects.toMatchObject({ status: 409, code: 'legacy-vault' });
  });

  it('leaves the code undefined when the server does not send one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Synthetic conflict' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    await expect(api.sessionBackupStatus()).rejects.toMatchObject({ status: 409, code: undefined });
  });

  it('turns a dead local backend into an actionable Chinese message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(api.sessionBackupStatus()).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      message: '连不上 Moo Fleet 本地服务；请确认应用正在运行，然后重试',
    });
  });

  it('does not retry deterministic 4xx responses and bounds transient retries', () => {
    expect(shouldRetryApiQuery(0, new ApiError(409, 'Synthetic conflict'))).toBe(false);
    expect(shouldRetryApiQuery(0, new ApiError(500, 'Synthetic server failure'))).toBe(true);
    expect(shouldRetryApiQuery(1, new Error('Synthetic network failure'))).toBe(true);
    expect(shouldRetryApiQuery(2, new Error('Synthetic network failure'))).toBe(false);
  });
});
