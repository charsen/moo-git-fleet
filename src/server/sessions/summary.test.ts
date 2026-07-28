import { describe, expect, it } from 'vitest';
import type { DiscoveredSession, WorkspaceSnapshot } from '../../shared/sessions.js';
import { createHeuristicSummary, parseProviderSummary, reviewHandoffSummary } from './summary.js';

const session: DiscoveredSession = {
  schemaVersion: 1,
  provider: 'claude',
  providerSessionId: 'synthetic-session',
  sourcePath: '/synthetic/provider/session.jsonl',
  projectPath: '/synthetic/project',
  projectId: 'remote:synthetic',
  repositoryId: 'synthetic-repository',
  repositoryName: 'Synthetic Repository',
  title: 'Implement synthetic handoff',
  createdAt: '2026-07-28T00:00:00.000Z',
  lastActivityAt: '2026-07-28T00:10:00.000Z',
  bytes: 100,
  messageCount: 2,
  tailTruncated: true,
  readable: true,
  error: null,
  discoveredAt: '2026-07-28T00:11:00.000Z',
};

const workspace: WorkspaceSnapshot = {
  projectId: session.projectId,
  repositoryId: session.repositoryId,
  branch: 'feature/session-sync',
  head: 'a'.repeat(40),
  dirty: true,
  changedFiles: 3,
  stagedFiles: 1,
  modifiedFiles: 2,
  deletedFiles: 0,
  renamedFiles: 0,
  untrackedFiles: 1,
};

describe('handoff summary drafts and review', () => {
  it('builds a conservative heuristic draft from metadata and Git state only', () => {
    const summary = createHeuristicSummary({ session, workspace });
    expect(summary).toMatchObject({
      goal: session.title,
      source: 'heuristic',
      reviewedAt: null,
      completed: [],
      decisions: [],
    });
    expect(summary.nextSteps[0]).toContain('复核当前工作区');
    expect(summary.risks.join('\n')).toContain('尾行');
    expect(summary.risks.join('\n')).toContain('3 个未提交文件');
  });

  it('marks user-edited content as manual while preserving an unchanged source', () => {
    const original = createHeuristicSummary({ session, workspace });
    const { source: _source, reviewedAt: _reviewedAt, ...content } = original;
    const reviewed = reviewHandoffSummary(original, content, new Date('2026-07-28T01:00:00.000Z'));
    const manual = reviewHandoffSummary(
      original,
      { ...content, goal: 'A user-corrected synthetic goal' },
      new Date('2026-07-28T01:01:00.000Z'),
    );
    expect(reviewed).toMatchObject({ source: 'heuristic', reviewedAt: '2026-07-28T01:00:00.000Z' });
    expect(manual).toMatchObject({ source: 'manual', reviewedAt: '2026-07-28T01:01:00.000Z' });
  });

  it('parses provider JSON without accepting missing handoff fields', () => {
    const output = JSON.stringify({
      goal: 'Synthetic provider goal',
      completed: [],
      decisions: [],
      nextSteps: ['Continue synthetic work'],
      blockers: [],
      commands: [],
      risks: [],
    });
    expect(parseProviderSummary(output)).toMatchObject({ source: 'ai-generated', goal: 'Synthetic provider goal' });
    expect(() => parseProviderSummary('{"goal":"incomplete"}')).toThrow();
  });
});
