import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  NativeRollbackResult,
  NativeRestoreResult,
  NativeRestorePlan,
} from '../../shared/native-capsule.js';
import {
  nativeRollbackResultSchema,
  nativeRestorePlanSchema,
  nativeRestoreResultSchema,
} from '../../shared/native-capsule.js';
import type { ProviderPermissionMode } from '../../shared/provider-command.js';
import type { ProviderCapabilities } from '../../shared/sessions.js';
import { appRoot } from '../config/store.js';
import type { SessionNativeCapsulePayload } from './catalog.js';
import {
  buildNativeTarget,
  providerVersionsCompatible,
  type NativeProviderFileAccess,
  type NativeTarget,
} from './native-capsule.js';

export interface InspectNativeRestoreInput {
  capsule: SessionNativeCapsulePayload;
  localProjectPath: string | null;
  localCapabilities: ProviderCapabilities;
  claudeHome?: string;
  codexHome?: string;
  targetUserHome?: string;
  permissionMode?: ProviderPermissionMode;
  onProviderFileAccess?: (access: NativeProviderFileAccess) => void | Promise<void>;
}

export interface InspectedNativeRestore {
  plan: NativeRestorePlan;
  target: NativeTarget | null;
}

export interface ExecuteNativeRestoreInput extends InspectNativeRestoreInput {
  expectedFingerprint: string;
  backupDirectory?: string;
  now?: Date;
  testHook?: (phase: 'after-backup' | 'after-target-write') => void | Promise<void>;
}

export interface RollbackNativeRestoreInput {
  sessionId: string;
  backupId: string;
  expectedInstalledSha256: string;
  backupDirectory?: string;
  claudeHome?: string;
  codexHome?: string;
  now?: Date;
  onProviderFileAccess?: (access: NativeProviderFileAccess) => void | Promise<void>;
}

const nativeBackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  backupId: z.string().uuid(),
  sessionId: z.string().min(1).max(255),
  checkpointId: z.string().min(1).max(255),
  provider: z.enum(['claude', 'codex']),
  providerSessionId: z.string().min(1).max(255),
  targetPath: z.string().min(1).max(4_000),
  targetDisplayPath: z.string().min(1).max(4_000),
  originalExisted: z.boolean(),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  originalBytes: z.number().int().nonnegative(),
  installedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['prepared', 'installed', 'restore-failed', 'rolled-back']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  automaticallyRolledBack: z.boolean(),
  failureMessage: z.string().max(2_000).nullable(),
}).strict();
type NativeBackupManifest = z.infer<typeof nativeBackupManifestSchema>;

export class NativeRestoreError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'NativeRestoreError';
    this.statusCode = statusCode;
  }
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function unavailable(
  input: InspectNativeRestoreInput,
  status: NativeRestorePlan['status'],
  message: string,
  localVersion = input.localCapabilities.version,
): InspectedNativeRestore {
  const { manifest } = input.capsule;
  return {
    plan: nativeRestorePlanSchema.parse({
      schemaVersion: 1,
      status,
      provider: manifest.provider,
      providerSessionId: manifest.providerSessionId,
      providerVersionAtCapture: manifest.providerVersion,
      localProviderVersion: localVersion,
      formatVersion: manifest.formatVersion,
      available: false,
      action: 'unavailable',
      targetDisplayPath: null,
      targetExists: false,
      backupRequired: false,
      capsuleSha256: manifest.files[0]?.sha256 ?? null,
      currentTargetSha256: null,
      expectedTargetSha256: null,
      fingerprint: null,
      nativeCommand: null,
      message,
    }),
    target: null,
  };
}

