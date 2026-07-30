import { z } from 'zod';

/** Providers whose on-disk session formats are inspected by the M0 adapters. */
export const sessionProviderSchema = z.enum(['claude', 'codex']);
export type SessionProvider = z.infer<typeof sessionProviderSchema>;

export const capabilityStateSchema = z.enum(['supported', 'unsupported', 'unknown']);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

/**
 * A provider capability result is deliberately descriptive rather than a
 * boolean.  A shim can be executable while still being impossible to verify;
 * that case must remain `unknown` so callers can safely fall back.
 */
export const providerCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  provider: sessionProviderSchema,
  state: capabilityStateSchema,
  command: z.string().min(1).max(255),
  commandPath: z.string().min(1).max(4_000).nullable(),
  realBinaryPath: z.string().min(1).max(4_000).nullable(),
  shimChain: z.array(z.string().min(1).max(4_000)).max(32),
  version: z.string().max(1_000).nullable(),
  helpSignature: z.string().max(2_000).nullable(),
  nativeResume: z.boolean(),
  forkResume: z.boolean(),
  checkedAt: z.string().datetime({ offset: true }),
  reason: z.string().max(2_000).nullable(),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const capabilityCacheSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.object({
    claude: providerCapabilitiesSchema.optional(),
    codex: providerCapabilitiesSchema.optional(),
  }),
});
export type CapabilityCache = z.infer<typeof capabilityCacheSchema>;

export const sessionDiscoveryErrorSchema = z.object({
  provider: sessionProviderSchema,
  path: z.string().min(1).max(4_000),
  message: z.string().min(1).max(2_000),
});
export type SessionDiscoveryError = z.infer<typeof sessionDiscoveryErrorSchema>;

/**
 * A read-only, provider-neutral view of one local transcript file.  It does
 * not contain transcript text or provider database state.  `repositoryId` is
 * the existing Fleet registration when the project can be joined locally.
 */
export const discoveredSessionSchema = z.object({
  schemaVersion: z.literal(1),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  sourcePath: z.string().min(1).max(4_000),
  projectPath: z.string().min(1).max(4_000).nullable(),
  projectId: z.string().min(1).max(255),
  repositoryId: z.string().min(1).max(120).nullable(),
  repositoryName: z.string().min(1).max(120).nullable(),
  title: z.string().max(500).nullable(),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  lastActivityAt: z.string().datetime({ offset: true }).nullable(),
  bytes: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  tailTruncated: z.boolean(),
  readable: z.boolean(),
  error: z.string().max(2_000).nullable(),
  discoveredAt: z.string().datetime({ offset: true }),
});
export type DiscoveredSession = z.infer<typeof discoveredSessionSchema>;

export const sessionDiscoveryResultSchema = z.object({
  schemaVersion: z.literal(1),
  scannedAt: z.string().datetime({ offset: true }),
  sessions: z.array(discoveredSessionSchema),
  errors: z.array(sessionDiscoveryErrorSchema),
  scannedFiles: z.number().int().nonnegative(),
  ignoredFiles: z.number().int().nonnegative(),
});
export type SessionDiscoveryResult = z.infer<typeof sessionDiscoveryResultSchema>;

export const checkpointDiscoveryPayloadSchema = sessionDiscoveryResultSchema.extend({
  machine: z.string().trim().min(1).max(255),
}).strict();
export type CheckpointDiscoveryPayload = z.infer<typeof checkpointDiscoveryPayloadSchema>;

export const handoffSummarySourceSchema = z.enum(['provider-export', 'ai-generated', 'heuristic', 'manual']);
export const handoffSummarySchema = z.object({
  goal: z.string().max(10_000),
  completed: z.array(z.string().max(2_000)).max(200),
  decisions: z.array(z.string().max(2_000)).max(200),
  nextSteps: z.array(z.string().max(2_000)).max(200),
  blockers: z.array(z.string().max(2_000)).max(200),
  commands: z.array(z.string().max(2_000)).max(200),
  risks: z.array(z.string().max(2_000)).max(200),
  source: handoffSummarySourceSchema,
  reviewedAt: z.string().datetime({ offset: true }).nullable(),
});
export type HandoffSummary = z.infer<typeof handoffSummarySchema>;

export const providerSummaryRequestSchema = z.object({
  allowProviderInvocation: z.literal(true),
}).strict();
export type ProviderSummaryRequest = z.infer<typeof providerSummaryRequestSchema>;

