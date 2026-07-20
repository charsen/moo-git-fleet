import { z } from 'zod';

export const profileViewPreferencesSchema = z.object({
  repositorySort: z.enum(['activity', 'name', 'group', 'commit', 'fetch']).default('activity'),
  repositoryFilter: z.enum(['all', 'attention', 'dirty', 'ahead', 'behind', 'stale']).default('all'),
  repositoryGroup: z.string().trim().min(1).max(80).nullable().default(null),
  batchScope: z.enum(['visible', 'all']).default('visible'),
});

export const profileConfigSchema = z.object({
  version: z.literal(1),
  profile: z.object({
    displayName: z.string().trim().min(1).max(80),
    avatar: z.string().trim().max(500).nullable(),
    locale: z.enum(['zh-CN', 'en-US']),
    theme: z.literal('moon'),
    preferredCommitLanguage: z.enum(['zh-CN', 'en-US']),
    aiCommitMode: z.enum(['review', 'auto-commit']),
    notificationsEnabled: z.boolean().default(false),
    autoFetchIntervalMinutes: z.union([
      z.literal(0),
      z.literal(15),
      z.literal(30),
      z.literal(60),
      z.literal(120),
      z.literal(240),
    ]).default(0),
    viewPreferences: profileViewPreferencesSchema.default({
      repositorySort: 'activity',
      repositoryFilter: 'all',
      repositoryGroup: null,
      batchScope: 'visible',
    }),
  }),
  gitIdentity: z.object({ source: z.literal('git-config') }),
});

export const capabilitiesSchema = z.object({
  fetch: z.boolean(),
  pull: z.boolean(),
  stage: z.boolean(),
  commit: z.boolean(),
  stash: z.boolean().default(true),
  push: z.boolean(),
});

export const repositoryConfigSchema = z.object({
  id: z.string().min(3).max(120),
  name: z.string().trim().min(1).max(120),
  root: z.string().min(1).max(80),
  path: z.string().min(1).max(1000),
  group: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  pinned: z.boolean(),
  order: z.number().int().min(0).max(100000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  aiCommitPolicy: z.enum(['disabled', 'stat-only', 'redacted-patch']).default('redacted-patch'),
  capabilities: capabilitiesSchema,
});

export const repositoriesConfigSchema = z.object({
  version: z.literal(1),
  settings: z.object({
    roots: z.record(z.string().min(1), z.string().min(1)),
    defaultRemote: z.string().min(1).max(80),
    scanDepth: z.number().int().min(1).max(5),
    localScanConcurrency: z.number().int().min(1).max(20),
    networkConcurrency: z.number().int().min(1).max(10),
  }),
  repositories: z.array(repositoryConfigSchema),
});

export const profileUpdateSchema = profileConfigSchema.shape.profile;
export const viewPreferencesUpdateSchema = profileViewPreferencesSchema;

export const addRootSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]{0,31}$/),
  path: z.string().trim().min(1).max(1000),
});

export const scanRootSchema = z.object({ rootId: z.string().min(1).max(80) });

export const directoryPickerSchema = z.object({
  initialPath: z.string().trim().min(1).max(2000).optional(),
});

export const repositoryManifestPreviewSchema = z.object({
  sourcePath: z.string().trim().min(1).max(2000),
});

export const repositoryImportCandidateSchema = z.object({
  rootId: z.string().min(1).max(80),
  relativePath: z.string().min(1).max(1000),
  name: z.string().trim().min(1).max(120),
  group: z.string().trim().min(1).max(80),
});

export const repositoryManifestImportSchema = z.object({
  sourcePath: z.string().trim().min(1).max(2000),
  candidates: z.array(repositoryImportCandidateSchema).min(1).max(100),
});

export const addRepositorySchema = z.object({
  rootId: z.string().min(1).max(80),
  relativePath: z.string().min(1).max(1000),
  name: z.string().trim().min(1).max(120).optional(),
  group: z.string().trim().min(1).max(80).default('未分组'),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const updateRepositorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  group: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  pinned: z.boolean().optional(),
  order: z.number().int().min(0).max(100000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  aiCommitPolicy: z.enum(['disabled', 'stat-only', 'redacted-patch']).optional(),
  capabilities: capabilitiesSchema.partial().optional(),
});

export const fileSelectionSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(100),
});

export const fileActionSchema = z.object({ fileId: z.string().uuid() });

export const commitRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pushAfterCommit: z.boolean().default(false),
});

export const autoCommitRequestSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pushAfterCommit: z.boolean().default(false),
});

export const batchRequestSchema = z.object({
  type: z.enum(['fetch', 'pull', 'push']),
  repositoryIds: z.array(z.string().min(3).max(120)).min(1).max(100).optional(),
});

export const openRepositorySchema = z.object({
  target: z.enum(['finder', 'terminal', 'vscode']),
});

export const createStashSchema = z.object({
  message: z.string().trim().max(120).default(''),
  includeUntracked: z.boolean().default(true),
});

export const applyStashSchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/),
  expectedHash: z.string().regex(/^[a-f0-9]{40,64}$/),
});
