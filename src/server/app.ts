import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { RepositoriesConfig, RepositoryStatus } from '../shared/contracts.js';
import {
  addRepositorySchema,
  addRootSchema,
  applyStashSchema,
  autoCommitRequestSchema,
  batchRequestSchema,
  commitRequestSchema,
  createStashSchema,
  fileSelectionSchema,
  openRepositorySchema,
  profileUpdateSchema,
  scanRootSchema,
  updateRepositorySchema,
} from '../shared/schemas.js';
import { aiCommitPolicy, aiProviderStatus, suggestCommit } from './ai/provider.js';
import {
  appRoot,
  isPathInside,
  loadProfile,
  loadRepositories,
  resolveRepositoryPath,
  resolveRoot,
  saveProfile,
  saveRepositories,
} from './config/store.js';
import { fetchRepository, pullRepository, pushRepository } from './git/actions.js';
import {
  commitPreview,
  commitStaged,
  fileDiff,
  listRepositoryFiles,
  resolveFileIds,
  stageFiles,
  unstageFiles,
} from './git/files.js';
import { repositoryId, scanRepositories, scanRoot } from './git/scanner.js';
import { runGitText } from './git/runner.js';
import { applyStash, createStash, listStashes } from './git/stash.js';
import { initializeOperations, listBatches, listOperations, runOperation, startBatch } from './operations/service.js';
import { registerLocalSessionSecurity } from './security/session.js';
import { openRepositoryLocation } from './system/open.js';

function activityRank(status: RepositoryStatus): number {
  const rank: Record<RepositoryStatus['state'], number> = {
    conflict: 0,
    'operation-in-progress': 1,
    diverged: 2,
    dirty: 3,
    ahead: 4,
    behind: 5,
    'remote-unknown': 6,
    missing: 7,
    invalid: 8,
    clean: 9,
  };
  return rank[status.state];
}

async function dashboardPayload() {
  const [profile, config, ai] = await Promise.all([loadProfile(), loadRepositories(), aiProviderStatus()]);
  const repositories = await scanRepositories(config);
  repositories.sort((a, b) => {
    const rankDifference = activityRank(a) - activityRank(b);
    if (rankDifference !== 0) return rankDifference;
    if (a.gitIdentity.complete !== b.gitIdentity.complete) return a.gitIdentity.complete ? 1 : -1;
    if (a.config.pinned !== b.config.pinned) return a.config.pinned ? -1 : 1;
    if (a.config.order !== b.config.order) return a.config.order - b.config.order;
    return a.config.name.localeCompare(b.config.name);
  });
  return { profile, ai, roots: config.settings.roots, repositories };
}

async function managedRepository(id: string) {
  const config = await loadRepositories();
  const repository = config.repositories.find((item) => item.id === id);
  if (!repository) throw new Error('仓库不存在');
  const rootPath = await resolveRoot(config, repository.root);
  const absolutePath = await realpath(resolveRepositoryPath(config, repository));
  if (!isPathInside(rootPath, absolutePath)) throw new Error('仓库路径超出允许的根目录');
  const topLevel = await realpath(await runGitText(absolutePath, ['rev-parse', '--show-toplevel']));
  if (topLevel !== absolutePath) throw new Error('仓库配置路径不是 Git worktree 根目录');
  return { config, repository, absolutePath };
}

function nextOrder(config: RepositoriesConfig): number {
  return config.repositories.reduce((maximum, repository) => Math.max(maximum, repository.order), 0) + 10;
}

function isBatchSafetySkip(type: 'pull' | 'push', error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const common = [
    '仓库配置禁止',
    'Detached HEAD',
    '当前分支没有 upstream',
    '仓库存在冲突或进行中的 Git 操作',
  ];
  const pull = ['工作区不干净', '本地与远端已分叉'];
  const push = ['远端存在新提交或已经分叉'];
  return [...common, ...(type === 'pull' ? pull : push)].some((reason) => message.includes(reason));
}

