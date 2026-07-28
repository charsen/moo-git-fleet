import path from 'node:path';
import type { Checkpoint, SessionEvent } from '../../shared/sessions.js';
import { sessionEventSchema } from '../../shared/sessions.js';
import { runGit } from '../git/runner.js';
import { scanSecrets, type SecretScanFile } from './secrets.js';
import { deriveSessionLifecycleStates, SessionLifecycleStateError } from './lifecycle-state.js';
import { deriveSessionLineageStates, SessionLineageStateError } from './lineage-state.js';

const maxEventCount = 100_000;
const maxEventBytes = 1_000_000;

export class SessionEventStoreError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SessionEventStoreError';
  }
}

export function assertSessionVaultContentSafe(files: SecretScanFile[]): void {
  const result = scanSecrets(files);
  if (result.safe) return;
  const types = [...new Set(result.findings.map((finding) => finding.type))].sort().join('、');
  throw new SessionEventStoreError(`Session Vault 已跟踪内容命中秘密扫描规则（${types}），已停止读取`);
}

export async function readSessionVaultBlob(
  vaultPath: string,
  head: string,
  relativePath: string,
  maxBytes: number,
): Promise<string> {
  if (
    relativePath.includes('\\') ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('/')
  ) {
    throw new SessionEventStoreError('Session Vault blob 路径不安全，已停止读取');
  }
  const result = await runGit(vaultPath, ['show', `${head}:${relativePath}`], 30_000, undefined, maxBytes);
  if (result.exitCode !== 0 || result.stdoutTruncated) {
    throw new SessionEventStoreError(`Session Vault 已跟踪文件无法安全读取：${relativePath}`);
  }
  return result.stdout.toString('utf8');
}

function assertEventPath(relativePath: string): void {
  if (
    relativePath.includes('\\') ||
    path.posix.normalize(relativePath) !== relativePath ||
    !/^events\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/.test(relativePath)
  ) {
    throw new SessionEventStoreError('Session Vault event 路径不安全，已停止读取');
  }
}

export function assertCheckpointPayloadPath(checkpoint: Checkpoint): void {
  if (
    !/^[a-f0-9]{64}$/.test(checkpoint.checkpointId) ||
    checkpoint.payloadPath !== `objects/${checkpoint.checkpointId}`
  ) {
    throw new SessionEventStoreError('Session Vault checkpoint payload 身份不匹配，已停止读取');
  }
}

async function trackedEventPaths(vaultPath: string, head: string): Promise<string[]> {
  const treeResult = await runGit(
    vaultPath,
    ['ls-tree', '-r', '-z', '--name-only', head, '--', 'events'],
    30_000,
    undefined,
    16 * 1024 * 1024,
  );
  if (treeResult.exitCode !== 0 || treeResult.stdoutTruncated) {
    throw new SessionEventStoreError('Session Vault event 列表过大或无法读取，已停止读取');
  }
  const treePaths = treeResult.stdout.toString('utf8').split('\0').filter(Boolean);
  if (treePaths.length > maxEventCount) throw new SessionEventStoreError(`Session Vault event 超过 ${maxEventCount} 条索引上限`);
  treePaths.forEach(assertEventPath);

  const historyResult = await runGit(
    vaultPath,
    ['log', '--reverse', '--topo-order', '--format=%H', '--name-only', '--no-renames', head, '--', 'events'],
    30_000,
    undefined,
    16 * 1024 * 1024,
  );
  if (historyResult.exitCode !== 0 || historyResult.stdoutTruncated) {
    throw new SessionEventStoreError('Session Vault event 历史过大或无法读取，已停止读取');
  }
  const historyPaths = historyResult.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('events/'));
  historyPaths.forEach(assertEventPath);
  if (new Set(historyPaths).size !== historyPaths.length) {
    throw new SessionEventStoreError('Session Vault 存在被修改或重复提交的旧 event，已停止读取');
  }
  const treeSet = new Set(treePaths);
  if (historyPaths.length !== treePaths.length || historyPaths.some((eventPath) => !treeSet.has(eventPath))) {
    throw new SessionEventStoreError('Session Vault event 历史与当前树不一致，已停止读取');
  }
  return historyPaths;
}

