import { spawn } from 'node:child_process';
import path from 'node:path';

export type RepositoryOpenTarget = 'finder' | 'terminal' | 'vscode' | 'reveal' | 'editor';

export interface OpenCommand {
  command: string;
  args: string[];
}

/**
 * `filePath` 只在 `reveal` / `editor` 下有意义，指向仓库内的单个文件；
 * 省略时退回仓库根目录，与 `finder` / `terminal` / `vscode` 行为一致。
 */
export function repositoryOpenCommand(
  target: RepositoryOpenTarget,
  repositoryPath: string,
  platform: NodeJS.Platform = process.platform,
  filePath?: string,
): OpenCommand {
  const targetPath = filePath ?? repositoryPath;
  if (target === 'reveal') {
    if (platform === 'darwin') return { command: 'open', args: ['-R', targetPath] };
    if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${targetPath}`] };
    // Linux 没有可靠的「在文件管理器里选中」入口，退化为打开所在目录。
    return { command: 'xdg-open', args: [path.dirname(targetPath)] };
  }
  if (target === 'editor') {
    if (platform === 'darwin') return { command: 'open', args: ['-a', 'Visual Studio Code', targetPath] };
    if (platform === 'win32') return { command: 'code.cmd', args: [targetPath] };
    return { command: 'code', args: [targetPath] };
  }
  if (platform === 'darwin') {
    if (target === 'finder') return { command: 'open', args: [repositoryPath] };
    if (target === 'terminal') return { command: 'open', args: ['-a', 'Terminal', repositoryPath] };
    return { command: 'open', args: ['-a', 'Visual Studio Code', repositoryPath] };
  }
  if (platform === 'win32') {
    if (target === 'finder') return { command: 'explorer.exe', args: [repositoryPath] };
    if (target === 'terminal') return { command: 'cmd.exe', args: ['/K', 'cd', '/d', repositoryPath] };
    return { command: 'code.cmd', args: [repositoryPath] };
  }
  if (target === 'finder') return { command: 'xdg-open', args: [repositoryPath] };
  if (target === 'terminal') return { command: 'x-terminal-emulator', args: ['--working-directory', repositoryPath] };
  return { command: 'code', args: [repositoryPath] };
}

export async function openRepositoryLocation(
  target: RepositoryOpenTarget,
  repositoryPath: string,
  filePath?: string,
): Promise<void> {
  const { command, args } = repositoryOpenCommand(target, repositoryPath, process.platform, filePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
