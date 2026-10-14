import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteRemoteBranch, deleteRemoteTag } from './remote-deletions.js';
import { createTag, pushTag } from './tags.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();
}

async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

/** 真实 bare remote + clone；故意不复用别的测试夹具，因为这里要真的联网（本地路径）。 */
async function remoteFixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  await execFileAsync('git', ['init', '--bare', '-q', path.join(root, 'remote.git')]);
  await git(root, ['clone', '-q', 'remote.git', 'work']);
  const work = path.join(root, 'work');
  await git(work, ['config', 'user.name', 'Remote Delete Test']);
  await git(work, ['config', 'user.email', 'remote-delete@example.test']);
  await writeFile(path.join(work, 'README.md'), 'base\n');
  await git(work, ['add', '.']);
  await git(work, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'base']);
  await git(work, ['branch', '-M', 'main']);
  await git(work, ['push', '-q', '-u', 'origin', 'main']);
  return { root, work };
}

/** 从另一个 clone 往同一个分支推进，用来制造「远端已经变了」。 */
async function advanceFromAnotherClone(root: string, branch: string): Promise<void> {
  await git(root, ['clone', '-q', 'remote.git', 'other']);
  const other = path.join(root, 'other');
  await git(other, ['config', 'user.name', 'Other']);
  await git(other, ['config', 'user.email', 'other@example.test']);
  await git(other, ['switch', '-q', '-c', branch, `origin/${branch}`]);
  await writeFile(path.join(other, 'other.txt'), 'other\n');
  await git(other, ['add', '.']);
  await git(other, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'pushed by someone else']);
  await git(other, ['push', '-q', 'origin', branch]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('deleteRemoteBranch', () => {
  it('deletes the remote ref with a lease match and keeps the local branch', async () => {
    const { work } = await remoteFixture('git-fleet-remote-branch-');
    await git(work, ['switch', '-q', '-c', 'feature/x', 'main']);
    await writeFile(path.join(work, 'x.txt'), 'x\n');
    await git(work, ['add', '.']);
    await git(work, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'x work']);
    const head = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['push', '-q', '-u', 'origin', 'feature/x']);

    const result = await deleteRemoteBranch(work, { remote: 'origin', branch: 'feature/x', expectedHead: head, confirmPrimary: false });
    expect(result).toEqual({ remote: 'origin', branch: 'feature/x', head });
    expect(await git(work, ['ls-remote', '--heads', 'origin'])).not.toContain('refs/heads/feature/x');
    // 本地 remote-tracking ref 被清掉，本地分支保留。
    expect(await git(work, ['branch', '--list', '--remotes'])).not.toContain('origin/feature/x');
    expect(await git(work, ['branch', '--list', 'feature/x'])).toContain('feature/x');
  });

  it('refuses when the remote moved after the snapshot', async () => {
    const { root, work } = await remoteFixture('git-fleet-remote-stale-');
    await git(work, ['switch', '-q', '-c', 'feature/stale', 'main']);
    await writeFile(path.join(work, 's.txt'), 's\n');
    await git(work, ['add', '.']);
    await git(work, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'stale work']);
    const staleHead = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['push', '-q', '-u', 'origin', 'feature/stale']);
    await advanceFromAnotherClone(root, 'feature/stale');

    const error = await rejectionOf(
      deleteRemoteBranch(work, { remote: 'origin', branch: 'feature/stale', expectedHead: staleHead, confirmPrimary: false }),
    );
    expect(error.message).toContain('已变化');
    // 远端 ref 必须原样保留。
    expect(await git(work, ['ls-remote', '--heads', 'origin'])).toContain('refs/heads/feature/stale');
  });

  it('refuses a missing remote, a missing remote branch and a primary branch without confirmation', async () => {
    const { work } = await remoteFixture('git-fleet-remote-guards-');
    const head = await git(work, ['rev-parse', 'HEAD']);
    expect((await rejectionOf(deleteRemoteBranch(work, { remote: 'nope', branch: 'main', expectedHead: head, confirmPrimary: true }))).message).toContain('缺少 remote');
    expect((await rejectionOf(deleteRemoteBranch(work, { remote: 'bad name', branch: 'main', expectedHead: head, confirmPrimary: true }))).message).toContain('名称不安全');
    expect((await rejectionOf(deleteRemoteBranch(work, { remote: 'origin', branch: 'feature/none', expectedHead: head, confirmPrimary: false }))).message).toContain('没有分支');

    const guarded = await rejectionOf(deleteRemoteBranch(work, { remote: 'origin', branch: 'main', expectedHead: head, confirmPrimary: false }));
    expect(guarded.message).toContain('主分支');
    expect(await git(work, ['ls-remote', '--heads', 'origin'])).toContain('refs/heads/main');

    // 即使显式确认，远端也会用 denyDeleteCurrent 拒掉它自己指向的分支：如实翻译这条 Git 侧保护。
    const refused = await rejectionOf(deleteRemoteBranch(work, { remote: 'origin', branch: 'main', expectedHead: head, confirmPrimary: true }));
    expect(refused.message).toContain('拒绝删除它当前指向的分支');
    expect(await git(work, ['ls-remote', '--heads', 'origin'])).toContain('refs/heads/main');
  });
});

describe('deleteRemoteTag', () => {
  it('deletes the remote tag and keeps the local one', async () => {
    const { work } = await remoteFixture('git-fleet-remote-tag-');
    const head = await git(work, ['rev-parse', 'HEAD']);
    const tag = await createTag(work, { name: 'v1.0.0', target: head, message: '' });
    await pushTag(work, 'v1.0.0', 'origin');
    expect(await git(work, ['ls-remote', '--tags', 'origin'])).toContain('refs/tags/v1.0.0');

    const removed = await deleteRemoteTag(work, 'v1.0.0', 'origin', tag.hash);
    expect(removed.name).toBe('v1.0.0');
    expect(await git(work, ['ls-remote', '--tags', 'origin'])).not.toContain('refs/tags/v1.0.0');
    expect(await git(work, ['tag', '--list', 'v1.0.0'])).toBe('v1.0.0');
  });

  it('explains a tag that only exists locally and refuses a stale hash', async () => {
    const { work } = await remoteFixture('git-fleet-remote-tag-guards-');
    const head = await git(work, ['rev-parse', 'HEAD']);
    const localOnly = await createTag(work, { name: 'v0.9.0', target: head, message: '' });
    expect((await rejectionOf(deleteRemoteTag(work, 'v0.9.0', 'origin', localOnly.hash))).message).toContain('没有标签');
    expect((await rejectionOf(deleteRemoteTag(work, 'v9.9.9', 'origin', localOnly.hash))).message).toContain('Tag 不存在');

    await pushTag(work, 'v0.9.0', 'origin');
    // 轻量标签的 hash 就是它指向的提交，所以必须换一个提交才有真正不同的 hash。
    await writeFile(path.join(work, 'later.txt'), 'later\n');
    await git(work, ['add', '.']);
    await git(work, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'later work']);
    const laterHead = await git(work, ['rev-parse', 'HEAD']);
    const wrongHash = await createTag(work, { name: 'v2.0.0', target: laterHead, message: '' });
    expect(wrongHash.hash).not.toBe(localOnly.hash);
    expect((await rejectionOf(deleteRemoteTag(work, 'v0.9.0', 'origin', wrongHash.hash))).message).toContain('已变化');
    expect(await git(work, ['ls-remote', '--tags', 'origin'])).toContain('refs/tags/v0.9.0');
  });
});
