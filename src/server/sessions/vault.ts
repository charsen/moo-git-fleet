import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type {
  InitializeSessionVaultRequest,
  SessionVaultBinding,
  SessionVaultManifest,
  SessionVaultPrivacyState,
  SessionVaultStatus,
} from '../../shared/sessions.js';
import {
  initializeSessionVaultSchema,
  sessionVaultPrivateRemoteConfirmation,
  sessionVaultBindingSchema,
  sessionVaultManifestSchema,
  sessionVaultStatusSchema,
} from '../../shared/sessions.js';
import { isPathInside } from '../config/store.js';
import { runGitText } from '../git/runner.js';
import { normalizeRemoteUrl } from './discovery.js';

export const SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION = sessionVaultPrivateRemoteConfirmation;
export const SESSION_VAULT_PRIVATE_LABEL = '私有（用户确认，未经 Fleet 验证）';
export const SESSION_VAULT_LOCAL_LABEL = '仅本机（未启用远端同步）';
export const SESSION_VAULT_UNCONFIRMED_LABEL = '远端未确认（只能本机保存）';
const officialFleetRemotes = [
  'https://gitee.com/charsen/moo-git-fleet.git',
  'https://github.com/charsen/moo-git-fleet.git',
].map(normalizeRemoteUrl);

export type SessionVaultErrorCode =
  | 'path-overlaps-fleet'
  | 'path-overlaps-git-repository'
  | 'binding-path-unsafe'
  | 'path-not-directory'
  | 'path-not-empty'
  | 'vault-repository-invalid'
  | 'remote-matches-fleet'
  | 'remote-conflict'
  | 'remote-contains-credentials'
  | 'remote-required'
  | 'private-confirmation-required'
  | 'vault-config-invalid';

export class SessionVaultSafetyError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: SessionVaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionVaultSafetyError';
  }
}

export interface SessionVaultServiceOptions {
  fleetRepositoryPath?: string;
  bindingPath?: string;
  now?: Date;
}

interface GitRemote {
  name: string;
  url: string;
  normalizedUrl: string;
}

interface PreparedVaultRepository {
  vaultPath: string;
  initialized: boolean;
  remotes: GitRemote[];
}

function defaultFleetRepositoryPath(): string {
  return path.resolve(process.env.GIT_FLEET_SOURCE_ROOT ?? process.env.GIT_FLEET_ASSETS_HOME ?? process.cwd());
}

function defaultBindingPath(): string {
  if (process.env.GIT_FLEET_HOME) return path.join(path.resolve(process.env.GIT_FLEET_HOME), 'config', 'session-vault.yaml');
  const dataHome =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Moo Fleet')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? os.homedir(), 'Moo Fleet')
        : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'moo-fleet');
  return path.join(dataHome, 'config', 'session-vault.yaml');
}

export function resolveSessionVaultBindingPath(options: SessionVaultServiceOptions = {}): string {
  return path.resolve(options.bindingPath ?? defaultBindingPath());
}

