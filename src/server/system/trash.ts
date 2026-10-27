import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrashCommand {
  command: string;
  args: string[];
}

/**
 * 系统自带的 `trash`：**macOS 15.0 才有的新命令**（`man trash` 的 HISTORY 写明 First appeared
 * in macOS 15.0）。App 声明的最低系统是 13.5，所以 13/14 上它必然 ENOENT——而「移到废纸篓」
 * 是丢弃改动、删除会话这两条主路径的唯一出口，没有回退等于这两个功能整体失效。
 */
const darwinNativeTrash = '/usr/bin/trash';

/** 探测某个绝对路径是否存在且可执行。做成可注入，单测才能覆盖两条分支。 */
export interface TrashProbe {
  isExecutable: (candidate: string) => boolean;
}

const defaultProbe: TrashProbe = {
  isExecutable: (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * macOS 13/14 的回退：让 osascript 在 Foundation 里调 `trashItemAtURL:resultingItemURL:error:`，
 * 效果与系统 `trash` 相同（进同一个废纸篓、可还原），不经过 Finder、不弹自动化授权。
 *
 * 待删路径作为 argv 传进来（`run(argv)`），不拼进脚本文本——否则文件名里的引号就能改写脚本。
 * 失败时 osascript 退出码非 0，`movePathToTrash` 会把 stderr 带进错误消息。
 */
const darwinFallbackScript = [
  'ObjC.import("Foundation");',
  'function run(argv) {',
  '  var fm = $.NSFileManager.defaultManager;',
  '  var url = $.NSURL.fileURLWithPath($(argv[0]));',
  '  if (!fm.trashItemAtURLResultingItemURLError(url, $(), $())) {',
  '    throw new Error("trashItemAtURL failed for " + argv[0]);',
  '  }',
  '  return "ok";',
  '}',
].join('\n');

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

export function trashCommand(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  probe: TrashProbe = defaultProbe,
): TrashCommand {
  if (platform === 'darwin') {
    // 有系统自带命令就用它（macOS 15+）；没有就走 Foundation 回退，别让 13/14 上直接失败。
    if (probe.isExecutable(darwinNativeTrash)) return { command: darwinNativeTrash, args: [filePath] };
    return { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', darwinFallbackScript, filePath] };
  }
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
    throw new Error(`移到废纸篓失败：${message}`, { cause: error });
  }
}
