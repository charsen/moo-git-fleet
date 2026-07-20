import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { ProfileConfig, RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { profileConfigSchema, repositoriesConfigSchema } from '../../shared/schemas.js';

const appRoot = path.resolve(process.env.GIT_FLEET_HOME ?? process.cwd());
const configDir = path.join(appRoot, 'config');
const profilePath = path.join(configDir, 'profile.yaml');
const repositoriesPath = path.join(configDir, 'repositories.yaml');

const defaultProfile: ProfileConfig = {
  version: 1,
  profile: {
    displayName: process.env.USER ?? 'Developer',
    avatar: null,
    locale: 'zh-CN',
    theme: 'moon',
    preferredCommitLanguage: 'zh-CN',
    aiCommitMode: 'review',
    notificationsEnabled: false,
  },
  gitIdentity: { source: 'git-config' },
};

const defaultRepositories: RepositoriesConfig = {
  version: 1,
  settings: {
    roots: { dev: '/Volumes/dev/wwwroot' },
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
  await mkdir(path.dirname(filePath), { recursive: true });
  if (await exists(filePath)) {
    await copyFile(filePath, `${filePath}.bak`);
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, stringify(value, { indent: 2 }), { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readYaml<T>(filePath: string, fallback: T, parseValue: (value: unknown) => T): Promise<T> {
  if (!(await exists(filePath))) {
    await writeYamlAtomic(filePath, fallback);
    return fallback;
  }
  const contents = await readFile(filePath, 'utf8');
  return parseValue(parse(contents));
}

export async function loadProfile(): Promise<ProfileConfig> {
  return readYaml(profilePath, defaultProfile, (value) => profileConfigSchema.parse(value));
}

export async function saveProfile(profile: ProfileConfig): Promise<ProfileConfig> {
  const parsed = profileConfigSchema.parse(profile);
  await writeYamlAtomic(profilePath, parsed);
  return parsed;
}

export async function loadRepositories(): Promise<RepositoriesConfig> {
  return readYaml(repositoriesPath, defaultRepositories, (value) => repositoriesConfigSchema.parse(value));
}

export async function saveRepositories(config: RepositoriesConfig): Promise<RepositoriesConfig> {
  const parsed = repositoriesConfigSchema.parse(config);
  await writeYamlAtomic(repositoriesPath, parsed);
  return parsed;
}

export async function resolveRoot(config: RepositoriesConfig, rootId: string): Promise<string> {
  const configuredPath = config.settings.roots[rootId];
  if (!configuredPath) throw new Error(`未知仓库根目录：${rootId}`);
  const rootPath = await realpath(configuredPath);
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
