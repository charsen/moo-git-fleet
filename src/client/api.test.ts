import { beforeEach, describe, expect, it, vi } from 'vitest';

type ApiModule = typeof import('./api.js');

/**
 * `api.ts` 里的会话令牌是模块级缓存，用例之间会互相污染（「只取一次令牌」这种断言
 * 在第二个用例里必然失败）。每个用例都拿一份全新的模块实例。
 */
const loadApi = async (): Promise<ApiModule> => {
  vi.resetModules();
  return import('./api.js');
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * 按调用次序回放的 fetch 替身，同时把每次请求的 url 与 init 记下来 —— 令牌头、
 * content-type、编码后的路径都只能从请求本身看，光断言返回值覆盖不到。
 */
const stubFetch = (respond: (call: FetchCall, index: number) => Response | Promise<Response>): FetchCall[] => {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = { url: String(input), init };
      calls.push(call);
      return respond(call, calls.length - 1);
    }),
  );
  return calls;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const headerOf = (call: FetchCall | undefined, name: string): string | null =>
  new Headers(call?.init?.headers).get(name);

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('failure classification', () => {
  it('never retries a 4xx but allows two retries for server and network failures', async () => {
    const { ApiError, shouldRetryApiQuery } = await loadApi();

    expect(shouldRetryApiQuery(0, new ApiError(404, '没有这个仓库'))).toBe(false);
    expect(shouldRetryApiQuery(0, new ApiError(403, '令牌过期'))).toBe(false);
    // 499 也要按 client error 处理，别把「参数不对」当成临时故障反复重放。
    expect(shouldRetryApiQuery(0, new ApiError(499, '客户端断开'))).toBe(false);

    expect(shouldRetryApiQuery(0, new ApiError(500, '内部错误'))).toBe(true);
    expect(shouldRetryApiQuery(1, new ApiError(500, '内部错误'))).toBe(true);
    expect(shouldRetryApiQuery(2, new ApiError(500, '内部错误'))).toBe(false);

    // fetch 直接抛 TypeError 时压根没有状态码，属于「大概率能自愈」，跟 5xx 同等对待。
    expect(shouldRetryApiQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryApiQuery(2, new TypeError('Failed to fetch'))).toBe(false);
  });

  it('keeps the status and machine-readable code on the error object', async () => {
    const { ApiError } = await loadApi();
    const error = new ApiError(409, '密钥库版本过旧', 'legacy-vault');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(409);
    expect(error.code).toBe('legacy-vault');
    expect(error.message).toBe('密钥库版本过旧');
  });
});

