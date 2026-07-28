import { describe, expect, it } from 'vitest';
import type { Checkpoint, LifecycleEvent, SessionEvent } from '../../shared/sessions.js';
import { deriveSessionLifecycleStates } from './lifecycle-state.js';

function checkpoint(checkpointId: string, parentCheckpointIds: string[] = []): Checkpoint {
  return {
    schemaVersion: 1,
    eventType: 'checkpoint',
    eventId: `event-${checkpointId}`,
    checkpointId,
    parentCheckpointIds,
    resumedFromCheckpointId: null,
    sessionId: 'fleet:synthetic-lifecycle-state',
    provider: 'codex',
    providerSessionId: '55555555-5555-4555-8555-555555555555',
    title: checkpointId,
    projectId: 'remote:synthetic-lifecycle-state',
    repositoryId: 'synthetic-lifecycle-state',
    branch: 'feature/lifecycle-state',
    head: '5'.repeat(40),
    machine: 'synthetic-machine',
    createdAt: '2026-07-28T00:00:00.000Z',
    payloadPath: `objects/${checkpointId}`,
    capabilities: {
      nativeResume: false,
      universalHandoff: true,
      codeReachable: true,
      wipRef: null,
      sourceSync: null,
    },
  };
}

function lifecycle(
  action: LifecycleEvent['action'],
  eventId: string,
  resolvedCheckpointIds?: string[],
): LifecycleEvent {
  return {
    schemaVersion: 1,
    eventType: 'lifecycle',
    eventId,
    sessionId: 'fleet:synthetic-lifecycle-state',
    action,
    machine: 'synthetic-machine',
    createdAt: '2026-07-28T01:00:00.000Z',
    retentionUntil: action === 'trash' ? '2026-08-27T01:00:00.000Z' : null,
    resolvedCheckpointIds,
    reason: null,
  };
}

describe('Session lifecycle state replay', () => {
  it('reopens deletion conflict for later descendants and clears it only through explicit resolution', () => {
    const rootId = '1'.repeat(64);
    const oldDeviceId = '2'.repeat(64);
    const laterDescendantId = '3'.repeat(64);
    const events: SessionEvent[] = [
      checkpoint(rootId),
      lifecycle('trash', 'trash-event'),
      checkpoint(oldDeviceId, [rootId]),
      lifecycle('resolve-trash-conflict', 'resolved-event', [oldDeviceId]),
      checkpoint(laterDescendantId, [oldDeviceId]),
    ];
    expect(deriveSessionLifecycleStates(events).get('fleet:synthetic-lifecycle-state')).toMatchObject({
      state: 'trashed',
      version: 'resolved-event',
      deletionConflictCheckpointIds: [laterDescendantId],
    });

    events.push(lifecycle('untrash', 'restore-event'));
    expect(deriveSessionLifecycleStates(events).get('fleet:synthetic-lifecycle-state')).toMatchObject({
      state: 'active',
      version: 'restore-event',
      deletionConflictCheckpointIds: [],
    });
  });
});
