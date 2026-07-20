import { spawn } from 'node:child_process';

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export async function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
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
      resolve({ stdout: Buffer.concat(stdout), stderr: stderrText, exitCode: code ?? 1 });
    });
  });
}

export async function runGitText(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Git 命令失败：git ${args.join(' ')}`);
  }
  return result.stdout.toString('utf8').trim();
}
