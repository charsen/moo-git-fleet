import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { defaultDarkTheme, type ProfileConfig, type RepositoriesConfig, type RepositoryConfig } from '../../shared/contracts.js';
import { profileConfigSchema, repositoriesConfigSchema } from '../../shared/schemas.js';
import { notFoundError } from '../errors.js';

const appRoot = path.resolve(process.env.GIT_FLEET_HOME ?? process.cwd());
const configDir = path.join(appRoot, 'config');
const profilePath = path.join(configDir, 'profile.yaml');
const repositoriesPath = path.join(configDir, 'repositories.yaml');

type ConfigUpdater<T> = (current: T) => T | Promise<T>;

let profileQueue = Promise.resolve();
let repositoriesQueue = Promise.resolve();

function enqueueConfigTask<T>(
  queue: 'profile' | 'repositories',
  task: () => T | Promise<T>,
): Promise<T> {
  const currentQueue = queue === 'profile' ? profileQueue : repositoriesQueue;
  const result = currentQueue.then(task, task);
  const nextQueue = result.then(
    () => undefined,
    () => undefined,
  );
  if (queue === 'profile') profileQueue = nextQueue;
  else repositoriesQueue = nextQueue;
  return result;
}

const defaultProfile: ProfileConfig = {
  version: 1,
  profile: {
    displayName: process.env.USER ?? 'Developer',
    avatar: null,
    locale: 'zh-CN',
    theme: defaultDarkTheme,
    preferredCommitLanguage: 'zh-CN',
    aiCommitMode: 'review',
    autoFetchIntervalMinutes: 0,
    viewPreferences: {
      repositorySort: 'activity',
      repositoryFilter: 'all',
      repositoryGroup: null,
      batchScope: 'visible',
    },
  },
  gitIdentity: { source: 'git-config' },
  migrations: { activitySortDefault: true },
};

export function migrateProfileDefaults(profile: ProfileConfig): ProfileConfig {
  if (profile.migrations.activitySortDefault) return profile;
  return {
    ...profile,
    migrations: { ...profile.migrations, activitySortDefault: true },
    profile: {
      ...profile.profile,
      viewPreferences: {
        ...profile.profile.viewPreferences,
        repositorySort:
          profile.profile.viewPreferences.repositorySort === 'name'
            ? 'activity'
            : profile.profile.viewPreferences.repositorySort,
      },
    },
  };
}

export function detectDefaultRoots(candidatePath = process.env.GIT_FLEET_DEFAULT_ROOT ?? path.join(os.homedir(), 'dev')):
  Record<string, string> {
  const resolvedPath = path.resolve(candidatePath);
  return existsSync(resolvedPath) ? { dev: resolvedPath } : {};
}

const defaultRepositories: RepositoriesConfig = {
  version: 1,
  settings: {
    roots: detectDefaultRoots(),
    defaultRemote: 'origin',
    scanDepth: 2,
    localScanConcurrency: 6,
    networkConcurrency: 3,
  },
  repositories: [],
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeYamlAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  yamlCache.delete(filePath);
  if (await exists(filePath)) {
    const backupPath = `${filePath}.bak`;
    await copyFile(filePath, backupPath);
    await chmod(backupPath, 0o600);
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, stringify(value, { indent: 2 }), { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

/**
 * 解析结果缓存。
 *
 * 每个仓库级请求都会 `loadRepositories()`，而 54 个仓库的 YAML 解析实测约 4.5 ms
 * （zod 校验另算），文件本身却几乎不变。按 `(mtime, size)` 命中就跳过读盘与解析。
 *
 * 命中时返回**克隆**：`updateRepositories` 的 updater 会原地改传入的配置对象，
 * 共享同一份实例意味着一次失败的写入能把缓存带脏。
 */
const yamlCache = new Map<string, { stamp: string; value: unknown }>();

async function readYaml<T>(filePath: string, fallback: T, parseValue: (value: unknown) => T): Promise<T> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(filePath).catch(() => null);
  if (!info) {
    await writeYamlAtomic(filePath, fallback);
    return structuredClone(fallback);
  }
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = yamlCache.get(filePath);
  if (cached && cached.stamp === stamp) return structuredClone(cached.value as T);
  await chmod(filePath, 0o600);
  const contents = await readFile(filePath, 'utf8');
  const value = parseValue(parse(contents));
  yamlCache.set(filePath, { stamp, value });
  return structuredClone(value);
}

async function loadProfileUnlocked(): Promise<ProfileConfig> {
  const profile = await readYaml(profilePath, defaultProfile, (value) => profileConfigSchema.parse(value));
  const migrated = migrateProfileDefaults(profile);
  if (migrated !== profile) await writeYamlAtomic(profilePath, migrated);
  return migrated;
}

async function saveProfileUnlocked(profile: ProfileConfig): Promise<ProfileConfig> {
  const parsed = profileConfigSchema.parse(profile);
  await writeYamlAtomic(profilePath, parsed);
  return parsed;
}

async function loadRepositoriesUnlocked(): Promise<RepositoriesConfig> {
  return readYaml(repositoriesPath, defaultRepositories, (value) => repositoriesConfigSchema.parse(value));
}

async function saveRepositoriesUnlocked(config: RepositoriesConfig): Promise<RepositoriesConfig> {
  const parsed = repositoriesConfigSchema.parse(config);
  await writeYamlAtomic(repositoriesPath, parsed);
  return parsed;
}

export function loadProfile(): Promise<ProfileConfig> {
  return enqueueConfigTask('profile', loadProfileUnlocked);
}

export function updateProfile(update: ConfigUpdater<ProfileConfig>): Promise<ProfileConfig> {
  return enqueueConfigTask('profile', async () => {
    const current = await loadProfileUnlocked();
    return saveProfileUnlocked(await update(current));
  });
}

export function loadRepositories(): Promise<RepositoriesConfig> {
  return enqueueConfigTask('repositories', loadRepositoriesUnlocked);
}

export function updateRepositories(update: ConfigUpdater<RepositoriesConfig>): Promise<RepositoriesConfig> {
  return enqueueConfigTask('repositories', async () => {
    const current = await loadRepositoriesUnlocked();
    return saveRepositoriesUnlocked(await update(current));
  });
}

export async function resolveRoot(config: RepositoriesConfig, rootId: string): Promise<string> {
  const configuredPath = config.settings.roots[rootId];
  if (!configuredPath) throw notFoundError(`未知仓库根目录：${rootId}`);
  // 目录被外部删除时 realpath 抛 ENOENT，原样透出去用户看到的是
  // 「ENOENT: no such file or directory, realpath '/private/var/…'」——既有内部路径，
  // 也没说该做什么。换成能指导操作的说法，同时保留路径方便排查。
  const rootPath = await realpath(configuredPath).catch(() => {
    throw notFoundError(`仓库根目录不存在：${configuredPath}。它可能已被移动或删除，请在设置里重新指定。`);
  });
  const info = await stat(rootPath);
  if (!info.isDirectory()) throw new Error(`仓库根目录不是目录：${configuredPath}`);
  return rootPath;
}

export function resolveRepositoryPath(config: RepositoriesConfig, repository: RepositoryConfig): string {
  const rootPath = config.settings.roots[repository.root];
  if (!rootPath) return path.resolve(repository.path);
  return path.resolve(rootPath, repository.path);
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export { appRoot };