export const summaryGenerationSchema = z.object({
  method: z.enum(['heuristic', 'provider']),
  provider: sessionProviderSchema,
  providerInvocationAvailable: z.boolean(),
  providerInvocationAttempted: z.boolean(),
  providerInvocationSucceeded: z.boolean(),
  requiresExplicitOptIn: z.literal(true),
  incursProviderTokenUsage: z.literal(true),
  message: z.string().min(1).max(2_000),
}).strict();
export type SummaryGeneration = z.infer<typeof summaryGenerationSchema>;

export const sourceSyncChoiceSchema = z.enum(['push-branch', 'push-wip-ref', 'handoff-only']);
export type SourceSyncChoice = z.infer<typeof sourceSyncChoiceSchema>;

export const sourceSyncFileStatsSchema = z.object({
  changedFiles: z.number().int().nonnegative(),
  stagedFiles: z.number().int().nonnegative(),
  modifiedFiles: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  renamedFiles: z.number().int().nonnegative(),
  untrackedFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
}).strict();
export type SourceSyncFileStats = z.infer<typeof sourceSyncFileStatsSchema>;

export const sourceSyncGateSchema = z.object({
  schemaVersion: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  repositoryId: z.string().min(1).max(120),
  branch: z.string().max(1_024).nullable(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  workspaceStateHash: z.string().regex(/^[a-f0-9]{64}$/),
  remote: z.string().min(1).max(255).nullable(),
  upstream: z.string().min(1).max(2_000).nullable(),
  dirty: z.boolean(),
  remoteChecked: z.boolean(),
  headReachable: z.boolean(),
  branchReachable: z.boolean(),
  requiresChoice: z.boolean(),
  choices: z.array(sourceSyncChoiceSchema).min(1).max(3),
  message: z.string().min(1).max(2_000),
}).strict();
export type SourceSyncGate = z.infer<typeof sourceSyncGateSchema>;

export const sourceSyncResultSchema = z.object({
  schemaVersion: z.literal(1),
  choice: sourceSyncChoiceSchema,
  mode: z.enum(['already-reachable', 'pushed-branch', 'pushed-wip-ref', 'handoff-only']),
  remote: z.string().min(1).max(255).nullable(),
  ref: z.string().min(1).max(500).nullable(),
  transport: z.enum(['existing-remote', 'branch', 'namespace-ref', 'fallback-branch', 'none']),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  codeReachable: z.boolean(),
  includesWorkingTree: z.boolean(),
  files: sourceSyncFileStatsSchema,
  message: z.string().min(1).max(2_000),
}).strict();
export type SourceSyncResult = z.infer<typeof sourceSyncResultSchema>;

export const checkpointCapabilitiesSchema = z.object({
  nativeResume: z.boolean(),
  universalHandoff: z.boolean(),
  codeReachable: z.boolean(),
  wipRef: z.string().min(1).max(500).nullable(),
  sourceSync: sourceSyncResultSchema.nullable(),
});
export type CheckpointCapabilities = z.infer<typeof checkpointCapabilitiesSchema>;

export const workspaceSnapshotSchema = z.object({
  projectId: z.string().min(1).max(255),
  repositoryId: z.string().min(1).max(120).nullable(),
  branch: z.string().max(1_024).nullable(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  dirty: z.boolean(),
  changedFiles: z.number().int().nonnegative(),
  stagedFiles: z.number().int().nonnegative(),
  modifiedFiles: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  renamedFiles: z.number().int().nonnegative(),
  untrackedFiles: z.number().int().nonnegative(),
}).strict();
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

/** Immutable checkpoint event. There is intentionally no updatedAt field. */
export const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  eventType: z.literal('checkpoint'),
  eventId: z.string().min(1).max(255),
  checkpointId: z.string().min(1).max(255),
  parentCheckpointIds: z.array(z.string().min(1).max(255)).max(50),
  resumedFromCheckpointId: z.string().min(1).max(255).nullable(),
  splitFromCheckpointId: z.string().min(1).max(255).nullable().optional(),
  sessionId: z.string().min(1).max(255),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  title: z.string().max(500),
  projectId: z.string().min(1).max(255),
  repositoryId: z.string().min(1).max(120).nullable(),
  branch: z.string().max(1_024).nullable(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  machine: z.string().min(1).max(255),
  createdAt: z.string().datetime({ offset: true }),
  payloadPath: z.string().min(1).max(1_000),
  capabilities: checkpointCapabilitiesSchema,
}).strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const lifecycleActionSchema = z.enum([
  'pin',
  'unpin',
  'archive',
  'restore',
  'trash',
  'untrash',
  'resolve-trash-conflict',
]);
export type LifecycleAction = z.infer<typeof lifecycleActionSchema>;
export const lifecycleEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventType: z.literal('lifecycle'),
  eventId: z.string().min(1).max(255),
  sessionId: z.string().min(1).max(255),
  action: lifecycleActionSchema,
  machine: z.string().min(1).max(255),
  createdAt: z.string().datetime({ offset: true }),
  retentionUntil: z.string().datetime({ offset: true }).nullable(),
  resolvedCheckpointIds: z.array(z.string().min(1).max(255)).min(1).max(50).optional(),
  reason: z.string().max(2_000).nullable(),
}).strict().superRefine((event, context) => {
  if (event.action === 'trash' && !event.retentionUntil) {
    context.addIssue({ code: 'custom', path: ['retentionUntil'], message: '移入废纸篓事件必须包含保留期限' });
  }
  if (event.action !== 'trash' && event.retentionUntil) {
    context.addIssue({ code: 'custom', path: ['retentionUntil'], message: '仅移入废纸篓事件可以包含保留期限' });
  }
  if (event.action === 'resolve-trash-conflict' && !event.resolvedCheckpointIds) {
    context.addIssue({ code: 'custom', path: ['resolvedCheckpointIds'], message: '删除冲突处置事件必须包含已处置 checkpoint' });
  }
  if (event.action !== 'resolve-trash-conflict' && event.resolvedCheckpointIds) {
    context.addIssue({ code: 'custom', path: ['resolvedCheckpointIds'], message: '仅删除冲突处置事件可以包含已处置 checkpoint' });
  }
});
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export const sessionLineageActionSchema = z.enum(['select-head', 'split']);
export type SessionLineageAction = z.infer<typeof sessionLineageActionSchema>;
export const sessionLineageEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventType: z.literal('lineage'),
  eventId: z.string().min(1).max(255),
  sessionId: z.string().min(1).max(255),
  action: sessionLineageActionSchema,
  expectedResolutionVersion: z.string().min(1).max(255).nullable(),
  expectedHeadCheckpointIds: z.array(z.string().min(1).max(255)).min(2).max(50),
  selectedHeadCheckpointId: z.string().min(1).max(255),
  discardedHeadCheckpointIds: z.array(z.string().min(1).max(255)).min(1).max(49),
  splitSessions: z.array(z.object({
    sourceHeadCheckpointId: z.string().min(1).max(255),
    newSessionId: z.string().min(1).max(255),
    newCheckpointId: z.string().min(1).max(255),
  }).strict()).max(49),
  machine: z.string().min(1).max(255),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((event, context) => {
  const expected = new Set(event.expectedHeadCheckpointIds);
  const discarded = new Set(event.discardedHeadCheckpointIds);
  if (expected.size !== event.expectedHeadCheckpointIds.length || discarded.size !== event.discardedHeadCheckpointIds.length) {
    context.addIssue({ code: 'custom', message: 'lineage head 列表不能包含重复项' });
  }
  if (!expected.has(event.selectedHeadCheckpointId) || discarded.has(event.selectedHeadCheckpointId)) {
    context.addIssue({ code: 'custom', message: 'lineage 选中 head 必须属于 expected 且不能被丢弃' });
  }
  const expectedDiscarded = event.expectedHeadCheckpointIds.filter(
    (checkpointId) => checkpointId !== event.selectedHeadCheckpointId,
  );
  if (expectedDiscarded.length !== discarded.size || expectedDiscarded.some((checkpointId) => !discarded.has(checkpointId))) {
    context.addIssue({ code: 'custom', message: 'lineage discarded heads 必须恰好是未选中的 expected heads' });
  }
  if (event.action === 'select-head' && event.splitSessions.length > 0) {
    context.addIssue({ code: 'custom', message: 'select-head 事件不能包含拆分会话' });
  }
  if (event.action === 'split') {
    const sources = new Set(event.splitSessions.map((item) => item.sourceHeadCheckpointId));
    if (sources.size !== discarded.size || [...discarded].some((checkpointId) => !sources.has(checkpointId))) {
      context.addIssue({ code: 'custom', message: 'split 事件必须为每个被拆出的 head 记录新会话' });
    }
  }
});
export type SessionLineageEvent = z.infer<typeof sessionLineageEventSchema>;

