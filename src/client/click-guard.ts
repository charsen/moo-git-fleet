/**
 * 拖选文字之后的点击。
 *
 * `click` 只在「按下点与松开点是同一个元素」时照常派发，拖选文字正好满足这个条件：
 * 在仓库行里按住左键拖过仓库名/路径再松手，浏览器仍会派发一次 click，
 * 于是「选中文字准备复制」被当成「点了这一行」，抽屉直接顶出来。
 *
 * 判据：有非空选区、且选区就落在这一行内时，忽略这次点击。
 * 点击别处时浏览器会先把选区收起，所以不会误伤正常点击。
 */

export interface ClickSelectionState {
  collapsed: boolean;
  text: string;
  insideRoot: boolean;
}

export function ignoresClickAfterSelection(state: ClickSelectionState): boolean {
  return !state.collapsed && state.text.trim().length > 0 && state.insideRoot;
}

/** `root` 内是否存在非空选区；`root` 传当前被点击的那个容器。 */
export function hasActiveSelectionWithin(root: Element | null): boolean {
  if (!root) return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  return ignoresClickAfterSelection({
    collapsed: selection.isCollapsed,
    text: selection.toString(),
    insideRoot: root.contains(selection.getRangeAt(0).commonAncestorContainer),
  });
}
