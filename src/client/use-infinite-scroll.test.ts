import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInfiniteScroll } from './use-infinite-scroll';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); });

function setup() {
  const observers: { notify: (visible: boolean) => void; disconnect: ReturnType<typeof vi.fn>; init: IntersectionObserverInit }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
      observers.push({ notify: visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver), disconnect: this.disconnect, init });
    }
  });
  const enabled = ref(true), count = ref(20), context = ref('first');
  const root = ref({} as HTMLElement), sentinel = ref({} as HTMLElement);
  const load = vi.fn(async () => { count.value += 20; });
  const scope = effectScope(); scopes.push(scope);
  scope.run(() => useInfiniteScroll({ root, sentinel, enabled: () => enabled.value, context: () => context.value, count: () => count.value, loadMore: load }));
  return { observers, enabled, count, context, root, load, scope };
}
async function settled() { await nextTick(); await Promise.resolve(); await nextTick(); }

describe('automatic list pagination', () => {
  it('uses the list viewport and only fetches when the bottom approaches it', async () => {
    const { observers, root, load } = setup(); await settled();
    expect(observers[0].init).toEqual({ root: root.value, rootMargin: '0px 0px 240px 0px', threshold: 0 });
    observers[0].notify(false); expect(load).not.toHaveBeenCalled();
    observers[0].notify(true); await settled(); expect(load).toHaveBeenCalledTimes(1);
    observers.at(-1)!.notify(true); await settled(); expect(load).toHaveBeenCalledTimes(2);
  });
  it('serializes repeated notifications while a page is in flight', async () => {
    const { observers, load } = setup(); await settled();
    let finish!: () => void;
    load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    observers[0].notify(true); observers[0].notify(true); await settled();
    expect(load).toHaveBeenCalledTimes(1); expect(observers[0].disconnect).toHaveBeenCalled();
    finish(); await settled(); observers.at(-1)!.notify(true); await settled();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('pauses on hidden, failed or exhausted lists and ignores obsolete callbacks after context changes', async () => {
    const { observers, enabled, context, load } = setup(); await settled();
    enabled.value = false; observers[0].notify(true); await settled(); expect(load).not.toHaveBeenCalled();
    enabled.value = true; context.value = 'second'; await settled();
    observers[0].notify(true); expect(load).not.toHaveBeenCalled();
    observers.at(-1)!.notify(true); await settled(); expect(load).toHaveBeenCalledTimes(1);
    enabled.value = false; await settled(); observers.at(-1)!.notify(true); expect(load).toHaveBeenCalledTimes(1);
  });
  it('disconnects on disposal and ignores callbacks already queued by the browser', async () => {
    const { observers, load, scope } = setup(); await settled();
    scope.stop(); observers[0].notify(true);
    expect(observers[0].disconnect).toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  });
});
