import type { StashEntry } from '../../shared/contracts.js';
import { runGit, runGitText } from './runner.js';

const stashRefPattern = /^stash@\{\d+\}$/;
const stashHashPattern = /^[a-f0-9]{40,64}$/;

function ensureStashIdentity(ref: string, expectedHash: string): void {
  if (!stashRefPattern.test(ref) || !stashHashPattern.test(expectedHash)) {
    throw new Error('Stash 参数无效');
  }
}

export async function listStashes(cwd: string): Promise<StashEntry[]> {
  const output = await runGitText(cwd, ['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%cI%x1e']);
  const entries = output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [ref = '', hash = '', message = '', createdAt = ''] = record.split('\x1f');
      if (!stashRefPattern.test(ref) || !stashHashPattern.test(hash)) throw new Error('读取 Stash 列表失败');
      return { ref, hash, message, createdAt, stat: '' };
    });

  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      stat: await runGitText(cwd, ['stash', 'show', '--stat', '--no-color', entry.ref]).catch(() => ''),
    })),
  );
}

export async function createStash(
  cwd: string,
  message: string,
  includeUntracked: boolean,
): Promise<StashEntry> {
  const before = (await listStashes(cwd))[0]?.hash ?? null;
  const status = await runGit(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    includeUntracked ? '--untracked-files=all' : '--untracked-files=no',
  ]);
  if (status.exitCode !== 0) throw new Error(status.stderr || '读取工作区状态失败');
  if (status.stdout.byteLength === 0) throw new Error('工作区没有可 Stash 的改动');

  const label = message.trim() || `Git Fleet backup ${new Date().toISOString()}`;
  const args = ['stash', 'push', '--message', label];
  if (includeUntracked) args.push('--include-untracked');
  const result = await runGit(cwd, args, 120_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || '创建 Stash 失败');

  const created = (await listStashes(cwd))[0];
  if (!created || created.hash === before) throw new Error('工作区没有可 Stash 的改动');
  return created;
}

export async function applyStash(cwd: string, ref: string, expectedHash: string): Promise<StashEntry> {
  ensureStashIdentity(ref, expectedHash);
  const status = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.exitCode !== 0) throw new Error(status.stderr || '读取工作区状态失败');
  if (status.stdout.byteLength > 0) throw new Error('工作区不干净，应用 Stash 已阻止');

  const currentHash = await runGitText(cwd, ['rev-parse', '--verify', ref]).catch(() => '');
  if (currentHash !== expectedHash) throw new Error('Stash 列表已变化，请刷新后重试');
  const entry = (await listStashes(cwd)).find((item) => item.ref === ref && item.hash === expectedHash);
  if (!entry) throw new Error('Stash 列表已变化，请刷新后重试');

  const result = await runGit(cwd, ['stash', 'apply', ref], 120_000);
  if (result.exitCode !== 0) {
    throw new Error(`Stash 应用产生冲突或失败，工作区可能已部分修改：${result.stderr || '请检查 Git 状态'}`);
  }
  return entry;
}

export async function dropStash(cwd: string, ref: string, expectedHash: string): Promise<StashEntry> {
  ensureStashIdentity(ref, expectedHash);
  const currentHash = await runGitText(cwd, ['rev-parse', '--verify', ref]).catch(() => '');
  if (currentHash !== expectedHash) throw new Error('Stash 列表已变化，请刷新后重试');
  const entry = (await listStashes(cwd)).find((item) => item.ref === ref && item.hash === expectedHash);
  if (!entry) throw new Error('Stash 列表已变化，请刷新后重试');

  const result = await runGit(cwd, ['stash', 'drop', ref]);
  if (result.exitCode !== 0) throw new Error(result.stderr || '删除 Stash 失败');
  return entry;
}
