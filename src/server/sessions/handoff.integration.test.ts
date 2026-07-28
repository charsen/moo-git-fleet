import { execFile } from 'node:child_process';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CheckpointDiscoveryPayload,
  CheckpointJob,
  CheckpointJobsPayload,
  CheckpointPreview,
} from '../../shared/sessions.js';

const execFileAsync = promisify(execFile);
const syntheticCliFixture = fileURLToPath(new URL('./fixtures/probe/synthetic-cli.mjs', import.meta.url));
const temporaryDirectories: string[] = [];
const hostHeaders = { host: '127.0.0.1:8787' };

function encodeClaudeProjectPath(projectPath: string): string {
  return path.resolve(projectPath).replaceAll('/', '-');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

async function request<T>(
  app: FastifyInstance,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  token?: string,
): Promise<{ statusCode: number; body: T }> {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...hostHeaders,
      ...(token ? { 'x-git-fleet-token': token } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { statusCode: response.statusCode, body: response.json<T>() };
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, message: string): Promise<T> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function openCheckpointStream(port: number): Promise<{
  response: IncomingMessage;
  read: () => string;
  close: () => void;
}> {
  let contents = '';
  let clientRequest: ClientRequest | null = null;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    clientRequest = get(
      {
        host: '127.0.0.1',
        port,
        path: '/api/session-checkpoint-jobs/events',
        headers: hostHeaders,
      },
      (incoming) => {
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => {
          contents += chunk;
        });
        incoming.once('data', () => resolve(incoming));
      },
    );
    clientRequest.once('error', reject);
  });
  return {
    response,
    read: () => contents,
    close: () => {
      clientRequest?.destroy();
      response.destroy();
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Session checkpoint API and progress stream', () => {
  it('previews, captures, reports real steps over SSE, and never echoes rejected secrets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-handoff-api-'));
    temporaryDirectories.push(root);
    const fleetHome = path.join(root, 'fleet-home');
    const providerHome = path.join(root, 'provider-home');
    const fleetSource = path.join(root, 'fleet-source');
    const repositoriesRoot = path.join(root, 'repositories');
    const projectPath = path.join(repositoriesRoot, 'synthetic-project');
    const remotePath = path.join(root, 'project-remote.git');
    const vaultPath = path.join(root, 'private-session-vault');
    const binDirectory = path.join(root, 'bin');
    await Promise.all([
      mkdir(fleetSource, { recursive: true }),
      mkdir(projectPath, { recursive: true }),
      mkdir(binDirectory, { recursive: true }),
    ]);
    await git(root, ['init', '--bare', remotePath]);
    await git(root, ['init', '--initial-branch=main', fleetSource]);
    await git(root, ['init', '--initial-branch=main', projectPath]);
    await git(projectPath, ['config', 'user.name', 'Synthetic Developer']);
    await git(projectPath, ['config', 'user.email', 'synthetic@example.test']);
    await git(projectPath, ['remote', 'add', 'origin', remotePath]);
    await writeFile(path.join(projectPath, 'README.md'), '# Synthetic project\n');
    await git(projectPath, ['add', 'README.md']);
    await git(projectPath, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(projectPath, ['push', '--set-upstream', 'origin', 'main:main']);
    await writeFile(path.join(projectPath, 'README.md'), '# Synthetic project with local changes\n');
    await writeFile(path.join(projectPath, 'untracked.txt'), 'Synthetic API untracked source.\n');

    const cliPath = path.join(binDirectory, 'claude');
    await copyFile(syntheticCliFixture, cliPath);
    await chmod(cliPath, 0o700);
    const providerSessionId = '55555555-5555-4555-8555-555555555555';
    const fakeAwsKey = `AKIA${'D'.repeat(16)}`;
    const canonicalProjectPath = await realpath(projectPath);
    const claudeProjectPath = path.join(
      providerHome,
      '.claude',
      'projects',
      encodeClaudeProjectPath(canonicalProjectPath),
    );
    await mkdir(claudeProjectPath, { recursive: true });
    await writeFile(
      path.join(claudeProjectPath, `${providerSessionId}.jsonl`),
      `${JSON.stringify({ timestamp: new Date().toISOString(), title: `Synthetic API title ${fakeAwsKey}` })}\n`,
    );

    vi.stubEnv('GIT_FLEET_HOME', fleetHome);
    vi.stubEnv('GIT_FLEET_SOURCE_ROOT', fleetSource);
    vi.stubEnv('GIT_FLEET_AI_ENABLED', 'false');
    vi.stubEnv('GIT_FLEET_PORT', '8787');
    vi.stubEnv('GIT_FLEET_MACHINE', 'synthetic-machine');
    vi.stubEnv('HOME', providerHome);
    vi.stubEnv('PATH', `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口');
    let stream: Awaited<ReturnType<typeof openCheckpointStream>> | null = null;

    try {
      const session = await request<{ token: string }>(app, 'GET', '/api/session');
      const token = session.body.token;
      const rootResult = await request<{ rootId: string }>(
        app,
        'POST',
        '/api/repository-roots',
        { path: repositoriesRoot },
        token,
      );
      expect(rootResult.statusCode).toBe(200);
      const repository = await request<{ id: string }>(
        app,
        'POST',
        '/api/repositories',
        {
          rootId: rootResult.body.rootId,
          relativePath: 'synthetic-project',
          name: 'Synthetic Project',
          group: 'Tests',
        },
        token,
      );
      expect(repository.statusCode).toBe(201);
      const initialized = await request<{ configured: boolean }>(
        app,
        'POST',
        '/api/session-vault/initialize',
        { vaultPath },
        token,
      );
      expect(initialized).toMatchObject({ statusCode: 200, body: { configured: true } });

      const discovery = await request<CheckpointDiscoveryPayload>(app, 'GET', '/api/session-discovery');
      expect(discovery.statusCode).toBe(200);
      expect(discovery.body).toMatchObject({
        schemaVersion: 1,
        machine: 'synthetic-machine',
        sessions: [{
          provider: 'claude',
          providerSessionId,
          repositoryId: repository.body.id,
          readable: true,
        }],
      });
      expect(JSON.stringify(discovery.body)).not.toContain(fakeAwsKey);

      const previewUrl = `/api/sessions/claude/${providerSessionId}/checkpoint-preview`;
      const preview = await request<CheckpointPreview>(app, 'GET', previewUrl);
      expect(preview.statusCode).toBe(200);
      expect(preview.body.workspaceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(preview.body.providerCapabilities).toMatchObject({ state: 'supported', forkResume: true });
      expect(preview.body.summary.goal).toContain('[REDACTED:aws-access-key]');
      expect(preview.body.summaryGeneration).toMatchObject({
        method: 'heuristic',
        providerInvocationAvailable: true,
        providerInvocationAttempted: false,
        requiresExplicitOptIn: true,
        incursProviderTokenUsage: true,
      });
      expect(preview.body.sourceSyncGate).toMatchObject({
        dirty: true,
        headReachable: true,
        branchReachable: true,
        choices: ['push-wip-ref', 'handoff-only'],
      });
      expect(JSON.stringify(preview.body)).not.toContain(fakeAwsKey);

      const providerSummaryUrl = `${previewUrl}/provider-summary`;
      const providerSummaryUnauthorized = await request<{ error: string }>(
        app,
        'POST',
        providerSummaryUrl,
        { allowProviderInvocation: true },
      );
      expect(providerSummaryUnauthorized.statusCode).toBe(403);
      const missingOptIn = await request<{ error: string }>(
        app,
        'POST',
        providerSummaryUrl,
        { allowProviderInvocation: false },
        token,
      );
      expect(missingOptIn.statusCode).toBe(400);
      const providerPreview = await request<CheckpointPreview>(
        app,
        'POST',
        providerSummaryUrl,
        { allowProviderInvocation: true },
        token,
      );
      expect(providerPreview.statusCode).toBe(200);
      expect(providerPreview.body.summary).toMatchObject({
        goal: 'Continue the synthetic provider-generated handoff',
        source: 'ai-generated',
      });
      expect(providerPreview.body.summaryGeneration).toMatchObject({
        method: 'provider',
        providerInvocationAttempted: true,
        providerInvocationSucceeded: true,
        incursProviderTokenUsage: true,
      });
      expect(providerPreview.body.summaryGeneration.message).toContain('token');
      expect(JSON.stringify(providerPreview.body)).not.toContain(fakeAwsKey);

      const captureUrl = `/api/sessions/claude/${providerSessionId}/checkpoints`;
      const reviewedSummary = {
        ...providerPreview.body.summary,
        goal: 'Continue the synthetic API checkpoint workflow',
        source: 'manual' as const,
        reviewedAt: new Date().toISOString(),
      };
      const capturePayload = {
        summary: reviewedSummary,
        expectedWorkspaceFingerprint: providerPreview.body.workspaceFingerprint,
        expectedSourceSyncFingerprint: providerPreview.body.sourceSyncGate!.fingerprint,
        sourceSyncChoice: 'push-wip-ref' as const,
      };
      const unauthorized = await request<{ error: string }>(app, 'POST', captureUrl, capturePayload);
      expect(unauthorized.statusCode).toBe(403);

      stream = await openCheckpointStream(address.port);
      expect(stream.response.headers['content-type']).toContain('text/event-stream');
      const started = await request<CheckpointJob>(app, 'POST', captureUrl, capturePayload, token);
      expect(started.statusCode).toBe(202);
      const completed = await waitFor(async () => {
        const current = await request<CheckpointJob>(
          app,
          'GET',
          `/api/session-checkpoint-jobs/${started.body.operationId}`,
        );
        return current.body.state === 'success' ? current.body : null;
      }, 'checkpoint API job did not complete');
      expect(completed.progress.map((item) => item.step)).toEqual([
        'source-sync-check',
        'source-sync-push',
        'preparing',
        'writing-staging',
        'secret-scan',
        'publishing-object',
        'writing-event',
        'committing',
        'complete',
      ]);
      expect(completed.result?.checkpoint.capabilities).toMatchObject({
        codeReachable: true,
        sourceSync: {
          mode: 'pushed-wip-ref',
          transport: 'namespace-ref',
          includesWorkingTree: true,
        },
      });
      const sourceSync = completed.result?.checkpoint.capabilities.sourceSync;
      expect(sourceSync?.ref).toMatch(/^refs\/moo-fleet\/wip\/[a-f0-9]{64}$/);
      expect(await git(remotePath, ['rev-parse', sourceSync!.ref!])).toBe(sourceSync?.commit);
      await waitFor(
        () =>
          stream?.read().includes(started.body.operationId) && stream.read().includes('"step":"complete"')
            ? stream.read()
            : null,
        'checkpoint SSE stream did not expose completed progress',
      );

      const fakeProviderKey = `sk-${'q'.repeat(24)}`;
      const blocked = await request<CheckpointJob>(
        app,
        'POST',
        captureUrl,
        {
          ...capturePayload,
          sourceSyncChoice: 'handoff-only',
          summary: { ...reviewedSummary, goal: `Synthetic blocked content ${fakeProviderKey}` },
        },
        token,
      );
      expect(blocked.statusCode).toBe(202);
      const failed = await waitFor(async () => {
        const current = await request<CheckpointJob>(
          app,
          'GET',
          `/api/session-checkpoint-jobs/${blocked.body.operationId}`,
        );
        return current.body.state === 'failed' ? current.body : null;
      }, 'secret-scanned checkpoint job did not fail');
      expect(failed.error?.code).toBe('session-secret-scan-failed');
      expect(JSON.stringify(failed)).not.toContain(fakeProviderKey);
      await waitFor(
        () => (stream?.read().includes(blocked.body.operationId) && stream.read().includes('"state":"failed"') ? true : null),
        'checkpoint SSE stream did not expose failed progress',
      );
      expect(stream.read()).not.toContain(fakeAwsKey);
      expect(stream.read()).not.toContain(fakeProviderKey);

      const jobs = await request<CheckpointJobsPayload>(app, 'GET', '/api/session-checkpoint-jobs');
      expect(jobs.body.jobs.map((job) => job.operationId)).toEqual(
        expect.arrayContaining([started.body.operationId, blocked.body.operationId]),
      );
      expect(JSON.stringify(jobs.body)).not.toContain(fakeAwsKey);
      expect(JSON.stringify(jobs.body)).not.toContain(fakeProviderKey);
      expect(await git(vaultPath, ['rev-list', '--all', '--count'])).toBe('1');

      const missing = await request<{ error: string }>(
        app,
        'GET',
        '/api/session-checkpoint-jobs/00000000-0000-4000-8000-000000000000',
      );
      expect(missing).toMatchObject({ statusCode: 404, body: { error: 'Checkpoint 后台任务不存在或已过期' } });
    } finally {
      stream?.close();
      await app.close();
    }
  }, 20_000);
});
