import { z } from 'zod';
import { codeFonts, darkThemes, defaultDarkTheme, interfaceFonts } from './contracts.js';
import { normalizeAnalyticsRepositoryScope } from './analytics-scope.js';

export const analyticsRepositoryScopeSchema = z.array(z.string().min(1).max(120)).max(10_000)
  .nullable().transform(normalizeAnalyticsRepositoryScope);

export const analyticsQuerySchema = z.object({
  weeks: z.unknown().optional(),
  // 自定义时间段：`start` / `end` 都是本地日期串，服务端按「早 → 晚」精确到天裁剪
  start: z.unknown().optional(),
  end: z.unknown().optional(),
  repositoryIds: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }, analyticsRepositoryScopeSchema.optional()),
});

/**
 * 深色主题取值。
 *
 * 旧版只有 `moon` 一个主题，它已被五套深色主题取代；这里把历史配置里的
 * `'moon'` 归一化成默认主题，让升级后的 profile.yaml 仍能读出来，并在下次写入时落成新值。
 */
const darkThemeSchema = z.preprocess(
  (value) => (value === 'moon' ? defaultDarkTheme : value),
  z.enum(darkThemes).default(defaultDarkTheme),
);

export const profileViewPreferencesSchema = z.object({
  repositorySort: z.enum(['activity', 'name', 'group', 'commit', 'fetch']).default('activity'),
  repositoryFilter: z.enum(['all', 'today', 'attention', 'dirty', 'ahead', 'behind', 'stale']).default('all'),
  repositoryGroup: z.string().trim().min(1).max(80).nullable().default(null),
  batchScope: z.enum(['visible', 'all']).default('visible'),
  interfaceFont: z.enum(interfaceFonts).optional(),
  interfaceFontSize: z.number().int().min(12).max(16).optional(),
  codeFont: z.enum(codeFonts).optional(),
  codeFontSize: z.number().int().min(12).max(16).optional(),
  fileListView: z.enum(['flat', 'tree']).optional(),
  analyticsRepositoryIds: analyticsRepositoryScopeSchema.optional(),
});

