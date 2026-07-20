import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoriesConfig, RepositoryConfig, RepositoryImportCandidate } from '../../shared/contracts.js';
import { isPathInside, resolveRepositoryPath, resolveRoot } from '../config/store.js';
import { runGitText } from '../git/runner.js';
import { repositoryId } from '../git/scanner.js';

type AppendRepositoryInput = RepositoryImportCandidate & { tags?: string[] };

function nextOrder(config: RepositoriesConfig): number {
  return config.repositories.reduce((maximum, repository) => Math.max(maximum, repository.order), 0) + 10;
}

async function configuredRepositoryPaths(config: RepositoriesConfig): Promise<string[]> {
  return Promise.all(
    config.repositories.map(async (repository) => {
      const configuredPath = resolveRepositoryPath(config, repository);
      return realpath(configuredPath).catch(() => configuredPath);
    }),
  );
}

export async function appendRepositoryConfig(
  config: RepositoriesConfig,
  input: AppendRepositoryInput,
): Promise<RepositoryConfig> {
  const rootPath = await resolveRoot(config, input.rootId);
  const requestedPath = path.resolve(rootPath, input.relativePath);
  let candidatePath: string;
  try {
    candidatePath = await realpath(requestedPath);
  } catch {
    throw new Error(`本地目录不存在：${requestedPath}`);
  }
  if (!isPathInside(rootPath, candidatePath)) throw new Error('候选仓库超出允许的根目录');

  let topLevel: string;
  try {
    topLevel = await realpath(await runGitText(candidatePath, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new Error(`配置路径不是 Git worktree 根目录：${candidatePath}`);
  }
  if (!isPathInside(rootPath, topLevel)) throw new Error('Git worktree 超出允许的根目录');
  if ((await configuredRepositoryPaths(config)).includes(topLevel)) throw new Error('该仓库已经在列表中');

  const name = input.name || path.basename(topLevel);
  const repository: RepositoryConfig = {
    id: repositoryId(name, topLevel),
    name,
    root: input.rootId,
    path: path.relative(rootPath, topLevel) || '.',
    group: input.group,
    enabled: true,
    pinned: false,
    order: nextOrder(config),
    tags: input.tags ?? [],
    aiCommitPolicy: 'redacted-patch',
    capabilities: { fetch: true, pull: true, stage: true, commit: true, stash: true, push: true },
  };
  config.repositories.push(repository);
  return repository;
}