export const sessionEventSchema = z.union([
  checkpointSchema,
  lifecycleEventSchema,
  sessionLineageEventSchema,
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionVaultPrivacyStateSchema = z.enum(['local-only', 'unconfirmed', 'private-user-confirmed']);
export type SessionVaultPrivacyState = z.infer<typeof sessionVaultPrivacyStateSchema>;
export const sessionVaultPrivateRemoteConfirmation = '这是我控制的私有远端';

export const sessionVaultManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('moo-fleet-session-vault'),
  privacyMode: z.literal('plaintext-private'),
  createdAt: z.string().datetime({ offset: true }),
  remote: z.object({
    name: z.string().min(1).max(255),
    normalizedUrl: z.string().min(1).max(2_000),
    privateConfirmed: z.boolean(),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
  }).nullable(),
}).strict();
export type SessionVaultManifest = z.infer<typeof sessionVaultManifestSchema>;

export const sessionVaultBindingSchema = z.object({
  schemaVersion: z.literal(1),
  vaultPath: z.string().min(1).max(4_000),
  remoteSyncEnabled: z.boolean(),
  remoteName: z.string().min(1).max(255).nullable(),
  normalizedRemoteUrl: z.string().min(1).max(2_000).nullable(),
  privacyState: sessionVaultPrivacyStateSchema,
  initializedAt: z.string().datetime({ offset: true }),
}).strict();
export type SessionVaultBinding = z.infer<typeof sessionVaultBindingSchema>;

