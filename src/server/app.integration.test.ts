import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

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

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Moo Fleet API workflow', () => {
  it('adds a local repository and completes the staged Commit flow with an audited operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-api-flow-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const repositoriesRoot = path.join(root, 'Repositories-研发');
    const repositoryPath = path.join(repositoriesRoot, 'demo');
    const remotePath = path.join(root, 'remote.git');
    await git(root, ['init', '--bare', remotePath]);
    await git(root, ['init', '--initial-branch=master', repositoryPath]);
    await git(repositoryPath, ['config', 'user.name', 'Git Fleet API Test']);
    await git(repositoryPath, ['config', 'user.email', 'api@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'initial\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
    await git(repositoryPath, ['push', '--set-upstream', 'origin', 'master:master']);
    await git(repositoryPath, ['branch', '--unset-upstream']);

    vi.stubEnv('GIT_FLEET_HOME', home);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_AI_API_KEY', '');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.resetModules();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    try {
      const unauthorized = await jsonRequest<{ error: string }>(app, {
        method: 'POST',
        url: '/api/repository-roots',
        payload: { path: repositoriesRoot },
      });
      expect(unauthorized).toMatchObject({ statusCode: 403, body: { error: '本地会话已失效，请刷新页面' } });

      const session = await jsonRequest<{ token: string }>(app, { method: 'GET', url: '/api/session' });
      expect(session.statusCode).toBe(200);
      const token = session.body.token;

      const savedKey = await jsonRequest<{ configured: boolean }>(
        app,
        { method: 'PUT', url: '/api/settings/deepseek-api-key', payload: { apiKey: 'integration-test-key-value' } },
        token,
      );
      expect(savedKey).toMatchObject({ statusCode: 200, body: { configured: true } });
      const tokenPath = path.join(home, 'deepseek_token');
      await chmod(tokenPath, 0o644);
      const readKey = await jsonRequest<{ apiKey: string }>(
        app,
        { method: 'POST', url: '/api/settings/deepseek-api-key/read' },
        token,
      );
      expect(readKey).toMatchObject({ statusCode: 200, body: { apiKey: 'integration-test-key-value' } });
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
      expect((await readdir(home)).filter((name) => name.startsWith('deepseek_token.') && name.endsWith('.tmp'))).toEqual([]);

      const preferences = await jsonRequest<{
        profile: { viewPreferences: { repositorySort: string; repositoryFilter: string; repositoryGroup: string | null; batchScope: string } };
      }>(
        app,
        {
          method: 'PATCH',
          url: '/api/settings/view-preferences',
          payload: { repositorySort: 'group', repositoryFilter: 'behind', repositoryGroup: 'Test', batchScope: 'all' },
        },
        token,
      );
      expect(preferences).toMatchObject({
        statusCode: 200,
        body: {
          profile: {
            viewPreferences: { repositorySort: 'group', repositoryFilter: 'behind', repositoryGroup: 'Test', batchScope: 'all' },
          },
        },
      });
      expect((await stat(path.join(home, 'config'))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(home, 'config/profile.yaml'))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(home, 'config/profile.yaml.bak'))).mode & 0o777).toBe(0o600);

      const roots = await jsonRequest<{
        roots: Record<string, string>;
        rootId: string;
        canonicalPath: string;
        created: boolean;
      }>(
        app,
        { method: 'POST', url: '/api/repository-roots', payload: { path: repositoriesRoot } },
        token,
      );
      expect(roots.statusCode).toBe(200);
      const canonicalRepositoriesRoot = await realpath(repositoriesRoot);
      expect(roots.body).toMatchObject({
        canonicalPath: canonicalRepositoriesRoot,
        created: true,
      });
      const rootId = roots.body.rootId;
      expect(roots.body.roots[rootId]).toBe(canonicalRepositoriesRoot);

      const added = await jsonRequest<{ id: string; name: string }>(
        app,
        {
          method: 'POST',
          url: '/api/repositories',
          payload: { rootId, relativePath: 'demo', name: 'Demo API', group: 'Tests', tags: ['api'] },
        },
        token,
      );
      expect(added).toMatchObject({ statusCode: 201, body: { name: 'Demo API' } });
      const repositoryId = added.body.id;

      const recentCommits = await jsonRequest<{
        commits: Array<{ hash: string; subject: string; author: string; committedAt: string }>;
      }>(app, { method: 'GET', url: `/api/repositories/${repositoryId}/commits` });
      expect(recentCommits.statusCode).toBe(200);
      expect(recentCommits.body.commits).toHaveLength(1);
      expect(recentCommits.body.commits[0]).toMatchObject({ subject: 'initial', author: 'Git Fleet API Test' });

      await writeFile(path.join(repositoryPath, 'README.md'), 'updated through API\n');
      await writeFile(path.join(repositoryPath, 'notes.md'), 'new through API\n');
      const files = await jsonRequest<{ files: Array<{ id: string; path: string; staged: boolean }> }>(app, {
        method: 'GET',
        url: `/api/repositories/${repositoryId}/files`,
      });
      expect(files.statusCode).toBe(200);
      expect(files.body.files.map((file) => file.path)).toHaveLength(2);
      expect(files.body.files.map((file) => file.path)).toEqual(expect.arrayContaining(['README.md', 'notes.md']));

      const readmeFile = files.body.files.find((file) => file.path === 'README.md');
      expect(readmeFile).toBeDefined();
      const discarded = await jsonRequest<{
        result: { action: string; path: string };
        files: Array<{ id: string; path: string; staged: boolean }>;
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/files/discard`,
          payload: { fileId: readmeFile!.id },
        },
        token,
      );
      expect(discarded).toMatchObject({
        statusCode: 200,
        body: { result: { action: 'restore', path: 'README.md' } },
      });
      expect(await readFile(path.join(repositoryPath, 'README.md'), 'utf8')).toBe('initial\n');

      await writeFile(path.join(repositoryPath, 'README.md'), 'updated through API\n');
      const filesAfterDiscard = await jsonRequest<{ files: Array<{ id: string; path: string; staged: boolean }> }>(app, {
        method: 'GET',
        url: `/api/repositories/${repositoryId}/files`,
      });

      const staged = await jsonRequest<{ files: Array<{ path: string; staged: boolean }> }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/stage`,
          payload: { fileIds: filesAfterDiscard.body.files.map((file) => file.id) },
        },
        token,
      );
      expect(staged.statusCode).toBe(200);
      expect(staged.body.files.every((file) => file.staged)).toBe(true);

      const preview = await jsonRequest<{ fingerprint: string; files: string[]; truncated: boolean }>(
        app,
        { method: 'POST', url: `/api/repositories/${repositoryId}/commit/preview`, payload: {} },
        token,
      );
      expect(preview).toMatchObject({
        statusCode: 200,
        body: { files: ['README.md', 'notes.md'], truncated: false },
      });
      expect(preview.body.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      await writeFile(path.join(repositoryPath, 'late-staged.txt'), 'staged after preview\n');
      await git(repositoryPath, ['add', 'late-staged.txt']);
      const staleSuggestion = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit/suggest`,
          payload: { fingerprint: preview.body.fingerprint },
        },
        token,
      );
      expect(staleSuggestion).toMatchObject({ statusCode: 409 });
      expect(staleSuggestion.body.error).toContain('暂存区已变化');
      await git(repositoryPath, ['reset', '--', 'late-staged.txt']);
      await rm(path.join(repositoryPath, 'late-staged.txt'));

      vi.stubEnv('GIT_FLEET_AI_ENABLED', 'true');
      vi.stubEnv('GIT_FLEET_AI_API_KEY', 'integration-ai-key');
      let markFetchStarted: (() => void) | undefined;
      let releaseFetch: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
      const fetchReleased = new Promise<void>((resolve) => { releaseFetch = resolve; });
      vi.stubGlobal('fetch', vi.fn(async () => {
        markFetchStarted?.();
        await fetchReleased;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              type: 'test',
              scope: 'api',
              subject: 'test: 验证建议快照',
              body: [],
              summary: '验证 AI 建议绑定 staged 快照',
            }) } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }));
      const suggestionDuringIndexChange = jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit/suggest`,
          payload: { fingerprint: preview.body.fingerprint },
        },
        token,
      );
      await fetchStarted;
      await writeFile(path.join(repositoryPath, 'late-during-ai.txt'), 'staged while AI is running\n');
      await git(repositoryPath, ['add', 'late-during-ai.txt']);
      releaseFetch?.();
      await expect(suggestionDuringIndexChange).resolves.toMatchObject({ statusCode: 409 });
      await git(repositoryPath, ['reset', '--', 'late-during-ai.txt']);
      await rm(path.join(repositoryPath, 'late-during-ai.txt'));

      let markAutoFetchStarted: (() => void) | undefined;
      let releaseAutoFetch: (() => void) | undefined;
      const autoFetchStarted = new Promise<void>((resolve) => { markAutoFetchStarted = resolve; });
      const autoFetchReleased = new Promise<void>((resolve) => { releaseAutoFetch = resolve; });
      vi.stubGlobal('fetch', vi.fn(async () => {
        markAutoFetchStarted?.();
        await autoFetchReleased;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              type: 'test',
              scope: 'api',
              subject: 'test: 验证自动提交快照',
              body: [],
              summary: '验证自动提交绑定 staged 快照',
            }) } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }));
      const autoCommitDuringIndexChange = jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit/auto`,
          payload: { fingerprint: preview.body.fingerprint, pushAfterCommit: false },
        },
        token,
      );
      await autoFetchStarted;
      await writeFile(path.join(repositoryPath, 'late-during-auto.txt'), 'staged while auto Commit is generating\n');
      await git(repositoryPath, ['add', 'late-during-auto.txt']);
      releaseAutoFetch?.();
      await expect(autoCommitDuringIndexChange).resolves.toMatchObject({ statusCode: 409 });
      expect(await git(repositoryPath, ['rev-list', '--count', 'HEAD'])).toBe('1');
      await git(repositoryPath, ['reset', '--', 'late-during-auto.txt']);
      await rm(path.join(repositoryPath, 'late-during-auto.txt'));
      vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
      vi.stubEnv('GIT_FLEET_AI_API_KEY', '');
      vi.unstubAllGlobals();

      const suggestion = await jsonRequest<{ source: string; message: string; fingerprint: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit/suggest`,
          payload: { fingerprint: preview.body.fingerprint },
        },
        token,
      );
      expect(suggestion).toMatchObject({
        statusCode: 200,
        body: { source: 'local', fingerprint: preview.body.fingerprint },
      });

      const staleCommit = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit`,
          payload: {
            message: suggestion.body.message,
            fingerprint: '0'.repeat(64),
            pushAfterCommit: false,
          },
        },
        token,
      );
      expect(staleCommit).toMatchObject({ statusCode: 409 });
      expect(staleCommit.body.error).toContain('暂存区已变化');
      expect(await git(repositoryPath, ['rev-list', '--count', 'HEAD'])).toBe('1');

      const committed = await jsonRequest<{
        operation: { type: string; state: string };
        result: { hash: string; treeMatches: boolean };
        pushOperation: null;
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/commit`,
          payload: {
            message: suggestion.body.message,
            fingerprint: preview.body.fingerprint,
            pushAfterCommit: false,
          },
        },
        token,
      );
      expect(committed).toMatchObject({
        statusCode: 200,
        body: {
          operation: { type: 'commit', state: 'success' },
          result: { treeMatches: true },
          pushOperation: null,
        },
      });
      expect(committed.body.result.hash).toMatch(/^[a-f0-9]{40}$/);
      expect(await git(repositoryPath, ['status', '--porcelain'])).toBe('');
      expect(await git(repositoryPath, ['show', '-1', '--no-patch', '--format=%s'])).toBe(suggestion.body.message.split('\n')[0]);

      await writeFile(path.join(repositoryPath, 'README.md'), 'stash through API\n');
      const createdStash = await jsonRequest<{
        operation: { type: string; state: string };
        result: { stash: { ref: string; hash: string }; stashes: Array<{ ref: string; hash: string }> };
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/stashes`,
          payload: { message: 'api drop test', includeUntracked: true },
        },
        token,
      );
      expect(createdStash).toMatchObject({
        statusCode: 200,
        body: { operation: { type: 'stash', state: 'success' }, result: { stashes: [{ ref: 'stash@{0}' }] } },
      });

      const staleDrop = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/stashes/drop`,
          payload: { ref: createdStash.body.result.stash.ref, expectedHash: '0'.repeat(40) },
        },
        token,
      );
      expect(staleDrop).toMatchObject({ statusCode: 409 });
      expect(staleDrop.body.error).toContain('Stash 列表已变化');

      const droppedStash = await jsonRequest<{
        operation: { type: string; state: string; message: string };
        result: { stashes: unknown[]; status: { stashCount: number } };
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/stashes/drop`,
          payload: { ref: createdStash.body.result.stash.ref, expectedHash: createdStash.body.result.stash.hash },
        },
        token,
      );
      expect(droppedStash).toMatchObject({
        statusCode: 200,
        body: {
          operation: { type: 'stash', state: 'success', message: 'stash@{0} 已永久删除' },
          result: { stashes: [], status: { stashCount: 0 } },
        },
      });

      const upstreamPlan = await jsonRequest<{
        branch: string;
        head: string;
        upstream: string | null;
        recommendedUpstream: string | null;
        candidates: Array<{ upstream: string; reason: string; ahead: number | null; behind: number | null }>;
      }>(app, { method: 'GET', url: `/api/repositories/${repositoryId}/upstream/repair` });
      expect(upstreamPlan).toMatchObject({
        statusCode: 200,
        body: {
          branch: 'master',
          upstream: null,
          recommendedUpstream: 'origin/master',
          candidates: [{ upstream: 'origin/master', reason: 'same-name', ahead: 1, behind: 0 }],
        },
      });

      const staleUpstream = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/upstream`,
          payload: {
            mode: 'track',
            upstream: 'origin/master',
            expectedBranch: upstreamPlan.body.branch,
            expectedHead: '0'.repeat(40),
          },
        },
        token,
      );
      expect(staleUpstream).toMatchObject({ statusCode: 409 });
      expect(staleUpstream.body.error).toContain('分支或 HEAD 已变化');

      const trackedUpstream = await jsonRequest<{
        operation: { type: string; state: string; message: string };
        result: {
          upstream: string;
          status: { upstream: string | null; ahead: number | null; behind: number | null; state: string };
          branches: { branches: Array<{ name: string; current: boolean; upstream: string | null }> };
        };
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/upstream`,
          payload: {
            mode: 'track',
            upstream: 'origin/master',
            expectedBranch: upstreamPlan.body.branch,
            expectedHead: upstreamPlan.body.head,
          },
        },
        token,
      );
      expect(trackedUpstream).toMatchObject({
        statusCode: 200,
        body: {
          operation: { type: 'set-upstream', state: 'success', message: '已关联 upstream：origin/master' },
          result: {
            upstream: 'origin/master',
            status: { upstream: 'origin/master', ahead: 1, behind: 0, state: 'ahead' },
          },
        },
      });
      expect(trackedUpstream.body.result.branches.branches).toContainEqual(
        expect.objectContaining({ name: 'master', current: true, upstream: 'origin/master' }),
      );
      expect(await git(repositoryPath, ['config', '--get', 'branch.master.remote'])).toBe('origin');
      expect(await git(repositoryPath, ['config', '--get', 'branch.master.merge'])).toBe('refs/heads/master');

      const fetched = await jsonRequest<{
        operation: { type: string; state: string; message: string };
        result: { config: { id: string }; ahead: number | null; behind: number | null };
      }>(
        app,
        { method: 'POST', url: `/api/repositories/${repositoryId}/fetch` },
        token,
      );
      expect(fetched).toMatchObject({
        statusCode: 200,
        body: {
          operation: {
            type: 'fetch',
            state: 'success',
            message: 'Fetch 完成：未发现当前分支的新提交',
          },
          result: { config: { id: repositoryId }, ahead: 1, behind: 0 },
        },
      });

      await git(repositoryPath, ['branch', 'feature/api-switch']);
      const branches = await jsonRequest<{
        currentBranch: string | null;
        head: string;
        branches: Array<{ name: string; current: boolean; worktreePath: string | null }>;
        worktrees: Array<{ path: string; branch: string | null; current: boolean }>;
      }>(app, { method: 'GET', url: `/api/repositories/${repositoryId}/branches` });
      expect(branches).toMatchObject({ statusCode: 200, body: { currentBranch: 'master' } });
      expect(branches.body.branches).toContainEqual(
        expect.objectContaining({ name: 'feature/api-switch', current: false, worktreePath: null }),
      );
      expect(branches.body.worktrees).toContainEqual(expect.objectContaining({ branch: 'master', current: true }));

      const staleSwitch = await jsonRequest<{ error: string }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/branches/switch`,
          payload: { branch: 'feature/api-switch', expectedBranch: 'master', expectedHead: '0'.repeat(40) },
        },
        token,
      );
      expect(staleSwitch).toMatchObject({ statusCode: 409 });
      expect(staleSwitch.body.error).toContain('分支或 HEAD 已变化');

      const switched = await jsonRequest<{
        operation: { type: string; state: string };
        result: { status: { branch: string | null }; files: unknown[]; branches: { currentBranch: string | null } };
      }>(
        app,
        {
          method: 'POST',
          url: `/api/repositories/${repositoryId}/branches/switch`,
          payload: { branch: 'feature/api-switch', expectedBranch: 'master', expectedHead: branches.body.head },
        },
        token,
      );
      expect(switched).toMatchObject({
        statusCode: 200,
        body: {
          operation: { type: 'switch-branch', state: 'success' },
          result: { status: { branch: 'feature/api-switch' }, branches: { currentBranch: 'feature/api-switch' } },
        },
      });
      expect(await git(repositoryPath, ['branch', '--show-current'])).toBe('feature/api-switch');

      const dashboard = await jsonRequest<{
        profile: { profile: { viewPreferences: { repositorySort: string; repositoryFilter: string; repositoryGroup: string | null; batchScope: string } } };
        repositories: Array<{ config: { id: string }; state: string; staged: number; modified: number }>;
        scan: { startedAt: string; completedAt: string; durationMs: number };
      }>(app, { method: 'GET', url: '/api/dashboard' });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.body.profile.profile.viewPreferences).toEqual({
        repositorySort: 'group',
        repositoryFilter: 'behind',
        repositoryGroup: 'Test',
        batchScope: 'all',
      });
      expect(dashboard.body.scan.durationMs).toBeGreaterThanOrEqual(0);
      expect(new Date(dashboard.body.scan.completedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(dashboard.body.scan.startedAt).getTime(),
      );
      expect(dashboard.body.repositories).toContainEqual(
        expect.objectContaining({ config: expect.objectContaining({ id: repositoryId }), staged: 0, modified: 0 }),
      );

      const restricted = await jsonRequest<{ capabilities: { fetch: boolean } }>(
        app,
        {
          method: 'PATCH',
          url: `/api/repositories/${repositoryId}/config`,
          payload: { capabilities: { fetch: false } },
        },
        token,
      );
      expect(restricted).toMatchObject({ statusCode: 200, body: { capabilities: { fetch: false } } });

      const invalidBatch = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/batches', payload: { type: 'fetch', repositoryIds: ['missing-repository'] } },
        token,
      );
      expect(invalidBatch).toMatchObject({ statusCode: 400 });
      expect(invalidBatch.body.error).toContain('未知或已禁用');

      const duplicateBatch = await jsonRequest<{ error: string }>(
        app,
        { method: 'POST', url: '/api/batches', payload: { type: 'fetch', repositoryIds: [repositoryId, repositoryId] } },
        token,
      );
      expect(duplicateBatch).toMatchObject({ statusCode: 400 });
      expect(duplicateBatch.body.error).toContain('重复项');

      const selectedBatch = await jsonRequest<{ batch: { id: string; total: number } }>(
        app,
        { method: 'POST', url: '/api/batches', payload: { type: 'fetch', repositoryIds: [repositoryId] } },
        token,
      );
      expect(selectedBatch).toMatchObject({ statusCode: 202, body: { batch: { total: 1 } } });
      let selectedBatchState = '';
      for (let attempt = 0; attempt < 50 && selectedBatchState !== 'completed'; attempt += 1) {
        const current = await jsonRequest<{ batches: Array<{ id: string; state: string; skipped: number }> }>(
          app,
          { method: 'GET', url: '/api/operations' },
        );
        const batch = current.body.batches.find((item) => item.id === selectedBatch.body.batch.id);
        selectedBatchState = batch?.state ?? '';
        if (selectedBatchState !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
        else expect(batch?.skipped).toBe(1);
      }
      expect(selectedBatchState).toBe('completed');

      const operations = await jsonRequest<{ operations: Array<{ repositoryId: string; type: string; state: string }> }>(
        app,
        { method: 'GET', url: '/api/operations' },
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'commit', state: 'success' }),
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'commit', state: 'failed' }),
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'switch-branch', state: 'success' }),
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'switch-branch', state: 'failed' }),
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'set-upstream', state: 'success' }),
      );
      expect(operations.body.operations).toContainEqual(
        expect.objectContaining({ repositoryId, type: 'set-upstream', state: 'failed' }),
      );
      const operationLogFiles = await readdir(path.join(home, '.data', 'operations'));
      const operationLog = await readFile(path.join(home, '.data', 'operations', operationLogFiles[0] ?? ''), 'utf8');
      expect(operationLog).toContain('"type":"commit"');
      expect(operationLog).toContain('"type":"switch-branch"');
      expect(operationLog).toContain('"type":"set-upstream"');
      expect(operationLog).not.toContain(repositoryPath);
      expect(await readFile(path.join(home, 'config', 'repositories.yaml'), 'utf8')).toContain('name: Demo API');
    } finally {
      await app.close();
    }
  }, 20000);
});
