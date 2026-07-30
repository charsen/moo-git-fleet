import { createHash } from 'node:crypto';
import os from 'node:os';
import type {
  CheckpointDiscoveryPayload,
  CheckpointCaptureProgress,
  CheckpointCaptureRequest,
  CheckpointCaptureResult,
  CheckpointJob,
  CheckpointPreview,
  DiscoveredSession,
  HandoffSummary,
  ProviderCapabilities,
  SessionContentPreview,
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
  workspaceSnapshotSchema,
} from '../../shared/sessions.js';
import type { RepositoriesConfig as FleetRepositoriesConfig } from '../../shared/contracts.js';
import { loadRepositories } from '../config/store.js';
import { captureCheckpoint, plannedCheckpointId } from './checkpoint.js';
import { startCheckpointJob } from './checkpoint-jobs.js';
import {
  SessionCatalogError,
  sessionVaultNativeCapsulePayload,
  sessionVaultSessionDetail,
} from './catalog.js';
import { previewSessionContent } from './content-preview.js';
import { discoverSessions } from './discovery.js';
import { captureNativeCapsule, notCapturedNativeCapsule } from './native-capsule.js';
import { probeProviderCapabilities } from './probe.js';
import {
  generateProviderHandoffSummary,
  ProviderSummaryGenerationError,
  type ProviderSummaryExecutor,
} from './provider-summary.js';
import { redactSensitiveText, scanSecrets, type SecretFinding } from './secrets.js';
import type { ExecuteSourceSyncInput, InspectSourceSyncGateInput } from './source-sync.js';
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
  providerCapabilities: ProviderCapabilities;
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
  const capabilities = options.providerCapabilities ?? await probeProviderCapabilities({ provider, command: provider });
  return {
    session,
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
    recentDays: options.recentDays ?? null,
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
  contentPreview: SessionContentPreview,
): CheckpointPreview {
  const secretFindings = previewSecretFindings(rawSummary);
  return checkpointPreviewSchema.parse({
    session: sanitizedSession(resolved.session),
    workspace: null,
    workspaceFingerprint: null,
    summary: secretFindings.length > 0 ? redactSummary(rawSummary) : rawSummary,
    summaryGeneration: generation,
    sourceSyncGate: null,
    providerCapabilities: resolved.providerCapabilities,
    contentPreview,
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
  const contentPreview = await previewSessionContent(resolved.session.sourcePath);
  const rawSummary = createHeuristicSummary({ session: resolved.session, workspace: null });
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
    contentPreview,
  );
}

export async function sessionCheckpointProviderSummaryPreview(
  provider: SessionProvider,
  providerSessionId: string,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<CheckpointPreview> {
  const resolved = await resolvedSession(provider, providerSessionId, options);
  const contentPreview = await previewSessionContent(resolved.session.sourcePath);
  const heuristic = createHeuristicSummary({ session: resolved.session, workspace: null });
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
      contentPreview,
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
      contentPreview,
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
      contentPreview,
    );
  }
}

function sessionOnlyWorkspace(session: DiscoveredSession): WorkspaceSnapshot {
  return workspaceSnapshotSchema.parse({
    projectId: session.projectId,
    repositoryId: session.repositoryId,
    branch: null,
    head: null,
    dirty: false,
    changedFiles: 0,
    stagedFiles: 0,
    modifiedFiles: 0,
    deletedFiles: 0,
    renamedFiles: 0,
    untrackedFiles: 0,
  });
}

export interface LocalSessionBackupInput {
  session: DiscoveredSession;
  summary?: HandoffSummary;
  sessionId?: string;
  parentCheckpointIds?: string[];
  resumedFromCheckpointId?: string | null;
  machine?: string;
  captureNative?: boolean;
  requireNative?: boolean;
  skipUnchanged?: boolean;
  skipBlocked?: boolean;
  providerCapabilities?: ProviderCapabilities;
  operationId?: string;
  onProgress?: (progress: CheckpointCaptureProgress) => void | Promise<void>;
}

export interface LocalSessionBackupResult {
  outcome: 'backed-up' | 'unchanged' | 'skipped';
  checkpoint: CheckpointCaptureResult | null;
  message: string;
}

