const sessionVaultQueues = new Map<string, Promise<void>>();

/** Serialize every Git/index mutation for one Session Vault within this process. */
export async function withSessionVaultLock<T>(vaultPath: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionVaultQueues.get(vaultPath) ?? Promise.resolve();
  const result = previous.then(task, task);
  const next = result.then(
    () => undefined,
    () => undefined,
  );
  sessionVaultQueues.set(vaultPath, next);
  try {
    return await result;
  } finally {
    if (sessionVaultQueues.get(vaultPath) === next) sessionVaultQueues.delete(vaultPath);
  }
}
