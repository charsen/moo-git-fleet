import { createHash } from 'node:crypto';
import type { SessionSyncAction, SessionSyncRelation } from '../../shared/session-sync.js';

/**
 * Claude / Codex 的会话文件是追加写的 JSONL：继续同一个会话只会在末尾添行，
 * 已经写下的行不会被改写。因此「谁更全」只需要逐行比前缀，不需要 diff 算法，
 * 也不需要事件流、checkpoint 或 lineage 这类派生结构。
 */
export interface TranscriptSnapshot {
  lines: string[];
  sha256: string;
  bytes: number;
}

/** 去掉行尾 CR 与文件末尾的空行，避免「只差一个换行」被当成分叉。 */
export function splitTranscript(content: string): string[] {
  const lines = content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * provider 可能正在往文件里写最后一行。写完整的一行必然以换行结尾，
 * 所以没有换行结尾的尾巴是半行——它不能进备份，否则那行写完之后
 * 两边就会被判成"分叉"，逼用户去选一个根本不存在的冲突。
 */
export function completeContent(content: string): string {
  if (content === '' || content.endsWith('\n')) return content;
  const lastBreak = content.lastIndexOf('\n');
  return lastBreak === -1 ? '' : content.slice(0, lastBreak + 1);
}

export function transcriptSnapshot(content: string): TranscriptSnapshot {
  return {
    lines: splitTranscript(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function isPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length > longer.length) return false;
  return shorter.every((line, index) => line === longer[index]);
}

/**
 * 一边没有内容时，光看"有没有"就能定关系——这一步不用读文件。
 * 两边都有内容才需要读进来比，那时返回 null 交给 `contentRelation`。
 */
export function presenceRelation(input: {
  hasLocal: boolean;
  hasBackup: boolean;
  backupDeleted?: boolean;
}): SessionSyncRelation | null {
  if (input.backupDeleted) return input.hasLocal ? 'backup-deleted' : 'same';
  if (!input.hasLocal) return input.hasBackup ? 'backup-only' : 'same';
  if (!input.hasBackup) return 'local-only';
  return null;
}

/** 两边都有内容时逐行比前缀。 */
export function contentRelation(local: readonly string[], backup: readonly string[]): SessionSyncRelation {
  if (local.length === backup.length && isPrefix(local, backup)) return 'same';
  if (isPrefix(backup, local)) return 'local-ahead';
  if (isPrefix(local, backup)) return 'backup-ahead';
  return 'diverged';
}

export interface RelationInput {
  /** 本机会话内容；本机没有这个会话时为 null。 */
  local: readonly string[] | null;
  /** 备份仓里的会话内容；备份没有或只有墓碑时为 null。 */
  backup: readonly string[] | null;
  /** 备份里这条记录是墓碑（另一台电脑删掉了）。 */
  backupDeleted?: boolean;
}

export function sessionRelation({ local, backup, backupDeleted = false }: RelationInput): SessionSyncRelation {
  return (
    presenceRelation({ hasLocal: Boolean(local), hasBackup: Boolean(backup), backupDeleted })
    ?? contentRelation(local ?? [], backup ?? [])
  );
}

/**
 * 同步时对每种关系的默认处理。只有真正会丢内容的两种情况才停下来问用户；
 * 其余都能安全自动完成，因为「更全的一方包含另一方的全部内容」。
 */
export function autoActionFor(relation: SessionSyncRelation): SessionSyncAction {
  switch (relation) {
    case 'same':
      return 'skip';
    case 'local-only':
    case 'local-ahead':
      return 'write-backup';
    case 'backup-only':
    case 'backup-ahead':
      return 'write-local';
    case 'diverged':
    case 'backup-deleted':
      return 'ask';
  }
}

/** 分叉时共同的前缀行数，用于告诉用户「从第几条开始各写各的」。 */
export function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}
