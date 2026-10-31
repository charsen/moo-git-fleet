import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { listRepositoryFiles } from './files.js';
import {
  parsePorcelainV2,
  repositoryId,
  repositoryInternalState,
  sanitizeRemote,
  scanRoot,
  scanRepositories,
  scanRepository,
} from './scanner.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

/**
 * 夹具用有限并发创建，避免受限环境（沙箱对单次并发文件操作有上限）直接失败。
 * 本用例断言的是扫描的 500 上限，与目录怎么建出来无关。
 */
async function createRepositoryDirectories(root: string, count: number): Promise<void> {
  const batchSize = 25;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) =>
        mkdir(path.join(root, `repository-${String(start + offset).padStart(3, '0')}`, '.git'), { recursive: true }),
      ),
    );
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('parsePorcelainV2', () => {
  it('parses branch divergence and worktree counts', () => {
    const output = Buffer.from(
      '# branch.head master\0# branch.upstream origin/master\0# branch.ab +2 -1\0' +
        '# stash 3\0' +
        '1 M. N... 100644 100644 100644 abc abc src/a.ts\0' +
        '1 .D N... 100644 100644 000000 abc abc src/b.ts\0' +
        '1 MM N... 100644 100644 100644 abc abc src/both.ts\0' +
        '2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\0src/old.ts\0' +
        '? notes.txt\0' +
        'u UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts\0',
    );
    expect(parsePorcelainV2(output)).toMatchObject({
      branch: 'master',
      upstream: 'origin/master',
      ahead: 2,
      behind: 1,
      stashCount: 3,
      changedFiles: 6,
      staged: 3,
      modified: 2,
      deleted: 1,
      renamed: 1,
      untracked: 1,
      conflicted: 1,
    });
  });

  it('keeps newlines inside a NUL-delimited filename', () => {
    const output = Buffer.from(
      '# branch.head master\0' +
        '? notes\n? fake-status.ts\0' +
        '1 M. N... 100644 100644 100644 abc abc src/real.ts\0',
    );

    expect(parsePorcelainV2(output)).toMatchObject({
      branch: 'master',
      changedFiles: 2,
      staged: 1,
      modified: 0,
      untracked: 1,
      conflicted: 0,
    });
  });
});

describe('repositoryId', () => {
  it('is stable for a canonical path', () => {
    expect(repositoryId('Example Project', '/srv/projects/example-repo')).toBe(
      repositoryId('Example Project', '/srv/projects/example-repo'),
    );
  });
});

describe('sanitizeRemote', () => {
  it('removes credentials from HTTP remotes and preserves common SSH remotes', () => {
    expect(sanitizeRemote('https://oauth-user:secret-token@gitee.com/example-org/repository.git')).toBe(
      'https://gitee.com/example-org/repository.git',
    );
    expect(sanitizeRemote('git@gitee.com:example-org/repository.git')).toBe(
      'git@gitee.com:example-org/repository.git',
    );
  });
});

