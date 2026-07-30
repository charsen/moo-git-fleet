import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  DiscoveredSession,
  SessionDiscoveryError,
  SessionDiscoveryResult,
  SessionProvider,
} from '../../shared/sessions.js';
import type { RepositoriesConfig, RepositoryConfig } from '../../shared/contracts.js';
import { isPathInside, resolveRepositoryPath } from '../config/store.js';
import { runGitText } from '../git/runner.js';

const claudeAuxiliaryNames = new Set(['history.jsonl', 'session-env', 'file-history']);
const sqliteSuffixes = ['.sqlite', '.sqlite-wal', '.sqlite-shm'];

export interface SessionDiscoveryInput {
  repositories: RepositoriesConfig;
  claudeHome?: string;
  codexHome?: string;
  /** Defaults to 30. Pass null to inspect all dates (useful for recovery/import). */
  recentDays?: number | null;
  now?: Date;
}

interface RepositoryIdentity {
  id: string;
  name: string;
  canonicalPath: string;
  normalizedRemote: string | null;
  projectId: string;
  claudeDirectoryNames: string[];
}

interface JsonlMetadata {
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  cwd: string | null;
  messageCount: number;
  tailTruncated: boolean;
  malformedLines: number;
}

interface ScanContext {
  identities: RepositoryIdentity[];
  byClaudeDirectory: Map<string, RepositoryIdentity>;
  recentDays: number | null;
  now: Date;
  scannedAt: string;
  errors: SessionDiscoveryError[];
  scannedFiles: number;
  ignoredFiles: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Normalize the remote identity used to join projects across machines.
 * Credentials, query strings, fragments and a trailing `.git` are never part
 * of the identity.  SCP-style SSH URLs are converted to the same form as
 * `ssh://host/path`. Transport schemes are deliberately removed so an HTTPS
 * checkout and an SSH checkout of the same hosted repository share one id.
 */
export function normalizeRemoteUrl(remote: string): string {
  const value = remote.trim();
  const scp = value.includes('://') ? null : value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp) {
    const host = scp[1]?.toLowerCase() ?? '';
    const repositoryPath = (scp[2] ?? '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return `host:${host}/${repositoryPath}`.toLowerCase();
  }

  try {
    const url = new URL(value);
    const repositoryPath = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (url.protocol === 'file:') return `file:${path.normalize(`/${repositoryPath}`)}`;
    return `host:${url.host.toLowerCase()}/${repositoryPath}`.toLowerCase();
  } catch {
    if (path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
      return `file:${path.resolve(value).replace(/\.git$/i, '')}`;
    }
    return value
      .replace(/:\/\/[^/@]+@/, '://')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  }
}

/** Claude currently encodes an absolute path by replacing `/` with `-`. */
export function encodeClaudeProjectPath(projectPath: string): string {
  return path.resolve(projectPath).replaceAll('/', '-');
}

/**
 * Decode the common Claude project directory representation.  Hyphens in an
 * original path are ambiguous in this legacy representation; discovery first
 * matches the encoded name against registered Fleet repositories and only uses
 * this best-effort fallback when no registration is available.
 */
export function decodeClaudeProjectPath(directoryName: string): string | null {
  if (!directoryName.startsWith('-')) return null;
  const decoded = directoryName.replaceAll('-', '/');
  return decoded.startsWith('/') ? path.normalize(decoded) : path.resolve('/', decoded);
}

export function projectIdFor(remote: string | null, canonicalPath: string): string {
  return remote ? `remote:${digest(remote)}` : `local:${digest(canonicalPath)}`;
}

async function canonicalPath(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => path.resolve(candidate));
}

async function buildRepositoryIdentities(config: RepositoriesConfig): Promise<RepositoryIdentity[]> {
  return Promise.all(
    config.repositories.map(async (repository: RepositoryConfig) => {
      const configuredPath = resolveRepositoryPath(config, repository);
      const configuredAbsolutePath = path.resolve(configuredPath);
      const resolvedPath = await canonicalPath(configuredPath);
      const remote = await runGitText(resolvedPath, ['remote', 'get-url', config.settings.defaultRemote]).catch(() => '');
      const normalizedRemote = remote ? normalizeRemoteUrl(remote) : null;
      return {
        id: repository.id,
        name: repository.name,
        canonicalPath: resolvedPath,
        normalizedRemote,
        projectId: projectIdFor(normalizedRemote, resolvedPath),
        claudeDirectoryNames: [...new Set([configuredAbsolutePath, resolvedPath].map(encodeClaudeProjectPath))],
      };
    }),
  );
}

