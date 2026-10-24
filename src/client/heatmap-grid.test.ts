import { describe, expect, it } from 'vitest';
import {
  bucketRepositoryFreshness,
  buildHeatmapWeeks,
  buildHeatmapWeeksForWindow,
  buildMonthLabels,
  countRepositoriesActiveSince,
  dailyBarStubHeight,
  flattenWindowDays,
  heatmapLevel,
  initialHeatmapCursor,
  layoutDailyBars,
  localIsoDate,
  moveDailyBarCursor,
  moveHeatmapCursor,
  summarizeHeatmapWindow,
  summarizeHourly,
  type HeatmapDay,
} from './heatmap-grid';

const dates = (weeks: ReturnType<typeof buildHeatmapWeeks>): string[] =>
  weeks.flat().map((day) => day.date);

describe('localIsoDate', () => {
  it('按本地时区取日期，不会被 UTC 换算拽到前一天', () => {
    // 这条用例专门守 `toISOString().slice(0, 10)` 的回归：
    // 东八区本地 1 月 1 日 00:00 转 UTC 是 12 月 31 日 16:00，截出来就错了。
    expect(localIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(localIsoDate(new Date(2026, 0, 1, 23, 59, 59))).toBe('2026-01-01');
    expect(localIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('buildHeatmapWeeks', () => {
  it('固定 52 列 × 7 行，首列从周一开始、末列到本周周日', () => {
    // 2026-10-23 是周五
    const weeks = buildHeatmapWeeks(new Date(2026, 9, 23), {});

    expect(weeks).toHaveLength(52);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0][0].date).toBe('2025-10-27'); // 周一
    expect(weeks[51][0].date).toBe('2026-10-19'); // 本周一
    expect(weeks[51][6].date).toBe('2026-10-25'); // 本周日
    // 列内日期严格递增一天
    const flat = dates(weeks);
    expect(flat).toHaveLength(364);
    expect(new Set(flat).size).toBe(364);
  });

  it('把今天之后的日子标成未发生，且不因为「还没到」就算成 0 提交', () => {
    const weeks = buildHeatmapWeeks(new Date(2026, 9, 23), {});
    const lastWeek = weeks[51];

    expect(lastWeek[4].date).toBe('2026-10-23');
    expect(lastWeek[4].elapsed).toBe(true);
    expect(lastWeek[5].elapsed).toBe(false);
    expect(lastWeek[6].elapsed).toBe(false);
  });

  it('今天是周日时整列都已发生；是周一时只有第一格已发生', () => {
    const sunday = buildHeatmapWeeks(new Date(2026, 9, 25), {});
    expect(sunday[51][6].date).toBe('2026-10-25');
    expect(sunday[51].every((day) => day.elapsed)).toBe(true);

    const monday = buildHeatmapWeeks(new Date(2026, 9, 19), {});
    expect(monday[51][0].date).toBe('2026-10-19');
    expect(monday[51].filter((day) => day.elapsed)).toHaveLength(1);
  });

  it('闰年 2 月 29 日出现在网格里，且前后日期连续', () => {
    const weeks = buildHeatmapWeeks(new Date(2024, 2, 1), {});
    const flat = dates(weeks);

    expect(flat).toContain('2024-02-29');
    const index = flat.indexOf('2024-02-29');
    expect(flat[index - 1]).toBe('2024-02-28');
    expect(flat[index + 1]).toBe('2024-03-01');
  });

  it('跨年时不会漏掉或重复日期', () => {
    const flat = dates(buildHeatmapWeeks(new Date(2026, 0, 3), {}));

    expect(flat).toContain('2025-12-31');
    expect(flat).toContain('2026-01-01');
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('按日期取提交数，没有记录的日期为 0', () => {
    const weeks = buildHeatmapWeeks(new Date(2026, 9, 23), {
      '2026-10-23': 15,
      '2025-10-27': 2,
      '2020-01-01': 99, // 窗口之外，不该出现在网格里
    });

    expect(weeks[51][4]).toMatchObject({ date: '2026-10-23', count: 15 });
    expect(weeks[0][0]).toMatchObject({ date: '2025-10-27', count: 2 });
    expect(weeks[51][0].count).toBe(0);
  });
});

describe('buildHeatmapWeeksForWindow', () => {
  it('按服务端给的起止日期铺格子，列数由跨度决定', () => {
    // 近 6 个月：182 天 = 26 列整
    const weeks = buildHeatmapWeeksForWindow('2026-04-27', '2026-10-25', {}, '2026-10-23');

    expect(weeks).toHaveLength(26);
    expect(weeks[0][0].date).toBe('2026-04-27');
    expect(weeks[25][6].date).toBe('2026-10-25');
  });

  it('跨年窗口从周一开始，最后一周补齐到下周日', () => {
    const weeks = buildHeatmapWeeksForWindow('2025-10-27', '2026-10-25', {}, '2026-10-23');
    const flat = dates(weeks);

    expect(weeks).toHaveLength(52);
    expect(flat[0]).toBe('2025-10-27');
    expect(flat[flat.length - 1]).toBe('2026-10-25');
  });

  it('起点不是周一时补到本周周一，多出来的格子不进窗口', () => {
    // 自定义范围不一定对齐整周，而格子必须按星期排行：向前补到周一，
    // 但 10-19、10-20 标成 inWindow=false——画的是命位，算的是所选范围。
    const weeks = buildHeatmapWeeksForWindow('2026-10-21', '2026-10-25', { '2026-10-20': 9 }, '2026-10-23');

    expect(weeks).toHaveLength(1);
    expect(weeks[0].map((day) => day.date)[0]).toBe('2026-10-19');
    expect(weeks[0].map((day) => day.inWindow)).toEqual([false, false, true, true, true, true, true]);
    // 窗口外那天的提交不该被算进来
    expect(summarizeHeatmapWindow(weeks).commits).toBe(0);
  });

  it('终点不是周日时补到本周周日，同样不进窗口', () => {
    const weeks = buildHeatmapWeeksForWindow('2026-10-05', '2026-10-14', {}, '2026-10-23');

    expect(weeks).toHaveLength(2);
    expect(weeks[0][0].date).toBe('2026-10-05');
    expect(weeks[1][6].date).toBe('2026-10-18');
    expect(weeks[1].map((day) => day.inWindow)).toEqual([true, true, true, false, false, false, false]);
  });

  it('今天之后的格子标 elapsed=false，不计入统计', () => {
    const weeks = buildHeatmapWeeksForWindow('2026-10-19', '2026-10-25', { '2026-10-24': 5 }, '2026-10-23');
    const stats = summarizeHeatmapWindow(weeks);

    expect(weeks[0][4].elapsed).toBe(true); // 周五（今天）
    expect(weeks[0][5].elapsed).toBe(false); // 周六
    expect(stats.commits).toBe(0); // 周六那 5 次还没发生
  });
});

describe('buildMonthLabels', () => {
  const labelsOf = (startIso: string, endIso: string): string[] =>
    buildMonthLabels(buildHeatmapWeeksForWindow(startIso, endIso, {}, '2026-10-23')).map(
      (item) => item.label,
    );

  it('左边界只有一两周的残月不打标签，不能把后面完整的月份挤掉', () => {
    // 近一年从 2025-10-27 起：10 月只占首列一周。旧实现把它标成「10月」，
    // 紧接着的 11 月因「两标签不足 3 列」被丢弃，刻度成了「10月 … 12月」。
    const labels = labelsOf('2025-10-27', '2026-10-25');

    expect(labels[0]).toBe('11月');
    expect(labels[1]).toBe('12月');
    // 10 月只在窗口末尾（2026-10）出现一次，首列那个残月不再占位
    expect(labels.filter((label) => label === '10月')).toHaveLength(1);
    expect(labels[labels.length - 1]).toBe('10月');
  });

  it('近 3 个月的残月同样让位，8 月不再消失', () => {
    const labels = labelsOf('2026-07-27', '2026-10-25');

    expect(labels).toEqual(['8月', '9月', '10月']);
  });

  it('起点正好是月初时首月照常打标签', () => {
    const weeks = buildHeatmapWeeksForWindow('2026-06-01', '2026-08-30', {}, '2026-08-30');
    const labels = buildMonthLabels(weeks);

    expect(labels[0]).toEqual({ index: 0, label: '6月' });
  });

  it('标签下标递增且两两至少隔 3 列，不会叠字', () => {
    const weeks = buildHeatmapWeeksForWindow('2025-10-27', '2026-10-25', {}, '2026-10-23');
    const labels = buildMonthLabels(weeks);

    expect(labels.length).toBeGreaterThan(10);
    for (let i = 1; i < labels.length; i += 1) {
      expect(labels[i].index - labels[i - 1].index).toBeGreaterThanOrEqual(3);
    }
  });

  it('同一个月份在窗口里只出现一次', () => {
    const labels = labelsOf('2025-10-27', '2026-10-25');

    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('countRepositoriesActiveSince', () => {
  const start = '2025-10-27';

  it('窗口内有提交的才算', () => {
    const repos = [
      { lastCommitDate: '2026-10-23' },
      { lastCommitDate: '2025-10-27' }, // 正好卡在起点，算
      { lastCommitDate: '2025-10-26' }, // 差一天，不算
      { lastCommitDate: '2020-01-01' },
    ];

    expect(countRepositoriesActiveSince(repos, start)).toBe(2);
  });

  it('从没提交过的仓库不算活跃', () => {
    expect(countRepositoriesActiveSince([{ lastCommitDate: null }], start)).toBe(0);
  });

  it('窗口起点缺失时返回 0，而不是把所有仓库算进来', () => {
    // 起点为空说明网格还没建好。此时按「全部活跃」算会先闪一个偏大的数字
    expect(countRepositoriesActiveSince([{ lastCommitDate: '2026-10-23' }], '')).toBe(0);
  });
});

describe('summarizeHeatmapWindow', () => {
  it('只统计窗口内已经发生的日期', () => {
    const weeks = buildHeatmapWeeks(new Date(2026, 9, 23), {
      '2026-10-19': 4,
      '2026-10-21': 9,
      '2026-10-23': 2,
      '2025-10-27': 3,
      '2020-01-01': 500, // 窗口外
    });
    const summary = summarizeHeatmapWindow(weeks);

    expect(summary.commits).toBe(18);
    expect(summary.activeDays).toBe(4);
    expect(summary.maxDaily).toBe(9);
  });

  it('未来日期即使有数据也不计入（时钟被调过时不会虚高）', () => {
    const weeks = buildHeatmapWeeks(new Date(2026, 9, 23), { '2026-10-25': 100 });
    const summary = summarizeHeatmapWindow(weeks);

    expect(summary.commits).toBe(0);
    expect(summary.maxDaily).toBe(0);
    expect(summary.activeDays).toBe(0);
  });

  it('全空时返回零值而不是 NaN', () => {
    expect(summarizeHeatmapWindow(buildHeatmapWeeks(new Date(2026, 9, 23), {}))).toEqual({
      commits: 0,
      activeDays: 0,
      maxDaily: 0,
    });
  });
});

describe('heatmapLevel', () => {
  it('0 次提交是空格子，最大值落在最深一档', () => {
    expect(heatmapLevel(0, 100)).toBe(0);
    expect(heatmapLevel(100, 100)).toBe(4);
    expect(heatmapLevel(1, 100)).toBe(1);
  });

  it('单调不减，且不会越界', () => {
    const levels = Array.from({ length: 40 }, (_, index) => heatmapLevel(index, 39));
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]).toBeGreaterThanOrEqual(levels[index - 1]);
    }
    expect(Math.max(...levels)).toBe(4);
    expect(Math.min(...levels.slice(1))).toBe(1);
  });

  it('峰值只有 1 次时，所有有提交的日子都是最深一档', () => {
    expect(heatmapLevel(1, 1)).toBe(4);
  });
});

const emptyHourly = (): number[][] => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));

describe('summarizeHourly', () => {
  it('区分工作日 / 周末 / 深夜，并给出峰值时段', () => {
    const hourly = emptyHourly();
    hourly[0][10] = 5; // 周一 10 点
    hourly[4][15] = 3; // 周五 15 点
    hourly[5][11] = 2; // 周六 11 点
    hourly[6][23] = 4; // 周日 23 点（深夜）
    hourly[2][3] = 1; // 周三 3 点（深夜）

    const summary = summarizeHourly(hourly);

    expect(summary.total).toBe(15);
    expect(summary.workday).toBe(9);
    expect(summary.weekend).toBe(6);
    // 23 点 + 3 点
    expect(summary.lateNight).toBe(5);
    expect(summary.peak).toEqual({ weekday: 0, hour: 10, count: 5 });
  });

  it('22 点和 5 点算深夜，21 点和 6 点不算', () => {
    const hourly = emptyHourly();
    hourly[1][21] = 1;
    hourly[1][22] = 1;
    hourly[1][5] = 1;
    hourly[1][6] = 1;

    expect(summarizeHourly(hourly).lateNight).toBe(2);
  });

  it('全空时 peak 为 null，各计数为零', () => {
    expect(summarizeHourly(emptyHourly())).toEqual({
      total: 0,
      workday: 0,
      weekend: 0,
      lateNight: 0,
      peak: null,
    });
  });

  it('峰值并列时取先遇到的那一格，结果稳定', () => {
    const hourly = emptyHourly();
    hourly[3][9] = 7;
    hourly[1][9] = 7;

    expect(summarizeHourly(hourly).peak).toEqual({ weekday: 1, hour: 9, count: 7 });
  });
});

describe('bucketRepositoryFreshness', () => {
  // 2026-10-23 是周五
  const today = new Date(2026, 9, 23);

  it('按 7 / 30 / 90 天分档，边界算进更近的一档', () => {
    const buckets = bucketRepositoryFreshness(
      [
        { lastCommitDate: '2026-10-23' }, // 0 天
        { lastCommitDate: '2026-10-16' }, // 7 天
        { lastCommitDate: '2026-10-15' }, // 8 天
        { lastCommitDate: '2026-09-23' }, // 30 天
        { lastCommitDate: '2026-09-22' }, // 31 天
        { lastCommitDate: '2026-07-25' }, // 90 天
        { lastCommitDate: '2026-07-24' }, // 91 天
      ],
      today,
    );

    expect(buckets).toEqual({ week: 2, month: 2, quarter: 2, older: 1 });
  });

  it('没有提交记录的仓库不计入任何一档', () => {
    expect(bucketRepositoryFreshness([{ lastCommitDate: null }], today)).toEqual({
      week: 0,
      month: 0,
      quarter: 0,
      older: 0,
    });
  });

  it('未来日期（时钟偏差）算作最近一档，不落进「90 天以上」', () => {
    expect(bucketRepositoryFreshness([{ lastCommitDate: '2026-11-05' }], today).week).toBe(1);
  });

  it('跨年也算得对', () => {
    const buckets = bucketRepositoryFreshness([{ lastCommitDate: '2025-10-24' }], today);
    expect(buckets.older).toBe(1);
  });
});

/**
 * 键盘光标。3 列 × 7 行的手写网格比 `buildHeatmapWeeks` 更好读：
 * 只有最后几格是「还没发生」的，边界一眼能看出来。
 */
describe('热力图键盘光标', () => {
  const week = (firstDate: string, elapsedDays: number): HeatmapDay[] =>
    Array.from({ length: 7 }, (_, day) => ({
      date: `2026-10-${String(Number(firstDate) + day).padStart(2, '0')}`,
      count: day,
      elapsed: day < elapsedDays,
      inWindow: true,
    }));
  // 第 3 列只有周一到周三发生过（今天 = 周三）
  const weeks = [week('05', 7), week('12', 7), week('19', 3)];

  it('初始光标落在最后一个已发生的日子', () => {
    expect(initialHeatmapCursor(weeks)).toEqual({ week: 2, day: 2 });
  });

  it('没有已发生的日子时没有光标', () => {
    expect(initialHeatmapCursor([week('19', 0)])).toBeNull();
  });

  it('左右换一列，行不变', () => {
    expect(moveHeatmapCursor({ week: 2, day: 2 }, 'ArrowLeft', weeks)).toEqual({ week: 1, day: 2 });
    expect(moveHeatmapCursor({ week: 0, day: 2 }, 'ArrowRight', weeks)).toEqual({ week: 1, day: 2 });
  });

  it('上下换一行，到边界停住', () => {
    expect(moveHeatmapCursor({ week: 1, day: 3 }, 'ArrowUp', weeks)).toEqual({ week: 1, day: 2 });
    expect(moveHeatmapCursor({ week: 1, day: 3 }, 'ArrowDown', weeks)).toEqual({ week: 1, day: 4 });
    // 周一按上是「不动」，不是绕到上周日：视觉上那两格隔得最远
    expect(moveHeatmapCursor({ week: 1, day: 0 }, 'ArrowUp', weeks)).toBeNull();
    expect(moveHeatmapCursor({ week: 1, day: 6 }, 'ArrowDown', weeks)).toBeNull();
  });

  it('左右越界不动', () => {
    expect(moveHeatmapCursor({ week: 0, day: 2 }, 'ArrowLeft', weeks)).toBeNull();
    expect(moveHeatmapCursor({ week: 2, day: 2 }, 'ArrowRight', weeks)).toBeNull();
  });

  it('落到未来日期不动（那一格根本没画）', () => {
    // 最后一列周四之后还没发生
    expect(moveHeatmapCursor({ week: 2, day: 2 }, 'ArrowDown', weeks)).toBeNull();
  });

  it('Home / End 跳到首尾周，落点是未来时退到该列最后一个已发生的日子', () => {
    expect(moveHeatmapCursor({ week: 1, day: 2 }, 'Home', weeks)).toEqual({ week: 0, day: 2 });
    // day=5 在最后一列还没发生，应当退到周三
    expect(moveHeatmapCursor({ week: 0, day: 5 }, 'End', weeks)).toEqual({ week: 2, day: 2 });
  });

  it('空网格没有光标，方向键也不会崩', () => {
    expect(moveHeatmapCursor({ week: 0, day: 0 }, 'ArrowRight', [])).toBeNull();
  });
});

describe('flattenWindowDays', () => {
  /** 一个不对齐整周的自定义窗口：2026-10-07（周三）~ 2026-10-20（周二）。 */
  const windowWeeks = () =>
    buildHeatmapWeeksForWindow(
      '2026-10-07',
      '2026-10-20',
      { '2026-10-07': 3, '2026-10-08': 1, '2026-10-20': 5 },
      '2026-10-24',
    );

  it('只摊平窗口内的日子，按日期升序', () => {
    const points = flattenWindowDays(windowWeeks());

    // 10-07 到 10-20 共 14 天；首尾两列多出来的 10-05/06 与 10-21~25 不在窗口内
    expect(points).toHaveLength(14);
    expect(points[0].date).toBe('2026-10-07');
    expect(points[points.length - 1].date).toBe('2026-10-20');
    expect(points.map((p) => p.date)).toEqual([...points.map((p) => p.date)].sort());
  });

  it('和网格用同一套判据，总数与峰值不会两样', () => {
    const weeks = windowWeeks();
    const points = flattenWindowDays(weeks);
    const summary = summarizeHeatmapWindow(weeks);

    expect(points.reduce((sum, p) => sum + p.count, 0)).toBe(summary.commits);
    expect(points.filter((p) => p.count > 0)).toHaveLength(summary.activeDays);
    expect(Math.max(...points.map((p) => p.count))).toBe(summary.maxDaily);
  });

  it('今天之后的日子不摊平（那一格本来就不画）', () => {
    const weeks = buildHeatmapWeeksForWindow('2026-10-01', '2026-10-31', {}, '2026-10-10');
    const points = flattenWindowDays(weeks);

    expect(points[points.length - 1].date).toBe('2026-10-10');
    expect(points).toHaveLength(10);
  });
});

describe('layoutDailyBars', () => {
  const points = (counts: number[]) =>
    counts.map((count, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, count }));

  it('铺满整幅：最后一格贴着右边缘，柱子都在自己的槽里居中', () => {
    const layout = layoutDailyBars(points(new Array(91).fill(1)), { width: 1332, plotHeight: 132 });

    expect(layout.slot).toBeCloseTo(1332 / 91, 5);
    expect(layout.slots[0].x).toBe(0);
    const lastSlot = layout.slots[layout.slots.length - 1];
    expect(lastSlot.x + lastSlot.width).toBeCloseTo(1332, 5);
    expect(layout.bars).toHaveLength(91);
    // 柱子不贴边：左右各留半个槽间距，最后一根不会骑在卡片边缘上
    layout.bars.forEach((bar, index) => {
      expect(bar.x).toBeGreaterThanOrEqual(layout.slots[index].x);
      expect(bar.x + bar.width).toBeLessThanOrEqual(layout.slots[index].x + layout.slots[index].width);
    });
  });

  it('高度与提交数成正比，空白天只留一根短桩', () => {
    const layout = layoutDailyBars(points([0, 5, 10]), { width: 300, plotHeight: 100 });

    expect(layout.maxCount).toBe(10);
    expect(layout.bars[0].height).toBe(dailyBarStubHeight);
    expect(layout.bars[1].height).toBeCloseTo(50, 5);
    expect(layout.bars[2].height).toBeCloseTo(100, 5);
    // 有提交就不该和空白天一样高：1 次的柱子最矮 3px
    const one = layoutDailyBars(points([0, 1]), { width: 200, plotHeight: 132 });
    expect(one.bars[1].height).toBeGreaterThan(dailyBarStubHeight);
  });

  it('柱子最宽 60px：7 天不会摊成七块色板', () => {
    const layout = layoutDailyBars(points(new Array(7).fill(2)), { width: 1332, plotHeight: 132 });

    expect(layout.barWidth).toBe(60);
    // 槽位仍然是 190px，柱子在槽里居中
    expect(layout.slot).toBeCloseTo(1332 / 7, 5);
    expect(layout.bars[0].x).toBeCloseTo((1332 / 7 - 60) / 2, 5);
  });

  it('日期刻度不超过上限，首尾不被裁到绘图区外', () => {
    for (const total of [7, 45, 91]) {
      const layout = layoutDailyBars(points(new Array(total).fill(1)), { width: 1332, plotHeight: 132 });
      expect(layout.ticks.length).toBeLessThanOrEqual(7);
      // 刻度是 text-anchor: middle，两端要留出半个字宽
      expect(layout.ticks[0].x).toBeGreaterThanOrEqual(16);
      expect(layout.ticks[layout.ticks.length - 1].x).toBeLessThanOrEqual(1332 - 16);
    }
  });

  it('刻度写成「月/日」，不写前导零', () => {
    const layout = layoutDailyBars(points([1, 1]), { width: 300, plotHeight: 100 });

    expect(layout.ticks[0].label).toBe('10/1');
  });

  it('整段没有提交时也排得出图，不除零', () => {
    const layout = layoutDailyBars(points(new Array(30).fill(0)), { width: 600, plotHeight: 132 });

    expect(layout.maxCount).toBe(0);
    expect(layout.bars.every((bar) => bar.height === dailyBarStubHeight)).toBe(true);
    expect(layout.ticks.length).toBeGreaterThan(0);
  });

  it('宽度为 0（还没量出容器）时给一份空布局，不抛错', () => {
    expect(layoutDailyBars(points([1, 2]), { width: 0, plotHeight: 132 }).bars).toEqual([]);
    expect(layoutDailyBars([], { width: 600, plotHeight: 132 }).bars).toEqual([]);
  });
});

describe('moveDailyBarCursor', () => {
  it('左右走一天，上下走一周', () => {
    expect(moveDailyBarCursor(10, 'ArrowLeft', 91)).toBe(9);
    expect(moveDailyBarCursor(10, 'ArrowRight', 91)).toBe(11);
    expect(moveDailyBarCursor(10, 'ArrowUp', 91)).toBe(3);
    expect(moveDailyBarCursor(10, 'ArrowDown', 91)).toBe(17);
  });

  it('Home / End 跳到首尾', () => {
    expect(moveDailyBarCursor(40, 'Home', 91)).toBe(0);
    expect(moveDailyBarCursor(40, 'End', 91)).toBe(90);
  });

  it('越界返回 null，不弹回也不绕回', () => {
    expect(moveDailyBarCursor(0, 'ArrowLeft', 91)).toBeNull();
    expect(moveDailyBarCursor(0, 'ArrowUp', 91)).toBeNull();
    expect(moveDailyBarCursor(90, 'ArrowRight', 91)).toBeNull();
    expect(moveDailyBarCursor(90, 'ArrowDown', 91)).toBeNull();
    expect(moveDailyBarCursor(0, 'ArrowRight', 0)).toBeNull();
  });
});