export const profileConfigSchema = z.object({
  version: z.literal(1),
  profile: z.object({
    displayName: z.string().trim().min(1).max(80),
    avatar: z.string().trim().max(500).nullable(),
    locale: z.enum(['zh-CN', 'en-US']),
    theme: darkThemeSchema,
    preferredCommitLanguage: z.enum(['zh-CN', 'en-US']),
    aiCommitMode: z.enum(['review', 'auto-commit']),
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
  migrations: z.object({
    activitySortDefault: z.boolean().default(false),
  }).default({ activitySortDefault: false }),
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
/**
 * 只改主题的窄接口。
 *
 * 切换主题是即时动作，不该把表单里其它未保存改动一起落盘，所以这里用 `.strict()`
 * 明确拒绝多余字段——否则调用方会以为它可以当整体 profile 更新用。
 */
export const themeUpdateSchema = z.object({ theme: darkThemeSchema }).strict();
export const viewPreferencesUpdateSchema = profileViewPreferencesSchema;

export const addRootSchema = z.object({
  // `id` is retained only for older clients. New clients submit a path and
  // let the server generate the opaque internal key.
  id: z.string().trim().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  path: z.string().trim().min(1).max(2000),
});

export const scanRootSchema = z.object({ rootId: z.string().min(1).max(80) });

export const directoryPickerSchema = z.object({
  initialPath: z.string().trim().min(1).max(2000).optional(),
});

export const nativeFolderPickerSchema = z.object({
  prompt: z.string().trim().min(1).max(120).default('选择会话备份文件夹'),
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

export const pruneMissingRepositoriesSchema = z.object({
  ids: z.array(z.string().min(1).max(120)).min(1).max(500),
});

export const fileSelectionSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(100),
});

export const fileActionSchema = z.object({ fileId: z.string().uuid() });

export const resolveConflictSchema = z.object({
  fileId: z.string().uuid(),
  strategy: z.enum(['ours', 'theirs', 'mark-resolved', 'restore']),
  expectedConflictFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const applyHunksSchema = z.object({
  fileId: z.string().uuid(),
  kind: z.enum(['staged', 'unstaged']),
  hunkIndexes: z.array(z.number().int().min(0).max(10_000)).min(1).max(500),
});

// Tag 名的权威校验由服务端 `check-ref-format refs/tags/<name>` 完成；这里只做长度兜底。
const tagNameSchema = z.string().min(1).max(250);

export const createTagSchema = z.object({
  name: tagNameSchema,
  target: z.string().min(1).max(1024),
  message: z.string().max(2000).default(''),
  push: z.boolean().default(false),
});

export const pushTagSchema = z.object({
  name: tagNameSchema,
  // 省略时服务端用仓库配置里的 defaultRemote，避免客户端写死 remote 名。
  remote: z.string().regex(/^[A-Za-z0-9._-]+$/).max(255).optional(),
});

const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

/** 提交历史分页查询；上限 100，默认一页 20 条。 */
export const commitPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
  ref: z.string().min(1).max(1024).refine((value) => value === 'HEAD' || /^refs\/(heads|remotes)\/.+/.test(value), '分支引用无效').optional(),
  tip: gitObjectIdSchema.optional(),
  scope: z.enum(['all', 'ref', 'outgoing', 'incoming', 'compare']).optional(),
  baseRef: z.string().min(1).max(1024).refine(value => /^refs\/(heads|remotes)\/.+/.test(value), '对比基准引用无效').optional(),
  excludeTip: gitObjectIdSchema.optional(),
  snapshot: z.string().uuid().optional(),
  search: z.string().trim().max(300).refine(value => !/[\0\r\n]/.test(value), '搜索内容必须为单行文本').optional(),
  searchField: z.enum(['message', 'author', 'hash']).optional(),
  filePath: z.string().min(1).max(4096).refine(value => !value.includes('\0') && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !/^[A-Za-z]:/.test(value), '文件路径无效').optional(),
});

export const commitHashParamsSchema = z.object({ hash: gitObjectIdSchema });
export const commitDetailQuerySchema = commitPageQuerySchema.pick({ filePath: true });
export const branchComparisonQuerySchema = z.object({ tip: gitObjectIdSchema, baseTip: gitObjectIdSchema });
export const revisionFileQuerySchema = z.object({ commit: gitObjectIdSchema, path: commitPageQuerySchema.shape.filePath.unwrap() });
export const revisionTreeQuerySchema = revisionFileQuerySchema.extend({
  path: revisionFileQuerySchema.shape.path.or(z.literal('')).default(''),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  search: z.string().trim().max(300).default(''),
});
export const reflogQuerySchema = z.object({
  ref: z.string().min(1).max(1024).refine(value => value === 'HEAD' || value.startsWith('refs/heads/'), 'Reflog 引用无效').default('HEAD'),
  snapshot: z.string().uuid().optional(),
  skip: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const deleteTagSchema = z.object({
  name: tagNameSchema,
  expectedHash: gitObjectIdSchema,
});

export const switchBranchSchema = z.object({
  branch: z.string().min(1).max(1024),
  expectedBranch: z.string().min(1).max(1024).nullable(),
  expectedHead: gitObjectIdSchema,
});

// 分支名的权威校验由服务端 `check-ref-format --branch` 完成；这里只做长度与形态兜底。
const branchNameSchema = z.string().min(1).max(1024).refine((value) => !value.startsWith('-'), {
  message: '分支名不能以连字符开头',
});

export const mergePreviewSchema = z.object({
  source: z.object({ kind: z.enum(['local', 'remote']), name: branchNameSchema }),
  expectedBranch: branchNameSchema,
  expectedHead: gitObjectIdSchema,
  expectedSourceHead: gitObjectIdSchema,
});
export const mergeBranchSchema = mergePreviewSchema.extend({
  noFastForward: z.boolean().default(false),
  stashFirst: z.boolean().default(false),
  stashIncludeUntracked: z.boolean().default(true),
});

/** Pull / Sync 的可选「自动 Stash」与「rebase」参数。Pull 只用 stashFirst，Sync 两者皆可用。 */
export const syncPullSchema = z.object({
  stashFirst: z.boolean().default(false),
  rebase: z.boolean().default(false),
});

export const createBranchSchema = z.object({
  branch: branchNameSchema,
  checkout: z.boolean().default(true),
  expectedBranch: z.string().min(1).max(1024).nullable(),
  expectedHead: gitObjectIdSchema,
});

export const renameBranchSchema = z.object({
  branch: branchNameSchema,
  nextBranch: branchNameSchema,
  expectedBranch: z.string().min(1).max(1024).nullable(),
  expectedHead: gitObjectIdSchema,
});

export const deleteBranchSchema = z.object({
  branch: branchNameSchema,
  expectedBranch: z.string().min(1).max(1024).nullable(),
  expectedHead: gitObjectIdSchema,
  expectedBranchHead: gitObjectIdSchema.optional(),
  force: z.boolean().default(false),
  backupTag: z.boolean().default(false),
});

export const deleteRemoteBranchSchema = z.object({
  remote: z.string().regex(/^[A-Za-z0-9._-]+$/).max(255),
  branch: branchNameSchema,
  expectedHead: gitObjectIdSchema,
  confirmPrimary: z.boolean().default(false),
});

export const deleteRemoteTagSchema = z.object({
  name: tagNameSchema,
  expectedHash: gitObjectIdSchema,
});

export const checkoutRemoteBranchSchema = z.object({
  remote: z.string().regex(/^[A-Za-z0-9._-]+$/).max(255),
  branch: branchNameSchema,
  localBranch: branchNameSchema,
  expectedBranch: z.string().min(1).max(1024).nullable(),
  expectedHead: gitObjectIdSchema,
});

const upstreamSnapshotSchema = z.object({
  expectedBranch: z.string().min(1).max(1024),
  expectedHead: gitObjectIdSchema,
});

export const upstreamRepairSchema = z.discriminatedUnion('mode', [
  upstreamSnapshotSchema.extend({
    mode: z.literal('track'),
    upstream: z.string().min(3).max(2048),
  }),
  upstreamSnapshotSchema.extend({
    mode: z.literal('publish'),
    remote: z.string().regex(/^[A-Za-z0-9._-]+$/).max(255),
  }),
]);

export const commitRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pushAfterCommit: z.boolean().default(false),
});

export const commitSuggestionRequestSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const autoCommitRequestSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pushAfterCommit: z.boolean().default(false),
});

export const batchRequestSchema = z.object({
  type: z.enum(['fetch', 'pull', 'push']),
  repositoryIds: z.array(z.string().min(3).max(120)).min(1).max(100).optional(),
});

export const openRepositorySchema = z
  .object({
    target: z.enum(['finder', 'terminal', 'vscode', 'reveal', 'editor']),
    fileId: z.string().uuid().optional(),
    /** 打开 `.gitignore` / `.git/info/exclude`；与 `fileId` 互斥，服务端自己解析路径。 */
    ignoreFile: z.enum(['gitignore', 'exclude']).optional(),
  })
  .refine((value) => !['reveal', 'editor'].includes(value.target) || Boolean(value.fileId) !== Boolean(value.ignoreFile), {
    message: '打开单个文件需要 fileId 或 ignoreFile 之一',
  });

export const ignoreRuleSchema = z
  .object({
    fileId: z.string().uuid(),
    target: z.enum(['gitignore', 'exclude']),
    scope: z.enum(['path', 'name', 'custom']),
    pattern: z.string().min(1).max(200).regex(/^[^\0\r\n]+$/, '忽略模式必须为单行文本').optional(),
  })
  .refine((value) => value.scope !== 'custom' || Boolean(value.pattern), {
    message: '自定义忽略模式不能为空',
  });

export const removeIgnoreRuleSchema = z.object({
  target: z.enum(['gitignore', 'exclude']),
  line: z.number().int().min(1).max(100_000),
  // 删除不设 200 的长度上限：已有规则可能比新建时的上限更长，仍需可删。
  pattern: z.string().min(1).max(1000).regex(/^[^\0\r\n]+$/, '忽略模式必须为单行文本'),
});

export const unignoreFileSchema = z.object({ fileId: z.string().uuid() });

export const assumeUnchangedSchema = z.object({
  fileId: z.string().uuid(),
  assumed: z.boolean(),
});

export const createStashSchema = z.object({
  message: z.string().trim().max(120).default(''),
  includeUntracked: z.boolean().default(true),
});

export const applyStashSchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/),
  expectedHash: z.string().regex(/^[a-f0-9]{40,64}$/),
});

