import type { RemoteProtocol } from './remote-url.js';

/**
 * 可选深色主题。
 *
 * - `fleet-blue` 取自品牌设计稿（深蓝 `#0B3D91` / 亮蓝 `#2563EB` / 绿 `#28BF3F`），默认项：
 *   蓝色承担链接、焦点与选中，绿色只留给「已同步 / 成功」，语义不重叠。
 * - `mooeen` 取自母品牌官网的青柠绿（`#84AF3F` / `#A8D452`），纯黑底。
 * - 后三套取自 VS Code 内置深色主题的公开色值，按 Moo Fleet 的语义 token 重新分配，
 *   不是像素级复刻。
 *
 * 品牌绿 `#28bf3f` 是 Moo Fleet 的身份色，在除 `mooeen`（改用青柠）外的各套里保持一致。
 */
export const darkThemes = ['fleet-blue', 'mooeen', 'dark-modern', 'monokai', 'dark-high-contrast'] as const;
export type DarkTheme = typeof darkThemes[number];
export const defaultDarkTheme: DarkTheme = 'fleet-blue';

export type AiCommitMode = 'review' | 'auto-commit';
export type AiCommitRepositoryPolicy = 'disabled' | 'stat-only' | 'redacted-patch';
export type RepositorySortMode = 'activity' | 'name' | 'group' | 'commit' | 'fetch';
export type RepositoryFilterMode = 'all' | 'today' | 'attention' | 'dirty' | 'ahead' | 'behind' | 'stale';
export type BatchScope = 'visible' | 'all';
export type AutoFetchIntervalMinutes = 0 | 15 | 30 | 60 | 120 | 240;
/** 界面字体；`inter` 是品牌字体并作为默认，后 5 项与 `codeFonts` 同源。 */
export const interfaceFonts = [
  'inter',
  'system',
  'plex',
  'hiragino',
  'heiti',
  'songti',
  'jetbrains-mono',
  'ibm-plex-mono',
  'fira-code',
  'source-code-pro',
  'cascadia-code',
] as const;
export type InterfaceFont = typeof interfaceFonts[number];
/** 未设置界面字体时的默认值。 */
export const defaultInterfaceFont: InterfaceFont = 'inter';

/** 代码与等宽区域的字体；默认 JetBrains Mono，与改动前的行为一致。 */
export const codeFonts = ['jetbrains-mono', 'ibm-plex-mono', 'fira-code', 'source-code-pro', 'cascadia-code'] as const;
export type CodeFont = typeof codeFonts[number];

export interface ProfileViewPreferences {
  repositorySort: RepositorySortMode;
  repositoryFilter: RepositoryFilterMode;
  repositoryGroup: string | null;
  batchScope: BatchScope;
  interfaceFont?: InterfaceFont;
  interfaceFontSize?: number;
  codeFont?: CodeFont;
  /** 省略表示代码字号跟随界面字号（改动前的默认行为）。 */
  codeFontSize?: number;
  /** 文件清单的呈现方式；省略表示平铺（改动前的默认行为）。 */
  fileListView?: 'flat' | 'tree';
  /** 分析页的本机仓库范围，省略或 null 为全部启用仓库。 */
  analyticsRepositoryIds?: AnalyticsRepositoryScope;
}

export interface ProfileConfig {
  version: 1;
  profile: {
    displayName: string;
    avatar: string | null;
    locale: 'zh-CN' | 'en-US';
    theme: DarkTheme;
    preferredCommitLanguage: 'zh-CN' | 'en-US';
    aiCommitMode: AiCommitMode;
    autoFetchIntervalMinutes: AutoFetchIntervalMinutes;
    viewPreferences: ProfileViewPreferences;
  };
  gitIdentity: {
    source: 'git-config';
  };
  migrations: {
    activitySortDefault: boolean;
  };
}

export interface RepositoryCapabilities {
  fetch: boolean;
  pull: boolean;
  stage: boolean;
  commit: boolean;
  stash: boolean;
  push: boolean;
}

export interface RepositoryConfig {
  id: string;
  name: string;
  root: string;
  path: string;
  group: string;
  enabled: boolean;
  pinned: boolean;
  order: number;
  tags: string[];
  aiCommitPolicy: AiCommitRepositoryPolicy;
  capabilities: RepositoryCapabilities;
}

export interface RepositoriesConfig {
  version: 1;
  settings: {
    roots: Record<string, string>;
    defaultRemote: string;
    scanDepth: number;
    localScanConcurrency: number;
    networkConcurrency: number;
  };
  repositories: RepositoryConfig[];
}

export interface RepositoryRootMutationResult {
  roots: Record<string, string>;
  rootId: string;
  canonicalPath: string;
  created: boolean;
}

export interface PruneMissingRepositoriesResult {
  removed: string[];
  skipped: string[];
}