describe('request plumbing', () => {
  it('仓库范围使用 JSON 编码，并保留空选择与全部的区别', async () => {
    const { api } = await loadApi();
    const calls = stubFetch(() => json({}));
    await api.commitHeatmap(26, ['repo,alpha', 'repo&beta']);
    await api.commitHeatmap(26, []);
    await api.commitHeatmap(26);
    const queries = calls.map((call) => new URL(call.url, 'http://127.0.0.1').searchParams);
    expect(JSON.parse(queries[0].get('repositoryIds')!)).toEqual(['repo,alpha', 'repo&beta']);
    expect(queries[1].get('repositoryIds')).toBe('[]');
    expect(queries[2].has('repositoryIds')).toBe(false);
    expect(queries.every((query) => query.get('weeks') === '26')).toBe(true);
  });

  it('does not establish a session for read-only requests', async () => {
    const { api } = await loadApi();
    const calls = stubFetch(() => json({ repositories: [] }));

    await api.dashboard();

    expect(calls.map((call) => call.url)).toEqual(['/api/dashboard']);
    expect(headerOf(calls[0], 'x-git-fleet-token')).toBeNull();
  });

  it('establishes the session once and reuses the token for every later write', async () => {
    const { api } = await loadApi();
    const calls = stubFetch((call) => (call.url === '/api/session' ? json({ token: 'tok-1' }) : json({})));

    await api.saveTheme('mooeen');
    await api.refresh();

    expect(calls.map((call) => call.url)).toEqual([
      '/api/session',
      '/api/settings/theme',
      '/api/repositories/refresh',
    ]);
    expect(headerOf(calls[1], 'x-git-fleet-token')).toBe('tok-1');
    expect(headerOf(calls[2], 'x-git-fleet-token')).toBe('tok-1');
  });

  it('declares JSON only when there is a body to send', async () => {
    const { api } = await loadApi();
    const calls = stubFetch((call) => (call.url === '/api/session' ? json({ token: 't' }) : json({})));

    // POST 但没有请求体（fetch / push / continue 这类空动作）不该声明 content-type。
    await api.fetchRepository('repo-1');
    await api.saveTheme('mooeen');

    expect(headerOf(calls[1], 'content-type')).toBeNull();
    expect(headerOf(calls[2], 'content-type')).toBe('application/json');
  });

  it('refreshes an expired token and retries the write exactly once', async () => {
    const { api } = await loadApi();
    let issued = 0;
    const calls = stubFetch((call) => {
      if (call.url === '/api/session') {
        issued += 1;
        return json({ token: `tok-${issued}` });
      }
      // 只有第一个令牌被拒，换到 tok-2 之后放行。
      if (issued === 1) return json({ error: '令牌已过期' }, 403);
      return json({ theme: 'mooeen' });
    });

    await expect(api.saveTheme('mooeen')).resolves.toEqual({ theme: 'mooeen' });

    expect(issued).toBe(2);
    expect(calls.at(-1)?.url).toBe('/api/settings/theme');
    expect(headerOf(calls.at(-1), 'x-git-fleet-token')).toBe('tok-2');
  });

  it('gives up after a single retry instead of looping on a rejected token', async () => {
    const { api, ApiError } = await loadApi();
    let issued = 0;
    const calls = stubFetch((call) => {
      if (call.url === '/api/session') {
        issued += 1;
        return json({ token: `tok-${issued}` });
      }
      return json({ error: '令牌无效' }, 403);
    });

    await expect(api.saveTheme('mooeen')).rejects.toBeInstanceOf(ApiError);

    expect(issued).toBe(2);
    expect(calls.filter((call) => call.url === '/api/settings/theme')).toHaveLength(2);
  });

  it('refuses to send a write without a session instead of proceeding unauthenticated', async () => {
    const { api } = await loadApi();
    stubFetch(() => json({}, 401));

    await expect(api.saveTheme('mooeen')).rejects.toThrow('无法建立本地会话');
  });

  it('returns the parsed body untouched on success', async () => {
    const { api } = await loadApi();
    stubFetch(() => json({ configured: true }));

    await expect(api.saveDeepSeekApiKey('sk-test')).resolves.toEqual({ configured: true });
  });
});

describe('error translation', () => {
  it('surfaces the server message and code instead of a generic status line', async () => {
    const { api, ApiError } = await loadApi();
    stubFetch(() => json({ error: '仓库目录不存在', code: 'missing-repository' }, 404));

    const error = await api.dashboard().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: '仓库目录不存在', code: 'missing-repository' });
  });

  it('falls back to a readable message when the error body is not JSON', async () => {
    // 反向代理挂了的时候返回的是 HTML，`response.json()` 会抛；不能把
    // “Unexpected token < in JSON” 这种解析错误丢给用户看。
    const { api } = await loadApi();
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    await expect(api.dashboard()).rejects.toMatchObject({
      status: 502,
      message: '本地服务返回异常（502），请稍后重试',
    });
  });

  it('translates a dead local service into an actionable message', async () => {
    const { api } = await loadApi();
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    await expect(api.dashboard()).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('连不上 Moo Fleet 本地服务'),
    });
  });
});

describe('URL construction', () => {
  it('encodes path segments so a slash inside an id cannot rewrite the route', async () => {
    const { api } = await loadApi();
    const calls = stubFetch(() => json({}));

    await api.commitDetail('a/b', 'x/y');

    expect(calls[0]?.url).toBe('/api/repositories/a%2Fb/commits/x%2Fy');
  });

  it('keeps explicit zeroes in commit queries and drops undefined options', async () => {
    const { api } = await loadApi();
    const calls = stubFetch(() => json({}));

    // skip: 0 是有效值（第一页），不能当成 falsy 丢掉；undefined 则不该出现在 URL 里。
    await api.repositoryCommits('repo', { skip: 0, limit: 50, search: undefined });

    expect(calls[0]?.url).toBe('/api/repositories/repo/commits?skip=0&limit=50');
  });

  it('encodes query values that contain separators', async () => {
    const { api } = await loadApi();
    const calls = stubFetch(() => json({}));

    // DELETE 会先建会话，真正带查询参数的是最后一次请求。
    await api.removeRemoteCredential('git.example.com/team repo');

    expect(calls.at(-1)?.url).toBe('/api/credentials?host=git.example.com%2Fteam%20repo');
  });

  it('keeps the query behind the path when a file path is present', async () => {
    const { api } = await loadApi();
    const calls = stubFetch(() => json({}));

    await api.commitDetail('repo', 'abc123', 'src/a b.ts');

    expect(calls[0]?.url).toBe('/api/repositories/repo/commits/abc123?filePath=src%2Fa+b.ts');
  });
});
