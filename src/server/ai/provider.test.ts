import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommitPreview, RepositoryConfig } from '../../shared/contracts.js';
import { suggestCommit } from './provider.js';

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
  capabilities: { fetch: true, pull: true, stage: true, commit: true, push: true },
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
});
