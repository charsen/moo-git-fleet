import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionProvider } from '../../shared/sessions.js';
import type { BackupSessionMeta } from '../../shared/session-sync.js';
import { backupSessionMetaSchema } from '../../shared/session-sync.js';
import { completeContent, transcriptSnapshot } from './compare.js';

/**
 * 备份仓的全部结构就是这些文件，没有事件流、没有对象目录：
 *
 *   sessions/<provider>/<providerSessionId>.jsonl   会话原文，追加写，git diff 天然增量
 *   sessions/<provider>/<providerSessionId>.json    这条会话的说明（标题、项目、来源设备、墓碑）
 *
 * 一个会话一对文件，删除就是把 .jsonl 移走、.json 标记为墓碑。
 */
export const sessionsDirectoryName = 'sessions';

export class BackupStoreError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BackupStoreError';
  }
}

/** 会话 ID 直接当文件名用，因此必须先确认它不会跳出备份目录。 */
export function assertSafeSessionId(providerSessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerSessionId) || providerSessionId.includes('..')) {
    throw new BackupStoreError(`会话 ID 无法安全地作为文件名保存：${providerSessionId}`);
  }
  return providerSessionId;
}

function sessionDirectory(backupPath: string, provider: SessionProvider): string {
  return path.join(backupPath, sessionsDirectoryName, provider);
}

export function transcriptPath(backupPath: string, provider: SessionProvider, providerSessionId: string): string {
  return path.join(sessionDirectory(backupPath, provider), `${assertSafeSessionId(providerSessionId)}.jsonl`);
}

function metaPath(backupPath: string, provider: SessionProvider, providerSessionId: string): string {
  return path.join(sessionDirectory(backupPath, provider), `${assertSafeSessionId(providerSessionId)}.json`);
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export interface BackupSessionEntry {
  meta: BackupSessionMeta;
  /** 墓碑没有会话原文。 */
  hasTranscript: boolean;
}

/** 列出备份仓里全部会话（含墓碑）。备份仓不存在或还是空的时候返回空数组。 */
export async function listBackupSessions(backupPath: string): Promise<BackupSessionEntry[]> {
  const entries: BackupSessionEntry[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const directory = sessionDirectory(backupPath, provider);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const transcripts = new Set(names.filter((name) => name.endsWith('.jsonl')));
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readIfExists(path.join(directory, name));
      if (!raw) continue;
      const parsed = backupSessionMetaSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      entries.push({
        meta: parsed.data,
        hasTranscript: transcripts.has(`${name.slice(0, -'.json'.length)}.jsonl`),
      });
    }
  }
  return entries.sort((left, right) => right.meta.updatedAt.localeCompare(left.meta.updatedAt));
}

export async function readBackupTranscript(
  backupPath: string,
  provider: SessionProvider,
  providerSessionId: string,
): Promise<string | null> {
  return readIfExists(transcriptPath(backupPath, provider, providerSessionId));
}

/** 流式算摘要：会话文件可能几十 MB，不要为了算 sha256 把它读成字符串。 */
async function fileDigest(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), bytes: (await stat(filePath)).size };
}

/** 文件是不是以换行结尾——不是的话最后一行还在写，只能备份到上一个换行为止。 */
async function endsWithNewline(filePath: string): Promise<boolean> {
  const size = (await stat(filePath)).size;
  if (size === 0) return true;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

export interface WriteBackupSessionInput {
  backupPath: string;
  provider: SessionProvider;
  providerSessionId: string;
  /** 二选一：已经读进内存的内容，或直接从本机会话文件拷贝。 */
  content?: string;
  sourcePath?: string;
  device: string;
  now: Date;
  details: Pick<
    BackupSessionMeta,
    'title' | 'projectId' | 'projectPath' | 'repositoryName' | 'lastActivityAt' | 'messageCount' | 'sourceRelativePath'
  >;
}

/** 写入一条会话备份：原文 + 说明。同一条会话重复写入是覆盖，不留历史副本（历史交给 git）。 */
export async function writeBackupSession(input: WriteBackupSessionInput): Promise<BackupSessionMeta> {
  const target = transcriptPath(input.backupPath, input.provider, input.providerSessionId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  // provider 正在写最后一行时，只备份到上一个换行为止。
  const wholeFile = input.sourcePath ? await endsWithNewline(input.sourcePath) : false;
  const content = input.sourcePath && !wholeFile
    ? completeContent(await readFile(input.sourcePath, 'utf8'))
    : completeContent(input.content ?? '');
  const snapshot = input.sourcePath && wholeFile
    ? await fileDigest(input.sourcePath)
    : transcriptSnapshot(content);
  const meta = backupSessionMetaSchema.parse({
    schemaVersion: 1,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    ...input.details,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    device: input.device,
    updatedAt: input.now.toISOString(),
    deleted: false,
    deletedAt: null,
  } satisfies BackupSessionMeta);
  if (input.sourcePath && wholeFile) await copyFile(input.sourcePath, target);
  else await writeAtomic(target, content);
  await writeAtomic(metaPath(input.backupPath, input.provider, input.providerSessionId), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/**
 * 墓碑：删掉会话原文，只留一条「这条会话被某台电脑删除了」的记录。
 * 没有墓碑的话，另一台电脑下次同步会把它当成「只有本机有」重新推回备份。
 */
export async function writeBackupTombstone(input: {
  backupPath: string;
  provider: SessionProvider;
  providerSessionId: string;
  device: string;
  now: Date;
  previous?: BackupSessionMeta | null;
}): Promise<BackupSessionMeta> {
  const timestamp = input.now.toISOString();
  const meta = backupSessionMetaSchema.parse({
    schemaVersion: 1,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    title: input.previous?.title ?? null,
    projectId: input.previous?.projectId ?? 'unknown',
    projectPath: input.previous?.projectPath ?? null,
    repositoryName: input.previous?.repositoryName ?? null,
    lastActivityAt: input.previous?.lastActivityAt ?? null,
    sourceRelativePath: input.previous?.sourceRelativePath ?? null,
    messageCount: 0,
    bytes: 0,
    sha256: '',
    device: input.device,
    updatedAt: timestamp,
    deleted: true,
    deletedAt: timestamp,
  } satisfies BackupSessionMeta);
  await rm(transcriptPath(input.backupPath, input.provider, input.providerSessionId), { force: true });
  await writeAtomic(metaPath(input.backupPath, input.provider, input.providerSessionId), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export async function readBackupMeta(
  backupPath: string,
  provider: SessionProvider,
  providerSessionId: string,
): Promise<BackupSessionMeta | null> {
  const raw = await readIfExists(metaPath(backupPath, provider, providerSessionId));
  if (!raw) return null;
  const parsed = backupSessionMetaSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}
