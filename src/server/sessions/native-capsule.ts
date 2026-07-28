import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  NativeCapsuleFile,
  NativeCapsuleManifest,
} from '../../shared/native-capsule.js';
import { nativeCapsuleManifestSchema } from '../../shared/native-capsule.js';
import {
  providerPermissionFlag,
  type ProviderPermissionMode,
} from '../../shared/provider-command.js';
import type {
  DiscoveredSession,
  ProviderCapabilities,
  SessionProvider,
} from '../../shared/sessions.js';
import { shellQuote } from '../../shared/shell-command.js';
import { assertNoSecrets, redactSensitiveText } from './secrets.js';
import { encodeClaudeProjectPath } from './discovery.js';

const maximumNativeBytes = 50 * 1024 * 1024;
const projectToken = '{{MOO_FLEET_PROJECT}}';
const homeToken = '{{MOO_FLEET_HOME}}';
const nativeRecordPath = 'native/files/session-record.jsonl' as const;

export type NativeProviderFileOperation = 'stat' | 'read' | 'write' | 'remove';

export interface NativeProviderFileAccess {
  provider: SessionProvider;
  operation: NativeProviderFileOperation;
  path: string;
}

export interface NativeCapsuleCapture {
  manifest: NativeCapsuleManifest;
  recordContent: string | null;
}

export interface CaptureNativeCapsuleInput {
  session: DiscoveredSession;
  capabilities: ProviderCapabilities;
  claudeHome?: string;
  codexHome?: string;
  sourceUserHome?: string;
  now?: Date;
  maximumBytes?: number;
  onProviderFileAccess?: (access: NativeProviderFileAccess) => void | Promise<void>;
}

export interface NativeTargetInput {
  manifest: NativeCapsuleManifest;
  localProjectPath: string;
  permissionMode?: ProviderPermissionMode;
  claudeHome?: string;
  codexHome?: string;
  targetUserHome?: string;
}

export interface NativeTarget {
  absolutePath: string;
  displayPath: string;
  hydratedContent: string;
  sha256: string;
  nativeCommand: string;
}

interface SourceFileIdentity {
  providerHome: string;
  sourcePath: string;
  fileName: string;
  recordedAt: string | null;
  datePath: string | null;
}

interface SanitizedJsonl {
  content: string;
  tailTruncated: boolean;
  redactionsApplied: number;
}

export class NativeCapsuleError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'NativeCapsuleError';
    this.statusCode = statusCode;
  }
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function providerFormat(provider: SessionProvider): NativeCapsuleManifest['formatVersion'] {
  return provider === 'claude' ? 'claude-jsonl-v1' : 'codex-rollout-jsonl-v1';
}

function providerHome(
  provider: SessionProvider,
  input: Pick<CaptureNativeCapsuleInput, 'claudeHome' | 'codexHome'> | Pick<NativeTargetInput, 'claudeHome' | 'codexHome'>,
): string {
  const userHome = process.env.HOME ?? os.homedir();
  return path.resolve(provider === 'claude'
    ? (input.claudeHome ?? process.env.GIT_FLEET_CLAUDE_HOME ?? path.join(userHome, '.claude'))
    : (input.codexHome ?? process.env.GIT_FLEET_CODEX_HOME ?? path.join(userHome, '.codex')));
}

function inside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '原生会话文件无法安全捕获';
  return redactSensitiveText(message).slice(0, 2_000) || '原生会话文件无法安全捕获';
}

export function notCapturedNativeCapsule(
  provider: SessionProvider,
  providerSessionId: string,
  capturedAt: string,
  reason = '未选择把原生会话以脱敏明文写入私有 Vault',
): NativeCapsuleCapture {
  return {
    manifest: nativeCapsuleManifestSchema.parse({
      schemaVersion: 1,
      provider,
      providerSessionId,
      status: 'not-captured',
      providerVersion: null,
      formatVersion: null,
      capturedAt,
      files: [],
      restoreCheck: 'not-run',
      sourceTailTruncated: false,
      redactionsApplied: 0,
      reason,
    }),
    recordContent: null,
  };
}

