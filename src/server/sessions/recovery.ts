import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryConfig, RepositoriesConfig } from '../../shared/contracts.js';
import type {
  NativeRollbackRequest,
  NativeRollbackResult,
  NativeRestoreExecuteRequest,
  NativeRestoreResult,
} from '../../shared/native-capsule.js';
import {
  nativeRollbackRequestSchema,
  nativeRestoreExecuteRequestSchema,
} from '../../shared/native-capsule.js';
import {
  recoveryBlockerSchema,
  recoveryMappingEntrySchema,
  recoveryMappingsFileSchema,
  recoveryMappingSchema,
  recoveryPlanRequestSchema,
  recoveryPlanSchema,
  recoveryStructuredContextSchema,
  recoveryWorkspaceSchema,
  recoveryWipSchema,
  type RecoveryBlocker,
  type RecoveryMapping,
  type RecoveryPlan,
  type RecoveryPlanRequest,
  type RecoveryWorkspace,
  type RecoveryWip,
} from '../../shared/recovery.js';
import type {
  Checkpoint,
  ProviderCapabilities,
  SessionCheckpointPayload,
  SessionProvider,
} from '../../shared/sessions.js';
import { parsePorcelainV2 } from '../git/scanner.js';
import { runGit, runGitLine, runGitText, runGitWithEnvironment } from '../git/runner.js';
import { appRoot, loadRepositories, resolveRepositoryPath } from '../config/store.js';
import { normalizeRemoteUrl, projectIdFor } from './discovery.js';
import {
  sessionVaultCheckpointPayload,
  sessionVaultNativeCapsulePayload,
  type SessionCatalogOptions,
} from './catalog.js';
import { buildRecoveryLaunch, type RecoveryLaunchOptions } from './cmux.js';
import type { NativeProviderFileAccess } from './native-capsule.js';
import {
  executeNativeRestore,
  inspectNativeRestore,
  rollbackNativeRestore,
} from './native-restore.js';
import { probeProviderCapabilities } from './probe.js';

const readOnlyGitEnvironment = { GIT_OPTIONAL_LOCKS: '0' };
const maxDiffBytes = 120_000;
const maxFileListBytes = 32_000;

export class SessionRecoveryError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'SessionRecoveryError';
    this.statusCode = statusCode;
  }
}

export interface SessionRecoveryOptions extends SessionCatalogOptions {
  repositories?: RepositoriesConfig;
  mappingsPath?: string;
  launchOptions?: RecoveryLaunchOptions;
  claudeHome?: string;
  codexHome?: string;
  targetUserHome?: string;
  providerCapabilities?: ProviderCapabilities;
  onProviderFileAccess?: (access: NativeProviderFileAccess) => void | Promise<void>;
  nativeBackupDirectory?: string;
  nativeTestHook?: (phase: 'after-backup' | 'after-target-write') => void | Promise<void>;
  now?: Date;
}

interface RepositoryCandidate {
  repository: RepositoryConfig;
  canonicalPath: string;
  remoteName: string | null;
  normalizedRemote: string | null;
  projectId: string;
}

