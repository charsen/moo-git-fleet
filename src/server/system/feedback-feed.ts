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
  error?: { message?: string };
}

function baseUrl(): string {
  return process.env.GIT_FLEET_UPDATE_BASE_URL ?? 'https://c.mooeen.com';
}

function platform(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, baseUrl()), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'moo-fleet/feedback',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok || (payload as { ok?: boolean }).ok === false) {
    throw new Error(payload.error?.message ?? `反馈服务返回 ${response.status}`);
  }
  return payload;
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
