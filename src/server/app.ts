import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { RepositoriesConfig, RepositoryStatus } from '../shared/contracts.js';
import {
  addRepositorySchema,
  addRootSchema,
  profileUpdateSchema,
  scanRootSchema,
  updateRepositorySchema,
} from '../shared/schemas.js';
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
import { repositoryId, scanRepositories, scanRoot } from './git/scanner.js';
import { runGitText } from './git/runner.js';
import { listOperations, runOperation } from './operations/service.js';
import { registerLocalSessionSecurity } from './security/session.js';

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
  const [profile, config] = await Promise.all([loadProfile(), loadRepositories()]);
  const repositories = await scanRepositories(config);
  repositories.sort((a, b) => {
    const rankDifference = activityRank(a) - activityRank(b);
    if (rankDifference !== 0) return rankDifference;
    if (a.config.pinned !== b.config.pinned) return a.config.pinned ? -1 : 1;
    if (a.config.order !== b.config.order) return a.config.order - b.config.order;
    return a.config.name.localeCompare(b.config.name);
  });
  return { profile, roots: config.settings.roots, repositories };
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

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' } });
  await registerLocalSessionSecurity(app);

  app.setErrorHandler((error, _request, reply) => {
    const hasValidationIssues = typeof error === 'object' && error !== null && 'issues' in error;
    const message = error instanceof Error ? error.message : '服务器内部错误';
    const fastifyStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : null;
    reply.status(hasValidationIssues ? 400 : (fastifyStatus ?? 500)).send({ error: message });
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
      capabilities: { fetch: true, pull: true, stage: true, commit: true, push: true },
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

  app.get('/api/operations', async () => ({ operations: listOperations() }));
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