export function resolveSuggestedSessionVaultPath(options: SessionVaultServiceOptions = {}): string {
  const bindingDirectory = path.dirname(resolveSessionVaultBindingPath(options));
  const dataDirectory = path.basename(bindingDirectory) === 'config'
    ? path.dirname(bindingDirectory)
    : bindingDirectory;
  return path.join(dataDirectory, 'session-vault');
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingAncestor(candidate: string): Promise<{ ancestor: string; suffix: string[] }> {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new SessionVaultSafetyError('path-not-directory', '无法解析 Session Vault 目录。请选择可访问的本机目录。');
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return { ancestor: current, suffix };
}

async function canonicalPlannedPath(candidate: string): Promise<string> {
  const { ancestor, suffix } = await nearestExistingAncestor(candidate);
  return path.join(await realpath(ancestor), ...suffix);
}

async function gitTopLevel(candidate: string): Promise<string | null> {
  const topLevel = await runGitText(candidate, ['rev-parse', '--show-toplevel']).catch(() => '');
  return topLevel ? realpath(topLevel).catch(() => path.resolve(topLevel)) : null;
}

async function fleetGitRoot(candidate: string): Promise<string> {
  const canonicalCandidate = await canonicalPlannedPath(candidate);
  return (await gitTopLevel(canonicalCandidate)) ?? canonicalCandidate;
}

function overlapKind(fleetRoot: string, vaultPath: string): 'same' | 'inside' | 'contains' | null {
  if (fleetRoot === vaultPath) return 'same';
  if (isPathInside(fleetRoot, vaultPath)) return 'inside';
  if (isPathInside(vaultPath, fleetRoot)) return 'contains';
  return null;
}

function assertPathIsolated(fleetRoot: string, vaultPath: string): void {
  const overlap = overlapKind(fleetRoot, vaultPath);
  if (!overlap) return;
  const detail =
    overlap === 'same'
      ? '不能直接使用 Moo Fleet 开源仓库根目录'
      : overlap === 'inside'
        ? '不能放在 Moo Fleet 开源仓库的子目录（包括 .fleet、docs、fixture 或构建目录）中'
        : '不能使用包含 Moo Fleet 开源仓库的父目录';
  throw new SessionVaultSafetyError(
    'path-overlaps-fleet',
    `Session Vault ${detail}。请在开源仓库之外新建一个独立目录，移动或重新选择后再试。`,
  );
}

function assertBindingPathIsolated(fleetRoot: string, vaultPath: string, bindingPath: string): void {
  if (isPathInside(fleetRoot, bindingPath)) {
    throw new SessionVaultSafetyError(
      'binding-path-unsafe',
      'Session Vault 本机绑定配置不能写入 Moo Fleet 开源仓库。请把 GIT_FLEET_HOME 指向仓库外的应用数据目录后重试。',
    );
  }
  if (isPathInside(vaultPath, bindingPath)) {
    throw new SessionVaultSafetyError(
      'binding-path-unsafe',
      'Session Vault 本机绑定配置不能放进 Vault Git worktree。请把 GIT_FLEET_HOME 改到 Vault 之外后重试。',
    );
  }
}

async function assertNotNestedInAnotherRepository(vaultPath: string): Promise<void> {
  const { ancestor } = await nearestExistingAncestor(vaultPath);
  const containingRepository = await gitTopLevel(ancestor);
  if (!containingRepository || containingRepository === vaultPath) return;
  if (isPathInside(containingRepository, vaultPath)) {
    throw new SessionVaultSafetyError(
      'path-overlaps-git-repository',
      'Session Vault 不能嵌套在另一个 Git 仓库中。请迁移到独立目录，或直接选择一个独立 Git 仓库的根目录。',
    );
  }
}

function assertCredentialFreeRemote(remoteUrl: string): void {
  if (!remoteUrl.includes('://')) return;
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password || url.search || url.hash) {
      throw new SessionVaultSafetyError(
        'remote-contains-credentials',
        'Session Vault 远端 URL 不能内嵌用户名、密码、Token、查询参数或片段。请改用 SSH Agent、Keychain 或 Git credential helper 后重试。',
      );
    }
  } catch (error) {
    if (error instanceof SessionVaultSafetyError) throw error;
  }
}

async function repositoryRemotes(repositoryPath: string): Promise<GitRemote[]> {
  const names = (await runGitText(repositoryPath, ['remote']).catch(() => ''))
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  const remotes: GitRemote[] = [];
  for (const name of names) {
    const urls = (await runGitText(repositoryPath, ['remote', 'get-url', '--all', name]).catch(() => ''))
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean);
    for (const url of urls) remotes.push({ name, url, normalizedUrl: normalizeRemoteUrl(url) });
  }
  return remotes;
}

function assertRemoteIsolated(remote: string | null, fleetRemotes: Set<string>): void {
  if (!remote || !fleetRemotes.has(remote)) return;
  throw new SessionVaultSafetyError(
    'remote-matches-fleet',
    'Session Vault 远端不能与 Moo Fleet 开源仓库远端相同。请新建一个独立的私有 Git 仓库，替换远端 URL 后再试。',
  );
}

