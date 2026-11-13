import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateDownloadStatus } from '../../shared/contracts.js';
import { conflictError, invalidRequestError } from '../errors.js';
import { dataHome } from './release-feed.js';

/**
 * 应用内下载更新安装包。
 *
 * 前端跑在本机 loopback 的 WKWebView 里，直接 `fetch` cloud / GitHub 的安装包会被 CORS
 * 拦下；所以由服务端下载（无跨域限制）并落盘，前端只轮询进度，完成后把文件交给系统
 * 安装器（打开 DMG / exe / AppImage）。这里只负责「下到本地 + 报告进度 + 打开」，不静默
 * 替换正在运行的 App——换装是用户点安装器的事，误自替换的代价太大。
 *
 * 安全：只允许 https 且主机在受信白名单（cloud 与 GitHub 资产域）；配置了
 * `GIT_FLEET_UPDATE_BASE_URL` 时也允许该主机（便于本地/内网更新服务）。
 */

/** 默认允许的下载源主机：cloud 主源 + GitHub 资产域。 */
const DEFAULT_ALLOWED_HOSTS = new Set([
  'c.mooeen.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'api.github.com',
]);

function customUpdateBase(): { host: string; protocol: string } | null {
  const raw = process.env.GIT_FLEET_UPDATE_BASE_URL?.trim();
  if (!raw) return null; // 只有显式配置的自建/本地更新服务才放宽主机，默认不放宽。
  try {
    const url = new URL(raw);
    return { host: url.hostname.toLowerCase(), protocol: url.protocol };
  } catch {
    return null;
  }
}

/** 是否允许从这个 URL 下载：https + 受信主机（或显式配置的更新服务主机）。 */
export function isAllowedUpdateUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:' && DEFAULT_ALLOWED_HOSTS.has(host)) return true;
  // 自建/本地更新服务：只放行显式配置的那个主机与协议（避免任意内网地址 / 降级 http）。
  const base = customUpdateBase();
  return Boolean(base) && host === base!.host && url.protocol === base!.protocol;
}

/** 从 URL 路径里取一个安全的文件名（去掉查询串、非法字符，防目录穿越）。 */
export function sanitizeUpdateFileName(rawPathname: string): string {
  const last = rawPathname.split('/').pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // 非法百分号编码：沿用原串。
  }
  const cleaned = decoded.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'moo-fleet-update';
}

let state: UpdateDownloadStatus = {
  status: 'idle',
  receivedBytes: 0,
  totalBytes: null,
  filePath: null,
  fileName: null,
  error: null,
};
let controller: AbortController | null = null;

function snapshot(): UpdateDownloadStatus {
  return { ...state };
}

export function updateDownloadStatus(): UpdateDownloadStatus {
  return snapshot();
}

async function runDownload(url: string, destination: string, signal: AbortSignal): Promise<void> {
  const temporary = `${destination}.part`;
  try {
    const response = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: { 'user-agent': 'moo-fleet-updater' },
    });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    state.totalBytes = Number.isFinite(length) && length > 0 ? length : null;
    const source = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
    source.on('data', (chunk: Buffer) => {
      state.receivedBytes += chunk.length;
    });
    await pipeline(source, createWriteStream(temporary, { mode: 0o600 }));
    await rm(destination, { force: true }).catch(() => undefined);
    await rename(temporary, destination);
    state = {
      ...state,
      status: 'done',
      filePath: destination,
      totalBytes: state.totalBytes ?? state.receivedBytes,
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    state = {
      ...state,
      status: 'error',
      error: error instanceof Error ? error.message : '下载失败',
    };
  } finally {
    controller = null;
  }
}

/** 开始下载；同一时间只允许一个。返回起始状态（后续靠轮询）。 */
export async function startUpdateDownload(rawUrl: string): Promise<UpdateDownloadStatus> {
  if (state.status === 'downloading') throw conflictError('已有更新正在下载，请稍候');
  if (!isAllowedUpdateUrl(rawUrl)) throw invalidRequestError('更新下载地址不被允许');
  const url = new URL(rawUrl);
  const fileName = sanitizeUpdateFileName(url.pathname);
  const directory = path.join(dataHome(), 'updates');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, fileName);
  state = {
    status: 'downloading',
    receivedBytes: 0,
    totalBytes: null,
    filePath: null,
    fileName,
    error: null,
  };
  controller = new AbortController();
  void runDownload(url.toString(), destination, controller.signal);
  return snapshot();
}

/** 打开/定位已下载的安装包（交给系统默认程序）。 */
export async function openDownloadedUpdate(reveal: boolean): Promise<void> {
  if (state.status !== 'done' || !state.filePath) throw conflictError('还没有下载完成的更新');
  const target = state.filePath;
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = reveal ? ['-R', target] : [target];
  } else if (platform === 'win32') {
    command = reveal ? 'explorer.exe' : 'cmd.exe';
    args = reveal ? [`/select,${target}`] : ['/c', 'start', '', target];
  } else {
    command = 'xdg-open';
    args = [reveal ? path.dirname(target) : target];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
