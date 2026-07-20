import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { parsePackagesMarkdown, previewPackagesManifest } from './packages.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createGitRepository(repositoryPath: string, remote?: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  await execFileAsync('git', ['init', repositoryPath]);
  if (remote) await execFileAsync('git', ['-C', repositoryPath, 'remote', 'add', 'origin', remote]);
}

function configFor(root: string, repositories: RepositoryConfig[] = []): RepositoriesConfig {
  return {
    version: 1,
    settings: {
      roots: { dev: root },
      defaultRemote: 'origin',
      scanDepth: 2,
      localScanConcurrency: 2,
      networkConcurrency: 1,
    },
    repositories,
  };
}

describe('PACKAGES.md repository import', () => {
  it('extracts repository URLs and host project names with their section groups', () => {
    const parsed = parsePackagesMarkdown(`
## ① 开源基础设施
| 包名 | 仓库 |
| --- | --- |
| \`charsen/moo-scaffold\` | gitee.com/charsen/moo-scaffold（MIT） |

## ④ Hosts 与教程
| 项目 | 角色 |
| --- | --- |
| \`wisdomcity\` | 基线 |
| \`moo-engine-skeleton\` | 扩展包接入教程骨架 |

## ⑤ 生态周边（非 Composer 包）
| 项目 | 仓库 |
| --- | --- |
| \`moo-monitor-vue\` | https://gitee.com/charsen/moo-monitor-vue.git |
`);

    expect(parsed).toEqual([
      { name: 'moo-scaffold', group: '基础设施', sourceRemote: 'https://gitee.com/charsen/moo-scaffold' },
      { name: 'wisdomcity', group: 'Hosts', sourceRemote: null },
      { name: 'moo-engine-skeleton', group: '教程', sourceRemote: null },
      { name: 'moo-monitor-vue', group: '周边', sourceRemote: 'https://gitee.com/charsen/moo-monitor-vue' },
    ]);
  });

  it('classifies configured, importable and missing repositories without changing config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-manifest-'));
    temporaryDirectories.push(root);
    await Promise.all([
      createGitRepository(path.join(root, 'moo-system')),
      createGitRepository(path.join(root, 'moo-attachment')),
      createGitRepository(path.join(root, 'wisdomcity'), 'https://gitee.com/charsen/wrong-host.git'),
    ]);
    const sourceDirectory = path.join(root, 'wisdomcity', 'docs');
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePath = path.join(sourceDirectory, 'PACKAGES.md');
    await writeFile(
      sourcePath,
      `## ② 正式业务扩展包
| 包名 | 仓库 |
| --- | --- |
| \`charsen/moo-system\` | gitee.com/charsen/moo-system |
| \`charsen/moo-attachment\` | gitee.com/charsen/moo-attachment |
| \`charsen/moo-radar\` | gitee.com/charsen/moo-radar |
## ④ Hosts 与教程
| 项目 | 角色 |
| --- | --- |
| \`wisdomcity\` | gitee.com/charsen/wisdomcity |
`,
    );
    const configured: RepositoryConfig = {
      id: 'moo-system-existing',
      name: 'moo-system',
      root: 'dev',
      path: 'moo-system',
      group: '业务包',
      enabled: true,
      pinned: false,
      order: 10,
      tags: [],
      aiCommitPolicy: 'redacted-patch',
      capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
    };
    const config = configFor(root, [configured]);

    const preview = await previewPackagesManifest(config, sourcePath);

    expect(preview).toMatchObject({ total: 4, ready: 1, existing: 1, missing: 1, ambiguous: 0, mismatch: 1 });
    expect(preview.candidates.map((candidate) => [candidate.name, candidate.status])).toEqual([
      ['moo-system', 'existing'],
      ['moo-attachment', 'ready'],
      ['moo-radar', 'missing'],
      ['wisdomcity', 'remote-mismatch'],
    ]);
    expect(config.repositories).toEqual([configured]);
  });

  it('rejects manifest files outside configured trusted roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-outside-'));
    temporaryDirectories.push(root, outside);
    const sourcePath = path.join(outside, 'PACKAGES.md');
    await writeFile(sourcePath, '| 项目 | 仓库 |\n| --- | --- |\n| `demo` | gitee.com/charsen/demo |\n');

    await expect(previewPackagesManifest(configFor(root), sourcePath)).rejects.toThrow('受信任根目录');
  });
});
