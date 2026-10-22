/**
 * 父进程看护：外壳被强杀时后端不会自己退出。
 *
 * Swift 外壳正常退出会走 `applicationWillTerminate` → `stopBackend()`，给后端发
 * SIGTERM；但外壳被 SIGKILL、崩溃或被系统强退时，后端收不到任何信号。它会带着
 * 内存和随机端口一直跑下去 —— 端口是随机分配的，下一个实例不会撞上，用户也就
 * 永远察觉不到这些残留。SIGKILL 不可捕获，唯一可靠的兜底是自查父进程：父进程
 * 一死，子进程的 ppid 会被 init 收养，值随之改变。
 */

/** 2 秒一次足够快：孤儿多活两秒没有危害，而更短的间隔在空闲时纯属浪费。 */
export const PARENT_WATCH_INTERVAL_MS = 2_000;

/**
 * ppid 为 1 有两种可能：进程已经被 launchd 收养（父进程早就没了），或者本来就由
 * launchd / 终端直启，没有需要看护的父进程。两种都不该看护 —— 否则 `npm start`
 * 起来的服务会自己退出。
 *
 * `MOO_FLEET_PARENT_WATCH=0` 是显式关闭开关，留给「故意让后端比父进程活得久」的
 * 场景（例如脚本里 `nohup` 起服务）。
 */
export const shouldWatchParent = (ppid: number, env: NodeJS.ProcessEnv = process.env): boolean =>
  env.MOO_FLEET_PARENT_WATCH !== '0' && ppid > 1;

export interface ParentWatchOptions {
  /** 启动时的 ppid，默认读 `process.ppid`。测试用来固定起点。 */
  readonly initialPpid?: number;
  /** 当前 ppid，默认读 `process.ppid`。测试用来模拟父进程消失。 */
  readonly readPpid?: () => number;
  /** 父进程消失时调用；只会调用一次。 */
  readonly onParentGone: () => void;
  readonly intervalMs?: number;
}

/** 返回停止函数；不需要看护时返回空函数，调用方不用判空。 */
export const startParentWatch = (options: ParentWatchOptions): (() => void) => {
  const initialPpid = options.initialPpid ?? process.ppid;
  if (!shouldWatchParent(initialPpid)) return () => {};

  const readPpid = options.readPpid ?? (() => process.ppid);
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  timer = setInterval(() => {
    if (readPpid() === initialPpid) return;
    // 先停表再回调：回调里可能又触发一轮关闭流程，重复调用没有意义。
    stop();
    options.onParentGone();
  }, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  // 看护本身不能成为进程不退出的理由。
  timer.unref();

  return stop;
};
