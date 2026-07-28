import { z } from 'zod';
import { providerPermissionModeSchema } from './provider-command.js';
import { sessionProviderSchema } from './sessions.js';

export const nativeCapsuleStatusSchema = z.enum([
  'verified',
  'unsupported',
  'not-captured',
  'restore-failed',
]);
export type NativeCapsuleStatus = z.infer<typeof nativeCapsuleStatusSchema>;

export const nativeCapsuleRestoreCheckSchema = z.enum(['passed', 'unsupported', 'not-run', 'failed']);

export const nativeCapsuleFileSchema = z.object({
  path: z.literal('native/files/session-record.jsonl'),
  fileName: z.string().regex(/^[A-Za-z0-9._:-]+\.jsonl$/).max(255),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(50 * 1024 * 1024),
  recordedAt: z.string().datetime({ offset: true }).nullable(),
  datePath: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/).nullable(),
}).strict();
export type NativeCapsuleFile = z.infer<typeof nativeCapsuleFileSchema>;

export const nativeCapsuleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  status: nativeCapsuleStatusSchema,
  providerVersion: z.string().min(1).max(1_000).nullable(),
  formatVersion: z.enum(['claude-jsonl-v1', 'codex-rollout-jsonl-v1']).nullable(),
  capturedAt: z.string().datetime({ offset: true }),
  files: z.array(nativeCapsuleFileSchema).max(1),
  restoreCheck: nativeCapsuleRestoreCheckSchema,
  sourceTailTruncated: z.boolean(),
  redactionsApplied: z.number().int().nonnegative(),
  reason: z.string().min(1).max(2_000).nullable(),
}).strict().superRefine((manifest, context) => {
  if (manifest.status === 'verified' && manifest.files.length !== 1) {
    context.addIssue({ code: 'custom', path: ['files'], message: '已验证的原生胶囊必须包含一份白名单会话文件' });
  }
  if (manifest.status === 'verified' && (!manifest.providerVersion || !manifest.formatVersion || manifest.restoreCheck !== 'passed')) {
    context.addIssue({ code: 'custom', path: ['status'], message: '已验证的原生胶囊缺少版本或格式校验结果' });
  }
  if (manifest.status === 'not-captured' && manifest.files.length > 0) {
    context.addIssue({ code: 'custom', path: ['files'], message: '未捕获状态不能引用原生文件' });
  }
});
export type NativeCapsuleManifest = z.infer<typeof nativeCapsuleManifestSchema>;

export const checkpointPayloadManifestSchema = z.object({
  schemaVersion: z.literal(1),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  summarySource: z.enum(['provider-export', 'ai-generated', 'heuristic', 'manual']),
  reviewedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  nativeCapsule: nativeCapsuleManifestSchema.optional(),
}).strict();
export type CheckpointPayloadManifest = z.infer<typeof checkpointPayloadManifestSchema>;

export const nativeRestoreActionSchema = z.enum([
  'unavailable',
  'install',
  'replace-with-backup',
  'already-present',
]);

export const nativeRestorePlanSchema = z.object({
  schemaVersion: z.literal(1),
  status: nativeCapsuleStatusSchema,
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  providerVersionAtCapture: z.string().max(1_000).nullable(),
  localProviderVersion: z.string().max(1_000).nullable(),
  formatVersion: z.string().max(255).nullable(),
  available: z.boolean(),
  action: nativeRestoreActionSchema,
  targetDisplayPath: z.string().max(4_000).nullable(),
  targetExists: z.boolean(),
  backupRequired: z.boolean(),
  capsuleSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  currentTargetSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  expectedTargetSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  nativeCommand: z.string().max(4_000).nullable(),
  message: z.string().min(1).max(2_000),
}).strict();
export type NativeRestorePlan = z.infer<typeof nativeRestorePlanSchema>;

export const nativeRestoreExecuteRequestSchema = z.object({
  localPath: z.string().trim().min(1).max(4_000).nullable().optional(),
  checkpointId: z.string().trim().min(1).max(255).optional(),
  permissionMode: providerPermissionModeSchema.default('standard'),
  expectedNativeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirmNativeRestore: z.literal(true),
}).strict();
export type NativeRestoreExecuteRequest = z.input<typeof nativeRestoreExecuteRequestSchema>;

export const nativeRestoreResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: nativeCapsuleStatusSchema,
  sessionId: z.string().min(1).max(255),
  checkpointId: z.string().min(1).max(255),
  action: z.enum(['installed', 'replaced', 'already-present', 'failed']),
  targetDisplayPath: z.string().max(4_000),
  installedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  backupId: z.string().regex(/^[0-9a-f-]{36}$/).nullable(),
  backupExists: z.boolean(),
  rollbackAvailable: z.boolean(),
  automaticallyRolledBack: z.boolean(),
  universalFallbackAvailable: z.literal(true),
  nativeCommand: z.string().max(4_000).nullable(),
  message: z.string().min(1).max(2_000),
}).strict();
export type NativeRestoreResult = z.infer<typeof nativeRestoreResultSchema>;

export const nativeRollbackRequestSchema = z.object({
  backupId: z.string().regex(/^[0-9a-f-]{36}$/),
  expectedInstalledSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmRollback: z.literal(true),
}).strict();
export type NativeRollbackRequest = z.infer<typeof nativeRollbackRequestSchema>;

export const nativeRollbackResultSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(255),
  checkpointId: z.string().min(1).max(255),
  backupId: z.string().regex(/^[0-9a-f-]{36}$/),
  targetDisplayPath: z.string().max(4_000),
  restoredOriginal: z.boolean(),
  removedInstalledFile: z.boolean(),
  message: z.string().min(1).max(2_000),
}).strict();
export type NativeRollbackResult = z.infer<typeof nativeRollbackResultSchema>;
