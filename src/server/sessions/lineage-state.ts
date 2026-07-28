import type { Checkpoint, SessionEvent, SessionLineageEvent } from '../../shared/sessions.js';

export interface SessionLineageState {
  checkpoints: Checkpoint[];
  rawHeadCheckpointIds: string[];
  headCheckpointIds: string[];
  suppressedHeadCheckpointIds: string[];
  resolutionVersion: string | null;
  resolutionConflict: boolean;
}

interface MutableLineageState {
  checkpoints: Checkpoint[];
  checkpointIds: Set<string>;
  rawHeads: Set<string>;
  suppressedHeads: Set<string>;
  resolutionVersion: string | null;
  resolutionConflict: boolean;
}

export class SessionLineageStateError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SessionLineageStateError';
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function applyResolution(
  event: SessionLineageEvent,
  state: MutableLineageState,
  checkpoints: Map<string, Checkpoint>,
): void {
  for (const checkpointId of event.expectedHeadCheckpointIds) {
    if (!state.checkpointIds.has(checkpointId)) {
      throw new SessionLineageStateError('lineage 事件引用了其他逻辑会话或不存在的 checkpoint');
    }
  }
  if (event.action === 'split') {
    for (const split of event.splitSessions) {
      const source = checkpoints.get(split.sourceHeadCheckpointId);
      const clone = checkpoints.get(split.newCheckpointId);
      if (
        !source ||
        source.sessionId !== event.sessionId ||
        !clone ||
        clone.sessionId !== split.newSessionId ||
        clone.splitFromCheckpointId !== split.sourceHeadCheckpointId ||
        clone.parentCheckpointIds.length > 0
      ) {
        throw new SessionLineageStateError('split lineage 事件引用的新会话 checkpoint 不完整或身份不匹配');
      }
    }
  }
  if (event.expectedResolutionVersion !== state.resolutionVersion) {
    for (const checkpointId of event.expectedHeadCheckpointIds) state.suppressedHeads.delete(checkpointId);
    state.resolutionVersion = event.eventId;
    state.resolutionConflict = true;
    return;
  }
  state.suppressedHeads.delete(event.selectedHeadCheckpointId);
  for (const checkpointId of event.discardedHeadCheckpointIds) state.suppressedHeads.add(checkpointId);
  state.resolutionVersion = event.eventId;
  state.resolutionConflict = false;
}

/**
 * Builds the immutable checkpoint DAG first, then applies lineage resolutions.
 * Git does not define a semantic order for multiple event files added by one
 * commit, so checkpoint parent validation must never depend on filename order.
 * Suppression is exact: if an old device extends a discarded head, the new
 * descendant is unsuppressed and the fork becomes visible again.
 */
export function deriveSessionLineageStates(events: SessionEvent[]): Map<string, SessionLineageState> {
  const mutable = new Map<string, MutableLineageState>();
  const checkpoints = new Map<string, Checkpoint>();
  for (const event of events) {
    if (event.eventType !== 'checkpoint') continue;
    checkpoints.set(event.checkpointId, event);
    const state = mutable.get(event.sessionId) ?? {
      checkpoints: [],
      checkpointIds: new Set<string>(),
      rawHeads: new Set<string>(),
      suppressedHeads: new Set<string>(),
      resolutionVersion: null,
      resolutionConflict: false,
    };
    state.checkpoints.push(event);
    state.checkpointIds.add(event.checkpointId);
    state.rawHeads.add(event.checkpointId);
    mutable.set(event.sessionId, state);
  }
  for (const checkpoint of checkpoints.values()) {
    const state = mutable.get(checkpoint.sessionId)!;
    for (const parentId of checkpoint.parentCheckpointIds) state.rawHeads.delete(parentId);
  }
  for (const event of events) {
    if (event.eventType !== 'lineage') continue;
    const state = mutable.get(event.sessionId);
    if (!state) throw new SessionLineageStateError('lineage 事件引用了尚不存在的逻辑会话');
    applyResolution(event, state, checkpoints);
  }

  const result = new Map<string, SessionLineageState>();
  for (const [sessionId, state] of mutable) {
    const rawHeadCheckpointIds = sorted(state.rawHeads);
    const unsuppressedHeads = rawHeadCheckpointIds.filter(
      (checkpointId) => !state.suppressedHeads.has(checkpointId),
    );
    // Concurrent stale resolutions can suppress opposite heads. Keep the Vault
    // readable and surface the original fork instead of producing zero heads.
    const resolutionConflict = state.resolutionConflict || (unsuppressedHeads.length === 0 && rawHeadCheckpointIds.length > 0);
    result.set(sessionId, {
      checkpoints: [...state.checkpoints],
      rawHeadCheckpointIds,
      headCheckpointIds: unsuppressedHeads.length === 0 ? rawHeadCheckpointIds : unsuppressedHeads,
      suppressedHeadCheckpointIds: sorted(state.suppressedHeads),
      resolutionVersion: state.resolutionVersion,
      resolutionConflict,
    });
  }
  return result;
}