interface GitWorkspaceInspection {
  canonicalPath: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  remoteName: string | null;
  parsed: ReturnType<typeof parsePorcelainV2>;
  status: Buffer;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mappingFilePath(options: SessionRecoveryOptions): string {
  return path.resolve(options.mappingsPath ?? path.join(appRoot, '.data', 'session-project-mappings.json'));
}

function nowIso(options: SessionRecoveryOptions): string {
  return (options.now ?? new Date()).toISOString();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadMappings(options: SessionRecoveryOptions): Promise<ReturnType<typeof recoveryMappingsFileSchema.parse>> {
  const filePath = mappingFilePath(options);
  if (!(await fileExists(filePath))) return { schemaVersion: 1, mappings: {} };
  try {
    return recoveryMappingsFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    throw new SessionRecoveryError('本机项目路径映射文件无法解析，请移除后重新选择一次目录', 409);
  }
}

let mappingWriteQueue = Promise.resolve();

async function saveMapping(options: SessionRecoveryOptions, projectId: string, entry: {
  localPath: string;
  normalizedRemote: string | null;
}): Promise<void> {
  const task = async (): Promise<void> => {
    const current = await loadMappings(options);
    current.mappings[projectId] = recoveryMappingEntrySchema.parse({
      schemaVersion: 1,
      projectId,
      localPath: entry.localPath,
      normalizedRemote: entry.normalizedRemote,
      savedAt: nowIso(options),
    });
    const filePath = mappingFilePath(options);
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${filePath}.${digest(`${projectId}:${Date.now()}`)}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(recoveryMappingsFileSchema.parse(current), null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  };
  const result = mappingWriteQueue.then(task, task);
  mappingWriteQueue = result.then(() => undefined, () => undefined);
  await result;
}

async function repositoryCandidate(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
): Promise<RepositoryCandidate | null> {
  const configuredPath = resolveRepositoryPath(config, repository);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(configuredPath);
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) return null;
    const topLevel = await realpath(await runGitLine(canonicalPath, ['rev-parse', '--show-toplevel']));
    if (topLevel !== canonicalPath) return null;
  } catch {
    return null;
  }
  const remoteName = config.settings.defaultRemote;
  const remoteUrl = await runGitText(canonicalPath, ['remote', 'get-url', remoteName]).catch(() => '');
  const normalizedRemote = remoteUrl ? normalizeRemoteUrl(remoteUrl) : null;
  return {
    repository,
    canonicalPath,
    remoteName: normalizedRemote ? remoteName : null,
    normalizedRemote,
    projectId: projectIdFor(normalizedRemote, canonicalPath),
  };
}

async function repositoryCandidates(config: RepositoriesConfig): Promise<RepositoryCandidate[]> {
  const candidates = await Promise.all(config.repositories.map((repository) => repositoryCandidate(config, repository)));
  return candidates.filter((candidate): candidate is RepositoryCandidate => candidate !== null);
}

function checkpointRemoteProject(checkpoint: Checkpoint): boolean {
  return checkpoint.projectId.startsWith('remote:');
}

function mappingFromCandidate(
  checkpoint: Checkpoint,
  candidate: RepositoryCandidate,
  source: RecoveryMapping['source'],
  state: RecoveryMapping['state'] = 'matched-registered',
): RecoveryMapping {
  return recoveryMappingSchema.parse({
    schemaVersion: 1,
    state,
    projectId: checkpoint.projectId,
    repositoryId: candidate.repository.id,
    repositoryName: candidate.repository.name,
    localPath: candidate.canonicalPath,
    remoteName: candidate.remoteName,
    normalizedRemote: candidate.normalizedRemote,
    source,
    message: state === 'matched-manual' ? '已复用本机保存的手工项目映射' : '已按 Fleet 仓库注册表自动匹配项目',
  });
}

function noMapping(checkpoint: Checkpoint, state: RecoveryMapping['state'], message: string): RecoveryMapping {
  return recoveryMappingSchema.parse({
    schemaVersion: 1,
    state,
    projectId: checkpoint.projectId,
    repositoryId: checkpoint.repositoryId,
    repositoryName: null,
    localPath: null,
    remoteName: null,
    normalizedRemote: null,
    source: 'none',
    message,
  });
}

async function validateManualPath(
  checkpoint: Checkpoint,
  requestedPath: string,
  config: RepositoriesConfig,
  options: SessionRecoveryOptions,
  persist: boolean,
): Promise<{ mapping: RecoveryMapping; candidate: RepositoryCandidate | null }> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path.resolve(requestedPath));
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error('选择的路径不是目录');
  } catch (error) {
    return {
      mapping: noMapping(checkpoint, 'invalid', error instanceof Error ? error.message : '选择的项目目录不可用'),
      candidate: null,
    };
  }

  try {
    const topLevel = await realpath(await runGitLine(canonicalPath, ['rev-parse', '--show-toplevel']));
    if (topLevel !== canonicalPath) throw new Error('选择的路径不是 Git worktree 根目录');
  } catch (error) {
    return {
      mapping: noMapping(checkpoint, 'invalid', error instanceof Error ? error.message : '选择的路径不是 Git worktree 根目录'),
      candidate: null,
    };
  }

  const remoteName = config.settings.defaultRemote;
  const remoteUrl = await runGitText(canonicalPath, ['remote', 'get-url', remoteName]).catch(() => '');
  const normalizedRemote = remoteUrl ? normalizeRemoteUrl(remoteUrl) : null;
  const actualProjectId = projectIdFor(normalizedRemote, canonicalPath);
  if (checkpointRemoteProject(checkpoint) && actualProjectId !== checkpoint.projectId) {
    return {
      mapping: recoveryMappingSchema.parse({
        schemaVersion: 1,
        state: 'remote-mismatch',
        projectId: checkpoint.projectId,
        repositoryId: null,
        repositoryName: null,
        localPath: canonicalPath,
        remoteName: normalizedRemote ? remoteName : null,
        normalizedRemote,
        source: 'request-manual',
        message: '选择的仓库远端与 checkpoint 项目身份不一致，请选择同一项目的 worktree',
      }),
      candidate: null,
    };
  }

  const registered = (await repositoryCandidates(config)).find((candidate) => candidate.canonicalPath === canonicalPath);
  const candidate: RepositoryCandidate = registered ?? {
    repository: {
      id: checkpoint.repositoryId ?? `manual-${digest(canonicalPath).slice(0, 16)}`,
      name: path.basename(canonicalPath),
      root: '',
      path: canonicalPath,
      group: '',
      enabled: true,
      pinned: false,
      order: 0,
      tags: [],
      aiCommitPolicy: 'disabled',
      capabilities: { fetch: false, pull: false, stage: false, commit: false, stash: false, push: false },
    },
    canonicalPath,
    remoteName: normalizedRemote ? remoteName : null,
    normalizedRemote,
    projectId: actualProjectId,
  };
  if (persist) await saveMapping(options, checkpoint.projectId, { localPath: canonicalPath, normalizedRemote });
  return {
    mapping: recoveryMappingSchema.parse({
      schemaVersion: 1,
      state: 'matched-manual',
      projectId: checkpoint.projectId,
      repositoryId: candidate.repository.id,
      repositoryName: candidate.repository.name,
      localPath: canonicalPath,
      remoteName: candidate.remoteName,
      normalizedRemote,
      source: 'request-manual',
      message: persist ? '已保存本机项目映射，后续恢复会自动复用' : '已验证本机保存的项目映射',
    }),
    candidate,
  };
}

