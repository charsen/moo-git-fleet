import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { cloneRepositoryIntoRoot } from './clone.js';

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
  /** 可直接当作克隆来源的本地仓库（离线，不需要网络）。 */
  origin: string;
  config: RepositoriesConfig;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-clone-'));
  temporaryDirectories.push(root);
  const origin = path.join(root, 'origin');
  await execFileAsync('/usr/bin/git', ['init', '--initial-branch=master', origin]);
  await git(origin, ['config', 'user.name', 'Git Fleet Test']);
  await git(origin, ['config', 'user.email', 'git-fleet@example.test']);
  await writeFile(path.join(origin, 'readme.md'), 'hello\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '-m', 'init']);

  const clones = path.join(root, 'clones');
  await mkdir(clones);
  const config: RepositoriesConfig = {
    version: 1,
    settings: {
      roots: { clones },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories: [],
  };
  return { root, origin, config };
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('cloneRepositoryIntoRoot', () => {
  it('把远端克隆到根目录下并返回目录名', async () => {
    const { config, origin } = await fixture();
    const output = await cloneRepositoryIntoRoot(config, { rootId: 'clones', url: origin });

    expect(output.directory).toBe('origin');
    // resolveRoot 会把根目录解析成 realpath（macOS 上 /var 是 /private/var 的符号链接），
    // 因此期望值同样要过一遍 realpath。
    expect(output.absolutePath).toBe(path.join(await realpath(config.settings.roots.clones!), 'origin'));
    expect(await git(output.absolutePath, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect(await git(output.absolutePath, ['log', '-1', '--format=%s'])).toBe('init');
  });

  it('允许指定目录名', async () => {
    const { config, origin } = await fixture();
    const output = await cloneRepositoryIntoRoot(config, { rootId: 'clones', url: origin, directory: '我的项目' });
    expect(output.directory).toBe('我的项目');
    expect(await exists(output.absolutePath)).toBe(true);
  });

  it('目标已存在时拒绝，且不覆盖任何内容', async () => {
    const { config, origin } = await fixture();
    const occupied = path.join(config.settings.roots.clones!, 'origin');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'keep.txt'), 'keep\n');

    await expect(cloneRepositoryIntoRoot(config, { rootId: 'clones', url: origin })).rejects.toThrow('目标目录已存在');
    // 原有内容必须原封不动
    expect(await exists(path.join(occupied, 'keep.txt'))).toBe(true);
    expect(await exists(path.join(occupied, '.git'))).toBe(false);
  });

  it('目录名不接受路径分隔符与特殊项（把「写到根目录之外」堵在入口）', async () => {
    const { config, origin } = await fixture();
    for (const directory of ['../escape', 'a/b', 'a\\b', '.', '..', '-oops', 'bad\nname']) {
      await expect(
        cloneRepositoryIntoRoot(config, { rootId: 'clones', url: origin, directory }),
        directory,
      ).rejects.toThrow();
    }
    // 一个都没落盘
    expect(await exists(path.join(path.dirname(config.settings.roots.clones!), 'escape'))).toBe(false);
  });

  it('地址走与远端管理同一份判定：危险形式被拒', async () => {
    const { config } = await fixture();
    await expect(
      cloneRepositoryIntoRoot(config, { rootId: 'clones', url: 'ext::sh -c whoami' }),
    ).rejects.toThrow('远程助手');
    await expect(
      cloneRepositoryIntoRoot(config, { rootId: 'clones', url: 'ftp://example.com/a.git' }),
    ).rejects.toThrow('不支持的协议');
  });

  it('未登记的根目录被拒', async () => {
    const { config, origin } = await fixture();
    await expect(cloneRepositoryIntoRoot(config, { rootId: 'nope', url: origin })).rejects.toThrow();
  });

  it('克隆失败时清理半成品，不留垃圾目录', async () => {
    const { config, root } = await fixture();
    const missing = path.join(root, 'does-not-exist.git');

    await expect(cloneRepositoryIntoRoot(config, { rootId: 'clones', url: missing })).rejects.toThrow();
    // git 自己会清掉，或由我们清理——两种情况下目标目录都不应留下
    expect(await exists(path.join(config.settings.roots.clones!, 'does-not-exist'))).toBe(false);
  });
});
