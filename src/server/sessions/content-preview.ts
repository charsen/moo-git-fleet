import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  sessionContentPreviewSchema,
  type SessionContentPreview,
  type SessionContentPreviewItem,
} from '../../shared/sessions.js';
import { redactSensitiveText } from './secrets.js';

const defaultMaxItems = 8;
const maxTextLength = 2_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function nested(value: unknown, key: string): JsonRecord | null {
  return record(record(value)?.[key]);
}

function roleOf(value: unknown): SessionContentPreviewItem['role'] | null {
  const root = record(value);
  const message = nested(value, 'message');
  const payload = nested(value, 'payload');
  const candidates = [
    root?.role,
    root?.type,
    message?.role,
    message?.type,
    payload?.role,
    payload?.type,
  ].filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase());
  if (candidates.some((item) => ['user', 'human', 'user_message', 'input'].includes(item))) return 'user';
  if (candidates.some((item) => ['assistant', 'agent', 'agent_message', 'output'].includes(item))) return 'assistant';
  return null;
}

function textParts(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textParts(item, depth + 1));
  const item = record(value);
  if (!item) return [];
  const kind = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  if (['tool_result', 'tool_use', 'function_call', 'function_call_output', 'reasoning'].includes(kind)) return [];
  const parts: string[] = [];
  for (const key of ['text', 'input_text', 'output_text']) {
    if (typeof item[key] === 'string') parts.push(item[key]);
  }
  if (parts.length > 0) return parts;
  for (const key of ['content', 'message']) {
    if (item[key] !== undefined) parts.push(...textParts(item[key], depth + 1));
  }
  return parts;
}

function messageText(value: unknown): { text: string; truncated: boolean } | null {
  const root = record(value);
  const message = nested(value, 'message');
  const payload = nested(value, 'payload');
  const candidates = [
    message?.content,
    payload?.content,
    root?.content,
    payload?.message,
    root?.message,
    payload?.text,
    root?.text,
  ];
  for (const candidate of candidates) {
    const raw = textParts(candidate).join('\n').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const redacted = redactSensitiveText(raw);
    return {
      text: redacted.slice(0, maxTextLength),
      truncated: redacted.length > maxTextLength,
    };
  }
  return null;
}

function occurredAt(value: unknown): string | null {
  const root = record(value);
  const payload = nested(value, 'payload');
  for (const candidate of [root?.timestamp, root?.created_at, root?.createdAt, payload?.timestamp]) {
    if (typeof candidate !== 'string') continue;
    const timestamp = new Date(candidate);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  return null;
}

export async function previewSessionContent(
  sourcePath: string,
  options: { maxItems?: number } = {},
): Promise<SessionContentPreview> {
  const maxItems = Math.min(500, Math.max(1, options.maxItems ?? defaultMaxItems));
  const items: SessionContentPreviewItem[] = [];
  let totalMessages = 0;
  let truncated = false;
  const stream = createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const input = String(line).trim();
      if (!input) continue;
      let value: unknown;
      try {
        value = JSON.parse(input);
      } catch {
        truncated = true;
        continue;
      }
      const role = roleOf(value);
      if (!role) continue;
      const content = messageText(value);
      if (!content) continue;
      totalMessages += 1;
      truncated ||= content.truncated;
      items.push({ role, text: content.text, occurredAt: occurredAt(value) });
      if (items.length > maxItems) items.shift();
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return sessionContentPreviewSchema.parse({
    items,
    totalMessages,
    truncated: truncated || totalMessages > items.length,
  });
}
