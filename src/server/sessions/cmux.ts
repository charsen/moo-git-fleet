import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { ProviderCapabilities, SessionProvider } from '../../shared/sessions.js';
import {
  cmuxCapabilitySchema,
  cmuxConfigSchema,
  cmuxOpenResultSchema,
  cmuxSettingsStatusSchema,
  recoveryLaunchSchema,
  type CmuxCapability,
  type CmuxConfig,
  type CmuxOpenResult,
  type CmuxSettingsStatus,
  type RecoveryLaunch,
} from '../../shared/cmux.js';
import { cdCommand, shellQuote } from '../../shared/shell-command.js';
import { appRoot } from '../config/store.js';
import { loadProviderCapabilityCache } from './probe.js';

const maximumProbeOutputBytes = 64 * 1_024;
const configQueues = new Map<string, Promise<void>>();

export const defaultCmuxConfig: CmuxConfig = {
  version: 1,
  providerTemplates: {
    claude: '{{executable}} "$(cat {{promptFile}})"',
    codex: '{{executable}} -C {{cwd}} "$(cat {{promptFile}})"',
  },
};

export class CmuxBridgeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'CmuxBridgeError';
    this.statusCode = statusCode;
  }
}

export interface CmuxProbeOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  now?: Date;
}

export interface RecoveryLaunchOptions extends CmuxProbeOptions {
  configPath?: string;
  promptDirectory?: string;
  capabilityCachePath?: string;
  cmuxCapability?: CmuxCapability;
  providerCapability?: ProviderCapabilities | null;
}

export interface RecoveryLaunchInput {
  provider: SessionProvider;
  providerSessionId: string;
  sessionId: string;
  checkpointId: string;
  title: string;
  localPath: string;
  workspaceFingerprint: string;
  recoveryPrompt: string;
  recoveryAvailable: boolean;
}

function resolvedConfigPath(configPath?: string): string {
  return path.resolve(configPath ?? path.join(appRoot, 'config', 'cmux.yaml'));
}

function resolvedPromptDirectory(promptDirectory?: string): string {
  return path.resolve(promptDirectory ?? path.join(appRoot, '.data', 'session-recovery-prompts'));
}

export function cmuxConfigPath(): string {
  return resolvedConfigPath();
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    const explicitPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await executableFile(explicitPath)) ? explicitPath : null;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      if (await executableFile(candidate)) return candidate;
    }
  }
  return null;
}

async function commandVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null; timedOut: boolean; failedToStart: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      const remaining = maximumProbeOutputBytes - bytes;
      if (remaining <= 0) return;
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      bytes += kept.byteLength;
    };
    const finish = (result: { output: string; exitCode: number | null; timedOut: boolean; failedToStart: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 500);
      force.unref();
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', () => finish({ output: '', exitCode: null, timedOut: false, failedToStart: true }));
    child.once('close', (exitCode) => finish({
      output: Buffer.concat(chunks).toString('utf8').trim(),
      exitCode,
      timedOut,
      failedToStart: false,
    }));
  });
}

function firstOutputLine(output: string): string | null {
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 1_000) ?? null;
}

export async function probeCmux(options: CmuxProbeOptions = {}): Promise<CmuxCapability> {
  const command = options.command ?? 'cmux';
  const env = { ...process.env, ...(options.env ?? {}) };
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const detectedAt = (options.now ?? new Date()).toISOString();
  const executablePath = await findExecutable(command, env, cwd);
  if (!executablePath) {
    return cmuxCapabilitySchema.parse({
      schemaVersion: 1,
      state: 'unavailable',
      command,
      executablePath: null,
      version: null,
      detectedAt,
      message: '本机未检测到 cmux；恢复操作会继续使用复制指令，不视为错误。',
    });
  }
  const version = await commandVersion(executablePath, env, cwd, options.timeoutMs ?? 3_000);
  if (version.failedToStart || version.timedOut || version.exitCode !== 0) {
    return cmuxCapabilitySchema.parse({
      schemaVersion: 1,
      state: 'unknown',
      command,
      executablePath,
      version: firstOutputLine(version.output),
      detectedAt,
      message: '已找到 cmux，但版本探测未完成；暂时保留复制指令。',
    });
  }
  return cmuxCapabilitySchema.parse({
    schemaVersion: 1,
    state: 'available',
    command,
    executablePath,
    version: firstOutputLine(version.output),
    detectedAt,
    message: `cmux${firstOutputLine(version.output) ? ` · ${firstOutputLine(version.output)}` : ''} 已就绪`,
  });
}

