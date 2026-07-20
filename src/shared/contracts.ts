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
  roots: Record<string, string>;
  repositories: RepositoryStatus[];
}
