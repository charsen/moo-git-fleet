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
  inProgressOperation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
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
}

export interface DashboardPayload {
  profile: ProfileConfig;
  ai: {
    configured: boolean;
    provider: 'deepseek' | 'openai-compatible';
    model: string;
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

export interface BranchesSnapshot {
  currentBranch: string | null;
  head: string;
  branches: LocalBranch[];
  worktrees: WorktreeInfo[];
}

export interface SwitchBranchRequest {
  branch: string;
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

export type OperationType = 'fetch' | 'pull' | 'push' | 'commit' | 'stash' | 'switch-branch' | 'set-upstream';
export type BatchOperationType = 'fetch' | 'pull' | 'push';
export type OperationState = 'queued' | 'running' | 'success' | 'failed' | 'skipped';

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
