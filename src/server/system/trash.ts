import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrashCommand {
  command: string;
  args: string[];
}

export function trashCommand(filePath: string, platform: NodeJS.Platform = process.platform): TrashCommand {
  if (platform === 'darwin') return { command: '/usr/bin/trash', args: [filePath] };
  if (platform === 'linux') return { command: 'gio', args: ['trash', filePath] };
  throw new Error('当前系统暂不支持移到废纸篓');
}

export async function movePathToTrash(filePath: string): Promise<void> {
  const { command, args } = trashCommand(filePath);
  try {
    await execFileAsync(command, args, { timeout: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    throw new Error(`移到废纸篓失败：${message}`);
  }
}
