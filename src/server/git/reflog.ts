import { randomUUID } from 'node:crypto';
import type { ReflogEntry, ReflogPage } from '../../shared/contracts.js';
import { reflogQuerySchema } from '../../shared/schemas.js';
import { invalidRequestError, notFoundError } from '../errors.js';
import { runGit } from './runner.js';

const snapshots = new Map<string, { cwd: string; ref: string; expires: number; entries: ReflogEntry[]; truncated: boolean }>();
const ttl = 10 * 60_000;
const maxEntries = 10_000;

export async function readReflogPage(cwd: string, input: { ref?: string; snapshot?: string; skip?: number; limit?: number }): Promise<ReflogPage> {
  const query = reflogQuerySchema.parse(input);
  if (query.ref !== 'HEAD' && (await runGit(cwd, ['check-ref-format', query.ref])).exitCode !== 0) throw invalidRequestError('Reflog 引用无效');
  for (const [id, value] of snapshots) if (value.expires < Date.now()) snapshots.delete(id);
  let snapshot = query.snapshot, stored = snapshot ? snapshots.get(snapshot) : undefined;
  if (snapshot && (!stored || stored.cwd !== cwd || stored.ref !== query.ref)) throw notFoundError('Reflog 阅读快照已过期，请刷新后重试');
  if (!stored) {
    if (query.ref !== 'HEAD' && (await runGit(cwd, ['show-ref', '--verify', '--quiet', query.ref])).exitCode !== 0) throw notFoundError('该本地分支已不存在');
    const exists = await runGit(cwd, ['reflog', 'exists', query.ref]);
    const entries: ReflogEntry[] = [];
    if (exists.exitCode === 0) {
      const result = await runGit(cwd, ['log', '-g', '-z', '--date=iso-strict', '--format=%H%x00%gD%x00%gn%x00%gs', `--max-count=${maxEntries + 1}`, query.ref, '--'], 15_000, undefined, 8_000_000);
      if (result.exitCode !== 0 || result.stdoutTruncated) throw new Error('Reflog 过大或读取失败，请在本地 Git 中查看');
      const fields = result.stdout.toString('utf8').split('\0'); if (fields.at(-1) === '') fields.pop();
      if (fields.length % 4 !== 0) throw new Error('Reflog 记录格式无效');
      for (let i = 0; i < fields.length; i += 4) {
        const hash = fields[i]!, selector = fields[i + 1]!, date = selector.match(/@\{(.+)\}$/)?.[1];
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) || !date || Number.isNaN(Date.parse(date))) throw new Error('Reflog 记录身份无效');
        entries.push({ hash, selector: `${query.ref.replace(/^refs\/heads\//, '')}@{${i / 4}}`, actor: fields[i + 2]!, occurredAt: date, message: fields[i + 3]! });
      }
    } else if (exists.exitCode !== 1) throw new Error('读取 Reflog 状态失败');
    stored = { cwd, ref: query.ref, expires: Date.now() + ttl, entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries };
    snapshot = randomUUID(); snapshots.set(snapshot, stored);
    while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
  }
  return { ref: stored.ref, snapshot: snapshot!, entries: stored.entries.slice(query.skip, query.skip + query.limit), hasMore: query.skip + query.limit < stored.entries.length, truncated: stored.truncated };
}
