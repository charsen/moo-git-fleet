import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let temporaryHome = '';

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
  temporaryHome = '';
});

describe('server shutdown', () => {
  it('closes every active event stream before waiting for HTTP connections', async () => {
    temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-app-shutdown-'));
    vi.stubEnv('GIT_FLEET_HOME', temporaryHome);
    vi.stubEnv('GIT_FLEET_PORT', '0');
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口');
    const responses = await Promise.all(
      ['/api/operations/events', '/api/session-checkpoint-jobs/events'].map(
        (eventPath) =>
          new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
            const request = get(
              {
                host: '127.0.0.1',
                port: address.port,
                path: eventPath,
                headers: { host: '127.0.0.1:0' },
              },
              (incoming) => {
                incoming.once('data', () => resolve(incoming));
              },
            );
            request.once('error', reject);
          }),
      ),
    );

    const streamsClosed = Promise.all(responses.map((response) => new Promise<void>((resolve) => response.once('close', resolve))));
    const startedAt = Date.now();
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('关闭 SSE 服务超时')), 1_000)),
    ]);
    await Promise.race([
      streamsClosed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE 连接未全部关闭')), 1_000)),
    ]);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
