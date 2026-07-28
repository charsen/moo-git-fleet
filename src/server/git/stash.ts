import type { StashEntry } from '../../shared/contracts.js';
import { runGit, runGitText } from './runner.js';

const stashRefPattern = /^stash@\{\d+\}$/;
const stashHashPattern = /^[a-f0-9]{40,64}$/;

function ensureStashIdentity(ref: string, expectedHash: string): void {
  if (!stashRefPattern.test(ref) || !stashHashPattern.test(expectedHash)) {
    throw new Error('Stash 参数无效');
  }
}

async function ensureCleanWorktree(cwd: string): Promise<void> {
  const status = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.exitCode !== 0) throw new Error(status.stderr || '读取工作区状态失败');
  if (status.stdout.byteLength > 0) throw new Error('工作区不干净，应用 Stash 已阻止');
}

async function restoreDroppedEntries(cwd: string, entries: StashEntry[]): Promise<void> {
  for (const entry of entries) {
    const result = await runGit(cwd, ['stash', 'store', '--message', entry.message, entry.hash]);
    if (result.exitCode !== 0) {
      throw new Error(`Stash 列表已变化，误删条目恢复失败：${result.stderr || entry.hash}`);
    }
  }
}

function stashHashCounts(entries: StashEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.hash, (counts.get(entry.hash) ?? 0) + 1);
  return counts;
}

function entriesMissingFrom(snapshot: StashEntry[], current: StashEntry[]): StashEntry[] {
  const remainingCounts = stashHashCounts(current);
  return snapshot.filter((entry) => {
    const count = remainingCounts.get(entry.hash) ?? 0;
    if (count === 0) return true;
    remainingCounts.set(entry.hash, count - 1);
    return false;
  });
}

function entriesAddedSince(snapshot: StashEntry[], current: StashEntry[]): StashEntry[] {
  return entriesMissingFrom(current, snapshot);
}

export async function listStashes(cwd: string): Promise<StashEntry[]> {
  const result = await runGit(cwd, ['stash', 'list', '-z', '--format=%gd%x00%H%x00%gs%x00%cI']);
  if (result.exitCode !== 0) throw new Error(result.stderr || '读取 Stash 列表失败');
  const fields = result.stdout.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4 !== 0) throw new Error('读取 Stash 列表失败');

  const entries: StashEntry[] = [];
  for (let index = 0; index < fields.length; index += 4) {
    const ref = fields[index] ?? '';
    const hash = fields[index + 1] ?? '';
    const message = fields[index + 2] ?? '';
    const createdAt = fields[index + 3] ?? '';
    if (!stashRefPattern.test(ref) || !stashHashPattern.test(hash)) throw new Error('读取 Stash 列表失败');
    entries.push({ ref, hash, message, createdAt, stat: '' });
  }

  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      // `stash show` omits files saved with `--include-untracked` unless the
      // flag is repeated during inspection. Keep the UI summary honest for
      // backups that contain both tracked and untracked files; it is a no-op
      // for ordinary stashes.
      stat: await runGitText(cwd, ['stash', 'show', '--stat', '--no-color', '--include-untracked', entry.ref]).catch(() => ''),
    })),
  );
}

export async function createStash(
  cwd: string,
  message: string,
  includeUntracked: boolean,
): Promise<StashEntry> {
  const before = await listStashes(cwd);
  const status = await runGit(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    includeUntracked ? '--untracked-files=all' : '--untracked-files=no',
  ]);
  if (status.exitCode !== 0) throw new Error(status.stderr || '读取工作区状态失败');
  if (status.stdout.byteLength === 0) throw new Error('工作区没有可 Stash 的改动');

  const label = message.trim() || `Moo Fleet backup ${new Date().toISOString()}`;
  const args = ['stash', 'push', '--message', label];
  if (includeUntracked) args.push('--include-untracked');
  const result = await runGit(cwd, args, 120_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || '创建 Stash 失败');

  const after = await listStashes(cwd);
  const added = entriesAddedSince(before, after);
  if (added.length === 1) return added[0] as StashEntry;

  const labelSubject = label.split(/\r?\n/, 1)[0] ?? label;
  const matching = added.filter((entry) => entry.message.endsWith(`: ${labelSubject}`));
  if (matching.length === 1) return matching[0] as StashEntry;
  if (added.length > 0) throw new Error('Stash 已创建，但列表同时发生变化，请刷新后确认');
  throw new Error('工作区没有可 Stash 的改动');
}

export async function applyStash(cwd: string, ref: string, expectedHash: string): Promise<StashEntry> {
  ensureStashIdentity(ref, expectedHash);
  await ensureCleanWorktree(cwd);

  const currentHash = await runGitText(cwd, ['rev-parse', '--verify', ref]).catch(() => '');
  if (currentHash !== expectedHash) throw new Error('Stash 列表已变化，请刷新后重试');
  const entry = (await listStashes(cwd)).find((item) => item.ref === ref && item.hash === expectedHash);
  if (!entry) throw new Error('Stash 列表已变化，请刷新后重试');
  await ensureCleanWorktree(cwd);

  // A stash ref is positional and can be renumbered by another Git process.
  // The commit hash is the stable identity selected by the user.
  const result = await runGit(cwd, ['stash', 'apply', expectedHash], 120_000);
  if (result.exitCode !== 0) {
    throw new Error(`Stash 应用产生冲突或失败，工作区可能已部分修改：${result.stderr || '请检查 Git 状态'}`);
  }
  return entry;
}

export async function dropStash(cwd: string, ref: string, expectedHash: string): Promise<StashEntry> {
  ensureStashIdentity(ref, expectedHash);
  const currentHash = await runGitText(cwd, ['rev-parse', '--verify', ref]).catch(() => '');
  if (currentHash !== expectedHash) throw new Error('Stash 列表已变化，请刷新后重试');
  const snapshot = await listStashes(cwd);
  const entry = snapshot.find((item) => item.ref === ref && item.hash === expectedHash);
  if (!entry) throw new Error('Stash 列表已变化，请刷新后重试');

  const finalHash = await runGitText(cwd, ['rev-parse', '--verify', ref]).catch(() => '');
  if (finalHash !== expectedHash) throw new Error('Stash 列表已变化，请刷新后重试');

  const result = await runGit(cwd, ['stash', 'drop', ref]);
  if (result.exitCode !== 0) throw new Error(result.stderr || '删除 Stash 失败');

  // The ref check and `stash drop` are separate Git processes. If another
  // process inserts a Stash between them, Git can legally delete the old
  // entry at the same position. Detect that outcome and restore its commit.
  const remaining = await listStashes(cwd);
  const expectedCountBefore = snapshot.filter((item) => item.hash === expectedHash).length;
  const expectedCountAfter = remaining.filter((item) => item.hash === expectedHash).length;
  if (expectedCountAfter >= expectedCountBefore) {
    const accidentallyDropped = entriesMissingFrom(snapshot, remaining).filter((item) => item.hash !== expectedHash);
    await restoreDroppedEntries(cwd, accidentallyDropped);
    throw new Error('Stash 列表已变化，已恢复误删条目，请刷新后重试');
  }
  if (expectedCountAfter !== expectedCountBefore - 1) {
    throw new Error('Stash 列表已变化，请刷新后重试');
  }

  return entry;
}
