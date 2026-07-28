import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DiscoveredSession, HandoffSummary, ProviderCapabilities, SessionProvider } from '../../shared/sessions.js';
import { SESSION_HANDOFF_SUMMARY_PROMPT, parseProviderSummary } from './summary.js';

const maximumOutputBytes = 1024 * 1024;

export interface ProviderSummaryCommand {
  provider: SessionProvider;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProviderSummaryCommandResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  failedToStart: boolean;
  outputExceeded: boolean;
}

export type ProviderSummaryExecutor = (command: ProviderSummaryCommand) => Promise<ProviderSummaryCommandResult>;

export interface GenerateProviderSummaryInput {
  session: Pick<DiscoveredSession, 'provider' | 'providerSessionId' | 'projectPath'>;
  capabilities: ProviderCapabilities;
  executor?: ProviderSummaryExecutor;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class ProviderSummaryGenerationError extends Error {
  readonly code = 'provider-summary-failed';

  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProviderSummaryGenerationError';
  }
}

export function providerSummaryCommand(input: GenerateProviderSummaryInput): ProviderSummaryCommand {
  const { session, capabilities } = input;
  if (capabilities.provider !== session.provider) {
    throw new ProviderSummaryGenerationError('Provider 能力与会话来源不一致，已阻止跨 provider 摘要', 409);
  }
  if (capabilities.state !== 'supported' || !capabilities.forkResume) {
    throw new ProviderSummaryGenerationError('当前 provider 未提供可验证的无头 fork-resume，自摘要不可用', 409);
  }
  if (!capabilities.realBinaryPath) {
    throw new ProviderSummaryGenerationError('无法确认真实 provider 可执行文件，自摘要已降级', 409);
  }
  const args =
    session.provider === 'claude'
      ? ['--resume', session.providerSessionId, '--fork-session', '-p', SESSION_HANDOFF_SUMMARY_PROMPT]
      : ['exec', 'resume', session.providerSessionId, SESSION_HANDOFF_SUMMARY_PROMPT];
  return {
    provider: session.provider,
    executable: capabilities.realBinaryPath,
    args,
    cwd: path.resolve(session.projectPath ?? process.cwd()),
    env: { ...process.env, ...(input.env ?? {}) },
    timeoutMs: input.timeoutMs ?? 120_000,
  };
}

async function executeProviderSummary(command: ProviderSummaryCommand): Promise<ProviderSummaryCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      if (outputExceeded) return;
      const remaining = maximumOutputBytes - outputBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
        outputExceeded = true;
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 500);
        force.unref();
        return;
      }
      stdout.push(chunk);
      outputBytes += chunk.byteLength;
    };
    const finish = (result: ProviderSummaryCommandResult): void => {
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
    }, command.timeoutMs);
    child.stdout.on('data', append);
    // Provider diagnostics can contain transcript fragments. Drain stderr but
    // never retain or expose it through errors, API responses, or logs.
    child.stderr.resume();
    child.on('error', () => {
      finish({ stdout: '', exitCode: null, timedOut: false, failedToStart: true, outputExceeded: false });
    });
    child.on('close', (exitCode) => {
      finish({
        stdout: Buffer.concat(stdout).toString('utf8'),
        exitCode,
        timedOut,
        failedToStart: false,
        outputExceeded,
      });
    });
  });
}

function parseSummaryOutput(output: string): HandoffSummary {
  try {
    return parseProviderSummary(output);
  } catch {
    const firstBrace = output.indexOf('{');
    const lastBrace = output.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return parseProviderSummary(output.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through to a stable, non-sensitive error.
      }
    }
    throw new ProviderSummaryGenerationError('Provider 自摘要未返回有效的结构化结果，已降级为本地草稿', 502);
  }
}

export async function generateProviderHandoffSummary(input: GenerateProviderSummaryInput): Promise<HandoffSummary> {
  const command = providerSummaryCommand(input);
  let result: ProviderSummaryCommandResult;
  try {
    result = await (input.executor ?? executeProviderSummary)(command);
  } catch {
    throw new ProviderSummaryGenerationError('Provider 自摘要调用失败，已降级为本地草稿', 502);
  }
  if (result.failedToStart) {
    throw new ProviderSummaryGenerationError('真实 provider CLI 无法启动，已降级为本地草稿', 502);
  }
  if (result.timedOut) {
    throw new ProviderSummaryGenerationError('Provider 自摘要调用超时，已降级为本地草稿', 504);
  }
  if (result.outputExceeded) {
    throw new ProviderSummaryGenerationError('Provider 自摘要输出超过安全上限，已降级为本地草稿', 502);
  }
  if (result.exitCode !== 0) {
    throw new ProviderSummaryGenerationError('Provider 自摘要调用未成功完成，已降级为本地草稿', 502);
  }
  return parseSummaryOutput(result.stdout);
}
