import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 剪贴板内容可能很长，但仍然只取一小段：这里只用来粘 API Key。 */
const MAX_BUFFER = 16 * 1024;

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/**
 * 按顺序尝试的读取命令。Linux 上没有统一的剪贴板工具，
 * Wayland 用 wl-paste、X11 用 xclip，谁在就用谁。
 */
export function clipboardReadCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === 'darwin') return [{ command: '/usr/bin/pbpaste', args: [] }];
  if (platform === 'win32') {
    return [{ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'] }];
  }
  if (platform === 'linux') {
    return [
      { command: 'wl-paste', args: ['--no-newline'] },
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    ];
  }
  throw new Error('当前系统不支持读取系统剪贴板');
}

export async function readSystemClipboard(): Promise<string> {
  const candidates = clipboardReadCommands();
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args, {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
      });
      return stdout.trim();
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '未知错误';
  throw new Error(`读取系统剪贴板失败：${detail}`);
}