function validateLineage(events: SessionEvent[]): void {
  const eventIds = new Set<string>();
  const checkpoints = new Map<string, Checkpoint>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new SessionEventStoreError('Session Vault 存在重复 eventId，已停止读取');
    eventIds.add(event.eventId);
    if (event.eventType !== 'checkpoint') continue;
    assertCheckpointPayloadPath(event);
    if (checkpoints.has(event.checkpointId)) {
      throw new SessionEventStoreError('Session Vault 存在重复 checkpointId，已停止读取');
    }
    checkpoints.set(event.checkpointId, event);
  }
  for (const checkpoint of checkpoints.values()) {
    if (new Set(checkpoint.parentCheckpointIds).size !== checkpoint.parentCheckpointIds.length) {
      throw new SessionEventStoreError('Session Vault checkpoint parent 重复，已停止读取');
    }
    for (const parentId of checkpoint.parentCheckpointIds) {
      const parent = checkpoints.get(parentId);
      if (!parent || parent.sessionId !== checkpoint.sessionId) {
        throw new SessionEventStoreError('Session Vault checkpoint parent 缺失或跨逻辑会话，已停止读取');
      }
    }
    if (checkpoint.resumedFromCheckpointId) {
      const resumedFrom = checkpoints.get(checkpoint.resumedFromCheckpointId);
      if (!resumedFrom || resumedFrom.sessionId !== checkpoint.sessionId) {
        throw new SessionEventStoreError('Session Vault 接力来源缺失或跨逻辑会话，已停止读取');
      }
    }
    if (checkpoint.splitFromCheckpointId) {
      const splitFrom = checkpoints.get(checkpoint.splitFromCheckpointId);
      if (!splitFrom || splitFrom.sessionId === checkpoint.sessionId || checkpoint.parentCheckpointIds.length > 0) {
        throw new SessionEventStoreError('Session Vault 拆分来源缺失、未跨逻辑会话或错误携带 parent，已停止读取');
      }
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (checkpointId: string): void => {
    if (visited.has(checkpointId)) return;
    if (visiting.has(checkpointId)) {
      throw new SessionEventStoreError('Session Vault checkpoint lineage 形成循环，已停止读取');
    }
    visiting.add(checkpointId);
    for (const parentId of checkpoints.get(checkpointId)?.parentCheckpointIds ?? []) visit(parentId);
    visiting.delete(checkpointId);
    visited.add(checkpointId);
  };
  for (const checkpointId of checkpoints.keys()) visit(checkpointId);
  try {
    deriveSessionLifecycleStates(events);
    deriveSessionLineageStates(events);
  } catch (error) {
    if (error instanceof SessionLifecycleStateError) throw new SessionEventStoreError(error.message);
    if (error instanceof SessionLineageStateError) throw new SessionEventStoreError(error.message);
    throw error;
  }
}

export async function readSessionEventsAtHead(vaultPath: string, head: string | null): Promise<SessionEvent[]> {
  if (!head) return [];
  const events: SessionEvent[] = [];
  for (const eventPath of await trackedEventPaths(vaultPath, head)) {
    const contents = await readSessionVaultBlob(vaultPath, head, eventPath, maxEventBytes);
    assertSessionVaultContentSafe([{ path: eventPath, content: contents }]);
    let event: SessionEvent;
    try {
      event = sessionEventSchema.parse(JSON.parse(contents));
    } catch {
      throw new SessionEventStoreError(`Session Vault event 无法解析：${eventPath}`);
    }
    if (path.posix.basename(eventPath) !== `${event.eventId}.json`) {
      throw new SessionEventStoreError('Session Vault event 文件名与 eventId 不一致，已停止读取');
    }
    events.push(event);
  }
  validateLineage(events);
  return events;
}
