/**
 * 桌面外壳共用的服务端入口（CJS）。
 *
 * macOS 原生壳（native/macos/）与 Windows / Linux 的 Electron 外壳
 * （native/desktop/）都拉起这个入口，再由各自的外壳指向它。
 * 这里没有平台专有代码，平台差异全在 src/server/system/ 的
 * process.platform 分支里。浏览器/源码模式走的是 index.ts（ESM）。
 */
import { buildApp } from './app.js';
import { terminateActiveGitProcesses } from './git/runner.js';

async function main(): Promise<void> {
  const host = process.env.GIT_FLEET_HOST ?? '127.0.0.1';
  const port = Number(process.env.GIT_FLEET_PORT ?? 8787);
  const app = await buildApp();
  await app.listen({ host, port });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminateActiveGitProcesses();
    const forcedExit = setTimeout(() => process.exit(1), 5_000);
    forcedExit.unref();
    try {
      await app.close();
    } finally {
      clearTimeout(forcedExit);
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
