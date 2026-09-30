import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommitDetail, CommitPage, CommitPageQuery, RepositoryCommit } from '../shared/contracts';
import { useRepositoryHistory } from './use-repository-history';
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
const hash = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number): RepositoryCommit => ({ hash: hash(n), subject: `commit ${n}`, author: 'Test', committedAt: '2026-09-30T00:00:00Z', tags: [] });
const detail = (n: number): CommitDetail => ({ ...commit(n), body: '', parents: [], patch: `patch ${n}`, stat: '', truncated: false, files: [] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
async function settled() { await nextTick(); await Promise.resolve(); await nextTick(); }
function setup() {
  const reference = ref<string | undefined>(); const active = ref(false); const revision = ref('r1');
  const page = vi.fn(async (_id: string, _query: CommitPageQuery): Promise<CommitPage> => ({ commits: [commit(2), commit(1)], hasMore: true, tip: hash(2) }));
  const readDetail = vi.fn(async (_id: string, h: string) => detail(parseInt(h, 16)));
  const scope = effectScope(); scopes.push(scope);
  const history = scope.run(() => useRepositoryHistory({ repositoryId: () => 'demo', reference: () => reference.value, revision: () => revision.value, active: () => active.value, readPage: page, readDetail }))!;
  return { reference, active, revision, page, readDetail, history };
}
describe('branch history reading', () => {
  it('loads lazily, selects the newest commit and pins subsequent pages', async () => {
    const { active, page, history } = setup(); expect(page).not.toHaveBeenCalled(); active.value = true; await settled();
    expect(history.state.value.detail?.hash).toBe(hash(2));
    page.mockResolvedValueOnce({ commits: [commit(0)], hasMore: false }); await history.loadMore();
    expect(page).toHaveBeenLastCalledWith('demo', { ref: undefined, tip: hash(2), limit: 20, skip: 2 });
    expect(history.state.value.commits).toHaveLength(3);
  });
  it('ignores late branch pages, errors and detail responses', async () => {
    const { active, reference, page, history } = setup(); const old = deferred<CommitPage>(); page.mockImplementationOnce(() => old.promise);
    active.value = true; await nextTick(); reference.value = 'refs/heads/dev'; await settled(); old.reject(new Error('late branch error')); await settled();
    expect(history.state.value.error).toBe(''); expect(history.state.value.detail?.hash).toBe(hash(2));
  });
  it('keeps only the latest selected commit when preview responses arrive out of order', async () => {
    const { active, readDetail, history } = setup(); active.value = true; await settled();
    const old = deferred<CommitDetail>(); readDetail.mockImplementationOnce(() => old.promise); const pending = history.select(hash(1));
    await history.select(hash(2)); old.resolve(detail(1)); await pending;
    expect(history.state.value.detail?.hash).toBe(hash(2)); expect(history.state.value.detailLoading).toBe(false);
  });
  it('restores branch selection and loaded records after changing views or browsing another branch', async () => {
    const { active, reference, page, history } = setup(); active.value = true; await settled(); await history.select(hash(1)); active.value = false; active.value = true; await settled();
    expect(history.state.value.selectedHash).toBe(hash(1)); reference.value = 'refs/heads/dev'; await settled(); reference.value = undefined; await settled();
    expect(history.state.value.selectedHash).toBe(hash(1)); expect(history.state.value.detail?.hash).toBe(hash(1)); expect(page).toHaveBeenCalledTimes(2);
  });
  it('does not let an old load-more completion unlock a newer branch request', async () => {
    const { active, reference, page, history } = setup(); active.value = true; await settled();
    const old = deferred<CommitPage>(); page.mockImplementationOnce(() => old.promise); const pending = history.loadMore();
    reference.value = 'refs/heads/dev'; await settled(); old.resolve({ commits: [commit(0)], hasMore: false }); await pending;
    expect(history.state.value.commits.map(c => c.hash)).toEqual([hash(2), hash(1)]);
    expect(history.state.value.hasMore).toBe(true);
  });
  it('refreshes changed branch heads and rejects mismatched commit identity', async () => {
    const { active, revision, page, readDetail, history } = setup(); active.value = true; await settled();
    revision.value = 'r2'; await settled(); expect(page).toHaveBeenCalledTimes(2);
    readDetail.mockResolvedValueOnce(detail(99)); await history.select(hash(1)); expect(history.state.value.detail).toBeNull(); expect(history.state.value.detailError).toContain('身份');
  });
});