async function writeConfigAtomic(filePath: string, config: CmuxConfig): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, stringify(config, { indent: 2 }), { mode: 0o600 });
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

export async function loadCmuxConfig(configPath?: string): Promise<CmuxConfig> {
  const filePath = resolvedConfigPath(configPath);
  try {
    const config = cmuxConfigSchema.parse(parse(await readFile(filePath, 'utf8')));
    await chmod(filePath, 0o600);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeConfigAtomic(filePath, defaultCmuxConfig);
    return defaultCmuxConfig;
  }
}

export async function saveCmuxConfig(config: CmuxConfig, configPath?: string): Promise<CmuxConfig> {
  const parsed = cmuxConfigSchema.parse(config);
  const filePath = resolvedConfigPath(configPath);
  const previous = configQueues.get(filePath) ?? Promise.resolve();
  const task = previous.then(() => writeConfigAtomic(filePath, parsed));
  configQueues.set(filePath, task.then(() => undefined, () => undefined));
  await task;
  return parsed;
}

export async function cmuxSettingsStatus(options: RecoveryLaunchOptions = {}): Promise<CmuxSettingsStatus> {
  const [config, capability] = await Promise.all([
    loadCmuxConfig(options.configPath),
    options.cmuxCapability ? Promise.resolve(options.cmuxCapability) : probeCmux(options),
  ]);
  return cmuxSettingsStatusSchema.parse({ schemaVersion: 1, config, capability });
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, placeholder: string) => {
    const value = values[placeholder];
    if (value === undefined) throw new CmuxBridgeError(`命令模板包含未知占位符：${placeholder}`, 400);
    return shellQuote(value);
  });
}

function cleanWorkspaceName(title: string, provider: SessionProvider): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `Moo Fleet · ${cleaned || (provider === 'claude' ? 'Claude 接力' : 'Codex 接力')}`.slice(0, 160);
}

