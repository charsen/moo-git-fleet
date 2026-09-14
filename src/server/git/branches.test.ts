import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  listBranches,
  parseBranchRefs,
  parseWorktreePorcelain,
  renameBranch,
  repositoryCommonDir,
  switchBranch,
} from './branches.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
}

/** 建一个带首个 Commit 的仓库，返回目录与 HEAD。 */
async function createRepositoryFixture(prefix: string): Promise<{ root: string; repository: string; head: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'repository');
  await execFileAsync('git', ['init', '--initial-branch=master', repository]);
  await git(repository, ['config', 'user.name', 'Git Fleet Test']);
  await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(repository, 'README.md'), 'initial\n');
  await git(repository, ['add', 'README.md']);
  await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
  return { root, repository, head: await git(repository, ['rev-parse', 'HEAD']) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('branch and Worktree parsers', () => {
  it('parses stable NUL-delimited branch fields', () => {
    const output = Buffer.from(
      'refs/heads/feature/example\0abc123\0origin/feature/example\nrefs/heads/master\0def456\0\n',
    );
    expect(parseBranchRefs(output)).toEqual([
      { name: 'feature/example', head: 'abc123', upstream: 'origin/feature/example' },
      { name: 'master', head: 'def456', upstream: null },
    ]);
  });

  it('parses attached, detached and prunable Worktree records', () => {
    const output = Buffer.from(
      'worktree /repo/main\0HEAD abc123\0branch refs/heads/master\0\0' +
        'worktree /repo/detached\0HEAD def456\0detached\0\0' +
        'worktree /repo/stale\0HEAD fedcba\0branch refs/heads/feature/stale\0prunable gitdir file points to missing location\0\0',
    );
    expect(parseWorktreePorcelain(output, '/repo/main')).toEqual([
      { path: '/repo/main', head: 'abc123', branch: 'master', current: true, prunable: false },
      { path: '/repo/detached', head: 'def456', branch: null, current: false, prunable: false },
      { path: '/repo/stale', head: 'fedcba', branch: 'feature/stale', current: false, prunable: true },
    ]);
  });
});

describe('listBranches', () => {
  it('returns an unborn branch snapshot before the first commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-unborn-branch-'));
    temporaryDirectories.push(root);
    const repository = path.join(root, 'repository');
    await execFileAsync('git', ['init', '--initial-branch=main', repository]);

    const snapshot = await listBranches(repository);
    expect(snapshot).toMatchObject({ currentBranch: 'main', head: '', branches: [] });
    expect(snapshot.worktrees).toContainEqual(
      expect.objectContaining({ path: await realpath(repository), branch: 'main', current: true }),
    );
  });

  it('reports local branches, divergence, detached state and Worktree occupancy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-branches-'));
    temporaryDirectories.push(root);
    const repository = path.join(root, 'repository');
    const linkedWorktree = path.join(root, 'feature-worktree');
    await execFileAsync('git', ['init', '--initial-branch=master', repository]);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(repository, ['branch', 'feature/linked']);
    await git(repository, ['branch', 'feature/free']);
    await git(repository, ['worktree', 'add', linkedWorktree, 'feature/linked']);
    await git(repository, ['remote', 'add', 'origin', path.join(root, 'remote.git')]);
    await git(repository, ['update-ref', 'refs/remotes/origin/master', 'HEAD']);
    await git(repository, ['config', 'branch.master.remote', 'origin']);
    await git(repository, ['config', 'branch.master.merge', 'refs/heads/master']);
    await writeFile(path.join(repository, 'README.md'), 'local change\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'local change']);

    const snapshot = await listBranches(repository);
    expect(snapshot.currentBranch).toBe('master');
    expect(snapshot.head).toMatch(/^[a-f0-9]{40,64}$/);
    expect(snapshot.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'master',
          current: true,
          upstream: 'origin/master',
          ahead: 1,
          behind: 0,
          worktreePath: await realpath(repository),
        }),
        expect.objectContaining({ name: 'feature/linked', current: false, worktreePath: await realpath(linkedWorktree) }),
      ]),
    );
    expect(snapshot.worktrees).toHaveLength(2);
    expect(await repositoryCommonDir(repository)).toBe(await repositoryCommonDir(linkedWorktree));

    await git(repository, ['checkout', '--detach']);
    const detached = await listBranches(repository);
    expect(detached.currentBranch).toBeNull();
    expect(detached.branches.every((branch) => !branch.current)).toBe(true);
  });
});

