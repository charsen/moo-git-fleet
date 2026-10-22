import { buildApp } from './app.js';
import { terminateActiveGitProcesses } from './git/runner.js';
import { startParentWatch } from './parent-watch.js';

const host = process.env.GIT_FLEET_HOST ?? '127.0.0.1';
const port = Number(process.env.GIT_FLEET_PORT ?? 8787);
const app = await buildApp();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateActiveGitProcesses();
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
  try {
    await app.close();
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    clearTimeout(forcedExit);
    process.exit(1);
  }
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

// 外壳正常退出会发 SIGTERM，但被 SIGKILL 或崩溃时这里收不到任何信号 ——
// 只能靠自查父进程兜底，否则后端会带着随机端口一直挂着，谁也看不见。
startParentWatch({ onParentGone: () => void shutdown() });
