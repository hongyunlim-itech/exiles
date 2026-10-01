/** Minimal typed event bus. */
export type Listener<T> = (payload: T) => void;

export class EventBus<E extends object> {
  private listeners = new Map<keyof E, Set<Listener<any>>>();

  on<K extends keyof E>(type: K, fn: Listener<E[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => this.off(type, fn);
  }

  off<K extends keyof E>(type: K, fn: Listener<E[K]>): void {
    this.listeners.get(type)?.delete(fn);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] listener for "${String(type)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
