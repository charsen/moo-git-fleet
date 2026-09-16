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
| \`example-org/core-lib\` | gitee.com/example-org/core-lib（MIT） |

## ④ Hosts 与教程
| 项目 | 角色 |
| --- | --- |
| \`web-portal\` | 基线 |
| \`tutorial-skeleton\` | 扩展包接入教程骨架 |

## ⑤ 生态周边（非 Composer 包）
| 项目 | 仓库 |
| --- | --- |
| \`ops-dashboard\` | https://gitee.com/example-org/ops-dashboard.git |
`);

    expect(parsed).toEqual([
      { name: 'core-lib', group: '基础设施', sourceRemote: 'https://gitee.com/example-org/core-lib' },
      { name: 'web-portal', group: 'Hosts', sourceRemote: null },
      { name: 'tutorial-skeleton', group: '教程', sourceRemote: null },
      { name: 'ops-dashboard', group: '周边', sourceRemote: 'https://gitee.com/example-org/ops-dashboard' },
    ]);
  });

  it('classifies configured, importable and missing repositories without changing config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-manifest-'));
    temporaryDirectories.push(root);
    await Promise.all([
      createGitRepository(path.join(root, 'service-api')),
      createGitRepository(path.join(root, 'service-files')),
      createGitRepository(path.join(root, 'web-portal'), 'https://gitee.com/example-org/wrong-host.git'),
    ]);
    const sourceDirectory = path.join(root, 'web-portal', 'docs');
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePath = path.join(sourceDirectory, 'PACKAGES.md');
    await writeFile(
      sourcePath,
      `## ② 正式业务扩展包
| 包名 | 仓库 |
| --- | --- |
| \`example-org/service-api\` | gitee.com/example-org/service-api |
| \`example-org/service-files\` | gitee.com/example-org/service-files |
| \`example-org/service-metrics\` | gitee.com/example-org/service-metrics |
## ④ Hosts 与教程
| 项目 | 角色 |
| --- | --- |
| \`web-portal\` | gitee.com/example-org/web-portal |
`,
    );
    const configured: RepositoryConfig = {
      id: 'service-api-existing',
      name: 'service-api',
      root: 'dev',
      path: 'service-api',
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
      ['service-api', 'existing'],
      ['service-files', 'ready'],
      ['service-metrics', 'missing'],
      ['web-portal', 'remote-mismatch'],
    ]);
    expect(config.repositories).toEqual([configured]);
  });

  it('rejects manifest files outside configured trusted roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-outside-'));
    temporaryDirectories.push(root, outside);
    const sourcePath = path.join(outside, 'PACKAGES.md');
    await writeFile(sourcePath, '| 项目 | 仓库 |\n| --- | --- |\n| `demo` | gitee.com/example-org/demo |\n');

    await expect(previewPackagesManifest(configFor(root), sourcePath)).rejects.toThrow('受信任根目录');
  });
});