function unsupportedNativeCapsule(
  input: CaptureNativeCapsuleInput,
  capturedAt: string,
  reason: string,
): NativeCapsuleCapture {
  return {
    manifest: nativeCapsuleManifestSchema.parse({
      schemaVersion: 1,
      provider: input.session.provider,
      providerSessionId: input.session.providerSessionId,
      status: 'unsupported',
      providerVersion: input.capabilities.version,
      formatVersion: providerFormat(input.session.provider),
      capturedAt,
      files: [],
      restoreCheck: 'unsupported',
      sourceTailTruncated: input.session.tailTruncated,
      redactionsApplied: 0,
      reason,
    }),
    recordContent: null,
  };
}

function parseCodexTimestamp(fileName: string): { recordedAt: string; datePath: string } | null {
  const match = fileName.match(
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:[.-](\d{1,9}))?(?:Z)?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const milliseconds = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : '.000';
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${milliseconds}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return { recordedAt: date.toISOString(), datePath: `${year}/${month}/${day}` };
}

async function sourceFileIdentity(input: CaptureNativeCapsuleInput): Promise<SourceFileIdentity> {
  const provider = input.session.provider;
  const configuredHome = providerHome(provider, input);
  const sourceInput = path.resolve(input.session.sourcePath);
  await input.onProviderFileAccess?.({ provider, operation: 'stat', path: sourceInput });
  const sourceInfo = await lstat(sourceInput);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new NativeCapsuleError('原生会话白名单路径不是普通文件，已降级通用恢复');
  }
  const [canonicalHome, sourcePath] = await Promise.all([realpath(configuredHome), realpath(sourceInput)]);
  if (!inside(canonicalHome, sourcePath)) throw new NativeCapsuleError('原生会话文件超出 provider home 白名单');
  if (/\.sqlite(?:-(?:wal|shm))?$/i.test(sourcePath)) throw new NativeCapsuleError('SQLite、WAL 与 SHM 文件禁止进入原生胶囊');

  const relativePath = path.relative(canonicalHome, sourcePath).split(path.sep).join('/');
  const fileName = path.basename(sourcePath);
  if (provider === 'claude') {
    const parts = relativePath.split('/');
    if (
      parts.length !== 3 ||
      parts[0] !== 'projects' ||
      !parts[1]?.startsWith('-') ||
      parts[2] !== `${input.session.providerSessionId}.jsonl`
    ) {
      throw new NativeCapsuleError('Claude 原生胶囊只允许 projects/<路径编码>/<sessionId>.jsonl');
    }
    return { providerHome: canonicalHome, sourcePath, fileName, recordedAt: input.session.createdAt, datePath: null };
  }

  const timestamp = parseCodexTimestamp(fileName);
  if (!timestamp || relativePath !== `sessions/${timestamp.datePath}/${fileName}`) {
    throw new NativeCapsuleError('Codex 原生胶囊只允许日期目录中的 rollout-*.jsonl');
  }
  if (!fileName.toLowerCase().endsWith(`-${input.session.providerSessionId.toLowerCase()}.jsonl`)) {
    throw new NativeCapsuleError('Codex rollout 文件名与 provider session ID 不一致');
  }
  return { providerHome: canonicalHome, sourcePath, fileName, ...timestamp };
}

function replacementCount(text: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(search, offset)) >= 0) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function transformStrings(
  value: unknown,
  transform: (value: string) => string,
): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((item) => transformStrings(item, transform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, transformStrings(item, transform)]),
    );
  }
  return value;
}

