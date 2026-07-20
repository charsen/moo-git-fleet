export type AiCommitMode = 'review' | 'auto-commit';

export interface ProfileConfig {
  version: 1;
  profile: {
    displayName: string;
    avatar: string | null;
    locale: 'zh-CN' | 'en-US';
    theme: 'moon';
    preferredCommitLanguage: 'zh-CN' | 'en-US';
    aiCommitMode: AiCommitMode;
  };
  gitIdentity: {
    source: 'git-config';
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
  lastCommit: {
    hash: string;
    subject: string;
    author: string;
    committedAt: string;
  } | null;
  scannedAt: string;
  error: string | null;
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

export interface CommitPreview {
  fingerprint: string;
  files: string[];
  stat: string;
  patch: string;
  truncated: boolean;
  aiPolicy?: AiCommitPolicy;
}

export type AiCommitPrivacyMode = 'redacted-patch' | 'local-sensitive' | 'local-disabled' | 'local-fallback';

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

export type OperationType = 'fetch' | 'pull' | 'push' | 'commit' | 'stash';
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
