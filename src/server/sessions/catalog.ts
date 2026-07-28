import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  Checkpoint,
  SessionCheckpointPayload,
  SessionDetail,
  SessionEvent,
  SessionListItem,
  SessionListPayload,
  SessionLifecycleFilter,
  SessionProvider,
} from '../../shared/sessions.js';
import {
  sessionDetailSchema,
  sessionCheckpointPayloadSchema,
  sessionEventSchema,
  sessionListItemSchema,
  sessionListPayloadSchema,
  workspaceSnapshotSchema,
} from '../../shared/sessions.js';
import { runGit, runGitText } from '../git/runner.js';
import {
  assertCheckpointPayloadPath,
  assertSessionVaultContentSafe,
  readSessionEventsAtHead,
  readSessionVaultBlob,
  SessionEventStoreError,
} from './event-store.js';
import { sessionVaultSyncStatus, type SessionVaultSyncOptions } from './sync.js';
import { loadSessionVaultStatus, resolveSessionVaultBindingPath } from './vault.js';
import { deriveSessionLifecycleStates, initialSessionLifecycleState } from './lifecycle-state.js';
import { deriveSessionLineageStates } from './lineage-state.js';

const maxEventCount = 100_000;
const maxHandoffBytes = 1_000_000;
const maxPayloadMetadataBytes = 200_000;

const sessionCatalogCacheSchema = z.object({
  schemaVersion: z.literal(1),
  vaultId: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  builtAt: z.string().datetime({ offset: true }),
  events: z.array(sessionEventSchema).max(maxEventCount),
  payloadObjects: z.array(z.object({
    checkpointId: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }).strict()).max(maxEventCount),
}).strict();
type SessionCatalogCache = z.infer<typeof sessionCatalogCacheSchema>;

const sessionListQuerySchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(50).default(50),
  search: z.string().trim().max(200).default(''),
  provider: z.enum(['claude', 'codex']).nullable().default(null),
  lifecycle: z.enum(['active', 'archived', 'trashed', 'all']).default('active'),
}).strict();

export interface SessionCatalogOptions extends SessionVaultSyncOptions {
  indexPath?: string;
}

export interface SessionListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  provider?: SessionProvider | null;
  lifecycle?: SessionLifecycleFilter;
}

export class SessionCatalogError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SessionCatalogError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveIndexPath(options: SessionCatalogOptions): string {
  return path.resolve(options.indexPath ?? path.join(path.dirname(resolveSessionVaultBindingPath(options)), 'session-vault-index.json'));
}

async function gitHead(vaultPath: string): Promise<string | null> {
  return runGitText(vaultPath, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null);
}

async function readCache(options: SessionCatalogOptions): Promise<SessionCatalogCache | null> {
  try {
    return sessionCatalogCacheSchema.parse(JSON.parse(await readFile(resolveIndexPath(options), 'utf8')));
  } catch {
    return null;
  }
}

async function writeCache(options: SessionCatalogOptions, cache: SessionCatalogCache): Promise<void> {
  const parsed = sessionCatalogCacheSchema.parse(cache);
  const filePath = resolveIndexPath(options);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function loadCatalog(options: SessionCatalogOptions): Promise<{
  vaultPath: string | null;
  head: string | null;
  events: SessionEvent[];
  payloadObjects: Map<string, { bytes: number; files: number }>;
}> {
  const status = await loadSessionVaultStatus(options);
  if (!status.configured || !status.binding) {
    return { vaultPath: null, head: null, events: [], payloadObjects: new Map() };
  }
  const vaultPath = await realpath(status.binding.vaultPath);
  const head = await gitHead(vaultPath);
  const vaultId = digest(vaultPath);
  const cached = await readCache(options);
  if (cached?.vaultId === vaultId && cached.head === head) {
    return {
      vaultPath,
      head,
      events: cached.events,
      payloadObjects: new Map(cached.payloadObjects.map((item) => [item.checkpointId, { bytes: item.bytes, files: item.files }])),
    };
  }
  let events: SessionEvent[];
  try {
    events = await readSessionEventsAtHead(vaultPath, head);
  } catch (error) {
    if (error instanceof SessionEventStoreError) throw new SessionCatalogError(error.message);
    throw error;
  }
  const payloadObjects = await readSessionPayloadObjectsAtHead(vaultPath, head);
  await writeCache(options, {
    schemaVersion: 1,
    vaultId,
    head,
    builtAt: new Date().toISOString(),
    events,
    payloadObjects: [...payloadObjects].map(([checkpointId, value]) => ({ checkpointId, ...value })),
  });
  return { vaultPath, head, events, payloadObjects };
}

export async function readSessionPayloadObjectsAtHead(
  vaultPath: string,
  head: string | null,
): Promise<Map<string, { bytes: number; files: number }>> {
  const objects = new Map<string, { bytes: number; files: number }>();
  if (!head) return objects;
  const result = await runGit(
    vaultPath,
    ['ls-tree', '-r', '-l', '-z', head, '--', 'objects'],
    30_000,
    undefined,
    32 * 1024 * 1024,
  );
  if (result.exitCode !== 0 || result.stdoutTruncated) {
    throw new SessionCatalogError('Session Vault 交接对象索引过大或无法读取');
  }
  for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^100(?:644|755) blob [a-f0-9]{40,64}\s+(\d+)\t(objects\/([a-f0-9]{64})\/.+)$/);
    if (!match?.[1] || !match[2] || !match[3] || path.posix.normalize(match[2]) !== match[2]) {
      throw new SessionCatalogError('Session Vault 交接对象树包含不安全或无法识别的条目');
    }
    const bytes = Number.parseInt(match[1], 10);
    const current = objects.get(match[3]) ?? { bytes: 0, files: 0 };
    current.bytes += Number.isFinite(bytes) ? bytes : 0;
    current.files += 1;
    objects.set(match[3], current);
  }
  return objects;
}

