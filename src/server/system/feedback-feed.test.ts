import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackToken, listFeedback, replyFeedback, submitFeedback } from './feedback-feed.js';

/**
 * 反馈接口的鉴权头。
 *
 * 上游 `c.mooeen.com` 的 `v1/feedback` 挂在 `project.token:feedback,optional` 上：
 * 当前不带 token 也放行，所以这个头缺失**不会报错**，只会等到后台把项目切成强制时
 * 才整片 401——那时代码里已经看不出是哪次改动漏掉的。这些用例守的就是「头在不在」。
 */
const originalBase = process.env.GIT_FLEET_UPDATE_BASE_URL;
const originalHome = process.env.GIT_FLEET_DATA_HOME;
const originalToken = process.env.MOO_FLEET_FEEDBACK_TOKEN;

const TOKEN = 'moo_test_0123456789abcdefghijklmnopqrstuvwxyz';

let dataHome: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function thread(): Record<string, unknown> {
  return {
    id: '1',
    version: '0.2.2',
    platform: 'macos',
    arch: 'arm64',
    status: 'open',
    contact: null,
    createdAt: null,
    lastMessageAt: null,
    messages: [],
  };
}

/** 取某次 fetch 调用的请求头；调用方给的是普通对象，不必过 Headers。 */
function headersOf(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const init = fetcher.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-feedback-'));
  process.env.GIT_FLEET_DATA_HOME = dataHome;
  process.env.GIT_FLEET_UPDATE_BASE_URL = 'https://feedback.test';
  delete process.env.MOO_FLEET_FEEDBACK_TOKEN;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataHome, { recursive: true, force: true });

  for (const [key, value] of [
    ['GIT_FLEET_UPDATE_BASE_URL', originalBase],
    ['GIT_FLEET_DATA_HOME', originalHome],
    ['MOO_FLEET_FEEDBACK_TOKEN', originalToken],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('feedbackToken', () => {
  it('reads the environment variable', () => {
    process.env.MOO_FLEET_FEEDBACK_TOKEN = `  ${TOKEN}  `;
    expect(feedbackToken()).toBe(TOKEN);
  });

  it('is empty when neither source is present', () => {
    // 测试进程里没有 tsup 注入的 __FEEDBACK_TOKEN__，走的正是「未注入」这一支。
    expect(feedbackToken()).toBe('');
  });
});

describe('反馈请求的鉴权头', () => {
  it('三个接口都带 Authorization: Bearer', async () => {
    process.env.MOO_FLEET_FEEDBACK_TOKEN = TOKEN;
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({ feedbacks: [], feedback: thread() }));
    vi.stubGlobal('fetch', fetcher);

    await listFeedback();
    await submitFeedback('0.2.2', '导出后找不到文件');
    await replyFeedback('123456789012345', '已修复');

    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const index of [0, 1, 2]) {
      expect(headersOf(fetcher, index).authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('没有 token 时不发空 Bearer', async () => {
    const fetcher = vi.fn(async () => json({ feedbacks: [] }));
    vi.stubGlobal('fetch', fetcher);

    await listFeedback();

    expect(headersOf(fetcher)).not.toHaveProperty('authorization');
  });
});

describe('上游错误信息', () => {
  it('401 的字符串 error 原样透出', async () => {
    // 上游 ResolveProjectToken 返回的是 `{ ok: false, error: 'token 无效' }`。
    // 早先只按 `error.message` 取，这条会退化成「反馈服务返回 401」。
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: 'token 无效' }, 401)));

    await expect(listFeedback()).rejects.toThrow('token 无效');
  });

  it('对象形式的 error.message 仍然可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: { message: '内容太短' } }, 400)));

    await expect(submitFeedback('0.2.2', 'x')).rejects.toThrow('内容太短');
  });

  it('没有 error 字段时退回状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));

    await expect(listFeedback()).rejects.toThrow('反馈服务返回 503');
  });
});
