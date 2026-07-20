import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommitPreview, RepositoryConfig } from '../../shared/contracts.js';
import { aiProviderStatus, suggestCommit } from './provider.js';

const repository: RepositoryConfig = {
  id: 'provider-test',
  name: 'provider-test',
  root: 'test',
  path: '.',
  group: 'tests',
  enabled: true,
  pinned: false,
  order: 10,
  tags: [],
  capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
};

const preview: CommitPreview = {
  fingerprint: 'a'.repeat(64),
  files: ['README.md'],
  stat: ' README.md | 1 +',
  patch: 'diff --git a/README.md b/README.md\n+updated',
  truncated: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AI commit provider', () => {
  it('reports provider readiness without exposing the API key', async () => {
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'true');
    vi.stubEnv('GIT_FLEET_AI_API_KEY', 'test-key');
    vi.stubEnv('GIT_FLEET_AI_MODEL', 'deepseek-test');

    await expect(aiProviderStatus()).resolves.toEqual({
      configured: true,
      provider: 'deepseek',
      model: 'deepseek-test',
    });
  });

  it('accepts a null optional scope from OpenAI-compatible responses', async () => {
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'true');
    vi.stubEnv('GIT_FLEET_AI_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: 'docs',
                    scope: null,
                    subject: 'docs: 更新项目说明',
                    body: ['补充本地工具说明'],
                    summary: '更新 README 文档',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const suggestion = await suggestCommit(process.cwd(), repository, preview, 'zh-CN');

    expect(suggestion.source).toBe('deepseek');
    expect(suggestion.message).toBe('docs: 更新项目说明\n\n补充本地工具说明');
  });

  it('never calls AI when a staged path looks sensitive', async () => {
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'true');
    vi.stubEnv('GIT_FLEET_AI_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const suggestion = await suggestCommit(
      process.cwd(),
      repository,
      { ...preview, files: ['deepseek_token'], patch: '+super-secret-token' },
      'zh-CN',
    );

    expect(suggestion.source).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to local rules when the provider is unavailable', async () => {
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'true');
    vi.stubEnv('GIT_FLEET_AI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));

    const suggestion = await suggestCommit(process.cwd(), repository, preview, 'zh-CN');

    expect(suggestion.source).toBe('local');
    expect(suggestion.summary).toContain('AI 请求失败：429');
    expect(suggestion.summary).toContain('回退到本地规则');
  });
});
