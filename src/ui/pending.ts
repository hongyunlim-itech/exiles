/**
 * Co-op "pending" values. In co-op a command is only queued when the player clicks (the host applies it at a later
 * turn), so a control that re-reads the game at 4 Hz would snap back to the old value for a moment and a second quick
 * click would build on stale data. Controls remember what the player asked for here and show that value until the
 * shared game reflects it (or a timeout passes, e.g. when the host rejected the command).
 *
 * Solo play never records anything (commands apply immediately), so solo behaviour is unchanged.
 */

export type PendingValue = number | string | boolean | null;

interface Entry {
  value: PendingValue;
  until: number;
}

/** Default time a requested value is shown before falling back to the game's value (ms). */
export const PENDING_TTL_MS = 4000;

export class PendingValues {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Remember that `key` was requested to become `value`. */
  set(key: string, value: PendingValue, ttlMs = PENDING_TTL_MS): void {
    this.map.set(key, { value, until: this.now() + ttlMs });
  }

  /**
   * The value to display for `key`: the requested value while it is pending, else `actual`. The entry is dropped as
   * soon as the game reports the requested value or the entry expires.
   */
  get<T extends PendingValue>(key: string, actual: T): T {
    const e = this.map.get(key);
    if (!e) return actual;
    if (e.value === actual || this.now() > e.until) {
      this.map.delete(key);
      return actual;
    }
    return e.value as T;
  }

  /** True while `key` has a pending request that differs from `actual`. */
  isPending(key: string, actual: PendingValue): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    if (e.value === actual || this.now() > e.until) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Pending-value keys shared by the building panel and the professions window. */
export const pendingKey = {
  workers: (id: number) => `workers:${id}`,
  builders: () => 'builders',
  paused: (id: number) => `paused:${id}`,
  priority: (id: number) => `priority:${id}`,
  crop: (id: number) => `crop:${id}`,
  recipe: (id: number) => `recipe:${id}`,
  merchant: () => 'merchant',
} as const;
