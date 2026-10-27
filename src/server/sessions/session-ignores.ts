import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { backupConfigDirectory, type BackupRepoOptions } from './backup-repo.js';

/**
 * 本机忽略清单。
 *
 * 「删除会话」只动当前电脑的文件，备份里那份按产品设计要保留（另一台电脑还在用）。
 * 但同步的默认动作是「备份有、本机没有 → 写回本机」，于是删掉的会话下一次同步就
 * 原封不动回来了——用户点的是删除，看到的却是复活。
 *
 * 所以删除成功时在这里记一笔：这条会话**在这台电脑上**不想要了。同步见到它就跳过，
 * 备份和另一台电脑都不受影响（跨机删除仍要靠墓碑，那件事会让另一台电脑弹确认）。
 *
 * 清单只在本机，不进备份仓：它是「这台电脑的偏好」，不是会话内容。
 */
const ignoreItemSchema = z.object({
  provider: z.string().min(1),
  providerSessionId: z.string().min(1),
  ignoredAt: z.string(),
});
const ignoresFileSchema = z.object({
  version: z.literal(1),
  items: z.array(ignoreItemSchema),
});

export interface SessionIgnore {
  provider: string;
  providerSessionId: string;
  ignoredAt: string;
}

export function sessionIgnoreKey(provider: string, providerSessionId: string): string {
  return `${provider}:${providerSessionId}`;
}

export function resolveSessionIgnorePath(options: BackupRepoOptions = {}): string {
  return path.join(backupConfigDirectory(options), 'session-ignores.json');
}

export async function loadSessionIgnores(options: BackupRepoOptions = {}): Promise<SessionIgnore[]> {
  const raw = await readFile(resolveSessionIgnorePath(options), 'utf8').catch(() => null);
  if (!raw) return [];
  try {
    const parsed = ignoresFileSchema.safeParse(JSON.parse(raw));
    // 清单坏了就当没有：宁可按默认同步，也不要因为一个缓存文件让同步整体失败。
    return parsed.success ? parsed.data.items : [];
  } catch {
    return [];
  }
}

async function writeSessionIgnores(items: SessionIgnore[], options: BackupRepoOptions): Promise<void> {
  const target = resolveSessionIgnorePath(options);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ignoresFileSchema.parse({ version: 1, items }), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

/** 记住「这些会话在这台电脑上不要再拿回来」。 */
export async function rememberSessionIgnores(
  entries: Array<{ provider: string; providerSessionId: string }>,
  options: BackupRepoOptions = {},
  now: Date = new Date(),
): Promise<void> {
  if (entries.length === 0) return;
  const existing = await loadSessionIgnores(options);
  const known = new Set(existing.map((item) => sessionIgnoreKey(item.provider, item.providerSessionId)));
  const added = entries
    .filter((entry) => !known.has(sessionIgnoreKey(entry.provider, entry.providerSessionId)))
    .map((entry) => ({ ...entry, ignoredAt: now.toISOString() }));
  if (added.length === 0) return;
  await writeSessionIgnores([...existing, ...added], options);
}

/** 忘掉这些忽略项：会话被恢复了、或已经改成跨机删除，清单里就不该再留着。 */
export async function forgetSessionIgnores(
  keys: Iterable<string>,
  options: BackupRepoOptions = {},
): Promise<void> {
  const targets = new Set(keys);
  if (targets.size === 0) return;
  const existing = await loadSessionIgnores(options);
  const remaining = existing.filter((item) => !targets.has(sessionIgnoreKey(item.provider, item.providerSessionId)));
  if (remaining.length === existing.length) return;
  await writeSessionIgnores(remaining, options);
}