describe('switchBranch', () => {
  it('rejects stale, dirty, in-progress and occupied targets before switching safely', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-switch-'));
    temporaryDirectories.push(root);
    const repository = path.join(root, 'repository');
    const occupiedWorktree = path.join(root, 'occupied-worktree');
    await execFileAsync('git', ['init', '--initial-branch=master', repository]);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(repository, ['branch', 'feature/free']);
    await git(repository, ['branch', 'feature/occupied']);
    await git(repository, ['worktree', 'add', occupiedWorktree, 'feature/occupied']);

    const initial = await listBranches(repository);
    const request = { branch: 'feature/free', expectedBranch: 'master', expectedHead: initial.head };
    await expect(switchBranch(repository, { ...request, expectedHead: 'a'.repeat(40) })).rejects.toThrow(
      '当前分支或 HEAD 已变化',
    );
    await expect(
      switchBranch(repository, { ...request, branch: 'feature/occupied' }),
    ).rejects.toThrow('目标分支已被其他 Worktree 占用');

    const untrackedPath = path.join(repository, 'notes.txt');
    await writeFile(untrackedPath, 'dirty\n');
    await expect(switchBranch(repository, request)).rejects.toThrow('工作区不干净');
    await rm(untrackedPath);

    const mergeHeadPath = path.resolve(repository, await git(repository, ['rev-parse', '--git-path', 'MERGE_HEAD']));
    await writeFile(mergeHeadPath, `${initial.head}\n`);
    await expect(switchBranch(repository, request)).rejects.toThrow('仓库正在进行 merge');
    await rm(mergeHeadPath);

    const switched = await switchBranch(repository, request);
    expect(switched.currentBranch).toBe('feature/free');
    expect(await git(repository, ['branch', '--show-current'])).toBe('feature/free');

    await git(repository, ['checkout', '--detach']);
    const detached = await listBranches(repository);
    const attached = await switchBranch(repository, {
      branch: 'master',
      expectedBranch: null,
      expectedHead: detached.head,
    });
    expect(attached.currentBranch).toBe('master');
  });

  it('rejects worktree changes created after the initial status scan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-switch-race-'));
    temporaryDirectories.push(root);
    const repository = path.join(root, 'repository');
    const fakeBin = path.join(root, 'bin');
    await execFileAsync('git', ['init', '--initial-branch=master', repository]);
    await git(repository, ['config', 'user.name', 'Git Fleet Test']);
    await git(repository, ['config', 'user.email', 'git-fleet@example.test']);
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await git(repository, ['branch', 'feature/free']);
    await git(repository, ['update-ref', 'refs/remotes/origin/master', 'HEAD']);
    await git(repository, ['config', 'branch.master.remote', 'origin']);
    await git(repository, ['config', 'branch.master.merge', 'refs/heads/master']);
    await mkdir(fakeBin);
    const gitWrapper = path.join(fakeBin, 'git');
    await writeFile(
      gitWrapper,
      '#!/bin/sh\ncase " $* " in\n  *" for-each-ref "*) sleep 0.25 ;;\nesac\nexec /usr/bin/git "$@"\n',
    );
    await chmod(gitWrapper, 0o755);

    const before = await listBranches(repository);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
      const switching = switchBranch(repository, {
        branch: 'feature/free',
        expectedBranch: 'master',
        expectedHead: before.head,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await writeFile(path.join(repository, 'late.txt'), 'created during validation\n');

      await expect(switching).rejects.toThrow('工作区不干净');
      expect(await git(repository, ['branch', '--show-current'])).toBe('master');
      expect(await git(repository, ['status', '--porcelain', '--', 'late.txt'])).toContain('?? late.txt');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('createBranch', () => {
  it('creates from HEAD without touching the worktree, and switches when asked', async () => {
    const { repository, head } = await createRepositoryFixture('git-fleet-create-branch-');

    const created = await createBranch(repository, {
      branch: 'feature/created',
      checkout: false,
      expectedBranch: 'master',
      expectedHead: head,
    });
    expect(created.currentBranch).toBe('master');
    expect(created.branches.map((branch) => branch.name)).toContain('feature/created');

    const switched = await createBranch(repository, {
      branch: 'feature/switched',
      checkout: true,
      expectedBranch: 'master',
      expectedHead: head,
    });
    expect(switched.currentBranch).toBe('feature/switched');
    expect(await git(repository, ['branch', '--show-current'])).toBe('feature/switched');
  });

  it('rejects duplicate, invalid and stale requests', async () => {
    const { repository, head } = await createRepositoryFixture('git-fleet-create-branch-reject-');
    await git(repository, ['branch', 'feature/taken']);

    await expect(
      createBranch(repository, { branch: 'feature/taken', checkout: true, expectedBranch: 'master', expectedHead: head }),
    ).rejects.toThrow('本地分支已存在');
    await expect(
      createBranch(repository, { branch: 'bad..name', checkout: true, expectedBranch: 'master', expectedHead: head }),
    ).rejects.toThrow('目标分支名称无效');
    await expect(
      createBranch(repository, {
        branch: 'feature/stale',
        checkout: true,
        expectedBranch: 'master',
        expectedHead: 'a'.repeat(40),
      }),
    ).rejects.toThrow('当前分支或 HEAD 已变化');
    expect(await git(repository, ['branch', '--list', 'feature/stale'])).toBe('');
  });

  it('requires a clean worktree only when it has to switch', async () => {
    const { repository, head } = await createRepositoryFixture('git-fleet-create-branch-dirty-');
    await writeFile(path.join(repository, 'notes.txt'), 'dirty\n');

    const created = await createBranch(repository, {
      branch: 'feature/offline',
      checkout: false,
      expectedBranch: 'master',
      expectedHead: head,
    });
    expect(created.branches.map((branch) => branch.name)).toContain('feature/offline');

    await expect(
      createBranch(repository, {
        branch: 'feature/online',
        checkout: true,
        expectedBranch: 'master',
        expectedHead: head,
      }),
    ).rejects.toThrow('工作区不干净');
    expect(await git(repository, ['branch', '--show-current'])).toBe('master');
    expect(await git(repository, ['branch', '--list', 'feature/online'])).toBe('');
  });
});

describe('renameBranch', () => {
  it('renames a free branch and the current branch', async () => {
    const { repository, head } = await createRepositoryFixture('git-fleet-rename-branch-');
    await git(repository, ['branch', 'feature/old']);

    const renamed = await renameBranch(repository, {
      branch: 'feature/old',
      nextBranch: 'feature/new',
      expectedBranch: 'master',
      expectedHead: head,
    });
    const names = renamed.branches.map((branch) => branch.name);
    expect(names).toContain('feature/new');
    expect(names).not.toContain('feature/old');

    const renamedCurrent = await renameBranch(repository, {
      branch: 'master',
      nextBranch: 'main',
      expectedBranch: 'master',
      expectedHead: head,
    });
    expect(renamedCurrent.currentBranch).toBe('main');
    expect(await git(repository, ['branch', '--show-current'])).toBe('main');
  });

  it('rejects occupied, duplicate, unchanged and missing targets', async () => {
    const { root, repository, head } = await createRepositoryFixture('git-fleet-rename-branch-reject-');
    const occupiedWorktree = path.join(root, 'occupied-worktree');
    await git(repository, ['branch', 'feature/occupied']);
    await git(repository, ['branch', 'feature/taken']);
    await git(repository, ['worktree', 'add', occupiedWorktree, 'feature/occupied']);

    await expect(
      renameBranch(repository, {
        branch: 'feature/occupied',
        nextBranch: 'feature/moved',
        expectedBranch: 'master',
        expectedHead: head,
      }),
    ).rejects.toThrow('目标分支已被其他 Worktree 占用');
    await expect(
      renameBranch(repository, {
        branch: 'feature/taken',
        nextBranch: 'master',
        expectedBranch: 'master',
        expectedHead: head,
      }),
    ).rejects.toThrow('本地分支已存在');
    await expect(
      renameBranch(repository, {
        branch: 'feature/taken',
        nextBranch: 'feature/taken',
        expectedBranch: 'master',
        expectedHead: head,
      }),
    ).rejects.toThrow('新分支名与原名相同');
    await expect(
      renameBranch(repository, {
        branch: 'feature/missing',
        nextBranch: 'feature/whatever',
        expectedBranch: 'master',
        expectedHead: head,
      }),
    ).rejects.toThrow('本地分支不存在');
  });
});

describe('deleteBranch', () => {
  it('deletes a merged branch and refuses current, occupied, unmerged and missing targets', async () => {
    const { root, repository, head } = await createRepositoryFixture('git-fleet-delete-branch-');
    const occupiedWorktree = path.join(root, 'occupied-worktree');
    await git(repository, ['branch', 'feature/merged']);
    await git(repository, ['branch', 'feature/occupied']);
    await git(repository, ['branch', 'feature/unmerged']);
    await git(repository, ['worktree', 'add', occupiedWorktree, 'feature/occupied']);

    await git(repository, ['switch', 'feature/unmerged']);
    await writeFile(path.join(repository, 'extra.txt'), 'unmerged work\n');
    await git(repository, ['add', 'extra.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'unmerged work']);
    await git(repository, ['switch', 'master']);

    const base = { expectedBranch: 'master', expectedHead: head };
    await expect(deleteBranch(repository, { branch: 'master', ...base })).rejects.toThrow('不能删除当前分支');
    await expect(deleteBranch(repository, { branch: 'feature/occupied', ...base })).rejects.toThrow(
      '目标分支已被其他 Worktree 占用',
    );
    await expect(deleteBranch(repository, { branch: 'feature/unmerged', ...base })).rejects.toThrow(
      '未合并到当前 HEAD',
    );
    await expect(deleteBranch(repository, { branch: 'feature/missing', ...base })).rejects.toThrow('本地分支不存在');
    expect(await git(repository, ['branch', '--list', 'feature/merged'])).not.toBe('');

    const deleted = await deleteBranch(repository, { branch: 'feature/merged', ...base });
    expect(deleted.branches.map((branch) => branch.name)).not.toContain('feature/merged');
    expect(await git(repository, ['branch', '--list', 'feature/merged'])).toBe('');
  });
});

describe('checkoutRemoteBranch', () => {
  async function remoteFixture(prefix: string) {
    const { root, repository, head: initialHead } = await createRepositoryFixture(prefix);
    const remotePath = path.join(root, 'remote.git');
    await execFileAsync('git', ['init', '--bare', remotePath]);
    await git(repository, ['remote', 'add', 'origin', remotePath]);
    await git(repository, ['push', 'origin', 'refs/heads/master:refs/heads/master']);

    // 远端分支指向第二个提交，与 initialHead 不同，便于验证「远端 ref 漂移」。
    await writeFile(path.join(repository, 'remote-only.txt'), 'remote only\n');
    await git(repository, ['add', 'remote-only.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'remote only work']);
    const head = await git(repository, ['rev-parse', 'HEAD']);
    await git(repository, ['push', 'origin', `${head}:refs/heads/feature/remote-only`]);
    await git(repository, ['fetch', 'origin']);
    return { root, repository, head, initialHead };
  }

  it('checks out a remote branch with an explicit tracking relationship', async () => {
    const { repository, head } = await remoteFixture('git-fleet-checkout-remote-');
    const before = await listBranches(repository);
    expect(before.remoteBranches).toContainEqual(
      expect.objectContaining({
        name: 'origin/feature/remote-only',
        remote: 'origin',
        branch: 'feature/remote-only',
        hasLocal: false,
      }),
    );

    const checkedOut = await checkoutRemoteBranch(repository, {
      remote: 'origin',
      branch: 'feature/remote-only',
      localBranch: 'feature/remote-only',
      expectedBranch: 'master',
      expectedHead: head,
    });
    expect(checkedOut.currentBranch).toBe('feature/remote-only');
    expect(checkedOut.branches.find((branch) => branch.current)?.upstream).toBe('origin/feature/remote-only');
  });

  it('rejects unsafe, unknown, existing, invalid and dirty requests', async () => {
    const { repository, head } = await remoteFixture('git-fleet-checkout-remote-reject-');
    const base = { remote: 'origin', branch: 'feature/remote-only', expectedBranch: 'master', expectedHead: head };

    await expect(
      checkoutRemoteBranch(repository, { ...base, remote: 'bad name', localBranch: 'feature/x' }),
    ).rejects.toThrow('Git remote 名称不安全');
    await expect(
      checkoutRemoteBranch(repository, { ...base, branch: 'feature/missing', localBranch: 'feature/missing' }),
    ).rejects.toThrow('远端分支不存在');
    await expect(
      checkoutRemoteBranch(repository, { ...base, localBranch: 'feature/invalid..name' }),
    ).rejects.toThrow('目标分支名称无效');
    await git(repository, ['branch', 'feature/taken']);
    await expect(checkoutRemoteBranch(repository, { ...base, localBranch: 'feature/taken' })).rejects.toThrow(
      '本地分支已存在',
    );

    await writeFile(path.join(repository, 'notes.txt'), 'dirty\n');
    await expect(
      checkoutRemoteBranch(repository, { ...base, localBranch: 'feature/remote-only' }),
    ).rejects.toThrow('工作区不干净');
    expect(await git(repository, ['branch', '--show-current'])).toBe('master');
  });

  it('rejects a remote ref that moved after the snapshot was taken', async () => {
    const { root, repository, head, initialHead } = await remoteFixture('git-fleet-checkout-remote-drift-');
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin);
    const gitWrapper = path.join(fakeBin, 'git');
    // 快照先读完，再让写前复核停住 1.5s；这段时间足够在快照之后、最终复核之前改动远端 ref。
    await writeFile(
      gitWrapper,
      '#!/bin/sh\ncase " $* " in\n  *"--absolute-git-dir"*) sleep 1.5 ;;\nesac\nexec /usr/bin/git "$@"\n',
    );
    await chmod(gitWrapper, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
      const checkout = checkoutRemoteBranch(repository, {
        remote: 'origin',
        branch: 'feature/remote-only',
        localBranch: 'feature/remote-only',
        expectedBranch: 'master',
        expectedHead: head,
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await git(repository, ['update-ref', 'refs/remotes/origin/feature/remote-only', initialHead]);

      await expect(checkout).rejects.toThrow('远端分支已变化');
      expect(await git(repository, ['branch', '--show-current'])).toBe('master');
      expect(await git(repository, ['branch', '--list', 'feature/remote-only'])).toBe('');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