export const initializeSessionVaultSchema = z.object({
  vaultPath: z.string().trim().min(1).max(4_000),
  remoteName: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).max(255).default('origin'),
  remoteUrl: z.string().trim().min(1).max(2_000).nullable().default(null),
  enableRemoteSync: z.boolean().default(false),
  confirmationPhrase: z.string().max(200).default(''),
});
export type InitializeSessionVaultRequest = z.input<typeof initializeSessionVaultSchema>;
export type InitializedSessionVaultRequest = z.output<typeof initializeSessionVaultSchema>;

export const sessionVaultStatusSchema = z.object({
  configured: z.boolean(),
  binding: sessionVaultBindingSchema.nullable(),
  manifest: sessionVaultManifestSchema.nullable(),
  privacyLabel: z.string().min(1).max(255),
  suggestedVaultPath: z.string().min(1).max(4_000),
});
export type SessionVaultStatus = z.infer<typeof sessionVaultStatusSchema>;

export const sessionVaultSyncStateSchema = z.enum([
  'unconfigured',
  'local-only',
  'unconfirmed',
  'remote-unknown',
  'synced',
  'local-ahead',
  'remote-ahead',
  'diverged',
  'sync-failed',
]);
export type SessionVaultSyncState = z.infer<typeof sessionVaultSyncStateSchema>;

export const sessionVaultSyncStatusSchema = z.object({
  schemaVersion: z.literal(1),
  configured: z.boolean(),
  remoteSyncEnabled: z.boolean(),
  remoteChecked: z.boolean(),
  state: sessionVaultSyncStateSchema,
  localHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  remoteHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  pendingLocal: z.boolean(),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().min(1).max(2_000).nullable(),
  message: z.string().min(1).max(2_000),
}).strict();
export type SessionVaultSyncStatus = z.infer<typeof sessionVaultSyncStatusSchema>;

export const sessionVaultEpochStateSchema = z.enum(['active', 'archived']);
export type SessionVaultEpochState = z.infer<typeof sessionVaultEpochStateSchema>;

export const sessionVaultEpochSchema = z.object({
  schemaVersion: z.literal(1),
  epochId: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive(),
  state: sessionVaultEpochStateSchema,
  readOnly: z.boolean(),
  vaultPath: z.string().min(1).max(4_000),
  remoteSyncEnabled: z.boolean(),
  remoteName: z.string().min(1).max(255).nullable(),
  normalizedRemoteUrl: z.string().min(1).max(2_000).nullable(),
  privacyState: sessionVaultPrivacyStateSchema,
  createdAt: z.string().datetime({ offset: true }),
  activatedAt: z.string().datetime({ offset: true }),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  storageBytes: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
}).strict().superRefine((epoch, context) => {
  if (epoch.state === 'active' && (epoch.readOnly || epoch.archivedAt !== null)) {
    context.addIssue({ code: 'custom', message: '当前纪元必须可写且不能包含归档时间' });
  }
  if (epoch.state === 'archived' && (!epoch.readOnly || epoch.archivedAt === null)) {
    context.addIssue({ code: 'custom', message: '归档纪元必须只读并包含归档时间' });
  }
});
export type SessionVaultEpoch = z.infer<typeof sessionVaultEpochSchema>;

