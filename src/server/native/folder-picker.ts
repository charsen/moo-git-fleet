import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 让人从容翻目录：五分钟没选完就当没选，同时把留在后台的对话框杀掉。 */
const PICK_TIMEOUT_MS = 300_000;
/** 只是把窗口拉到前台，卡住也不该拖住选择框。 */
const ACTIVATE_TIMEOUT_MS = 10_000;

export type OsascriptRunner = (args: string[], timeoutMs: number) => Promise<string>;

export interface PickFolderOptions {
  /** 测试用替身；默认真的跑 osascript。 */
  runner?: OsascriptRunner;
  platform?: NodeJS.Platform;
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * AppleScript 字符串字面量只认这几种转义。prompt 来自请求体，
 * 必须逐字转义再拼进脚本，否则一个双引号就能改写整段脚本。
 */
export function escapeAppleScriptString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
}

export function chooseFolderScript(prompt: string): string {
  return `POSIX path of (choose folder with prompt "${escapeAppleScriptString(prompt)}")`;
}

/** osascript 返回的目录路径带结尾斜杠；统一去掉，根目录除外。 */
export function normalizePickedPath(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '') || '/';
}

/**
 * 用户点取消时 osascript 以 -128 退出；超时被我们杀掉同样等于“没选”。
 * 两者都不是故障，不该弹错误。
 */
function wasCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { killed?: boolean; signal?: string | null; stderr?: string };
  if (candidate.killed || candidate.signal) return true;
  return /User canceled|\(-128\)/i.test(candidate.stderr ?? '');
}

function failureDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { stderr?: string; message?: string };
  const raw = (candidate.stderr || candidate.message || '').trim().split('\n')[0]?.trim() ?? '';
  return raw ? `：${raw}` : '';
}

const runOsascript: OsascriptRunner = async (args, timeoutMs) => {
  const { stdout } = await execFileAsync('osascript', args, { timeout: timeoutMs });
  return stdout;
};

/**
 * 单飞：系统对话框是模态的，连点两下会叠出两个窗口，
 * 用户关掉一个还会看到另一个。第二个请求直接拒掉，比排队更好解释。
 */
let picking = false;

export async function pickFolder(prompt: string, options: PickFolderOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw httpError('系统文件夹选择器只在 macOS 上可用；请直接把文件夹的绝对路径粘贴到输入框里', 400);
  }
  if (picking) throw httpError('已有一个选择窗口打开，请先在系统对话框里选择或取消', 409);
  picking = true;
  const runner = options.runner ?? runOsascript;
  try {
    try {
      // 把窗口拉到最前，免得对话框藏在浏览器后面。没给自动化授权时这步会失败，
      // 属于锦上添花，失败也要照常弹选择框。
      await runner(['-e', 'tell application "System Events" to activate'], ACTIVATE_TIMEOUT_MS);
    } catch {
      // 忽略：拉不到前台不影响选择。
    }
    return normalizePickedPath(await runner(['-e', chooseFolderScript(prompt)], PICK_TIMEOUT_MS));
  } catch (error) {
    if (wasCancelled(error)) return null;
    throw httpError(`无法打开系统文件夹选择器${failureDetail(error)}`, 500);
  } finally {
    picking = false;
  }
}
