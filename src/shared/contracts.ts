export type AiCommitMode = 'review' | 'auto-commit';
export type AiCommitRepositoryPolicy = 'disabled' | 'stat-only' | 'redacted-patch';
export type RepositorySortMode = 'activity' | 'name' | 'group' | 'commit' | 'fetch';
export type RepositoryFilterMode = 'all' | 'today' | 'attention' | 'dirty' | 'ahead' | 'behind' | 'stale';
export type BatchScope = 'visible' | 'all';
export type AutoFetchIntervalMinutes = 0 | 15 | 30 | 60 | 120 | 240;
export const interfaceFonts = ['system', 'plex', 'hiragino', 'heiti', 'songti'] as const;
export type InterfaceFont = typeof interfaceFonts[number];

export interface ProfileViewPreferences {
  repositorySort: RepositorySortMode;
  repositoryFilter: RepositoryFilterMode;
  repositoryGroup: string | null;
  batchScope: BatchScope;
  interfaceFont?: InterfaceFont;
  interfaceFontSize?: number;
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
  blocker: string | null;
}

export interface MergeBranchRequest extends MergePreviewRequest {
  noFastForward: boolean;
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
  | 'merge'
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
