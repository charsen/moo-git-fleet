import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import type {
  CheckpointDiscoveryPayload,
  CheckpointCaptureProgress,
  CheckpointCaptureRequest,
  CheckpointJob,
  CheckpointPreview,
  DiscoveredSession,
  HandoffSummary,
  ProviderCapabilities,
  SessionProvider,
  SourceSyncGate,
  SourceSyncResult,
  SummaryGeneration,
  WorkspaceSnapshot,
} from '../../shared/sessions.js';
import {
  checkpointDiscoveryPayloadSchema,
  checkpointCaptureProgressSchema,
  checkpointCaptureRequestSchema,
  checkpointPreviewSchema,
  discoveredSessionSchema,
  handoffSummarySchema,
} from '../../shared/sessions.js';
import type { RepositoriesConfig as FleetRepositoriesConfig } from '../../shared/contracts.js';
import { loadRepositories, resolveRepositoryPath } from '../config/store.js';
import { runGitLine } from '../git/runner.js';
import { captureCheckpoint, captureWorkspaceSnapshot, plannedCheckpointId } from './checkpoint.js';
import { startCheckpointJob } from './checkpoint-jobs.js';
import { SessionCatalogError, sessionVaultSessionDetail } from './catalog.js';
import { discoverSessions } from './discovery.js';
import { captureNativeCapsule, notCapturedNativeCapsule } from './native-capsule.js';
import { probeProviderCapabilities } from './probe.js';
import {
  generateProviderHandoffSummary,
  ProviderSummaryGenerationError,
  type ProviderSummaryExecutor,
} from './provider-summary.js';
import { redactSensitiveText, scanSecrets, type SecretFinding } from './secrets.js';
import {
  executeSourceSync,
  inspectSourceSyncGate,
  SourceSyncError,
  type ExecuteSourceSyncInput,
  type InspectSourceSyncGateInput,
} from './source-sync.js';
import { createHeuristicSummary } from './summary.js';
import { loadSessionVaultStatus, type SessionVaultServiceOptions } from './vault.js';

export class SessionCheckpointWorkflowError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SessionCheckpointWorkflowError';
  }
}

export interface SessionCheckpointWorkflowOptions {
  repositories?: FleetRepositoriesConfig;
  claudeHome?: string;
  codexHome?: string;
  machine?: string;
  recentDays?: number | null;
  providerCapabilities?: ProviderCapabilities;
  providerSummaryExecutor?: ProviderSummaryExecutor;
  sourceSyncInspector?: (input: InspectSourceSyncGateInput) => Promise<SourceSyncGate>;
  sourceSyncExecutor?: (input: ExecuteSourceSyncInput) => Promise<SourceSyncResult>;
  vault?: SessionVaultServiceOptions;
}

interface ResolvedSession {
  session: DiscoveredSession;
  workspace: WorkspaceSnapshot | null;
  workspaceFingerprint: string | null;
  repositoryPath: string | null;
  remoteName: string | null;
  sourceSyncGate: SourceSyncGate | null;
  providerCapabilities: ProviderCapabilities;
}

