import { buildApp } from './app.js';
import { terminateActiveGitProcesses } from './git/runner.js';

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