async function resolveMapping(
  checkpoint: Checkpoint,
  config: RepositoriesConfig,
  request: RecoveryPlanRequest,
  options: SessionRecoveryOptions,
): Promise<{ mapping: RecoveryMapping; candidate: RepositoryCandidate | null }> {
  const candidates = await repositoryCandidates(config);
  const exactRemote = candidates.filter((candidate) => candidate.projectId === checkpoint.projectId);
  if (exactRemote.length > 0) {
    const preferred = exactRemote.find((candidate) => candidate.repository.id === checkpoint.repositoryId) ?? exactRemote[0]!;
    return { mapping: mappingFromCandidate(checkpoint, preferred, 'fleet-registry'), candidate: preferred };
  }

  // A repository id is only a secondary hint.  It is safe to use it for a
  // local-only checkpoint or when the remote identity is absent; it is never
  // allowed to override a mismatching remote project id.
  if (!checkpointRemoteProject(checkpoint) && checkpoint.repositoryId) {
    const byId = candidates.find((candidate) => candidate.repository.id === checkpoint.repositoryId);
    if (byId) return { mapping: mappingFromCandidate(checkpoint, byId, 'fleet-registry'), candidate: byId };
  }

  const mappings = await loadMappings(options);
  const saved = mappings.mappings[checkpoint.projectId];
  if (saved) {
    const validated = await validateManualPath(checkpoint, saved.localPath, config, options, false);
    if (validated.mapping.state === 'matched-manual') {
      return {
        mapping: recoveryMappingSchema.parse({ ...validated.mapping, source: 'saved-manual', message: '已复用本机保存的手工项目映射' }),
        candidate: validated.candidate,
      };
    }
  }

  if (request.localPath) return validateManualPath(checkpoint, request.localPath, config, options, true);
  return {
    mapping: noMapping(checkpoint, 'needs-selection', 'Fleet 仓库注册表中没有匹配项目，请选择一次本机 Git worktree 目录'),
    candidate: null,
  };
}

