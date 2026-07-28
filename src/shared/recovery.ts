import { z } from 'zod';
import { recoveryLaunchSchema } from './cmux.js';
import { nativeRestorePlanSchema } from './native-capsule.js';
import { providerPermissionModeSchema } from './provider-command.js';
import { checkpointSchema, sessionProviderSchema } from './sessions.js';

export const recoveryMappingStateSchema = z.enum([
  'matched-registered',
  'matched-manual',
  'needs-selection',
  'invalid',
  'remote-mismatch',
]);
export type RecoveryMappingState = z.infer<typeof recoveryMappingStateSchema>;

export const recoveryMappingSchema = z.object({
  schemaVersion: z.literal(1),
  state: recoveryMappingStateSchema,
  projectId: z.string().min(1).max(255),
  repositoryId: z.string().min(1).max(120).nullable(),
  repositoryName: z.string().min(1).max(120).nullable(),
  localPath: z.string().min(1).max(4_000).nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  normalizedRemote: z.string().min(1).max(2_000).nullable(),
  source: z.enum(['fleet-registry', 'saved-manual', 'request-manual', 'none']),
  message: z.string().min(1).max(2_000),
}).strict();
export type RecoveryMapping = z.infer<typeof recoveryMappingSchema>;

export const recoveryDiffFileSchema = z.object({
  path: z.string().min(1).max(4_000),
  status: z.string().min(1).max(20),
}).strict();
export type RecoveryDiffFile = z.infer<typeof recoveryDiffFileSchema>;

export const recoveryWorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  localPath: z.string().min(1).max(4_000),
  branch: z.string().max(1_024).nullable(),
  detached: z.boolean(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  upstream: z.string().max(2_000).nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  dirty: z.boolean(),
  changedFiles: z.number().int().nonnegative(),
  stagedFiles: z.number().int().nonnegative(),
  modifiedFiles: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  renamedFiles: z.number().int().nonnegative(),
  untrackedFiles: z.number().int().nonnegative(),
  files: z.array(recoveryDiffFileSchema).max(1_000),
  diff: z.string().max(120_000),
  diffTruncated: z.boolean(),
  branchMatchesCheckpoint: z.boolean(),
  headMatchesCheckpoint: z.boolean(),
  workspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RecoveryWorkspace = z.infer<typeof recoveryWorkspaceSchema>;

export const recoveryWipSchema = z.object({
  schemaVersion: z.literal(1),
  present: z.boolean(),
  ref: z.string().min(1).max(500).nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  expectedCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  reachable: z.boolean(),
  fetched: z.boolean(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  includesWorkingTree: z.boolean(),
  files: z.array(recoveryDiffFileSchema).max(1_000),
  diff: z.string().max(120_000),
  diffTruncated: z.boolean(),
  message: z.string().min(1).max(2_000),
}).strict();
export type RecoveryWip = z.infer<typeof recoveryWipSchema>;

export const recoveryBlockerSchema = z.object({
  code: z.string().min(1).max(120),
  severity: z.enum(['blocking', 'warning']),
  message: z.string().min(1).max(2_000),
}).strict();
export type RecoveryBlocker = z.infer<typeof recoveryBlockerSchema>;

export const recoveryStructuredContextSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(255),
  checkpointId: z.string().min(1).max(255),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  title: z.string().max(500),
  projectId: z.string().min(1).max(255),
  repositoryId: z.string().min(1).max(120).nullable(),
  localPath: z.string().min(1).max(4_000).nullable(),
  branch: z.string().max(1_024).nullable(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  dirty: z.boolean().nullable(),
  codeReachable: z.boolean(),
  wipRef: z.string().min(1).max(500).nullable(),
  wipCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
}).strict();
export type RecoveryStructuredContext = z.infer<typeof recoveryStructuredContextSchema>;

export const recoveryCommandSchema = z.object({
  provider: sessionProviderSchema,
  mode: z.enum(['universal', 'native']),
  command: z.string().min(1).max(120_000),
  available: z.boolean(),
  message: z.string().min(1).max(2_000),
}).strict();
export type RecoveryCommand = z.infer<typeof recoveryCommandSchema>;

export const recoveryPlanSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(255),
  checkpoint: checkpointSchema,
  mapping: recoveryMappingSchema,
  workspace: recoveryWorkspaceSchema.nullable(),
  wip: recoveryWipSchema,
  blockers: z.array(recoveryBlockerSchema).max(50),
  canStartUniversal: z.boolean(),
  handoffMarkdown: z.string().max(1_000_000),
  structuredContext: recoveryStructuredContextSchema,
  structuredContextJson: z.string().max(50_000),
  recoveryPrompt: z.string().max(80_000),
  command: recoveryCommandSchema.nullable(),
  launch: recoveryLaunchSchema.nullable(),
  native: nativeRestorePlanSchema,
  generatedAt: z.string().datetime({ offset: true }),
}).strict();
export type RecoveryPlan = z.infer<typeof recoveryPlanSchema>;

export const recoveryPlanRequestSchema = z.object({
  localPath: z.string().trim().min(1).max(4_000).nullable().optional(),
  checkpointId: z.string().trim().min(1).max(255).optional(),
  permissionMode: providerPermissionModeSchema.default('standard'),
  refreshRemote: z.boolean().default(true),
}).strict();
export type RecoveryPlanRequest = z.input<typeof recoveryPlanRequestSchema>;

export const recoveryMappingEntrySchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1).max(255),
  localPath: z.string().min(1).max(4_000),
  normalizedRemote: z.string().min(1).max(2_000).nullable(),
  savedAt: z.string().datetime({ offset: true }),
}).strict();
export type RecoveryMappingEntry = z.infer<typeof recoveryMappingEntrySchema>;

export const recoveryMappingsFileSchema = z.object({
  schemaVersion: z.literal(1),
  mappings: z.record(z.string().min(1).max(255), recoveryMappingEntrySchema),
}).strict();
export type RecoveryMappingsFile = z.infer<typeof recoveryMappingsFileSchema>;
