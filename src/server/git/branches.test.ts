import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listBranches, parseBranchRefs, parseWorktreePorcelain, repositoryCommonDir, switchBranch } from './branches.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync('git', ['-C', cwd, ...args]);
  return output.stdout.trim();
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
});