async function inspectWorkspace(
  checkpoint: Checkpoint,
  candidate: RepositoryCandidate,
): Promise<GitWorkspaceInspection> {
  const statusResult = await runGitWithEnvironment(
    candidate.canonicalPath,
    ['status', '--porcelain=v2', '--branch', '-z'],
    readOnlyGitEnvironment,
  );
  if (statusResult.exitCode !== 0) throw new SessionRecoveryError(statusResult.stderr || '无法读取本机项目 Git 状态');
  const parsed = parsePorcelainV2(statusResult.stdout);
  const head = await runGitText(candidate.canonicalPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null);
  const upstream = await runGitText(candidate.canonicalPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => null);
  return {
    canonicalPath: candidate.canonicalPath,
    branch: parsed.branch,
    detached: parsed.detached,
    head,
    upstream,
    remoteName: candidate.remoteName,
    parsed,
    status: statusResult.stdout,
  };
}

function workspaceFingerprint(inspection: GitWorkspaceInspection): string {
  return createHash('sha256').update(JSON.stringify({
    branch: inspection.branch,
    detached: inspection.detached,
    head: inspection.head,
    status: inspection.status.toString('base64'),
  })).digest('hex');
}

function parseStatusFiles(status: Buffer): Array<{ path: string; status: string }> {
  const records = status.toString('utf8').split('\0').filter(Boolean);
  const files: Array<{ path: string; status: string }> = [];
  for (const record of records) {
    if (record.startsWith('# ')) continue;
    if (record.startsWith('? ')) {
      files.push({ path: record.slice(2), status: '??' });
      continue;
    }
    if (record.startsWith('1 ') || record.startsWith('2 ') || record.startsWith('u ')) {
      const parts = record.split(' ');
      const xy = parts[1] ?? '??';
      const filePath = parts.slice(8).join(' ') || parts.at(-1) || '';
      if (filePath) files.push({ path: filePath, status: xy });
    }
  }
  return files.slice(0, 1_000);
}

async function workingTreeDiff(
  candidate: RepositoryCandidate,
  inspection: GitWorkspaceInspection,
): Promise<{ files: Array<{ path: string; status: string }>; diff: string; diffTruncated: boolean }> {
  const files = parseStatusFiles(inspection.status);
  if (!inspection.parsed.changedFiles) return { files, diff: '', diffTruncated: false };
  const args = inspection.head
    ? ['diff', '--no-ext-diff', '--no-color', inspection.head, '--']
    : ['diff', '--cached', '--no-ext-diff', '--no-color', '--'];
  const result = await runGit(candidate.canonicalPath, args, 30_000, undefined, maxDiffBytes);
  if (result.exitCode !== 0) {
    return { files, diff: '', diffTruncated: false };
  }
  const diff = result.stdout.toString('utf8');
  return {
    files,
    diff: result.stdoutTruncated ? `${diff}\n\n… 本机工作区 diff 已截断 …` : diff,
    diffTruncated: result.stdoutTruncated,
  };
}

function validWipRef(ref: string): boolean {
  return /^refs\/(?:moo-fleet\/wip|heads\/wip)\/[a-f0-9]{64}$/.test(ref);
}

async function remoteExists(cwd: string, remote: string | null): Promise<boolean> {
  if (!remote || !/^[A-Za-z0-9._-]+$/.test(remote)) return false;
  const result = await runGit(cwd, ['remote']);
  return result.exitCode === 0 && result.stdout.toString('utf8').split(/\r?\n/).includes(remote);
}

async function commitObject(cwd: string, value: string | null): Promise<string | null> {
  if (!value || !/^[a-f0-9]{40,64}$/.test(value)) return null;
  return runGitText(cwd, ['rev-parse', '--verify', `${value}^{commit}`]).catch(() => null);
}

async function trustedRevisionCommit(cwd: string, revision: 'FETCH_HEAD'): Promise<string | null> {
  return runGitText(cwd, ['rev-parse', '--verify', `${revision}^{commit}`]).catch(() => null);
}

