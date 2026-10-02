import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortRepositoryOperation,
  continueRepositoryOperation,
  parseUnmergedEntries,
  resolveConflictFile,
} from './conflicts.js';
import { readConflictPreview } from './conflict-preview.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 建一个「master 与 side 改同一行」的仓库并真的触发一次 merge 冲突。 */
async function conflictFixture(
  prefix: string,
): Promise<{ root: string; repository: string; masterHead: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'repository');
  await execFileAsync('git', ['init', '--initial-branch=master', repository]);
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(repository, 'app.txt'), 'base\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);

  await git(repository, ['switch', '-c', 'side']);
  await writeFile(path.join(repository, 'app.txt'), 'side\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'side change']);

  await git(repository, ['switch', 'master']);
  await writeFile(path.join(repository, 'app.txt'), 'ours\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'ours change']);
  const masterHead = await gitText(repository, ['rev-parse', 'HEAD']);

  // `git merge` 在冲突时退出码为 1，这里必须容忍失败。
  await execFileAsync('git', ['-C', repository, 'merge', 'side']).catch(() => undefined);
  return { root, repository, masterHead };
}

async function cleanFixture(prefix: string): Promise<{ repository: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'repository');
  await execFileAsync('git', ['init', '--initial-branch=master', repository]);
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(repository, 'app.txt'), 'base\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);
  return { repository };
}

describe('parseUnmergedEntries', () => {
  it('keeps only unmerged records and skips rename original paths', () => {
    const output = Buffer.from('UU app.txt\0M  other.txt\0R  new.txt\0old.txt\0AA both.txt\0');
    expect(parseUnmergedEntries(output)).toEqual([
      { path: 'app.txt', status: 'UU' },
      { path: 'both.txt', status: 'AA' },
    ]);
  });
});

