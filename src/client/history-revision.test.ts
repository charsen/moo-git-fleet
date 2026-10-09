import { describe, expect, it } from 'vitest';
import type { BranchesSnapshot, TagEntry } from '../shared/contracts';
import { historyReferencesRevision } from './history-revision';

const snapshot = (): BranchesSnapshot => ({
  currentBranch: 'master', head: 'a',
  branches: [{ name: 'master', head: 'a', current: true, upstream: 'origin/master', ahead: 0, behind: 0, worktreePath: null }, { name: 'topic', head: 'b', current: false, upstream: null, ahead: null, behind: null, worktreePath: null }],
  remoteBranches: [{ name: 'origin/master', remote: 'origin', branch: 'master', head: 'a', hasLocal: true }], worktrees: [],
});
const tag = (targetHash: string): TagEntry => ({ name: 'v1', hash: 'tag-object', targetHash, annotated: true, createdAt: null, message: 'release', commitSubject: 'subject' });
describe('history reference revision', () => {
  it('keeps history stable across reordered refs and tracking/worktree metadata changes', () => {
    const a = snapshot(), b = snapshot(); b.branches.reverse(); b.branches[1]!.ahead = 2; b.branches[0]!.worktreePath = '/fixture';
    expect(historyReferencesRevision(a, [tag('a')], null)).toBe(historyReferencesRevision(b, [tag('a')], null));
  });
  it('detects branch movement, ref removal and moved tags even when tag names stay the same', () => {
    const base = historyReferencesRevision(snapshot(), [tag('a')], null), moved = snapshot(); moved.remoteBranches[0]!.head = 'c';
    expect(historyReferencesRevision(moved, [tag('a')], null)).not.toBe(base);
    const removed = snapshot(); removed.branches.pop(); expect(historyReferencesRevision(removed, [tag('a')], null)).not.toBe(base);
    expect(historyReferencesRevision(snapshot(), [tag('b')], null)).not.toBe(base);
  });
  it('includes the latest scan tag hint before the full tag list is manually refreshed', () => {
    expect(historyReferencesRevision(snapshot(), [], { name: 'v2', createdAt: null })).not.toBe(historyReferencesRevision(snapshot(), [], null));
  });
});