function makeContext(identities: RepositoryIdentity[], input: SessionDiscoveryInput): ScanContext {
  const now = input.now ?? new Date();
  const recentDays = input.recentDays === undefined ? 30 : input.recentDays;
  return {
    identities,
    byClaudeDirectory: new Map(
      identities.flatMap((identity) => identity.claudeDirectoryNames.map((directoryName) => [directoryName, identity] as const)),
    ),
    recentDays,
    now,
    scannedAt: now.toISOString(),
    errors: [],
    scannedFiles: 0,
    ignoredFiles: 0,
  };
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nestedRecords(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const nested: Record<string, unknown>[] = [record];
  for (const key of ['payload', 'data', 'meta', 'session', 'event']) {
    const child = record[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) nested.push(child as Record<string, unknown>);
  }
  return nested;
}

function inspectRecord(value: unknown, metadata: JsonlMetadata): void {
  for (const record of nestedRecords(value)) {
    const timestamp = normalizedDate(stringField(record, ['timestamp', 'created_at', 'createdAt', 'time', 'occurredAt']));
    if (timestamp && (!metadata.firstAt || timestamp < metadata.firstAt)) metadata.firstAt = timestamp;
    if (timestamp && (!metadata.lastAt || timestamp > metadata.lastAt)) metadata.lastAt = timestamp;

    const cwd = stringField(record, ['cwd', 'working_directory', 'workingDirectory', 'projectPath', 'project_path']);
    if (cwd && !metadata.cwd) metadata.cwd = cwd;

    const title = stringField(record, ['title', 'summary', 'slug', 'session_title']);
    if (title && !metadata.title) metadata.title = title.slice(0, 500);
  }
}

/** Read only JSONL metadata; no transcript text is returned or retained. */
async function readJsonlMetadata(filePath: string): Promise<JsonlMetadata> {
  const metadata: JsonlMetadata = {
    title: null,
    firstAt: null,
    lastAt: null,
    cwd: null,
    messageCount: 0,
    tailTruncated: false,
    malformedLines: 0,
  };
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lastNonEmptyWasMalformed = false;
  try {
    for await (const line of lines) {
      const text = String(line).trim();
      if (!text) continue;
      try {
        const value: unknown = JSON.parse(text);
        metadata.messageCount += 1;
        inspectRecord(value, metadata);
        lastNonEmptyWasMalformed = false;
      } catch {
        // A provider can be writing the final JSONL record while we scan.  A
        // malformed non-tail line is noted but does not make other records
        // disappear; the caller exposes the tail flag separately.
        metadata.malformedLines += 1;
        lastNonEmptyWasMalformed = true;
      }
    }
    metadata.tailTruncated = lastNonEmptyWasMalformed;
  } finally {
    lines.close();
    stream.destroy();
  }
  return metadata;
}

function isRecent(fileStat: { mtimeMs: number }, context: ScanContext): boolean {
  if (context.recentDays === null) return true;
  const cutoff = context.now.getTime() - Math.max(0, context.recentDays) * 24 * 60 * 60 * 1_000;
  return fileStat.mtimeMs >= cutoff;
}

function chooseIdentity(context: ScanContext, projectPath: string | null, remote: string | null): RepositoryIdentity | null {
  const normalizedProjectPath = projectPath ? path.resolve(projectPath) : null;
  const normalizedRemote = remote ? normalizeRemoteUrl(remote) : null;
  if (normalizedRemote) {
    const remoteMatch = context.identities.find((identity) => identity.normalizedRemote === normalizedRemote);
    if (remoteMatch) return remoteMatch;
  }
  if (!normalizedProjectPath) return null;
  const matches = context.identities
    .filter((identity) => isPathInside(identity.canonicalPath, normalizedProjectPath))
    .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length);
  return matches[0] ?? null;
}

function projectJoin(
  context: ScanContext,
  encodedClaudeDirectory: string | null,
  projectPath: string | null,
  remote: string | null,
): { projectPath: string | null; projectId: string; repositoryId: string | null; repositoryName: string | null } {
  const encodedMatch = encodedClaudeDirectory ? context.byClaudeDirectory.get(encodedClaudeDirectory) : undefined;
  const identity = encodedMatch ?? chooseIdentity(context, projectPath, remote);
  if (identity) {
    return {
      projectPath: identity.canonicalPath,
      projectId: identity.projectId,
      repositoryId: identity.id,
      repositoryName: identity.name,
    };
  }
  const canonicalProjectPath = projectPath ? path.resolve(projectPath) : null;
  return {
    projectPath: canonicalProjectPath,
    projectId: canonicalProjectPath ? `local:${digest(canonicalProjectPath)}` : `unknown:${digest(encodedClaudeDirectory ?? 'unknown')}`,
    repositoryId: null,
    repositoryName: null,
  };
}