async function wipPreview(
  checkpoint: Checkpoint,
  candidate: RepositoryCandidate,
  inspection: GitWorkspaceInspection,
  refreshRemote: boolean,
): Promise<RecoveryWip> {
  const sourceSync = checkpoint.capabilities.sourceSync;
  const ref = checkpoint.capabilities.wipRef ?? sourceSync?.ref ?? null;
  const expectedCommit = sourceSync?.commit ?? null;
  const includesWorkingTree = Boolean(sourceSync?.includesWorkingTree);
  if (!ref) {
    return recoveryWipSchema.parse({
      schemaVersion: 1,
      present: false,
      ref: null,
      remoteName: candidate.remoteName,
      expectedCommit,
      reachable: Boolean(checkpoint.capabilities.codeReachable && await commitObject(candidate.canonicalPath, checkpoint.head)),
      fetched: false,
      commit: await commitObject(candidate.canonicalPath, checkpoint.head),
      includesWorkingTree,
      files: [],
      diff: '',
      diffTruncated: false,
      message: checkpoint.capabilities.codeReachable ? '该 checkpoint 没有 WIP ref；仅检查基线 HEAD' : '该 checkpoint 选择了仅保存交接，代码在本机不可验证',
    });
  }
  if (!validWipRef(ref)) {
    return recoveryWipSchema.parse({
      schemaVersion: 1,
      present: true,
      ref,
      remoteName: candidate.remoteName,
      expectedCommit,
      reachable: false,
      fetched: false,
      commit: null,
      includesWorkingTree,
      files: [],
      diff: '',
      diffTruncated: false,
      message: 'checkpoint 的 WIP ref 格式不在允许白名单内，已停止读取',
    });
  }

  const remoteName = candidate.remoteName && await remoteExists(candidate.canonicalPath, candidate.remoteName)
    ? candidate.remoteName
    : null;
  let fetched = false;
  let commit = await commitObject(candidate.canonicalPath, expectedCommit);
  if (refreshRemote && remoteName) {
    const fetchedResult = await runGit(
      candidate.canonicalPath,
      ['fetch', '--no-tags', remoteName, ref],
      300_000,
    );
    fetched = fetchedResult.exitCode === 0;
    if (fetched) commit = await commitObject(candidate.canonicalPath, expectedCommit) ?? await trustedRevisionCommit(candidate.canonicalPath, 'FETCH_HEAD');
  }
  const reachableCommit = commit;
  const reachable = Boolean(reachableCommit && (!expectedCommit || reachableCommit === expectedCommit));
  if (!reachable) {
    return recoveryWipSchema.parse({
      schemaVersion: 1,
      present: true,
      ref,
      remoteName,
      expectedCommit,
      reachable: false,
      fetched,
      commit,
      includesWorkingTree,
      files: [],
      diff: '',
      diffTruncated: false,
      message: remoteName ? 'WIP ref 尚未在本机可达，fetch 未取得预期 commit' : '本机没有可用 remote，无法 fetch WIP ref',
    });
  }

  const base = inspection.head;
  commit = reachableCommit;
  if (!commit) throw new SessionRecoveryError('WIP commit 在预览期间消失，请重新执行恢复预检');
  const diffArgs = base
    ? ['diff', '--no-ext-diff', '--no-color', base, commit]
    : ['show', '--format=', '--no-ext-diff', '--no-color', commit];
  const diffResult = await runGit(candidate.canonicalPath, diffArgs, 30_000, undefined, maxDiffBytes);
  const nameResult = base
    ? await runGit(candidate.canonicalPath, ['diff', '--no-renames', '--name-status', '-z', base, commit], 30_000, undefined, maxFileListBytes)
    : await runGit(candidate.canonicalPath, ['diff-tree', '--root', '--no-renames', '--name-status', '-z', commit], 30_000, undefined, maxFileListBytes);
  const nameRecords = nameResult.stdout.toString('utf8').split('\0').filter(Boolean);
  const files: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < nameRecords.length - 1; index += 2) {
    const status = nameRecords[index] ?? '';
    const filePath = nameRecords[index + 1] ?? '';
    if (filePath) files.push({ path: filePath, status });
  }
  const diff = diffResult.stdout.toString('utf8');
  return recoveryWipSchema.parse({
    schemaVersion: 1,
    present: true,
    ref,
    remoteName,
    expectedCommit,
    reachable: true,
    fetched,
    commit,
    includesWorkingTree,
    files: files.slice(0, 1_000),
    diff: diffResult.stdoutTruncated ? `${diff}\n\n… WIP diff 已截断 …` : diff,
    diffTruncated: diffResult.stdoutTruncated || nameResult.stdoutTruncated,
    message: fetched ? 'WIP ref 已 fetch 并完成只读 diff 预览；尚未应用到工作区' : '本机已有 WIP commit，已完成只读 diff 预览；尚未应用到工作区',
  });
}