/**
 * 主机名限制为字面量形式：它会以 `host=<值>` 拼进 git credential 的 stdin 负载，
 * 必须挡掉换行与其它控制字符，否则能伪造出额外的 credential 字段。
 */
const credentialHostSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9.-]+(?::\d+)?$/, '主机名无效');

/** 用户名与凭证同样走 stdin 负载，一律限制为单行文本。 */
const credentialLineSchema = (label: string) =>
  z.string().min(1).max(1000).regex(/^[^\0\r\n]+$/, `${label}必须为单行文本`);

export const saveRemoteCredentialSchema = z.object({
  host: credentialHostSchema,
  username: credentialLineSchema('用户名'),
  secret: credentialLineSchema('凭证'),
});

export const removeRemoteCredentialSchema = z.object({ host: credentialHostSchema });

/** 远端协议切换：目标协议 + （批量时）仓库范围 + 是否探活。 */
export const remoteProtocolTargetSchema = z.enum(['https', 'ssh']);

export const remoteProtocolSchema = z.object({
  target: remoteProtocolTargetSchema,
  /** 切换后是否做一次只读探活（`git ls-remote`）；默认开启。 */
  verify: z.boolean().default(true),
});

export const remoteProtocolBatchSchema = z.object({
  target: remoteProtocolTargetSchema,
  repositoryIds: z.array(z.string().min(3).max(120)).min(1).max(200),
  verify: z.boolean().default(true),
});

