import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let home: string;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) await rm(home, { recursive: true, force: true });
});

it('persists appearance through the protected preferences API and keeps the rest of the profile', async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'fleet-appearance-'));
  vi.stubEnv('GIT_FLEET_HOME', home);
  vi.stubEnv('GIT_FLEET_CLAUDE_HOME', path.join(home, 'claude'));
  vi.stubEnv('GIT_FLEET_CODEX_HOME', path.join(home, 'codex'));
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  vi.resetModules();
  app = await (await import('./app.js')).buildApp();
  const headers = { host: '127.0.0.1:8787' };
  const original = (await app.inject({ url: '/api/settings/profile', headers })).json();
  const preferences = { ...original.profile.viewPreferences, interfaceFont: 'heiti', interfaceFontSize: 16 };
  expect((await app.inject({ method: 'PATCH', url: '/api/settings/view-preferences', headers, payload: preferences })).statusCode).toBe(403);
  const token = (await app.inject({ url: '/api/session', headers })).json().token;
  const writeHeaders = { ...headers, 'x-git-fleet-token': token };
  const saved = await app.inject({ method: 'PATCH', url: '/api/settings/view-preferences', headers: writeHeaders, payload: preferences });
  expect(saved.statusCode).toBe(200);
  const reloaded = (await app.inject({ url: '/api/settings/profile', headers })).json();
  expect(reloaded.profile).toEqual({ ...original.profile, viewPreferences: preferences });
  expect((await app.inject({ method: 'PATCH', url: '/api/settings/view-preferences', headers: writeHeaders, payload: { ...preferences, interfaceFontSize: 30 } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/settings/profile', headers })).json()).toEqual(reloaded);
});
