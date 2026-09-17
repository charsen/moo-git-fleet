export type AiCommitMode = 'review' | 'auto-commit';
export type AiCommitRepositoryPolicy = 'disabled' | 'stat-only' | 'redacted-patch';
export type RepositorySortMode = 'activity' | 'name' | 'group' | 'commit' | 'fetch';
export type RepositoryFilterMode = 'all' | 'today' | 'attention' | 'dirty' | 'ahead' | 'behind' | 'stale';
export type BatchScope = 'visible' | 'all';
export type AutoFetchIntervalMinutes = 0 | 15 | 30 | 60 | 120 | 240;

export interface ProfileViewPreferences {
  repositorySort: RepositorySortMode;
  repositoryFilter: RepositoryFilterMode;
  repositoryGroup: string | null;
  batchScope: BatchScope;
}

export interface ProfileConfig {
  version: 1;
  profile: {
    displayName: string;
    avatar: string | null;
    locale: 'zh-CN' | 'en-US';
    theme: 'moon';
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
}

/** 提交历史分页结果；`hasMore` 由服务端多取一条得出，不额外做 count 查询。 */
export interface CommitPage {
  commits: RepositoryCommit[];
  hasMore: boolean;
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
  remote: string;
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
  expectedHead: string;
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
  | 'fetch'
  | 'pull'
  | 'push'
  | 'commit'
  | 'stash'
  | 'switch-branch'
  | 'set-upstream'
  | 'branch'
  | 'conflict'
  | 'tag';
export type BatchOperationType = 'fetch' | 'pull' | 'push';
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
