/**
 * 「只保存最新值」的串行保存队列。
 *
 * 场景是「即时生效、异步落库」的偏好设置（本项目里是深色主题）：用户每点一次就改一次
 * 界面，但不该为每一次点击都发一次请求，更不能让先发后到的请求把最后一次选择覆盖掉。
 *
 * 三条约定：
 * - **排队时只记目标值**，不记「发起那一刻的快照」。连点 A→B→A 时，最后一次改回 A
 *   一样会被保存；按快照排队则会把 A 判成「和已保存的一样」直接跳过，服务端停在 B。
 * - **队首在飞时，中间值直接跳过**：B→C→D 只会保存 B 和 D。
 * - **和落库值相同时不发请求**：改回原值不该产生一次写。
 *
 * `persist` 负责保存并返回「服务端最终认下的值」——服务端可能归一化（例如小写化），
 * 后续比较必须用它，否则会为同一个值反复发请求。
 */
export interface LatestSave<T> {
  /** 记下一个待保存值并尽快落库；不会抛错，失败走 `onError`。 */
  save(value: T): void;
  /**
   * 把一个「别处已经落库」的值认作基线：常见于首屏从服务端同步配置。
   * 不这么做，同步本身会触发一次回写，把服务端的值又 PATCH 回去。
   */
  adopt(value: T): void;
  /** 队列排空后 resolve；已经空闲时立即 resolve。测试与关窗前等待用。 */
  idle(): Promise<void>;
}

export function createLatestSave<T>(
  persist: (value: T) => Promise<T>,
  options: { current: T; onError?: (error: unknown) => void },
): LatestSave<T> {
  let latest = options.current;
  let persisted = options.current;
  let pending = false;
  /** 当前这一轮排空的 promise；`null` 表示空闲。 */
  let drain: Promise<void> | null = null;

  async function run(): Promise<void> {
    while (pending) {
      pending = false;
      const target = latest;
      if (Object.is(target, persisted)) continue;
      try {
        persisted = await persist(target);
      } catch (error) {
        options.onError?.(error);
        // 失败的这一版不自动重试（重试会变成对着一台关掉的服务端刷请求），
        // 但也不吞掉用户期间改出的新值：下一次 save() 会重新排一次。
        break;
      }
    }
  }

  /**
   * 启动一次排空。
   *
   * 收尾不能用 `finally` 直接写 `drain = null`：`drain = run()` 的赋值在同步段，
   * 而「无事可做」时循环会同步跑完，`finally` 先执行、随后赋值又把一个**已完成**的
   * promise 挂回 `drain`，`idle()` 就会对着它反复 await（测试表现为挂住不返回）。
   * 改成在 `then` 里按身份清：清收尾永远排在赋值之后。
   */
  function start(): void {
    if (drain) return;
    const task = run();
    drain = task;
    const clear = (): void => { if (drain === task) drain = null; };
    void task.then(clear, clear);
  }

  return {
    save(value: T): void {
      latest = value;
      pending = true;
      start();
    },
    adopt(value: T): void {
      latest = value;
      persisted = value;
      pending = false;
    },
    async idle(): Promise<void> {
      // 排空期间可能又排进新值，所以要看 `drain` 而不是等一次 Promise。
      while (drain) {
        const current: Promise<void> = drain;
        await current.catch(() => undefined);
        // 兜底：万一清收尾没赶上，也别在同一个已完成 promise 上自旋。
        if (drain === current) break;
      }
    },
  };
}
