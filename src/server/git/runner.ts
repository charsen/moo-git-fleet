import { spawn } from 'node:child_process';

const activeGitProcesses = new Set<ReturnType<typeof spawn>>();
const forcedTerminationTimers = new Map<ReturnType<typeof spawn>, ReturnType<typeof setTimeout>>();
const terminationGraceMs = 500;

function signalGitProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function clearForcedTermination(child: ReturnType<typeof spawn>): void {
  const timer = forcedTerminationTimers.get(child);
  if (!timer) return;
  clearTimeout(timer);
  forcedTerminationTimers.delete(child);
}

function terminateGitProcess(child: ReturnType<typeof spawn>): void {
  signalGitProcess(child, 'SIGTERM');
  if (forcedTerminationTimers.has(child)) return;
  const timer = setTimeout(() => {
    forcedTerminationTimers.delete(child);
    signalGitProcess(child, 'SIGKILL');
  }, terminationGraceMs);
  timer.unref();
  forcedTerminationTimers.set(child, timer);
}

function forgetGitProcess(child: ReturnType<typeof spawn>): void {
  clearForcedTermination(child);
  activeGitProcesses.delete(child);
}

export function terminateActiveGitProcesses(): void {
  for (const child of activeGitProcesses) terminateGitProcess(child);
}

export function activeGitProcessCount(): number {
  return activeGitProcesses.size;
}

export interface GitResult {
  stdout: Buffer;
  stdoutTruncated: boolean;
  stderr: string;
  exitCode: number;
}

export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
  input?: string,
  maxStdoutBytes = Number.POSITIVE_INFINITY,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeGitProcesses.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGitProcess(child);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxStdoutBytes - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.byteLength > remaining) {
        stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      clearTimeout(timer);
      terminateGitProcess(child);
      reject(error);
    });
    child.stdin.end(input ?? '');
    child.on('error', (error) => {
      clearTimeout(timer);
      forgetGitProcess(child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      forgetGitProcess(child);
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) {
        reject(new Error(`Git 命令超时：git ${args[0] ?? ''}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stdoutTruncated, stderr: stderrText, exitCode: code ?? 1 });
    });
  });
}

export async function runGitText(cwd: string, args: string[], timeoutMs?: number, input?: string): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs, input);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Git 命令失败：git ${args.join(' ')}`);
  }
  return result.stdout.toString('utf8').trim();
}

export async function runGitLine(cwd: string, args: string[], timeoutMs?: number, input?: string): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs, input);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Git 命令失败：git ${args.join(' ')}`);
  }
  const output = result.stdout.toString('utf8');
  if (output.endsWith('\r\n')) return output.slice(0, -2);
  if (output.endsWith('\n')) return output.slice(0, -1);
  return output;
}
