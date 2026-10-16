import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { amendCommit, readLastCommitSnapshot, undoLastCommit } from './rewrite.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

interface Fixture {
  root: string;
  worker: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
}

/** `commits` 个提交就绪的仓库；传 0 得到「尚无提交」的空仓库。 */
async function fixture(commits = 1): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-rewrite-'));
  temporaryDirectories.push(root);
  const worker = path.join(root, 'worker');
  await execFileAsync('/usr/bin/git', ['init', '--initial-branch=master', worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);
  for (let index = 0; index < commits; index += 1) {
    await writeFile(path.join(worker, `file-${index}.txt`), `${index}\n`);
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', `commit ${index}`]);
  }

  const repository: RepositoryConfig = {
    id: 'worker-test',
    name: 'worker',
    root: 'test',
    path: 'worker',
    group: 'tests',
    enabled: true,
    pinned: false,
    order: 10,
    tags: [],
    aiCommitPolicy: 'disabled',
    capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
  };
  const config: RepositoriesConfig = {
    version: 1,
    settings: {
      roots: { test: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [repository],
  };
  return { root, worker, repository, config };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('readLastCommitSnapshot', () => {
  it('空仓库给出可操作的原因，而不是一个空对象', async () => {
    const { worker, repository, config } = await fixture(0);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);

    expect(snapshot.commit).toBeNull();
    expect(snapshot.blocked).toBe('仓库还没有任何提交');
    // 指纹仍然要给出：界面用它做后续一致性校验
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('报告提交信息、暂存文件数与是否已推送', async () => {
    const { worker, repository, config } = await fixture(1);
    await writeFile(path.join(worker, 'staged.txt'), 'x\n');
    await git(worker, ['add', 'staged.txt']);

    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    expect(snapshot.commit).toMatchObject({
      subject: 'commit 0',
      pushed: 'no',
      pushedRef: null,
      merge: false,
      hasParent: false,
    });
    expect(snapshot.stagedCount).toBe(1);
    expect(snapshot.blocked).toBeNull();
  });

  it('提交已存在于远端跟踪引用上时报 pushed=yes 并给出出处', async () => {
    const { worker, repository, config } = await fixture(2);
    const head = await git(worker, ['rev-parse', 'HEAD']);
    await git(worker, ['update-ref', 'refs/remotes/origin/master', head]);

    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    expect(snapshot.commit?.pushed).toBe('yes');
    expect(snapshot.commit?.pushedRef).toBe('refs/remotes/origin/master');
  });

  it('合并提交被标出来，且 hasParent 为真', async () => {
    const { worker, repository, config } = await fixture(1);
    await git(worker, ['checkout', '-b', 'side']);
    await writeFile(path.join(worker, 'side.txt'), 's\n');
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', 'side']);
    await git(worker, ['checkout', 'master']);
    await writeFile(path.join(worker, 'main.txt'), 'm\n');
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', 'main']);
    await git(worker, ['merge', '--no-ff', 'side', '-m', 'merge side']);

    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    expect(snapshot.commit).toMatchObject({ merge: true, hasParent: true });
  });

  it('进行中的 Git 操作会挡住改写', async () => {
    const { worker, repository, config } = await fixture(1);
    // 直接放一个 MERGE_HEAD 标记：scanner 以此判定「合并进行中」。
    await writeFile(path.join(worker, '.git', 'MERGE_HEAD'), `${await git(worker, ['rev-parse', 'HEAD'])}\n`);

    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    expect(snapshot.blocked).toContain('进行中的 Git 操作');
  });
});

describe('amendCommit', () => {
  it('只改文案时内容与父提交都不变', async () => {
    const { worker, repository, config } = await fixture(2);
    const before = await readLastCommitSnapshot(config, repository, worker);
    const previousHash = before.commit!.hash;
    // 注意只取父提交：`rev-list --parents` 的第一个字段是 HEAD 自己，amend 后必然变。
    const previousParents = (await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ').slice(1).join(' ');
    const treeBefore = await git(worker, ['write-tree']);

    const output = await amendCommit(config, repository, worker, {
      message: '改过的文案',
      fingerprint: before.fingerprint,
    });

    expect(output.consistent).toBe(true);
    expect(output.hash).not.toBe(previousHash);
    expect(await git(worker, ['log', '-1', '--format=%s'])).toBe('改过的文案');
    // 父提交不变：只改这一个提交，没有顺带改写历史
    const nextParents = (await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ').slice(1).join(' ');
    expect(nextParents).toBe(previousParents);
    expect(await git(worker, ['write-tree'])).toBe(treeBefore);
    expect(await git(worker, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('把已暂存的内容并入上次提交', async () => {
    const { worker, repository, config } = await fixture(1);
    await writeFile(path.join(worker, 'added.txt'), 'new\n');
    await git(worker, ['add', 'added.txt']);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    expect(snapshot.stagedCount).toBe(1);

    const output = await amendCommit(config, repository, worker, {
      message: 'commit 0 + added',
      fingerprint: snapshot.fingerprint,
    });

    expect(output.consistent).toBe(true);
    // 文件确实进了新提交，而提交数没有增加
    expect(await git(worker, ['show', '--name-only', '--format=', 'HEAD'])).toContain('added.txt');
    expect(await git(worker, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(await git(worker, ['status', '--porcelain'])).toBe('');
  });

  it('指纹不符时拒绝，且 HEAD 一动不动', async () => {
    const { worker, repository, config } = await fixture(1);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    // 期间 HEAD 被换过（例如另一个窗口又提交了一次）：指纹必须失效
    await writeFile(path.join(worker, 'other.txt'), 'o\n');
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', 'another commit']);
    const headNow = await git(worker, ['rev-parse', 'HEAD']);

    await expect(
      amendCommit(config, repository, worker, { message: 'x', fingerprint: snapshot.fingerprint }),
    ).rejects.toThrow('已变化');
    // 拒绝后什么都没有发生：新提交还在，也没有被改写
    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(headNow);
    expect(await git(worker, ['log', '-1', '--format=%s'])).toBe('another commit');
  });

  it('指纹只管 HEAD：期间新增的暂存内容不会让改写失效', async () => {
    const { worker, repository, config } = await fixture(1);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    // 「先暂存、再修正」是正常顺序，不能因为这个顺序就报「已变化」
    await writeFile(path.join(worker, 'late.txt'), 'late\n');
    await git(worker, ['add', 'late.txt']);

    const output = await amendCommit(config, repository, worker, { message: 'x', fingerprint: snapshot.fingerprint });

    expect(output.consistent).toBe(true);
    expect(await git(worker, ['show', '--name-only', '--format=', 'HEAD'])).toContain('late.txt');
  });

  it('合并提交允许修正，且保留两个父提交（实测 git 的既定行为）', async () => {
    const { worker, repository, config } = await fixture(1);
    await git(worker, ['checkout', '-b', 'side']);
    await writeFile(path.join(worker, 'side.txt'), 's\n');
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', 'side']);
    await git(worker, ['checkout', 'master']);
    await writeFile(path.join(worker, 'main.txt'), 'm\n');
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', 'main']);
    await git(worker, ['merge', '--no-ff', 'side', '-m', 'merge side']);

    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    expect(snapshot.commit?.merge).toBe(true);
    const output = await amendCommit(config, repository, worker, {
      message: 'merge side (fixed)',
      fingerprint: snapshot.fingerprint,
    });

    expect(output.consistent).toBe(true);
    expect((await git(worker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ').length).toBe(3);
  });

  it('hook 改动暂存区时如实报出「不一致」，而不是假装成功', async () => {
    const { worker, repository, config } = await fixture(1);
    // post-commit 钩子在提交之后往暂存区塞一个文件：新提交的树就不再等于 write-tree，
    // 这正是「内容与预期不符」的真实来源（与 commitStaged 的 treeMatches 同一个思路）。
    const hook = path.join(worker, '.git', 'hooks', 'post-commit');
    await writeFile(hook, '#!/bin/sh\necho hook > hook.txt\ngit add hook.txt\n', { mode: 0o755 });
    const snapshot = await readLastCommitSnapshot(config, repository, worker);

    const output = await amendCommit(config, repository, worker, { message: 'x', fingerprint: snapshot.fingerprint });

    expect(output.consistent).toBe(false);
    expect(output.message).toContain('⚠');
    expect(output.message).toContain('暂存内容未被完整写入');
  });

  it('没有提交的仓库直接拒绝', async () => {
    const { worker, repository, config } = await fixture(0);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    await expect(
      amendCommit(config, repository, worker, { message: 'x', fingerprint: snapshot.fingerprint }),
    ).rejects.toThrow('还没有任何提交');
  });
});

describe('undoLastCommit', () => {
  it('撤销后 HEAD 回到上一个提交，改动全部留在暂存区', async () => {
    const { worker, repository, config } = await fixture(2);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    const treeBefore = await git(worker, ['write-tree']);
    const expected = await git(worker, ['rev-parse', 'HEAD~1']);

    const output = await undoLastCommit(config, repository, worker, { fingerprint: snapshot.fingerprint });

    expect(output.consistent).toBe(true);
    expect(output.hash).toBe(expected);
    expect(await git(worker, ['log', '-1', '--format=%s'])).toBe('commit 0');
    // 唯一可验证的不变量：暂存区原封不动，内容一点没丢
    expect(await git(worker, ['write-tree'])).toBe(treeBefore);
    expect(await git(worker, ['status', '--porcelain'])).toBe('A  file-1.txt');
  });

  it('撤销第一个提交后回到「尚无提交」，索引同样不动', async () => {
    const { worker, repository, config } = await fixture(1);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    const treeBefore = await git(worker, ['write-tree']);

    const output = await undoLastCommit(config, repository, worker, { fingerprint: snapshot.fingerprint });

    expect(output.consistent).toBe(true);
    expect(output.hash).toBeNull();
    expect(await git(worker, ['write-tree'])).toBe(treeBefore);
    expect(await git(worker, ['status', '--porcelain'])).toBe('A  file-0.txt');
    const after = await readLastCommitSnapshot(config, repository, worker);
    expect(after.commit).toBeNull();
  });

  it('指纹不符时拒绝，提交仍在', async () => {
    const { worker, repository, config } = await fixture(2);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    // 期间 HEAD 被换过：撤销必须拒绝，否则会撤销掉另一个提交
    await writeFile(path.join(worker, 'other.txt'), 'o\n');
    await git(worker, ['add', '.']);
    await git(worker, ['commit', '-m', 'another commit']);
    const headNow = await git(worker, ['rev-parse', 'HEAD']);

    await expect(undoLastCommit(config, repository, worker, { fingerprint: snapshot.fingerprint })).rejects.toThrow(
      '已变化',
    );
    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(headNow);
  });

  it('进行中的 Git 操作会挡住撤销', async () => {
    const { worker, repository, config } = await fixture(1);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    await writeFile(path.join(worker, '.git', 'MERGE_HEAD'), `${snapshot.commit!.hash}\n`);

    await expect(undoLastCommit(config, repository, worker, { fingerprint: snapshot.fingerprint })).rejects.toThrow(
      '进行中的 Git 操作',
    );
    expect(await git(worker, ['rev-parse', 'HEAD'])).toBe(snapshot.commit!.hash);
  });

  it('返回被撤销提交的推送状态，供界面说明影响面', async () => {
    const { worker, repository, config } = await fixture(1);
    const head = await git(worker, ['rev-parse', 'HEAD']);
    await git(worker, ['update-ref', 'refs/remotes/origin/master', head]);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);

    const output = await undoLastCommit(config, repository, worker, { fingerprint: snapshot.fingerprint });
    expect(output.pushed).toBe('yes');
    expect(output.pushedRef).toBe('refs/remotes/origin/master');
  });

  it('空仓库直接拒绝', async () => {
    const { worker, repository, config } = await fixture(0);
    const snapshot = await readLastCommitSnapshot(config, repository, worker);
    await expect(undoLastCommit(config, repository, worker, { fingerprint: snapshot.fingerprint })).rejects.toThrow(
      '还没有任何提交',
    );
  });

  it('仓库配置禁止提交时，修正与撤销都拒绝', async () => {
    const { worker, repository, config } = await fixture(2);
    const locked: RepositoryConfig = {
      ...repository,
      capabilities: { ...repository.capabilities, commit: false },
    };
    const lockedConfig: RepositoriesConfig = { ...config, repositories: [locked] };
    const snapshot = await readLastCommitSnapshot(lockedConfig, locked, worker);
    // 快照要把原因给出来，界面才能禁用按钮；而不是让用户点下去才被拒
    expect(snapshot.blocked).toContain('禁止提交');
    await expect(
      amendCommit(lockedConfig, locked, worker, { message: 'x', fingerprint: snapshot.fingerprint }),
    ).rejects.toThrow('禁止提交');
    await expect(undoLastCommit(lockedConfig, locked, worker, { fingerprint: snapshot.fingerprint })).rejects.toThrow(
      '禁止提交',
    );
    expect(await git(worker, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });
});
