import { z } from 'zod';
import { discoveredSessionSchema, sessionContentPreviewSchema, sessionProviderSchema } from './sessions.js';

/**
 * 会话同步只有一个心智模型：本机的 JSONL 与备份仓里的 JSONL 比一比，
 * 结果只有「一样 / 一方更全（追加）/ 真的分叉了（要人来选）」三类。
 */
export const sessionSyncRelationSchema = z.enum([
  /** 两边内容完全一致，跳过。 */
  'same',
  /** 只有本机有：备份仓需要新增。 */
  'local-only',
  /** 只有备份有：另一台电脑的会话，可恢复到本机。 */
  'backup-only',
  /** 本机包含备份的全部内容：用本机内容更新备份。 */
  'local-ahead',
  /** 备份包含本机的全部内容：把新增部分追加到本机。 */
  'backup-ahead',
  /** 两边从同一处各自往下写：需要用户选择。 */
  'diverged',
  /** 另一台电脑删除了这个会话，本机还在：需要用户选择。 */
  'backup-deleted',
]);
export type SessionSyncRelation = z.infer<typeof sessionSyncRelationSchema>;

/** 同步时对一条会话采取的动作，只在服务端内部流转。 */
export type SessionSyncAction = 'skip' | 'write-backup' | 'write-local' | 'ask';

/** 用户对需要决策项的选择。 */
export const sessionSyncDecisionSchema = z.enum([
  /** 用本机内容覆盖备份。 */
  'keep-local',
  /** 用备份内容覆盖本机。 */
  'keep-backup',
  /** 两份都留：备份那份以新会话名写入本机。 */
  'keep-both',
  /** 跟随另一台电脑的删除，把本机会话也移到废纸篓。 */
  'delete-local',
]);
export type SessionSyncDecision = z.infer<typeof sessionSyncDecisionSchema>;

/** 每个 relation 允许的选择，服务端与 UI 共用同一份口径。 */
export const sessionSyncDecisionOptions: Record<SessionSyncRelation, SessionSyncDecision[]> = {
  same: [],
  'local-only': [],
  'backup-only': [],
  'local-ahead': [],
  'backup-ahead': [],
  diverged: ['keep-local', 'keep-backup', 'keep-both'],
  'backup-deleted': ['keep-local', 'delete-local'],
};

/**
 * 「两份都留」时另存的那份会话，ID 是 `<原 ID>--<设备名>`。
 * provider 自己的会话 ID 是 UUID，不含 `--`，所以这个后缀足以区分。
 */
export const keptCopySeparator = '--';

export function isKeptCopy(providerSessionId: string): boolean {
  return providerSessionId.includes(keptCopySeparator);
}

export const backupSessionMetaSchema = z.object({
  schemaVersion: z.literal(1),
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1),
  title: z.string().nullable(),
  projectId: z.string(),
  projectPath: z.string().nullable(),
  repositoryName: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  /**
   * 会话文件在 provider 目录里的相对位置（如 `projects/-work-x/<id>.jsonl`）。
   * 恢复到另一台电脑时优先按本机项目目录重建，重建不了就原样落地，
   * 这样不需要在两台电脑之间维护任何路径映射表。
   */
  sourceRelativePath: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  /** 最后写入这份备份的设备名，用于「两份都留」时区分来源。 */
  device: z.string(),
  updatedAt: z.string(),
  /** 墓碑：某台电脑删除了这个会话，保留记录以免另一台把它同步回来。 */
  deleted: z.boolean(),
  deletedAt: z.string().nullable(),
});
export type BackupSessionMeta = z.infer<typeof backupSessionMetaSchema>;

/**
 * 客户端与服务端共用的请求约定。
 * 备份仓就是本机的一个文件夹：留空表示「只备份在本机」，
 * 想跨电脑同步就选一个自己 clone 下来的空私仓，remote 从它自身的 origin 读。
 */
export const initializeBackupSchema = z.object({
  /** 留空用建议位置。 */
  backupPath: z.string().trim().max(4_000).nullish(),
  /**
   * 用户已经确认「这个旧版备份仓可以清空并升级」。
   * 只对识别得出的旧版备份仓有意义，对空目录 / 空仓库 / 新版备份仓都是无害的空标志；
   * 任何**别的**有内容的仓库带上它也照样被拒绝——这个守卫防的就是手滑覆盖代码仓。
   */
  upgradeLegacy: z.boolean().optional(),
});
export type InitializeBackupRequest = z.infer<typeof initializeBackupSchema>;

/**
 * 机器可读的错误码：选中的目录是 v0.3 的会话备份仓，需要用户确认后才能覆盖升级。
 * 服务端放在 409 响应的 `code` 里，前端据此把它变成一次确认流程而不是红字报错。
 */
export const legacyVaultErrorCode = 'legacy-vault';

/** 设置弹窗里可以直接选中的本机文件夹。 */
export const sessionBackupCandidateSchema = z.object({
  path: z.string(),
  name: z.string(),
  /**
   * session-backup：另一台电脑用过的会话备份仓；
   * legacy-vault：旧版 Moo Fleet 的会话备份仓，确认后可以清空升级；
   * empty-repo：还没有任何提交的空仓库。
   */
  kind: z.enum(['session-backup', 'legacy-vault', 'empty-repo']),
  /** 仓库自己的 origin（已去掉内嵌凭据）；没有远端就是只备份在本机。 */
  remoteUrl: z.string().nullable(),
});
export type SessionBackupCandidate = z.infer<typeof sessionBackupCandidateSchema>;

