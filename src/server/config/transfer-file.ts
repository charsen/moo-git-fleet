import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ConfigurationExport,
  ConfigurationExportFileResult,
  ConfigurationPickedFile,
} from '../../shared/contracts.js';
import { configurationExportSchema } from '../../shared/schemas.js';
import { invalidRequestError } from '../errors.js';
import { pickFile } from '../native/file-picker.js';

/**
 * 配置包的磁盘往返。
 *
 * 存在的理由只有一个：**浏览器那两条文件通道在 macOS 原生外壳里都是哑的。**
 * WKWebView 没实现 `WKUIDelegate.runOpenPanelWith` 时 `<input type="file">` 点不开，
 * 没有 `WKNavigationDelegate` 的 download 分支时 `<a download>` 触发的 blob 下载
 * 也不会写文件。两者都不报错——前者像按钮坏了，后者更糟：界面显示「已导出」，
 * 用户去下载目录什么也找不到。
 *
 * 所以原生外壳里改由服务端做这两件事：写文件用 `node:fs`，选文件用系统对话框。
 * 成功失败都是真的，界面还能把绝对路径直接摆给用户。
 */

/** 与前端 `input[type=file]` 分支同一上限：超过这个尺寸不再读。 */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/** 文件名里只留安全字符：机器名可能带空格、点、括号（`xxx.local`、`Mac (2)`）。 */
function safeNamePart(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'machine';
}

/**
 * 默认落点：`~/Downloads` 存在就用它，否则退回家目录——不要凭空建一个用户没见过的目录。
 *
 * `GIT_FLEET_EXPORT_DIR` 可以覆盖：集成测试要指向临时目录（否则会往用户真实的
 * 下载目录里写测试文件），用户也可以把它指到自己习惯的同步盘。
 */
export async function defaultExportDirectory(
  home: string = os.homedir(),
  override: string | undefined = process.env.GIT_FLEET_EXPORT_DIR,
): Promise<string> {
  const wanted = override?.trim();
  if (wanted) return path.resolve(wanted);
  const downloads = path.join(home, 'Downloads');
  const info = await stat(downloads).catch(() => null);
  return info?.isDirectory() ? downloads : home;
}

export interface ExportFileDeps {
  buildPayload: () => Promise<ConfigurationExport>;
  directory: string;
}

/**
 * 把导出包写到磁盘并返回绝对路径。
 *
 * 同名文件不覆盖：同一天导两次是很常见的动作（换了台机器又导一次），
 * 覆盖掉上一次的文件会让人怀疑「怎么还是旧数据」。改为 `-2`、`-3` 递增。
 *
 * 用 `flag: 'wx'` 而不是「先 stat 再 write」：后者有 TOCTOU 窗口，两路导出同时
 * 落在同一个名字上时后一个会静默覆盖前一个。`wx` 让「创建新文件」本身成为原子操作，
 * 撞名就抛 EEXIST，顺便也保证了 `mode` 一定生效（已存在的文件不会改权限）。
 *
 * 权限 0600：文件里有 DeepSeek Key 明文。浏览器下载走的是系统默认 0644，
 * 那条路径不在我们手里；服务端这条至少能做到位。
 */
export async function exportConfigurationToFile(deps: ExportFileDeps): Promise<ConfigurationExportFileResult> {
  const payload = await deps.buildPayload();
  await mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const stamp = payload.exportedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const base = `moo-fleet-config-${safeNamePart(payload.machine)}-${stamp}`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  for (let index = 1; index <= 200; index += 1) {
    const fileName = index === 1 ? `${base}.json` : `${base}-${index}.json`;
    const target = path.join(deps.directory, fileName);
    try {
      await writeFile(target, text, { mode: 0o600, flag: 'wx' });
      return {
        path: target,
        fileName,
        bytes: Buffer.byteLength(text),
        repositories: payload.repositories.length,
        includesAppearance: Boolean(payload.appearance),
        includesApiKey: Boolean(payload.ai?.apiKey?.trim()),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  // 200 个同名文件基本只可能是有人在导出目录里堆了测试产物，报错比默默覆盖诚实。
  throw new Error(`导出目录里同名文件过多，请先清理 ${deps.directory}`);
}

export interface PickConfigurationDeps {
  /** 测试用替身；默认弹系统对话框。 */
  picker?: () => Promise<string | null>;
}

/**
 * 弹系统对话框选一份配置，读进来并校验。
 *
 * 路径不接受客户端传入：选择动作发生在服务端，客户端只拿到结果。
 * 这样即使页面被注入，也拿不到「读任意文件」的能力。
 */
export async function pickConfigurationFile(
  deps: PickConfigurationDeps = {},
): Promise<ConfigurationPickedFile | null> {
  const picker = deps.picker ?? (() => pickFile());
  const picked = await picker();
  if (!picked) return null;

  const info = await stat(picked).catch(() => null);
  if (!info) throw invalidRequestError('选中的文件已经不在磁盘上了');
  if (!info.isFile()) throw invalidRequestError('选中的不是一个文件');
  if (info.size > MAX_CONFIG_BYTES) throw invalidRequestError('配置文件超过 2 MB，已拒绝读取');

  const text = await readFile(picked, 'utf8').catch(() => {
    throw invalidRequestError('无法读取该文件，请检查权限');
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidRequestError('这个文件不是合法的 JSON');
  }

  const result = configurationExportSchema.safeParse(parsed);
  if (!result.success) {
    // 把 zod 的第一条具体问题带上：用户手改过文件时，只说「不是配置文件」帮不到他。
    const detail = result.error.issues[0];
    const where = detail?.path.join('.') || '内容';
    throw invalidRequestError(`这不是有效的 Moo Fleet 配置文件：${where} ${detail?.message ?? ''}`.trim());
  }

  return {
    sourcePath: picked,
    fileName: path.basename(picked),
    payload: result.data,
  };
}
