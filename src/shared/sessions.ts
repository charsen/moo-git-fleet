import { z } from 'zod';

/** 目前支持发现的两种本机会话格式。 */
export const sessionProviderSchema = z.enum(['claude', 'codex']);
export type SessionProvider = z.infer<typeof sessionProviderSchema>;

export const sessionDiscoveryErrorSchema = z.object({
  provider: sessionProviderSchema,
  path: z.string().min(1).max(4_000),
  message: z.string().min(1).max(2_000),
});
export type SessionDiscoveryError = z.infer<typeof sessionDiscoveryErrorSchema>;

/**
 * 一条本机会话文件的只读视图：只有元数据，不含对话正文。
 * `repositoryId` 是这个项目在 Fleet 仓库列表里的登记，能对上才有值。
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
  /** 会话文件的最后修改时间，用来判断「自上次备份以来有没有动过」。 */
  modifiedAt: z.string().datetime({ offset: true }),
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

export const sessionContentPreviewItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(2_000),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
});
export type SessionContentPreviewItem = z.infer<typeof sessionContentPreviewItemSchema>;

export const sessionContentPreviewSchema = z.object({
  items: z.array(sessionContentPreviewItemSchema).max(500),
  totalMessages: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type SessionContentPreview = z.infer<typeof sessionContentPreviewSchema>;
