import { access, realpath, stat } from 'node:fs/promises';
import { mapWithConcurrency } from './concurrency.js';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
  import type {
    BranchesSnapshot,
    CloneRepositoryResult,
    LastCommitSnapshot,
    PruneMissingRepositoriesResult,
  RemoteProtocolBatchResult,
    RepositoriesConfig,
    RepositoryConfig,
    RepositoryRemotesSnapshot,
    RepositoryRootMutationResult,
    StashEntry,
  } from '../shared/contracts.js';
import { createUniqueRootId } from '../shared/root-identity.js';
import { mergePausedErrorCode } from '../shared/contracts.js';
import {
  addRepositorySchema,
  analyticsQuerySchema,
  addRootSchema,
  applyStashSchema,
  applyHunksSchema,
  assumeUnchangedSchema,
  autoCommitRequestSchema,
  batchRequestSchema,
  checkoutRemoteBranchSchema,
  commitHashParamsSchema,
  commitDetailQuerySchema,
  commitPageQuerySchema,
  branchComparisonQuerySchema,
  revisionTreeQuerySchema,
  revisionFileQuerySchema,
  reflogQuerySchema,
  commitRequestSchema,
  commitSuggestionRequestSchema,
  createBranchSchema,
  createStashSchema,
  createTagSchema,
  deleteBranchSchema,
  deleteRemoteBranchSchema,
  deleteRemoteTagSchema,
  deleteTagSchema,
  directoryPickerSchema,
  fileActionSchema,
  fileSelectionSchema,
  addRepositoryRemoteSchema,
  amendCommitSchema,
  cloneRepositorySchema,
  ignoreRuleSchema,
  nativeFolderPickerSchema,
  mergePreviewSchema,
  mergeBranchSchema,
  syncPullSchema,
  openRepositorySchema,
  profileUpdateSchema,
  pruneMissingRepositoriesSchema,
  pushTagSchema,
  removeIgnoreRuleSchema,
  removeRemoteCredentialSchema,
  remoteProtocolBatchSchema,
  remoteProtocolSchema,
  renameBranchSchema,
  removeRepositoryRemoteSchema,
  renameRepositoryRemoteSchema,
  replayCommitSchema,
  repositoryManifestImportSchema,
  repositoryManifestPreviewSchema,
  resolveConflictSchema,
  saveRemoteCredentialSchema,
  scanRootSchema,
  setRepositoryRemoteUrlSchema,
  switchBranchSchema,
  themeUpdateSchema,
  unignoreFileSchema,
  undoCommitSchema,
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
import { AppError, conflictError, invalidRequestError, isAppError, notFoundError, safetyBlockedError } from './errors.js';
import { fetchRepository, pullRepository, pushRepository, syncRepository } from './git/actions.js';
import { listRemoteCredentialHosts, removeRemoteCredential, saveRemoteCredential } from './git/credentials.js';
import { switchRemoteProtocol } from './git/remote-protocol.js';
import { applyRemoteChange, listRemotes, readRemoteNames } from './git/remotes.js';
import { amendCommit, readLastCommitSnapshot, undoLastCommit } from './git/rewrite.js';
import { cherryPickCommit, revertCommit } from './git/replays.js';
import { cloneRepositoryIntoRoot } from './git/clone.js';
import { protocolLabel } from '../shared/remote-url.js';
import { branchDeletionPreview, checkoutRemoteBranch, createBranch, deleteBranch, listBranches, renameBranch, switchBranch } from './git/branches.js';
import { deleteRemoteBranch, deleteRemoteTag } from './git/remote-deletions.js';
import { commitDetail } from './git/commits.js';
import { readHistoryPage } from './git/history-reader.js';
import { readBranchComparison } from './git/comparison.js';
import { readRevisionTree, readRevisionFile, readFileBlame } from './git/revision-files.js';
import { readReflogPage } from './git/reflog.js';
import { readConflictPreview } from './git/conflict-preview.js';
import { mergeBranch, previewBranchMerge } from './git/merge.js';
import { abortRepositoryOperation, continueRepositoryOperation, resolveConflictFile } from './git/conflicts.js';
import { applyFileHunks } from './git/hunks.js';
import { createTag, deleteTag, listRemoteTagNames, listTags, pushTag } from './git/tags.js';
import { commitWithOptionalPush } from './git/commit-push.js';
import {
  commitPreview,
  commitStaged,
  discardFileChange,
  fileDiff,
  listIgnoredEntries,
  listRepositoryFiles,
  resolveCurrentFileAction,
  resolveFileIds,
  safeRepositoryPath,
  stageFiles,
  stagedFingerprint,
  unstageFiles,
} from './git/files.js';
import { appendIgnoreRule, deriveIgnorePattern, ignoreSourceTarget, locateIgnoreRule, readIgnoreFiles, removeIgnoreRule, resolveIgnoreFile } from './git/ignore.js';
import { listMarkedFiles, setAssumeUnchanged } from './git/assume-unchanged.js';
import { scanRepository, scanRoot } from './git/scanner.js';
import { previewPackagesManifest } from './import/packages.js';
import { runGitLine, runGitText } from './git/runner.js';
import { applyStash, createStash, dropStash, listStashes, popStash, stashDetail } from './git/stash.js';
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
import { aggregateCommitHeatmap } from './analytics/heatmap.js';
import { appendRepositoryConfig } from './repositories/service.js';
import { compareRepositoryActivity, compareRepositoryPinning } from '../shared/repository-pinning.js';
import { fetchResultMessage } from '../shared/fetch-result.js';
import { registerLocalSessionSecurity } from './security/session.js';
import { pickFolder } from './native/folder-picker.js';
import { openRepositoryLocation } from './system/open.js';
import { selectDirectory } from './system/directory-picker.js';
import { readSystemClipboard } from './system/clipboard.js';
import { movePathToTrash } from './system/trash.js';
import { checkLatestRelease } from './system/release-feed.js';
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
  if (!repository) throw notFoundError('仓库不存在');
  const rootPath = await resolveRoot(config, repository.root);
  const configuredPath = resolveRepositoryPath(config, repository);
  // 目录被外部移动或删除时 realpath 抛的是 ENOENT，直接把 errno 透出去，用户会看到
  // 「ENOENT: no such file or directory, realpath '/private/var/…'」——既有内部路径，
  // 也没说该做什么。换成能指导操作的说法，同时保留路径方便排查。
  const absolutePath = await realpath(configuredPath).catch(() => {
    throw notFoundError(`仓库目录不存在：${configuredPath}。它可能已被移动或删除，请重新接入这个仓库。`);
  });
  if (!isPathInside(rootPath, absolutePath)) throw invalidRequestError('仓库路径超出允许的根目录');
  const topLevelRaw = await runGitLine(absolutePath, ['rev-parse', '--show-toplevel']).catch(
    (error: unknown) => {
      // 目录还在、但 .git 被删掉时 git 报的是英文 fatal。只改写这一种，超时等其它失败保持原样，
      // 否则「git 卡住」会被误报成「不是仓库」。
      const message = error instanceof Error ? error.message : '';
      if (/not a git repository/i.test(message)) {
        throw invalidRequestError('这个目录已经不是一个 Git 仓库了（找不到 .git 目录），请重新接入。');
      }
      throw error;
    },
  );
  const topLevel = await realpath(topLevelRaw);
  if (topLevel !== absolutePath) throw invalidRequestError('仓库配置路径不是 Git worktree 根目录');
  return { config, repository, absolutePath };
}

