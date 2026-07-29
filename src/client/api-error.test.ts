import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, shouldRetryApiQuery } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client API error contract', () => {
  it('preserves HTTP status and the safe server message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Synthetic Vault binding is invalid' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    await expect(api.sessionVaultStatus()).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Synthetic Vault binding is invalid',
    });
  });

  it('does not retry deterministic 4xx responses and bounds transient retries', () => {
    expect(shouldRetryApiQuery(0, new ApiError(409, 'Synthetic conflict'))).toBe(false);
    expect(shouldRetryApiQuery(0, new ApiError(500, 'Synthetic server failure'))).toBe(true);
    expect(shouldRetryApiQuery(1, new Error('Synthetic network failure'))).toBe(true);
    expect(shouldRetryApiQuery(2, new Error('Synthetic network failure'))).toBe(false);
  });
});
