import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { RepositoriesConfig, RepositoryConfig } from '../src/shared/contracts.js';
import { scanRepositories } from '../src/server/git/scanner.js';

const execFileAsync = promisify(execFile);
const repositoryCount = Number.parseInt(process.env.GIT_FLEET_STRESS_REPOSITORIES ?? '100', 10);
const scanBudgetMs = Number.parseInt(process.env.GIT_FLEET_SCAN_BUDGET_MS ?? '15000', 10);
const fixtureConcurrency = 12;

if (!Number.isInteger(repositoryCount) || repositoryCount < 1 || repositoryCount > 500) {
  throw new Error('GIT_FLEET_STRESS_REPOSITORIES 必须是 1～500 的整数');
}
if (!Number.isInteger(scanBudgetMs) || scanBudgetMs < 100) {
  throw new Error('GIT_FLEET_SCAN_BUDGET_MS 必须是不小于 100 的整数');
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function forEachConcurrent<T>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) await task(item, index);
      }
    }),
  );
}

function repositoryConfig(index: number): RepositoryConfig {
  const name = `stress-repository-${String(index + 1).padStart(3, '0')}`;
  return {
    id: name,
    name,
    root: 'stress',
    path: name,
    group: 'Stress',
    enabled: true,
    pinned: false,
    order: index * 10,
    tags: [],
    aiCommitPolicy: 'disabled',
    capabilities: {
      fetch: false,
      pull: false,
      stage: false,
      commit: false,
      stash: false,
      push: false,
    },
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'git-fleet-scan-stress-'));

try {
  const template = path.join(root, '.template');
  await git(root, ['init', '--initial-branch=master', template]);
  await git(template, ['config', 'user.name', 'Git Fleet Stress']);
  await git(template, ['config', 'user.email', 'stress@example.test']);
  await writeFile(path.join(template, 'README.md'), '# Git Fleet scan stress fixture\n');
  await git(template, ['add', 'README.md']);
  await git(template, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial fixture']);
  await git(template, ['tag', 'v1.0.0']);

  const repositories = Array.from({ length: repositoryCount }, (_, index) => repositoryConfig(index));
  await forEachConcurrent(repositories, fixtureConcurrency, async (repository, index) => {
    const destination = path.join(root, repository.path);
    await cp(template, destination, { recursive: true });
    if (index % 10 === 0) await writeFile(path.join(destination, 'dirty.txt'), `dirty ${index}\n`);
  });

  const config: RepositoriesConfig = {
    version: 1,
    settings: {
      roots: { stress: root },
      defaultRemote: 'origin',
      scanDepth: 1,
      localScanConcurrency: 6,
      networkConcurrency: 3,
    },
    repositories,
  };

  const startedAt = performance.now();
  const statuses = await scanRepositories(config);
  const durationMs = Math.round(performance.now() - startedAt);
  const available = statuses.filter((repository) => repository.available).length;
  const dirty = statuses.filter((repository) => repository.state === 'dirty').length;
  const stableOrder = statuses.every((repository, index) => repository.config.id === repositories[index]?.id);

  const result = {
    repositories: repositoryCount,
    available,
    dirty,
    stableOrder,
    concurrency: config.settings.localScanConcurrency,
    durationMs,
    averageMs: Number((durationMs / repositoryCount).toFixed(2)),
    budgetMs: scanBudgetMs,
  };
  console.log(JSON.stringify(result, null, 2));

  if (available !== repositoryCount) throw new Error(`仅成功扫描 ${available}/${repositoryCount} 个仓库`);
  if (dirty !== Math.ceil(repositoryCount / 10)) throw new Error(`Dirty 状态数量异常：${dirty}`);
  if (!stableOrder) throw new Error('扫描结果顺序与配置顺序不一致');
  if (durationMs > scanBudgetMs) throw new Error(`扫描耗时 ${durationMs}ms，超过预算 ${scanBudgetMs}ms`);
} finally {
  await rm(root, { recursive: true, force: true });
}
