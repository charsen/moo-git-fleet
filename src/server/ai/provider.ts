import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AiCommitPolicy, CommitPreview, CommitSuggestion, RepositoryConfig } from '../../shared/contracts.js';
import { appRoot } from '../config/store.js';
import { hasSensitivePath, redactPatch } from '../git/files.js';
import { runGitText } from '../git/runner.js';

const aiResponseSchema = z.object({
  type: z.string().trim().min(1).max(20),
  scope: z
    .string()
    .trim()
    .max(50)
    .nullish()
    .transform((value) => value ?? ''),
  subject: z.string().trim().min(1).max(120),
  body: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
  summary: z.string().trim().min(1).max(500),
});

function commitMessage(subject: string, body: string[]): string {
  return body.length ? `${subject}\n\n${body.join('\n')}` : subject;
}

function localSuggestion(
  repository: RepositoryConfig,
  preview: CommitPreview,
  aiPolicy: AiCommitPolicy,
): CommitSuggestion {
  const allDocs = preview.files.every((file) => /\.(md|mdx|txt)$/i.test(file));
  const allTests = preview.files.every((file) => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(file));
  const allStyles = preview.files.every((file) => /\.(css|scss|sass|less)$/i.test(file));
  const type = allDocs ? 'docs' : allTests ? 'test' : allStyles ? 'style' : 'chore';
  const scope = preview.files.length === 1 ? preview.files[0]?.split('/')[0] : repository.name;
  const subject = `${type}: 更新 ${scope || repository.name} 相关内容`;
  const body = [`涉及 ${preview.files.length} 个文件`, preview.stat.split('\n').at(-1)?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  return {
    source: 'local',
    message: commitMessage(subject, body),
    subject,
    body,
    summary: `根据 staged 文件和 diff stat 生成的本地规则建议。`,
    fingerprint: preview.fingerprint,
    aiPolicy,
  };
}

function extractJson(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function loadApiKey(): Promise<string | null> {
  const environmentKey = process.env.GIT_FLEET_AI_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  try {
    const fileKey = (await readFile(path.join(appRoot, 'deepseek_token'), 'utf8')).trim();
    return fileKey || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('无法读取 deepseek_token，请检查文件权限');
  }
}

export async function aiProviderStatus(): Promise<{
  configured: boolean;
  provider: 'deepseek' | 'openai-compatible';
  model: string;
}> {
  const apiKey = await loadApiKey();
  return {
    configured: process.env.GIT_FLEET_AI_ENABLED !== 'false' && Boolean(apiKey),
    provider: (process.env.GIT_FLEET_AI_PROVIDER ?? 'deepseek') === 'deepseek' ? 'deepseek' : 'openai-compatible',
    model: process.env.GIT_FLEET_AI_MODEL ?? 'deepseek-chat',
  };
}

export async function aiCommitPolicy(
  repository: RepositoryConfig,
  preview: CommitPreview,
): Promise<AiCommitPolicy> {
  if (repository.aiCommitPolicy === 'disabled') {
    return {
      mode: 'local-policy-disabled',
      label: '仓库策略 · 禁用 AI',
      detail: '此仓库禁止调用远端 AI；Commit 文案仅使用本地规则生成。',
    };
  }
  if (hasSensitivePath(preview.files)) {
    return {
      mode: 'local-sensitive',
      label: '敏感路径 · 仅本地',
      detail: '检测到 Token、凭据或密钥类路径，Git Fleet 不会调用 AI。',
    };
  }
  const status = await aiProviderStatus();
  if (!status.configured) {
    return {
      mode: 'local-disabled',
      label: '仅本地规则',
      detail: 'AI 未启用或未配置 Token；文件内容不会离开本机。',
    };
  }
  if (repository.aiCommitPolicy === 'stat-only') {
    return {
      mode: 'stat-only',
      label: `${status.provider === 'deepseek' ? 'DeepSeek' : 'AI'} · 仅统计`,
      detail: '仅发送仓库名、文件路径、diff stat 和最近提交标题；不会发送 staged diff 内容。',
    };
  }
  return {
    mode: 'redacted-patch',
    label: `${status.provider === 'deepseek' ? 'DeepSeek' : 'AI'} · 脱敏后发送`,
    detail: '仓库名、文件路径、统计、最近提交标题和脱敏后的 staged diff 将发送给 AI。',
  };
}

export async function suggestCommit(
  cwd: string,
  repository: RepositoryConfig,
  preview: CommitPreview,
  language: 'zh-CN' | 'en-US',
): Promise<CommitSuggestion> {
  const aiPolicy = await aiCommitPolicy(repository, preview);
  if (!['redacted-patch', 'stat-only'].includes(aiPolicy.mode)) return localSuggestion(repository, preview, aiPolicy);
  const apiKey = await loadApiKey();
  if (!apiKey) {
    return localSuggestion(repository, preview, {
      mode: 'local-disabled',
      label: '仅本地规则',
      detail: 'AI Token 当前不可用；文件内容不会离开本机。',
    });
  }

  const recentSubjects = await runGitText(cwd, ['log', '-8', '--format=%s']).catch(() => '');
  const diffInput = aiPolicy.mode === 'redacted-patch' ? redactPatch(preview.patch) : '[omitted by stat-only policy]';
  const prompt = [
    `Repository: ${repository.name}`,
    `Language: ${language}`,
    `Files:\n${preview.files.join('\n')}`,
    `Stat:\n${preview.stat}`,
    `Recent commit subjects:\n${recentSubjects}`,
    `Staged diff:\n${diffInput}`,
    '',
    'Return JSON only: {"type":"feat|fix|docs|style|refactor|test|chore","scope":"optional","subject":"complete commit subject including type","body":["line"],"summary":"change summary"}',
  ].join('\n');

  try {
    const baseUrl = (process.env.GIT_FLEET_AI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    const configuredTimeout = Number(process.env.GIT_FLEET_AI_TIMEOUT_SECONDS ?? 60);
    const timeoutSeconds = Number.isFinite(configuredTimeout)
      ? Math.min(120, Math.max(5, configuredTimeout))
      : 60;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GIT_FLEET_AI_MODEL ?? 'deepseek-chat',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You write precise Git commit messages. Never include secrets or markdown fences. The subject, body and summary must use the requested language; conventional type prefixes stay in English.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    if (!response.ok) throw new Error(`AI 请求失败：${response.status}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI 未返回 Commit 建议');
    const parsed = aiResponseSchema.parse(extractJson(content));
    return {
      source: (process.env.GIT_FLEET_AI_PROVIDER ?? 'deepseek') === 'deepseek' ? 'deepseek' : 'openai-compatible',
      message: commitMessage(parsed.subject, parsed.body),
      subject: parsed.subject,
      body: parsed.body,
      summary: parsed.summary,
      fingerprint: preview.fingerprint,
      aiPolicy,
    };
  } catch (error) {
    const fallback = localSuggestion(repository, preview, {
      mode: 'local-fallback',
      label: 'AI 失败 · 已回退本地',
      detail: 'AI 服务未完成请求，本次文案由本地规则生成；文件内容不会再次发送。',
    });
    const reason = error instanceof Error ? error.message : 'AI 服务不可用';
    return { ...fallback, summary: `${reason}，已安全回退到本地规则。` };
  }
}
