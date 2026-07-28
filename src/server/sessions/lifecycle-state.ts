import type {
  LifecycleAction,
  LifecycleEvent,
  SessionEvent,
  SessionListItem,
} from '../../shared/sessions.js';

export interface SessionLifecycleState {
  state: SessionListItem['lifecycleState'];
  pinned: boolean;
  version: string | null;
  updatedAt: string | null;
  retentionUntil: string | null;
  stateBeforeTrash: 'active' | 'archived' | null;
  deletionConflictCheckpointIds: string[];
}

export class SessionLifecycleStateError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SessionLifecycleStateError';
  }
}

export function initialSessionLifecycleState(): SessionLifecycleState {
  return {
    state: 'active',
    pinned: false,
    version: null,
    updatedAt: null,
    retentionUntil: null,
    stateBeforeTrash: null,
    deletionConflictCheckpointIds: [],
  };
}

function invalidTransition(action: LifecycleAction): never {
  const labels: Record<LifecycleAction, string> = {
    pin: '置顶',
    unpin: '取消置顶',
    archive: '归档',
    restore: '恢复归档',
    trash: '移入废纸篓',
    untrash: '恢复废纸篓会话',
    'resolve-trash-conflict': '确认删除后产生的新内容',
  };
  throw new SessionLifecycleStateError(`生命周期事件顺序非法：当前状态不能重复或直接执行“${labels[action]}”`);
}

export function applyLifecycleEvent(
  current: SessionLifecycleState,
  event: LifecycleEvent,
): SessionLifecycleState {
  let state = current.state;
  let pinned = current.pinned;
  let retentionUntil = current.retentionUntil;
  let stateBeforeTrash = current.stateBeforeTrash;
  let deletionConflictCheckpointIds = current.deletionConflictCheckpointIds;
  switch (event.action) {
    case 'pin':
      if (pinned || state === 'trashed') invalidTransition(event.action);
      pinned = true;
      break;
    case 'unpin':
      if (!pinned || state === 'trashed') invalidTransition(event.action);
      pinned = false;
      break;
    case 'archive':
      if (state !== 'active') invalidTransition(event.action);
      state = 'archived';
      break;
    case 'restore':
      if (state !== 'archived') invalidTransition(event.action);
      state = 'active';
      break;
    case 'trash':
      if (state === 'trashed') invalidTransition(event.action);
      stateBeforeTrash = state;
      state = 'trashed';
      retentionUntil = event.retentionUntil;
      deletionConflictCheckpointIds = [];
      break;
    case 'untrash':
      if (state !== 'trashed') invalidTransition(event.action);
      state = stateBeforeTrash ?? 'active';
      stateBeforeTrash = null;
      retentionUntil = null;
      deletionConflictCheckpointIds = [];
      break;
    case 'resolve-trash-conflict': {
      const resolved = new Set(event.resolvedCheckpointIds ?? []);
      deletionConflictCheckpointIds = deletionConflictCheckpointIds.filter((checkpointId) => !resolved.has(checkpointId));
      break;
    }
  }
  return {
    state,
    pinned,
    version: event.eventId,
    updatedAt: event.createdAt,
    retentionUntil,
    stateBeforeTrash,
    deletionConflictCheckpointIds,
  };
}

/** Replays immutable events in their Vault Git history order. */
export function deriveSessionLifecycleStates(events: SessionEvent[]): Map<string, SessionLifecycleState> {
  const states = new Map<string, SessionLifecycleState>();
  for (const event of events) {
    if (event.eventType === 'checkpoint') {
      const current = states.get(event.sessionId) ?? initialSessionLifecycleState();
      states.set(event.sessionId, current.state === 'trashed'
        ? {
            ...current,
            deletionConflictCheckpointIds: [...new Set([...current.deletionConflictCheckpointIds, event.checkpointId])],
          }
        : current);
      continue;
    }
    if (event.eventType !== 'lifecycle') continue;
    const current = states.get(event.sessionId);
    if (!current) {
      throw new SessionLifecycleStateError('生命周期事件引用了尚不存在的逻辑会话');
    }
    states.set(event.sessionId, applyLifecycleEvent(current, event));
  }
  return states;
}
