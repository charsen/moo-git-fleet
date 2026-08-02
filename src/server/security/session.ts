import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const sessionToken = randomBytes(32).toString('base64url');

function safeTokenMatch(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(sessionToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * 补充放行的 origin 只能是本机的 http 地址（带明确端口）。
 * 这条口径不能松：`GIT_FLEET_DEV_ORIGIN` 绝不该变成"任意站点都能打本机 API"的口子。
 */
const localOriginPattern = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * 允许的页面来源。默认是 vite 的 5173 和 API 自身端口；
 * 本机调试时 5173 常被别的项目占走，vite 会落到别的端口（如 5199），那时浏览器发起的
 * 每个 POST 都会被 Origin 检查 403 拦下——用 `GIT_FLEET_DEV_ORIGIN` 逗号分隔补进来即可。
 * 不合本机 http 签名的值一律忽略，不设这个变量时行为和以前完全一样。
 */
export function resolveAllowedOrigins(
  port: number,
  environment: Partial<Pick<NodeJS.ProcessEnv, 'GIT_FLEET_DEV_ORIGIN'>> = process.env,
): Set<string> {
  const allowed = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  for (const entry of (environment.GIT_FLEET_DEV_ORIGIN ?? '').split(',')) {
    const origin = entry.trim();
    if (localOriginPattern.test(origin)) allowed.add(origin);
  }
  return allowed;
}

export async function registerLocalSessionSecurity(app: FastifyInstance): Promise<void> {
  const port = Number(process.env.GIT_FLEET_PORT ?? 8787);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = resolveAllowedOrigins(port);

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host || !allowedHosts.has(host)) {
      reply.status(403).send({ error: 'Host 不在本地允许列表中' });
      return reply;
    }

    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      reply.status(403).send({ error: 'Origin 不在本地允许列表中' });
      return reply;
    }

    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || request.url === '/api/session') return;
    const header = request.headers['x-git-fleet-token'];
    const candidate = Array.isArray(header) ? header[0] : header;
    if (!safeTokenMatch(candidate)) {
      reply.status(403).send({ error: '本地会话已失效，请刷新页面' });
      return reply;
    }
  });

  app.get('/api/session', async () => ({ token: sessionToken }));
}
