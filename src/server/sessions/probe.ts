import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, readlink, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CapabilityCache,
  ProviderCapabilities,
  SessionProvider,
} from '../../shared/sessions.js';
import { capabilityCacheSchema, providerCapabilitiesSchema } from '../../shared/sessions.js';

const maximumProbeOutputBytes = 512 * 1_024;
const maximumShimDepth = 16;
const cacheQueues = new Map<string, Promise<void>>();

export interface ProviderProbeInput {
  provider: SessionProvider;
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  now?: Date;
  /** Set false for a pure in-memory probe. Defaults to the Fleet data cache. */
  cachePath?: string | false;
}

export interface ProbeAllInput extends Omit<ProviderProbeInput, 'provider' | 'command'> {
  commands?: Partial<Record<SessionProvider, string>>;
}

interface ExecutableResolution {
  commandPath: string | null;
  realBinaryPath: string | null;
  shimChain: string[];
  resolutionCertain: boolean;
  reason: string | null;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  failedToStart: boolean;
}

interface ProviderProbeOutput {
  version: CommandOutput;
  help: CommandOutput;
  resumeHelp: CommandOutput | null;
  forkHelp: CommandOutput | null;
}

function defaultCachePath(): string {
  const fleetHome = path.resolve(process.env.GIT_FLEET_HOME ?? process.cwd());
  return path.join(fleetHome, '.data', 'session-capabilities.json');
}

export function providerCapabilityCachePath(): string {
  return defaultCachePath();
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableCandidates(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    const explicitPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await executableFile(explicitPath)) ? [explicitPath] : [];
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const candidates: string[] = [];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await executableFile(candidate)) candidates.push(path.resolve(candidate));
    }
  }
  return [...new Set(candidates)];
}

async function findExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  return (await findExecutableCandidates(command, env, cwd))[0] ?? null;
}

async function readScriptPrefix(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1_024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const prefix = buffer.subarray(0, bytesRead);
    if (prefix.includes(0)) return null;
    const text = prefix.toString('utf8');
    return text.startsWith('#!') ? text : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shellAssignments(script: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const rawLine of script.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s#;]+)\s*;?$/);
    if (!match?.[1] || match[2] === undefined) continue;
    assignments.set(match[1], unquote(match[2]));
  }
  return assignments;
}

function expandSimpleShellValue(value: string, assignments: Map<string, string>): string {
  return value
    .replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/, (_match, name: string) => assignments.get(name) ?? value)
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)$/, (_match, name: string) => assignments.get(name) ?? value);
}

function shellExecTarget(script: string): string | null {
  const firstLine = script.split(/\r?\n/, 1)[0] ?? '';
  const shebangParts = firstLine.replace(/^#!/, '').trim().split(/\s+/);
  const interpreter = path.basename(shebangParts[0] === '/usr/bin/env' ? (shebangParts[1] ?? '') : (shebangParts[0] ?? ''));
  if (!['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(interpreter)) return null;
  const assignments = shellAssignments(script);
  for (const rawLine of script.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('exec ')) continue;
    const commandText = line.slice('exec '.length).trim();
    const token = commandText.match(/^("[^"]+"|'[^']+'|[^\s;]+)/)?.[1];
    if (!token) continue;
    const target = expandSimpleShellValue(unquote(token), assignments);
    if (target && target !== '$@' && target !== '${@}') return target;
  }
  return null;
}

async function resolveTargetPath(
  target: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  if (target.includes('/') || (process.platform === 'win32' && target.includes('\\'))) {
    const candidate = path.isAbsolute(target) ? target : path.resolve(path.dirname(scriptPath), target);
    return (await executableFile(candidate)) ? candidate : null;
  }
  return findExecutable(target, env, cwd);
}

function isKnownDelegatingShim(filePath: string, script: string | null): boolean {
  const normalizedPath = filePath.replaceAll('\\', '/');
  if (normalizedPath.includes('/cmux-cli-shims/')) return true;
  if (!script) return false;
  return /cmux (?:claude|codex) wrapper|Managed by Codex HUD/i.test(script);
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ExecutableResolution> {
  const commandCandidates = await findExecutableCandidates(command, env, cwd);
  const commandPath = commandCandidates[0] ?? null;
  if (!commandPath) {
    return {
      commandPath: null,
      realBinaryPath: null,
      shimChain: [],
      resolutionCertain: true,
      reason: `未找到 ${command} 可执行文件`,
    };
  }

  const chain: string[] = [];
  const visited = new Set<string>();
  let current = path.resolve(commandPath);
  let resolutionCertain = true;
  let reason: string | null = null;
  let reachedTerminalTarget = false;

  for (let depth = 0; depth < maximumShimDepth; depth += 1) {
    if (visited.has(current)) {
      resolutionCertain = false;
      reason = 'CLI shim 解析出现循环';
      break;
    }
    visited.add(current);
    chain.push(current);

    let info;
    try {
      info = await lstat(current);
    } catch {
      resolutionCertain = false;
      reason = 'CLI shim 目标不存在';
      break;
    }
    if (info.isSymbolicLink()) {
      const link = await readlink(current);
      current = path.resolve(path.dirname(current), link);
      continue;
    }

    const script = await readScriptPrefix(current);
    if (isKnownDelegatingShim(current, script)) {
      const nextCandidate = commandCandidates.find((candidate) => !visited.has(candidate));
      if (!nextCandidate) {
        resolutionCertain = false;
        reason = '识别到 CLI shim，但无法穿透到真实 provider 可执行文件';
        reachedTerminalTarget = true;
        break;
      }
      current = nextCandidate;
      continue;
    }
    const execTarget = script ? shellExecTarget(script) : null;
    if (!execTarget) {
      reachedTerminalTarget = true;
      break;
    }
    const targetPath = await resolveTargetPath(execTarget, current, env, cwd);
    if (!targetPath) {
      resolutionCertain = false;
      reason = '无法确认 CLI shim 的真实目标';
      reachedTerminalTarget = true;
      break;
    }
    current = path.resolve(targetPath);
  }

  if (!reachedTerminalTarget && chain.length >= maximumShimDepth) {
    resolutionCertain = false;
    reason = 'CLI shim 链超过安全深度';
  }

  return {
    commandPath: path.resolve(commandPath),
    realBinaryPath: current,
    shimChain: [...new Set(chain.concat(current))],
    resolutionCertain,
    reason,
  };
}

async function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const append = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = maximumProbeOutputBytes - outputBytes;
      if (remaining <= 0) return;
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      outputBytes += kept.byteLength;
    };
    const finish = (output: CommandOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 500);
      force.unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.on('error', () => {
      finish({ stdout: '', stderr: '', exitCode: null, timedOut: false, failedToStart: true });
    });
    child.on('close', (exitCode) => {
      finish({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        timedOut,
        failedToStart: false,
      });
    });
  });
}

