import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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

async function executeGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  input: string | Uint8Array | undefined,
  maxStdoutBytes: number,
  environment: NodeJS.ProcessEnv,
  onStderr?: (chunk: string) => void,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      cwd,
      // `GIT_OPTIONAL_LOCKS=0`：读命令（status / diff）默认会顺手刷新并回写索引的
      // stat 缓存，那是一次真实的写盘。本应用会每 15 秒对几十个仓库跑一遍 status，
      // 这些「只读」命令因此可能撞上用户正在执行的 `git add`，让写操作报
      // `index.lock` 已存在。关掉可选锁之后读命令不写盘，只读与读写就能真正并行。
      // 需要写索引的命令（add / reset / commit）走的是必需的锁，不受影响。
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeGitProcesses.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stderrDecoder = new StringDecoder('utf8');
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
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      if (!onStderr) return;
      // 用 StringDecoder 而不是 `chunk.toString('utf8')`：一个多字节字符可能被拆在
      // 两个 chunk 之间，逐块解码会把它变成两个 U+FFFD。进度行本身是 ASCII，
      // 但 stderr 里还有路径、分支名这类中文内容，解码不能有损。
      try {
        const text = stderrDecoder.write(chunk);
        if (text) onStderr(text);
      } catch {
        // 监听者出错不能连累 Git 进程：进度只是装饰，失败照常走原路径。
      }
    });
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

export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
  input?: string | Uint8Array,
  maxStdoutBytes = Number.POSITIVE_INFINITY,
): Promise<GitResult> {
  return executeGit(cwd, args, timeoutMs, input, maxStdoutBytes, process.env);
}

export interface StreamingGitOptions {
  timeoutMs?: number;
  input?: string | Uint8Array;
  maxStdoutBytes?: number;
  /** 收到 stderr 增量时回调；内容是**未按行切分**的片段，调用方自己攒行。 */
  onStderr?: (chunk: string) => void;
}

/**
 * 与 `runGit` 同语义，额外把 stderr 边收边转出去。
 *
 * 只为「跑几分钟才有结果、但过程里有可读进度」的命令而存在（目前是 `git clone`）。
 * 默认的 `runGit` 会把 stderr 攒到进程退出才交出来，长任务期间界面只能干转圈。
 *
 * 注意 `onStderr` 拿到的是**任意切分**的片段：可能半行、可能一行里塞了多个
 * `\r` 刷新。要按行理解就得自己缓冲（见 `clone-progress.ts` 的解析器）。
 */
export async function runGitStreaming(
  cwd: string,
  args: string[],
  options: StreamingGitOptions = {},
): Promise<GitResult> {
  return executeGit(
    cwd,
    args,
    options.timeoutMs ?? 15_000,
    options.input,
    options.maxStdoutBytes ?? Number.POSITIVE_INFINITY,
    process.env,
    options.onStderr,
  );
}

export async function runGitText(
  cwd: string,
  args: string[],
  timeoutMs?: number,
  input?: string | Uint8Array,
): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs, input);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Git 命令失败：git ${args.join(' ')}`);
  }
  return result.stdout.toString('utf8').trim();
}

export async function runGitLine(
  cwd: string,
  args: string[],
  timeoutMs?: number,
  input?: string | Uint8Array,
): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs, input);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Git 命令失败：git ${args.join(' ')}`);
  }
  const output = result.stdout.toString('utf8');
  if (output.endsWith('\r\n')) return output.slice(0, -2);
  if (output.endsWith('\n')) return output.slice(0, -1);
  return output;
}
