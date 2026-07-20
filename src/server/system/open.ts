import { spawn } from 'node:child_process';

export type RepositoryOpenTarget = 'finder' | 'terminal' | 'vscode';

export interface OpenCommand {
  command: string;
  args: string[];
}

export function repositoryOpenCommand(
  target: RepositoryOpenTarget,
  repositoryPath: string,
  platform: NodeJS.Platform = process.platform,
): OpenCommand {
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

export async function openRepositoryLocation(target: RepositoryOpenTarget, repositoryPath: string): Promise<void> {
  const { command, args } = repositoryOpenCommand(target, repositoryPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
