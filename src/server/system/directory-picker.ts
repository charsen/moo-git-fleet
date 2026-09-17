import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 仓库根目录场景的默认提示语；调用方可以按用途覆盖（例如会话备份文件夹）。 */
export const DEFAULT_DIRECTORY_PROMPT = '选择 Git 仓库根目录';

export interface DirectoryPickerCommand {
  command: string;
  args: string[];
}

/**
 * 三平台都把提示语当**参数**传给选择器，而不是拼进脚本正文：
 * osascript 走 `on run argv`，PowerShell 走 `$args`，zenity 走 `--title=`。
 * 这样调用方传任意文本都不会改写脚本结构，不需要额外转义。
 */
export function directoryPickerCommand(
  initialPath: string | null,
  platform: NodeJS.Platform = process.platform,
  prompt: string = DEFAULT_DIRECTORY_PROMPT,
): DirectoryPickerCommand {
  if (platform === 'darwin') {
    const script = [
      'on run argv',
      `set promptText to "${DEFAULT_DIRECTORY_PROMPT}"`,
      'set startFolder to POSIX file "/"',
      'if (count of argv) > 0 then set promptText to (item 1 of argv)',
      'if (count of argv) > 1 then set startFolder to POSIX file (item 2 of argv)',
      'set selectedFolder to choose folder with prompt promptText default location startFolder',
      'return POSIX path of selectedFolder',
      'end run',
    ].join('\n');
    return { command: 'osascript', args: ['-e', script, '--', prompt, ...(initialPath ? [initialPath] : [])] };
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      'if ($args.Count -gt 0) { $dialog.Description = $args[0] }',
      'if ($args.Count -gt 1) { $dialog.SelectedPath = $args[1] }',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
    ].join('; ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script, prompt, ...(initialPath ? [initialPath] : [])],
    };
  }

  return {
    command: 'zenity',
    args: [
      '--file-selection',
      '--directory',
      `--title=${prompt}`,
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
  prompt: string = DEFAULT_DIRECTORY_PROMPT,
): Promise<string | null> {
  const { command, args } = directoryPickerCommand(initialPath, platform, prompt);
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5 * 60_000 });
    return stdout.trim() || null;
  } catch (error) {
    if (wasCancelled(error, platform)) return null;
    throw new Error('无法打开系统目录选择器');
  }
}
