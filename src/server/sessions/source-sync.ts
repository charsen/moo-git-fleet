import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  SourceSyncChoice,
  SourceSyncFileStats,
  SourceSyncGate,
  SourceSyncResult,
  WorkspaceSnapshot,
} from '../../shared/sessions.js';
import { sourceSyncGateSchema, sourceSyncResultSchema } from '../../shared/sessions.js';
import {
  runGit,
  runGitText,
  runGitTextWithEnvironment,
  runGitWithEnvironment,
} from '../git/runner.js';
import { parsePorcelainV2 } from '../git/scanner.js';

const readOnlyGitEnvironment = { GIT_OPTIONAL_LOCKS: '0' };

export class SourceSyncError extends Error {
  readonly code = 'session-source-sync-failed';

  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SourceSyncError';
  }
}

export interface InspectSourceSyncGateInput {
  repositoryPath: string;
  repositoryId: string;
  workspace: WorkspaceSnapshot;
  remoteName: string;
  refreshRemote?: boolean;
}

export interface ExecuteSourceSyncInput extends InspectSourceSyncGateInput {
  choice: SourceSyncChoice;
  expectedFingerprint: string;
  checkpointId: string;
  now?: Date;
}

interface RepositoryInvariant {
  branch: string | null;
  head: string | null;
  status: Buffer;
  indexPath: string;
  indexExists: boolean;
  indexBytes: Buffer;
  indexMtimeNs: bigint | null;
  workspaceStateHash: string;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function ensureRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new SourceSyncError('Git remote 名称不安全');
}

function ensureCheckpointId(checkpointId: string): void {
  if (!/^[a-f0-9]{64}$/.test(checkpointId)) throw new SourceSyncError('Checkpoint 标识无效，无法生成 WIP ref');
}

async function currentBranchAndHead(repositoryPath: string): Promise<{ branch: string | null; head: string | null }> {
  const [branch, head] = await Promise.all([
    runGitText(repositoryPath, ['branch', '--show-current']),
    runGitText(repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null),
  ]);
  return { branch: branch || null, head };
}

