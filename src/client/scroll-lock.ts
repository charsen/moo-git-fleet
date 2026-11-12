import { onActivated, onDeactivated, onScopeDispose, watch } from 'vue';

/**
 * 根滚动锁：由弹层状态显式登记，而不是靠 CSS `:has()` 去猜 DOM 里还有没有遮罩。
 *
 * 旧实现是 `html:has(.modal-backdrop, .drawer-backdrop, …) { overflow: hidden }`。
 * 条件消失后 WKWebView 偶尔不重算这条规则，弹层已经关掉、`overflow: hidden` 却还留着，
 * 主界面就完全滚不动；再开关一次项目详情（又一次 DOM 变化）才恢复。`<transition>` 的
 * 离场节点也会在 DOM 里多留 160 ms，同样会让基于节点存在与否的判定滞后。
 *
 * 现在每个来源用唯一名字登记：任意一个还要锁，html 就带 `scroll-locked`；全部来源都
 * 关掉就无条件摘掉。class 切换本身会触发样式重算，不再依赖 `:has()` 的失效时机。
 * 多个来源可以叠加（例如会话页的抽屉 + App 级确认弹窗），先关的那个不会误解锁。
 */
const lockOwners = new Set<string>();

function syncScrollLock(): void {
  document.documentElement.classList.toggle('scroll-locked', lockOwners.size > 0);
}

/** 登记 / 注销一个滚动锁来源；重复登记同一状态没有副作用。 */
export function setScrollLock(owner: string, locked: boolean): void {
  if (locked) lockOwners.add(owner);
  else lockOwners.delete(owner);
  syncScrollLock();
}

/**
 * 组件内使用：状态为真时保持锁定，组件卸载或 `<KeepAlive>` 停用时自动注销，重新激活时
 * 按当时的状态恢复。会话页被 KeepAlive 缓存，停用时它的 Teleport 层状态还留在内存里，
 * 不显式注销就会把主界面的滚动一直锁住。
 */
export function useScrollLock(owner: string, locked: () => boolean): void {
  const apply = (): void => setScrollLock(owner, Boolean(locked()));
  watch(locked, apply, { flush: 'sync', immediate: true });
  onActivated(apply);
  onDeactivated(() => setScrollLock(owner, false));
  onScopeDispose(() => setScrollLock(owner, false));
}
