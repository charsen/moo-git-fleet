import { describe, expect, it } from 'vitest';
import {
  capabilityCacheSchema,
  checkpointSchema,
  lifecycleEventSchema,
  providerSummaryRequestSchema,
  sessionEventSchema,
  sessionListPayloadSchema,
  sessionVaultSyncStatusSchema,
} from './sessions.js';

const checkpoint = {
  schemaVersion: 1 as const,
  eventType: 'checkpoint' as const,
  eventId: '01K00000000000000000000000',
  checkpointId: 'checkpoint-content-id',
  parentCheckpointIds: ['previous-checkpoint-id'],
  resumedFromCheckpointId: null,
  sessionId: 'stable-fleet-session-id',
  provider: 'claude' as const,
  providerSessionId: '11111111-1111-4111-8111-111111111111',
  title: 'Synthetic checkpoint',
  projectId: 'remote:0123456789abcdef0123456789abcdef',
  repositoryId: 'synthetic-repository',
  branch: 'feature/session-sync',
  head: 'a'.repeat(40),
  machine: 'fixture-machine',
  createdAt: '2026-07-28T00:00:00.000Z',
  payloadPath: 'objects/checkpoint-content-id',
  capabilities: {
    nativeResume: false,
    universalHandoff: true,
    codeReachable: true,
    wipRef: 'refs/moo-fleet/wip/checkpoint-content-id',
    sourceSync: null,
  },
};

describe('session event schemas', () => {
  it('keeps provider session ids and lineage in immutable checkpoint events', () => {
    expect(checkpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(sessionEventSchema.parse(checkpoint)).toMatchObject({
      providerSessionId: checkpoint.providerSessionId,
      parentCheckpointIds: checkpoint.parentCheckpointIds,
      resumedFromCheckpointId: null,
    });
  });

  it('rejects mutable updatedAt and lastCheckpoint fields instead of silently persisting them', () => {
    expect(checkpointSchema.safeParse({ ...checkpoint, updatedAt: '2026-07-28T01:00:00.000Z' }).success).toBe(false);
    expect(checkpointSchema.safeParse({ ...checkpoint, lastCheckpoint: 'another-id' }).success).toBe(false);
  });

  it('accepts append-only lifecycle events and a partial provider capability cache', () => {
    const lifecycle = {
      schemaVersion: 1 as const,
      eventType: 'lifecycle' as const,
      eventId: '01K00000000000000000000001',
      sessionId: checkpoint.sessionId,
      action: 'trash' as const,
      machine: 'fixture-machine',
      createdAt: '2026-07-28T01:00:00.000Z',
      retentionUntil: '2026-08-27T01:00:00.000Z',
      reason: 'Synthetic cleanup',
    };
    expect(lifecycleEventSchema.parse(lifecycle)).toEqual(lifecycle);
    expect(capabilityCacheSchema.parse({ schemaVersion: 1, providers: {} })).toEqual({
      schemaVersion: 1,
      providers: {},
    });
  });

  it('requires retention only on trash lifecycle events', () => {
    const lifecycle = {
      schemaVersion: 1 as const,
      eventType: 'lifecycle' as const,
      eventId: '01K00000000000000000000002',
      sessionId: checkpoint.sessionId,
      action: 'trash' as const,
      machine: 'fixture-machine',
      createdAt: '2026-07-28T01:00:00.000Z',
      retentionUntil: null,
      reason: null,
    };
    expect(lifecycleEventSchema.safeParse(lifecycle).success).toBe(false);
    expect(lifecycleEventSchema.safeParse({
      ...lifecycle,
      action: 'archive',
      retentionUntil: '2026-08-27T01:00:00.000Z',
    }).success).toBe(false);
    expect(lifecycleEventSchema.safeParse({ ...lifecycle, action: 'untrash' }).success).toBe(true);
  });

  it('requires an explicit true opt-in before a provider summary can consume tokens', () => {
    expect(providerSummaryRequestSchema.safeParse({ allowProviderInvocation: false }).success).toBe(false);
    expect(providerSummaryRequestSchema.parse({ allowProviderInvocation: true })).toEqual({ allowProviderInvocation: true });
  });

  it('bounds paginated session list payloads and keeps Vault sync state explicit', () => {
    const sync = sessionVaultSyncStatusSchema.parse({
      schemaVersion: 1,
      configured: true,
      remoteSyncEnabled: true,
      remoteChecked: true,
      state: 'local-ahead',
      localHead: 'b'.repeat(40),
      remoteHead: 'a'.repeat(40),
      ahead: 1,
      behind: 0,
      pendingLocal: true,
      lastAttemptAt: '2026-07-28T08:00:00.000Z',
      lastSuccessAt: null,
      lastError: null,
      message: 'Synthetic local checkpoint is pending Push',
    });
    const item = {
      sessionId: checkpoint.sessionId,
      provider: checkpoint.provider,
      providerSessionId: checkpoint.providerSessionId,
      title: checkpoint.title,
      projectId: checkpoint.projectId,
      repositoryId: checkpoint.repositoryId,
      branch: checkpoint.branch,
      head: checkpoint.head,
      machine: checkpoint.machine,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointAt: checkpoint.createdAt,
      checkpointCount: 1,
      headCheckpointIds: [checkpoint.checkpointId],
      forked: false,
      pinned: false,
      lifecycleState: 'active' as const,
      lifecycleVersion: null,
      lifecycleUpdatedAt: null,
      retentionUntil: null,
      deletionConflict: false,
      deletionConflictCheckpointIds: [],
      payloadState: 'available' as const,
      payloadBytes: 1_024,
      capabilities: checkpoint.capabilities,
    };
    expect(sessionListPayloadSchema.parse({
      schemaVersion: 1,
      items: [item],
      page: 1,
      pageSize: 50,
      total: 1,
      totalPages: 1,
      counts: { active: 1, archived: 0, trashed: 0, all: 1 },
      sync,
    })).toMatchObject({ items: [{ sessionId: checkpoint.sessionId }], sync: { state: 'local-ahead' } });
    expect(sessionListPayloadSchema.safeParse({
      schemaVersion: 1,
      items: Array.from({ length: 51 }, () => item),
      page: 1,
      pageSize: 50,
      total: 51,
      totalPages: 2,
      counts: { active: 51, archived: 0, trashed: 0, all: 51 },
      sync,
    }).success).toBe(false);
  });
});
