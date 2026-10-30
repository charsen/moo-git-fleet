import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchDeletionPreview,
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

/**
 * 等一个标记文件出现。竞态用例靠它对齐阶段，而不是靠固定 sleep：
 * 负载高时固定窗口会让「故意制造的变化」落进快照里，测试就会假失败。
 */
async function waitForMarker(marker: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await readFile(marker, 'utf8').then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待标记文件超时：${marker}`);
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

    // 只关心「当前分支是谁、它的 upstream 是什么」的调用方可以跳过整批 rev-list：
    // 分支集合与 upstream 不变，领先 / 落后为 null。
    const withoutDivergence = await listBranches(repository, { divergence: false });
    expect(withoutDivergence.branches.map((branch) => branch.name)).toEqual(snapshot.branches.map((branch) => branch.name));
    expect(withoutDivergence.branches.every((branch) => branch.ahead === null && branch.behind === null)).toBe(true);
    expect(withoutDivergence.branches.find((branch) => branch.current)?.upstream).toBe('origin/master');

    await git(repository, ['checkout', '--detach']);
    const detached = await listBranches(repository);
    expect(detached.currentBranch).toBeNull();
    expect(detached.branches.every((branch) => !branch.current)).toBe(true);
  });
});

describe('switchBranch', () => {
  it('rejects stale, in-progress and occupied targets before switching safely', async () => {
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

  it('carries compatible staged, unstaged and untracked content without committing or stashing', async () => {
    const { repository, head } = await createRepositoryFixture('git-fleet-switch-dirty-');
    await git(repository, ['switch', '-c', 'feature/compatible']);
    await writeFile(path.join(repository, 'target.txt'), 'target branch\n');
    await git(repository, ['add', 'target.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'target']);
    const targetHead = await git(repository, ['rev-parse', 'HEAD']);
    await git(repository, ['switch', 'master']);
    await writeFile(path.join(repository, 'README.md'), 'staged\n');
    await git(repository, ['add', 'README.md']);
    await writeFile(path.join(repository, 'README.md'), 'unstaged\n');
    await writeFile(path.join(repository, 'notes.txt'), 'untracked\n');
    const index = await git(repository, ['diff', '--cached', '--binary']);
    const switched = await switchBranch(repository, {
      branch: 'feature/compatible', expectedBranch: 'master', expectedHead: head,
    });
    expect(switched.currentBranch).toBe('feature/compatible');
    expect(switched.head).toBe(targetHead);
    expect(await git(repository, ['diff', '--cached', '--binary'])).toBe(index);
    expect(await readFile(path.join(repository, 'README.md'), 'utf8')).toBe('unstaged\n');
    expect(await readFile(path.join(repository, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(await readFile(path.join(repository, 'target.txt'), 'utf8')).toBe('target branch\n');
    expect(await git(repository, ['stash', 'list'])).toBe('');
  });

  it.each(['unstaged', 'staged', 'untracked'] as const)('preserves %s content and the branch when Git would overwrite it', async (kind) => {
    const { repository, head } = await createRepositoryFixture('git-fleet-switch-overwrite-');
    const file = kind === 'untracked' ? 'notes.txt' : 'README.md';
    await git(repository, ['switch', '-c', 'feature/conflicting']);
    await writeFile(path.join(repository, file), 'target version\n');
    await git(repository, ['add', file]);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'target']);
    await git(repository, ['switch', 'master']);
    await writeFile(path.join(repository, file), 'local version\n');
    if (kind === 'staged') await git(repository, ['add', file]);
    const index = await git(repository, ['diff', '--cached', '--binary']);
    const status = await git(repository, ['status', '--porcelain=v2', '-z']);
    await expect(switchBranch(repository, {
      branch: 'feature/conflicting', expectedBranch: 'master', expectedHead: head,
    })).rejects.toMatchObject({ message: '切换会覆盖本地修改或未跟踪文件，请先处理这些文件后重试', statusCode: 409, safetyBlocked: true });
    expect(await git(repository, ['branch', '--show-current'])).toBe('master');
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(path.join(repository, file), 'utf8')).toBe('local version\n');
    expect(await git(repository, ['diff', '--cached', '--binary'])).toBe(index);
    expect(await git(repository, ['status', '--porcelain=v2', '-z'])).toBe(status);
  });

  it('rejects conflicting content created just before Git switches', async () => {
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
    await git(repository, ['switch', 'feature/free']);
    await writeFile(path.join(repository, 'README.md'), 'target version\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'target']);
    await git(repository, ['switch', 'master']);
    await git(repository, ['update-ref', 'refs/remotes/origin/master', 'HEAD']);
    await git(repository, ['config', 'branch.master.remote', 'origin']);
    await git(repository, ['config', 'branch.master.merge', 'refs/heads/master']);
    await mkdir(fakeBin);
    const gitWrapper = path.join(fakeBin, 'git');
    const marker = path.join(root, 'switch-started');
    const release = path.join(root, 'switch-released');
    await writeFile(
      gitWrapper,
      `#!/bin/sh\ncase " $* " in\n  *" switch "*) : > "${marker}"; while [ ! -f "${release}" ]; do sleep 0.01; done ;;\nesac\nexec /usr/bin/git "$@"\n`,
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
      await waitForMarker(marker);
      await writeFile(path.join(repository, 'README.md'), 'created during validation\n');
      await writeFile(release, 'continue\n');

      await expect(switching).rejects.toThrow('切换会覆盖本地修改');
      expect(await git(repository, ['branch', '--show-current'])).toBe('master');
      expect(await readFile(path.join(repository, 'README.md'), 'utf8')).toBe('created during validation\n');
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
    expect(deleted.backupTag).toBeNull();
    expect(deleted.snapshot.branches.map((branch) => branch.name)).not.toContain('feature/merged');
    expect(await git(repository, ['branch', '--list', 'feature/merged'])).toBe('');
  });

  it('previews lost commits and only force deletes when the previewed head still matches', async () => {
    const { repository, head } = await createRepositoryFixture('git-fleet-force-delete-');
    await git(repository, ['branch', 'feature/merged']);
    await git(repository, ['branch', 'feature/lonely']);
    await git(repository, ['switch', 'feature/lonely']);
    await writeFile(path.join(repository, 'one.txt'), '1\n');
    await git(repository, ['add', 'one.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'first lonely']);
    await writeFile(path.join(repository, 'two.txt'), '2\n');
    await git(repository, ['add', 'two.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'second lonely']);
    const lonelyHead = await git(repository, ['rev-parse', 'feature/lonely']);
    await git(repository, ['switch', 'master']);
    const base = { expectedBranch: 'master', expectedHead: head };

    // 已合并的分支不会丢引用。
    const mergedPreview = await branchDeletionPreview(repository, { branch: 'feature/merged', ...base });
    expect(mergedPreview).toMatchObject({ unmerged: false, lostCount: 0, lostCommits: [] });

    // 只在本地、未合并的分支：两条提交都会失去引用，并且按新到旧列出。
    const preview = await branchDeletionPreview(repository, { branch: 'feature/lonely', ...base });
    expect(preview).toMatchObject({ branch: 'feature/lonely', head: lonelyHead, unmerged: true, lostCount: 2, lostTruncated: false });
    expect(preview.lostCommits.map((commit) => commit.subject)).toEqual(['second lonely', 'first lonely']);

    // 未确认强制时仍然拒绝，且提示要重新预览。
    await expect(deleteBranch(repository, { branch: 'feature/lonely', ...base })).rejects.toThrow('如需强制删除');

    // 直接用过期预览（分支在预览后被推进）会被拒绝，分支仍在。
    await git(repository, ['switch', 'feature/lonely']);
    await writeFile(path.join(repository, 'three.txt'), '3\n');
    await git(repository, ['add', 'three.txt']);
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'third lonely']);
    await git(repository, ['switch', 'master']);
    await expect(
      deleteBranch(repository, { branch: 'feature/lonely', ...base, force: true, expectedBranchHead: lonelyHead }),
    ).rejects.toThrow('请重新预览');
    expect(await git(repository, ['branch', '--list', 'feature/lonely'])).not.toBe('');

    // 缺 expectedBranchHead 的强制删除也不放行。
    const advancedHead = await git(repository, ['rev-parse', 'feature/lonely']);
    await expect(deleteBranch(repository, { branch: 'feature/lonely', ...base, force: true })).rejects.toThrow(
      '必须带上预览里的分支 head',
    );

    // 重新预览后可以强制删除，并且可以顺带留一个备份标签。
    const fresh = await branchDeletionPreview(repository, { branch: 'feature/lonely', ...base });
    expect(fresh.head).toBe(advancedHead);
    expect(fresh.lostCount).toBe(3);
    const forced = await deleteBranch(repository, {
      branch: 'feature/lonely',
      ...base,
      force: true,
      backupTag: true,
      expectedBranchHead: advancedHead,
    });
    expect(await git(repository, ['branch', '--list', 'feature/lonely'])).toBe('');
    expect(forced.backupTag).toMatch(/^fleet-backup\/feature\/lonely-/);
    expect(await git(repository, ['rev-parse', `refs/tags/${forced.backupTag}`])).toBe(advancedHead);
  });

  it('does not let a force delete bypass the current-branch or worktree guards', async () => {
    const { root, repository, head } = await createRepositoryFixture('git-fleet-force-guards-');
    const occupiedWorktree = path.join(root, 'occupied-worktree');
    await git(repository, ['branch', 'feature/occupied']);
    await git(repository, ['worktree', 'add', occupiedWorktree, 'feature/occupied']);
    const base = { expectedBranch: 'master', expectedHead: head, force: true, expectedBranchHead: head };
    await expect(deleteBranch(repository, { branch: 'master', ...base })).rejects.toThrow('不能删除当前分支');
    await expect(deleteBranch(repository, { branch: 'feature/occupied', ...base })).rejects.toThrow(
      '目标分支已被其他 Worktree 占用',
    );
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

  it('creates a differently named local branch even when the remote branch name is already local', async () => {
    const { repository, head } = await remoteFixture('git-fleet-checkout-custom-name-');
    await git(repository, ['branch', 'feature/remote-only']);
    const checkedOut = await checkoutRemoteBranch(repository, {
      remote: 'origin', branch: 'feature/remote-only', localBranch: 'feature/local-copy',
      expectedBranch: 'master', expectedHead: head,
    });
    expect(checkedOut.currentBranch).toBe('feature/local-copy');
    expect(checkedOut.branches.find(branch => branch.current)).toMatchObject({ upstream: 'origin/feature/remote-only' });
    expect(await git(repository, ['rev-parse', 'feature/local-copy'])).toBe(await git(repository, ['rev-parse', 'refs/remotes/origin/feature/remote-only']));
    expect(checkedOut.branches.some(branch => branch.name === 'feature/remote-only')).toBe(true);
  });

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

  it('rejects unsafe, unknown, existing and invalid requests', async () => {
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
  });

  it('carries compatible local changes and untracked files onto the new branch', async () => {
    const { repository, head } = await remoteFixture('git-fleet-checkout-remote-dirty-');
    // 未跟踪文件，加上「两边内容相同、只有本地改过」的已跟踪文件，都属于 git 能兼容携带的情况。
    await writeFile(path.join(repository, 'notes.txt'), 'dirty\n');
    await writeFile(path.join(repository, 'remote-only.txt'), 'compatible local edit\n');

    const checkedOut = await checkoutRemoteBranch(repository, {
      remote: 'origin',
      branch: 'feature/remote-only',
      localBranch: 'feature/remote-only',
      expectedBranch: 'master',
      expectedHead: head,
    });
    expect(checkedOut.currentBranch).toBe('feature/remote-only');
    expect(checkedOut.branches.find((branch) => branch.current)?.upstream).toBe('origin/feature/remote-only');
    expect(await readFile(path.join(repository, 'notes.txt'), 'utf8')).toBe('dirty\n');
    expect(await readFile(path.join(repository, 'remote-only.txt'), 'utf8')).toBe('compatible local edit\n');
  });

  it('refuses to overwrite conflicting local changes and leaves the repository untouched', async () => {
    const { repository, head } = await remoteFixture('git-fleet-checkout-remote-conflict-');
    // 让远端分支上的 remote-only.txt 与本地版本不同，本地再改这一份，检出就会真的冲突。
    await git(repository, ['switch', '-q', '-c', 'diverged']);
    await writeFile(path.join(repository, 'remote-only.txt'), 'remote side\n');
    await git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-am', 'remote side']);
    await git(repository, ['push', 'origin', 'diverged:refs/heads/feature/remote-only']);
    await git(repository, ['switch', '-q', 'master']);
    await git(repository, ['fetch', 'origin']);
    await writeFile(path.join(repository, 'remote-only.txt'), 'conflicting local edit\n');

    await expect(
      checkoutRemoteBranch(repository, {
        remote: 'origin',
        branch: 'feature/remote-only',
        localBranch: 'feature/remote-only',
        expectedBranch: 'master',
        expectedHead: head,
      }),
    ).rejects.toThrow('检出会覆盖本地修改或未跟踪文件');
    expect(await git(repository, ['branch', '--show-current'])).toBe('master');
    expect(await git(repository, ['branch', '--list', 'feature/remote-only'])).toBe('');
    expect(await readFile(path.join(repository, 'remote-only.txt'), 'utf8')).toBe('conflicting local edit\n');
  });

  it('rejects a remote ref that moved after the snapshot was taken', async () => {
    const { root, repository, head, initialHead } = await remoteFixture('git-fleet-checkout-remote-drift-');
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin);
    const gitWrapper = path.join(fakeBin, 'git');
    const marker = path.join(root, 'recheck-started');
    // 写前复核会跑 `rev-parse --verify HEAD^{commit}`（不带 `--quiet`，与快照里那次可区分）：
    // 先落标记再停住 1.5s，测试等到标记出现才动远端 ref。这样「ref 变化落在快照之后、
    // 复核之前」是确定的；原来靠固定 sleep 800ms 对齐，机器一忙快照就超过 800ms，
    // 变化会落进快照里，于是复核看不出漂移，用例假失败（并行跑全量时复现过）。
    // 不要再挂到 `--absolute-git-dir` 上：那次调用已经从 `repositoryInternalState` 里去掉，
    // 换成直接读 `.git`，挂上去就再也等不到标记。
    await writeFile(
      gitWrapper,
      `#!/bin/sh\ncase " $* " in\n  *"--verify HEAD^{commit}"*) : > "${marker}"; sleep 1.5 ;;\nesac\nexec /usr/bin/git "$@"\n`,
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
      await waitForMarker(marker);
      await git(repository, ['update-ref', 'refs/remotes/origin/feature/remote-only', initialHead]);

      await expect(checkout).rejects.toThrow('远端分支已变化');
      expect(await git(repository, ['branch', '--show-current'])).toBe('master');
      expect(await git(repository, ['branch', '--list', 'feature/remote-only'])).toBe('');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