/** 分支类写操作统一返回最新的仓库状态与文件列表，避免每个路由重复取数。 */
async function branchOperationResult(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  absolutePath: string,
  branches: BranchesSnapshot,
) {
  const [status, files] = await Promise.all([
    scanRepository(config, repository),
    listRepositoryFiles(repository.id, absolutePath),
  ]);
  return { status, files, branches };
}

/**
 * 文件清单与仓库状态互不依赖，并发读。
 *
 * 这两项在写操作之后总是成对返回，原先 7 条路由各自写两行串行 `await`，
 * 在同一把仓库锁里白等一个来回。锁仍然覆盖两次读取，只是不再排队。
 */
async function readFilesAndStatus(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  absolutePath: string,
) {
  const [files, status] = await Promise.all([
    listRepositoryFiles(repository.id, absolutePath),
    scanRepository(config, repository),
  ]);
  return { files, status };
}

/**
 * Stash 写操作之后的统一取数：新的 Stash 列表 + 仓库状态。
 *
 * 四个 Stash 路由（创建 / 应用 / 弹出 / 删除）原先各自抄了一遍这两行，差别只有
 * 提示文案。取数顺序在这里定死，避免以后某个路由只刷新列表不刷新状态。
 */
async function stashResult(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
  absolutePath: string,
  stash: StashEntry,
) {
  const [stashes, status] = await Promise.all([
    listStashes(absolutePath),
    scanRepository(config, repository),
  ]);
  return { result: { stash, stashes, status } };
}

/**
 * 批量操作遇到「前置条件未满足」时记为跳过而不是失败。
 * 已类型化的错误直接读标记，文案不再参与判定；未转换的抛出点继续按文案兜底。
 */
export function isBatchSafetySkip(type: 'pull' | 'push', error: unknown): boolean {
  if (error instanceof AppError) return error.safetyBlocked;
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
  return [...common, ...(type === 'push' ? push : pull)].some((reason) => message.includes(reason));
}