async function prepareVaultRepository(vaultPath: string): Promise<PreparedVaultRepository> {
  if (!(await exists(vaultPath))) {
    await mkdir(vaultPath, { recursive: true, mode: 0o700 });
    await chmod(vaultPath, 0o700);
    await runGitText(vaultPath, ['init', '--initial-branch=main']);
    return { vaultPath: await realpath(vaultPath), initialized: true, remotes: [] };
  }

  const info = await stat(vaultPath);
  if (!info.isDirectory()) {
    throw new SessionVaultSafetyError('path-not-directory', 'Session Vault 路径必须是目录。请选择空目录或现有的独立 Git 仓库。');
  }
  const canonicalPath = await realpath(vaultPath);
  const topLevel = await gitTopLevel(canonicalPath);
  if (topLevel) {
    if (topLevel !== canonicalPath) {
      throw new SessionVaultSafetyError(
        'vault-repository-invalid',
        '选择的目录不是独立 Git worktree 根目录。请改选该 Vault 仓库根目录，或迁移到新的空目录。',
      );
    }
    return { vaultPath: canonicalPath, initialized: false, remotes: await repositoryRemotes(canonicalPath) };
  }

  if ((await readdir(canonicalPath)).length > 0) {
    throw new SessionVaultSafetyError(
      'path-not-empty',
      'Session Vault 只能初始化到空目录，或绑定一个现有的独立 Git 仓库。请清空无关文件或选择新目录后重试。',
    );
  }
  await chmod(canonicalPath, 0o700);
  await runGitText(canonicalPath, ['init', '--initial-branch=main']);
  return { vaultPath: canonicalPath, initialized: true, remotes: [] };
}

async function readVaultManifest(vaultPath: string): Promise<SessionVaultManifest | null> {
  const manifestPath = path.join(vaultPath, 'vault.yaml');
  if (!(await exists(manifestPath))) return null;
  try {
    return sessionVaultManifestSchema.parse(parse(await readFile(manifestPath, 'utf8')));
  } catch {
    throw new SessionVaultSafetyError(
      'vault-config-invalid',
      '现有 vault.yaml 无法识别。请先备份并修复该文件，或迁移到新的空 Vault 目录后重试。',
    );
  }
}

async function writeYamlAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, stringify(value, { indent: 2 }), { mode: 0o600 });
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