function compareCheckpointAscending(left: Checkpoint, right: Checkpoint): number {
  return left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);
}

export function deriveSessionCatalog(
  events: SessionEvent[],
  payloadObjects?: Map<string, { bytes: number; files: number }>,
): { items: SessionListItem[]; checkpoints: Map<string, Checkpoint[]> } {
  const checkpoints = new Map<string, Checkpoint[]>();
  const lifecycleStates = deriveSessionLifecycleStates(events);
  const lineageStates = deriveSessionLineageStates(events);
  const items: SessionListItem[] = [];
  for (const [sessionId, lineage] of lineageStates) {
    const sessionCheckpoints = [...lineage.checkpoints];
    sessionCheckpoints.sort(compareCheckpointAscending);
    checkpoints.set(sessionId, sessionCheckpoints);
    const headIds = new Set(lineage.headCheckpointIds);
    const heads = sessionCheckpoints.filter((checkpoint) => headIds.has(checkpoint.checkpointId));
    if (heads.length === 0) throw new SessionCatalogError('Session Vault checkpoint lineage 形成循环，已停止建立索引');
    heads.sort(compareCheckpointAscending);
    const latest = heads.at(-1)!;
    const lifecycle = lifecycleStates.get(sessionId) ?? initialSessionLifecycleState();
    const deletionConflictCheckpointIds = heads
      .map((checkpoint) => checkpoint.checkpointId)
      .filter((checkpointId) => lifecycle.deletionConflictCheckpointIds.includes(checkpointId));
    const availablePayloads = sessionCheckpoints.filter((checkpoint) => payloadObjects?.has(checkpoint.checkpointId));
    const payloadState = payloadObjects === undefined || availablePayloads.length === sessionCheckpoints.length
      ? 'available'
      : availablePayloads.length === 0
        ? 'purged'
        : 'partial';
    if (lifecycle.state !== 'trashed' && payloadState !== 'available') {
      throw new SessionCatalogError('活跃或已归档会话的交接对象不完整，已停止建立索引');
    }
    items.push(sessionListItemSchema.parse({
      sessionId,
      provider: latest.provider,
      providerSessionId: latest.providerSessionId,
      title: latest.title,
      projectId: latest.projectId,
      repositoryId: latest.repositoryId,
      branch: latest.branch,
      head: latest.head,
      machine: latest.machine,
      latestCheckpointId: latest.checkpointId,
      latestCheckpointAt: latest.createdAt,
      checkpointCount: sessionCheckpoints.length,
      headCheckpointIds: heads.map((checkpoint) => checkpoint.checkpointId),
      forked: heads.length > 1,
      pinned: lifecycle.pinned,
      lifecycleState: lifecycle.state,
      lifecycleVersion: lifecycle.version,
      lifecycleUpdatedAt: lifecycle.updatedAt,
      retentionUntil: lifecycle.retentionUntil,
      deletionConflict: deletionConflictCheckpointIds.length > 0,
      deletionConflictCheckpointIds,
      payloadState,
      payloadBytes: sessionCheckpoints.reduce(
        (total, checkpoint) => total + (payloadObjects?.get(checkpoint.checkpointId)?.bytes ?? 0),
        0,
      ),
      capabilities: latest.capabilities,
    }));
  }
  items.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.latestCheckpointAt.localeCompare(left.latestCheckpointAt) || left.sessionId.localeCompare(right.sessionId);
  });
  return { items, checkpoints };
}