/**
 * 远端名与远端地址的**边界**校验。
 *
 * 这里只限长度与基本形态，**语义校验交给服务端模块**：
 * 名字走 `ensureRequestedRemoteName`（与 branches / tags / remote-deletions 共用同一份
 * 安全判定，避免又出现「改一处漏一处」的副本），地址走 `parseRemoteTarget`
 * （与客户端预览共用同一份判定）。这样规则只有一处，且客户端能给出同样的原因。
 */
const repositoryRemoteNameSchema = z.string().trim().min(1).max(80);
const repositoryRemoteUrlSchema = z.string().trim().min(1).max(2048);

export const addRepositoryRemoteSchema = z.object({
  name: repositoryRemoteNameSchema,
  url: repositoryRemoteUrlSchema,
});

export const setRepositoryRemoteUrlSchema = z.object({
  name: repositoryRemoteNameSchema,
  url: repositoryRemoteUrlSchema,
});

export const renameRepositoryRemoteSchema = z.object({
  name: repositoryRemoteNameSchema,
  nextName: repositoryRemoteNameSchema,
});

export const removeRepositoryRemoteSchema = z.object({ name: repositoryRemoteNameSchema });

/**
 * 历史改写（修正上次提交 / 撤销上次提交）。
 *
 * 两者都只接受 fingerprint，不接受 hash：要改的永远是「当前 HEAD」，
 * 由服务端自己读，避免客户端传一个过期或伪造的目标进来。
 */
export const amendCommitSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const undoCommitSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * 克隆远端仓库到已登记的根目录。
 *
 * 地址的语义校验交给 `parseRemoteTarget`（与远端管理共用一份判定）；
 * 目录名只做长度约束，安全性由服务端模块统一处理。
 */
export const cloneRepositorySchema = z.object({
  rootId: z.string().min(1).max(80),
  url: z.string().trim().min(1).max(2048),
  directory: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  group: z.string().trim().min(1).max(80).optional(),
});

/** 把某个提交应用到当前分支（revert / cherry-pick 共用）。 */
export const replayCommitSchema = z.object({
  hash: z.string().trim().min(7).max(64),
});