export async function backupLocalSession(
  input: LocalSessionBackupInput,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<LocalSessionBackupResult> {
  const vaultStatus = await loadSessionVaultStatus(options.vault);
  if (!vaultStatus.configured || !vaultStatus.binding || !vaultStatus.manifest) {
    throw new SessionCheckpointWorkflowError('会话备份仓库尚未设置', 409);
  }
  const now = new Date();
  const session = sanitizedSession(input.session);
  const sessionId = input.sessionId ?? logicalSessionId(session.provider, session.providerSessionId);
  const machine = machineName(input.machine ?? options.machine);
  let current: Awaited<ReturnType<typeof sessionVaultSessionDetail>> | null = null;
  try {
    current = await sessionVaultSessionDetail(sessionId, options.vault ?? {});
  } catch (error) {
    if (!(error instanceof SessionCatalogError) || error.statusCode !== 404) throw error;
  }
  if (current?.session.lifecycleState === 'trashed') {
    const message = '该会话已在废纸篓中，未自动重新加入备份';
    if (input.skipBlocked) return { outcome: 'skipped', checkpoint: null, message };
    throw new SessionCheckpointWorkflowError(message, 409);
  }
  if (current?.session.forked) {
    const message = '该会话存在两个版本，需要先选择保留方式';
    if (input.skipBlocked) return { outcome: 'skipped', checkpoint: null, message };
    throw new SessionCheckpointWorkflowError(message, 409);
  }

  const capabilities = input.providerCapabilities ?? options.providerCapabilities ?? await probeProviderCapabilities({
    provider: session.provider,
    command: session.provider,
  });
  const nativeCapsule = input.captureNative === false
    ? notCapturedNativeCapsule(session.provider, session.providerSessionId, now.toISOString())
    : await captureNativeCapsule({
        session,
        capabilities,
        claudeHome: options.claudeHome,
        codexHome: options.codexHome,
        now,
      });
  if (input.requireNative && nativeCapsule.manifest.status !== 'verified') {
    return {
      outcome: 'skipped',
      checkpoint: null,
      message: nativeCapsule.manifest.reason ?? '当前会话格式暂时无法完整备份',
    };
  }

  if (input.skipUnchanged && current && nativeCapsule.manifest.status === 'verified') {
    try {
      const previous = await sessionVaultNativeCapsulePayload(
        sessionId,
        current.session.latestCheckpointId,
        options.vault ?? {},
      );
      const previousFile = previous.manifest.files[0];
      const currentFile = nativeCapsule.manifest.files[0];
      if (previous.manifest.status === 'verified' && previousFile && currentFile && previousFile.sha256 === currentFile.sha256) {
        return { outcome: 'unchanged', checkpoint: null, message: '内容与最近一次备份相同' };
      }
    } catch (error) {
      if (!(error instanceof SessionCatalogError) || ![404, 410].includes(error.statusCode)) throw error;
    }
  }

  const rawSummary = input.summary ?? {
    ...createHeuristicSummary({ session, workspace: null }),
    reviewedAt: now.toISOString(),
  };
  const summary = previewSecretFindings(rawSummary).length > 0 ? redactSummary(rawSummary) : rawSummary;
  const workspace = sessionOnlyWorkspace(session);
  const lineage = await resolveCheckpointParents(
    sessionId,
    input.parentCheckpointIds ?? [],
    options.vault ?? {},
  );
  const captureSession = { ...session, title: summary.goal || session.title };
  const checkpointId = plannedCheckpointId({
    sessionId,
    session: captureSession,
    summary,
    workspace,
    parentCheckpointIds: lineage.parentCheckpointIds,
    resumedFromCheckpointId: input.resumedFromCheckpointId ?? null,
    nativeCapsule,
  }, now);
  const progress = (
    operationId: string,
    step: CheckpointCaptureProgress['step'],
    state: CheckpointCaptureProgress['state'],
    message: string,
  ): CheckpointCaptureProgress => checkpointCaptureProgressSchema.parse({
    operationId,
    checkpointId,
    step,
    state,
    message,
    occurredAt: new Date().toISOString(),
  });
  const operationId = input.operationId;
  if (operationId && input.onProgress) {
    await input.onProgress(progress(operationId, 'native-capture', 'completed', '完整会话记录已准备'));
  }
  const checkpoint = await captureCheckpoint({
    operationId,
    vaultPath: vaultStatus.binding.vaultPath,
    sessionId,
    session: captureSession,
    summary,
    workspace,
    parentCheckpointIds: lineage.parentCheckpointIds,
    expectedHeadCheckpointIds: lineage.expectedHeadCheckpointIds,
    resumedFromCheckpointId: input.resumedFromCheckpointId ?? null,
    machine,
    capabilities: {
      nativeResume: nativeCapsule.manifest.status === 'verified',
      universalHandoff: true,
      codeReachable: false,
      wipRef: null,
      sourceSync: null,
    },
    nativeCapsule,
    now,
    onProgress: input.onProgress,
  });
  return { outcome: 'backed-up', checkpoint, message: '会话已备份' };
}

export async function startSessionCheckpoint(
  provider: SessionProvider,
  providerSessionId: string,
  request: CheckpointCaptureRequest,
  options: SessionCheckpointWorkflowOptions = {},
): Promise<CheckpointJob> {
  const input = checkpointCaptureRequestSchema.parse(request);
  if (input.sourceSyncChoice !== 'handoff-only') {
    throw new SessionCheckpointWorkflowError('会话备份不再同步项目代码，请使用项目自己的 Git', 409);
  }
  const resolved = await resolvedSession(provider, providerSessionId, options);
  return startCheckpointJob(async (operationId, onProgress) => {
    const result = await backupLocalSession({
      session: resolved.session,
      summary: input.summary,
      sessionId: input.sessionId,
      parentCheckpointIds: input.parentCheckpointIds,
      resumedFromCheckpointId: input.resumedFromCheckpointId,
      machine: input.machine,
      captureNative: input.captureNativeCapsule,
      providerCapabilities: resolved.providerCapabilities,
      operationId,
      onProgress,
    }, options);
    if (!result.checkpoint) throw new SessionCheckpointWorkflowError(result.message, 409);
    return result.checkpoint;
  });
}