export interface ScanCandidate {
  rootId: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  branch: string | null;
  remote: string | null;
  /** 该目录是 Moo Fleet 的会话备份仓（含 fleet.json 标记），不建议当作代码仓库加入 */
  sessionBackup: boolean;
  alreadyAdded: boolean;
  repositoryId: string | null;
}

export type RepositoryManifestCandidateStatus = 'ready' | 'existing' | 'missing' | 'ambiguous' | 'remote-mismatch';

export interface RepositoryManifestCandidate {
  name: string;
  group: string;
  sourceRemote: string | null;
  status: RepositoryManifestCandidateStatus;
  detail: string;
  rootId: string | null;
  relativePath: string | null;
  absolutePath: string | null;
  branch: string | null;
  localRemote: string | null;
  repositoryId: string | null;
}

export interface RepositoryManifestPreview {
  sourcePath: string;
  total: number;
  ready: number;
  existing: number;
  missing: number;
  ambiguous: number;
  mismatch: number;
  candidates: RepositoryManifestCandidate[];
}

export interface RepositoryImportCandidate {
  rootId: string;
  relativePath: string;
  name: string;
  group: string;
}

export type RepositoryState =
  | 'missing'
  | 'invalid'
  | 'conflict'
  | 'operation-in-progress'
  | 'diverged'
  | 'dirty'
  | 'ahead'
  | 'behind'
  | 'clean'
  | 'remote-unknown';

/** 可能因冲突而中断、需要用户「继续」或「终止」的 Git 操作。 */
export type RepositoryOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export type ConflictResolutionStrategy = 'ours' | 'theirs' | 'mark-resolved' | 'restore';

export interface ResolveConflictRequest {
  fileId: string;
  strategy: ConflictResolutionStrategy;
  expectedConflictFingerprint?: string;
}

export interface GitTextContent {
  objectId: string;
  content: string | null;
  size: number;
  binary: boolean;
  truncated: boolean;
}
export interface RevisionTreeEntry {
  name: string;
  path: string;
  objectId: string;
  mode: string;
  kind: 'directory' | 'file' | 'symlink' | 'submodule';
  size: number | null;
}
export interface RevisionTreePage {
  commit: string;
  path: string;
  entries: RevisionTreeEntry[];
  total: number;
  hasMore: boolean;
}
export interface RevisionFile extends GitTextContent {
  commit: string;
  path: string;
  kind: RevisionTreeEntry['kind'];
}
export interface BlameLine {
  line: number;
  originalLine: number;
  hash: string;
  author: string;
  authoredAt: string;
  subject: string;
  originalPath: string;
  text: string;
  boundary: boolean;
}
export interface FileBlame {
  commit: string;
  path: string;
  lines: BlameLine[];
}
export interface ReflogEntry {
  hash: string;
  selector: string;
  actor: string;
  occurredAt: string;
  message: string;
}
export interface ReflogPage {
  ref: string;
  snapshot: string;
  entries: ReflogEntry[];
  hasMore: boolean;
  truncated: boolean;
}
export interface ConflictSide {
  stage: 1 | 2 | 3;
  label: string;
  source: string;
  commit: string | null;
  mode: string | null;
  file: GitTextContent | null;
}
export interface ConflictPreview {
  path: string;
  operation: RepositoryOperation | null;
  fingerprint: string;
  note: string;
  sides: ConflictSide[];
}

export interface RepositoryStatus {
  config: RepositoryConfig;
  absolutePath: string;
  available: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  remoteUrl: string | null;
  ahead: number | null;
  behind: number | null;
  changedFiles: number;
  staged: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
  stashCount: number;
  inProgressOperation: RepositoryOperation | null;
  lastFetchedAt: string | null;
  state: RepositoryState;
  lastCommit: RepositoryCommit | null;
  latestTag: {
    name: string;
    createdAt: string | null;
  } | null;
  gitIdentity: {
    name: string | null;
    email: string | null;
    complete: boolean;
  };
  scannedAt: string;
  error: string | null;
}

export interface RepositoryCommit {
  hash: string;
  subject: string;
  author: string;
  committedAt: string;
  tags: string[];
  /** 仅单文件历史返回当时的路径。 */
  filePath?: string;
}

/** 提交历史分页结果；`hasMore` 由服务端多取一条得出，不额外做 count 查询。 */
export interface CommitPage {
  commits: RepositoryCommit[];
  hasMore: boolean;
  /** 固定本轮分页的提交起点，避免分支更新后 offset 重复或漏项。 */
  tip?: string | null;
  /** 全仓历史固定引用集合的短期读取凭据。 */
  snapshot?: string;
  /** 范围分页固定的排除端提交（upstream、本地或对比基准）。 */
  excludeTip?: string;
}