async function ensureVaultGitIgnore(vaultPath: string): Promise<void> {
  const ignorePath = path.join(vaultPath, '.gitignore');
  let contents = '';
  try {
    contents = await readFile(ignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = contents.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes('.fleet/')) return;
  const prefix = contents && !contents.endsWith('\n') ? `${contents}\n` : contents;
  await writeFile(ignorePath, `${prefix}.fleet/\n`, { mode: 0o600 });
  await chmod(ignorePath, 0o600);
}

function privacyState(remote: string | null, confirmed: boolean): SessionVaultPrivacyState {
  if (!remote) return 'local-only';
  return confirmed ? 'private-user-confirmed' : 'unconfirmed';
}

export function sessionVaultPrivacyLabel(state: SessionVaultPrivacyState): string {
  if (state === 'private-user-confirmed') return SESSION_VAULT_PRIVATE_LABEL;
  if (state === 'unconfirmed') return SESSION_VAULT_UNCONFIRMED_LABEL;
  return SESSION_VAULT_LOCAL_LABEL;
}

export async function loadSessionVaultBinding(
  options: SessionVaultServiceOptions = {},
): Promise<SessionVaultBinding | null> {
  const bindingPath = resolveSessionVaultBindingPath(options);
  if (!(await exists(bindingPath))) return null;
  try {
    return sessionVaultBindingSchema.parse(parse(await readFile(bindingPath, 'utf8')));
  } catch {
    throw new SessionVaultSafetyError(
      'vault-config-invalid',
      '本机 Session Vault 绑定配置无法识别。请备份后移走该配置，再重新绑定 Vault。',
    );
  }
}

export async function writeSessionVaultBinding(
  binding: SessionVaultBinding,
  options: SessionVaultServiceOptions = {},
): Promise<void> {
  await writeYamlAtomic(resolveSessionVaultBindingPath(options), sessionVaultBindingSchema.parse(binding));
}

export async function loadSessionVaultStatus(options: SessionVaultServiceOptions = {}): Promise<SessionVaultStatus> {
  const suggestedVaultPath = resolveSuggestedSessionVaultPath(options);
  const binding = await loadSessionVaultBinding(options);
  if (!binding) {
    return sessionVaultStatusSchema.parse({
      configured: false,
      binding: null,
      manifest: null,
      privacyLabel: SESSION_VAULT_LOCAL_LABEL,
      suggestedVaultPath,
    });
  }
  const manifest = await readVaultManifest(binding.vaultPath);
  return sessionVaultStatusSchema.parse({
    configured: Boolean(manifest),
    binding,
    manifest,
    privacyLabel: sessionVaultPrivacyLabel(binding.privacyState),
    suggestedVaultPath,
  });
}

export async function initializeSessionVault(
  request: InitializeSessionVaultRequest,
  options: SessionVaultServiceOptions = {},
): Promise<SessionVaultStatus> {
  const input = initializeSessionVaultSchema.parse(request);
  const now = options.now ?? new Date();
  const initializedAt = now.toISOString();
  const fleetRoot = await fleetGitRoot(options.fleetRepositoryPath ?? defaultFleetRepositoryPath());
  const plannedVaultPath = await canonicalPlannedPath(input.vaultPath);
  const bindingPath = await canonicalPlannedPath(resolveSessionVaultBindingPath(options));
  assertPathIsolated(fleetRoot, plannedVaultPath);
  assertBindingPathIsolated(fleetRoot, plannedVaultPath, bindingPath);
  await assertNotNestedInAnotherRepository(plannedVaultPath);
  if (input.remoteUrl) assertCredentialFreeRemote(input.remoteUrl);

  const fleetRemotes = new Set([
    ...officialFleetRemotes,
    ...(await repositoryRemotes(fleetRoot)).map((remote) => remote.normalizedUrl),
  ]);
  const requestedRemote = input.remoteUrl ? normalizeRemoteUrl(input.remoteUrl) : null;
  assertRemoteIsolated(requestedRemote, fleetRemotes);

  const preexistingManifest =
    (await exists(plannedVaultPath)) && (await stat(plannedVaultPath)).isDirectory()
      ? await readVaultManifest(plannedVaultPath)
      : null;
  const preexistingGitRoot = (await exists(plannedVaultPath)) ? await gitTopLevel(plannedVaultPath) : null;
  const preexistingRemotes =
    preexistingGitRoot === plannedVaultPath ? await repositoryRemotes(plannedVaultPath) : [];
  const preexistingSelectedRemote =
    preexistingRemotes.find((remote) => remote.name === input.remoteName) ?? preexistingRemotes[0] ?? null;
  if (input.enableRemoteSync && !requestedRemote && !preexistingSelectedRemote) {
    throw new SessionVaultSafetyError(
      'remote-required',
      '启用 Session Vault 远端同步前必须配置独立的私有 Git 远端。请填写远端 URL，或先保持仅本机保存。',
    );
  }
  if (
    input.enableRemoteSync &&
    requestedRemote &&
    input.confirmationPhrase.trim() !== SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION &&
    !(preexistingManifest?.remote?.privateConfirmed && preexistingManifest.remote.normalizedUrl === requestedRemote)
  ) {
    throw new SessionVaultSafetyError(
      'private-confirmation-required',
      `启用远端同步前请输入确认短语“${SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION}”。Fleet 不会自动声称该远端已验证为私有。`,
    );
  }

  const prepared = await prepareVaultRepository(plannedVaultPath);
  assertPathIsolated(fleetRoot, prepared.vaultPath);
  for (const remote of prepared.remotes) {
    assertCredentialFreeRemote(remote.url);
    assertRemoteIsolated(remote.normalizedUrl, fleetRemotes);
  }

  const namedRemote = prepared.remotes.find((remote) => remote.name === input.remoteName) ?? null;
  if (requestedRemote && namedRemote && namedRemote.normalizedUrl !== requestedRemote) {
    throw new SessionVaultSafetyError(
      'remote-conflict',
      `现有 Vault 的 ${input.remoteName} 远端与请求 URL 不一致。请先确认仓库归属，再使用新的独立目录或在 Git 中显式修复远端。`,
    );
  }
  const existingRemote = namedRemote ?? (!requestedRemote ? prepared.remotes[0] ?? null : null);
  const effectiveRemote = requestedRemote ?? existingRemote?.normalizedUrl ?? null;
  const effectiveRemoteName = requestedRemote ? input.remoteName : existingRemote?.name ?? input.remoteName;
  if (input.enableRemoteSync && !effectiveRemote) {
    throw new SessionVaultSafetyError(
      'remote-required',
      '启用 Session Vault 远端同步前必须配置独立的私有 Git 远端。请填写远端 URL，或先保持仅本机保存。',
    );
  }

  const existingManifest = await readVaultManifest(prepared.vaultPath);
  if (existingManifest?.remote && !effectiveRemote) {
    throw new SessionVaultSafetyError(
      'remote-conflict',
      'vault.yaml 声明该 Vault 应绑定远端，但 Git 远端已经不存在。请恢复远端或迁移到新的 Vault，Fleet 不会静默改成仅本机模式。',
    );
  }
  if (
    existingManifest?.remote?.normalizedUrl &&
    effectiveRemote &&
    existingManifest.remote.normalizedUrl !== effectiveRemote
  ) {
    throw new SessionVaultSafetyError(
      'remote-conflict',
      'vault.yaml 记录的远端与当前 Git 远端不一致。请先修复或迁移 Vault，Fleet 不会自动覆盖远端归属。',
    );
  }
  const existingConfirmation = Boolean(
    existingManifest?.remote?.privateConfirmed && existingManifest.remote.normalizedUrl === effectiveRemote,
  );
  const confirmed = existingConfirmation || input.confirmationPhrase.trim() === SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION;
  if (input.enableRemoteSync && !confirmed) {
    throw new SessionVaultSafetyError(
      'private-confirmation-required',
      `启用远端同步前请输入确认短语“${SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION}”。Fleet 不会自动声称该远端已验证为私有。`,
    );
  }

  if (input.remoteUrl && !namedRemote) {
    await runGitText(prepared.vaultPath, ['remote', 'add', input.remoteName, input.remoteUrl]);
  }

  const manifest = sessionVaultManifestSchema.parse({
    schemaVersion: 1,
    kind: 'moo-fleet-session-vault',
    privacyMode: 'plaintext-private',
    createdAt: existingManifest?.createdAt ?? initializedAt,
    remote: effectiveRemote
      ? {
          name: effectiveRemoteName,
          normalizedUrl: effectiveRemote,
          privateConfirmed: confirmed,
          confirmedAt: confirmed ? existingManifest?.remote?.confirmedAt ?? initializedAt : null,
        }
      : null,
  });
  const state = privacyState(effectiveRemote, confirmed);
  const binding = sessionVaultBindingSchema.parse({
    schemaVersion: 1,
    vaultPath: prepared.vaultPath,
    remoteSyncEnabled: input.enableRemoteSync,
    remoteName: effectiveRemote ? effectiveRemoteName : null,
    normalizedRemoteUrl: effectiveRemote,
    privacyState: state,
    initializedAt,
  });
  await ensureVaultGitIgnore(prepared.vaultPath);
  await writeYamlAtomic(path.join(prepared.vaultPath, 'vault.yaml'), manifest);
  await writeSessionVaultBinding(binding, { ...options, bindingPath });
  return sessionVaultStatusSchema.parse({
    configured: true,
    binding,
    manifest,
    privacyLabel: sessionVaultPrivacyLabel(state),
    suggestedVaultPath: resolveSuggestedSessionVaultPath(options),
  });
}