describe('resolveConflictFile', () => {
  it('takes our side and stages only the target file', async () => {
    const { repository } = await conflictFixture('git-fleet-conflict-ours-');
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toContain('<<<<<<<');

    const ours = await resolveConflictFile(repository, 'app.txt', 'ours');
    expect(ours).toEqual({ action: 'ours', path: 'app.txt' });
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe('ours\n');
    // 「取我方」后内容与 HEAD 一致，因此相对 HEAD 没有差异；关键是它已不再是 unmerged。
    expect(await gitText(repository, ['status', '--porcelain', '--', 'app.txt'])).toBe('');

    // 已解决的文件不再是 unmerged，重复操作必须被拒绝。
    await expect(resolveConflictFile(repository, 'app.txt', 'theirs')).rejects.toThrow('没有未解决的冲突');
  });

  it('takes their side', async () => {
    const { repository } = await conflictFixture('git-fleet-conflict-theirs-');
    const theirs = await resolveConflictFile(repository, 'app.txt', 'theirs');
    expect(theirs).toEqual({ action: 'theirs', path: 'app.txt' });
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe('side\n');
    expect(await gitText(repository, ['status', '--porcelain', '--', 'app.txt'])).toBe('M  app.txt');
  });

  it('refuses to mark a file resolved while conflict markers remain', async () => {
    const { repository } = await conflictFixture('git-fleet-conflict-mark-');
    await expect(resolveConflictFile(repository, 'app.txt', 'mark-resolved')).rejects.toThrow('仍有冲突标记');

    await writeFile(path.join(repository, 'app.txt'), 'manual resolution\n');
    const result = await resolveConflictFile(repository, 'app.txt', 'mark-resolved');
    expect(result).toEqual({ action: 'mark-resolved', path: 'app.txt' });
    expect(await gitText(repository, ['status', '--porcelain', '--', 'app.txt'])).toBe('M  app.txt');
  });

  it('restores conflict markers for a file that is still unmerged', async () => {
    const { repository } = await conflictFixture('git-fleet-conflict-restore-');
    await writeFile(path.join(repository, 'app.txt'), 'manual edit without markers\n');
    const result = await resolveConflictFile(repository, 'app.txt', 'restore');
    expect(result).toEqual({ action: 'restore', path: 'app.txt' });
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('rejects non-conflicted, missing and escaping paths', async () => {
    const { repository } = await conflictFixture('git-fleet-conflict-reject-');
    await writeFile(path.join(repository, 'clean.txt'), 'x\n');
    await git(repository, ['add', 'clean.txt']);

    await expect(resolveConflictFile(repository, 'clean.txt', 'ours')).rejects.toThrow('没有未解决的冲突');
    await expect(resolveConflictFile(repository, 'missing.txt', 'ours')).rejects.toThrow('没有未解决的冲突');
    await expect(resolveConflictFile(repository, '../outside.txt', 'ours')).rejects.toThrow('Git 文件路径不安全');
  });
});

describe('continueRepositoryOperation', () => {
  it('refuses while conflicts remain, then completes the merge', async () => {
    const { repository } = await conflictFixture('git-fleet-conflict-continue-');
    await expect(continueRepositoryOperation(repository)).rejects.toThrow('未解决冲突');

    await resolveConflictFile(repository, 'app.txt', 'ours');
    expect(await continueRepositoryOperation(repository)).toBe('merge');
    expect(await gitText(repository, ['status', '--porcelain'])).toBe('');
    // base + side + ours + merge = 4
    expect(await gitText(repository, ['rev-list', '--count', 'HEAD'])).toBe('4');
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe('ours\n');
  });

  it('rejects when no operation is in progress', async () => {
    const { repository } = await cleanFixture('git-fleet-conflict-none-');
    await expect(continueRepositoryOperation(repository)).rejects.toThrow('没有进行中的 Git 操作');
    await expect(abortRepositoryOperation(repository)).rejects.toThrow('没有进行中的 Git 操作');
  });
});

describe('abortRepositoryOperation', () => {
  it('discards the local resolution and returns to the pre-merge state', async () => {
    const { repository, masterHead } = await conflictFixture('git-fleet-conflict-abort-');
    await resolveConflictFile(repository, 'app.txt', 'theirs');
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe('side\n');

    expect(await abortRepositoryOperation(repository)).toBe('merge');
    // 回到合并前的 master tip，而不是产生任何新提交。
    expect(await gitText(repository, ['rev-parse', 'HEAD'])).toBe(masterHead);
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe('ours\n');
    expect(await gitText(repository, ['status', '--porcelain'])).toBe('');
    expect(await gitText(repository, ['branch', '--show-current'])).toBe('master');
  });
});

describe('conflict preview', () => {
  it('reads three fixed versions and rejects changed index identities before resolution', async () => {
    const { repository } = await conflictFixture('fleet-conflict-preview-');
    const before = await gitText(repository, ['ls-files', '--stage']); const content = await readFile(path.join(repository, 'app.txt'), 'utf8');
    const preview = await readConflictPreview(repository, 'app.txt');
    expect(preview.operation).toBe('merge'); expect(preview.sides.map(side => side.file?.content)).toEqual(['base\n', 'ours\n', 'side\n']);
    expect(await gitText(repository, ['ls-files', '--stage'])).toBe(before); expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe(content);
    // Move HEAD without changing the unmerged files; the old preview is no longer valid.
    const parent = await gitText(repository, ['rev-parse', 'HEAD^']); await git(repository, ['update-ref', 'HEAD', parent]);
    await expect(resolveConflictFile(repository, 'app.txt', 'theirs', preview.fingerprint)).rejects.toThrow('已变化');
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe(content);
    const latest = await readConflictPreview(repository, 'app.txt'); await resolveConflictFile(repository, 'app.txt', 'theirs', latest.fingerprint);
    expect(await readFile(path.join(repository, 'app.txt'), 'utf8')).toBe('side\n');
    await expect(readConflictPreview(repository, 'app.txt')).rejects.toThrow('没有未解决');
  });
  it.each(['rebase', 'cherry-pick', 'revert'] as const)('describes %s sides using actual index semantics', async operation => {
    const { repository, masterHead } = await conflictFixture(`fleet-preview-${operation}-`); await abortRepositoryOperation(repository);
    if (operation === 'rebase') { await git(repository, ['switch', 'side']); await execFileAsync('git', ['-C', repository, 'rebase', 'master']).catch(() => undefined); }
    else if (operation === 'cherry-pick') await execFileAsync('git', ['-C', repository, 'cherry-pick', 'side']).catch(() => undefined);
    else { await writeFile(path.join(repository, 'app.txt'), 'later\n'); await git(repository, ['add', '.']); await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'later']); await execFileAsync('git', ['-C', repository, 'revert', masterHead]).catch(() => undefined); }
    const preview = await readConflictPreview(repository, 'app.txt'); expect(preview.operation).toBe(operation);
    if (operation === 'rebase') { expect(preview.sides[1]?.label).toBe('基准与已重放内容'); expect(preview.sides[1]?.file?.content).toBe('ours\n'); expect(preview.sides[2]?.label).toBe('正在重放的提交'); expect(preview.sides[2]?.file?.content).toBe('side\n'); }
    if (operation === 'cherry-pick') { expect(preview.sides[2]?.source).toContain('选取提交'); expect(preview.sides[2]?.file?.content).toBe('side\n'); }
    if (operation === 'revert') { expect(preview.sides[0]?.file?.content).toBe('ours\n'); expect(preview.sides[1]?.file?.content).toBe('later\n'); expect(preview.sides[2]?.file?.content).toBe('base\n'); }
  });
  it('represents a deleted side as absent rather than an empty file', async () => {
    const { repository } = await conflictFixture('fleet-conflict-delete-'); await abortRepositoryOperation(repository); await git(repository, ['switch', 'side']); await git(repository, ['rm', 'app.txt']); await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'delete']); await git(repository, ['switch', 'master']); await execFileAsync('git', ['-C', repository, 'merge', 'side']).catch(() => undefined);
    const preview = await readConflictPreview(repository, 'app.txt'); expect(preview.sides[2]).toMatchObject({ file: null, mode: null }); expect(preview.sides[1]?.file?.content).toBe('ours\n');
  });
});