function blocker(code: string, severity: RecoveryBlocker['severity'], message: string): RecoveryBlocker {
  return recoveryBlockerSchema.parse({ code, severity, message });
}

function buildPrompt(
  checkpoint: Checkpoint,
  handoffMarkdown: string,
  contextJson: string,
  workspace: RecoveryWorkspace | null,
  wip: RecoveryWip,
  blockers: RecoveryBlocker[],
): string {
  const blockerText = blockers.length === 0
    ? '预检通过。'
    : blockers.map((item) => `- [${item.severity}] ${item.message}`).join('\n');
  const workspaceText = workspace
    ? `当前本机分支：${workspace.branch ?? 'DETACHED'}\n当前 HEAD：${workspace.head ?? '无'}\n工作区：${workspace.dirty ? `Dirty（${workspace.changedFiles} 个文件）` : 'clean'}`
    : '尚未定位本机项目目录';
  const wipText = wip.present
    ? `WIP ref：${wip.ref}\nWIP commit：${wip.commit ?? wip.expectedCommit ?? '不可达'}\nWIP 文件数：${wip.files.length}\n注意：Fleet 只做了预览，尚未自动应用 WIP。`
    : '该 checkpoint 没有 WIP ref。';
  return [
    '你正在接手一个 Moo Fleet AI 会话。请先阅读以下交接资料，再向用户确认当前目标和下一步；不要自动切换分支、覆盖 Dirty 工作区或应用未确认的 WIP 改动。',
    '',
    `逻辑会话：${checkpoint.sessionId}`,
    `Checkpoint：${checkpoint.checkpointId}`,
    `Provider：${checkpoint.provider}`,
    `项目身份：${checkpoint.projectId}`,
    workspaceText,
    wipText,
    '',
    '恢复预检结果：',
    blockerText,
    '',
    '结构化上下文（JSON）：',
    contextJson,
    '',
    '交接摘要（handoff.md）：',
    handoffMarkdown,
    '',
    '开始后请先复述目标、已完成事项和下一步；如果代码状态或 WIP 与摘要不一致，先停下来询问用户。',
  ].join('\n').slice(0, 80_000);
}

function emptyWorkspaceMappingBlockers(mapping: RecoveryMapping): RecoveryBlocker[] {
  if (mapping.state === 'needs-selection') return [blocker('project-mapping-required', 'blocking', mapping.message)];
  if (mapping.state === 'invalid') return [blocker('project-mapping-invalid', 'blocking', mapping.message)];
  if (mapping.state === 'remote-mismatch') return [blocker('project-remote-mismatch', 'blocking', mapping.message)];
  return [];
}