export const sessionVaultEpochCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  activeEpochId: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime({ offset: true }),
  epochs: z.array(sessionVaultEpochSchema).min(1).max(1_000),
}).strict().superRefine((catalog, context) => {
  const ids = new Set(catalog.epochs.map((epoch) => epoch.epochId));
  const active = catalog.epochs.filter((epoch) => epoch.state === 'active');
  if (ids.size !== catalog.epochs.length) {
    context.addIssue({ code: 'custom', message: 'Vault 纪元 ID 不能重复' });
  }
  if (active.length !== 1 || active[0]?.epochId !== catalog.activeEpochId) {
    context.addIssue({ code: 'custom', message: 'Vault 纪元目录必须恰好包含一个当前写入纪元' });
  }
});
export type SessionVaultEpochCatalog = z.infer<typeof sessionVaultEpochCatalogSchema>;

export const sessionVaultEpochStatusSchema = z.object({
  schemaVersion: z.literal(1),
  configured: z.boolean(),
  activeEpochId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  activeEpoch: sessionVaultEpochSchema.nullable(),
  archivedEpochs: z.array(sessionVaultEpochSchema).max(999),
  totalEpochs: z.number().int().nonnegative(),
  rotationThresholdBytes: z.number().int().positive(),
  rotationSuggested: z.boolean(),
  rotationReason: z.string().min(1).max(1_000).nullable(),
}).strict();
export type SessionVaultEpochStatus = z.infer<typeof sessionVaultEpochStatusSchema>;

export const rotateSessionVaultEpochRequestSchema = initializeSessionVaultSchema.extend({
  expectedActiveEpochId: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeReadOnlyArchive: z.literal(true),
}).strict();
export type RotateSessionVaultEpochRequest = z.input<typeof rotateSessionVaultEpochRequestSchema>;
export type RotatedSessionVaultEpochRequest = z.output<typeof rotateSessionVaultEpochRequestSchema>;

export const rotateSessionVaultEpochResultSchema = z.object({
  schemaVersion: z.literal(1),
  previousEpoch: sessionVaultEpochSchema,
  activeEpoch: sessionVaultEpochSchema,
  forcePushUsed: z.literal(false),
  message: z.string().min(1).max(1_000),
}).strict();
export type RotateSessionVaultEpochResult = z.infer<typeof rotateSessionVaultEpochResultSchema>;

export const sessionListItemSchema = z.object({
  sessionId: z.string().min(1).max(255),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  title: z.string().max(500),
  projectId: z.string().min(1).max(255),
  repositoryId: z.string().min(1).max(120).nullable(),
  branch: z.string().max(1_024).nullable(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  machine: z.string().min(1).max(255),
  latestCheckpointId: z.string().min(1).max(255),
  latestCheckpointAt: z.string().datetime({ offset: true }),
  checkpointCount: z.number().int().positive(),
  headCheckpointIds: z.array(z.string().min(1).max(255)).min(1).max(1_000),
  forked: z.boolean(),
  pinned: z.boolean(),
  lifecycleState: z.enum(['active', 'archived', 'trashed']),
  lifecycleVersion: z.string().min(1).max(255).nullable(),
  lifecycleUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  retentionUntil: z.string().datetime({ offset: true }).nullable(),
  deletionConflict: z.boolean(),
  deletionConflictCheckpointIds: z.array(z.string().min(1).max(255)).max(1_000),
  payloadState: z.enum(['available', 'partial', 'purged']),
  payloadBytes: z.number().int().nonnegative(),
  capabilities: checkpointCapabilitiesSchema,
}).strict();
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const sessionLifecycleFilterSchema = z.enum(['active', 'archived', 'trashed', 'all']);
export type SessionLifecycleFilter = z.infer<typeof sessionLifecycleFilterSchema>;

export const sessionLifecycleCountsSchema = z.object({
  active: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  trashed: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
}).strict();
export type SessionLifecycleCounts = z.infer<typeof sessionLifecycleCountsSchema>;

export const sessionListPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(sessionListItemSchema).max(50),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  counts: sessionLifecycleCountsSchema,
  sync: sessionVaultSyncStatusSchema,
}).strict();
export type SessionListPayload = z.infer<typeof sessionListPayloadSchema>;