export interface CommitPageQuery {
  limit?: number;
  skip?: number;
  /** HEAD 或完整的 refs/heads/...、refs/remotes/...，浏览不执行 checkout。 */
  ref?: string;
  tip?: string;
  scope?: 'all' | 'ref' | 'outgoing' | 'incoming' | 'compare';
  baseRef?: string;
  excludeTip?: string;
  snapshot?: string;
  search?: string;
  searchField?: 'message' | 'author' | 'hash';
  filePath?: string;
}

/** 两个固定提交端点的差异；不代表执行合并后的结果。 */
export interface BranchComparison {
  tip: string;
  baseTip: string;
  sourceOnly: number;
  baseOnly: number;
  files: CommitFileChange[];
  truncated: boolean;
}

/** 单条提交的完整详情，含元信息、diffstat 与补丁正文。 */
export interface CommitDetail {
  hash: string;
  subject: string;
  author: string;
  committedAt: string;
  body: string;
  parents: string[];
  tags: string[];
  stat: string;
  patch: string;
  truncated: boolean;
  files?: CommitFileChange[];
}

export interface CommitFileChange {
  path: string;
  originalPath: string | null;
  status: string;
  /** null 表示整份补丁截断后该文件没有完整预览。 */
  patch: string | null;
}

export interface DashboardPayload {
  profile: ProfileConfig;
  ai: {
    configured: boolean;
    provider: 'deepseek' | 'openai-compatible';
    model: string;
    /**
     * Token 已存在但读不出来时的原因；为 null 表示「没配置」或「读取正常」。
     * 刻意不用异常表达：首页要能照常打开，用户才有地方去改设置。
     */
    keyError: string | null;
  };
  roots: Record<string, string>;
  repositories: RepositoryStatus[];
  scan: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
}

