'use strict';

/**
 * Moo Fleet 桌面外壳（Windows / Linux）。
 *
 * 行为对齐 macOS 原生壳 native/macos/MooFleetApp.swift：
 *   1. 随机挑一个 loopback 空闲端口；
 *   2. 用内置 Node 拉起打包好的服务端（dist/server/index.cjs）；
 *   3. 开窗口，轮询 /api/health，健康后再加载页面；
 *   4. 站内地址留在窗口里，外部 http(s) 交给系统浏览器；
 *   5. 关窗即退出，退出前先收掉服务端进程；
 *   6. 服务端输出写进轮转日志。
 *
 * 与 macOS 壳的差异：这里的“内置 Node”是 Electron 自带的 Node，
 * 通过 ELECTRON_RUN_AS_NODE=1 复用同一个可执行文件，不再单独打包官方运行时。
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const WINDOW_TITLE = 'Moo Fleet';
const WINDOW_DEFAULT_WIDTH = 1440;
const WINDOW_DEFAULT_HEIGHT = 980;
const WINDOW_MIN_WIDTH = 1024;
const WINDOW_MIN_HEIGHT = 680;
/** 与 macOS 壳一致的深色底，避免加载期间闪白。 */
const WINDOW_BACKGROUND = '#101216';

const PORT_RANGE_START = 18000;
const PORT_RANGE_END = 28000;
const PORT_ATTEMPTS = 100;

const HEALTH_ATTEMPTS = 80;
const HEALTH_INTERVAL_MS = 100;

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILE_NAME = 'moo-fleet.log';

/** 关闭时的宽限：先礼后兵，超过这个时间直接强杀。 */
const SHUTDOWN_GRACE_MS = 3000;

let backend = null;
let backendLog = null;
let backendLogPath = null;
let backendFailure = null;
let backendPort = null;
let mainWindow = null;

// ---------------------------------------------------------------- 日志

/**
 * 轮转日志，对齐 RotatingLogWriter.swift：超过 maxBytes 就把旧内容挪到 `<file>.1`。
 * 日志失败绝不能影响主流程，所以这里全部吞掉异常。
 */
function createRotatingLogWriter(filePath, maxBytes = LOG_MAX_BYTES) {
  const archivePath = `${filePath}.1`;
  let size = 0;
  let closed = false;

  const ignore = () => {};

  function ensureFile() {
    try {
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { mode: 0o600 });
      // Windows 上 chmod 基本是空操作，失败也无所谓。
      fs.chmodSync(filePath, 0o600);
    } catch {
      ignore();
    }
  }

  function archive() {
    try {
      fs.rmSync(archivePath, { force: true });
      fs.renameSync(filePath, archivePath);
      fs.chmodSync(archivePath, 0o600);
    } catch {
      ignore();
    }
    size = 0;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stat = fs.statSync(filePath);
    size = stat.size;
    if (size >= maxBytes) archive();
  } catch {
    size = 0;
  }
  ensureFile();

  return {
    write(chunk) {
      if (closed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buffer.length === 0) return;
      try {
        let offset = 0;
        while (offset < buffer.length) {
          if (size >= maxBytes) archive();
          const available = Math.min(maxBytes - size, buffer.length - offset);
          fs.appendFileSync(filePath, buffer.subarray(offset, offset + available));
          size += available;
          offset += available;
        }
      } catch {
        ignore();
      }
    },
    close() {
      closed = true;
    },
    path: filePath,
  };
}

// ---------------------------------------------------------------- 路径

/** 与 server 侧 backup-repo.ts 的 dataHome() 保持同一套约定。 */
function dataHome() {
  if (process.env.GIT_FLEET_HOME) return path.resolve(process.env.GIT_FLEET_HOME);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Moo Fleet');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Moo Fleet');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'moo-fleet');
}

/**
 * 应用资源根目录。打包后布局与 macOS 一致：
 *   <resources>/app/dist/client        ← 前端
 *   <resources>/app/dist/server/index.cjs ← 服务端
 * 也就是 GIT_FLEET_ASSETS_HOME 指向 <resources>/app。
 */
function resolveAppRoot() {
  const override = process.env.MOO_FLEET_DESKTOP_APP_ROOT;
  if (override) return path.resolve(override);
  if (app.isPackaged) return path.join(process.resourcesPath, 'app');
  return __dirname;
}

// ---------------------------------------------------------------- 端口

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort() {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const span = PORT_RANGE_END - PORT_RANGE_START + 1;
    const candidate = PORT_RANGE_START + Math.floor(Math.random() * span);
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error('无法找到可用的本地端口');
}

// ---------------------------------------------------------------- 服务端

