import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { escapeAppleScriptString } from './folder-picker.js';

const execFileAsync = promisify(execFile);

/** 与文件夹选择器同一口径：五分钟没选完就当没选，顺手把留在后台的对话框杀掉。 */
const PICK_TIMEOUT_MS = 300_000;
/** 只是把窗口拉到前台，卡住也不该拖住选择框。 */
const ACTIVATE_TIMEOUT_MS = 10_000;

export const DEFAULT_FILE_PROMPT = '选择 Moo Fleet 导出的配置文件';

/** 执行一条外部命令；抽成类型是为了单测不去真的弹系统对话框。 */
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export interface PickFileOptions {
  /** 测试用替身；默认真的跑 osascript / powershell / zenity。 */
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}

export interface FilePickerCommand {
  command: string;
  args: string[];
}

/**
 * 系统文件选择框。
 *
 * 为什么需要它：配置迁移要给用户一个「选一份 JSON」的入口，而 `<input type="file">`
 * 在 macOS 原生外壳（WKWebView）里点不开——`WKUIDelegate` 没实现 `runOpenPanelWith`
 * 就什么都不会发生，用户点了按钮只会以为卡住。走系统对话框则与浏览器能力无关，
 * 原生外壳、浏览器、Electron 壳子都一样能用。
 *
 * 只选不读：路径由系统对话框产生，服务端接着自己读、自己校验。客户端始终无法指定路径，
 * 因此这里不存在「借接口读任意文件」的口子。
 */
export function filePickerCommand(
  initialPath: string | null,
  platform: NodeJS.Platform = process.platform,
  prompt: string = DEFAULT_FILE_PROMPT,
): FilePickerCommand {
  if (platform === 'darwin') {
    // 不指定 default location：让 macOS 自己记住上次的目录，比每次从家目录再翻一遍好用。
    const script = [
      'on run argv',
      `set promptText to "${escapeAppleScriptString(DEFAULT_FILE_PROMPT)}"`,
      'if (count of argv) > 0 then set promptText to (item 1 of argv)',
      'set selectedFile to choose file with prompt promptText of type {"public.json"}',
      'return POSIX path of selectedFile',
      'end run',
    ].join('\n');
    return {
      command: 'osascript',
      args: ['-e', script, '--', prompt],
    };
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Filter = 'Moo Fleet 配置文件 (*.json)|*.json|所有文件 (*.*)|*.*'",
      'if ($args.Count -gt 0) { $dialog.Title = $args[0] }',
      'if ($args.Count -gt 1) { $dialog.InitialDirectory = $args[1] }',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
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
      `--title=${prompt}`,
      '--file-filter=Moo Fleet 配置文件 (*.json) | *.json',
      '--file-filter=所有文件 | *',
      ...(initialPath ? [`--filename=${initialPath}`] : []),
    ],
  };
}

/** 用户取消时 osascript 以 -128 退出；超时被我们杀掉同样等于「没选」。 */
function wasCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { killed?: boolean; signal?: string | null; stderr?: string };
  if (candidate.killed || candidate.signal) return true;
  return /User canceled|\(-128\)/i.test(candidate.stderr ?? '');
}

function failureDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { stderr?: string; message?: string; code?: string };
  // 没装 zenity 之类属于环境缺件，报「找不到命令」比原文的 ENOENT 好懂。
  if (candidate.code === 'ENOENT') return '：系统里没有可用的选择器命令';
  const raw = (candidate.stderr || candidate.message || '').trim().split('\n')[0]?.trim() ?? '';
  return raw ? `：${raw}` : '';
}

const runCommand: CommandRunner = async (command, args, timeoutMs) => {
  const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs });
  return stdout;
};

/** 单飞：系统对话框是模态的，连点两下会叠出两个窗口。第二个请求直接拒掉。 */
let picking = false;

export async function pickFile(prompt: string = DEFAULT_FILE_PROMPT, options: PickFileOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (picking) {
    throw Object.assign(new Error('已有一个选择窗口打开，请先在系统对话框里选择或取消'), { statusCode: 409 });
  }
  picking = true;
  const runner = options.runner ?? runCommand;
  try {
    if (platform === 'darwin') {
      try {
        await runner('osascript', ['-e', 'tell application "System Events" to activate'], ACTIVATE_TIMEOUT_MS);
      } catch {
        // 拉不到前台不影响选择。
      }
    }
    const { command, args } = filePickerCommand(null, platform, prompt);
    const stdout = await runner(command, args, PICK_TIMEOUT_MS);
    return stdout.trim() || null;
  } catch (error) {
    if (wasCancelled(error)) return null;
    throw Object.assign(new Error(`无法打开系统文件选择器${failureDetail(error)}`), { statusCode: 500 });
  } finally {
    picking = false;
  }
}
