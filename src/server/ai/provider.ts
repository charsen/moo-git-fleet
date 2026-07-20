import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommitPreview, CommitSuggestion, RepositoryConfig } from '../../shared/contracts.js';
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

function localSuggestion(repository: RepositoryConfig, preview: CommitPreview): CommitSuggestion {
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

export async function suggestCommit(
  cwd: string,
  repository: RepositoryConfig,
  preview: CommitPreview,
  language: 'zh-CN' | 'en-US',
): Promise<CommitSuggestion> {
  const apiKey = await loadApiKey();
  const enabled = process.env.GIT_FLEET_AI_ENABLED !== 'false' && Boolean(apiKey);
  if (!enabled || !apiKey) return localSuggestion(repository, preview);

  const recentSubjects = await runGitText(cwd, ['log', '-8', '--format=%s']).catch(() => '');
  const sensitive = hasSensitivePath(preview.files);
  const diffInput = sensitive ? '[敏感路径命中，仅提供 stat]' : redactPatch(preview.patch);
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

  const baseUrl = (process.env.GIT_FLEET_AI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.GIT_FLEET_AI_MODEL ?? 'deepseek-chat',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You write precise Git commit messages. Never include secrets or markdown fences.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
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
  };
}