/**
 * Git 需要能被找到。macOS 壳直接写死 PATH；这里保留用户 PATH，
 * 只把常见 Git 安装位置补到前面，避免 Windows 上装完 Git 却没进 PATH 的情况。
 */
function backendPath() {
  const inherited = process.env.PATH ?? process.env.Path ?? '';
  const extra =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin']
      : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'];
  return [...extra, inherited].filter(Boolean).join(path.delimiter);
}

function startBackend(port, appRoot) {
  const serverPath = path.join(appRoot, 'dist', 'server', 'index.cjs');
  const support = dataHome();
  fs.mkdirSync(support, { recursive: true });

  backendLogPath = path.join(support, LOG_FILE_NAME);
  backendLog = createRotatingLogWriter(backendLogPath);

  const environment = {
    ...process.env,
    // 让 Electron 可执行文件退化成纯 Node 运行时，复用它的 Node。
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    GIT_FLEET_HOST: '127.0.0.1',
    GIT_FLEET_PORT: String(port),
    GIT_FLEET_HOME: support,
    GIT_FLEET_ASSETS_HOME: appRoot,
    GIT_FLEET_LOG_LEVEL: 'warn',
    PATH: backendPath(),
  };

  const child = spawn(process.execPath, [serverPath], {
    cwd: appRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => backendLog?.write(chunk));
  child.stderr.on('data', (chunk) => backendLog?.write(chunk));

  child.once('error', (error) => {
    backendFailure = `本地服务无法启动：${error.message}`;
    backendLog?.write(`[${new Date().toISOString()}] ${backendFailure}\n`);
  });

  child.once('exit', (code, signal) => {
    if (child !== backend) return; // 正常退出流程里我们已主动摘掉引用
    if (code === 0 || signal === 'SIGTERM') return;
    backendFailure = `本地服务异常退出：code=${code}, signal=${signal ?? 'none'}`;
    backendLog?.write(`[${new Date().toISOString()}] ${backendFailure}\n`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      presentFatal(`${backendFailure}，请查看 ${backendLogPath ?? '应用日志'}`, 'Moo Fleet 运行异常');
    }
  });

  backend = child;
  return child;
}

function stopBackend() {
  const child = backend;
  backend = null;
  if (child) {
    child.removeAllListeners('exit');
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        // Windows 没有真正的 SIGTERM，Node 的 kill 只会杀掉自己一层。
        // 用 taskkill /T 把整棵进程树（含 git 子进程）一起收掉。
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          try {
            child.kill();
          } catch {
            /* 进程可能已经没了 */
          }
        }
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          /* 进程可能已经没了 */
        }
        const forceKill = setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch {
            /* 已经退出 */
          }
        }, SHUTDOWN_GRACE_MS);
        forceKill.unref?.();
      }
    }
  }
  backendLog?.close();
  backendLog = null;
}

// ---------------------------------------------------------------- 窗口

function isInternalURL(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
    return Number(parsed.port) === backendPort;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(url);
    }
  } catch {
    /* 不是合法 URL，忽略 */
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: WINDOW_TITLE,
    backgroundColor: WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 站内导航放行，外部链接交给系统浏览器（对齐 macOS 壳的 decidePolicyFor）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalURL(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  // target=_blank / window.open 一律不开新窗口，外部链接走系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalURL(url)) openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function presentFatal(message, title = 'Moo Fleet 无法启动') {
  if (app.isReady()) {
    dialog.showMessageBoxSync({ type: 'error', title, message: title, detail: message, buttons: ['退出'] });
  }
  app.quit();
}

function waitForBackend(port, attemptsRemaining) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (attemptsRemaining <= 0) {
    presentFatal(`${backendFailure ?? '本地服务启动超时'}，请查看 ${backendLogPath ?? '应用日志'}`);
    return;
  }
  if (backend && backend.exitCode !== null) {
    presentFatal(`${backendFailure ?? '本地服务进程已退出'}，请查看 ${backendLogPath ?? '应用日志'}`);
    return;
  }

  fetch(`http://127.0.0.1:${port}/api/health`)
    .then((response) => {
      if (!response.ok) throw new Error(`health ${response.status}`);
      if (!mainWindow || mainWindow.isDestroyed()) return;
      return mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    })
    .catch(() => {
      setTimeout(() => waitForBackend(port, attemptsRemaining - 1), HEALTH_INTERVAL_MS);
    });
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const appRoot = resolveAppRoot();
      const port = await availablePort();
      backendPort = port;
      startBackend(port, appRoot);
      createWindow();
      waitForBackend(port, HEALTH_ATTEMPTS);
    } catch (error) {
      presentFatal(error instanceof Error ? error.message : String(error));
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    stopBackend();
  });
}
