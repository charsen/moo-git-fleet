import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrashCommand {
  command: string;
  args: string[];
}

/**
 * PowerShell 单引号字符串里，单引号自身要靠重复一次来转义。
 * 路径来自请求体，必须逐字转义再拼进脚本，否则一个引号就能改写整段脚本。
 */
export function escapePowerShellString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Windows 没有命令行版的“移到回收站”。这里走 Microsoft.VisualBasic 的
 * FileSystem，它调的是 shell 的回收站 API（SHFileOperation），是真正的
 * 回收站删除，不是永久删除。目录和文件分别对应 DeleteDirectory / DeleteFile。
 */
export function recycleScript(filePath: string): string {
  const literal = `'${escapePowerShellString(filePath)}'`;
  return [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$target = ${literal}`,
    'if ([System.IO.Directory]::Exists($target)) {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '} elseif ([System.IO.File]::Exists($target)) {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '} else {',
    `  throw "path not found: $target"`,
    '}',
  ].join('\n');
}

export function trashCommand(filePath: string, platform: NodeJS.Platform = process.platform): TrashCommand {
  if (platform === 'darwin') return { command: '/usr/bin/trash', args: [filePath] };
  if (platform === 'linux') return { command: 'gio', args: ['trash', filePath] };
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', recycleScript(filePath)],
    };
  }
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
