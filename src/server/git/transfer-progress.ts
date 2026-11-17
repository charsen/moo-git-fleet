/**
 * Fetch / Pull / Push 的传输进度解析。
 *
 * git 只在 stderr 上写进度、并且用 \r 原地刷新；管道模式下还要显式 --progress 才会吐。
 * 这里把任意切分的 stderr 片段切成完整行，识别阶段与百分比，翻译成一句能直接放进
 * 操作记录的中文（例如「接收对象 45%」）。解析器不碰进程与 HTTP，便于单测。
 */

type TransferPhase = 'counting' | 'compressing' | 'receiving' | 'resolving' | 'writing' | 'updating';

const phasePatterns: Array<{ phase: TransferPhase; pattern: RegExp }> = [
  { phase: 'counting', pattern: /Counting objects:\s+(\d+)%/ },
  { phase: 'compressing', pattern: /Compressing objects:\s+(\d+)%/ },
  { phase: 'receiving', pattern: /Receiving objects:\s+(\d+)%/ },
  { phase: 'resolving', pattern: /Resolving deltas:\s+(\d+)%/ },
  { phase: 'writing', pattern: /Writing objects:\s+(\d+)%/ },
  { phase: 'updating', pattern: /Updating files:\s+(\d+)%/ },
];

const phaseLabels: Record<TransferPhase, string> = {
  counting: '统计远端对象',
  compressing: '压缩远端对象',
  receiving: '接收对象',
  resolving: '解析增量',
  writing: '写入对象',
  updating: '更新文件',
};

export function formatTransferProgress(phase: TransferPhase, percent: number): string {
  return phaseLabels[phase] + ' ' + percent + '%';
}

export class TransferProgressParser {
  private pending = '';
  private lastMessage = '';

  constructor(private readonly report: (message: string) => void) {}

  push(chunk: string): void {
    const segments = (this.pending + chunk).split(/[\r\n]/);
    this.pending = segments.pop() ?? '';
    // 只写 \r、始终不换行的实现也不会撑爆缓冲：进度信息只在行尾。
    if (this.pending.length > 4096) this.pending = this.pending.slice(-1024);
    for (const line of segments) this.consume(line);
  }

  private consume(line: string): void {
    if (!line) return;
    for (const { phase, pattern } of phasePatterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const percent = Number(match[1]);
      if (!Number.isFinite(percent)) return;
      const message = formatTransferProgress(phase, percent);
      if (message === this.lastMessage) return;
      this.lastMessage = message;
      this.report(message);
      return;
    }
  }
}