export async function planSessionRecovery(
  sessionId: string,
  request: RecoveryPlanRequest = {},
  options: SessionRecoveryOptions = {},
): Promise<RecoveryPlan> {
  const input = recoveryPlanRequestSchema.parse({
    localPath: request.localPath ?? null,
    checkpointId: request.checkpointId,
    refreshRemote: request.refreshRemote ?? true,
  });
  const payload: SessionCheckpointPayload = await sessionVaultCheckpointPayload(sessionId, input.checkpointId ?? null, options);
  const [config, nativeCapsule, localProviderCapabilities] = await Promise.all([
    options.repositories ?? loadRepositories(),
    sessionVaultNativeCapsulePayload(sessionId, payload.checkpoint.checkpointId, options),
    options.providerCapabilities ?? probeProviderCapabilities({
      provider: payload.checkpoint.provider,
      command: payload.checkpoint.provider,
    }),
  ]);
  const { mapping, candidate } = await resolveMapping(payload.checkpoint, config, input, options);
  const blockers = [...emptyWorkspaceMappingBlockers(mapping)];
  let workspace: RecoveryWorkspace | null = null;
  let wip: RecoveryWip;

  if (candidate && mapping.localPath) {
    const inspection = await inspectWorkspace(payload.checkpoint, candidate);
    const diff = await workingTreeDiff(candidate, inspection);
    workspace = recoveryWorkspaceSchema.parse({
      schemaVersion: 1,
      localPath: candidate.canonicalPath,
      branch: inspection.branch,
      detached: inspection.detached,
      head: inspection.head,
      upstream: inspection.upstream,
      remoteName: inspection.remoteName,
      dirty: inspection.parsed.changedFiles > 0,
      changedFiles: inspection.parsed.changedFiles,
      stagedFiles: inspection.parsed.staged,
      modifiedFiles: inspection.parsed.modified,
      deletedFiles: inspection.parsed.deleted,
      renamedFiles: inspection.parsed.renamed,
      untrackedFiles: inspection.parsed.untracked,
      files: diff.files,
      diff: diff.diff,
      diffTruncated: diff.diffTruncated,
      branchMatchesCheckpoint: inspection.branch === payload.checkpoint.branch,
      headMatchesCheckpoint: inspection.head === payload.checkpoint.head,
      workspaceFingerprint: workspaceFingerprint(inspection),
    });
    if (workspace.dirty) blockers.push(blocker('workspace-dirty', 'blocking', '本机工作区有未提交改动，恢复停在预检；请先查看 diff，不会覆盖本地文件'));
    if (!workspace.branchMatchesCheckpoint) blockers.push(blocker('branch-mismatch', 'blocking', `本机分支与 checkpoint 不一致（本机 ${workspace.branch ?? 'DETACHED'} / checkpoint ${payload.checkpoint.branch ?? 'DETACHED'}），Fleet 不会自动切换`));
    if (!workspace.headMatchesCheckpoint) blockers.push(blocker('head-mismatch', 'blocking', `本机 HEAD 与 checkpoint 不一致（本机 ${workspace.head ?? '无'} / checkpoint ${payload.checkpoint.head ?? '无'}），请先人工确认`));
    wip = await wipPreview(payload.checkpoint, candidate, inspection, input.refreshRemote);
  } else {
    wip = recoveryWipSchema.parse({
      schemaVersion: 1,
      present: Boolean(payload.checkpoint.capabilities.wipRef || payload.checkpoint.capabilities.sourceSync?.ref),
      ref: payload.checkpoint.capabilities.wipRef ?? payload.checkpoint.capabilities.sourceSync?.ref ?? null,
      remoteName: null,
      expectedCommit: payload.checkpoint.capabilities.sourceSync?.commit ?? null,
      reachable: false,
      fetched: false,
      commit: null,
      includesWorkingTree: Boolean(payload.checkpoint.capabilities.sourceSync?.includesWorkingTree),
      files: [],
      diff: '',
      diffTruncated: false,
      message: '定位本机项目后才能检查 WIP ref 可达性',
    });
  }

  if (wip.present && !wip.reachable) blockers.push(blocker('wip-unreachable', 'blocking', wip.message));
  if (!payload.checkpoint.capabilities.codeReachable) blockers.push(blocker('code-unreachable', 'warning', '该 checkpoint 保存时选择了仅存交接，代码不会随 Session Vault 自动出现'));
  const blocking = blockers.some((item) => item.severity === 'blocking');
  const structuredContext = recoveryStructuredContextSchema.parse({
    schemaVersion: 1,
    sessionId,
    checkpointId: payload.checkpoint.checkpointId,
    provider: payload.checkpoint.provider,
    providerSessionId: payload.checkpoint.providerSessionId,
    title: payload.checkpoint.title,
    projectId: payload.checkpoint.projectId,
    repositoryId: payload.checkpoint.repositoryId,
    localPath: workspace?.localPath ?? null,
    branch: workspace?.branch ?? payload.checkpoint.branch,
    head: workspace?.head ?? payload.checkpoint.head,
    dirty: workspace?.dirty ?? null,
    codeReachable: payload.checkpoint.capabilities.codeReachable,
    wipRef: wip.ref,
    wipCommit: wip.commit ?? wip.expectedCommit,
  });
  const structuredContextJson = `${JSON.stringify(structuredContext, null, 2)}\n`;
  const recoveryPrompt = buildPrompt(payload.checkpoint, payload.handoffMarkdown, structuredContextJson, workspace, wip, blockers);
  const native = await inspectNativeRestore({
    capsule: nativeCapsule,
    localProjectPath: mapping.localPath,
    localCapabilities: localProviderCapabilities,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    targetUserHome: options.targetUserHome,
    onProviderFileAccess: options.onProviderFileAccess,
  });
  const launch = workspace
    ? await buildRecoveryLaunch({
        provider: payload.checkpoint.provider,
        providerSessionId: payload.checkpoint.providerSessionId,
        sessionId,
        checkpointId: payload.checkpoint.checkpointId,
        title: payload.checkpoint.title,
        localPath: workspace.localPath,
        workspaceFingerprint: workspace.workspaceFingerprint,
        recoveryPrompt,
        recoveryAvailable: !blocking,
      }, options.launchOptions)
    : null;
  const command = launch
    ? {
        provider: payload.checkpoint.provider,
        mode: 'universal' as const,
        command: launch.shellCommand,
        available: !blocking,
        message: blocking
          ? '预检存在阻塞项；命令仅供查看，解决 Dirty/分支/HEAD/WIP 问题后再执行'
          : '通用恢复命令已生成；长提示词保存在 Fleet 本机数据目录，命令行只引用文件路径',
      }
    : null;
  return recoveryPlanSchema.parse({
    schemaVersion: 1,
    sessionId,
    checkpoint: payload.checkpoint,
    mapping,
    workspace,
    wip,
    blockers,
    canStartUniversal: Boolean(workspace && !blocking),
    handoffMarkdown: payload.handoffMarkdown,
    structuredContext,
    structuredContextJson,
    recoveryPrompt,
    command,
    launch,
    native: native.plan,
    generatedAt: nowIso(options),
  });
}

