/**
 * Fault isolation helpers for the render loop: throttled error logging per layer and a no-op stand-in object for
 * sub-renderers whose constructor failed (so one broken layer never takes down the whole renderer).
 * OWNER: render-scene.
 */

export class ThrottledErrorLog {
  private readonly last = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();

  constructor(private readonly intervalMs = 5000) {}

  error(layer: string, message: string, err: unknown): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this.last.get(layer) ?? -Infinity;
    if (now - last < this.intervalMs) {
      this.suppressed.set(layer, (this.suppressed.get(layer) ?? 0) + 1);
      return;
    }
    const skipped = this.suppressed.get(layer) ?? 0;
    this.suppressed.set(layer, 0);
    this.last.set(layer, now);
    console.error(`[render:${layer}] ${message}${skipped ? ` (+${skipped} similar errors suppressed)` : ''}`, err);
  }
}

/**
 * A stand-in whose every method is a no-op returning undefined (arrays for `get*` methods, null for `pick`).
 * Used when a sub-renderer fails to construct.
 */
export function createNullRenderer<T>(name: string): T {
  const fns = new Map<PropertyKey, unknown>();
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      if (prop === 'isNullRenderer') return true;
      if (prop === 'name') return name;
      let fn = fns.get(prop);
      if (!fn) {
        const p = String(prop);
        fn = p.startsWith('get') ? () => [] : p === 'pick' ? () => null : () => undefined;
        fns.set(prop, fn);
      }
      return fn;
    },
  };
  return new Proxy({}, handler) as T;
}
