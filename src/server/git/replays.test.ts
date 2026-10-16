import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { mergePausedErrorCode } from '../../shared/contracts.js';
import { repositoryInternalState } from './scanner.js';
import { cherryPickCommit, revertCommit } from './replays.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return output.stdout.trim();
}

interface Fixture {
  worker: string;
  repository: RepositoryConfig;
  config: RepositoriesConfig;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-replays-'));
  temporaryDirectories.push(root);
  const worker = path.join(root, 'worker');
  await execFileAsync('/usr/bin/git', ['init', '--initial-branch=master', worker]);
  await git(worker, ['config', 'user.name', 'Git Fleet Test']);
  await git(worker, ['config', 'user.email', 'git-fleet@example.test']);

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
  return { worker, repository, config };
}

/** 写文件并提交，返回新提交的 sha。 */
async function commitFile(worker: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(worker, name), content);
  await git(worker, ['add', name]);
  await git(worker, ['commit', '-m', message]);
  return git(worker, ['rev-parse', 'HEAD']);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('revertCommit', () => {
  it('反向应用一个提交：改动被抵消，产生一个新提交', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    const target = await commitFile(worker, 'b.txt', 'added\n', 'add b');
    expect(await git(worker, ['ls-files'])).toBe('a.txt\nb.txt');

    const output = await revertCommit(config, repository, worker, { hash: target });

    expect(output.kind).toBe('revert');
    expect(output.hash).not.toBe(target);
    expect(output.message).toContain('回退提交完成');
    // b.txt 被抵消
    expect(await git(worker, ['ls-files'])).toBe('a.txt');
    expect(await git(worker, ['log', '-1', '--format=%s'])).toBe('Revert "add b"');
  });

  it('短 sha 也能用（界面里显示的就是短 sha）', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    const target = await commitFile(worker, 'b.txt', 'added\n', 'add b');

    const output = await revertCommit(config, repository, worker, { hash: target.slice(0, 7) });
    expect(output.source).toBe(target);
  });

  it('找不到的提交直接拒绝', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    await expect(revertCommit(config, repository, worker, { hash: 'deadbee' })).rejects.toThrow('找不到这个提交');
  });

  it('非十六进制的标识被拒绝（不落进参数位）', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    await expect(revertCommit(config, repository, worker, { hash: 'HEAD~1' })).rejects.toThrow('提交标识无效');
  });

  it('工作区有未提交改动时拒绝，并说清该怎么做', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    const target = await commitFile(worker, 'b.txt', 'added\n', 'add b');
    await commitFile(worker, 'b.txt', 'changed\n', 'change b');

    await writeFile(path.join(worker, 'a.txt'), 'dirty\n');
    await git(worker, ['add', 'a.txt']);
    await expect(revertCommit(config, repository, worker, { hash: target })).rejects.toThrow('工作区有未提交的改动');
  });

  it('未跟踪文件不拦（git 自己能处理，不该变成硬门槛）', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    const target = await commitFile(worker, 'b.txt', 'added\n', 'add b');
    await writeFile(path.join(worker, 'untracked.txt'), 'x\n');

    const output = await revertCommit(config, repository, worker, { hash: target });
    expect(output.hash).toBeTruthy();
    expect(await git(worker, ['ls-files', '--others', '--exclude-standard'])).toBe('untracked.txt');
  });

  it('冲突时暂停：抛带 mergePausedErrorCode 的错误，并留下进行中标记', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    const target = await commitFile(worker, 'a.txt', 'two\n', 'make two');
    await commitFile(worker, 'a.txt', 'three\n', 'make three');

    const error = await revertCommit(config, repository, worker, { hash: target }).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(mergePausedErrorCode);
    expect((error as Error).message).toContain('回退提交（revert）已暂停');
    // 暂停态交给既有的继续 / 中止链路
    expect((await repositoryInternalState(worker)).operation).toBe('revert');
  });

  it('仓库配置禁止提交时拒绝', async () => {
    const { worker, repository, config } = await fixture();
    const target = await commitFile(worker, 'a.txt', 'one\n', 'first');
    const locked = { ...repository, capabilities: { ...repository.capabilities, commit: false } };
    await expect(revertCommit({ ...config, repositories: [locked] }, locked, worker, { hash: target })).rejects.toThrow(
      '禁止提交',
    );
  });

  it('尚无提交的仓库拒绝', async () => {
    const { worker, repository, config } = await fixture();
    await expect(revertCommit(config, repository, worker, { hash: 'abcdef0' })).rejects.toThrow('还没有任何提交');
  });
});

describe('cherryPickCommit', () => {
  it('把另一个分支的提交搬到当前分支', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'one\n', 'first');
    await git(worker, ['checkout', '-b', 'feature']);
    const picked = await commitFile(worker, 'feature.txt', 'from feature\n', 'feature work');
    await git(worker, ['checkout', 'master']);
    // 让 master 先前进一格。若两边父提交相同，拣选出来的提交内容/父提交/时间戳完全一致，
    // git 会算出**同一个 hash**——那样就测不出「产生了新提交」这件事了。
    await commitFile(worker, 'main.txt', 'from main\n', 'main work');

    const output = await cherryPickCommit(config, repository, worker, { hash: picked });

    expect(output.kind).toBe('cherry-pick');
    expect(output.message).toContain('拣选提交完成');
    expect(await git(worker, ['show', '--name-only', '--format=', 'HEAD'])).toBe('feature.txt');
    expect(output.hash).not.toBe(picked);
    expect(await git(worker, ['rev-list', '--count', 'HEAD'])).toBe('3');
  });

  it('冲突时暂停，进行中标记为 cherry-pick', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'base\n', 'base');
    await git(worker, ['checkout', '-b', 'feature']);
    const picked = await commitFile(worker, 'a.txt', 'from feature\n', 'feature change');
    await git(worker, ['checkout', 'master']);
    await commitFile(worker, 'a.txt', 'from master\n', 'master change');

    const error = await cherryPickCommit(config, repository, worker, { hash: picked }).catch((thrown) => thrown);
    expect((error as { code?: string }).code).toBe(mergePausedErrorCode);
    expect((error as Error).message).toContain('拣选提交（cherry-pick）已暂停');
    expect((await repositoryInternalState(worker)).operation).toBe('cherry-pick');
  });

  it('已有进行中的操作时拒绝再发起', async () => {
    const { worker, repository, config } = await fixture();
    await commitFile(worker, 'a.txt', 'base\n', 'base');
    await git(worker, ['checkout', '-b', 'feature']);
    const picked = await commitFile(worker, 'a.txt', 'from feature\n', 'feature change');
    await git(worker, ['checkout', 'master']);
    await commitFile(worker, 'a.txt', 'from master\n', 'master change');

    // 第一次冲突暂停，第二次发起必须被前置校验挡住（不是又叠一层）
    await expect(cherryPickCommit(config, repository, worker, { hash: picked })).rejects.toThrow('已暂停');
    await expect(cherryPickCommit(config, repository, worker, { hash: picked })).rejects.toThrow('进行中的 Git 操作');
  });
});
