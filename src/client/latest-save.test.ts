import { describe, expect, it, vi } from 'vitest';
import { createLatestSave } from './latest-save';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createLatestSave', () => {
  it('值没变就不发请求', async () => {
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => { calls.push(value); return value; }, { current: 'dark-modern' });
    saver.save('dark-modern');
    await saver.idle();
    expect(calls).toEqual([]);
  });

  it('单个值只保存一次', async () => {
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => { calls.push(value); return value; }, { current: 'fleet-blue' });
    saver.save('mooeen');
    await saver.idle();
    expect(calls).toEqual(['mooeen']);
  });

  it('上一次还在飞时改回原值，最后一次也要落库', async () => {
    const gate = deferred<void>();
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => {
      calls.push(value);
      await gate.promise;
      return value;
    }, { current: 'fleet-blue' });
    saver.save('mooeen');
    // 还没返回就点回原来那套：按快照排队会判成「与已保存一致」而跳过，服务端停在 mooeen。
    saver.save('fleet-blue');
    gate.resolve();
    await saver.idle();
    expect(calls).toEqual(['mooeen', 'fleet-blue']);
  });

  it('排队期间的中间值被跳过，只保存飞行中的那个和最后一个', async () => {
    const gate = deferred<void>();
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => {
      calls.push(value);
      await gate.promise;
      return value;
    }, { current: 'a' });
    saver.save('b');
    saver.save('c');
    saver.save('d');
    gate.resolve();
    await saver.idle();
    expect(calls).toEqual(['b', 'd']);
  });

  it('用服务端认下的值做后续比较，避免同一值反复写', async () => {
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => { calls.push(value); return value.toLowerCase(); }, { current: 'fleet-blue' });
    saver.save('MOOEEN');
    await saver.idle();
    saver.save('mooeen');
    await saver.idle();
    expect(calls).toEqual(['MOOEEN']);
  });

  it('外部已落库的值认作基线后不再回写', async () => {
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => { calls.push(value); return value; }, { current: 'fleet-blue' });
    // 首屏从服务端同步来的主题：它本来就在服务端，再 PATCH 一次纯属噪音。
    saver.adopt('mooeen');
    saver.save('mooeen');
    await saver.idle();
    expect(calls).toEqual([]);
  });

  it('adopt 之后用户改选别的主题照常保存', async () => {
    const calls: string[] = [];
    const saver = createLatestSave(async (value: string) => { calls.push(value); return value; }, { current: 'fleet-blue' });
    saver.adopt('mooeen');
    saver.save('monokai');
    await saver.idle();
    expect(calls).toEqual(['monokai']);
  });

  it('失败上报一次，且不会堵住之后的保存', async () => {
    const onError = vi.fn();
    const calls: string[] = [];
    let fail = true;
    const saver = createLatestSave(async (value: string) => {
      calls.push(value);
      if (fail) throw new Error('offline');
      return value;
    }, { current: 'fleet-blue', onError });
    saver.save('mooeen');
    await saver.idle();
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    saver.save('monokai');
    await saver.idle();
    expect(calls).toEqual(['mooeen', 'monokai']);
  });
});