async function persistRecoveryPrompt(
  input: Pick<RecoveryLaunchInput, 'sessionId' | 'checkpointId' | 'recoveryPrompt'>,
  promptDirectory?: string,
): Promise<{ promptFile: string; digest: string }> {
  if (input.recoveryPrompt.includes('\0')) throw new CmuxBridgeError('恢复提示词含有非法控制字符，已停止生成命令', 400);
  const digest = createHash('sha256').update(input.recoveryPrompt).digest('hex');
  const identity = createHash('sha256').update(`${input.sessionId}\0${input.checkpointId}`).digest('hex');
  const directory = resolvedPromptDirectory(promptDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const promptFile = path.join(directory, `${identity}.txt`);
  const temporaryPath = `${promptFile}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, input.recoveryPrompt, { mode: 0o600 });
  await rename(temporaryPath, promptFile);
  await chmod(promptFile, 0o600);
  return { promptFile, digest };
}

async function providerCapability(
  provider: SessionProvider,
  options: RecoveryLaunchOptions,
): Promise<ProviderCapabilities | null> {
  if (options.providerCapability !== undefined) return options.providerCapability;
  const cache = await loadProviderCapabilityCache(options.capabilityCachePath);
  return cache.providers[provider] ?? null;
}

export async function buildRecoveryLaunch(
  input: RecoveryLaunchInput,
  options: RecoveryLaunchOptions = {},
): Promise<RecoveryLaunch> {
  const [{ config, capability: cmux }, capability, prompt] = await Promise.all([
    cmuxSettingsStatus(options),
    providerCapability(input.provider, options),
    persistRecoveryPrompt(input, options.promptDirectory),
  ]);
  const verifiedBinary = capability?.realBinaryPath && capability.state !== 'unknown'
    ? capability.realBinaryPath
    : null;
  const shellExecutable = verifiedBinary ?? input.provider;
  const template = config.providerTemplates[input.provider];
  const commonValues = {
    cwd: input.localPath,
    promptFile: prompt.promptFile,
    providerSessionId: input.providerSessionId,
    title: input.title,
  };
  const shellBody = renderTemplate(template, { ...commonValues, executable: shellExecutable });
  const cmuxBody = renderTemplate(template, { ...commonValues, executable: input.provider });
  const shellCommand = `${cdCommand(input.localPath)} && ${shellBody}`;
  const workspaceName = cleanWorkspaceName(input.title, input.provider);
  const cmuxExecutable = cmux.executablePath ?? cmux.command;
  const cmuxCliCommand = [
    shellQuote(cmuxExecutable),
    'new-workspace',
    '--name',
    shellQuote(workspaceName),
    '--cwd',
    shellQuote(input.localPath),
    '--command',
    shellQuote(cmuxBody),
  ].join(' ');
  const canOpenInCmux = input.recoveryAvailable && cmux.state === 'available' && Boolean(cmux.executablePath);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    checkpointId: input.checkpointId,
    workspaceFingerprint: input.workspaceFingerprint,
    promptDigest: prompt.digest,
    shellCommand,
    cmuxBody,
    workspaceName,
    cmuxExecutable: cmux.executablePath,
    config,
  })).digest('hex');
  const message = !input.recoveryAvailable
    ? '恢复预检仍有阻塞项；cmux 启动保持锁定。'
    : canOpenInCmux
      ? `${cmux.message}；打开前仍需确认命令与项目目录。`
      : '未检测到可确认的 cmux；界面会直接退化为复制恢复指令。';
  return recoveryLaunchSchema.parse({
    schemaVersion: 1,
    provider: input.provider,
    cwd: input.localPath,
    promptFile: prompt.promptFile,
    shellCommand,
    shellExecutable,
    shellExecutableSource: verifiedBinary ? 'real-binary' : 'command-name',
    cmuxCommand: cmuxBody,
    cmuxCliCommand,
    workspaceName,
    cmux,
    canOpenInCmux,
    fingerprint,
    message,
  });
}

export function cmuxOpenArguments(launch: RecoveryLaunch): string[] {
  return [
    'new-workspace',
    '--name',
    launch.workspaceName,
    '--cwd',
    launch.cwd,
    '--command',
    launch.cmuxCommand,
  ];
}

export async function openRecoveryInCmux(
  launch: RecoveryLaunch,
  expectedFingerprint: string,
  confirmed: boolean,
): Promise<CmuxOpenResult> {
  if (!confirmed) throw new CmuxBridgeError('必须明确确认后才能调用 cmux', 400);
  if (launch.fingerprint !== expectedFingerprint) {
    throw new CmuxBridgeError('恢复命令或工作区状态已变化，请重新预检后再打开 cmux');
  }
  if (!launch.canOpenInCmux || launch.cmux.state !== 'available' || !launch.cmux.executablePath) {
    throw new CmuxBridgeError('当前不能直接打开 cmux，请复制恢复指令');
  }
  if (!(await executableFile(launch.cmux.executablePath))) {
    throw new CmuxBridgeError('cmux 可执行文件在确认后发生变化，请重新检测');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.cmux.executablePath!, cmuxOpenArguments(launch), {
      cwd: launch.cwd,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return cmuxOpenResultSchema.parse({
    schemaVersion: 1,
    opened: true,
    workspaceName: launch.workspaceName,
    message: `已交给 cmux 创建 workspace：${launch.workspaceName}`,
  });
}