export function classifyErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  if (error instanceof ZodError) return 400;
  const message = error instanceof Error ? error.message : '';
  if (/(仓库不存在|本地目录不存在|文件不存在|未知仓库根目录)/.test(message)) return 404;
  if (
    /(已有 Git 操作|已变化|仍有仓库|已经在列表|标识已存在|暂存区为空|没有可提交内容|没有可 Stash|文件列表已过期|禁止|不干净|已分叉|应用产生冲突|没有 upstream|Detached HEAD|缺少 remote)/.test(
      message,
    )
  ) {
    return 409;
  }
  if (/(参数无效|路径不安全|路径超出|配置路径不是|根目录必须是目录|候选仓库超出|Commit 文案包含非法)/.test(message)) {
    return 400;
  }
  if (/^AI (请求失败|未返回)/.test(message)) return 502;
  return 500;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return `请求参数无效：${error.issues
      .map((issue) => `${issue.path.join('.') || 'request'} ${issue.message}`)
      .join('；')}`;
  }
  return error instanceof Error ? error.message : '服务器内部错误';
}

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' } });
  await initializeOperations();
  await registerLocalSessionSecurity(app);

  app.setErrorHandler((error, _request, reply) => {
    reply.status(classifyErrorStatus(error)).send({ error: errorMessage(error) });
  });

  app.get('/api/health', async () => ({ ok: true, name: 'moo-git-fleet', now: new Date().toISOString() }));
  app.get('/api/dashboard', dashboardPayload);
  app.get('/api/repositories', dashboardPayload);
  app.post('/api/repositories/refresh', dashboardPayload);

  app.get('/api/settings/profile', loadProfile);
  app.put('/api/settings/profile', async (request) => {
    const profile = profileUpdateSchema.parse(request.body);
    const current = await loadProfile();
    return saveProfile({ ...current, profile });
  });
  app.get('/api/settings/git-identity', async () => {
    const [name, email] = await Promise.all([
      runGitText(appRoot, ['config', '--global', '--get', 'user.name']).catch(() => ''),
      runGitText(appRoot, ['config', '--global', '--get', 'user.email']).catch(() => ''),
    ]);
    return { name: name || null, email: email || null };
  });

  app.get('/api/repository-roots', async () => (await loadRepositories()).settings.roots);
  app.post('/api/repository-roots', async (request, reply) => {
    const input = addRootSchema.parse(request.body);
    const canonicalPath = await realpath(input.path);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('仓库根目录必须是目录');
    const config = await loadRepositories();
    if (config.settings.roots[input.id]) {
      reply.status(409);
      return { error: `根目录标识已存在：${input.id}` };
    }
    config.settings.roots[input.id] = canonicalPath;
    await saveRepositories(config);
    return config.settings.roots;
  });
  app.delete('/api/repository-roots/:id', async (request, reply) => {
    const rootId = (request.params as { id: string }).id;
    const config = await loadRepositories();
    if (config.repositories.some((repository) => repository.root === rootId)) {
      reply.status(409);
      return { error: '仍有仓库使用该根目录，请先移出对应仓库' };
    }
    delete config.settings.roots[rootId];
    await saveRepositories(config);
    return config.settings.roots;
  });
  app.post('/api/repository-scan', async (request) => {
    const { rootId } = scanRootSchema.parse(request.body);
    return { candidates: await scanRoot(await loadRepositories(), rootId) };
  });

  app.post('/api/repositories', async (request, reply) => {
    const input = addRepositorySchema.parse(request.body);
    const config = await loadRepositories();
    const rootPath = await resolveRoot(config, input.rootId);
    const candidatePath = await realpath(path.resolve(rootPath, input.relativePath));
    if (!isPathInside(rootPath, candidatePath)) throw new Error('候选仓库超出允许的根目录');
    const topLevel = await realpath(await runGitText(candidatePath, ['rev-parse', '--show-toplevel']));
    if (!isPathInside(rootPath, topLevel)) throw new Error('Git worktree 超出允许的根目录');
    const relativePath = path.relative(rootPath, topLevel) || '.';
    const configuredPaths = await Promise.all(
      config.repositories.map(async (repository) => {
        const repositoryRoot = config.settings.roots[repository.root];
        const configuredPath = repositoryRoot ? path.resolve(repositoryRoot, repository.path) : repository.path;
        return realpath(configuredPath).catch(() => configuredPath);
      }),
    );
    if (configuredPaths.includes(topLevel)) {
      reply.status(409);
      return { error: '该仓库已经在列表中' };
    }
    const name = input.name ?? path.basename(topLevel);
    const repository = {
      id: repositoryId(name, topLevel),
      name,
      root: input.rootId,
      path: relativePath,
      group: input.group,
      enabled: true,
      pinned: false,
      order: nextOrder(config),
      tags: input.tags,
      aiCommitPolicy: 'redacted-patch' as const,
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    config.repositories.push(repository);
    await saveRepositories(config);
    reply.status(201);
    return repository;
  });

  app.patch('/api/repositories/:id/config', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const update = updateRepositorySchema.parse(request.body);
    const config = await loadRepositories();
    const index = config.repositories.findIndex((repository) => repository.id === id);
    if (index < 0) {
      reply.status(404);
      return { error: '仓库不存在' };
    }
    const current = config.repositories[index];
    if (!current) throw new Error('仓库配置损坏');
    config.repositories[index] = {
      ...current,
      ...update,
      capabilities: { ...current.capabilities, ...(update.capabilities ?? {}) },
    };
    await saveRepositories(config);
    return config.repositories[index];
  });

  app.delete('/api/repositories/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const config = await loadRepositories();
    const nextRepositories = config.repositories.filter((repository) => repository.id !== id);
    if (nextRepositories.length === config.repositories.length) {
      reply.status(404);
      return { error: '仓库不存在' };
    }
    config.repositories = nextRepositories;
    await saveRepositories(config);
    return { removed: id, deletedFromDisk: false };
  });

  app.get('/api/operations', async () => ({ batches: listBatches(), operations: listOperations() }));
  app.post('/api/batches', async (request, reply) => {
    const { type } = batchRequestSchema.parse(request.body);
    const config = await loadRepositories();
    const repositories = config.repositories.filter((repository) => repository.enabled);
    const batch = startBatch(repositories, type, config.settings.networkConcurrency, async (queuedRepository) => {
      const { config: freshConfig, repository, absolutePath } = await managedRepository(queuedRepository.id);
      if (!repository.capabilities[type]) {
        return { result: null, message: `仓库配置禁止 ${type} 操作`, skipped: true };
      }
      try {
        if (type === 'fetch') {
          return {
            result: await fetchRepository(freshConfig, repository, absolutePath),
            message: 'Fetch 完成',
          };
        }
        const output =
          type === 'pull'
            ? await pullRepository(freshConfig, repository, absolutePath)
            : await pushRepository(freshConfig, repository, absolutePath);
        return { result: output.status, message: output.message, skipped: output.skipped };
      } catch (error) {
        if (type !== 'fetch' && isBatchSafetySkip(type, error)) {
          return {
            result: null,
            message: error instanceof Error ? error.message : `安全 ${type} 已跳过`,
            skipped: true,
          };
        }
        throw error;
      }
    });
    reply.status(202);
    return { batch };
  });
  app.post('/api/repositories/:id/fetch', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'fetch', async () => ({
      result: await fetchRepository(config, repository, absolutePath),
      message: 'Fetch 完成',
    }));
  });
  app.post('/api/repositories/:id/pull', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'pull', async () => {
      const output = await pullRepository(config, repository, absolutePath);
      return { result: output.status, message: output.message, skipped: output.skipped };
    });
  });
  app.post('/api/repositories/:id/push', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'push', async () => {
      const output = await pushRepository(config, repository, absolutePath);
      return { result: output.status, message: output.message, skipped: output.skipped };
    });
  });

  app.get('/api/repositories/:id/files', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return { files: await listRepositoryFiles(id, absolutePath) };
  });
  app.get('/api/repositories/:id/stashes', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return { stashes: await listStashes(absolutePath) };
  });
  app.post('/api/repositories/:id/stashes', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = createStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw new Error('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await createStash(absolutePath, input.message, input.includeUntracked);
      const [stashes, status] = await Promise.all([
        listStashes(absolutePath),
        scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]),
      ]);
      return {
        result: { stash, stashes, status },
        message: `${stash.ref} 已创建，工作区改动已安全备份`,
      };
    });
  });
  app.post('/api/repositories/:id/stashes/apply', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = applyStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw new Error('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await applyStash(absolutePath, input.ref, input.expectedHash);
      const [stashes, status] = await Promise.all([
        listStashes(absolutePath),
        scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]),
      ]);
      return {
        result: { stash, stashes, status },
        message: `${stash.ref} 已应用，原 Stash 条目仍保留`,
      };
    });
  });
  app.post('/api/repositories/:id/open', async (request) => {
    const id = (request.params as { id: string }).id;
    const { target } = openRepositorySchema.parse(request.body);
    const { absolutePath } = await managedRepository(id);
    await openRepositoryLocation(target, absolutePath);
    return { opened: target };
  });
  app.get('/api/repositories/:id/diff', async (request) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { kind?: string; fileId?: string };
    if (!query.fileId || !['staged', 'unstaged'].includes(query.kind ?? '')) throw new Error('Diff 参数无效');
    const { absolutePath } = await managedRepository(id);
    const [relativePath] = resolveFileIds(id, [query.fileId]);
    if (!relativePath) throw new Error('文件不存在');
    return { path: relativePath, kind: query.kind, diff: await fileDiff(absolutePath, relativePath, query.kind as 'staged' | 'unstaged') };
  });
  app.post('/api/repositories/:id/stage', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileIds } = fileSelectionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw new Error('仓库配置禁止 Stage');
    await stageFiles(absolutePath, resolveFileIds(id, fileIds));
    return { files: await listRepositoryFiles(id, absolutePath), status: await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]) };
  });
  app.post('/api/repositories/:id/unstage', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileIds } = fileSelectionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw new Error('仓库配置禁止 Unstage');
    await unstageFiles(absolutePath, resolveFileIds(id, fileIds));
    return { files: await listRepositoryFiles(id, absolutePath), status: await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]) };
  });
  app.post('/api/repositories/:id/commit/preview', async (request) => {
    const id = (request.params as { id: string }).id;
    const { repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw new Error('仓库配置禁止 Commit');
    const preview = await commitPreview(absolutePath);
    return { ...preview, aiPolicy: await aiCommitPolicy(repository, preview) };
  });
  app.post('/api/repositories/:id/commit/suggest', async (request) => {
    const id = (request.params as { id: string }).id;
    const { repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw new Error('仓库配置禁止 Commit');
    const [preview, profile] = await Promise.all([commitPreview(absolutePath), loadProfile()]);
    return suggestCommit(absolutePath, repository, preview, profile.profile.preferredCommitLanguage);
  });
  app.post('/api/repositories/:id/commit', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = commitRequestSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw new Error('仓库配置禁止 Commit');
    return runOperation(repository, 'commit', async () => {
      const commit = await commitStaged(absolutePath, input.message, input.fingerprint);
      const status = await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]);
      return {
        result: { ...commit, status },
        message: commit.treeMatches
          ? `Commit ${commit.hash.slice(0, 7)} 完成`
          : `⚠ Commit ${commit.hash.slice(0, 7)} 完成，但 Git hook 改变了预览内容，请立即检查`,
      };
    });
  });
  app.post('/api/repositories/:id/commit/auto', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = autoCommitRequestSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw new Error('仓库配置禁止 Commit');
    return runOperation(repository, 'commit', async () => {
      const [preview, profile] = await Promise.all([commitPreview(absolutePath), loadProfile()]);
      if (preview.fingerprint !== input.fingerprint) throw new Error('暂存区已变化，请重新预览');
      const suggestion = await suggestCommit(
        absolutePath,
        repository,
        preview,
        profile.profile.preferredCommitLanguage,
      );
      const commit = await commitStaged(absolutePath, suggestion.message, preview.fingerprint);
      const status = await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]);
      return {
        result: { ...commit, status, suggestion },
        message: commit.treeMatches
          ? `${suggestion.source === 'local' ? '本地规则' : 'AI'} Commit ${commit.hash.slice(0, 7)} 完成`
          : `⚠ ${suggestion.source === 'local' ? '本地规则' : 'AI'} Commit ${commit.hash.slice(0, 7)} 完成，但 Git hook 改变了预览内容，请立即检查`,
      };
    });
  });

  const clientRoot = path.join(appRoot, 'dist/client');
  try {
    await access(clientRoot);
    await app.register(fastifyStatic, { root: clientRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'API route not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  } catch {
    // Vite serves the client during development.
  }

  return app;
}
