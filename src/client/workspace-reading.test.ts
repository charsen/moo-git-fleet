import { describe, expect, it } from 'vitest';
import { useReadingNavigation } from './workspace-reading';
describe('reading navigation', () => {
  it('restores snapshots in both directions and drops forward entries after a new destination', () => {
    const nav = useReadingNavigation<{ hash: string; scroll: number }>();
    nav.visit({ hash: 'a', scroll: 10 }, { hash: 'b', scroll: 0 });
    nav.visit({ hash: 'b', scroll: 30 }, { hash: 'c', scroll: 0 });
    expect(nav.move({ hash: 'c', scroll: 50 }, -1)).toEqual({ hash: 'b', scroll: 30 });
    expect(nav.move({ hash: 'b', scroll: 40 }, -1)).toEqual({ hash: 'a', scroll: 10 });
    expect(nav.canBack.value).toBe(false);
    expect(nav.move({ hash: 'a', scroll: 20 }, 1)).toEqual({ hash: 'b', scroll: 40 });
    nav.visit({ hash: 'b', scroll: 60 }, { hash: 'd', scroll: 0 });
    expect(nav.canForward.value).toBe(false);
    expect(nav.move({ hash: 'd', scroll: 0 }, -1)).toEqual({ hash: 'b', scroll: 60 });
  });
  it('bounds per-window history and ignores unavailable moves', () => {
    const nav = useReadingNavigation<number>(3);
    expect(nav.move(0, -1)).toBeUndefined();
    for (let i = 0; i < 8; i++) nav.visit(i, i + 1);
    expect(nav.move(8, -1)).toBe(7); expect(nav.move(7, -1)).toBe(6);
    expect(nav.move(6, -1)).toBeUndefined(); expect(nav.move(6, 1)).toBe(7);
  });
});
