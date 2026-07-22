import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readSystemClipboard(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('当前系统不支持读取 macOS 剪贴板');
  const { stdout } = await execFileAsync('/usr/bin/pbpaste', [], { encoding: 'utf8', maxBuffer: 16 * 1024 });
  return stdout.trim();
}
