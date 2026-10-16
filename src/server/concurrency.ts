/**
 * 有界并发映射：保持与输入等长、同序的结果数组。
 *
 * 用途是把「一次对 N 个仓库做事」的并发压到可控范围。这里刻意不做无界
 * `Promise.all`——每个任务通常会起一个 git 子进程，50 个仓库无界并发会瞬间
 * 拉起 50 个进程，既拖慢机器也会污染 `activeGitProcessCount()` 的读数。
 *
 * 并发上限由调用方决定（扫描用 `settings.localScanConcurrency`）。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  });
  await Promise.all(workers);
  return results;
}