export const sessionVaultEpochSessionListSchema = sessionListPayloadSchema.extend({
  epoch: sessionVaultEpochSchema,
}).strict();
export type SessionVaultEpochSessionList = z.infer<typeof sessionVaultEpochSessionListSchema>;

export const sessionLifecycleMutationActionSchema = z.enum(['pin', 'unpin', 'archive', 'restore', 'trash', 'untrash']);
export type SessionLifecycleMutationAction = z.infer<typeof sessionLifecycleMutationActionSchema>;

export const sessionLifecycleMutationRequestSchema = z.object({
  action: sessionLifecycleMutationActionSchema,
  expectedLifecycleVersion: z.string().min(1).max(255).nullable(),
}).strict();
export type SessionLifecycleMutationRequest = z.infer<typeof sessionLifecycleMutationRequestSchema>;

export const sessionLifecycleMutationResultSchema = z.object({
  schemaVersion: z.literal(1),
  event: lifecycleEventSchema,
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  auditRecorded: z.boolean(),
  message: z.string().min(1).max(1_000),
}).strict();
export type SessionLifecycleMutationResult = z.infer<typeof sessionLifecycleMutationResultSchema>;

export const sessionDetailSchema = z.object({
  schemaVersion: z.literal(1),
  session: sessionListItemSchema,
  checkpoints: z.array(checkpointSchema).min(1).max(2_000),
  latestHandoffMarkdown: z.string().max(1_000_000).nullable(),
  latestWorkspace: workspaceSnapshotSchema.nullable(),
}).strict();
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

export const sessionTrashEmptyPreviewSchema = z.object({
  schemaVersion: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime({ offset: true }),
  totalTrashed: z.number().int().nonnegative(),
  eligibleSessions: z.number().int().nonnegative(),
  retainedSessions: z.number().int().nonnegative(),
  forkedSessions: z.number().int().nonnegative(),
  deletionConflictSessions: z.number().int().nonnegative(),
  removableObjects: z.number().int().nonnegative(),
  removableBytes: z.number().int().nonnegative(),
  syncReady: z.boolean(),
  syncMessage: z.string().min(1).max(1_000),
  canEmpty: z.boolean(),
  blockers: z.array(z.string().min(1).max(1_000)).max(20),
  historyWarning: z.string().min(1).max(1_000),
}).strict();
export type SessionTrashEmptyPreview = z.infer<typeof sessionTrashEmptyPreviewSchema>;

export const sessionTrashEmptyRequestSchema = z.object({
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeGitHistoryRetention: z.literal(true),
}).strict();
export type SessionTrashEmptyRequest = z.infer<typeof sessionTrashEmptyRequestSchema>;

export const sessionTrashEmptyResultSchema = z.object({
  schemaVersion: z.literal(1),
  removedSessions: z.number().int().nonnegative(),
  removedObjects: z.number().int().nonnegative(),
  removedBytes: z.number().int().nonnegative(),
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  auditRecorded: z.boolean(),
  message: z.string().min(1).max(1_000),
}).strict();
export type SessionTrashEmptyResult = z.infer<typeof sessionTrashEmptyResultSchema>;

export const sessionDeletionConflictSaveRequestSchema = z.object({
  expectedLifecycleVersion: z.string().min(1).max(255),
  expectedConflictCheckpointIds: z.array(z.string().min(1).max(255)).min(1).max(50),
  sourceCheckpointId: z.string().min(1).max(255),
  summary: handoffSummarySchema.refine((summary) => summary.source === 'manual' && Boolean(summary.reviewedAt), {
    message: '另存的新会话摘要必须由用户复核并标记为 manual',
    path: ['reviewedAt'],
  }),
}).strict();
export type SessionDeletionConflictSaveRequest = z.infer<typeof sessionDeletionConflictSaveRequestSchema>;