function combinedOutput(output: CommandOutput | null): string {
  return output ? `${output.stdout}\n${output.stderr}`.trim() : '';
}

async function collectProbeOutput(
  provider: SessionProvider,
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<ProviderProbeOutput> {
  const [version, help] = await Promise.all([
    runCommand(executable, ['--version'], env, cwd, timeoutMs),
    runCommand(executable, ['--help'], env, cwd, timeoutMs),
  ]);
  if (provider === 'claude') {
    return { version, help, resumeHelp: null, forkHelp: null };
  }
  const [resumeHelp, forkHelp] = await Promise.all([
    runCommand(executable, ['resume', '--help'], env, cwd, timeoutMs),
    runCommand(executable, ['exec', 'resume', '--help'], env, cwd, timeoutMs),
  ]);
  return { version, help, resumeHelp, forkHelp };
}

function extractVersion(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return null;
  const match = line.match(/(?:claude(?: code)?|codex)?\s*v?\d+(?:\.\d+){1,4}(?:[-+][A-Za-z0-9.-]+)?/i);
  return match?.[0]?.trim().slice(0, 1_000) ?? null;
}

function outputLooksLikeWrapper(output: string): boolean {
  return /codex-hud|cmux(?:[- ]cli)?[- ]shim|cmux-cli-shims|wrapper for (?:claude|codex)|not the real (?:claude|codex)/i.test(
    output,
  );
}

function providerFeatureResult(
  provider: SessionProvider,
  output: ProviderProbeOutput,
): { authentic: boolean; nativeResume: boolean; forkResume: boolean; wrapper: boolean; signature: string } {
  const help = combinedOutput(output.help);
  const resumeHelp = combinedOutput(output.resumeHelp);
  const forkHelp = combinedOutput(output.forkHelp);
  const allHelp = `${help}\n${resumeHelp}\n${forkHelp}`;
  const wrapper = outputLooksLikeWrapper(`${combinedOutput(output.version)}\n${allHelp}`);
  if (provider === 'claude') {
    const authentic = /usage:\s*claude\b/i.test(help) || /claude code/i.test(help);
    const nativeResume = /(?:^|\s)(?:-r,?\s*)?--resume\b/m.test(help);
    const forkResume = nativeResume && /--fork-session\b/.test(help) && /--session-id\b/.test(help);
    return {
      authentic,
      nativeResume,
      forkResume,
      wrapper,
      signature: `claude:usage=${authentic};resume=${nativeResume};fork=${forkResume};wrapper=${wrapper}`,
    };
  }
  const authentic = /usage:\s*codex\b/i.test(help) || /openai codex/i.test(help);
  const resumeCommand = /(?:^|\n)\s*resume(?:\s|$)/im.test(help) || /usage:\s*codex\s+resume\b/i.test(resumeHelp);
  const execResume = /usage:\s*codex\s+exec\s+resume\b/i.test(forkHelp) || /resume a previous session/i.test(forkHelp);
  return {
    authentic,
    nativeResume: resumeCommand,
    forkResume: execResume,
    wrapper,
    signature: `codex:usage=${authentic};resume=${resumeCommand};fork=${execResume};wrapper=${wrapper}`,
  };
}

function classifyProbe(
  provider: SessionProvider,
  command: string,
  resolution: ExecutableResolution,
  output: ProviderProbeOutput | null,
  checkedAt: string,
): ProviderCapabilities {
  if (!resolution.commandPath || !resolution.realBinaryPath || !output) {
    return {
      schemaVersion: 1,
      provider,
      state: 'unsupported',
      command,
      commandPath: resolution.commandPath,
      realBinaryPath: resolution.realBinaryPath,
      shimChain: resolution.shimChain,
      version: null,
      helpSignature: null,
      nativeResume: false,
      forkResume: false,
      checkedAt,
      reason: resolution.reason ?? `未找到 ${command} 可执行文件`,
    };
  }

  const versionOutput = combinedOutput(output.version);
  const features = providerFeatureResult(provider, output);
  const executionFailed = [output.version, output.help, output.resumeHelp, output.forkHelp]
    .filter((item): item is CommandOutput => Boolean(item))
    .every((item) => item.failedToStart || item.timedOut);
  let state: ProviderCapabilities['state'];
  let reason: string | null = resolution.reason;
  if (!resolution.resolutionCertain || features.wrapper || executionFailed) {
    state = 'unknown';
    reason = features.wrapper
      ? '帮助文本来自 CLI 包装器，无法确认真实 provider 能力'
      : executionFailed
        ? 'CLI 能力探测未能完成'
        : resolution.reason;
  } else if (features.authentic && features.nativeResume) {
    state = 'supported';
    reason = null;
  } else if (features.authentic) {
    state = 'unsupported';
    reason = '真实 CLI 未提供可验证的原生恢复入口';
  } else {
    state = 'unknown';
    reason = '帮助文本缺少真实 CLI 签名';
  }

  return {
    schemaVersion: 1,
    provider,
    state,
    command,
    commandPath: resolution.commandPath,
    realBinaryPath: resolution.realBinaryPath,
    shimChain: resolution.shimChain,
    version: extractVersion(versionOutput),
    helpSignature: features.signature,
    nativeResume: state === 'supported' && features.nativeResume,
    forkResume: state === 'supported' && features.forkResume,
    checkedAt,
    reason,
  };
}

export async function loadProviderCapabilityCache(cachePath = defaultCachePath()): Promise<CapabilityCache> {
  try {
    return capabilityCacheSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')));
  } catch {
    return { schemaVersion: 1, providers: {} };
  }
}

async function writeCapabilityCache(cachePath: string, capability: ProviderCapabilities): Promise<void> {
  const resolvedPath = path.resolve(cachePath);
  const previousQueue = cacheQueues.get(resolvedPath) ?? Promise.resolve();
  const task = previousQueue.then(async () => {
    const cache = await loadProviderCapabilityCache(resolvedPath);
    cache.providers[capability.provider] = providerCapabilitiesSchema.parse(capability);
    const directory = path.dirname(resolvedPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${resolvedPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, resolvedPath);
    await chmod(resolvedPath, 0o600);
  });
  cacheQueues.set(
    resolvedPath,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

export async function probeProviderCapabilities(input: ProviderProbeInput): Promise<ProviderCapabilities> {
  const command = input.command ?? input.provider;
  const env = { ...process.env, ...(input.env ?? {}) };
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const timeoutMs = input.timeoutMs ?? 5_000;
  const checkedAt = (input.now ?? new Date()).toISOString();
  const resolution = await resolveExecutable(command, env, cwd);
  const output = resolution.realBinaryPath
    ? await collectProbeOutput(input.provider, resolution.realBinaryPath, env, cwd, timeoutMs)
    : null;
  const capability = providerCapabilitiesSchema.parse(classifyProbe(input.provider, command, resolution, output, checkedAt));
  const cachePath = input.cachePath === false ? null : input.cachePath ?? defaultCachePath();
  if (cachePath) await writeCapabilityCache(cachePath, capability);
  return capability;
}

export async function probeSessionProviders(input: ProbeAllInput = {}): Promise<ProviderCapabilities[]> {
  return Promise.all(
    (['claude', 'codex'] as const).map((provider) =>
      probeProviderCapabilities({
        ...input,
        provider,
        command: input.commands?.[provider] ?? provider,
      }),
    ),
  );
}