async function workspaceStateHash(
  repositoryPath: string,
  identity: { branch: string | null; head: string | null },
  status: Buffer,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  hash.update(status);
  const indexOutput = await runGitText(repositoryPath, ['rev-parse', '--git-path', 'index']);
  const indexPath = path.isAbsolute(indexOutput) ? indexOutput : path.resolve(repositoryPath, indexOutput);
  try {
    hash.update(await readFile(indexPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hash.update('missing-index');
  }
  for (const relativePath of await changedPaths(repositoryPath, identity.head)) {
    const absolutePath = path.resolve(repositoryPath, relativePath);
    const relative = path.relative(repositoryPath, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SourceSyncError('Git 返回了超出仓库的文件路径');
    hash.update(`\0${relativePath}\0`);
    try {
      const info = await lstat(absolutePath);
      hash.update(`${info.mode}:${info.size}:`);
      if (info.isSymbolicLink()) {
        hash.update(await readlink(absolutePath));
      } else if (info.isFile()) {
        for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('missing-worktree-path');
    }
  }
  return hash.digest('hex');
}

async function currentWorkspaceState(
  repositoryPath: string,
  expected: WorkspaceSnapshot,
): Promise<{ branch: string | null; head: string | null; workspaceStateHash: string }> {
  const identity = await currentBranchAndHead(repositoryPath);
  const statusResult = await runGitWithEnvironment(
    repositoryPath,
    ['status', '--porcelain=v2', '-z'],
    readOnlyGitEnvironment,
  );
  if (statusResult.exitCode !== 0) throw new SourceSyncError(statusResult.stderr || '无法读取当前工作区状态');
  const parsed = parsePorcelainV2(statusResult.stdout);
  const actual = {
    ...expected,
    branch: identity.branch,
    head: identity.head,
    dirty: parsed.changedFiles > 0,
    changedFiles: parsed.changedFiles,
    stagedFiles: parsed.staged,
    modifiedFiles: parsed.modified,
    deletedFiles: parsed.deleted,
    renamedFiles: parsed.renamed,
    untrackedFiles: parsed.untracked,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SourceSyncError('项目工作区已变化，请重新预览源码同步门');
  }
  return {
    ...identity,
    workspaceStateHash: await workspaceStateHash(repositoryPath, identity, statusResult.stdout),
  };
}

async function configuredRemoteExists(repositoryPath: string, remote: string): Promise<boolean> {
  const remotes = (await runGitText(repositoryPath, ['remote'])).split('\n').filter(Boolean);
  return remotes.includes(remote);
}

async function upstreamName(repositoryPath: string): Promise<string | null> {
  return runGitText(repositoryPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => null);
}

async function refreshRemote(repositoryPath: string, remote: string): Promise<boolean> {
  const result = await runGit(repositoryPath, ['fetch', '--prune', '--no-tags', remote], 300_000);
  return result.exitCode === 0;
}

async function refsContainingHead(repositoryPath: string, remote: string, head: string | null): Promise<string[]> {
  if (!head) return [];
  const output = await runGitText(repositoryPath, [
    'for-each-ref',
    '--format=%(refname)',
    '--contains',
    head,
    `refs/remotes/${remote}/`,
  ]).catch(() => '');
  return output.split('\n').filter(Boolean);
}

function gateFingerprint(input: Omit<SourceSyncGate, 'fingerprint' | 'message'>): string {
  return digest(JSON.stringify(input));
}

function gateMessage(input: {
  head: string | null;
  remote: string | null;
  remoteChecked: boolean;
  dirty: boolean;
  headReachable: boolean;
  branchReachable: boolean;
}): string {
  if (!input.remote) return '仓库未配置可用 remote；只能保存交接，代码在另一台电脑上不可达';
  if (!input.head && input.dirty) return '仓库尚无首个 Commit；可推送包含当前文件的 WIP ref，或明确只保存交接';
  if (!input.head) return '仓库尚无首个 Commit 且没有可推送文件；只能保存交接';
  if (!input.remoteChecked) return '无法刷新远端状态；仍可重试推送分支/WIP ref，或明确只保存交接';
  if (!input.dirty && input.headReachable) return '当前 HEAD 已可从远端取得，无需额外推送源码';
  if (input.dirty && input.branchReachable) return '分支提交已可达，但未提交改动仍需 WIP ref 才能带到另一台电脑';
  if (input.dirty) return '当前分支/工作区尚未完整到达远端，请选择推送 WIP ref 或只保存交接';
  return '当前 HEAD 尚未到达远端，请选择推送分支、推送 WIP ref 或只保存交接';
}

export async function inspectSourceSyncGate(input: InspectSourceSyncGateInput): Promise<SourceSyncGate> {
  const repositoryPath = await realpath(path.resolve(input.repositoryPath));
  ensureRemoteName(input.remoteName);
  const current = await currentWorkspaceState(repositoryPath, input.workspace);
  const hasRemote = await configuredRemoteExists(repositoryPath, input.remoteName);
  const remote = hasRemote ? input.remoteName : null;
  const remoteChecked = remote && input.refreshRemote !== false ? await refreshRemote(repositoryPath, remote) : false;
  const [upstream, containingRefs] = await Promise.all([
    upstreamName(repositoryPath),
    remote ? refsContainingHead(repositoryPath, remote, current.head) : Promise.resolve([]),
  ]);
  const expectedBranchRef = current.branch && remote ? `refs/remotes/${remote}/${current.branch}` : null;
  const headReachable = containingRefs.length > 0;
  const branchReachable = Boolean(expectedBranchRef && containingRefs.includes(expectedBranchRef));
  const fullyReachable = Boolean(remoteChecked) && !input.workspace.dirty && headReachable;
  const choices: SourceSyncChoice[] = [];
  if (fullyReachable || !remote) {
    choices.push('handoff-only');
  } else {
    if (current.branch && current.head && !branchReachable) choices.push('push-branch');
    if (current.head || input.workspace.dirty) choices.push('push-wip-ref');
    choices.push('handoff-only');
  }
  const base = {
    schemaVersion: 1 as const,
    repositoryId: input.repositoryId,
    branch: current.branch,
    head: current.head,
    workspaceStateHash: current.workspaceStateHash,
    remote,
    upstream,
    dirty: input.workspace.dirty,
    remoteChecked: Boolean(remoteChecked),
    headReachable,
    branchReachable,
    requiresChoice: !fullyReachable,
    choices,
  };
  return sourceSyncGateSchema.parse({
    ...base,
    fingerprint: gateFingerprint(base),
    message: gateMessage(base),
  });
}

async function changedPaths(repositoryPath: string, head: string | null): Promise<string[]> {
  const tracked = head
    ? await runGitWithEnvironment(repositoryPath, ['diff', '--name-only', '-z', head, '--'], readOnlyGitEnvironment)
    : await runGitWithEnvironment(repositoryPath, ['ls-files', '-z'], readOnlyGitEnvironment);
  if (tracked.exitCode !== 0) throw new SourceSyncError(tracked.stderr || '无法统计待同步源码文件');
  const untracked = await runGitWithEnvironment(
    repositoryPath,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    readOnlyGitEnvironment,
  );
  if (untracked.exitCode !== 0) throw new SourceSyncError(untracked.stderr || '无法统计未跟踪源码文件');
  return [...new Set(
    [...tracked.stdout.toString('utf8').split('\0'), ...untracked.stdout.toString('utf8').split('\0')].filter(Boolean),
  )].sort();
}

async function sourceFileStats(repositoryPath: string, workspace: WorkspaceSnapshot): Promise<SourceSyncFileStats> {
  const paths = await changedPaths(repositoryPath, workspace.head);
  let totalBytes = 0;
  for (const relativePath of paths) {
    const absolutePath = path.resolve(repositoryPath, relativePath);
    const relative = path.relative(repositoryPath, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SourceSyncError('Git 返回了超出仓库的文件路径');
    try {
      const info = await lstat(absolutePath);
      if (info.isFile() || info.isSymbolicLink()) totalBytes += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {
    changedFiles: workspace.changedFiles,
    stagedFiles: workspace.stagedFiles,
    modifiedFiles: workspace.modifiedFiles,
    deletedFiles: workspace.deletedFiles,
    renamedFiles: workspace.renamedFiles,
    untrackedFiles: workspace.untrackedFiles,
    totalBytes,
  };
}

async function repositoryInvariant(repositoryPath: string): Promise<RepositoryInvariant> {
  const identity = await currentBranchAndHead(repositoryPath);
  const statusResult = await runGitWithEnvironment(
    repositoryPath,
    ['status', '--porcelain=v2', '-z'],
    readOnlyGitEnvironment,
  );
  if (statusResult.exitCode !== 0) throw new SourceSyncError(statusResult.stderr || '无法读取源码同步前的 Git 状态');
  const gitIndexPath = await runGitText(repositoryPath, ['rev-parse', '--git-path', 'index']);
  const indexPath = path.isAbsolute(gitIndexPath) ? gitIndexPath : path.resolve(repositoryPath, gitIndexPath);
  try {
    const [indexBytes, indexStat] = await Promise.all([readFile(indexPath), stat(indexPath, { bigint: true })]);
    return {
      ...identity,
      status: statusResult.stdout,
      indexPath,
      indexExists: true,
      indexBytes,
      indexMtimeNs: indexStat.mtimeNs,
      workspaceStateHash: await workspaceStateHash(repositoryPath, identity, statusResult.stdout),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      ...identity,
      status: statusResult.stdout,
      indexPath,
      indexExists: false,
      indexBytes: Buffer.alloc(0),
      indexMtimeNs: null,
      workspaceStateHash: await workspaceStateHash(repositoryPath, identity, statusResult.stdout),
    };
  }
}

async function assertRepositoryInvariant(repositoryPath: string, before: RepositoryInvariant): Promise<void> {
  const after = await repositoryInvariant(repositoryPath);
  if (after.branch !== before.branch || after.head !== before.head) {
    throw new SourceSyncError('源码同步期间分支或 HEAD 发生变化，请立即检查仓库状态');
  }
  if (!after.status.equals(before.status)) {
    throw new SourceSyncError('源码同步期间 Git 工作区状态发生变化，请立即检查仓库状态');
  }
  if (after.workspaceStateHash !== before.workspaceStateHash) {
    throw new SourceSyncError('源码同步期间工作区文件内容发生变化，请立即检查仓库状态');
  }
  if (
    after.indexPath !== before.indexPath ||
    after.indexExists !== before.indexExists ||
    !after.indexBytes.equals(before.indexBytes) ||
    after.indexMtimeNs !== before.indexMtimeNs
  ) {
    throw new SourceSyncError('源码同步触碰了用户 Git index，已停止后续流程');
  }
}

async function createWipCommit(
  repositoryPath: string,
  workspace: WorkspaceSnapshot,
  checkpointId: string,
  now: Date,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-wip-index-'));
  const temporaryIndex = path.join(temporaryDirectory, 'index');
  const environment = {
    GIT_INDEX_FILE: temporaryIndex,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Moo Fleet WIP',
    GIT_AUTHOR_EMAIL: 'moo-fleet@localhost',
    GIT_COMMITTER_NAME: 'Moo Fleet WIP',
    GIT_COMMITTER_EMAIL: 'moo-fleet@localhost',
    GIT_AUTHOR_DATE: now.toISOString(),
    GIT_COMMITTER_DATE: now.toISOString(),
  };
  try {
    if (workspace.head) {
      await runGitTextWithEnvironment(repositoryPath, ['read-tree', workspace.head], environment);
    } else {
      await runGitTextWithEnvironment(repositoryPath, ['read-tree', '--empty'], environment);
    }
    await runGitTextWithEnvironment(repositoryPath, ['add', '-A', '--', '.'], environment, 300_000);
    const tree = await runGitTextWithEnvironment(repositoryPath, ['write-tree'], environment);
    const args = ['commit-tree', tree];
    if (workspace.head) args.push('-p', workspace.head);
    args.push('-m', `Moo Fleet WIP ${checkpointId.slice(0, 12)}`);
    return await runGitTextWithEnvironment(repositoryPath, args, environment);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function pushExactRef(repositoryPath: string, remote: string, commit: string, ref: string): Promise<boolean> {
  const result = await runGit(
    repositoryPath,
    ['push', '--porcelain', remote, `${commit}:${ref}`],
    300_000,
  );
  return result.exitCode === 0;
}

export async function executeSourceSync(input: ExecuteSourceSyncInput): Promise<SourceSyncResult> {
  ensureCheckpointId(input.checkpointId);
  const repositoryPath = await realpath(path.resolve(input.repositoryPath));
  const gate = await inspectSourceSyncGate({ ...input, repositoryPath, refreshRemote: input.refreshRemote ?? true });
  if (gate.fingerprint !== input.expectedFingerprint) {
    throw new SourceSyncError('源码同步门状态已变化，请重新预览后再保存');
  }
  if (!gate.choices.includes(input.choice)) {
    throw new SourceSyncError('当前源码同步选择已不可用，请重新预览');
  }
  const files = await sourceFileStats(repositoryPath, input.workspace);
  const before = await repositoryInvariant(repositoryPath);
  if (before.workspaceStateHash !== gate.workspaceStateHash) {
    throw new SourceSyncError('源码同步开始前工作区内容已变化，请重新预览');
  }
  let result: SourceSyncResult;
  try {
    if (!input.workspace.dirty && gate.remoteChecked && gate.headReachable) {
      result = sourceSyncResultSchema.parse({
        schemaVersion: 1,
        choice: input.choice,
        mode: 'already-reachable',
        remote: gate.remote,
        ref: gate.upstream,
        transport: 'existing-remote',
        commit: gate.head,
        codeReachable: true,
        includesWorkingTree: false,
        files,
        message: '当前 HEAD 已在远端可达，无需新增源码 ref',
      });
    } else if (input.choice === 'handoff-only') {
      result = sourceSyncResultSchema.parse({
        schemaVersion: 1,
        choice: input.choice,
        mode: 'handoff-only',
        remote: gate.remote,
        ref: null,
        transport: 'none',
        commit: gate.head,
        codeReachable: !input.workspace.dirty && gate.remoteChecked && gate.headReachable,
        includesWorkingTree: false,
        files,
        message: input.workspace.dirty
          ? '仅保存交接；当前未提交改动不会出现在另一台电脑'
          : '仅保存交接；当前 HEAD 尚未确认可从远端取得',
      });
    } else if (input.choice === 'push-branch') {
      if (!gate.remote || !gate.branch || !gate.head) throw new SourceSyncError('当前仓库无法安全推送分支');
      const branchRef = `refs/heads/${gate.branch}`;
      await runGitText(repositoryPath, ['check-ref-format', branchRef]);
      const pushed = await pushExactRef(repositoryPath, gate.remote, gate.head, branchRef);
      if (!pushed) throw new SourceSyncError('分支 Push 未成功；本机内容未丢失，请刷新远端状态后重试');
      result = sourceSyncResultSchema.parse({
        schemaVersion: 1,
        choice: input.choice,
        mode: 'pushed-branch',
        remote: gate.remote,
        ref: branchRef,
        transport: 'branch',
        commit: gate.head,
        codeReachable: !input.workspace.dirty,
        includesWorkingTree: false,
        files,
        message: input.workspace.dirty
          ? '分支 HEAD 已推送，但未提交改动仍未同步；该 checkpoint 的完整代码不可达'
          : '分支 HEAD 已推送，代码可从远端取得',
      });
    } else {
      if (!gate.remote) throw new SourceSyncError('仓库缺少可用 remote，无法推送 WIP ref');
      const commit = input.workspace.dirty
        ? await createWipCommit(repositoryPath, input.workspace, input.checkpointId, input.now ?? new Date())
        : gate.head;
      if (!commit) throw new SourceSyncError('仓库尚无可推送的 Commit 或工作区内容');
      const namespaceRef = `refs/moo-fleet/wip/${input.checkpointId}`;
      const fallbackRef = `refs/heads/wip/${input.checkpointId}`;
      let ref = namespaceRef;
      let transport: SourceSyncResult['transport'] = 'namespace-ref';
      if (!(await pushExactRef(repositoryPath, gate.remote, commit, namespaceRef))) {
        if (!(await pushExactRef(repositoryPath, gate.remote, commit, fallbackRef))) {
          throw new SourceSyncError(
            '远端同时拒绝 WIP namespace 与回退分支；请修复远端策略，或重新选择“仍然只存交接”',
          );
        }
        ref = fallbackRef;
        transport = 'fallback-branch';
      }
      result = sourceSyncResultSchema.parse({
        schemaVersion: 1,
        choice: input.choice,
        mode: 'pushed-wip-ref',
        remote: gate.remote,
        ref,
        transport,
        commit,
        codeReachable: true,
        includesWorkingTree: input.workspace.dirty,
        files,
        message:
          transport === 'namespace-ref'
            ? 'WIP ref 已推送，包含当前未提交与未跟踪文件'
            : '远端拒绝 WIP namespace，已改用普通 wip/ 分支推送',
      });
    }
  } finally {
    await assertRepositoryInvariant(repositoryPath, before);
  }
  return result;
}
