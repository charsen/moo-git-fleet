import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
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
 * 待删路径全部作为 argv 传进来（`run(argv)`），既不拼进脚本文本（文件名里的引号不能改写脚本），
 * 也**在一次进程里删完整批**：osascript 启动本身实测约 30 ms，逐个文件起一次进程会把
 * 「删 60 个文件」拖成两秒。
 */
const darwinFallbackScript = [
  'ObjC.import("Foundation");',
  'function run(argv) {',
  '  var fm = $.NSFileManager.defaultManager;',
  '  for (var index = 0; index < argv.length; index += 1) {',
  '    var url = $.NSURL.fileURLWithPath($(argv[index]));',
  '    if (!fm.trashItemAtURLResultingItemURLError(url, $(), $())) {',
  '      throw new Error("trashItemAtURL failed for " + argv[index]);',
  '    }',
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
export function recycleScript(filePaths: string[]): string {
  const targets = filePaths.map((filePath) => `'${escapePowerShellString(filePath)}'`).join(', ');
  return [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$targets = @(${targets})`,
    'foreach ($target in $targets) {',
    '  if ([System.IO.Directory]::Exists($target)) {',
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '  } elseif ([System.IO.File]::Exists($target)) {',
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '  } else {',
    '    throw "path not found: $target"',
    '  }',
    '}',
  ].join('\n');
}

export function trashCommand(
  filePaths: string[],
  platform: NodeJS.Platform = process.platform,
  probe: TrashProbe = defaultProbe,
): TrashCommand {
  if (platform === 'darwin') {
    // 有系统自带命令就用它（macOS 15+）；没有就走 Foundation 回退，别让 13/14 上直接失败。
    if (probe.isExecutable(darwinNativeTrash)) return { command: darwinNativeTrash, args: [...filePaths] };
    return { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', darwinFallbackScript, ...filePaths] };
  }
  if (platform === 'linux') return { command: 'gio', args: ['trash', ...filePaths] };
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', recycleScript(filePaths)],
    };
  }
  throw new Error('当前系统暂不支持移到废纸篓');
}

/**
 * 整批移进废纸篓：只起一次系统进程。
 *
 * 批量删除的主要成本不是文件本身，而是「每个文件一次子进程」（macOS 15+ 的 `trash`、
 * 13/14 的 osascript、Linux 的 gio、Windows 的 powershell 都接受多个路径）。
 */
export async function movePathsToTrash(filePaths: string[]): Promise<void> {
  if (!filePaths.length) return;
  const { command, args } = trashCommand(filePaths);
  try {
    await execFileAsync(command, args, { timeout: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    throw new Error(`移到废纸篓失败：${message}`, { cause: error });
  }
}

export async function movePathToTrash(filePath: string): Promise<void> {
  await movePathsToTrash([filePath]);
}

/**
 * 把文件的**当前内容**以副本形式送进废纸篓，原路径保持不动。
 *
 * 整文件丢弃（先移走再 restore）可以搬走原文件；按块丢弃不行——`git apply -R`
 * 要在原文件上就地修改。可恢复承诺不能因此打折，所以先把内容复制成同目录下的
 * 副本（同卷保证废纸篓操作是 rename 级别），再把副本整批送进废纸篓，最后删掉原路径上
 * 的残留（trash 失败时副本还留在工作区，会变成一个没人认识的未跟踪文件）。
 *
 * 备份文件名带毫秒时间戳：同一文件的两次按块丢弃都会在废纸篓里留下各自的副本，
 * 不会互相覆盖；副本以「原名.丢弃前备份-<时间戳>」命名，方便在废纸篓里认领。
 */
export async function trashCopyOfFile(
  filePath: string,
  moveToTrash: (absolutePaths: string[]) => Promise<void>,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.丢弃前备份-${timestamp}`;
  await copyFile(filePath, backupPath);
  try {
    await moveToTrash([backupPath]);
  } catch (error) {
    // 废纸篓失败必须清掉残留副本，否则工作区多出一个未跟踪文件；
    // 清理失败时至少要让上层知道备份没成功（错误原样上抛，丢弃会中止）。
    await rm(backupPath, { force: true });
    throw error;
  }
}
