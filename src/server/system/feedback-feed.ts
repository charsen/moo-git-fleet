import { installId } from './release-feed.js';

const REQUEST_TIMEOUT_MS = 8_000;

export interface FeedbackMessage {
  id: string;
  role: 'user' | 'admin';
  body: string;
  createdAt: string | null;
}

export interface FeedbackThread {
  id: string;
  version: string;
  platform: string;
  arch: string | null;
  status: string;
  contact: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  messages: FeedbackMessage[];
}

interface ApiError {
  /**
   * 上游两种形状都出现过：401/403 回**字符串**（`{ ok: false, error: 'token 无效' }`），
   * 其余业务错误回对象（`{ error: { message } }`）。只按对象取会让所有鉴权失败都退化成
   * 「反馈服务返回 401」——接入 Token 之后那正是最常撞的一条。
   */
  error?: string | { message?: string };
}

function baseUrl(): string {
  return process.env.GIT_FLEET_UPDATE_BASE_URL ?? 'https://c.mooeen.com';
}

/**
 * 反馈服务的项目 Token。
 *
 * 两条来源，先到先得：
 * 1. `MOO_FLEET_FEEDBACK_TOKEN`——dev / `npm start` / 临时排查用；构建脚本也经它传值。
 * 2. `__FEEDBACK_TOKEN__`——tsup 打包时 `define` 写进 bundle，安装包里只有这条。
 *
 * 都没有时返回空串：上游 `project.token:feedback,optional` 会放行，功能照常可用。
 * 一旦后台把项目的 `feedback_token_required` 打开，不带就是 401——所以发版构建必须带。
 */
export function feedbackToken(): string {
  const fromEnv = process.env.MOO_FLEET_FEEDBACK_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  // `typeof` 而不是直接引用：未定义时前者只是 'undefined'，后者会抛 ReferenceError。
  return typeof __FEEDBACK_TOKEN__ === 'string' ? __FEEDBACK_TOKEN__.trim() : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = feedbackToken();
  const response = await fetch(new URL(path, baseUrl()), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'moo-fleet/feedback',
      // 用 Authorization 而不是 body 里的 `token` 字段：上游三种读法都支持，
      // 但 body / URL 里的东西会进访问日志，Bearer 头不会。
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok || (payload as { ok?: boolean }).ok === false) {
    const failure = typeof payload.error === 'string' ? payload.error : payload.error?.message;
    throw new Error(failure || `反馈服务返回 ${response.status}`);
  }
  return payload;
}

function platform(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

function identity(): Promise<string> {
  return installId();
}

export async function listFeedback(): Promise<FeedbackThread[]> {
  const id = await identity();
  const query = new URLSearchParams({
    app: 'moo-git-fleet',
    device_id: id,
    install_id: id,
  });
  const payload = await request<{ feedbacks: FeedbackThread[] }>(`/api/v1/feedback?${query.toString()}`);
  return payload.feedbacks ?? [];
}

export async function submitFeedback(version: string, content: string): Promise<FeedbackThread> {
  const id = await identity();
  const payload = await request<{ feedback: FeedbackThread }>('/api/v1/feedback', {
    method: 'POST',
    body: JSON.stringify({
      app: 'moo-git-fleet',
      version,
      platform: platform(),
      arch: process.arch,
      device_id: id,
      install_id: id,
      content,
    }),
  });
  return payload.feedback;
}

export async function replyFeedback(feedbackId: string, content: string): Promise<FeedbackThread> {
  const id = await identity();
  const payload = await request<{ feedback: FeedbackThread }>(`/api/v1/feedback/${encodeURIComponent(feedbackId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      app: 'moo-git-fleet',
      device_id: id,
      install_id: id,
      content,
    }),
  });
  return payload.feedback;
}
