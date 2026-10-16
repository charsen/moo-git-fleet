import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
  it('保持与输入等长且同序', async () => {
    const items = [5, 1, 4, 2, 3];
    const results = await mapWithConcurrency(items, 2, async (item) => item * 10);
    expect(results).toEqual([50, 10, 40, 20, 30]);
  });

  it('并发度不超过上限', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return item;
    });
    expect(results).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(3);
    // 上限要真的被用满，否则「有界」退化成串行、白等一轮
    expect(peak).toBe(3);
  });

  it('并发上限大于条目数时不会多开 worker', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 10, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return item;
    });
    expect(peak).toBe(2);
  });

  it('空输入直接返回空数组', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('mapper 抛错会向上传播，不被吞掉', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});