function transformJsonl(content: string, transform: (value: string) => string): { content: string; tailTruncated: boolean } {
  const lines = content.split(/\r?\n/);
  let lastNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      lastNonEmpty = index;
      break;
    }
  }
  const transformed: string[] = [];
  let tailTruncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === lastNonEmpty) {
        tailTruncated = true;
        continue;
      }
      throw new NativeCapsuleError('原生 JSONL 含非尾部损坏记录，无法生成可验证胶囊');
    }
    transformed.push(JSON.stringify(transformStrings(parsed, transform)));
  }
  if (transformed.length === 0) throw new NativeCapsuleError('原生 JSONL 没有可用记录');
  return { content: `${transformed.join('\n')}\n`, tailTruncated };
}

function sanitizeJsonl(
  content: string,
  sourceProjectPath: string,
  sourceUserHome: string,
  sourceProviderHome: string,
): SanitizedJsonl {
  if (content.includes(projectToken) || content.includes(homeToken)) {
    throw new NativeCapsuleError('原生 JSONL 含 Fleet 保留路径标记，已降级通用恢复以避免内容误改写');
  }
  const replacements = [
    [path.resolve(sourceProjectPath), projectToken],
    [path.resolve(sourceProviderHome), `${homeToken}/${path.basename(sourceProviderHome)}`],
    [path.resolve(sourceUserHome), homeToken],
  ] as const;
  let redactionsApplied = 0;
  const transformed = transformJsonl(content, (value) => {
    let next = value;
    for (const [source, replacement] of replacements) {
      const count = replacementCount(next, source);
      if (count > 0) {
        redactionsApplied += count;
        next = next.replaceAll(source, replacement);
      }
    }
    const redacted = redactSensitiveText(next);
    if (redacted !== next) redactionsApplied += 1;
    return redacted;
  });
  for (const [source] of replacements) {
    if (transformed.content.includes(source)) throw new NativeCapsuleError('原生胶囊仍含源机器绝对路径，已停止捕获');
  }
  assertNoSecrets([{ path: nativeRecordPath, content: transformed.content }]);
  return { ...transformed, redactionsApplied };
}

export async function captureNativeCapsule(input: CaptureNativeCapsuleInput): Promise<NativeCapsuleCapture> {
  const capturedAt = (input.now ?? new Date()).toISOString();
  if (
    input.capabilities.provider !== input.session.provider ||
    input.capabilities.state !== 'supported' ||
    !input.capabilities.nativeResume ||
    !input.capabilities.version
  ) {
    return unsupportedNativeCapsule(input, capturedAt, input.capabilities.reason ?? '当前 provider 原生恢复能力未通过探测');
  }
  if (!input.session.projectPath) {
    return unsupportedNativeCapsule(input, capturedAt, '会话没有可验证的项目路径，无法生成可移植原生胶囊');
  }

  try {
    const identity = await sourceFileIdentity(input);
    const info = await lstat(identity.sourcePath);
    const maximumBytes = input.maximumBytes ?? maximumNativeBytes;
    if (info.size <= 0 || info.size > maximumBytes) {
      throw new NativeCapsuleError(`原生会话文件大小超出 1–${maximumBytes} 字节白名单`);
    }
    await input.onProviderFileAccess?.({ provider: input.session.provider, operation: 'read', path: identity.sourcePath });
    const source = await readFile(identity.sourcePath, 'utf8');
    const sourceUserHome = path.resolve(input.sourceUserHome ?? process.env.HOME ?? os.homedir());
    const sanitized = sanitizeJsonl(source, input.session.projectPath, sourceUserHome, identity.providerHome);
    const bytes = Buffer.byteLength(sanitized.content);
    if (bytes <= 0 || bytes > maximumBytes) throw new NativeCapsuleError('脱敏后的原生会话文件超过胶囊大小上限');
    const file: NativeCapsuleFile = {
      path: nativeRecordPath,
      fileName: identity.fileName,
      sha256: digest(sanitized.content),
      bytes,
      recordedAt: identity.recordedAt,
      datePath: identity.datePath,
    };
    return {
      manifest: nativeCapsuleManifestSchema.parse({
        schemaVersion: 1,
        provider: input.session.provider,
        providerSessionId: input.session.providerSessionId,
        status: 'verified',
        providerVersion: input.capabilities.version,
        formatVersion: providerFormat(input.session.provider),
        capturedAt,
        files: [file],
        restoreCheck: 'passed',
        sourceTailTruncated: sanitized.tailTruncated,
        redactionsApplied: sanitized.redactionsApplied,
        reason: null,
      }),
      recordContent: sanitized.content,
    };
  } catch (error) {
    return unsupportedNativeCapsule(input, capturedAt, safeReason(error));
  }
}

