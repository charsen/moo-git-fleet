import { describe, expect, it } from 'vitest';
import { createForegroundLoad } from './foreground-load';

describe('createForegroundLoad', () => {
  it('单次前台请求结束时落旗', () => {
    const load = createForegroundLoad();
    load.begin();
    expect(load.end()).toBe(true);
  });

  it('并发的前台请求要等最后一个才算结束', () => {
    const load = createForegroundLoad();
    load.begin();
    load.begin();
    expect(load.end()).toBe(false);
    expect(load.end()).toBe(true);
  });

  it('多出来的 end() 不会把计数压成负数', () => {
    const load = createForegroundLoad();
    expect(load.end()).toBe(true);
    load.begin();
    // 若上一步把计数变成 -1，这一次 end() 会得到 -1 而不是 0，旗子落不下来。
    expect(load.end()).toBe(true);
  });

  it('后台请求不参与计数，因此不会顶掉前台请求的落旗', () => {
    const load = createForegroundLoad();
    // 后台刷新期间不会有 begin / end；前台请求照样按自己的计数收尾。
    load.begin();
    expect(load.end()).toBe(true);
  });
});
