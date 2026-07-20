import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DirectoryPickerCommand {
  command: string;
  args: string[];
}

export function directoryPickerCommand(
  initialPath: string | null,
  platform: NodeJS.Platform = process.platform,
): DirectoryPickerCommand {
  if (platform === 'darwin') {
    const script = [
      'on run argv',
      'set startFolder to POSIX file "/"',
      'if (count of argv) > 0 then set startFolder to POSIX file (item 1 of argv)',
      'set selectedFolder to choose folder with prompt "选择 Git 仓库根目录" default location startFolder',
      'return POSIX path of selectedFolder',
      'end run',
    ].join('\n');
    return { command: 'osascript', args: ['-e', script, ...(initialPath ? ['--', initialPath] : [])] };
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "选择 Git 仓库根目录"',
      'if ($args.Count -gt 0) { $dialog.SelectedPath = $args[0] }',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
    ].join('; ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script, ...(initialPath ? [initialPath] : [])],
    };
  }

  return {
    command: 'zenity',
    args: [
      '--file-selection',
      '--directory',
      '--title=选择 Git 仓库根目录',
      ...(initialPath ? [`--filename=${initialPath.replace(/\/$/, '')}/`] : []),
    ],
  };
}

function wasCancelled(error: unknown, platform: NodeJS.Platform): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: number | string; stderr?: string };
  if (platform === 'linux' && candidate.code === 1) return true;
  return platform === 'darwin' && /User canceled|\(-128\)/i.test(candidate.stderr ?? '');
}

export async function selectDirectory(
  initialPath: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const { command, args } = directoryPickerCommand(initialPath, platform);
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5 * 60_000 });
    return stdout.trim() || null;
  } catch (error) {
    if (wasCancelled(error, platform)) return null;
    throw new Error('无法打开系统目录选择器');
  }
}