interface RepositoryContext {
  workspace: WorkspaceSnapshot;
  repositoryPath: string;
  remoteName: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function workspaceFingerprint(workspace: WorkspaceSnapshot): string {
  return digest(JSON.stringify(workspace));
}

export function logicalSessionId(provider: SessionProvider, providerSessionId: string): string {
  return `fleet:${digest(`${provider}\0${providerSessionId}`).slice(0, 32)}`;
}

function redactSummary(summary: HandoffSummary): HandoffSummary {
  const redactList = (items: string[]) => items.map(redactSensitiveText);
  return handoffSummarySchema.parse({
    goal: redactSensitiveText(summary.goal),
    completed: redactList(summary.completed),
    decisions: redactList(summary.decisions),
    nextSteps: redactList(summary.nextSteps),
    blockers: redactList(summary.blockers),
    commands: redactList(summary.commands),
    risks: redactList(summary.risks),
    source: summary.source,
    reviewedAt: summary.reviewedAt,
  });
}

async function repositoryContext(
  config: FleetRepositoriesConfig,
  session: DiscoveredSession,
): Promise<RepositoryContext | null> {
  if (!session.repositoryId) return null;
  const repository = config.repositories.find((item) => item.id === session.repositoryId);
  if (!repository) return null;
  const repositoryPath = await realpath(resolveRepositoryPath(config, repository));
  const topLevel = await realpath(await runGitLine(repositoryPath, ['rev-parse', '--show-toplevel']));
  if (topLevel !== repositoryPath) throw new SessionCheckpointWorkflowError('Fleet 仓库配置不是 Git worktree 根目录', 409);
  return {
    workspace: await captureWorkspaceSnapshot(repositoryPath, session.projectId, session.repositoryId),
    repositoryPath,
    remoteName: config.settings.defaultRemote,
  };
}

async function resolvedSession(
  provider: SessionProvider,
  providerSessionId: string,
  options: SessionCheckpointWorkflowOptions,
): Promise<ResolvedSession> {
  const repositories = options.repositories ?? (await loadRepositories());
  const discovery = await discoverSessions({
    repositories,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    recentDays: null,
  });
  const session = discovery.sessions.find(
    (item) => item.provider === provider && item.providerSessionId === providerSessionId,
  );
  if (!session) throw new SessionCheckpointWorkflowError('未找到指定的本机会话，请重新扫描或升级 provider 适配器', 404);
  const repository = await repositoryContext(repositories, session);
  const [capabilities, sourceSyncGate] = await Promise.all([
    options.providerCapabilities ?? probeProviderCapabilities({ provider, command: provider }),
    repository
      ? (options.sourceSyncInspector ?? inspectSourceSyncGate)({
          repositoryPath: repository.repositoryPath,
          repositoryId: session.repositoryId!,
          workspace: repository.workspace,
          remoteName: repository.remoteName,
        })
      : Promise.resolve(null),
  ]);
  return {
    session,
    workspace: repository?.workspace ?? null,
    workspaceFingerprint: repository ? workspaceFingerprint(repository.workspace) : null,
    repositoryPath: repository?.repositoryPath ?? null,
    remoteName: repository?.remoteName ?? null,
    sourceSyncGate,
    providerCapabilities: capabilities,
  };
}

function sanitizedSession(session: DiscoveredSession): DiscoveredSession {
  return discoveredSessionSchema.parse({
    ...session,
    title: session.title ? redactSensitiveText(session.title) : null,
    error: session.error ? redactSensitiveText(session.error) : null,
  });
}

function machineName(value?: string): string {
  return (value ?? process.env.GIT_FLEET_MACHINE ?? os.hostname()).trim().slice(0, 255) || 'machine';
}

export async function sessionCheckpointDiscovery(
  options: SessionCheckpointWorkflowOptions = {},
): Promise<CheckpointDiscoveryPayload> {
  const repositories = options.repositories ?? (await loadRepositories());
  const discovery = await discoverSessions({
    repositories,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    recentDays: options.recentDays,
  });
  return checkpointDiscoveryPayloadSchema.parse({
    ...discovery,
    machine: machineName(options.machine),
    sessions: discovery.sessions.map(sanitizedSession),
    errors: discovery.errors.map((error) => ({
      ...error,
      message: redactSensitiveText(error.message),
    })),
  });
}

function previewSecretFindings(summary: HandoffSummary): SecretFinding[] {
  return scanSecrets([{ path: 'handoff-summary.json', content: JSON.stringify(summary) }]).findings;
}

function providerSummaryAvailable(resolved: ResolvedSession): boolean {
  return (
    resolved.providerCapabilities.provider === resolved.session.provider &&
    resolved.providerCapabilities.state === 'supported' &&
    resolved.providerCapabilities.forkResume &&
    Boolean(resolved.providerCapabilities.realBinaryPath)
  );
}

function summaryGeneration(
  resolved: ResolvedSession,
  input: Pick<SummaryGeneration, 'method' | 'providerInvocationAttempted' | 'providerInvocationSucceeded' | 'message'>,
): SummaryGeneration {
  return {
    ...input,
    provider: resolved.session.provider,
    providerInvocationAvailable: providerSummaryAvailable(resolved),
    requiresExplicitOptIn: true,
    incursProviderTokenUsage: true,
  };
}

function checkpointPreview(
  resolved: ResolvedSession,
  rawSummary: HandoffSummary,
  generation: SummaryGeneration,
): CheckpointPreview {
  const secretFindings = previewSecretFindings(rawSummary);
  return checkpointPreviewSchema.parse({
    session: sanitizedSession(resolved.session),
    workspace: resolved.workspace,
    workspaceFingerprint: resolved.workspaceFingerprint,
    summary: secretFindings.length > 0 ? redactSummary(rawSummary) : rawSummary,
    summaryGeneration: generation,
    sourceSyncGate: resolved.sourceSyncGate,
    providerCapabilities: resolved.providerCapabilities,
    secretFindings,
  });
}

async function resolveCheckpointParents(
  sessionId: string,
  requestedParentIds: string[],
  options: SessionVaultServiceOptions,
): Promise<{ parentCheckpointIds: string[]; expectedHeadCheckpointIds: string[] }> {
  let currentHeadIds: string[] = [];
  try {
    currentHeadIds = (await sessionVaultSessionDetail(sessionId, options)).session.headCheckpointIds;
  } catch (error) {
    if (!(error instanceof SessionCatalogError) || error.statusCode !== 404) throw error;
  }
  const expectedHeadCheckpointIds = [...currentHeadIds].sort();
  const requested = [...requestedParentIds].sort();
  if (new Set(requested).size !== requested.length) {
    throw new SessionCheckpointWorkflowError('Checkpoint parent 存在重复项，请重新选择会话 head', 409);
  }
  if (currentHeadIds.length === 0) {
    if (requested.length > 0) {
      throw new SessionCheckpointWorkflowError('新逻辑会话不能引用不存在的 checkpoint parent', 409);
    }
    return { parentCheckpointIds: [], expectedHeadCheckpointIds };
  }
  if (requested.length === 0) {
    if (currentHeadIds.length > 1) {
      throw new SessionCheckpointWorkflowError('会话已分叉，请先明确选择一条 head 继续，或选择全部 head 合并', 409);
    }
    return { parentCheckpointIds: expectedHeadCheckpointIds, expectedHeadCheckpointIds };
  }
  const currentHeadSet = new Set(currentHeadIds);
  if (requested.some((checkpointId) => !currentHeadSet.has(checkpointId))) {
    throw new SessionCheckpointWorkflowError('所选 checkpoint 已不是当前 head，请刷新会话分叉状态后重试', 409);
  }
  if (requested.length !== 1 && requested.length !== currentHeadIds.length) {
    throw new SessionCheckpointWorkflowError('分叉会话只能继续其中一条 head，或一次合并全部当前 head', 409);
  }
  return { parentCheckpointIds: requested, expectedHeadCheckpointIds };
}

export async function sessionCheckpointPreview(
  provider: SessionProvider,
  providerSessionId: string,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<CheckpointPreview> {
  const resolved = await resolvedSession(provider, providerSessionId, options);
  const rawSummary = createHeuristicSummary({ session: resolved.session, workspace: resolved.workspace });
  const available = providerSummaryAvailable(resolved);
  return checkpointPreview(
    resolved,
    rawSummary,
    summaryGeneration(resolved, {
      method: 'heuristic',
      providerInvocationAttempted: false,
      providerInvocationSucceeded: false,
      message: available
        ? `可显式调用同一 ${provider} 会话生成更可靠摘要；该操作会消耗 provider token`
        : `当前 ${provider} 无头 fork-resume 不可用，已使用本地启发式草稿`,
    }),
  );
}

export async function sessionCheckpointProviderSummaryPreview(
  provider: SessionProvider,
  providerSessionId: string,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<CheckpointPreview> {
  const resolved = await resolvedSession(provider, providerSessionId, options);
  const heuristic = createHeuristicSummary({ session: resolved.session, workspace: resolved.workspace });
  if (!providerSummaryAvailable(resolved)) {
    return checkpointPreview(
      resolved,
      heuristic,
      summaryGeneration(resolved, {
        method: 'heuristic',
        providerInvocationAttempted: true,
        providerInvocationSucceeded: false,
        message: `当前 ${provider} 无头 fork-resume 不可用，未调用其他 provider，已降级为本地草稿`,
      }),
    );
  }

  try {
    const generated = await generateProviderHandoffSummary({
      session: resolved.session,
      capabilities: resolved.providerCapabilities,
      executor: options.providerSummaryExecutor,
    });
    return checkpointPreview(
      resolved,
      generated,
      summaryGeneration(resolved, {
        method: 'provider',
        providerInvocationAttempted: true,
        providerInvocationSucceeded: true,
        message: `已调用同一 ${provider} 会话生成摘要；本次调用会计入 provider token 消耗`,
      }),
    );
  } catch (error) {
    const reason =
      error instanceof ProviderSummaryGenerationError
        ? error.message
        : 'Provider 自摘要调用失败，已降级为本地草稿';
    return checkpointPreview(
      resolved,
      heuristic,
      summaryGeneration(resolved, {
        method: 'heuristic',
        providerInvocationAttempted: true,
        providerInvocationSucceeded: false,
        message: redactSensitiveText(reason),
      }),
    );
  }
}

export async function startSessionCheckpoint(
  provider: SessionProvider,
  providerSessionId: string,
  request: CheckpointCaptureRequest,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<CheckpointJob> {
  const input = checkpointCaptureRequestSchema.parse(request);
  const resolved = await resolvedSession(provider, providerSessionId, options);
  if (
    !resolved.workspace ||
    !resolved.workspaceFingerprint ||
    !resolved.session.repositoryId ||
    !resolved.repositoryPath ||
    !resolved.remoteName ||
    !resolved.sourceSyncGate
  ) {
    throw new SessionCheckpointWorkflowError('该会话尚未关联 Fleet 仓库，不能生成可恢复的 workspace checkpoint', 409);
  }
  if (resolved.workspaceFingerprint !== input.expectedWorkspaceFingerprint) {
    throw new SessionCheckpointWorkflowError('项目工作区已变化，请重新预览交接摘要后再保存', 409);
  }
  if (resolved.sourceSyncGate.fingerprint !== input.expectedSourceSyncFingerprint) {
    throw new SessionCheckpointWorkflowError('源码同步门状态已变化，请重新预览后再保存', 409);
  }
  const vaultStatus = await loadSessionVaultStatus(options.vault);
  if (!vaultStatus.configured || !vaultStatus.binding || !vaultStatus.manifest) {
    throw new SessionCheckpointWorkflowError('Session Vault 尚未初始化，请先完成独立 Vault 设置', 409);
  }
  const sessionId = input.sessionId ?? logicalSessionId(provider, providerSessionId);
  const machine = machineName(input.machine ?? options.machine);
  const lineage = await resolveCheckpointParents(sessionId, input.parentCheckpointIds, options.vault ?? {});
  const now = new Date();
  const captureSession = { ...resolved.session, title: input.summary.goal };
  const nativeCapsule = input.captureNativeCapsule
    ? await captureNativeCapsule({
        session: resolved.session,
        capabilities: resolved.providerCapabilities,
        claudeHome: options.claudeHome,
        codexHome: options.codexHome,
        now,
      })
    : notCapturedNativeCapsule(provider, providerSessionId, now.toISOString());
  const checkpointId = plannedCheckpointId(
    {
      sessionId,
      session: captureSession,
      summary: input.summary,
      workspace: resolved.workspace,
      parentCheckpointIds: lineage.parentCheckpointIds,
      resumedFromCheckpointId: input.resumedFromCheckpointId,
      nativeCapsule,
    },
    now,
  );
  const progress = (
    operationId: string,
    step: CheckpointCaptureProgress['step'],
    state: CheckpointCaptureProgress['state'],
    message: string,
  ): CheckpointCaptureProgress =>
    checkpointCaptureProgressSchema.parse({
      operationId,
      checkpointId,
      step,
      state,
      message,
      occurredAt: new Date().toISOString(),
    });
  return startCheckpointJob(async (operationId, onProgress) => {
    onProgress(progress(operationId, 'source-sync-check', 'running', '复核分支、HEAD 与源码远端可达性'));
    let sourceSync: SourceSyncResult;
    try {
      sourceSync = await (options.sourceSyncExecutor ?? executeSourceSync)({
        repositoryPath: resolved.repositoryPath!,
        repositoryId: resolved.session.repositoryId!,
        workspace: resolved.workspace!,
        remoteName: resolved.remoteName!,
        refreshRemote: true,
        choice: input.sourceSyncChoice,
        expectedFingerprint: input.expectedSourceSyncFingerprint!,
        checkpointId,
        now,
      });
    } catch (error) {
      const message =
        error instanceof SourceSyncError ? error.message : '源码同步未完成，尚未生成 Session Vault checkpoint';
      onProgress(progress(operationId, 'source-sync-push', 'failed', message));
      throw error;
    }
    onProgress(progress(operationId, 'source-sync-push', 'completed', sourceSync.message));
    return captureCheckpoint({
      operationId,
      vaultPath: vaultStatus.binding!.vaultPath,
      sessionId,
      session: captureSession,
      summary: input.summary,
      workspace: resolved.workspace!,
      parentCheckpointIds: lineage.parentCheckpointIds,
      expectedHeadCheckpointIds: lineage.expectedHeadCheckpointIds,
      resumedFromCheckpointId: input.resumedFromCheckpointId,
      machine,
      capabilities: {
        nativeResume: nativeCapsule.manifest.status === 'verified',
        universalHandoff: true,
        codeReachable: sourceSync.codeReachable,
        wipRef: sourceSync.mode === 'pushed-wip-ref' ? sourceSync.ref : null,
        sourceSync,
      },
      nativeCapsule,
      now,
      onProgress,
    });
  });
}
