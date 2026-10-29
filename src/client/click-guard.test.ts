import { describe, expect, it } from 'vitest';
import { ignoresClickAfterSelection } from './click-guard';

describe('click after text selection', () => {
  it('ignores the click that ends a text selection inside the row', () => {
    // 按住左键拖过仓库名再松手：选区非空，这次 click 是选字的副产品，不是「点了这一行」。
    expect(ignoresClickAfterSelection({ collapsed: false, text: 'acme-web', insideRoot: true })).toBe(true);
  });

  it('keeps the click when the selection is collapsed', () => {
    expect(ignoresClickAfterSelection({ collapsed: true, text: '', insideRoot: true })).toBe(false);
  });

  it('keeps the click when the selection lives in another container', () => {
    expect(ignoresClickAfterSelection({ collapsed: false, text: 'acme-web', insideRoot: false })).toBe(false);
  });

  it('keeps the click when the selection is only whitespace', () => {
    expect(ignoresClickAfterSelection({ collapsed: false, text: '   \n\t', insideRoot: true })).toBe(false);
  });
});
