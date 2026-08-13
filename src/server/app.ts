import { access, realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import type {
  PruneMissingRepositoriesResult,
  RepositoryConfig,
  RepositoryRootMutationResult,
} from '../shared/contracts.js';
import { createUniqueRootId } from '../shared/root-identity.js';
import {
  addRepositorySchema,
  addRootSchema,
  applyStashSchema,
  autoCommitRequestSchema,
  batchRequestSchema,
  commitRequestSchema,
  commitSuggestionRequestSchema,
  createStashSchema,
  directoryPickerSchema,
  fileActionSchema,
  fileSelectionSchema,
  nativeFolderPickerSchema,
  openRepositorySchema,
  profileUpdateSchema,
  pruneMissingRepositoriesSchema,
  repositoryManifestImportSchema,
  repositoryManifestPreviewSchema,
  scanRootSchema,
  switchBranchSchema,
  upstreamRepairSchema,
  updateRepositorySchema,
  viewPreferencesUpdateSchema,
} from '../shared/schemas.js';
import {
  initializeBackupSchema,
  legacyVaultErrorCode,
  localSessionParamsSchema,
  trashLocalSessionSchema,
  trashLocalSessionsSchema,
} from '../shared/session-sync.js';
import { aiCommitPolicy, aiProviderStatus, loadDeepSeekApiKey, saveDeepSeekApiKey, suggestCommit } from './ai/provider.js';
import {
  appRoot,
  isPathInside,
  loadProfile,
  loadRepositories,
  resolveRepositoryPath,
  resolveRoot,
  updateProfile,
  updateRepositories,
} from './config/store.js';
import { scanDashboardRepositories } from './dashboard/service.js';
import { fetchRepository, pullRepository, pushRepository } from './git/actions.js';
import { listBranches, switchBranch } from './git/branches.js';
import { listRecentCommits } from './git/commits.js';
import { commitWithOptionalPush } from './git/commit-push.js';
import {
  commitPreview,
  commitStaged,
  discardFileChange,
  fileDiff,
  listRepositoryFiles,
  resolveCurrentFileAction,
  resolveFileIds,
  stageFiles,
  stagedFingerprint,
  unstageFiles,
} from './git/files.js';
import { scanRepositories, scanRoot } from './git/scanner.js';
import { previewPackagesManifest } from './import/packages.js';
import { runGitLine, runGitText } from './git/runner.js';
import { applyStash, createStash, dropStash, listStashes } from './git/stash.js';
import { publishCurrentBranch, trackExistingUpstream, upstreamRepairPlan } from './git/upstream.js';
import {
  initializeOperations,
  operationsPayload,
  runOperation,
  startBatch,
  subscribeOperations,
  synchronizeOperations,
  withRepositoryLock,
} from './operations/service.js';
import { appendRepositoryConfig } from './repositories/service.js';
import { compareRepositoryActivity, compareRepositoryPinning } from '../shared/repository-pinning.js';
import { fetchResultMessage } from '../shared/fetch-result.js';
import { registerLocalSessionSecurity } from './security/session.js';
import { pickFolder } from './native/folder-picker.js';
import { openRepositoryLocation } from './system/open.js';
import { selectDirectory } from './system/directory-picker.js';
import { readSystemClipboard } from './system/clipboard.js';
import { movePathToTrash } from './system/trash.js';
import { backupStatus, initializeBackup, listBackupCandidates } from './sessions/backup-repo.js';
import { listLocalSessions, localSessionPreview } from './sessions/local-sessions.js';
import {
  resolveSessionSync,
  runSessionSync,
  sessionSyncResolveSchema,
  trashLocalSession,
  trashLocalSessions,
} from './sessions/sync-run.js';


async function dashboardPayload() {
  const [profile, config, ai] = await Promise.all([loadProfile(), loadRepositories(), aiProviderStatus()]);
  const dashboardScan = await scanDashboardRepositories(config);
  const repositories = [...dashboardScan.repositories];
  repositories.sort((a, b) => {
    const pinning = compareRepositoryPinning(a, b);
    if (pinning !== null) return pinning;
    return compareRepositoryActivity(a, b);
  });
  return { profile, ai, roots: config.settings.roots, repositories, scan: dashboardScan.scan };
}

async function managedRepository(id: string) {
  const config = await loadRepositories();
  const repository = config.repositories.find((item) => item.id === id);
  if (!repository) throw new Error('仓库不存在');
  const rootPath = await resolveRoot(config, repository.root);
  const absolutePath = await realpath(resolveRepositoryPath(config, repository));
  if (!isPathInside(rootPath, absolutePath)) throw new Error('仓库路径超出允许的根目录');
  const topLevel = await realpath(await runGitLine(absolutePath, ['rev-parse', '--show-toplevel']));
  if (topLevel !== absolutePath) throw new Error('仓库配置路径不是 Git worktree 根目录');
  return { config, repository, absolutePath };
}

function isBatchSafetySkip(type: 'pull' | 'push', error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const common = [
    '仓库配置禁止',
    'Detached HEAD',
    '当前分支没有 upstream',
    '仓库存在冲突或进行中的 Git 操作',
    '当前分支或 HEAD 已变化',
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
    /(已有 Git 操作|已变化|目标分支|不能切换|不能设置 upstream|仍有仓库|已经在列表|标识已存在|暂存区为空|没有可提交内容|没有可 Stash|文件列表已过期|清单候选已变化|Upstream 候选|远端分支 .*已出现|已有 upstream|尚无 Commit|upstream 写入后校验失败|禁止|不干净|已分叉|应用产生冲突|没有 upstream|Detached HEAD|缺少 remote)/.test(
      message,
    )
  ) {
    return 409;
  }
  if (/(参数无效|路径不安全|路径超出|配置路径不是|根目录必须是目录|候选仓库超出|清单文件|清单路径|清单中|清单仓库|批量仓库|Commit 文案包含非法)/.test(message)) {
    return 400;
  }
  if (/^AI (请求失败|未返回)/.test(message)) return 502;
  return 500;
}

/**
 * 界面需要特殊处理的错误码白名单。只有列在这里的才会出现在响应里——
 * Node 的系统错误（ENOENT、ERR_* 之类）也带 `code`，不该被当成产品语义漏给前端。
 */
const machineReadableErrorCodes = new Set<string>([legacyVaultErrorCode]);

/** 错误对象上的机器可读错误码；没有或不在白名单里就返回 null。 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && machineReadableErrorCodes.has(code) ? code : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return `请求参数无效：${error.issues
      .map((issue) => `${issue.path.join('.') || 'request'} ${issue.message}`)
      .join('；')}`;
  }
  return error instanceof Error ? error.message : '服务器内部错误';
}

export function resolveClientRoot(
  environment: Partial<Pick<NodeJS.ProcessEnv, 'GIT_FLEET_ASSETS_HOME'>> = process.env,
  workingDirectory = process.cwd(),
): string {
  const assetsRoot = path.resolve(environment.GIT_FLEET_ASSETS_HOME ?? workingDirectory);
  return path.join(assetsRoot, 'dist/client');
}

export async function buildApp() {
  const requestedLogLevel = process.env.GIT_FLEET_LOG_LEVEL ?? 'info';
  const supportedLogLevels = new Set(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']);
  const logLevel = process.env.NODE_ENV === 'test' ? 'silent' : supportedLogLevels.has(requestedLogLevel) ? requestedLogLevel : 'info';
  const app = Fastify({ logger: { level: logLevel } });
  const activeEventStreams = new Set<ServerResponse>();
  app.addHook('preClose', () => {
    for (const response of activeEventStreams) response.destroy();
    activeEventStreams.clear();
  });
  await initializeOperations();
  await registerLocalSessionSecurity(app);

  app.setErrorHandler((error, _request, reply) => {
    const code = errorCode(error);
    reply.status(classifyErrorStatus(error)).send({ error: errorMessage(error), ...(code ? { code } : {}) });
  });

  app.get('/api/health', async () => ({ ok: true, name: 'moo-fleet', now: new Date().toISOString() }));
  app.get('/api/dashboard', dashboardPayload);
  app.get('/api/repositories', dashboardPayload);
  app.post('/api/repositories/refresh', dashboardPayload);

  app.get('/api/settings/profile', loadProfile);
  app.put('/api/settings/profile', async (request) => {
    const profile = profileUpdateSchema.parse(request.body);
    return updateProfile((current) => ({ ...current, profile }));
  });
  app.patch('/api/settings/view-preferences', async (request) => {
    const viewPreferences = viewPreferencesUpdateSchema.parse(request.body);
    return updateProfile((current) => ({
      ...current,
      profile: { ...current.profile, viewPreferences },
    }));
  });
  app.put('/api/settings/deepseek-api-key', async (request) => {
    const { apiKey } = z.object({ apiKey: z.string().trim().min(8).max(500) }).parse(request.body);
    await saveDeepSeekApiKey(apiKey);
    return { configured: true };
  });
  app.post('/api/settings/deepseek-api-key/read', async () => ({ apiKey: (await loadDeepSeekApiKey()) ?? '' }));
  app.post('/api/system/clipboard/read', async () => ({ text: await readSystemClipboard() }));
  // —— 会话同步 ——
  // 本机会话是真相，备份仓是它在 Git 里的副本。整个功能只有下面这几个动作。
  app.get('/api/session-backup', async () => backupStatus());
  app.get('/api/session-backup/candidates', async () => ({ candidates: await listBackupCandidates() }));
  app.post('/api/session-backup/initialize', async (request) => {
    const input = initializeBackupSchema.parse(request.body ?? {});
    return initializeBackup(input);
  });
  app.get('/api/local-sessions', async () => listLocalSessions());
  app.get('/api/local-sessions/:provider/:providerSessionId', async (request) => {
    const { provider, providerSessionId } = localSessionParamsSchema.parse(request.params);
    return localSessionPreview({ provider, providerSessionId });
  });
  app.post('/api/local-sessions/:provider/:providerSessionId/trash', async (request) => {
    const { provider, providerSessionId } = localSessionParamsSchema.parse(request.params);
    const input = trashLocalSessionSchema.parse(request.body ?? {});
    return trashLocalSession({ provider, providerSessionId, alsoRemoveFromBackup: input.alsoRemoveFromBackup });
  });
  app.post('/api/local-sessions/trash-batch', async (request) => {
    const input = trashLocalSessionsSchema.parse(request.body);
    return trashLocalSessions(input);
  });
  app.post('/api/session-sync', async () => runSessionSync());
  app.post('/api/session-sync/resolve', async (request) => {
    const input = sessionSyncResolveSchema.parse(request.body);
    return resolveSessionSync(input);
  });

  app.get('/api/settings/git-identity', async () => {
    const [name, email] = await Promise.all([
      runGitText(appRoot, ['config', '--global', '--get', 'user.name']).catch(() => ''),
      runGitText(appRoot, ['config', '--global', '--get', 'user.email']).catch(() => ''),
    ]);
    return { name: name || null, email: email || null };
  });

  app.post('/api/system/select-directory', async (request) => {
    const { initialPath } = directoryPickerSchema.parse(request.body ?? {});
    let canonicalInitialPath: string | null = null;
    if (initialPath) {
      canonicalInitialPath = await realpath(initialPath).catch(() => null);
      if (canonicalInitialPath && !(await stat(canonicalInitialPath)).isDirectory()) canonicalInitialPath = null;
    }
    const selectedPath = await selectDirectory(canonicalInitialPath);
    if (!selectedPath) return { path: null };
    const canonicalPath = await realpath(selectedPath);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('选择的路径不是目录');
    return { path: canonicalPath };
  });

  // 网页拿不到原生选择器的绝对路径，只能由本机服务端弹 macOS 的 choose folder 再把路径带回来。
  app.post('/api/native/pick-folder', async (request) => {
    const { prompt } = nativeFolderPickerSchema.parse(request.body ?? {});
    return { path: await pickFolder(prompt) };
  });

  app.get('/api/repository-roots', async () => (await loadRepositories()).settings.roots);
  app.post('/api/repository-roots', async (request): Promise<RepositoryRootMutationResult> => {
    const input = addRootSchema.parse(request.body);
    const canonicalPath = await realpath(input.path);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('仓库根目录必须是目录');
    let rootId = '';
    let created = false;
    const config = await updateRepositories((current) => {
      const existingRoot = Object.entries(current.settings.roots).find(([, configuredPath]) => configuredPath === canonicalPath);
      if (existingRoot) {
        [rootId] = existingRoot;
        return current;
      }
      rootId = input.id ?? createUniqueRootId(canonicalPath, Object.keys(current.settings.roots));
      if (current.settings.roots[rootId]) throw new Error(`根目录标识已存在：${rootId}`);
      current.settings.roots[rootId] = canonicalPath;
      created = true;
      return current;
    });
    if (!rootId || config.settings.roots[rootId] !== canonicalPath) {
      throw new Error('根目录配置写入后身份校验失败');
    }
    return { roots: config.settings.roots, rootId, canonicalPath, created };
  });
  app.delete('/api/repository-roots/:id', async (request) => {
    const rootId = (request.params as { id: string }).id;
    const config = await updateRepositories((current) => {
      if (current.repositories.some((repository) => repository.root === rootId)) {
        throw new Error('仍有仓库使用该根目录，请先移出对应仓库');
      }
      delete current.settings.roots[rootId];
      return current;
    });
    return config.settings.roots;
  });
  app.post('/api/repository-scan', async (request) => {
    const { rootId } = scanRootSchema.parse(request.body);
    return { candidates: await scanRoot(await loadRepositories(), rootId) };
  });

  app.post('/api/repository-manifest/preview', async (request) => {
    const { sourcePath } = repositoryManifestPreviewSchema.parse(request.body);
    return previewPackagesManifest(await loadRepositories(), sourcePath);
  });

  app.post('/api/repository-manifest/import', async (request, reply) => {
    const input = repositoryManifestImportSchema.parse(request.body);
    const repositories: RepositoryConfig[] = [];
    await updateRepositories(async (config) => {
      const preview = await previewPackagesManifest(config, input.sourcePath);
      const readyByPath = new Map<string, (typeof preview.candidates)[number]>(
        preview.candidates
          .filter((candidate) => candidate.status === 'ready' && candidate.rootId && candidate.relativePath)
          .map((candidate) => [`${candidate.rootId}:${candidate.relativePath}`, candidate] as const),
      );
      const requestedKeys = new Set<string>();
      const selected = input.candidates.map((candidate) => {
        const key = `${candidate.rootId}:${candidate.relativePath}`;
        if (requestedKeys.has(key)) throw new Error('清单候选已变化，请重新预览');
        requestedKeys.add(key);
        const current = readyByPath.get(key);
        if (!current || current.name !== candidate.name || current.group !== candidate.group) {
          throw new Error('清单候选已变化，请重新预览');
        }
        return current;
      });

      for (const candidate of selected) {
        if (!candidate.rootId || !candidate.relativePath) throw new Error('清单候选已变化，请重新预览');
        repositories.push(
          await appendRepositoryConfig(config, {
            rootId: candidate.rootId,
            relativePath: candidate.relativePath,
            name: candidate.name,
            group: candidate.group,
          }),
        );
      }
      return config;
    });
    reply.status(201);
    return { repositories };
  });

  app.post('/api/repositories', async (request, reply) => {
    const input = addRepositorySchema.parse(request.body);
    let repository!: RepositoryConfig;
    await updateRepositories(async (config) => {
      repository = await appendRepositoryConfig(config, {
        rootId: input.rootId,
        relativePath: input.relativePath,
        name: input.name ?? '',
        group: input.group,
        tags: input.tags,
      });
      return config;
    });
    reply.status(201);
    return repository;
  });

  app.patch('/api/repositories/:id/config', async (request) => {
    const id = (request.params as { id: string }).id;
    const update = updateRepositorySchema.parse(request.body);
    const config = await updateRepositories((currentConfig) => {
      const index = currentConfig.repositories.findIndex((repository) => repository.id === id);
      if (index < 0) throw new Error('仓库不存在');
      const current = currentConfig.repositories[index];
      if (!current) throw new Error('仓库配置损坏');
      currentConfig.repositories[index] = {
        ...current,
        ...update,
        capabilities: { ...current.capabilities, ...(update.capabilities ?? {}) },
      };
      return currentConfig;
    });
    const index = config.repositories.findIndex((repository) => repository.id === id);
    return config.repositories[index];
  });

  app.delete('/api/repositories/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    await updateRepositories((config) => {
      const nextRepositories = config.repositories.filter((repository) => repository.id !== id);
      if (nextRepositories.length === config.repositories.length) throw new Error('仓库不存在');
      config.repositories = nextRepositories;
      return config;
    });
    return { removed: id, deletedFromDisk: false };
  });

  app.post('/api/repositories/prune-missing', async (request): Promise<PruneMissingRepositoriesResult> => {
    const { ids } = pruneMissingRepositoriesSchema.parse(request.body);
    const requested = new Set(ids);
    const removed: string[] = [];
    const skipped: string[] = [];
    await updateRepositories(async (config) => {
      const retained: RepositoryConfig[] = [];
      for (const repository of config.repositories) {
        if (!requested.has(repository.id)) {
          retained.push(repository);
          continue;
        }
        try {
          // Re-verify the directory is genuinely gone before dropping the config entry;
          // a remounted drive or transient failure must not lose a real repository.
          await access(resolveRepositoryPath(config, repository));
          retained.push(repository);
          skipped.push(repository.id);
        } catch {
          removed.push(repository.id);
        }
      }
      config.repositories = retained;
      return config;
    });
    return { removed, skipped };
  });

  app.get('/api/operations', async () => {
    await synchronizeOperations();
    return operationsPayload();
  });
  app.get('/api/operations/events', (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    activeEventStreams.add(response);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 2000\n\n');
    let closed = false;
    let eventId = 0;
    let unsubscribe: () => void = () => {};
    const publishOperationsForSse = () => {
      if (closed || response.writableEnded) return;
      eventId += 1;
      response.write(`id: ${eventId}\nevent: operations\ndata: ${JSON.stringify(operationsPayload())}\n\n`);
    };
    const syncTimer = setInterval(() => {
      void synchronizeOperations()
        .then((changed) => {
          if (changed) publishOperationsForSse();
        })
        .catch(() => undefined);
    }, 2_000);
    syncTimer.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(syncTimer);
      unsubscribe();
      activeEventStreams.delete(response);
    };
    const heartbeat = setInterval(() => {
      if (!closed && !response.writableEnded) response.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();
    unsubscribe = subscribeOperations((payload) => {
      if (closed || response.writableEnded) return;
      eventId += 1;
      response.write(`id: ${eventId}\nevent: operations\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    request.raw.once('aborted', close);
    response.once('close', close);
  });
  app.post('/api/batches', async (request, reply) => {
    const { type, repositoryIds } = batchRequestSchema.parse(request.body);
    const config = await loadRepositories();
    const enabledRepositories = config.repositories.filter((repository) => repository.enabled);
    let repositories = enabledRepositories;
    if (repositoryIds) {
      const requested = new Set(repositoryIds);
      if (requested.size !== repositoryIds.length) throw new Error('批量仓库列表包含重复项');
      const enabledById = new Map(enabledRepositories.map((repository) => [repository.id, repository]));
      repositories = repositoryIds.map((id) => {
        const repository = enabledById.get(id);
        if (!repository) throw new Error(`批量仓库范围包含未知或已禁用项：${id}`);
        return repository;
      });
    }
    const batch = startBatch(repositories, type, config.settings.networkConcurrency, async (queuedRepository) => {
      const { config: freshConfig, repository, absolutePath } = await managedRepository(queuedRepository.id);
      if (!repository.capabilities[type]) {
        return { result: null, message: `仓库配置禁止 ${type} 操作`, skipped: true, skipReason: 'disabled' as const };
      }
      try {
        if (type === 'fetch') {
          const status = await fetchRepository(freshConfig, repository, absolutePath);
          return {
            result: status,
            message: fetchResultMessage(status),
          };
        }
        const output =
          type === 'pull'
            ? await pullRepository(freshConfig, repository, absolutePath)
            : await pushRepository(freshConfig, repository, absolutePath);
        return {
          result: output.status,
          message: output.message,
          skipped: output.skipped,
          skipReason: output.skipReason,
        };
      } catch (error) {
        if (type !== 'fetch' && isBatchSafetySkip(type, error)) {
          return {
            result: null,
            message: error instanceof Error ? error.message : `安全 ${type} 已跳过`,
            skipped: true,
            skipReason: 'blocked',
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
    return runOperation(repository, 'fetch', async () => {
      const status = await fetchRepository(config, repository, absolutePath);
      return { result: status, message: fetchResultMessage(status) };
    });
  });
  app.post('/api/repositories/:id/pull', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'pull', async () => {
      const output = await pullRepository(config, repository, absolutePath);
      return {
        result: output.status,
        message: output.message,
        skipped: output.skipped,
        skipReason: output.skipReason,
      };
    });
  });
  app.post('/api/repositories/:id/push', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'push', async () => {
      const output = await pushRepository(config, repository, absolutePath);
      return {
        result: output.status,
        message: output.message,
        skipped: output.skipped,
        skipReason: output.skipReason,
      };
    });
  });

  app.get('/api/repositories/:id/branches', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return listBranches(absolutePath);
  });
  app.get('/api/repositories/:id/upstream/repair', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return upstreamRepairPlan(config, repository, absolutePath);
  });
  app.post('/api/repositories/:id/upstream', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = upstreamRepairSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (input.mode === 'track') {
      return runOperation(repository, 'set-upstream', async () => {
        const result = await trackExistingUpstream(config, repository, absolutePath, input);
        return { result, message: `已关联 upstream：${result.upstream}` };
      });
    }
    return runOperation(repository, 'push', async () => {
      const output = await publishCurrentBranch(config, repository, absolutePath, input);
      return {
        result: output.result,
        message: output.changedDuringPush
          ? `首次 Push 完成并关联 ${output.result.upstream}；Push 期间本地分支或 HEAD 已变化`
          : `首次 Push 完成并关联 upstream：${output.result.upstream}`,
      };
    });
  });
  app.get('/api/repositories/:id/commits', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return { commits: await listRecentCommits(absolutePath) };
  });
  app.post('/api/repositories/:id/branches/switch', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = switchBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw new Error('仓库配置禁止切换分支');
    return runOperation(repository, 'switch-branch', async () => {
      const branches = await switchBranch(absolutePath, input);
      const [status, files] = await Promise.all([
        scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]),
        listRepositoryFiles(id, absolutePath),
      ]);
      if (!status) throw new Error('切换后无法读取仓库状态');
      return {
        result: { status, files, branches },
        message: `已切换到 ${branches.currentBranch ?? 'DETACHED HEAD'}`,
      };
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
  app.post('/api/repositories/:id/stashes/drop', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = applyStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw new Error('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await dropStash(absolutePath, input.ref, input.expectedHash);
      const [stashes, status] = await Promise.all([
        listStashes(absolutePath),
        scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]),
      ]);
      return {
        result: { stash, stashes, status },
        message: `${stash.ref} 已永久删除`,
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
    return withRepositoryLock(repository.id, async () => {
      await stageFiles(absolutePath, resolveFileIds(id, fileIds));
      return { files: await listRepositoryFiles(id, absolutePath), status: await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]) };
    });
  });
  app.post('/api/repositories/:id/unstage', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileIds } = fileSelectionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw new Error('仓库配置禁止 Unstage');
    return withRepositoryLock(repository.id, async () => {
      await unstageFiles(absolutePath, resolveFileIds(id, fileIds));
      return { files: await listRepositoryFiles(id, absolutePath), status: await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]) };
    });
  });
  app.post('/api/repositories/:id/files/discard', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileId } = fileActionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw new Error('仓库配置禁止文件修改');
    return withRepositoryLock(repository.id, async () => {
      const currentFiles = await listRepositoryFiles(id, absolutePath);
      const file = resolveCurrentFileAction(id, fileId, currentFiles);
      const result = await discardFileChange(absolutePath, file, movePathToTrash);
      return {
        result,
        files: await listRepositoryFiles(id, absolutePath),
        status: await scanRepositories({ ...config, repositories: [repository] }).then((items) => items[0]),
      };
    });
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
    const input = commitSuggestionRequestSchema.parse(request.body);
    const { repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw new Error('仓库配置禁止 Commit');
    const [preview, profile] = await Promise.all([commitPreview(absolutePath), loadProfile()]);
    if (preview.fingerprint !== input.fingerprint) throw new Error('暂存区已变化，请重新预览后生成文案');
    const suggestion = await suggestCommit(absolutePath, repository, preview, profile.profile.preferredCommitLanguage);
    if (await stagedFingerprint(absolutePath) !== input.fingerprint) {
      throw new Error('暂存区已变化，请重新预览后生成文案');
    }
    return suggestion;
  });
  app.post('/api/repositories/:id/commit', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = commitRequestSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw new Error('仓库配置禁止 Commit');
    return commitWithOptionalPush(config, repository, absolutePath, input.pushAfterCommit, async () => {
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
    return commitWithOptionalPush(config, repository, absolutePath, input.pushAfterCommit, async () => {
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

  const clientRoot = resolveClientRoot();
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
