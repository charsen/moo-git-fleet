import { computed, ref, shallowRef } from 'vue';
import type { DiffKind } from './repository-workspace';

export interface HistoryReading {
  search: string;
  searchField: 'message' | 'author' | 'hash';
  hash: string | null;
  listTop: number;
  previewTop: number;
  previewLeft: number;
  expanded: [string, boolean][];
  comparisonPreview?: 'changes' | 'commit';
}
export interface ReferenceReading { key: string | null; listTop: number; previewTop: number; expanded: [string, boolean][] }
export interface RevisionReading { commit: string; directory: string; path: string | null; skip: number; search: string; blame: boolean; listTop: number; previewTop: number; previewLeft: number }
export interface ReflogReading { ref: string; key: string | null; listTop: number; previewTop: number; expanded: [string, boolean][] }
export interface WorkspaceReading {
  view: 'working' | 'history' | 'stash' | 'tags' | 'tree' | 'reflog';
  reference?: string;
  scope: 'all' | 'ref' | 'outgoing' | 'incoming' | 'compare';
  baseRef?: string;
  filePath?: string;
  startTip?: string;
  branch: string | null;
  history?: HistoryReading;
  references?: ReferenceReading;
  tree?: RevisionReading;
  reflog?: ReflogReading;
  working?: { path?: string; kind?: DiffKind; search: string; listTop: number; previewTop: number; previewLeft: number };
}
/** Reading navigation only: snapshots contain no Git mutation or checkout callbacks. */
export function useReadingNavigation<T>(limit = 64) {
  const entries = shallowRef<T[]>([]);
  const index = ref(-1);
  const canBack = computed(() => index.value > 0);
  const canForward = computed(() => index.value >= 0 && index.value < entries.value.length - 1);
  function visit(current: T, next: T): void {
    if (index.value < 0) { entries.value = [current]; index.value = 0; }
    else entries.value[index.value] = current;
    entries.value = [...entries.value.slice(0, index.value + 1), next].slice(-limit);
    index.value = entries.value.length - 1;
  }
  function move(current: T, direction: -1 | 1): T | undefined {
    if (direction === -1 ? !canBack.value : !canForward.value) return;
    entries.value[index.value] = current;
    index.value += direction;
    return entries.value[index.value];
  }
  return { canBack, canForward, visit, move };
}
