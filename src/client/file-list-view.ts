import { inject, provide, ref, type InjectionKey, type Ref } from 'vue';

/**
 * 文件清单的平铺 / 树形偏好。
 *
 * 它同时被工作区中栏和 `RepositoryChanges`（提交详情、分支对比、Stash/Tag、Reflog 四处共用）
 * 使用，而后者嵌在工作区/历史面板里，逐层透传要改 4 个组件的 props 与 emits；
 * 这里用一个窄上下文 `provide` 一次，消费方 `inject` 即可。
 */
export type FileListView = 'flat' | 'tree';

export interface FileListViewContext {
  view: Ref<FileListView>;
  set: (view: FileListView) => void;
}

export const fileListViewKey: InjectionKey<FileListViewContext> = Symbol('moo-fleet:file-list-view');

export function provideFileListView(context: FileListViewContext): void {
  provide(fileListViewKey, context);
}

/** 没有 Provider 时（例如单独挂载某个组件）退化为平铺且不可切换。 */
export function useFileListView(): FileListViewContext {
  return inject(fileListViewKey, { view: ref<FileListView>('flat'), set: () => undefined });
}
