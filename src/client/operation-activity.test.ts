import { describe, expect, it } from 'vitest';
import type { BatchRecord, OperationRecord } from '../shared/contracts';
import {
  activeRepositoryActivities,
  batchButtonActivity,
  repositoryActivityLabel,
} from './operation-activity.js';

const NOW = Date.parse('2026-11-16T10:00:00.000Z');

function batch(update: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'batch-1',
    type: 'pull',
    state: 'running',
    createdAt: '2026-11-16T09:59:50.000Z',
    finishedAt: null,
    total: 3,
    completed: 1,
    success: 1,
    skipped: 0,
    failed: 0,
    ...update,
  };
}

function operation(update: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: crypto.randomUUID(),
    batchId: 'batch-1',
    repositoryId: 'repo-a',
    repositoryName: 'Repo A',
    type: 'pull',
    state: 'running',
    startedAt: '2026-11-16T09:59:58.000Z',
    finishedAt: null,
    durationMs: null,
    message: '执行中',
    ...update,
  };
}

describe('activeRepositoryActivities', () => {
  it('keeps queued and running items of a foreground running batch', () => {
    const activities = activeRepositoryActivities(
      [
        operation({ repositoryId: 'repo-a', state: 'running' }),
        operation({ repositoryId: 'repo-b', state: 'queued', startedAt: null }),
        operation({ repositoryId: 'repo-c', state: 'success' }),
      ],
      [batch()],
      NOW,
    );
    expect(activities.get('repo-a')).toEqual({ type: 'pull', state: 'running' });
    expect(activities.get('repo-b')).toEqual({ type: 'pull', state: 'queued' });
    expect(activities.has('repo-c')).toBe(false);
  });

  it('ignores running rows left over from a completed batch', () => {
    const activities = activeRepositoryActivities(
      [operation({ repositoryId: 'repo-a', state: 'running' })],
      [batch({ state: 'completed', finishedAt: '2026-11-16T09:59:59.000Z' })],
      NOW,
    );
    expect(activities.size).toBe(0);
  });

  it('does not turn periodic background Fetch into noisy row spinners', () => {
    const activities = activeRepositoryActivities(
      [operation({ repositoryId: 'repo-a', type: 'fetch' })],
      [batch({ type: 'fetch', background: true })],
      NOW,
    );
    expect(activities.size).toBe(0);
  });

  it('shows a recent single-repository operation but drops a stale orphan', () => {
    const recent = activeRepositoryActivities(
      [operation({ batchId: null, repositoryId: 'repo-a', startedAt: '2026-11-16T09:59:30.000Z' })],
      [],
      NOW,
    );
    expect(recent.get('repo-a')).toEqual({ type: 'pull', state: 'running' });

    const stale = activeRepositoryActivities(
      [operation({ batchId: null, repositoryId: 'repo-a', startedAt: '2026-11-16T09:40:00.000Z' })],
      [],
      NOW,
    );
    expect(stale.size).toBe(0);
  });

  it('reports only the first activity per repository', () => {
    const activities = activeRepositoryActivities(
      [
        operation({ repositoryId: 'repo-a', type: 'pull', state: 'queued' }),
        operation({ repositoryId: 'repo-a', type: 'push', state: 'running' }),
      ],
      [batch()],
      NOW,
    );
    expect(activities.get('repo-a')).toEqual({ type: 'pull', state: 'queued' });
  });
});

describe('batchButtonActivity', () => {
  it('reports the type currently being started', () => {
    expect(batchButtonActivity('push', 'push', null)).toEqual({ phase: 'starting' });
    expect(batchButtonActivity('pull', 'push', null)).toBeNull();
  });

  it('reports progress for a foreground running batch of the same type', () => {
    expect(batchButtonActivity('pull', null, batch({ completed: 2, total: 5 }))).toEqual({
      phase: 'running',
      completed: 2,
      total: 5,
    });
  });

  it('stays idle for background, completed, or different-type batches', () => {
    expect(batchButtonActivity('fetch', null, batch({ type: 'fetch', background: true }))).toBeNull();
    expect(batchButtonActivity('pull', null, batch({ state: 'completed' }))).toBeNull();
    expect(batchButtonActivity('push', null, batch({ type: 'pull' }))).toBeNull();
    expect(batchButtonActivity('merge-branches', null, null)).toBeNull();
  });
});

describe('repositoryActivityLabel', () => {
  it('uses short actionable wording and falls back for unknown types', () => {
    expect(repositoryActivityLabel('pull')).toBe('拉取中');
    expect(repositoryActivityLabel('push-branches')).toBe('推送中');
    expect(repositoryActivityLabel('merge-branches')).toBe('合并中');
    expect(repositoryActivityLabel(undefined)).toBe('处理中');
  });

  it('says 排队中 for queued work instead of pretending it is already running', () => {
    expect(repositoryActivityLabel('pull', 'queued')).toBe('排队中');
    expect(repositoryActivityLabel('merge-branches', 'queued')).toBe('排队中');
    expect(repositoryActivityLabel('pull', 'running')).toBe('拉取中');
  });
});