export const sessionDeletionConflictSaveResultSchema = z.object({
  schemaVersion: z.literal(1),
  newSessionId: z.string().min(1).max(255),
  checkpoint: checkpointSchema,
  checkpointCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  resolution: sessionLifecycleMutationResultSchema,
  message: z.string().min(1).max(1_000),
}).strict();
export type SessionDeletionConflictSaveResult = z.infer<typeof sessionDeletionConflictSaveResultSchema>;

export const sessionCheckpointPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  checkpoint: checkpointSchema,
  handoffMarkdown: z.string().max(1_000_000),
  workspace: workspaceSnapshotSchema,
}).strict();
export type SessionCheckpointPayload = z.infer<typeof sessionCheckpointPayloadSchema>;

export const sessionForkMergeRequestSchema = z.object({
  expectedHeadCheckpointIds: z.array(z.string().min(1).max(255)).min(2).max(50),
  baseCheckpointId: z.string().min(1).max(255),
  summary: handoffSummarySchema.refine((summary) => summary.source === 'manual' && Boolean(summary.reviewedAt), {
    message: '分叉合并摘要必须由用户复核并标记为 manual',
    path: ['reviewedAt'],
  }),
}).strict();
export type SessionForkMergeRequest = z.infer<typeof sessionForkMergeRequestSchema>;

export const sessionForkSelectRequestSchema = z.object({
  expectedHeadCheckpointIds: z.array(z.string().min(1).max(255)).min(2).max(50),
  selectedHeadCheckpointId: z.string().min(1).max(255),
}).strict();
export type SessionForkSelectRequest = z.infer<typeof sessionForkSelectRequestSchema>;

export const sessionForkSplitRequestSchema = z.object({
  expectedHeadCheckpointIds: z.array(z.string().min(1).max(255)).length(2),
  selectedHeadCheckpointId: z.string().min(1).max(255),
  splitHeadCheckpointId: z.string().min(1).max(255),
  newSessionSummary: handoffSummarySchema.refine(
    (summary) => summary.source === 'manual' && Boolean(summary.reviewedAt),
    { message: '拆分后的新会话摘要必须由用户复核并标记为 manual', path: ['reviewedAt'] },
  ),
}).strict();
export type SessionForkSplitRequest = z.infer<typeof sessionForkSplitRequestSchema>;

export const sessionForkResolutionResultSchema = z.object({
  schemaVersion: z.literal(1),
  event: sessionLineageEventSchema,
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  message: z.string().min(1).max(1_000),
}).strict();
export type SessionForkResolutionResult = z.infer<typeof sessionForkResolutionResultSchema>;

export const sessionForkSelectResultSchema = sessionForkResolutionResultSchema.extend({
  auditRecorded: z.boolean(),
}).strict();
export type SessionForkSelectResult = z.infer<typeof sessionForkSelectResultSchema>;

export const sessionForkSplitResultSchema = z.object({
  schemaVersion: z.literal(1),
  newSessionId: z.string().min(1).max(255),
  checkpoint: checkpointSchema,
  checkpointCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  resolution: sessionForkResolutionResultSchema,
  auditRecorded: z.boolean(),
  message: z.string().min(1).max(1_000),
}).strict();
export type SessionForkSplitResult = z.infer<typeof sessionForkSplitResultSchema>;

export const checkpointCaptureStepSchema = z.enum([
  'native-capture',
  'source-sync-check',
  'source-sync-push',
  'preparing',
  'writing-staging',
  'secret-scan',
  'publishing-object',
  'writing-event',
  'committing',
  'complete',
  'failed',
]);
export const checkpointCaptureProgressSchema = z.object({
  operationId: z.string().min(1).max(255),
  checkpointId: z.string().min(1).max(255).nullable(),
  step: checkpointCaptureStepSchema,
  state: z.enum(['running', 'completed', 'failed']),
  message: z.string().min(1).max(1_000),
  occurredAt: z.string().datetime({ offset: true }),
});
export type CheckpointCaptureProgress = z.infer<typeof checkpointCaptureProgressSchema>;

export const checkpointCaptureResultSchema = z.object({
  operationId: z.string().min(1).max(255),
  checkpoint: checkpointSchema,
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  durationMs: z.number().int().nonnegative(),
});
export type CheckpointCaptureResult = z.infer<typeof checkpointCaptureResultSchema>;

export const sessionForkMergeResultSchema = checkpointCaptureResultSchema.extend({
  auditRecorded: z.boolean(),
  message: z.string().min(1).max(1_000),
}).strict();
export type SessionForkMergeResult = z.infer<typeof sessionForkMergeResultSchema>;