export function classifyErrorStatus(error: unknown): number {
  if (error instanceof AppError) return error.statusCode;
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  if (error instanceof ZodError) return 400;
  // 兜底：尚未类型化的抛出点（主要是 AI 会话与本机系统模块）沿用原有文案匹配。
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
const machineReadableErrorCodes = new Set<string>([legacyVaultErrorCode, mergePausedErrorCode]);

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
  // 只读、无副作用，失败也返回结构化原因（见 release-feed.ts），所以不需要写操作护栏。
  app.get('/api/update-check', async () => checkLatestRelease());
  app.get('/api/dashboard', dashboardPayload);
  app.get('/api/repositories', dashboardPayload);
  app.post('/api/repositories/refresh', dashboardPayload);
  // 只读、无副作用，失败也按「该仓库无提交」降级，所以不需要写操作护栏。
  // 刻意不接 dashboard 扫描：热力图只要 git log，跑 git status / ahead-behind 是纯浪费。
  // `weeks` 非法时回落到默认（近一年），不报 400：这是纯读接口，参数写错时
  // 给一张默认范围的图，比给调用方一个错误更符合预期。
  // 仓库范围则严格验证：非法选择不能静默扩大为全部仓库。
  app.get('/api/analytics/heatmap', async (request) => {
    const options = analyticsQuerySchema.parse(request.query);
    return aggregateCommitHeatmap(await loadRepositories(), options);
  });

  app.get('/api/settings/profile', loadProfile);
  app.put('/api/settings/profile', async (request) => {
    const profile = profileUpdateSchema.parse(request.body);
    return updateProfile((current) => ({ ...current, profile }));
  });
  app.patch('/api/settings/theme', async (request) => {
    const { theme } = themeUpdateSchema.parse(request.body);
    return updateProfile((current) => ({ ...current, profile: { ...current.profile, theme } }));
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

  // —— 远端访问凭证 ——
  // 凭证按 host 存取，与终端、其它 Git 客户端共享同一份系统钥匙串记录。
  // 这里只做「读状态 / 写入 / 擦除」，不做任何自动重试——重试由前端在用户确认后触发。
  // 逐仓读取 remote 会各起一个 git 进程，因此并发与本地扫描用同一个上限。
  app.get('/api/credentials', async () => {
    const config = await loadRepositories();
    return listRemoteCredentialHosts(
      config.repositories.filter((repository) => repository.enabled),
      (repository) => resolveRepositoryPath(config, repository),
      config.settings.defaultRemote,
      config.settings.localScanConcurrency,
    );
  });
  app.put('/api/credentials', async (request) => {
    const input = saveRemoteCredentialSchema.parse(request.body);
    await saveRemoteCredential(input);
    return { host: input.host.trim().toLowerCase(), stored: true };
  });
  app.delete('/api/credentials', async (request) => {
    const { host } = removeRemoteCredentialSchema.parse(request.query ?? {});
    return { host: host.trim().toLowerCase(), removed: await removeRemoteCredential(host) };
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
    if (!(await stat(canonicalPath)).isDirectory()) throw invalidRequestError('仓库根目录必须是目录');
    let rootId = '';
    let created = false;
    const config = await updateRepositories((current) => {
      const existingRoot = Object.entries(current.settings.roots).find(([, configuredPath]) => configuredPath === canonicalPath);
      if (existingRoot) {
        [rootId] = existingRoot;
        return current;
      }
      rootId = input.id ?? createUniqueRootId(canonicalPath, Object.keys(current.settings.roots));
      if (current.settings.roots[rootId]) throw conflictError(`根目录标识已存在：${rootId}`);
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
        throw conflictError('仍有仓库使用该根目录，请先移出对应仓库');
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
        if (requestedKeys.has(key)) throw conflictError('清单候选已变化，请重新预览');
        requestedKeys.add(key);
        const current = readyByPath.get(key);
        if (!current || current.name !== candidate.name || current.group !== candidate.group) {
          throw conflictError('清单候选已变化，请重新预览');
        }
        return current;
      });

      for (const candidate of selected) {
        if (!candidate.rootId || !candidate.relativePath) throw conflictError('清单候选已变化，请重新预览');
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

  /**
   * 克隆远端仓库到已登记的根目录，并登记进配置。
   *
   * 接入仓库此前只能登记「已存在的本地路径」（`appendRepositoryConfig` 会先 realpath
   * 确认目录存在），想 clone 一个新仓库只能回终端——界面文案甚至写着
   * 「先在 Gitee / GitHub 建一个空的私有仓库…clone 到本机，再回来选中它」。
   *
   * 不写操作记录：克隆时目标仓库还不存在（没有可归属的 id），
   * 与「扫描根目录」「导入清单」一样属于**接入流程**，不是对已有仓库的操作。
   */
  app.post('/api/repositories/clone', async (request, reply) => {
    const input = cloneRepositorySchema.parse(request.body);
    const config = await loadRepositories();
    const cloned = await cloneRepositoryIntoRoot(config, input);
    let repository!: RepositoryConfig;
    await updateRepositories(async (current) => {
      repository = await appendRepositoryConfig(current, {
        rootId: input.rootId,
        relativePath: cloned.directory,
        name: input.name?.trim() || cloned.directory,
        group: input.group?.trim() || '未分组',
        tags: [],
      });
      return current;
    });
    reply.status(201);
    return { repository, directory: cloned.directory } satisfies CloneRepositoryResult;
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
      if (index < 0) throw notFoundError('仓库不存在');
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
      if (nextRepositories.length === config.repositories.length) throw notFoundError('仓库不存在');
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
      if (requested.size !== repositoryIds.length) throw invalidRequestError('批量仓库列表包含重复项');
      const enabledById = new Map(enabledRepositories.map((repository) => [repository.id, repository]));
      repositories = repositoryIds.map((id) => {
        const repository = enabledById.get(id);
        if (!repository) throw invalidRequestError(`批量仓库范围包含未知或已禁用项：${id}`);
        return repository;
      });
    }
    const batch = startBatch(repositories, type, config.settings.networkConcurrency, async (queuedRepository) => {
      const { config: freshConfig, repository, absolutePath } = await managedRepository(queuedRepository.id);
      const capabilityBlocked = !repository.capabilities[type];
      if (capabilityBlocked) {
        return { result: null, message: `仓库配置禁止 ${type} 操作`, skipped: true, skipReason: 'disabled' as const };
      }
      // 没有远端的仓库不是「坏了」，批量里跳过即可：算成失败会让「需处理」永远归不了零。
      if (!(await readRemoteNames(absolutePath)).includes(freshConfig.settings.defaultRemote)) {
        return { result: null, message: `仓库没有配置 ${freshConfig.settings.defaultRemote} 远端，已跳过`, skipped: true, skipReason: 'not-needed' as const };
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
    const { stashFirst, rebase } = syncPullSchema.parse(request.body ?? {});
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'pull', async () => {
      const output = await pullRepository(config, repository, absolutePath, { stashFirst, rebase });
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
  app.post('/api/repositories/:id/sync', async (request) => {
    const id = (request.params as { id: string }).id;
    const { stashFirst, rebase } = syncPullSchema.parse(request.body ?? {});
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'sync', async () => {
      const output = await syncRepository(config, repository, absolutePath, { stashFirst, rebase });
      return {
        result: output.status,
        message: output.message,
        skipped: output.skipped,
        skipReason: output.skipReason,
      };
    });
  });

  app.post('/api/repositories/:id/remote-protocol', async (request) => {
    const id = (request.params as { id: string }).id;
    const { target, verify } = remoteProtocolSchema.parse(request.body ?? {});
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'remote-protocol', async () => {
      const output = await switchRemoteProtocol(config, repository, absolutePath, target, { verify });
      const suffix =
        output.verification === 'reachable'
          ? '（连通性已校验）'
          : output.verification === 'needs-credential'
            ? `（${output.note}）`
            : `（${output.note ?? '未校验连通性'}）`;
      return {
        result: {
          status: output.status,
          from: output.from,
          to: output.to,
          verification: output.verification,
          note: output.note,
        },
        message: `远端已切换为 ${protocolLabel(target)}：${output.to}${suffix}`,
      };
    });
  });

  /**
   * 批量切换远端协议。切换是纯本地 `.git/config` 改写（无网络），
   * 但探活会联网，因此不进 batch 队列，直接并发处理并在一个响应里给出逐仓结果。
   */
  app.post('/api/repositories/remote-protocol', async (request) => {
    const { target, repositoryIds, verify } = remoteProtocolBatchSchema.parse(request.body);
    const config = await loadRepositories();
    const enabledRepositories = config.repositories.filter((repository) => repository.enabled);
    const requested = new Set(repositoryIds);
    if (requested.size !== repositoryIds.length) throw invalidRequestError('批量仓库列表包含重复项');
    const enabledById = new Map(enabledRepositories.map((repository) => [repository.id, repository]));
    const repositories = repositoryIds.map((id) => {
      const repository = enabledById.get(id);
      if (!repository) throw invalidRequestError(`批量范围包含未知或已禁用项：${id}`);
      return repository;
    });

    const result: RemoteProtocolBatchResult = { target, switched: [], skipped: [], failed: [] };
    await mapWithConcurrency(repositories, 4, async (queued) => {
      try {
        const { config: freshConfig, repository, absolutePath } = await managedRepository(queued.id);
        const output = await switchRemoteProtocol(freshConfig, repository, absolutePath, target, { verify });
        result.switched.push({
          id: repository.id,
          name: repository.name,
          from: output.from,
          to: output.to,
          verification: output.verification,
        });
      } catch (error) {
        const name = queued.name;
        // 「已经是对应协议」「含自定义端口」这类是正常的无操作，记为跳过而不是失败。
        if (isAppError(error) && (error.safetyBlocked || error.kind === 'invalid-request')) {
          result.skipped.push({ id: queued.id, name, reason: error.message });
          return;
        }
        result.failed.push({
          id: queued.id,
          name,
          message: error instanceof Error ? error.message : '切换远端协议失败',
        });
      }
    });
    return result;
  });

  /**
   * —— 远端（remote）管理 ——
   *
   * 舰队级操作（fetch / pull / push / 协议切换）全部以配置里的默认远端为目标，但此前
   * 没有任何入口能修改远端本身：仓库没有 `origin`、或地址写错时，前置校验会挡住所有
   * 联网操作而应用内无解。协议切换只解决「协议不同」，解决不了「地址不对」。
   *
   * 这些操作只改本机 `.git/config`，不碰远端服务器；每次都进操作记录（与协议切换一致）。
   */
  app.get('/api/repositories/:id/remotes', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, absolutePath } = await managedRepository(id);
    return {
      defaultRemote: config.settings.defaultRemote,
      remotes: await listRemotes(absolutePath, config.settings.defaultRemote),
    } satisfies RepositoryRemotesSnapshot;
  });

  app.post('/api/repositories/:id/remotes', async (request) => {
    const id = (request.params as { id: string }).id;
    const { name, url } = addRepositoryRemoteSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'remote', async () => {
      const { message, ...result } = await applyRemoteChange(config, repository, absolutePath, {
        kind: 'add',
        name,
        url,
      });
      return { result, message: `${message}：${url}` };
    });
  });

  app.post('/api/repositories/:id/remotes/url', async (request) => {
    const id = (request.params as { id: string }).id;
    const { name, url } = setRepositoryRemoteUrlSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'remote', async () => {
      const { message, ...result } = await applyRemoteChange(config, repository, absolutePath, {
        kind: 'url',
        name,
        url,
      });
      return { result, message };
    });
  });

  app.post('/api/repositories/:id/remotes/rename', async (request) => {
    const id = (request.params as { id: string }).id;
    const { name, nextName } = renameRepositoryRemoteSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'remote', async () => {
      const { message, ...result } = await applyRemoteChange(config, repository, absolutePath, {
        kind: 'rename',
        name,
        nextName,
      });
      return { result, message };
    });
  });

  app.post('/api/repositories/:id/remotes/remove', async (request) => {
    const id = (request.params as { id: string }).id;
    const { name } = removeRepositoryRemoteSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'remote', async () => {
      const { message, ...result } = await applyRemoteChange(config, repository, absolutePath, {
        kind: 'remove',
        name,
      });
      return { result, message };
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
    const input = commitPageQuerySchema.parse(request.query ?? {});
    const { absolutePath } = await managedRepository(id);
    return readHistoryPage(absolutePath, input);
  });
  app.get('/api/repositories/:id/commits/:hash', async (request) => {
    const id = (request.params as { id: string }).id;
    const { hash } = commitHashParamsSchema.parse(request.params);
    const { filePath } = commitDetailQuerySchema.parse(request.query ?? {});
    const { absolutePath } = await managedRepository(id);
    return commitDetail(absolutePath, hash, filePath);
  });
  app.get('/api/repositories/:id/comparison', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = branchComparisonQuerySchema.parse(request.query ?? {});
    const { absolutePath } = await managedRepository(id);
    return readBranchComparison(absolutePath, input);
  });
  app.get('/api/repositories/:id/tree', async (request) => {
    const { absolutePath } = await managedRepository((request.params as { id: string }).id);
    return readRevisionTree(absolutePath, revisionTreeQuerySchema.parse(request.query ?? {}));
  });
  app.get('/api/repositories/:id/revision-file', async (request) => {
    const { absolutePath } = await managedRepository((request.params as { id: string }).id);
    return readRevisionFile(absolutePath, revisionFileQuerySchema.parse(request.query ?? {}));
  });
  app.get('/api/repositories/:id/blame', async (request) => {
    const { absolutePath } = await managedRepository((request.params as { id: string }).id);
    return readFileBlame(absolutePath, revisionFileQuerySchema.parse(request.query ?? {}));
  });
  app.get('/api/repositories/:id/reflog', async (request) => {
    const { absolutePath } = await managedRepository((request.params as { id: string }).id);
    return readReflogPage(absolutePath, reflogQuerySchema.parse(request.query ?? {}));
  });
  app.get('/api/repositories/:id/conflicts/preview', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileId } = fileActionSchema.parse(request.query);
    const { absolutePath } = await managedRepository(id);
    const file = resolveCurrentFileAction(id, fileId, await listRepositoryFiles(id, absolutePath));
    if (!file.conflicted) throw conflictError('该文件当前没有未解决的冲突，请刷新后重试');
    return readConflictPreview(absolutePath, file.path);
  });
  app.post('/api/repositories/:id/branches/switch', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = switchBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止切换分支');
    return runOperation(repository, 'switch-branch', async () => {
      const branches = await switchBranch(absolutePath, input);
      return {
        result: await branchOperationResult(config, repository, absolutePath, branches),
        message: `已切换到 ${branches.currentBranch ?? 'DETACHED HEAD'}`,
      };
    });
  });
  app.post('/api/repositories/:id/branches/merge-preview', async (request) => {
    const input = mergePreviewSchema.parse(request.body);
    const { repository, absolutePath } = await managedRepository((request.params as { id: string }).id);
    const preview = await withRepositoryLock(repository.id, () => previewBranchMerge(absolutePath, input));
    if (!repository.capabilities.stage || !repository.capabilities.commit) preview.blocker = '仓库配置禁止合并分支';
    return preview;
  });
  app.post('/api/repositories/:id/branches/merge', async (request) => {
    const input = mergeBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository((request.params as { id: string }).id);
    if (!repository.capabilities.stage || !repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止合并分支');
    return runOperation(repository, 'merge', async () => {
      const outcome = await mergeBranch(absolutePath, input);
      const merged = outcome.skipped ? '当前分支已包含来源分支的全部提交' : `已将 ${input.source.name} 合并到 ${input.expectedBranch}`;
      return {
        result: {
          ...(await branchOperationResult(config, repository, absolutePath, await listBranches(absolutePath))),
          stashed: outcome.stashed,
        },
        message: outcome.stashed ? `已把改动存入 ${outcome.stashed.ref}，${merged}` : merged,
        skipped: outcome.skipped,
        skipReason: 'not-needed' as const,
      };
    });
  });
  app.post('/api/repositories/:id/branches/create', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = createBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止分支管理');
    return runOperation(repository, 'branch', async () => {
      const branches = await createBranch(absolutePath, input);
      return {
        result: await branchOperationResult(config, repository, absolutePath, branches),
        message: input.checkout ? `已创建并切换到 ${input.branch}` : `已创建本地分支 ${input.branch}`,
      };
    });
  });
  app.post('/api/repositories/:id/branches/rename', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = renameBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止分支管理');
    return runOperation(repository, 'branch', async () => {
      const branches = await renameBranch(absolutePath, input);
      return {
        result: await branchOperationResult(config, repository, absolutePath, branches),
        message: `分支 ${input.branch} 已重命名为 ${input.nextBranch}`,
      };
    });
  });
  app.post('/api/repositories/:id/branches/delete-preview', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = deleteBranchSchema.parse(request.body);
    const { repository, absolutePath } = await managedRepository(id);
    return withRepositoryLock(repository.id, async () => ({ preview: await branchDeletionPreview(absolutePath, input) }));
  });
  app.post('/api/repositories/:id/branches/delete', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = deleteBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止分支管理');
    return runOperation(repository, 'branch', async () => {
      const { snapshot, backupTag } = await deleteBranch(absolutePath, input);
      return {
        result: { ...(await branchOperationResult(config, repository, absolutePath, snapshot)), backupTag },
        message: input.force
          ? `已强制删除本地分支 ${input.branch}${backupTag ? `；删除前已备份为标签 ${backupTag}` : '（提交只留在 reflog 里）'}`
          : `已删除本地分支 ${input.branch}`,
      };
    });
  });
  app.post('/api/repositories/:id/branches/delete-remote', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = deleteRemoteBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.push) throw safetyBlockedError('仓库配置禁止远端写入');
    return runOperation(repository, 'branch', async () => {
      const result = await deleteRemoteBranch(absolutePath, input);
      return {
        result: { ...(await branchOperationResult(config, repository, absolutePath, await listBranches(absolutePath))), deleted: result },
        message: `已删除远端分支 ${result.remote}/${result.branch}；本地同名分支未受影响`,
      };
    });
  });
  app.post('/api/repositories/:id/branches/checkout-remote', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = checkoutRemoteBranchSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止分支管理');
    return runOperation(repository, 'branch', async () => {
      const branches = await checkoutRemoteBranch(absolutePath, input);
      return {
        result: await branchOperationResult(config, repository, absolutePath, branches),
        message: `已检出 ${input.remote}/${input.branch} 并跟踪到本地分支 ${input.localBranch}`,
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
  app.get('/api/repositories/:id/stashes/:hash/patch', async (request) => {
    const id = (request.params as { id: string }).id;
    const { hash } = commitHashParamsSchema.parse(request.params);
    const { absolutePath } = await managedRepository(id);
    return stashDetail(absolutePath, hash);
  });
  app.post('/api/repositories/:id/stashes', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = createStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw safetyBlockedError('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await createStash(absolutePath, input.message, input.includeUntracked);
      return {
        ...(await stashResult(config, repository, absolutePath, stash)),
        message: `${stash.ref} 已创建，工作区改动已安全备份`,
      };
    });
  });
  app.post('/api/repositories/:id/stashes/apply', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = applyStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw safetyBlockedError('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await applyStash(absolutePath, input.ref, input.expectedHash);
      return {
        ...(await stashResult(config, repository, absolutePath, stash)),
        message: `${stash.ref} 已应用，原 Stash 条目仍保留`,
      };
    });
  });
  app.post('/api/repositories/:id/stashes/drop', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = applyStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw safetyBlockedError('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await dropStash(absolutePath, input.ref, input.expectedHash);
      return {
        ...(await stashResult(config, repository, absolutePath, stash)),
        message: `${stash.ref} 已永久删除`,
      };
    });
  });
  app.post('/api/repositories/:id/stashes/pop', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = applyStashSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stash) throw safetyBlockedError('仓库配置禁止 Stash');
    return runOperation(repository, 'stash', async () => {
      const stash = await popStash(absolutePath, input.ref, input.expectedHash);
      return {
        ...(await stashResult(config, repository, absolutePath, stash)),
        message: `${stash.ref} 已应用到工作区，并从列表中删除`,
      };
    });
  });
  app.post('/api/repositories/:id/open', async (request) => {
    const id = (request.params as { id: string }).id;
    const { target, fileId, ignoreFile } = openRepositorySchema.parse(request.body);
    const { absolutePath } = await managedRepository(id);
    let filePath: string | undefined;
    if (fileId) {
      const [relativePath] = resolveFileIds(id, [fileId]);
      if (!relativePath) throw notFoundError('文件不存在');
      safeRepositoryPath(absolutePath, relativePath);
      filePath = path.resolve(absolutePath, relativePath);
    } else if (ignoreFile) {
      // 目标文件由固定枚举推导（`.gitignore` / `info/exclude`），没有浏览器可控的路径片段；
      // 不套用 safeRepositoryPath——它按「仓库内相对路径」设计，`info/exclude` 的绝对路径会被误判。
      filePath = await resolveIgnoreFile(absolutePath, ignoreFile);
    }
    await openRepositoryLocation(target, absolutePath, filePath);
    return { opened: target };
  });
  app.get('/api/repositories/:id/diff', async (request) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { kind?: string; fileId?: string };
    if (!query.fileId || !['staged', 'unstaged'].includes(query.kind ?? '')) throw invalidRequestError('Diff 参数无效');
    const { absolutePath } = await managedRepository(id);
    const [relativePath] = resolveFileIds(id, [query.fileId]);
    if (!relativePath) throw notFoundError('文件不存在');
    const patch = await fileDiff(absolutePath, relativePath, query.kind as 'staged' | 'unstaged');
    return { path: relativePath, kind: query.kind, diff: patch.patch, truncated: patch.truncated };
  });
  app.post('/api/repositories/:id/stage', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileIds } = fileSelectionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止 Stage');
    return withRepositoryLock(repository.id, async () => {
      // 与 /discard 同一口径：先按**当前**工作区复核 token。
      // token 是内容寻址的，只说明「同一个 id 对应同一份内容」，不保证「调用时还是那份」；
      // 不复核就会把用户没在 diff 里看过的内容加进索引（编辑器保存、构建产物、另一个终端 checkout）。
      const currentFiles = await listRepositoryFiles(id, absolutePath);
      const files = fileIds.map((fileId) => resolveCurrentFileAction(id, fileId, currentFiles));
      // `git add` 会把未合并条目直接标成已解决——那是「解决冲突」，不是「暂存」。
      const conflicted = files.find((file) => file.conflicted);
      if (conflicted) throw safetyBlockedError(`先解决冲突再暂存：${conflicted.path}`);
      await stageFiles(absolutePath, files.map((file) => file.path));
      return readFilesAndStatus(config, repository, absolutePath);
    });
  });
  app.post('/api/repositories/:id/unstage', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileIds } = fileSelectionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止 Unstage');
    return withRepositoryLock(repository.id, async () => {
      await unstageFiles(absolutePath, resolveFileIds(id, fileIds));
      return readFilesAndStatus(config, repository, absolutePath);
    });
  });
  app.post('/api/repositories/:id/files/discard', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileId } = fileActionSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止文件修改');
    return withRepositoryLock(repository.id, async () => {
      const currentFiles = await listRepositoryFiles(id, absolutePath);
      const file = resolveCurrentFileAction(id, fileId, currentFiles);
      const result = await discardFileChange(absolutePath, file, movePathToTrash);
      return {
        result,
        ...(await readFilesAndStatus(config, repository, absolutePath)),
      };
    });
  });
  app.get('/api/repositories/:id/ignored', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    const result = await listIgnoredEntries(id, absolutePath);
    return { ignored: result.entries, truncated: result.truncated };
  });
  app.post('/api/repositories/:id/ignore', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = ignoreRuleSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止文件修改');
    return withRepositoryLock(repository.id, async () => {
      const currentFiles = await listRepositoryFiles(id, absolutePath);
      const file = resolveCurrentFileAction(id, input.fileId, currentFiles);
      const pattern = input.scope === 'custom'
        ? input.pattern!
        : deriveIgnorePattern(file.path, input.scope);
      const result = await appendIgnoreRule(absolutePath, input.target, pattern);
      return {
        result,
        ...(await readFilesAndStatus(config, repository, absolutePath)),
      };
    });
  });
  app.get('/api/repositories/:id/ignore-rules', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return { files: await readIgnoreFiles(absolutePath) };
  });
  app.post('/api/repositories/:id/ignore-rules/remove', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = removeIgnoreRuleSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止文件修改');
    return withRepositoryLock(repository.id, async () => {
      const result = await removeIgnoreRule(absolutePath, input.target, input.line, input.pattern);
      return {
        result,
        ...(await readFilesAndStatus(config, repository, absolutePath)),
      };
    });
  });
  app.post('/api/repositories/:id/ignore-rules/unignore', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileId } = unignoreFileSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止文件修改');
    return withRepositoryLock(repository.id, async () => {
      const [relativePath] = resolveFileIds(id, [fileId]);
      if (!relativePath) throw notFoundError('文件不存在');
      safeRepositoryPath(absolutePath, relativePath);
      // 被忽略的目录在注册表里带结尾 `/`；`check-ignore` 用不带斜杠的路径即可命中同一条规则。
      const located = await locateIgnoreRule(absolutePath, relativePath.replace(/\/+$/, ''));
      const target = await ignoreSourceTarget(absolutePath, located.source);
      // 规则来自嵌套 .gitignore 或全局 excludes 时不动任何文件，如实把来源告诉用户。
      const result = !target || located.line === null
        ? { removed: false, source: located.source, line: null, pattern: located.pattern, displayPath: null }
        : { ...(await removeIgnoreRule(absolutePath, target, located.line, located.pattern)), removed: true, source: located.source };
      return {
        result,
        message: result.removed
          ? `已移除忽略规则：${result.pattern}`
          : `这条规则来自 ${located.source}，请在对应的忽略文件里修改`,
        ...(await readFilesAndStatus(config, repository, absolutePath)),
      };
    });
  });
  app.get('/api/repositories/:id/assume-unchanged', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return { files: await listMarkedFiles(id, absolutePath) };
  });
  app.post('/api/repositories/:id/assume-unchanged', async (request) => {
    const id = (request.params as { id: string }).id;
    const { fileId, assumed } = assumeUnchangedSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止文件修改');
    return withRepositoryLock(repository.id, async () => {
      const [relativePath] = resolveFileIds(id, [fileId]);
      if (!relativePath) throw notFoundError('文件不存在');
      await setAssumeUnchanged(absolutePath, relativePath, assumed);
      const [files, marked, status] = await Promise.all([
        listRepositoryFiles(id, absolutePath),
        listMarkedFiles(id, absolutePath),
        scanRepository(config, repository),
      ]);
      return {
        result: { path: relativePath, assumed },
        files,
        marked,
        status,
      };
    });
  });
  app.get('/api/repositories/:id/tags', async (request) => {
    const id = (request.params as { id: string }).id;
    const { absolutePath } = await managedRepository(id);
    return { tags: await listTags(absolutePath) };
  });
  /** 只读探测：远端有哪些标签。客户端据此把本地专属标签的「删除远端」禁掉。 */
  app.get('/api/repositories/:id/tags/remote', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, absolutePath } = await managedRepository(id);
    const remote = config.settings.defaultRemote;
    return { remote, tags: await listRemoteTagNames(absolutePath, remote) };
  });
  app.post('/api/repositories/:id/tags', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = createTagSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止创建 Tag');
    if (input.push && !repository.capabilities.push) throw safetyBlockedError('仓库配置禁止推送 Tag');
    return runOperation(repository, 'tag', async () => {
      const tag = await createTag(absolutePath, { name: input.name, target: input.target, message: input.message });
      // 推送失败不回滚本地 Tag：与 Commit 后置 Push 一致，本地成果先保住。
      let pushed = false;
      let pushError: string | null = null;
      if (input.push) {
        try {
          await pushTag(absolutePath, tag.name, config.settings.defaultRemote);
          pushed = true;
        } catch (error) {
          pushError = error instanceof Error ? error.message : '推送 Tag 失败';
        }
      }
      const [tags, status] = await Promise.all([
        listTags(absolutePath),
        scanRepository(config, repository),
      ]);
      return {
        result: { tag, tags, status, pushed, pushError },
        message: !input.push
          ? `Tag ${tag.name} 已创建`
          : pushed
            ? `Tag ${tag.name} 已创建并推送到 ${config.settings.defaultRemote}`
            : `Tag ${tag.name} 已创建，但推送失败：${pushError}。Tag 已保留在本地`,
      };
    });
  });
  app.post('/api/repositories/:id/tags/delete', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = deleteTagSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止删除 Tag');
    return runOperation(repository, 'tag', async () => {
      const tag = await deleteTag(absolutePath, input.name, input.expectedHash);
      const [tags, status] = await Promise.all([
        listTags(absolutePath),
        scanRepository(config, repository),
      ]);
      return { result: { tag, tags, status }, message: `已删除本地 Tag ${tag.name}` };
    });
  });
  app.post('/api/repositories/:id/tags/push', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = pushTagSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.push) throw safetyBlockedError('仓库配置禁止推送 Tag');
    // 省略 remote 时用仓库配置的 defaultRemote，客户端不再写死 remote 名。
    const remote = input.remote ?? config.settings.defaultRemote;
    return runOperation(repository, 'tag', async () => {
      const tag = await pushTag(absolutePath, input.name, remote);
      return { result: { tag }, message: `Tag ${tag.name} 已推送到 ${remote}` };
    });
  });
  app.post('/api/repositories/:id/tags/delete-remote', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = deleteRemoteTagSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.push) throw safetyBlockedError('仓库配置禁止远端写入');
    const remote = config.settings.defaultRemote;
    return runOperation(repository, 'tag', async () => {
      const tag = await deleteRemoteTag(absolutePath, input.name, remote, input.expectedHash);
      const [tags, status] = await Promise.all([
        listTags(absolutePath),
        scanRepository(config, repository),
      ]);
      return { result: { tag, tags, status }, message: `已删除远端标签 ${tag.name}（${remote}）；本地标签未受影响` };
    });
  });
  app.post('/api/repositories/:id/hunks', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = applyHunksSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止按块操作');
    return withRepositoryLock(repository.id, async () => {
      const currentFiles = await listRepositoryFiles(id, absolutePath);
      const file = resolveCurrentFileAction(id, input.fileId, currentFiles);
      if (file.conflicted) throw conflictError('冲突文件必须先在「进行中的操作」里解决');
      const result = await applyFileHunks(absolutePath, file.path, input.kind, input.hunkIndexes);
      return { result, ...(await readFilesAndStatus(config, repository, absolutePath)) };
    });
  });
  app.post('/api/repositories/:id/conflicts/resolve', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = resolveConflictSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.stage) throw safetyBlockedError('仓库配置禁止解决冲突');
    return withRepositoryLock(repository.id, async () => {
      const currentFiles = await listRepositoryFiles(id, absolutePath);
      const file = resolveCurrentFileAction(id, input.fileId, currentFiles);
      if (!file.conflicted) throw conflictError('该文件当前没有未解决的冲突，请刷新后重试');
      const result = await resolveConflictFile(absolutePath, file.path, input.strategy, input.expectedConflictFingerprint);
      return { result, ...(await readFilesAndStatus(config, repository, absolutePath)) };
    });
  });
  app.post('/api/repositories/:id/conflicts/continue', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止继续 Git 操作');
    return runOperation(repository, 'conflict', async () => {
      const operation = await continueRepositoryOperation(absolutePath);
      const { status, files } = await readFilesAndStatus(config, repository, absolutePath);
      return { result: { operation, status, files }, message: `已继续 ${operation} 操作` };
    });
  });
  app.post('/api/repositories/:id/conflicts/abort', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止终止 Git 操作');
    return runOperation(repository, 'conflict', async () => {
      const operation = await abortRepositoryOperation(absolutePath);
      const { status, files } = await readFilesAndStatus(config, repository, absolutePath);
      return { result: { operation, status, files }, message: `已终止 ${operation} 操作` };
    });
  });
  app.post('/api/repositories/:id/commit/preview', async (request) => {
    const id = (request.params as { id: string }).id;
    const { repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止 Commit');
    // 预览是只读的（`git diff --cached` + 前后两次指纹比对），不占仓库锁：
    // 占锁期间任何暂存/取消暂存都会被拒成「该仓库已有 Git 操作正在执行」，而预览
    // 恰恰是每次勾选文件之后立刻发生的——于是「勾一个、勾下一个」就会失败。
    // 一致性由 `commitPreview` 自己的指纹前后比对保证：期间暂存区变了它会拒绝这次
    // 预览，界面等文件列表更新后重读即可。
    const preview = await commitPreview(absolutePath);
    return { ...preview, aiPolicy: await aiCommitPolicy(repository, preview) };
  });
  app.post('/api/repositories/:id/commit/suggest', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = commitSuggestionRequestSchema.parse(request.body);
    const { repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止 Commit');
    const [preview, profile] = await Promise.all([
      commitPreview(absolutePath), loadProfile(),
    ]);
    if (preview.fingerprint !== input.fingerprint) throw conflictError('暂存区已变化，请重新预览后生成文案');
    const suggestion = await suggestCommit(absolutePath, repository, preview, profile.profile.preferredCommitLanguage);
    if (await withRepositoryLock(repository.id, () => stagedFingerprint(absolutePath)) !== input.fingerprint) {
      throw conflictError('暂存区已变化，请重新预览后生成文案');
    }
    return suggestion;
  });
  /**
   * —— 提交历史改写 ——
   *
   * 界面能提交、能看历史，但此前提交错了没法收拾：打错文案、漏加文件、提交早了，
   * 都只能回终端。这里补上「修正上次提交」与「撤销上次提交」。
   *
   * 两者都只动本机对象库与引用；**不提供 force push**，因此已推送的提交被改写后
   * 本地会与远端分叉——快照接口把这一点先读出来交给界面说明。
   */
  app.get('/api/repositories/:id/commit/last', async (request) => {
    const id = (request.params as { id: string }).id;
    const { config, repository, absolutePath } = await managedRepository(id);
    return (await readLastCommitSnapshot(config, repository, absolutePath)) satisfies LastCommitSnapshot;
  });

  app.post('/api/repositories/:id/commit/amend', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = amendCommitSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'commit', async () => {
      const { message, ...result } = await amendCommit(config, repository, absolutePath, input);
      return { result, message };
    });
  });

  app.post('/api/repositories/:id/commit/undo', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = undoCommitSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'undo-commit', async () => {
      const { message, ...result } = await undoLastCommit(config, repository, absolutePath, input);
      return { result, message };
    });
  });

  /**
   * 把单个提交应用到当前分支：`revert`（反向抵消）与 `cherry-pick`（正向搬过来）。
   *
   * 在此之前这两个操作只能「善后」：`conflicts.ts` 早有继续 / 中止映射，
   * 冲突预览也支持它们，却**没有发起入口**——于是「回退一个坏提交」只能回终端。
   *
   * 冲突时抛带 `mergePausedErrorCode` 的冲突错误（与合并暂停同一套语义），
   * 界面据此切到工作区，之后由既有的「继续 / 中止」处理。
   */
  app.post('/api/repositories/:id/commit/revert', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = replayCommitSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'revert', async () => {
      const output = await revertCommit(config, repository, absolutePath, input);
      const status = await scanRepository(config, repository);
      return { result: { ...output, status }, message: output.message };
    });
  });

  app.post('/api/repositories/:id/commit/cherry-pick', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = replayCommitSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    return runOperation(repository, 'cherry-pick', async () => {
      const output = await cherryPickCommit(config, repository, absolutePath, input);
      const status = await scanRepository(config, repository);
      return { result: { ...output, status }, message: output.message };
    });
  });

  app.post('/api/repositories/:id/commit', async (request) => {
    const id = (request.params as { id: string }).id;
    const input = commitRequestSchema.parse(request.body);
    const { config, repository, absolutePath } = await managedRepository(id);
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止 Commit');
    return commitWithOptionalPush(config, repository, absolutePath, input.pushAfterCommit, async () => {
      const commit = await commitStaged(absolutePath, input.message, input.fingerprint);
      const status = await scanRepository(config, repository);
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
    if (!repository.capabilities.commit) throw safetyBlockedError('仓库配置禁止 Commit');
    return commitWithOptionalPush(config, repository, absolutePath, input.pushAfterCommit, async () => {
      const [preview, profile] = await Promise.all([commitPreview(absolutePath), loadProfile()]);
      if (preview.fingerprint !== input.fingerprint) throw conflictError('暂存区已变化，请重新预览');
      const suggestion = await suggestCommit(
        absolutePath,
        repository,
        preview,
        profile.profile.preferredCommitLanguage,
      );
      const commit = await commitStaged(absolutePath, suggestion.message, preview.fingerprint);
      const status = await scanRepository(config, repository);
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