export async function listSessionVaultSessions(
  query: SessionListQuery = {},
  options: SessionCatalogOptions = {},
): Promise<SessionListPayload> {
  const input = sessionListQuerySchema.parse({
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 50,
    search: query.search ?? '',
    provider: query.provider ?? null,
    lifecycle: query.lifecycle ?? 'active',
  });
  const [{ events, payloadObjects }, sync] = await Promise.all([loadCatalog(options), sessionVaultSyncStatus(options)]);
  let items = deriveSessionCatalog(events, payloadObjects).items;
  if (input.provider) items = items.filter((item) => item.provider === input.provider);
  if (input.search) {
    const needle = input.search.toLocaleLowerCase();
    items = items.filter((item) =>
      [item.title, item.projectId, item.repositoryId, item.branch, item.machine, item.provider]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle)));
  }
  const counts = {
    active: items.filter((item) => item.lifecycleState === 'active').length,
    archived: items.filter((item) => item.lifecycleState === 'archived').length,
    trashed: items.filter((item) => item.lifecycleState === 'trashed').length,
    all: items.length,
  };
  if (input.lifecycle !== 'all') items = items.filter((item) => item.lifecycleState === input.lifecycle);
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / input.pageSize);
  const offset = (input.page - 1) * input.pageSize;
  return sessionListPayloadSchema.parse({
    schemaVersion: 1,
    items: items.slice(offset, offset + input.pageSize),
    page: input.page,
    pageSize: input.pageSize,
    total,
    totalPages,
    counts,
    sync,
  });
}

export async function sessionVaultSessionDetail(
  sessionId: string,
  options: SessionCatalogOptions = {},
): Promise<SessionDetail> {
  const { vaultPath, head, events, payloadObjects } = await loadCatalog(options);
  if (!vaultPath || !head) throw new SessionCatalogError('Session Vault 中尚无 checkpoint', 404);
  const catalog = deriveSessionCatalog(events, payloadObjects);
  const session = catalog.items.find((item) => item.sessionId === sessionId);
  const checkpoints = catalog.checkpoints.get(sessionId);
  if (!session || !checkpoints) throw new SessionCatalogError('Session Vault 会话不存在', 404);
  const payload = payloadObjects.has(session.latestCheckpointId)
    ? await readCheckpointPayload(vaultPath, head, checkpoints, session.latestCheckpointId)
    : null;
  return sessionDetailSchema.parse({
    schemaVersion: 1,
    session,
    checkpoints,
    latestHandoffMarkdown: payload?.handoffMarkdown ?? null,
    latestWorkspace: payload?.workspace ?? null,
  });
}

async function readCheckpointPayload(
  vaultPath: string,
  head: string,
  checkpoints: Checkpoint[],
  checkpointId: string,
): Promise<SessionCheckpointPayload> {
  const checkpoint = checkpoints.find((item) => item.checkpointId === checkpointId);
  if (!checkpoint) throw new SessionCatalogError('Session Vault checkpoint 不存在', 404);
  assertCheckpointPayloadPath(checkpoint);
  const [handoff, workspaceContents, manifestContents] = await Promise.all([
    readSessionVaultBlob(vaultPath, head, `${checkpoint.payloadPath}/handoff.md`, maxHandoffBytes),
    readSessionVaultBlob(vaultPath, head, `${checkpoint.payloadPath}/workspace.json`, maxPayloadMetadataBytes),
    readSessionVaultBlob(vaultPath, head, `${checkpoint.payloadPath}/manifest.json`, maxPayloadMetadataBytes),
  ]);
  assertSessionVaultContentSafe([
    { path: 'handoff.md', content: handoff },
    { path: 'workspace.json', content: workspaceContents },
    { path: 'manifest.json', content: manifestContents },
  ]);
  let workspace;
  try {
    workspace = workspaceSnapshotSchema.parse(JSON.parse(workspaceContents));
    JSON.parse(manifestContents);
  } catch {
    throw new SessionCatalogError('Session Vault checkpoint payload 无法解析', 409);
  }
  return sessionCheckpointPayloadSchema.parse({
    schemaVersion: 1,
    checkpoint,
    handoffMarkdown: handoff,
    workspace,
  });
}

export async function sessionVaultCheckpointPayload(
  sessionId: string,
  checkpointId: string | null = null,
  options: SessionCatalogOptions = {},
): Promise<SessionCheckpointPayload> {
  const { vaultPath, head, events, payloadObjects } = await loadCatalog(options);
  if (!vaultPath || !head) throw new SessionCatalogError('Session Vault 中尚无 checkpoint', 404);
  const catalog = deriveSessionCatalog(events, payloadObjects);
  const session = catalog.items.find((item) => item.sessionId === sessionId);
  const checkpoints = catalog.checkpoints.get(sessionId);
  if (!session || !checkpoints) throw new SessionCatalogError('Session Vault 会话不存在', 404);
  const selectedCheckpointId = checkpointId ?? (session.forked ? null : session.latestCheckpointId);
  if (!selectedCheckpointId) {
    throw new SessionCatalogError('会话已分叉，请先明确选择一个 head checkpoint 再继续恢复', 409);
  }
  if (!payloadObjects.has(selectedCheckpointId)) {
    throw new SessionCatalogError('该会话的当前 Vault 交接对象已从废纸篓清理，只能从 Git 历史或备份人工恢复', 410);
  }
  return readCheckpointPayload(vaultPath, head, checkpoints, selectedCheckpointId);
}
