import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLocalSessionSecurity, resolveAllowedOrigins } from './session.js';

/**
 * `resolveAllowedOrigins` 的 env 靠参数注入（和 app.ts 的 `resolveClientRoot` 一个路子），
 * 单测不用碰全局；端到端那条要走真实的 onRequest 钩子，那里读的是 `process.env`，
 * 但读取发生在 `registerLocalSessionSecurity` 调用时而不是模块加载时，所以 `vi.stubEnv` 就够了，
 * 不需要 `vi.resetModules()`。
 */

/** 起一个只装了本地会话守卫的应用，请求带上指定 Origin 打一次 `/api/session`。 */
async function requestWithOrigin(origin: string): Promise<number> {
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  const app = Fastify({ logger: false });
  await registerLocalSessionSecurity(app);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { host: '127.0.0.1:8787', origin },
    });
    return response.statusCode;
  } finally {
    await app.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveAllowedOrigins', () => {
  it('不设变量时和以前完全一样：只有 5173 和 API 自身端口', () => {
    expect([...resolveAllowedOrigins(8787, {})].sort()).toEqual([
      'http://127.0.0.1:5173',
      'http://127.0.0.1:8787',
      'http://localhost:5173',
      'http://localhost:8787',
    ]);
  });

  it('GIT_FLEET_DEV_ORIGIN 逗号分隔，两侧空白照样认', () => {
    const allowed = resolveAllowedOrigins(8787, {
      GIT_FLEET_DEV_ORIGIN: ' http://127.0.0.1:5199 , http://localhost:5199 ',
    });

    expect(allowed.has('http://127.0.0.1:5199')).toBe(true);
    expect(allowed.has('http://localhost:5199')).toBe(true);
    expect(allowed.has('http://127.0.0.1:5173')).toBe(true);
  });

  it('只信本机 http 地址，别的值一概忽略', () => {
    const allowed = resolveAllowedOrigins(8787, {
      GIT_FLEET_DEV_ORIGIN: [
        'https://evil.com',
        'http://evil.com:5199',
        'https://127.0.0.1:5199',
        'http://127.0.0.1.evil.com:5199',
        'http://127.0.0.1:5199/evil',
        'http://localhost',
        '',
      ].join(','),
    });

    expect([...allowed].sort()).toEqual([
      'http://127.0.0.1:5173',
      'http://127.0.0.1:8787',
      'http://localhost:5173',
      'http://localhost:8787',
    ]);
  });
});

describe('Origin 守卫', () => {
  it('不设变量时 5199 仍被拦下', async () => {
    expect(await requestWithOrigin('http://127.0.0.1:5199')).toBe(403);
  });

  it('设了合法值之后放行那个端口', async () => {
    vi.stubEnv('GIT_FLEET_DEV_ORIGIN', 'http://127.0.0.1:5199,http://localhost:5199');

    expect(await requestWithOrigin('http://127.0.0.1:5199')).toBe(200);
    expect(await requestWithOrigin('http://localhost:5199')).toBe(200);
    expect(await requestWithOrigin('http://127.0.0.1:5173')).toBe(200);
  });

  it('设了非法值仍然拦截，不会因为变量存在就放松', async () => {
    vi.stubEnv('GIT_FLEET_DEV_ORIGIN', 'https://evil.com');

    expect(await requestWithOrigin('https://evil.com')).toBe(403);
    expect(await requestWithOrigin('http://127.0.0.1:5199')).toBe(403);
    expect(await requestWithOrigin('http://127.0.0.1:5173')).toBe(200);
  });
});