export interface FileChange {
  id: string;
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

/** 工作区里被 Git 忽略的条目；被忽略的目录折叠成一条，`path` 以 `/` 结尾。 */
export interface IgnoredEntry {
  /** 注册表 token，用于「在访达中显示 / 在编辑器中打开」。 */
  id: string;
  path: string;
  directory: boolean;
}

/** `gitignore` 写入仓库的 `.gitignore`（随仓库共享）；`exclude` 写入本机的 `.git/info/exclude`。 */
export type IgnoreTarget = 'gitignore' | 'exclude';

/** `path` 只匹配当前路径；`name` 匹配仓库内所有同名项；`custom` 用客户端提交的模式。 */
export type IgnoreScope = 'path' | 'name' | 'custom';

export interface IgnoreRuleRequest {
  fileId: string;
  target: IgnoreTarget;
  scope: IgnoreScope;
  /** 仅 `scope === 'custom'` 必填。 */
  pattern?: string;
}

export interface IgnoreRuleResult {
  target: IgnoreTarget;
  /** 实际写入（或已存在）的规则行，用于提示与回显。 */
  pattern: string;
  /** false 表示规则已存在，没有改动文件。 */
  created: boolean;
}

/** 忽略规则文件里的一行；`line` 从 1 开始。 */
export interface IgnoreRuleLine {
  line: number;
  text: string;
  /** comment / blank 不提供删除按钮。 */
  kind: 'rule' | 'comment' | 'blank';
}

/** 规则列表里的一个文件（仓库根 `.gitignore` 或本机 `info/exclude`）。 */
export interface IgnoreFileRules {
  target: IgnoreTarget;
  /** 展示用路径：`.gitignore` 或 Git 报告的 `.git/info/exclude`。 */
  displayPath: string;
  exists: boolean;
  lines: IgnoreRuleLine[];
}

export interface RemoveIgnoreRuleRequest {
  target: IgnoreTarget;
  line: number;
  /** 必须与当前该行内容一致，否则 409；避免列表过期时删错行。 */
  pattern: string;
}

export interface RemoveIgnoreRuleResult {
  target: IgnoreTarget;
  line: number;
  pattern: string;
  displayPath: string;
}

/** 被标记为 assume-unchanged 的已跟踪文件（本机索引标记，不进提交）。 */
export interface MarkedFile {
  /** 注册表 token，用于「取消标记」。 */
  id: string;
  path: string;
}

export interface AssumeUnchangedRequest {
  fileId: string;
  /** true 标记；false 取消标记。 */
  assumed: boolean;
}

/** 单个本地 Tag。 */
export interface TagEntry {
  name: string;
  /** 标签对象本身：附注标签是 tag 对象，轻量标签就是提交。 */
  hash: string;
  /** 标签最终指向的提交。 */
  targetHash: string;
  annotated: boolean;
  createdAt: string | null;
  /** 附注标签的说明；轻量标签为空。 */
  message: string;
  /** 目标提交的标题。 */
  commitSubject: string;
}

export interface CreateTagRequest {
  name: string;
  /** 目标提交，通常是 HEAD 或列表里的某个 hash。 */
  target: string;
  /** 非空则创建附注标签，为空则创建轻量标签。 */
  message: string;
  /** 创建后是否立即推送到远端。 */
  push: boolean;
}

export interface DeleteTagRequest {
  name: string;
  expectedHash: string;
}

export interface PushTagRequest {
  name: string;
  /** 省略时服务端用仓库配置里的 defaultRemote。 */
  remote?: string;
}

export interface ApplyHunksRequest {
  fileId: string;
  /** `unstaged` 表示按块暂存，`staged` 表示按块取消暂存。 */
  kind: 'staged' | 'unstaged';
  hunkIndexes: number[];
}

export interface AppliedHunksResult {
  path: string;
  kind: 'staged' | 'unstaged';
  applied: number[];
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  current: boolean;
  prunable: boolean;
}

export interface LocalBranch {
  name: string;
  head: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  worktreePath: string | null;
}

/** 远端跟踪分支；用于「检出远端分支并建立跟踪」。 */
export interface RemoteBranch {
  /** 形如 `origin/main`。 */
  name: string;
  remote: string;
  branch: string;
  head: string;
  /** 本地是否已有同名分支。 */
  hasLocal: boolean;
}

export interface BranchesSnapshot {
  currentBranch: string | null;
  head: string;
  branches: LocalBranch[];
  remoteBranches: RemoteBranch[];
  worktrees: WorktreeInfo[];
}

export interface SwitchBranchRequest {
  branch: string;
  expectedBranch: string | null;
  expectedHead: string;
}

export interface MergeSource {
  kind: 'local' | 'remote';
  name: string;
}
export const mergePausedErrorCode = 'merge-paused';

export interface MergePreviewRequest {
  source: MergeSource;
  expectedBranch: string;
  expectedHead: string;
  expectedSourceHead: string;
}

export interface MergePreview {
  source: MergeSource;
  sourceHead: string;
  targetBranch: string;
  targetHead: string;
  incomingCommits: number;
  kind: 'up-to-date' | 'fast-forward' | 'merge-commit';
  /** 工作区是否有任何改动（暂存、未暂存或未跟踪）。 */
  dirty: boolean;
  /** 会被本次合并覆盖、同时本地已改动的路径，最多前 20 条。 */
  conflicting: string[];
  /** 冲突路径里是否含未跟踪文件，决定「包含未跟踪文件」的默认值。 */
  conflictingUntracked: boolean;
  /** 无法自动解决的阻塞：进行中的操作、无共同历史、仓库配置禁止。 */
  blocker: string | null;
}

export interface MergeBranchRequest extends MergePreviewRequest {
  noFastForward: boolean;
  /** 合并前先把当前改动存入 Stash；只能由用户显式选择。 */
  stashFirst: boolean;
  /** 仅 stashFirst 生效。 */
  stashIncludeUntracked: boolean;
}

export interface CreateBranchRequest {
  branch: string;
  /** 创建后是否立即切换过去。 */
  checkout: boolean;
  expectedBranch: string | null;
  expectedHead: string;
}

export interface RenameBranchRequest {
  branch: string;
  nextBranch: string;
  expectedBranch: string | null;
  expectedHead: string;
}

export interface DeleteBranchRequest {
  branch: string;
  expectedBranch: string | null;
  /** 请求时的仓库 HEAD，用于复核工作区快照。 */
  expectedHead: string;
  /**
   * 预览里看到的目标分支 head。强制删除必须带上：不一致说明分支在预览之后被推进过，
   * 直接删会静默丢掉新提交，因此必须重新预览。
   */
  expectedBranchHead?: string;
  /** 仅在预览确认过「会丢引用」后才允许为 true；缺省等同普通删除。 */
  force?: boolean;
  /** 强制删除前先把分支备份成一个本地标签。 */
  backupTag?: boolean;
}

/**
 * 强制删除前的影响预览：`lostCommits` 是删除后不再被任何 ref 引用的提交。
 * 已经推到远端（remote-tracking ref 还在）或已合并到其他分支的提交不计入。
 */
export interface BranchDeletionPreview {
  branch: string;
  head: string;
  /** 普通删除是否会被拒绝（未合并到当前 HEAD 或其 upstream）。 */
  unmerged: boolean;
  lostCommits: Array<{ hash: string; subject: string }>;
  lostCount: number;
  lostTruncated: boolean;
}

export interface DeleteRemoteBranchRequest {
  remote: string;
  /** 远端分支名，不含 remote 前缀。 */
  branch: string;
  expectedHead: string;
  /** 目标是该远端的主分支（main/master）时必须显式为 true。 */
  confirmPrimary: boolean;
}

export interface DeleteRemoteTagRequest {
  name: string;
  /** 本地 tag 的 hash；推送删除前用它做 lease 复核。 */
  expectedHash: string;
}

export interface CheckoutRemoteBranchRequest {
  remote: string;
  /** 远端分支名，不含 remote 前缀。 */
  branch: string;
  /** 要创建的本地分支名。 */
  localBranch: string;
  expectedBranch: string | null;
  expectedHead: string;
}

export interface UpstreamRemote {
  name: string;
  url: string | null;
  default: boolean;
}

export type UpstreamCandidateReason = 'same-name' | 'same-head';

export interface UpstreamCandidate {
  upstream: string;
  remote: string;
  branch: string;
  head: string;
  reason: UpstreamCandidateReason;
  ahead: number | null;
  behind: number | null;
}

export interface UpstreamRepairPlan {
  branch: string;
  head: string;
  upstream: string | null;
  remotes: UpstreamRemote[];
  candidates: UpstreamCandidate[];
  recommendedUpstream: string | null;
  canPublish: boolean;
}

export type UpstreamRepairRequest =
  | {
      mode: 'track';
      upstream: string;
      expectedBranch: string;
      expectedHead: string;
    }
  | {
      mode: 'publish';
      remote: string;
      expectedBranch: string;
      expectedHead: string;
    };

export interface UpstreamRepairResult {
  status: RepositoryStatus;
  branches: BranchesSnapshot;
  upstream: string;
}

export interface CommitPreview {
  fingerprint: string;
  files: string[];
  stat: string;
  patch: string;
  truncated: boolean;
  aiPolicy?: AiCommitPolicy;
}

export type AiCommitPrivacyMode =
  | 'redacted-patch'
  | 'stat-only'
  | 'local-policy-disabled'
  | 'local-sensitive'
  | 'local-disabled'
  | 'local-fallback';

export interface AiCommitPolicy {
  mode: AiCommitPrivacyMode;
  label: string;
  detail: string;
}

export interface CommitSuggestion {
  source: 'deepseek' | 'openai-compatible' | 'local';
  message: string;
  subject: string;
  body: string[];
  summary: string;
  fingerprint: string;
  aiPolicy: AiCommitPolicy;
}

export interface StashEntry {
  ref: string;
  hash: string;
  message: string;
  createdAt: string;
  stat: string;
}

/** 单条 Stash 的补丁预览；`truncated` 表示补丁超过上限被截断。 */
export interface StashDetail {
  hash: string;
  patch: string;
  truncated: boolean;
}

export type OperationType =
  | 'merge'
  | 'fetch'
  | 'pull'
  | 'sync'
  | 'push'
  | 'commit'
  | 'stash'
  | 'switch-branch'
  | 'set-upstream'
  | 'branch'
  | 'conflict'
  | 'tag'
  | 'remote-protocol'
  | 'remote'
  | 'undo-commit'
  | 'revert'
  | 'cherry-pick';
export type BatchOperationType = 'fetch' | 'pull' | 'push';
/**
 * 能单独重试的联网操作类型（单仓维度）。
 *
 * 刻意与 `BatchOperationType` 分开：两者此前共用同一个类型，导致「单仓能重试 sync」
 * 这件事被错误地表达成了「批量支持 sync」。批量不提供同步——合并加自动推送
 * 放在一次批量里风险太高，只能进单个仓库处理。
 */
export type RetryableOperationType = 'fetch' | 'pull' | 'sync' | 'push';
export type OperationState = 'queued' | 'running' | 'success' | 'failed' | 'skipped';
export type OperationSkipReason = 'not-needed' | 'blocked' | 'disabled';

export interface OperationRecord {
  id: string;
  batchId: string | null;
  repositoryId: string;
  repositoryName: string;
  type: OperationType;
  state: OperationState;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  message: string;
  /** Optional for compatibility with operation logs written before skip classification existed. */
  skipReason?: OperationSkipReason | null;
}

export interface BatchRecord {
  id: string;
  type: BatchOperationType;
  state: 'running' | 'completed';
  createdAt: string;
  finishedAt: string | null;
  total: number;
  completed: number;
  success: number;
  skipped: number;
  failed: number;
}

export interface OperationsPayload {
  batches: BatchRecord[];
  operations: OperationRecord[];
}

/**
 * 远端主机的凭证状态；服务于设置里的「远端访问」区。
 *
 * 为什么按 host 归并而不是按仓库：git 的凭证按 `protocol://host` 存取，
 * 同主机下的仓库共享同一条记录，用户只需录入一次。
 */
export interface RemoteCredentialHost {
  /** 主机名，例如 `gitee.com`。 */
  host: string;
  /** 传输协议。只有 `https` 需要凭证；`ssh` 走密钥，`other` 不做管理。 */
  protocol: 'https' | 'ssh' | 'other';
  /** 使用该主机的已启用仓库数量。 */
  repositoryCount: number;
  /** 仓库名样例（最多 3 个），用于让用户认出这条记录对应哪些仓库。 */
  repositories: string[];
  /** 是否已存有可用凭证。`ssh` / `other` 不适用，为 `null`。 */
  hasCredential: boolean | null;
}

export interface RemoteCredentialOverview {
  /** 按「需要处理的排前面」排序：https 缺凭证 → https 有凭证 → ssh → other。 */
  hosts: RemoteCredentialHost[];
  /**
   * 当前生效的 `credential.helper`。为空表示没有配置凭证助手，
   * 此时写入的凭证不会持久化——界面要提前告诉用户，而不是让写入静默失效。
   */
  credentialHelper: string | null;
}

/** 单个仓库的远端协议切换结果。 */
export interface RemoteProtocolSwitchResult {
  status: RepositoryStatus;
  /** 切换前地址。 */
  from: string;
  /** 切换后地址。 */
  to: string;
  /** 切换后只读探活的结论。 */
  verification: 'reachable' | 'needs-credential' | 'unverified';
  /** 需要向用户补充的说明；无需补充时为 null。 */
  note: string | null;
}

/** 批量切换远端协议的结果汇总；逐仓库给出成功 / 跳过 / 失败。 */
export interface RemoteProtocolBatchResult {
  target: RemoteProtocol;
  switched: Array<{ id: string; name: string; from: string; to: string; verification: 'reachable' | 'needs-credential' | 'unverified' }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
  failed: Array<{ id: string; name: string; message: string }>;
}

export interface SaveRemoteCredentialRequest {
  host: string;
  username: string;
  /** 口令或私人令牌。只在请求体内传输，不写配置文件、不进日志。 */
  secret: string;
}

/**
 * 仓库里的一个远端（remote）。
 *
 * 舰队级操作（fetch / pull / push / 协议切换）只认配置里的默认远端，
 * 所以这里用 `isDefault` 标出来——用户改别的远端时界面必须能说明
 * 「这个改动不会影响舰队操作，除非它就是默认远端」。
 */
export interface RepositoryRemote {
  /** 远端名，例如 `origin`。 */
  name: string;
  /** fetch 地址。 */
  url: string;
  /** 与 fetch 不同的推送地址（`remote.<name>.pushurl`）；未单独设置或与 fetch 相同时为 `null`。 */
  pushUrl: string | null;
  /** 解析出的协议；识别不了时为 `null`。 */
  protocol: RemoteProtocol | 'other' | null;
  /** 解析出的主机名；识别不了时为 `null`。 */
  host: string | null;
  /** 是否是舰队配置里的默认远端。 */
  isDefault: boolean;
}

/** 某个仓库的远端列表。 */
export interface RepositoryRemotesSnapshot {
  /** 舰队配置里的默认远端名；fetch / pull / push 都以它为目标。 */
  defaultRemote: string;
  remotes: RepositoryRemote[];
}

/** 远端增删改之后的结果；一并带回最新状态，避免前端再取一次。 */
export interface RepositoryRemoteMutation {
  status: RepositoryStatus;
  defaultRemote: string;
  remotes: RepositoryRemote[];
  /** 需要提醒用户的风险（例如改动的是默认远端）；没有时为 `null`。 */
  warning: string | null;
}

/**
 * 历史改写（修正上次提交 / 撤销上次提交）的可行性快照。
 *
 * 界面要在**点下去之前**就说明三件事，因此一次把它读全：
 * 1. 上一次提交是什么、是否已经推送（改写已推送的提交会造成本地与远端分叉）；
 * 2. 当前暂存区 + 分支 + HEAD 的指纹（执行时必须原样带回，防止期间被改动）；
 * 3. 是否处于冲突 / 进行中的 Git 操作（此时禁止改写历史）。
 */
export interface LastCommitSnapshot {
  /** 上一次提交；仓库尚无提交时为 `null`。 */
  commit: {
    hash: string;
    subject: string;
    /** 按**本地**远端跟踪记录判断该提交是否已在远端分支上；不联网。 */
    pushed: 'yes' | 'no';
    /** 命中时最先命中的远端跟踪引用，供界面说明出处。 */
    pushedRef: string | null;
    /** 上次提交是否为合并提交（父提交多于一个）。 */
    merge: boolean;
    /** 是否存在更早的提交；为 `false` 说明这是仓库的第一个提交。 */
    hasParent: boolean;
  } | null;
  /**
   * 「当前分支 + HEAD」的指纹；执行改写时必须原样带回。
   *
   * 刻意不含暂存区：改写历史要守住的是「别把 HEAD 换掉的另一个提交改掉」，
   * 而暂存区在期间变了并不危险——amend 按执行时的实际暂存内容并入即可。
   * 若把暂存区算进来，用户每暂存一个文件都会让按钮失效，反而碍事。
   */
  fingerprint: string;
  /** 当前已暂存的文件数；amend 会把它们并入上次提交（实际并入数在执行时才最终确定）。 */
  stagedCount: number;
  /** 不允许改写历史的原因；可行时为 `null`。 */
  blocked: string | null;
}

/** 历史改写的结果。 */
export interface CommitRewriteResult {
  status: RepositoryStatus;
  /** 改写后的 HEAD；撤销首个提交后仓库变成「尚无提交」，此时为 `null`。 */
  hash: string | null;
  /** 被改写的那个提交此前是否已在远端（依据本地跟踪记录）。 */
  pushed: 'yes' | 'no';
  pushedRef: string | null;
  /** 暂存内容是否完整进入新提交（amend）或完整退回暂存区（撤销）。 */
  consistent: boolean;
}

/** 把单个提交应用到当前分支的两种方式。 */
export type ReplayKind = 'revert' | 'cherry-pick';

/**
 * 应用单个提交的结果。
 *
 * 冲突时**不在这里表示暂停态**：抛的是带 `mergePausedErrorCode` 的冲突错误，
 * 界面据此切到工作区，之后由既有的「继续 / 中止」处理——与合并暂停走同一条路。
 */
export interface ReplayResult {
  kind: ReplayKind;
  /** 被应用的来源提交（完整 sha）。 */
  source: string;
  /** 新产生的提交。 */
  hash: string | null;
  /** 供结果提示使用的一句话。 */
  message: string;
}

/** 克隆远端仓库到根目录后的登记结果。 */
export interface CloneRepositoryResult {
  repository: RepositoryConfig;
  /** 克隆到的目录名（相对根目录）。 */
  directory: string;
}

/**
 * 检查更新的结果。
 *
 * 查询失败**不抛错**：它只是顶栏上一个可选提示，拿不到就照常工作。
 * `reason` 有值表示这次没查成，界面显示原因而不是「已是最新」——否则会把
 * 断网说成没有新版本。
 */
export interface ReleaseCheckResult {
  /** 上游最新版本号（已去掉 `v` 前缀）；查询失败或没有发布记录时为 null。 */
  latest: string | null;
  /** 对应的发布页地址，供「下载新版本」直接跳转。 */
  releaseUrl: string | null;
  checkedAt: string;
  reason: string | null;
}

/**
 * 单个仓库的提交汇总。
 *
 * 只回总数、不回日粒度明细：热力图只需要全局 daily，仓库榜只需要 total。
 * 明细按「仓库 × 天」展开是 O(仓库数 × 天数)，20 个仓库两年历史就是上千条键，
 * 而页面上一个字都用不到。
 */
export interface RepositoryCommitHeatmap {
  repositoryId: string;
  repositoryName: string;
  /** 该仓库在所选时间段内的提交总数（全部分支，不含合并提交） */
  total: number;
  /**
   * 最近一次提交的日期（YYYY-MM-DD）。没有提交记录时为 null。
   * 「多久没动」只能由客户端按当天日期算，所以这里给日期而不是天数。
   */
  lastCommitDate: string | null;
  /**
   * 所选时间段内的新增行（已剔除 lock / 构建产物 / 二进制等生成文件）。
   *
   * 与 `total` 同一窗口，只是统计方式不同：提交数来自 `git log`，行数要另跑一遍
   * numstat，所以两者由不同的缓存维护（见 `code-volume.ts`）。全历史口径的行数
   * 代价过高——要为每个仓库重走一遍 diff。
   */
  additions: number;
  /** 所选时间段内的删除行，口径同 `additions` */
  deletions: number;
}

/**
 * 一个贡献者的身份与产出。
 *
 * `name` 是归并后的展示名，同一个人多种写法（大小写、带不带英文名、中英文名）
 * 已经被合并；`aliases` 保留其它写法，界面放在 title 里，让合并结果可核对。
 */
export interface AuthorContribution {
  name: string;
  /** 其它被合并进来的写法（已排除仅大小写不同的重复项） */
  aliases: string[];
  /** 所选时间段内的提交数 */
  commits: number;
  /** 所选时间段内新增行（已剔除生成文件） */
  additions: number;
  /** 所选时间段内删除行 */
  deletions: number;
}

/**
 * 所选时间段的代码量汇总。
 *
 * 提交数回答不了「做了多少」：一次依赖升级能刷出几万行 lock 文件，
 * 一次提交也可能只改一个错别字。这组数字才是产出量。
 */
export interface CommitCodeVolumeSummary {
  additions: number;
  deletions: number;
  /** 改动文件次（同一文件在两次提交里算两次） */
  files: number;
  /** 命中生成文件规则、被剔除的文件次 */
  excludedFiles: number;
  /** 二进制改动文件次，不计入行数 */
  binaryFiles: number;
}

/**
 * 非上班时间推算结果，单位均为分钟。
 *
 * 口径见 `src/server/analytics/overtime.ts`：相邻提交间隔 ≤90 分钟算同一工作段，
 * 每段开工前补 30 分钟准备时间，落在「工作日 08:30 前 / 18:00 后、周末全天」的部分
 * 记为非上班时间。提交数说明不了投入多久，这组数字才是时长。
 */
export interface CommitOvertimeSummary {
  /** 所有工作段合计的模型推算工时，含正常上班时段 */
  workMinutes: number;
  /** 落在非上班时段的总时长 = workdayMinutes + weekendMinutes */
  offHoursMinutes: number;
  /** 工作日 08:30 前 + 午休 + 18:00 后 */
  workdayMinutes: number;
  /** 周末全天 */
  weekendMinutes: number;
  /** 工作日 08:30 之前的部分 */
  earlyMinutes: number;
  /** 工作日 18:00 之后的部分 */
  eveningMinutes: number;
  /**
   * 午休 12:00–13:30 里**有提交锚定**的那部分。
   *
   * 跨过午休但午休内没有提交的时间不计入任何一档（既不算上班也不算加班），
   * 所以这个数通常远小于「午休时段有多长」。
   */
  lunchMinutes: number;
  /** 独立工作段数 */
  segments: number;
  /** 有非上班时间的自然日数 */
  activeDays: number;
  /**
   * 上面这些天里，非上班时长不足 15 分钟的天数。
   *
   * 典型来源是「下班前最后几分钟提交了一次」——它确实落在非上班时段，但把它读成
   * 「这一天有加班投入」并不合适。数字不剔（口径一旦带阈值就得年年解释），
   * 而是单列出来，让「涉及 796 天」这句话有第三个数可对读。
   */
  lightDays: number;
  /** offHoursMinutes ÷ 480，保留两位小数 */
  equivalentDays: number;
}

/** null 为全部启用仓库；空数组为明确的空选择。 */
export type AnalyticsRepositoryScope = string[] | null;

/** 同一时间窗口与仓库范围内的 Git commit 聚合数据。 */
export interface CommitHeatmapData {
  /** 本次实际请求的仓库范围；null 为全部，[] 为未选仓库。 */
  repositoryScope: AnalyticsRepositoryScope;
  /**
   * 本次统计实际用的时间窗口。
   *
   * 服务端算完回传：客户端据此显示「近一年 · 2025-10-27 ~ 2026-10-25」，
   * 也让「界面上的范围」和「服务端真正算的范围」有一处可以对账——
   * 之前两者各写各的，热力图标 52 周、非上班时间却是全部历史。
   */
  range: { weeks: number; label: string; start: string; end: string };
  /** 日粒度全局 commit 计数；key 为本地日期（YYYY-MM-DD） */
  daily: Record<string, number>;
  /**
   * 提交时段分布：7 行（周一 → 周日）× 24 列（0–23 时）。
   * 小时取 `%aI` 里的**作者本地时间**——「他当时几点在写」比统一换算到某个时区更有意义。
   */
  hourly: number[][];
  /** 按仓库汇总，按总数降序 */
  byRepo: RepositoryCommitHeatmap[];
  /** 按作者拆分，按提交数降序（仅取前 50）；同一人的多种写法已归并 */
  byAuthor: AuthorContribution[];
  /** 所选时间段内的代码量汇总 */
  codeVolume: CommitCodeVolumeSummary;
  /** 非上班时间推算；没有提交时各项为 0 */
  overtime: CommitOvertimeSummary;
  /** 统计摘要 */
  summary: {
    totalCommits: number;
    /** 所选范围中参与统计的启用仓库数 */
    totalRepos: number;
    /** 有提交记录的仓库数（全部历史口径：只用来判断「有没有东西可看」） */
    activeRepos: number;
    /** 窗口内最早一次提交的日期 */
    firstDate: string | null;
    /** 窗口内最近一次提交的日期 */
    lastDate: string | null;
    /**
     * 读取失败的仓库（目录不存在、不是 Git 仓库、没有权限）。
     *
     * 与「没有提交」必须分开：前者是环境坏了，后者只是还没开始写。
     * 混成一堆的话，界面只能含糊地说「没有可统计的提交」，而用户
     * 真正该做的是去检查那个画了红叉的路径。
     */
    unreadable: {
      count: number;
      /** 仓库名，最多 10 个；超出部分只看 count */
      names: string[];
      /**
       * git 给出的失败原因（第一行，去重后取最常见的一条）。
       *
       * 界面原来自己写死了「目录不可访问或不是 Git 仓库」，可实际上读不到的原因
       * 远不止这两种——2026-10-23 就遇到 `xcode-select` 指向未接受许可的 Xcode，
       * `/usr/bin/git` 直接拒绝执行，53 个仓库全挂，界面却让用户去查路径。
       * 把 git 的原话交上来，才不会把人引到错的地方。
       */
      reason: string | null;
    };
  };
}
