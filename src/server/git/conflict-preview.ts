import { createHash } from 'node:crypto';
import type { ConflictPreview, ConflictSide } from '../../shared/contracts.js';
import { conflictError } from '../errors.js';
import { safeRepositoryPath } from './files.js';
import { readBlobText } from './revision-files.js';
import { runGit } from './runner.js';
import { repositoryInternalState } from './scanner.js';

async function conflictSnapshot(cwd: string, path: string) {
  safeRepositoryPath(cwd, path);
  const [index, state, headResult, branchResult, ...targets] = await Promise.all([
    runGit(cwd, ['--literal-pathspecs', 'ls-files', '--unmerged', '-z', '--', path]),
    repositoryInternalState(cwd),
    runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    ...['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(ref => runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])),
  ]);
  if (index.exitCode !== 0) throw new Error('读取冲突版本失败');
  const entries = index.stdout.toString('utf8').split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t'), match = row.slice(0, tab).match(/^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])$/);
    if (tab < 0 || !match || row.slice(tab + 1) !== path) throw new Error('冲突文件身份无效');
    return { mode: match[1]!, objectId: match[2]!, stage: Number(match[3]) as 1 | 2 | 3 };
  });
  if (!entries.length) throw conflictError('该文件当前没有未解决的冲突，请刷新后重试');
  const head = headResult.exitCode === 0 ? headResult.stdout.toString('utf8').trim() : null;
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString('utf8').trim() : 'HEAD';
  const commits = targets.map(result => result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null);
  const fingerprint = createHash('sha256').update(JSON.stringify([path, index.stdout.toString('utf8'), head, branch, state.operation, commits])).digest('hex');
  return { entries, head, branch, commits, operation: state.operation, fingerprint };
}

export async function assertConflictFingerprint(cwd: string, path: string, expected: string): Promise<void> {
  if ((await conflictSnapshot(cwd, path)).fingerprint !== expected) throw conflictError('冲突版本或操作已变化，请重新预览后选择');
}

export async function readConflictPreview(cwd: string, path: string): Promise<ConflictPreview> {
  const snapshot = await conflictSnapshot(cwd, path);
  const { operation, head, branch, commits } = snapshot;
  const target = operation === 'merge' ? commits[0] : operation === 'rebase' ? commits[1] : operation === 'cherry-pick' ? commits[2] : operation === 'revert' ? commits[3] : null;
  let revertedParent: string | null = null;
  if (operation === 'revert' && target) {
    const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${target}^`]);
    if (result.exitCode === 0) revertedParent = result.stdout.toString('utf8').trim();
  }
  const descriptions: Array<Pick<ConflictSide, 'stage' | 'label' | 'source' | 'commit'>> = [
    { stage: 1, label: '基线', source: operation === 'revert' ? '被回退提交的版本' : 'Git 保存的共同基线', commit: operation === 'revert' ? target : null },
    { stage: 2, label: operation === 'rebase' ? '基准与已重放内容' : '当前一侧', source: operation === 'rebase' ? 'Git ours · rebase 的接收端与已应用提交' : `Git ours · ${branch}`, commit: head },
    { stage: 3, label: operation === 'rebase' ? '正在重放的提交' : operation === 'revert' ? '回退后的版本' : '合入一侧', source: operation === 'rebase' ? 'Git theirs · 当前重放提交' : operation === 'revert' ? 'Git theirs · 回退目标的父版本' : operation === 'cherry-pick' ? 'Git theirs · 当前选取提交' : 'Git theirs · 合并来源', commit: operation === 'revert' ? revertedParent : target },
  ];
  const sides = await Promise.all(descriptions.map(async side => {
    const entry = snapshot.entries.find(entry => entry.stage === side.stage);
    // Gitlinks are identities of submodule commits, not blobs in this repository.
    const file = !entry ? null : entry.mode === '160000' ? { objectId: entry.objectId, content: null, size: 0, binary: false, truncated: false } : await readBlobText(cwd, entry.objectId);
    return { ...side, mode: entry?.mode ?? null, file };
  }));
  await assertConflictFingerprint(cwd, path, snapshot.fingerprint);
  return { path, operation, fingerprint: snapshot.fingerprint, sides,
    note: operation === 'rebase' ? 'rebase 中 ours 是接收基准，theirs 是正在重放的工作提交；它们与日常“我的分支／他人的分支”并不对应。' : operation === 'revert' ? 'revert 正在反向应用目标提交；右侧表示回退后的版本。' : '内容来自 Git index 的固定版本。不存在的版本通常表示该侧删除了文件。' };
}