export function providerVersionsCompatible(captured: string | null, local: string | null): boolean {
  return Boolean(captured && local && captured.trim() === local.trim());
}

function hydrateJsonl(content: string, localProjectPath: string, targetUserHome: string): string {
  return transformJsonl(content, (value) => value
    .replaceAll(projectToken, path.resolve(localProjectPath))
    .replaceAll(homeToken, path.resolve(targetUserHome))).content;
}

function displayProviderPath(provider: SessionProvider, relativePath: string): string {
  return provider === 'claude' ? `~/.claude/${relativePath}` : `~/.codex/${relativePath}`;
}

export function buildNativeTarget(input: NativeTargetInput, recordContent: string): NativeTarget {
  const manifest = nativeCapsuleManifestSchema.parse(input.manifest);
  if (manifest.status !== 'verified' || manifest.files.length !== 1) {
    throw new NativeCapsuleError('Checkpoint 没有已验证的原生胶囊');
  }
  const file = manifest.files[0]!;
  if (Buffer.byteLength(recordContent) !== file.bytes || digest(recordContent) !== file.sha256) {
    throw new NativeCapsuleError('原生胶囊文件 checksum 或大小不匹配，已停止还原');
  }
  const configuredHome = providerHome(manifest.provider, input);
  const targetUserHome = path.resolve(
    input.targetUserHome ?? process.env.GIT_FLEET_PROVIDER_USER_HOME ?? process.env.HOME ?? os.homedir(),
  );
  const relativePath = manifest.provider === 'claude'
    ? path.posix.join('projects', encodeClaudeProjectPath(input.localProjectPath), `${manifest.providerSessionId}.jsonl`)
    : path.posix.join('sessions', file.datePath ?? '', file.fileName);
  if (
    relativePath.includes('\\') ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith('../') ||
    relativePath.includes('/../') ||
    (manifest.provider === 'codex' && !file.datePath)
  ) {
    throw new NativeCapsuleError('原生胶囊目标路径不符合 provider 白名单');
  }
  const absolutePath = path.resolve(configuredHome, ...relativePath.split('/'));
  if (!inside(configuredHome, absolutePath)) throw new NativeCapsuleError('原生胶囊目标路径超出 provider home');
  const hydratedContent = hydrateJsonl(recordContent, input.localProjectPath, targetUserHome);
  assertNoSecrets([{ path: nativeRecordPath, content: hydratedContent }]);
  const permissionFlag = providerPermissionFlag(manifest.provider, input.permissionMode ?? 'standard');
  const permissionSegment = permissionFlag ? ` ${shellQuote(permissionFlag)}` : '';
  const nativeCommand = manifest.provider === 'claude'
    ? `claude${permissionSegment} --resume ${shellQuote(manifest.providerSessionId)}`
    : `codex${permissionSegment} resume ${shellQuote(manifest.providerSessionId)}`;
  return {
    absolutePath,
    displayPath: displayProviderPath(manifest.provider, relativePath),
    hydratedContent,
    sha256: digest(hydratedContent),
    nativeCommand,
  };
}

export function nativeRecordRelativePath(): typeof nativeRecordPath {
  return nativeRecordPath;
}
