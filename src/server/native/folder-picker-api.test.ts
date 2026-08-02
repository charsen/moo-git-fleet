import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 绝不能在测试里真的弹系统对话框：路由测的是 pickFolder 的返回怎么变成 HTTP 结果。
const { pickFolderMock } = vi.hoisted(() => ({ pickFolderMock: vi.fn() }));
vi.mock('./folder-picker.js', () => ({ pickFolder: pickFolderMock }));

const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

async function jsonRequest<T>(
  app: FastifyInstance,
  options: Omit<InjectOptions, 'headers' | 'payload'> & { payload?: unknown },
  token?: string,
): Promise<{ statusCode: number; body: T }> {
  const response = await app.inject({
    ...options,
    headers: {
      ...hostHeaders,
      ...(token ? { 'x-git-fleet-token': token } : {}),
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: options.payload === undefined ? undefined : JSON.stringify(options.payload),
  });
  return { statusCode: response.statusCode, body: response.json<T>() };
}

async function buildTestApp(): Promise<{ app: FastifyInstance; token: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-folder-picker-'));
  temporaryDirectories.push(home);
  vi.stubEnv('GIT_FLEET_HOME', home);
  vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
  vi.stubEnv('GIT_FLEET_PORT', '8787');
  vi.resetModules();
  const { buildApp } = await import('../app.js');
  const app = await buildApp();
  const session = await jsonRequest<{ token: string }>(app, { method: 'GET', url: '/api/session' });
  return { app, token: session.body.token };
}

beforeEach(() => {
  pickFolderMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('POST /api/native/pick-folder', () => {
  it('用户取消时返回 { path: null }，并带上默认提示语', async () => {
    pickFolderMock.mockResolvedValue(null);
    const { app, token } = await buildTestApp();

    try {
      const response = await jsonRequest<{ path: string | null }>(
        app,
        { method: 'POST', url: '/api/native/pick-folder', payload: {} },
        token,
      );

      expect(response).toEqual({ statusCode: 200, body: { path: null } });
      expect(pickFolderMock).toHaveBeenCalledWith('选择会话备份文件夹');
    } finally {
      await app.close();
    }
  });

  it('选中的路径原样回传，自定义提示语透传给选择器', async () => {
    pickFolderMock.mockResolvedValue('/Users/me/ai-sessions');
    const { app, token } = await buildTestApp();

    try {
      const response = await jsonRequest<{ path: string | null }>(
        app,
        { method: 'POST', url: '/api/native/pick-folder', payload: { prompt: '选一个备份仓' } },
        token,
      );

      expect(response).toEqual({ statusCode: 200, body: { path: '/Users/me/ai-sessions' } });
      expect(pickFolderMock).toHaveBeenCalledWith('选一个备份仓');
    } finally {
      await app.close();
    }
  });

  it('并发的第二个请求被拒成 409，非 macOS 报 400，写操作仍然要带 token', async () => {
    const { app, token } = await buildTestApp();

    try {
      pickFolderMock.mockRejectedValue(
        Object.assign(new Error('已有一个选择窗口打开，请先在系统对话框里选择或取消'), { statusCode: 409 }),
      );
      const busy = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/native/pick-folder', payload: {} },
        token,
      );
      expect(busy.statusCode).toBe(409);
      expect(busy.body.error).toContain('已有一个选择窗口打开');

      pickFolderMock.mockRejectedValue(
        Object.assign(new Error('系统文件夹选择器只在 macOS 上可用；请直接把文件夹的绝对路径粘贴到输入框里'), {
          statusCode: 400,
        }),
      );
      const unsupported = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/native/pick-folder', payload: {} },
        token,
      );
      expect(unsupported.statusCode).toBe(400);
      expect(unsupported.body.error).toContain('只在 macOS 上可用');

      const unauthorized = await jsonRequest<{ error: string }>(app, {
        method: 'POST',
        url: '/api/native/pick-folder',
        payload: {},
      });
      expect(unauthorized.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