async function currentTarget(
  input: InspectNativeRestoreInput,
  target: NativeTarget,
): Promise<{ exists: boolean; sha256: string | null }> {
  const provider = input.capsule.manifest.provider;
  const configuredHome = path.resolve(provider === 'claude'
    ? (input.claudeHome ?? process.env.GIT_FLEET_CLAUDE_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.claude'))
    : (input.codexHome ?? process.env.GIT_FLEET_CODEX_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.codex')));
  if (!pathInside(configuredHome, target.absolutePath)) {
    throw new NativeRestoreError('原生还原目标超出 provider home');
  }
  let canonicalHome: string;
  try {
    canonicalHome = await realpath(configuredHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, sha256: null };
    throw error;
  }
  let existingParent = path.dirname(target.absolutePath);
  while (true) {
    try {
      const canonicalParent = await realpath(existingParent);
      const parentInfo = await lstat(canonicalParent);
      if (!parentInfo.isDirectory()) throw new NativeRestoreError('原生还原目标父路径不是目录');
      if (!pathInside(canonicalHome, canonicalParent)) {
        throw new NativeRestoreError('原生还原目标目录通过符号链接逃逸 provider home，已停止读取');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existingParent);
      if (parent === existingParent || !pathInside(configuredHome, parent)) {
        throw new NativeRestoreError('无法验证原生还原目标目录边界');
      }
      existingParent = parent;
    }
  }
  await input.onProviderFileAccess?.({
    provider,
    operation: 'stat',
    path: target.absolutePath,
  });
  try {
    const info = await lstat(target.absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('目标 provider 会话路径不是普通文件，已停止还原');
    }
    if (info.size > 50 * 1024 * 1024) throw new Error('目标 provider 会话文件超过 50 MB 安全读取上限');
    await input.onProviderFileAccess?.({
      provider,
      operation: 'read',
      path: target.absolutePath,
    });
    return { exists: true, sha256: digest(await readFile(target.absolutePath)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, sha256: null };
    throw error;
  }
}

export async function inspectNativeRestore(input: InspectNativeRestoreInput): Promise<InspectedNativeRestore> {
  const { manifest, recordContent, checkpoint } = input.capsule;
  if (manifest.status !== 'verified' || !recordContent) {
    return unavailable(
      input,
      manifest.status === 'restore-failed' ? 'restore-failed' : manifest.status,
      manifest.reason ?? '该 checkpoint 没有可还原的原生胶囊，继续使用通用恢复',
    );
  }
  if (!input.localProjectPath) {
    return unavailable(input, 'verified', '先完成本机项目路径映射，才能计算 provider 原生落点');
  }
  if (
    input.localCapabilities.provider !== manifest.provider ||
    input.localCapabilities.state !== 'supported' ||
    !input.localCapabilities.nativeResume
  ) {
    return unavailable(
      input,
      'unsupported',
      input.localCapabilities.reason ?? '目标机 provider 原生 resume 能力未通过探测，已降级通用恢复',
    );
  }
  if (!providerVersionsCompatible(manifest.providerVersion, input.localCapabilities.version)) {
    return unavailable(
      input,
      'unsupported',
      `Provider 版本不一致（捕获 ${manifest.providerVersion ?? '未知'} / 本机 ${input.localCapabilities.version ?? '未知'}），不会写入原生目录`,
    );
  }

  try {
    const target = buildNativeTarget({
      manifest,
      localProjectPath: input.localProjectPath,
      claudeHome: input.claudeHome,
      codexHome: input.codexHome,
      targetUserHome: input.targetUserHome,
      permissionMode: input.permissionMode,
    }, recordContent);
    const current = await currentTarget(input, target);
    const alreadyPresent = current.sha256 === target.sha256;
    const fingerprint = digest(JSON.stringify({
      sessionId: checkpoint.sessionId,
      checkpointId: checkpoint.checkpointId,
      projectId: checkpoint.projectId,
      localProjectPath: input.localProjectPath,
      provider: manifest.provider,
      providerSessionId: manifest.providerSessionId,
      capturedVersion: manifest.providerVersion,
      localVersion: input.localCapabilities.version,
      capsuleSha256: manifest.files[0]?.sha256,
      expectedTargetSha256: target.sha256,
      currentTargetSha256: current.sha256,
      targetPath: target.absolutePath,
      permissionMode: input.permissionMode ?? 'standard',
      nativeCommand: target.nativeCommand,
    }));
    return {
      plan: nativeRestorePlanSchema.parse({
        schemaVersion: 1,
        status: 'verified',
        provider: manifest.provider,
        providerSessionId: manifest.providerSessionId,
        providerVersionAtCapture: manifest.providerVersion,
        localProviderVersion: input.localCapabilities.version,
        formatVersion: manifest.formatVersion,
        available: true,
        action: alreadyPresent ? 'already-present' : current.exists ? 'replace-with-backup' : 'install',
        targetDisplayPath: target.displayPath,
        targetExists: current.exists,
        backupRequired: current.exists && !alreadyPresent,
        capsuleSha256: manifest.files[0]?.sha256 ?? null,
        currentTargetSha256: current.sha256,
        expectedTargetSha256: target.sha256,
        fingerprint,
        nativeCommand: target.nativeCommand,
        message: alreadyPresent
          ? '目标机已存在完全一致的原生会话文件，可直接使用 provider resume'
          : current.exists
            ? '原生胶囊兼容；确认后会先备份现有会话文件，再原子替换'
            : '原生胶囊兼容；确认后会创建目标会话文件，不读取或写入任何 SQLite',
      }),
      target,
    };
  } catch (error) {
    return unavailable(
      input,
      'unsupported',
      error instanceof NativeRestoreError
        ? error.message
        : '原生胶囊 dry-run 失败，已降级通用恢复',
    );
  }
}

function resolvedBackupDirectory(directory?: string): string {
  return path.resolve(directory ?? path.join(appRoot, '.data', 'session-native-backups'));
}

function backupPaths(directory: string | undefined, backupId: string): {
  root: string;
  directory: string;
  manifest: string;
  original: string;
} {
  const root = resolvedBackupDirectory(directory);
  const backupDirectory = path.join(root, backupId);
  return {
    root,
    directory: backupDirectory,
    manifest: path.join(backupDirectory, 'manifest.json'),
    original: path.join(backupDirectory, 'original.jsonl'),
  };
}

function configuredProviderHome(
  provider: 'claude' | 'codex',
  options: Pick<ExecuteNativeRestoreInput, 'claudeHome' | 'codexHome'> | Pick<RollbackNativeRestoreInput, 'claudeHome' | 'codexHome'>,
): string {
  const userHome = process.env.HOME ?? os.homedir();
  return path.resolve(provider === 'claude'
    ? (options.claudeHome ?? process.env.GIT_FLEET_CLAUDE_HOME ?? path.join(userHome, '.claude'))
    : (options.codexHome ?? process.env.GIT_FLEET_CODEX_HOME ?? path.join(userHome, '.codex')));
}

function pathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function writeBackupManifest(filePath: string, manifest: NativeBackupManifest): Promise<void> {
  const parsed = nativeBackupManifestSchema.parse(manifest);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

async function secureProviderParent(
  provider: 'claude' | 'codex',
  targetPath: string,
  options: Pick<ExecuteNativeRestoreInput, 'claudeHome' | 'codexHome'> | Pick<RollbackNativeRestoreInput, 'claudeHome' | 'codexHome'>,
): Promise<void> {
  const configuredHome = configuredProviderHome(provider, options);
  if (!pathInside(configuredHome, targetPath)) throw new NativeRestoreError('原生还原目标超出 provider home');
  await mkdir(configuredHome, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const [canonicalHome, canonicalParent] = await Promise.all([
    realpath(configuredHome),
    realpath(path.dirname(targetPath)),
  ]);
  if (!pathInside(canonicalHome, canonicalParent)) {
    throw new NativeRestoreError('原生还原目标目录通过符号链接逃逸 provider home，已停止写入');
  }
  try {
    const info = await lstat(targetPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new NativeRestoreError('原生还原目标不是普通文件');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeProviderFileAtomically(
  provider: 'claude' | 'codex',
  targetPath: string,
  content: string | Buffer,
  options: Pick<ExecuteNativeRestoreInput, 'claudeHome' | 'codexHome' | 'onProviderFileAccess'> | Pick<RollbackNativeRestoreInput, 'claudeHome' | 'codexHome' | 'onProviderFileAccess'>,
  suffix: string,
): Promise<void> {
  await secureProviderParent(provider, targetPath, options);
  const temporaryPath = path.join(path.dirname(targetPath), `.moo-fleet-${suffix}.tmp`);
  try {
    await options.onProviderFileAccess?.({ provider, operation: 'write', path: temporaryPath });
    await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' });
    await options.onProviderFileAccess?.({ provider, operation: 'write', path: targetPath });
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function providerFile(
  provider: 'claude' | 'codex',
  targetPath: string,
  options: Pick<ExecuteNativeRestoreInput, 'onProviderFileAccess'> | Pick<RollbackNativeRestoreInput, 'onProviderFileAccess'>,
): Promise<Buffer | null> {
  await options.onProviderFileAccess?.({ provider, operation: 'stat', path: targetPath });
  try {
    const info = await lstat(targetPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new NativeRestoreError('原生会话目标不是普通文件');
    if (info.size > 50 * 1024 * 1024) throw new NativeRestoreError('原生会话目标超过 50 MB 安全读取上限');
    await options.onProviderFileAccess?.({ provider, operation: 'read', path: targetPath });
    return readFile(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function prepareBackup(
  input: ExecuteNativeRestoreInput,
  inspected: InspectedNativeRestore,
): Promise<{ manifest: NativeBackupManifest; paths: ReturnType<typeof backupPaths>; original: Buffer | null }> {
  const target = inspected.target;
  if (!target || !inspected.plan.fingerprint) throw new NativeRestoreError('原生还原计划不完整');
  const provider = input.capsule.manifest.provider;
  const original = await providerFile(provider, target.absolutePath, input);
  const originalSha256 = original ? digest(original) : null;
  if (originalSha256 !== inspected.plan.currentTargetSha256) {
    throw new NativeRestoreError('目标 provider 会话文件已变化，请重新执行 dry-run');
  }
  const backupId = randomUUID();
  const paths = backupPaths(input.backupDirectory, backupId);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.directory, { mode: 0o700 });
  if (original) await writeFile(paths.original, original, { mode: 0o600, flag: 'wx' });
  const now = (input.now ?? new Date()).toISOString();
  const manifest = nativeBackupManifestSchema.parse({
    schemaVersion: 1,
    backupId,
    sessionId: input.capsule.checkpoint.sessionId,
    checkpointId: input.capsule.checkpoint.checkpointId,
    provider,
    providerSessionId: input.capsule.manifest.providerSessionId,
    targetPath: target.absolutePath,
    targetDisplayPath: target.displayPath,
    originalExisted: original !== null,
    originalSha256,
    originalBytes: original?.byteLength ?? 0,
    installedSha256: target.sha256,
    state: 'prepared',
    createdAt: now,
    updatedAt: now,
    automaticallyRolledBack: false,
    failureMessage: null,
  });
  await writeBackupManifest(paths.manifest, manifest);
  return { manifest, paths, original };
}

async function restoreOriginal(
  manifest: NativeBackupManifest,
  original: Buffer | null,
  options: Pick<ExecuteNativeRestoreInput, 'claudeHome' | 'codexHome' | 'onProviderFileAccess'> | Pick<RollbackNativeRestoreInput, 'claudeHome' | 'codexHome' | 'onProviderFileAccess'>,
): Promise<void> {
  if (manifest.originalExisted) {
    if (!original || digest(original) !== manifest.originalSha256) {
      throw new NativeRestoreError('原生还原备份 checksum 不匹配，已保留现场');
    }
    await writeProviderFileAtomically(
      manifest.provider,
      manifest.targetPath,
      original,
      options,
      `${manifest.backupId}-rollback`,
    );
    return;
  }
  await options.onProviderFileAccess?.({ provider: manifest.provider, operation: 'remove', path: manifest.targetPath });
  await rm(manifest.targetPath, { force: true });
}

export async function executeNativeRestore(input: ExecuteNativeRestoreInput): Promise<NativeRestoreResult> {
  const inspected = await inspectNativeRestore(input);
  const { plan, target } = inspected;
  if (!plan.available || !target || !plan.fingerprint) {
    throw new NativeRestoreError(plan.message);
  }
  if (plan.fingerprint !== input.expectedFingerprint) {
    throw new NativeRestoreError('原生还原 dry-run 已过期，请重新预检后确认');
  }
  const checkpoint = input.capsule.checkpoint;
  if (plan.action === 'already-present') {
    return nativeRestoreResultSchema.parse({
      schemaVersion: 1,
      status: 'verified',
      sessionId: checkpoint.sessionId,
      checkpointId: checkpoint.checkpointId,
      action: 'already-present',
      targetDisplayPath: target.displayPath,
      installedSha256: target.sha256,
      backupId: null,
      backupExists: false,
      rollbackAvailable: false,
      automaticallyRolledBack: false,
      universalFallbackAvailable: true,
      nativeCommand: target.nativeCommand,
      message: '目标机已有完全一致的原生会话文件，无需重复写入',
    });
  }

  let backup: Awaited<ReturnType<typeof prepareBackup>> | null = null;
  let targetWriteAttempted = false;
  try {
    backup = await prepareBackup(input, inspected);
    await input.testHook?.('after-backup');
    targetWriteAttempted = true;
    await writeProviderFileAtomically(
      input.capsule.manifest.provider,
      target.absolutePath,
      target.hydratedContent,
      input,
      backup.manifest.backupId,
    );
    await input.testHook?.('after-target-write');
    const installed = await providerFile(input.capsule.manifest.provider, target.absolutePath, input);
    if (!installed || digest(installed) !== target.sha256) {
      throw new NativeRestoreError('写入后的原生会话文件 checksum 校验失败');
    }
    const installedManifest = nativeBackupManifestSchema.parse({
      ...backup.manifest,
      state: 'installed',
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    await writeBackupManifest(backup.paths.manifest, installedManifest);
    return nativeRestoreResultSchema.parse({
      schemaVersion: 1,
      status: 'verified',
      sessionId: checkpoint.sessionId,
      checkpointId: checkpoint.checkpointId,
      action: backup.manifest.originalExisted ? 'replaced' : 'installed',
      targetDisplayPath: target.displayPath,
      installedSha256: target.sha256,
      backupId: backup.manifest.backupId,
      backupExists: true,
      rollbackAvailable: true,
      automaticallyRolledBack: false,
      universalFallbackAvailable: true,
      nativeCommand: target.nativeCommand,
      message: backup.manifest.originalExisted
        ? '原生会话已写入；原文件备份完整保留，可一键回滚'
        : '原生会话已写入；已记录“原文件不存在”备份状态，可一键移除还原',
    });
  } catch (error) {
    let automaticallyRolledBack = false;
    if (backup) {
      try {
        await restoreOriginal(backup.manifest, backup.original, input);
        automaticallyRolledBack = true;
      } catch {
        automaticallyRolledBack = false;
      }
      const failedManifest = nativeBackupManifestSchema.parse({
        ...backup.manifest,
        state: 'restore-failed',
        updatedAt: (input.now ?? new Date()).toISOString(),
        automaticallyRolledBack,
        failureMessage: (error instanceof Error ? error.message : '原生还原失败').slice(0, 2_000),
      });
      await writeBackupManifest(backup.paths.manifest, failedManifest).catch(() => undefined);
    }
    return nativeRestoreResultSchema.parse({
      schemaVersion: 1,
      status: 'restore-failed',
      sessionId: checkpoint.sessionId,
      checkpointId: checkpoint.checkpointId,
      action: 'failed',
      targetDisplayPath: target.displayPath,
      installedSha256: backup && targetWriteAttempted && !automaticallyRolledBack ? target.sha256 : null,
      backupId: backup?.manifest.backupId ?? null,
      backupExists: Boolean(backup),
      rollbackAvailable: Boolean(backup && targetWriteAttempted && !automaticallyRolledBack),
      automaticallyRolledBack,
      universalFallbackAvailable: true,
      nativeCommand: null,
      message: automaticallyRolledBack
        ? '原生还原失败，已自动恢复写入前状态；通用恢复仍可继续使用'
        : '原生还原失败，备份与通用交接仍保留；请先回滚或改用通用恢复',
    });
  }
}

async function readBackupManifest(input: RollbackNativeRestoreInput): Promise<{
  manifest: NativeBackupManifest;
  paths: ReturnType<typeof backupPaths>;
}> {
  const paths = backupPaths(input.backupDirectory, input.backupId);
  let manifest: NativeBackupManifest;
  try {
    manifest = nativeBackupManifestSchema.parse(JSON.parse(await readFile(paths.manifest, 'utf8')));
  } catch {
    throw new NativeRestoreError('原生还原备份不存在或 manifest 已损坏', 404);
  }
  if (manifest.backupId !== input.backupId || manifest.sessionId !== input.sessionId) {
    throw new NativeRestoreError('原生还原备份与当前会话身份不一致');
  }
  return { manifest, paths };
}

export async function rollbackNativeRestore(input: RollbackNativeRestoreInput): Promise<NativeRollbackResult> {
  const { manifest, paths } = await readBackupManifest(input);
  if (!['installed', 'restore-failed'].includes(manifest.state)) {
    throw new NativeRestoreError(manifest.state === 'rolled-back' ? '该原生还原已经回滚' : '原生还原尚未完成，不能回滚');
  }
  if (manifest.installedSha256 !== input.expectedInstalledSha256) {
    throw new NativeRestoreError('回滚确认的安装 checksum 与备份记录不一致');
  }
  const configuredHome = configuredProviderHome(manifest.provider, input);
  if (!pathInside(configuredHome, manifest.targetPath)) {
    throw new NativeRestoreError('备份记录的 provider 目标路径超出当前 provider home');
  }
  const current = await providerFile(manifest.provider, manifest.targetPath, input);
  if (!current || digest(current) !== input.expectedInstalledSha256) {
    throw new NativeRestoreError('原生会话文件在还原后又发生变化，为避免覆盖新内容已停止回滚');
  }
  const original = manifest.originalExisted ? await readFile(paths.original) : null;
  if (
    manifest.originalExisted &&
    (!original || original.byteLength !== manifest.originalBytes || digest(original) !== manifest.originalSha256)
  ) {
    throw new NativeRestoreError('原生还原备份文件 checksum 或大小不匹配，已停止回滚');
  }
  await restoreOriginal(manifest, original, input);
  const rolledBackAt = (input.now ?? new Date()).toISOString();
  await writeBackupManifest(paths.manifest, nativeBackupManifestSchema.parse({
    ...manifest,
    state: 'rolled-back',
    updatedAt: rolledBackAt,
  }));
  return nativeRollbackResultSchema.parse({
    schemaVersion: 1,
    sessionId: manifest.sessionId,
    checkpointId: manifest.checkpointId,
    backupId: manifest.backupId,
    targetDisplayPath: manifest.targetDisplayPath,
    restoredOriginal: manifest.originalExisted,
    removedInstalledFile: !manifest.originalExisted,
    message: manifest.originalExisted
      ? '已从 Fleet 本机备份恢复原 provider 会话文件'
      : '写入前目标文件不存在，已移除本次安装的原生会话文件',
  });
}
