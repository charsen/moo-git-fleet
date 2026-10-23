import { describe, expect, it } from 'vitest';
import {
  bucketRepositoryFreshness,
  buildHeatmapWeeks,
  buildHeatmapWeeksForWindow,
  countRepositoriesActiveSince,
  heatmapLevel,
  localIsoDate,
  summarizeHeatmapWindow,
  summarizeHourly,
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

  it('起点不是周一时仍然从那天起始，不偷偷往前挪一周', () => {
    // 服务端保证起点是周一；万一哪天不是，也不该凭空多画一周没数据的格子
    const weeks = buildHeatmapWeeksForWindow('2026-10-21', '2026-10-25', {}, '2026-10-23');

    expect(weeks).toHaveLength(1);
    expect(weeks[0].map((day) => day.date)[0]).toBe('2026-10-21');
  });

  it('今天之后的格子标 elapsed=false，不计入统计', () => {
    const weeks = buildHeatmapWeeksForWindow('2026-10-19', '2026-10-25', { '2026-10-24': 5 }, '2026-10-23');
    const stats = summarizeHeatmapWindow(weeks);

    expect(weeks[0][4].elapsed).toBe(true); // 周五（今天）
    expect(weeks[0][5].elapsed).toBe(false); // 周六
    expect(stats.commits).toBe(0); // 周六那 5 次还没发生
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