describe('scanRepository Git identity', () => {
  it('reports the effective repository identity and warns when it is incomplete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-identity-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    const homePath = path.join(root, 'home');
    await mkdir(homePath);
    await execFileAsync('git', ['init', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    vi.stubEnv('HOME', homePath);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

    const repository: RepositoryConfig = {
      id: 'identity-repository',
      name: 'Identity Repository',
      root: 'test',
      path: 'repository',
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [repository],
    };

    const partial = await scanRepository(config, repository);
    expect(partial.gitIdentity).toEqual({ name: 'Fleet Developer', email: null, complete: false });

    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Identity Repository\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial']);
    await execFileAsync('git', ['-C', repositoryPath, 'tag', 'v1.2.3']);
    await execFileAsync('git', [
      '-C',
      repositoryPath,
      'remote',
      'add',
      'origin',
      'https://user:secret@example.test/fleet.git',
    ]);
    await writeFile(path.join(repositoryPath, 'README.md'), '# First Stash\n');
    await execFileAsync('git', ['-C', repositoryPath, 'stash', 'push', '-m', 'first']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Second Stash\n');
    await execFileAsync('git', ['-C', repositoryPath, 'stash', 'push', '-m', 'second']);
    const complete = await scanRepository(config, repository);
    expect(complete.gitIdentity).toEqual({
      name: 'Fleet Developer',
      email: 'fleet@example.test',
      complete: true,
    });
    expect(complete.latestTag).toMatchObject({ name: 'v1.2.3' });
    expect(complete.lastCommit?.tags).toEqual(['v1.2.3']);
    expect(complete.stashCount).toBe(2);
    expect(complete.remoteUrl).toBe('https://example.test/fleet.git');

    await writeFile(path.join(repositoryPath, 'README.md'), '# After Release\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'after release']);
    const afterRelease = await scanRepository(config, repository);
    expect(afterRelease.latestTag).toMatchObject({ name: 'v1.2.3' });
    expect(afterRelease.lastCommit?.tags).toEqual([]);
  });
});

describe('scanRepository filename boundaries', () => {
  it('matches the file list for a real repository containing newlines and status-like filename text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-filename-boundary-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Filename Boundary\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);

    await writeFile(path.join(repositoryPath, 'README.md'), '# Filename Boundary\n\nStaged change.\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    const unusualPath = 'notes\n? fake-status.ts';
    await writeFile(path.join(repositoryPath, unusualPath), 'untracked\n');

    const repository: RepositoryConfig = {
      id: 'filename-boundary',
      name: 'Filename Boundary',
      root: 'test',
      path: 'repository',
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [repository],
    };

    const [status, files] = await Promise.all([
      scanRepository(config, repository),
      listRepositoryFiles(repository.id, repositoryPath),
    ]);

    expect(status).toMatchObject({
      available: true,
      changedFiles: 2,
      staged: 1,
      modified: 0,
      untracked: 1,
      state: 'dirty',
    });
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.path)).toContain(unusualPath);
  });
});

describe('repository internal state path boundaries', () => {
  it('does not treat a failed Fetch zero-byte marker as a successful Fetch', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-empty-fetch-head-'));
    temporaryDirectories.push(repository);
    await execFileAsync('git', ['init', '--initial-branch=main', repository]);
    const { stdout: fetchPathOutput } = await execFileAsync('git', [
      '-C',
      repository,
      'rev-parse',
      '--git-path',
      'FETCH_HEAD',
    ]);
    // `--git-path` 对普通仓库返回的是相对路径 `.git/FETCH_HEAD`，它相对 `-C` 指定的
    // 仓库，不相对进程 cwd。原样 writeFile 会落到**运行测试的那个仓库**自己的
    // .git/FETCH_HEAD 上，而断言检查的临时仓库一个 marker 都没有——测试恒过，
    // 顺带清空开发者的 FETCH_HEAD。必须先 resolve 到临时仓库再写。
    const fetchPath = path.resolve(repository, fetchPathOutput.trim());
    expect(fetchPath.startsWith(repository)).toBe(true);
    await writeFile(fetchPath, '');
    expect((await stat(fetchPath)).size).toBe(0);

    await expect(repositoryInternalState(repository)).resolves.toMatchObject({ lastFetchedAt: null });
  });

  it('reads Worktree markers when the common repository path contains a newline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-internal-state-'));
    temporaryDirectories.push(root);
    const mainRepository = path.join(root, 'main\nrepository');
    const linkedWorktree = path.join(root, 'linked');
    await execFileAsync('git', ['init', '--initial-branch=main', mainRepository]);
    await execFileAsync('git', ['-C', mainRepository, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', mainRepository, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(mainRepository, 'README.md'), '# Internal State\n');
    await execFileAsync('git', ['-C', mainRepository, 'add', 'README.md']);
    await execFileAsync('git', ['-C', mainRepository, '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    await execFileAsync('git', ['-C', mainRepository, 'branch', 'feature']);
    await execFileAsync('git', ['-C', mainRepository, 'worktree', 'add', linkedWorktree, 'feature']);

    const { stdout: headOutput } = await execFileAsync('git', ['-C', linkedWorktree, 'rev-parse', 'HEAD']);
    const { stdout: fetchPathOutput } = await execFileAsync('git', [
      '-C',
      linkedWorktree,
      'rev-parse',
      '--git-path',
      'FETCH_HEAD',
    ]);
    const { stdout: mergePathOutput } = await execFileAsync('git', [
      '-C',
      linkedWorktree,
      'rev-parse',
      '--git-path',
      'MERGE_HEAD',
    ]);
    await writeFile(fetchPathOutput.trim(), `${headOutput.trim()}\n`);
    await writeFile(mergePathOutput.trim(), `${headOutput.trim()}\n`);

    const state = await repositoryInternalState(linkedWorktree);
    expect(state.operation).toBe('merge');
    expect(state.lastFetchedAt).not.toBeNull();
  });
});

describe('repository scan coordination', () => {
  it('reads Fetch and operation markers while preserving configured repository order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-coordination-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'available');
    await execFileAsync('git', ['init', '--initial-branch=master', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await writeFile(path.join(repositoryPath, 'README.md'), '# Coordination Repository\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
    const { stdout: head } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD']);
    await writeFile(path.join(repositoryPath, '.git', 'FETCH_HEAD'), `${head.trim()}\n`);
    await writeFile(path.join(repositoryPath, '.git', 'MERGE_HEAD'), `${head.trim()}\n`);

    const configured = (id: string, repositoryPathName: string, order: number): RepositoryConfig => ({
      id,
      name: id,
      root: 'test',
      path: repositoryPathName,
      group: 'Tests',
      enabled: true,
      pinned: false,
      order,
      tags: [],
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    });
    const repositories = [configured('available', 'available', 10), configured('missing', 'missing', 20)];
    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 2,
        networkConcurrency: 1,
      },
      repositories,
    };

    const statuses = await scanRepositories(config);
    expect(statuses.map((status) => status.config.id)).toEqual(['available', 'missing']);
    expect(statuses[0]).toMatchObject({
      available: true,
      inProgressOperation: 'merge',
      state: 'operation-in-progress',
    });
    expect(statuses[0]?.lastFetchedAt).not.toBeNull();
    expect(statuses[1]).toMatchObject({ available: false, state: 'missing' });
  });

  it('marks session backup repositories carrying the fleet.json marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-session-backup-'));
    temporaryDirectories.push(root);
    const backupPath = path.join(root, 'ai-session-backup');
    const normalPath = path.join(root, 'normal-repository');
    await execFileAsync('git', ['init', '--initial-branch=main', backupPath]);
    await execFileAsync('git', ['init', '--initial-branch=main', normalPath]);
    await writeFile(path.join(backupPath, 'fleet.json'), '{"schemaVersion":1,"kind":"moo-fleet-session-backup"}');

    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 2,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [],
    };

    const candidates = await scanRoot(config, 'test');
    expect(candidates.map((candidate) => [candidate.name, candidate.sessionBackup])).toEqual([
      ['ai-session-backup', true],
      ['normal-repository', false],
    ]);
  });

  it('enforces the 500 repository discovery cap under concurrent traversal', { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-scan-cap-'));
    temporaryDirectories.push(root);
    const wrapperRoot = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-scan-cap-wrapper-'));
    temporaryDirectories.push(wrapperRoot);
    const bin = path.join(wrapperRoot, 'bin');
    await mkdir(bin);
    const wrapper = path.join(bin, 'git');
    await writeFile(
      wrapper,
      '#!/bin/sh\ncase " $* " in\n  *" rev-parse --is-inside-work-tree "*) printf true ;;\n  *" branch --show-current "*) printf main ;;\n  *" remote get-url origin "*) printf https://example.test/repository.git ;;\n  *) exec /usr/bin/git "$@" ;;\nesac\n',
    );
    await chmod(wrapper, 0o755);
    await createRepositoryDirectories(root, 501);

    const config: RepositoriesConfig = {
      version: 1,
      settings: {
        roots: { test: root },
        defaultRemote: 'origin',
        scanDepth: 1,
        localScanConcurrency: 1,
        networkConcurrency: 1,
      },
      repositories: [],
    };
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      const candidates = await scanRoot(config, 'test');
      expect(candidates).toHaveLength(500);
      expect(candidates[0]?.name).toBe('repository-000');
      expect(new Set(candidates.map((candidate) => candidate.absolutePath)).size).toBe(500);
      expect(candidates.every((candidate) => /^repository-(?:[0-4]\d\d|500)$/.test(candidate.name))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

/**
 * 元数据缓存（最近提交 / 最新 Tag / 身份 / 远端地址）按「文件指纹」复用。
 * 这里断言的是它的正确性契约：只要引用或 config 变了，就必须立刻看到新值——
 * 缓存只允许省进程，不允许让界面显示旧数据。
 */
describe('scanRepository metadata cache', () => {
  const metadataRepository = (root: string): { repository: RepositoryConfig; config: RepositoriesConfig } => {
    const repository: RepositoryConfig = {
      id: 'metadata-cache',
      name: 'Metadata Cache',
      root: 'test',
      path: 'repository',
      group: 'Tests',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    return {
      repository,
      config: {
        version: 1,
        settings: {
          roots: { test: root },
          defaultRemote: 'origin',
          scanDepth: 2,
          localScanConcurrency: 1,
          networkConcurrency: 1,
        },
        repositories: [repository],
      },
    };
  };

  const commitAt = async (repositoryPath: string, message: string, isoDate: string, file = 'README.md'): Promise<string> => {
    await writeFile(path.join(repositoryPath, file), `# ${message}\n`);
    await execFileAsync('git', ['-C', repositoryPath, 'add', file]);
    await execFileAsync('git', ['-C', repositoryPath, '-c', 'commit.gpgSign=false', 'commit', '-m', message], {
      env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    });
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD']);
    return stdout.trim();
  };

  it('follows new commits, new tags and a force-moved tag', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-metadata-cache-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    const { repository, config } = metadataRepository(root);

    const firstHash = await commitAt(repositoryPath, 'first', '2026-01-01T10:00:00+08:00');
    await execFileAsync('git', ['-C', repositoryPath, 'tag', 'v1.0.0']);
    const first = await scanRepository(config, repository);
    expect(first.lastCommit?.hash).toBe(firstHash);
    expect(first.latestTag?.name).toBe('v1.0.0');

    // 新提交 + 新 Tag：指纹必须失效
    const secondHash = await commitAt(repositoryPath, 'second', '2026-02-02T10:00:00+08:00');
    await execFileAsync('git', ['-C', repositoryPath, 'tag', 'v2.0.0']);
    const second = await scanRepository(config, repository);
    expect(second.lastCommit?.hash).toBe(secondHash);
    expect(second.latestTag?.name).toBe('v2.0.0');
    expect(second.lastCommit?.tags).toEqual(['v2.0.0']);

    // 强制把已有 Tag 指回旧提交：refs/tags 目录 mtime 不变，只有引用文件变了。
    // 只盯目录的实现会在这里返回旧的 creatordate。先删掉 v1.0.0，
    // 否则两个 Tag 指向同一个提交、creatordate 相同，排序结果不确定。
    await execFileAsync('git', ['-C', repositoryPath, 'tag', '-d', 'v1.0.0']);
    await execFileAsync('git', ['-C', repositoryPath, 'tag', '-f', 'v2.0.0', firstHash]);
    const third = await scanRepository(config, repository);
    expect(third.latestTag?.name).toBe('v2.0.0');
    expect(third.latestTag?.createdAt).not.toBe(second.latestTag?.createdAt);
    expect(third.latestTag?.createdAt).toContain('2026-01-01');
  });

  it('picks up identity and remote changes made between scans', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-metadata-config-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    // 身份会从全局 config 兜底，不隔离的话读到的是跑测试这台机器的真实邮箱
    const homePath = path.join(root, 'home');
    await mkdir(homePath);
    vi.stubEnv('HOME', homePath);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await commitAt(repositoryPath, 'first', '2026-01-01T10:00:00+08:00');
    const { repository, config } = metadataRepository(root);

    const before = await scanRepository(config, repository);
    expect(before.gitIdentity).toEqual({ name: 'Fleet Developer', email: null, complete: false });
    expect(before.remoteUrl).toBeNull();

    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'fleet@example.test']);
    await execFileAsync('git', ['-C', repositoryPath, 'remote', 'add', 'origin', 'git@example.test:fleet.git']);
    const after = await scanRepository(config, repository);
    expect(after.gitIdentity).toEqual({ name: 'Fleet Developer', email: 'fleet@example.test', complete: true });
    expect(after.remoteUrl).toBe('git@example.test:fleet.git');
  });

  it('follows the configured default remote without touching .git/config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-metadata-remote-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Fleet Developer']);
    await commitAt(repositoryPath, 'first', '2026-01-01T10:00:00+08:00');
    await execFileAsync('git', ['-C', repositoryPath, 'remote', 'add', 'origin', 'git@example.test:origin.git']);
    await execFileAsync('git', ['-C', repositoryPath, 'remote', 'add', 'upstream', 'git@example.test:upstream.git']);
    const { repository, config } = metadataRepository(root);

    const fromOrigin = await scanRepository(config, repository);
    expect(fromOrigin.remoteUrl).toBe('git@example.test:origin.git');

    // 只改设置里的默认远端名：`.git/config` 一个字节都不动，文件指纹不会失效。
    // 缓存键漏掉 defaultRemote 的实现会在这里继续返回 origin 的地址。
    const switched = { ...config, settings: { ...config.settings, defaultRemote: 'upstream' } };
    const fromUpstream = await scanRepository(switched, repository);
    expect(fromUpstream.remoteUrl).toBe('git@example.test:upstream.git');
  });
});
