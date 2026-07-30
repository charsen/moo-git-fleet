import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

const now = new Date('2026-07-30T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

const second = 1_000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

describe('relativeTime', () => {
  it('按秒 / 分钟 / 小时 / 天逐级取整', () => {
    expect(relativeTime(ago(5 * second), { now })).toBe('5 秒前');
    expect(relativeTime(ago(90 * second), { now })).toBe('1 分钟前');
    expect(relativeTime(ago(3 * hour), { now })).toBe('3 小时前');
    expect(relativeTime(ago(2 * day), { now })).toBe('2 天前');
  });

  it('默认超过 30 天继续数天数（仓库列表看新鲜度）', () => {
    expect(relativeTime(ago(29 * day), { now })).toBe('29 天前');
    expect(relativeTime(ago(400 * day), { now })).toBe('400 天前');
  });

  it('指定 longAgo: date 时超过 30 天换成日期（会话列表更好认）', () => {
    expect(relativeTime(ago(29 * day), { now, longAgo: 'date' })).toBe('29 天前');
    expect(relativeTime(ago(400 * day), { now, longAgo: 'date' }))
      .toBe(new Date(now - 400 * day).toLocaleDateString());
  });

  it('无法解析的时间不会显示成 NaN', () => {
    expect(relativeTime('这不是时间', { now })).toBe('时间未知');
    expect(relativeTime('2026-13-45T99:99:99Z', { now })).toBe('时间未知');
  });

  it('空值用调用方指定的占位', () => {
    expect(relativeTime(null, { now })).toBe('时间未知');
    expect(relativeTime(undefined, { now, empty: '—' })).toBe('—');
    expect(relativeTime('', { now, empty: '—' })).toBe('—');
  });

  it('时间在未来时按 0 秒处理，不出现负数', () => {
    expect(relativeTime(new Date(now + 10 * minute).toISOString(), { now })).toBe('0 秒前');
  });
});