export async function executeSessionNativeRestore(
  sessionId: string,
  request: NativeRestoreExecuteRequest,
  options: SessionRecoveryOptions = {},
): Promise<NativeRestoreResult> {
  const input = nativeRestoreExecuteRequestSchema.parse(request);
  const payload = await sessionVaultCheckpointPayload(sessionId, input.checkpointId ?? null, options);
  const [config, nativeCapsule, localProviderCapabilities] = await Promise.all([
    options.repositories ?? loadRepositories(),
    sessionVaultNativeCapsulePayload(sessionId, payload.checkpoint.checkpointId, options),
    options.providerCapabilities ?? probeProviderCapabilities({
      provider: payload.checkpoint.provider,
      command: payload.checkpoint.provider,
    }),
  ]);
  const mappingInput = recoveryPlanRequestSchema.parse({
    localPath: input.localPath ?? null,
    checkpointId: payload.checkpoint.checkpointId,
    refreshRemote: false,
  });
  const { mapping } = await resolveMapping(payload.checkpoint, config, mappingInput, options);
  if (!mapping.localPath || !['matched-registered', 'matched-manual'].includes(mapping.state)) {
    throw new SessionRecoveryError(mapping.message);
  }
  return executeNativeRestore({
    capsule: nativeCapsule,
    localProjectPath: mapping.localPath,
    localCapabilities: localProviderCapabilities,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    targetUserHome: options.targetUserHome,
    onProviderFileAccess: options.onProviderFileAccess,
    expectedFingerprint: input.expectedNativeFingerprint,
    backupDirectory: options.nativeBackupDirectory,
    now: options.now,
    testHook: options.nativeTestHook,
  });
}

export async function rollbackSessionNativeRestore(
  sessionId: string,
  request: NativeRollbackRequest,
  options: SessionRecoveryOptions = {},
): Promise<NativeRollbackResult> {
  const input = nativeRollbackRequestSchema.parse(request);
  return rollbackNativeRestore({
    sessionId,
    backupId: input.backupId,
    expectedInstalledSha256: input.expectedInstalledSha256,
    backupDirectory: options.nativeBackupDirectory,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    now: options.now,
    onProviderFileAccess: options.onProviderFileAccess,
  });
}

export { mappingFilePath as sessionRecoveryMappingsPath };
