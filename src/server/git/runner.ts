import { spawn } from 'node:child_process';

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
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
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
      reject(error);
    });
    child.stdin.end(input ?? '');
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
