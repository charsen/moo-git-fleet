import type { BranchesSnapshot, RepositoryStatus, TagEntry } from '../shared/contracts';

/** History changes with reachable refs, not scan timestamps or worktree metadata. */
export function historyReferencesRevision(branches: BranchesSnapshot | null, tags: TagEntry[], latestTag: RepositoryStatus['latestTag']): string {
  const refs = [
    ...(branches?.branches ?? []).map(branch => [`refs/heads/${branch.name}`, branch.head]),
    ...(branches?.remoteBranches ?? []).map(branch => [`refs/remotes/${branch.name}`, branch.head]),
    ...tags.map(tag => [`refs/tags/${tag.name}`, tag.targetHash]),
  ].sort(([a], [b]) => a!.localeCompare(b!));
  return JSON.stringify([branches?.head ?? null, refs, latestTag]);
}
