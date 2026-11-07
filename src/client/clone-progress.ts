import type { ClonePhase, CloneProgress } from '../shared/contracts';

/**
 * 把服务端给的克隆进度翻成一行中文。
 *
 * 单独成模块而不是写在模板里：一是模板里做条件拼接很容易长出三层三元表达式，
 * 二是这段文案有明确的边界（哪些阶段没有百分比、体积与速率可缺省），
 * 写成纯函数才好覆盖。
 *
 * 阶段名与 git 自己的措辞对应，但**不照抄**——`Resolving deltas` / `Updating files`
 * 对用户没有意义，说的是「内部在做什么」而不是「还要多久」。
 */
const phaseLabels: Record<ClonePhase, string> = {
  connecting: '正在连接远端',
  counting: '远端统计对象',
  compressing: '远端压缩对象',
  receiving: '接收对象',
  resolving: '解析增量',
  checkout: '检出文件',
};

export function clonePhaseLabel(phase: ClonePhase): string {
  return phaseLabels[phase];
}

/**
 * 一行进度文案，例如「接收对象 45%（450/1000） · 12.30 MiB · 1.50 MiB/s」。
 *
 * 没有量化信息时只返回阶段名（`connecting`，以及远端刚开始数对象的那几秒）——
 * 这时候给一个 0% 是假的，会让用户以为卡在起点。
 */
export function cloneProgressText(progress: CloneProgress): string {
  const label = clonePhaseLabel(progress.phase);
  if (progress.percent === null) return label;
  const counts =
    progress.current !== null && progress.total !== null ? `（${progress.current}/${progress.total}）` : '';
  const details = [progress.size, progress.speed].filter((value): value is string => Boolean(value)).join(' · ');
  const head = `${label} ${progress.percent}%${counts}`;
  return details ? `${head} · ${details}` : head;
}

/**
 * 进度条该画多宽；`null` 表示这一阶段没有可量化的进度，应该不画条。
 *
 * 不做「跨阶段折算」：`receiving` 占掉一次克隆的绝大部分时间，
 * 把它压进一个总体百分比会让进度条在阶段切换时倒退，
 * 而倒退的进度条比没有进度条更让人怀疑是不是出错了。
 */
export function cloneProgressWidth(progress: CloneProgress | null): number | null {
  if (!progress || progress.percent === null) return null;
  return Math.min(100, Math.max(0, progress.percent));
}