function discoveryError(context: ScanContext, provider: SessionProvider, filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : '读取会话文件失败';
  context.errors.push({ provider, path: filePath, message: message.slice(0, 2_000) });
}

function sessionFromMetadata(
  provider: SessionProvider,
  providerSessionId: string,
  sourcePath: string,
  project: ReturnType<typeof projectJoin>,
  metadata: JsonlMetadata,
  bytes: number,
  discoveredAt: string,
  error: string | null = null,
): DiscoveredSession {
  return {
    schemaVersion: 1,
    provider,
    providerSessionId,
    sourcePath,
    projectPath: project.projectPath,
    projectId: project.projectId,
    repositoryId: project.repositoryId,
    repositoryName: project.repositoryName,
    title: metadata.title,
    createdAt: metadata.firstAt,
    lastActivityAt: metadata.lastAt,
    bytes,
    messageCount: metadata.messageCount,
    tailTruncated: metadata.tailTruncated,
    readable: !error,
    error,
    discoveredAt,
  };
}

async function fileIsRecent(filePath: string, context: ScanContext): Promise<{ bytes: number; recent: boolean }> {
  const fileStat = await stat(filePath);
  return { bytes: fileStat.size, recent: isRecent(fileStat, context) };
}

async function scanClaudeRoot(rootPath: string, context: ScanContext): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  let projectEntries;
  try {
    projectEntries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') discoveryError(context, 'claude', rootPath, error);
    return sessions;
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink() || claudeAuxiliaryNames.has(projectEntry.name)) {
      context.ignoredFiles += 1;
      continue;
    }
    const projectDirectory = path.join(rootPath, projectEntry.name);
    let entries;
    try {
      entries = await readdir(projectDirectory, { withFileTypes: true });
    } catch (error) {
      discoveryError(context, 'claude', projectDirectory, error);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl') || entry.name === 'history.jsonl') {
        context.ignoredFiles += 1;
        continue;
      }
      const sourcePath = path.join(projectDirectory, entry.name);
      context.scannedFiles += 1;
      let fileInfo: { bytes: number; recent: boolean };
      try {
        fileInfo = await fileIsRecent(sourcePath, context);
      } catch (error) {
        discoveryError(context, 'claude', sourcePath, error);
        continue;
      }
      if (!fileInfo.recent) continue;

      const providerSessionId = entry.name.slice(0, -'.jsonl'.length);
      const decodedPath = decodeClaudeProjectPath(projectEntry.name);
      const project = projectJoin(context, projectEntry.name, decodedPath, null);
      try {
        const metadata = await readJsonlMetadata(sourcePath);
        sessions.push(sessionFromMetadata('claude', providerSessionId, sourcePath, project, metadata, fileInfo.bytes, context.scannedAt));
      } catch (error) {
        discoveryError(context, 'claude', sourcePath, error);
        sessions.push(
          sessionFromMetadata(
            'claude',
            providerSessionId,
            sourcePath,
            project,
            { title: null, firstAt: null, lastAt: null, cwd: null, messageCount: 0, tailTruncated: false, malformedLines: 0 },
            fileInfo.bytes,
            context.scannedAt,
            '读取会话文件失败',
          ),
        );
      }
    }
  }
  return sessions;
}

function isSqliteName(name: string): boolean {
  return sqliteSuffixes.some((suffix) => name.endsWith(suffix));
}

async function collectCodexRollouts(directory: string, context: ScanContext, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') discoveryError(context, 'codex', directory, error);
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await collectCodexRollouts(entryPath, context, files);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
      if (isSqliteName(entry.name) || entry.name.endsWith('.jsonl')) context.ignoredFiles += 1;
      continue;
    }
    context.scannedFiles += 1;
    try {
      const fileInfo = await fileIsRecent(entryPath, context);
      if (fileInfo.recent) files.push(entryPath);
    } catch (error) {
      discoveryError(context, 'codex', entryPath, error);
    }
  }
}

