import { describe, expect, it } from 'vitest';
import {
  beginBackdropGesture,
  endBackdropGesture,
  IDLE_BACKDROP_GESTURE,
  resolvesBackdropClick,
} from './backdrop-close';

/** 走一遍完整的「按下 → 松开 → 点击」手势，返回是否应当关闭。 */
function clickThrough(pressedOnBackdrop: boolean, releasedOnBackdrop: boolean, clickedOnBackdrop = true): boolean {
  const afterDown = beginBackdropGesture(pressedOnBackdrop);
  const afterUp = endBackdropGesture(afterDown, releasedOnBackdrop);
  return resolvesBackdropClick(afterUp, clickedOnBackdrop);
}

describe('backdrop dismiss gesture', () => {
  it('closes when press, release and click all land on the backdrop', () => {
    expect(clickThrough(true, true)).toBe(true);
  });

  it('stays open when the press starts inside the dialog and the release lands on the backdrop', () => {
    // 这是用户报的那个 bug：在弹窗里按住鼠标选字、往窗口外一拖再松手。
    // click 的 target 是按下点与松开点的最近公共祖先，而弹窗是遮罩的子节点，
    // 公共祖先正是遮罩 —— 只看 `@click.self` 就会把它当成「点了遮罩」。
    expect(clickThrough(false, true)).toBe(false);
  });

  it('stays open when the press starts on the backdrop but the release happens inside the dialog', () => {
    expect(clickThrough(true, false)).toBe(false);
  });

  it('stays open when neither end of the gesture touches the backdrop', () => {
    expect(clickThrough(false, false, false)).toBe(false);
  });

  it('ignores a click that did not land on the backdrop', () => {
    expect(resolvesBackdropClick(beginBackdropGesture(true), false)).toBe(false);
  });

  it('forgets the press once the gesture ends inside the dialog', () => {
    // 一次「按在弹窗里」的手势不能留下残余状态，否则紧接着的点击会被误判成关闭。
    expect(endBackdropGesture(beginBackdropGesture(false), true)).toEqual(IDLE_BACKDROP_GESTURE);
    expect(resolvesBackdropClick(IDLE_BACKDROP_GESTURE, true)).toBe(false);
  });

  it('requires a fresh press before every dismissal', () => {
    const pressed = endBackdropGesture(beginBackdropGesture(true), true);
    expect(resolvesBackdropClick(pressed, true)).toBe(true);
    // 关闭动作执行后指令会重置成 idle；没有新的按下就不该再触发一次。
    expect(resolvesBackdropClick(IDLE_BACKDROP_GESTURE, true)).toBe(false);
  });
});
