import { describe, expect, it } from 'vitest';
import { TransferProgressParser, formatTransferProgress } from './transfer-progress.js';

describe('TransferProgressParser', () => {
  it('把 \r 刷新与跨 chunk 切分都还原成进度行', () => {
    const seen: string[] = [];
    const parser = new TransferProgressParser((message) => seen.push(message));
    parser.push('remote: Counting objects: 30% (3/10)\rremote: Counting objects: 100% (10/10)\r');
    parser.push('Receiving objects:  45% (450/1000), 1.00 MiB | 2.0 MiB/s\rReceiving obj');
    parser.push('ects:  90% (900/1000)\r');
    expect(seen).toEqual(['统计远端对象 30%', '统计远端对象 100%', '接收对象 45%', '接收对象 90%']);
  });

  it('同一阶段同一百分比只报一次；write 阶段也能识别', () => {
    const seen: string[] = [];
    const parser = new TransferProgressParser((message) => seen.push(message));
    parser.push('Writing objects: 50% (5/10)\rWriting objects: 50% (5/10)\rWriting objects: 100% (10/10)\r');
    expect(seen).toEqual(['写入对象 50%', '写入对象 100%']);
  });

  it('识别 Resolving 与 Updating 阶段', () => {
    expect(formatTransferProgress('resolving', 12)).toBe('解析增量 12%');
    const seen: string[] = [];
    const parser = new TransferProgressParser((message) => seen.push(message));
    parser.push('Resolving deltas: 12% (12/100)\rUpdating files: 100% (20/20)\r');
    expect(seen).toEqual(['解析增量 12%', '更新文件 100%']);
  });
});