async function scanCodexRoot(rootPath: string, context: ScanContext): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  const files: string[] = [];
  await collectCodexRollouts(path.join(rootPath, 'sessions'), context, files);
  for (const sourcePath of files) {
    const fileName = path.basename(sourcePath);
    const uuid = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
    const providerSessionId = uuid ?? fileName.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
    let fileInfo: { bytes: number; recent: boolean };
    try {
      fileInfo = await fileIsRecent(sourcePath, context);
    } catch (error) {
      discoveryError(context, 'codex', sourcePath, error);
      continue;
    }
    try {
      const metadata = await readJsonlMetadata(sourcePath);
      const resolvedCwd = metadata.cwd ? await canonicalPath(metadata.cwd) : null;
      const project = projectJoin(context, null, resolvedCwd, null);
      sessions.push(sessionFromMetadata('codex', providerSessionId, sourcePath, project, metadata, fileInfo.bytes, context.scannedAt));
    } catch (error) {
      discoveryError(context, 'codex', sourcePath, error);
      sessions.push(
        sessionFromMetadata(
          'codex',
          providerSessionId,
          sourcePath,
          projectJoin(context, null, null, null),
          { title: null, firstAt: null, lastAt: null, cwd: null, messageCount: 0, tailTruncated: false, malformedLines: 0 },
          fileInfo.bytes,
          context.scannedAt,
          '读取会话文件失败',
        ),
      );
    }
  }
  return sessions;
}

async function rootExists(rootPath: string): Promise<boolean> {
  try {
    await access(rootPath);
    return true;
  } catch {
    return false;
  }
}

function sortedSessions(sessions: DiscoveredSession[]): DiscoveredSession[] {
  return sessions.sort((a, b) => {
    const aTime = a.lastActivityAt ?? a.createdAt ?? '';
    const bTime = b.lastActivityAt ?? b.createdAt ?? '';
    return bTime.localeCompare(aTime) || a.provider.localeCompare(b.provider) || a.providerSessionId.localeCompare(b.providerSessionId);
  });
}

export function sessionProviderRoot(input: SessionDiscoveryInput, provider: SessionProvider): string {
  const userHome = process.env.HOME ?? os.homedir();
  if (provider === 'claude') {
    return path.resolve(
      input.claudeHome ?? process.env.GIT_FLEET_CLAUDE_HOME ?? path.join(userHome, '.claude'),
    );
  }
  return path.resolve(
    input.codexHome ?? process.env.GIT_FLEET_CODEX_HOME ?? path.join(userHome, '.codex'),
  );
}

async function discoverWithContext(
  input: SessionDiscoveryInput,
  provider: SessionProvider,
): Promise<{ sessions: DiscoveredSession[]; context: ScanContext }> {
  const identities = await buildRepositoryIdentities(input.repositories);
  const context = makeContext(identities, input);
  const root = sessionProviderRoot(input, provider);
  if (!(await rootExists(root))) return { sessions: [], context };
  const sessions = provider === 'claude' ? await scanClaudeRoot(path.join(root, 'projects'), context) : await scanCodexRoot(root, context);
  return { sessions: sortedSessions(sessions), context };
}

export async function discoverClaudeSessions(input: SessionDiscoveryInput): Promise<SessionDiscoveryResult> {
  const { sessions, context } = await discoverWithContext(input, 'claude');
  return {
    schemaVersion: 1,
    scannedAt: context.scannedAt,
    sessions,
    errors: context.errors,
    scannedFiles: context.scannedFiles,
    ignoredFiles: context.ignoredFiles,
  };
}

export async function discoverCodexSessions(input: SessionDiscoveryInput): Promise<SessionDiscoveryResult> {
  const { sessions, context } = await discoverWithContext(input, 'codex');
  return {
    schemaVersion: 1,
    scannedAt: context.scannedAt,
    sessions,
    errors: context.errors,
    scannedFiles: context.scannedFiles,
    ignoredFiles: context.ignoredFiles,
  };
}

export async function discoverSessions(input: SessionDiscoveryInput): Promise<SessionDiscoveryResult> {
  const identities = await buildRepositoryIdentities(input.repositories);
  const context = makeContext(identities, input);
  const claudeRoot = sessionProviderRoot(input, 'claude');
  const codexRoot = sessionProviderRoot(input, 'codex');
  const [hasClaudeRoot, hasCodexRoot] = await Promise.all([rootExists(claudeRoot), rootExists(codexRoot)]);
  const [claudeSessions, codexSessions] = await Promise.all([
    hasClaudeRoot ? scanClaudeRoot(path.join(claudeRoot, 'projects'), context) : Promise.resolve([]),
    hasCodexRoot ? scanCodexRoot(codexRoot, context) : Promise.resolve([]),
  ]);
  return {
    schemaVersion: 1,
    scannedAt: context.scannedAt,
    sessions: sortedSessions([...claudeSessions, ...codexSessions]),
    errors: context.errors,
    scannedFiles: context.scannedFiles,
    ignoredFiles: context.ignoredFiles,
  };
}
