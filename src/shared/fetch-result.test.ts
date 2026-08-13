import { describe, expect, it } from 'vitest';
import { fetchBatchResultMessage, fetchResultMessage } from './fetch-result.js';

describe('Fetch result presentation', () => {
  it('distinguishes unchanged, behind, diverged and unknown upstream state', () => {
    expect(fetchResultMessage({ ahead: 0, behind: 0 })).toBe('Fetch 完成：未发现当前分支的新提交');
    expect(fetchResultMessage({ ahead: 0, behind: 3 })).toBe('Fetch 完成：发现远端 3 个新提交');
    expect(fetchResultMessage({ ahead: 2, behind: 1 })).toBe('Fetch 完成：远端有 1 个新提交，本地与远端已分叉');
    expect(fetchResultMessage({ ahead: null, behind: null })).toBe('Fetch 完成：当前分支远端差异未知');
  });

  it('summarizes repositories that remain behind after a batch Fetch', () => {
    expect(fetchBatchResultMessage([{ behind: 0 }, { behind: 2 }, { behind: null }, { behind: 1 }]))
      .toBe('成功 Fetch 的仓库中，有 2 个存在远端新提交');
    expect(fetchBatchResultMessage([{ behind: 0 }, { behind: null }])).toBe('成功 Fetch 的仓库均未落后于远端');
  });
});
