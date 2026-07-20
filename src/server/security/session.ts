import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const sessionToken = randomBytes(32).toString('base64url');

function safeTokenMatch(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(sessionToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function registerLocalSessionSecurity(app: FastifyInstance): Promise<void> {
  const port = Number(process.env.GIT_FLEET_PORT ?? 8787);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);

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