export const checkpointJobSchema = z.object({
  operationId: z.string().min(1).max(255),
  state: z.enum(['queued', 'running', 'success', 'failed']),
  createdAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  progress: z.array(checkpointCaptureProgressSchema).max(50),
  result: checkpointCaptureResultSchema.nullable(),
  error: z.object({
    code: z.string().min(1).max(255),
    message: z.string().min(1).max(2_000),
  }).nullable(),
});
export type CheckpointJob = z.infer<typeof checkpointJobSchema>;

export const checkpointJobsPayloadSchema = z.object({
  jobs: z.array(checkpointJobSchema),
});
export type CheckpointJobsPayload = z.infer<typeof checkpointJobsPayloadSchema>;

export const sessionBackupItemStateSchema = z.enum([
  'pending',
  'running',
  'backed-up',
  'unchanged',
  'skipped',
  'failed',
]);
export type SessionBackupItemState = z.infer<typeof sessionBackupItemStateSchema>;

export const sessionBackupItemSchema = z.object({
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  title: z.string().max(500).nullable(),
  lastActivityAt: z.string().datetime({ offset: true }).nullable(),
  state: sessionBackupItemStateSchema,
  checkpointId: z.string().min(1).max(255).nullable(),
  message: z.string().min(1).max(2_000),
}).strict();
export type SessionBackupItem = z.infer<typeof sessionBackupItemSchema>;

export const sessionBackupJobSchema = z.object({
  operationId: z.string().min(1).max(255),
  state: z.enum(['queued', 'running', 'success', 'failed']),
  createdAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  total: z.number().int().nonnegative(),
  backedUp: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(sessionBackupItemSchema).max(5_000),
  error: z.object({
    code: z.string().min(1).max(255),
    message: z.string().min(1).max(2_000),
  }).nullable(),
}).strict();
export type SessionBackupJob = z.infer<typeof sessionBackupJobSchema>;

export const sessionContentPreviewItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(2_000),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
});
export type SessionContentPreviewItem = z.infer<typeof sessionContentPreviewItemSchema>;

export const sessionContentPreviewSchema = z.object({
  items: z.array(sessionContentPreviewItemSchema).max(12),
  totalMessages: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type SessionContentPreview = z.infer<typeof sessionContentPreviewSchema>;

export const checkpointPreviewSchema = z.object({
  session: discoveredSessionSchema,
  workspace: workspaceSnapshotSchema.nullable(),
  workspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  summary: handoffSummarySchema,
  summaryGeneration: summaryGenerationSchema,
  sourceSyncGate: sourceSyncGateSchema.nullable(),
  providerCapabilities: providerCapabilitiesSchema,
  contentPreview: sessionContentPreviewSchema,
  secretFindings: z.array(z.object({
    type: z.string().min(1).max(255),
    pathHash: z.string().regex(/^[a-f0-9]{64}$/),
    line: z.number().int().positive(),
    lineHash: z.string().regex(/^[a-f0-9]{64}$/),
  })),
});
export type CheckpointPreview = z.infer<typeof checkpointPreviewSchema>;

export const checkpointCaptureRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(255).optional(),
  summary: handoffSummarySchema.refine((summary) => Boolean(summary.reviewedAt), {
    message: '交接摘要必须先由用户复核',
    path: ['reviewedAt'],
  }),
  expectedWorkspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  expectedSourceSyncFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  sourceSyncChoice: sourceSyncChoiceSchema.default('handoff-only'),
  parentCheckpointIds: z.array(z.string().min(1).max(255)).max(50).default([]),
  resumedFromCheckpointId: z.string().min(1).max(255).nullable().default(null),
  machine: z.string().trim().min(1).max(255).optional(),
  captureNativeCapsule: z.boolean().default(false),
  acknowledgeNativePlaintext: z.literal(true).optional(),
}).strict().superRefine((request, context) => {
  if (request.captureNativeCapsule && request.acknowledgeNativePlaintext !== true) {
    context.addIssue({
      code: 'custom',
      path: ['acknowledgeNativePlaintext'],
      message: '捕获原生胶囊前必须确认原始会话将以脱敏明文写入私有 Vault',
    });
  }
});
export type CheckpointCaptureRequest = z.input<typeof checkpointCaptureRequestSchema>;