export const sessionBackupCandidateListSchema = z.object({
  candidates: z.array(sessionBackupCandidateSchema),
});
export type SessionBackupCandidateList = z.infer<typeof sessionBackupCandidateListSchema>;

export const localSessionParamsSchema = z.object({
  provider: sessionProviderSchema,
  providerSessionId: z.string().min(1).max(255),
});

export const trashLocalSessionSchema = z.object({
  /** 默认只移到本机废纸篓；打开后会在备份里留一条删除记录，另一台电脑同步时会问你。 */
  alsoRemoveFromBackup: z.boolean().optional().default(false),
});

const trashLocalSessionSelectionSchema = z.array(localSessionParamsSchema).min(1).max(500).superRefine((items, context) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = `${item.provider}:${item.providerSessionId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: '同一条会话不能重复选择',
      });
    }
    seen.add(key);
  }
});

/** 批量删除始终以明确的 provider + session ID 清单为准，不接受隐式筛选条件。 */
export const trashLocalSessionsSchema = z.object({
  items: trashLocalSessionSelectionSchema,
  /** 默认只移到本机废纸篓；打开后会为成功删除的每条会话写入墓碑。 */
  alsoRemoveFromBackup: z.boolean().optional().default(false),
}).superRefine((input, context) => {
  if (!input.alsoRemoveFromBackup) return;
  for (const [index, item] of input.items.entries()) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.providerSessionId) && !item.providerSessionId.includes('..')) {
      continue;
    }
    context.addIssue({
      code: 'custom',
      path: ['items', index, 'providerSessionId'],
      message: '会话 ID 无法安全地写入备份',
    });
  }
});
export type TrashLocalSessionsRequest = z.infer<typeof trashLocalSessionsSchema>;

export const trashLocalSessionResultItemSchema = localSessionParamsSchema.extend({
  /** 本机文件是否已经进入系统废纸篓。 */
  trashed: z.boolean(),
  /** 备份工作树是否已经写入删除墓碑。 */
  backupRemoved: z.boolean(),
  /** 单项失败不会中断同批其他会话；部分成功也会在这里说明。 */
  error: z.string().nullable(),
});
export type TrashLocalSessionResultItem = z.infer<typeof trashLocalSessionResultItemSchema>;

export const trashLocalSessionsResultSchema = z.object({
  items: z.array(trashLocalSessionResultItemSchema),
  /** 有远端且本批墓碑已上传时为 true；本机-only 删除保持 false。 */
  pushed: z.boolean(),
  /** Git 提交或上传等批次级说明，不掩盖已经完成的本机删除。 */
  notes: z.array(z.string()),
});
export type TrashLocalSessionsResult = z.infer<typeof trashLocalSessionsResultSchema>;

/** 备份仓的连接状态。 */
export const backupStatusSchema = z.object({
  configured: z.boolean(),
  backupPath: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  remoteName: z.string().nullable(),
  suggestedBackupPath: z.string(),
  device: z.string(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const localSessionBackupStateSchema = z.enum(['not-backed-up', 'backed-up', 'changed', 'deleted-in-backup']);
export type LocalSessionBackupState = z.infer<typeof localSessionBackupStateSchema>;

export const localSessionItemSchema = discoveredSessionSchema.extend({
  backupState: localSessionBackupStateSchema,
  backupDevice: z.string().nullable(),
  backupUpdatedAt: z.string().nullable(),
});
export type LocalSessionItem = z.infer<typeof localSessionItemSchema>;

export const localSessionListSchema = z.object({
  scannedAt: z.string(),
  device: z.string(),
  backupConfigured: z.boolean(),
  items: z.array(localSessionItemSchema),
  /** 只在备份里、本机还没有的会话数量（同步一次就会拿回来）。 */
  onlyInBackup: z.number().int().nonnegative(),
  errors: z.array(z.object({ provider: z.string(), path: z.string(), message: z.string() })),
});
export type LocalSessionList = z.infer<typeof localSessionListSchema>;

export const localSessionPreviewPayloadSchema = z.object({
  session: discoveredSessionSchema,
  preview: sessionContentPreviewSchema,
});
export type LocalSessionPreviewPayload = z.infer<typeof localSessionPreviewPayloadSchema>;

/** 同步时需要用户决定的一条会话。 */
export const sessionSyncItemSchema = z.object({
  provider: sessionProviderSchema,
  providerSessionId: z.string(),
  title: z.string().nullable(),
  projectName: z.string().nullable(),
  relation: sessionSyncRelationSchema,
  localLines: z.number().int().nonnegative().nullable(),
  backupLines: z.number().int().nonnegative().nullable(),
  commonLines: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
  backupDevice: z.string().nullable(),
  /** 分叉之后两边各自的第一句，让人不用打开任何东西就能判断该保留哪份。 */
  localFirstDiff: z.string().nullable(),
  backupFirstDiff: z.string().nullable(),
  choices: z.array(sessionSyncDecisionSchema),
});
export type SessionSyncItem = z.infer<typeof sessionSyncItemSchema>;

export const sessionSyncResultSchema = z.object({
  ranAt: z.string(),
  /** 备份仓新增或更新的会话数。 */
  backedUp: z.number().int().nonnegative(),
  /** 写回本机的会话数。 */
  restored: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  pending: z.array(sessionSyncItemSchema),
  pushed: z.boolean(),
  notes: z.array(z.string()),
  message: z.string(),
});
export type SessionSyncResult = z.infer<typeof sessionSyncResultSchema>;
