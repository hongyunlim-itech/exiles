/**
 * Storage buildings (stockpiles, barns, markets, trading posts): capacity, reservations-aware queries, instant
 * add/take used by other modules. ARCHITECTURE §3.5 "Storage". OWNER: sim-core.
 */
import { RESOURCES, RESOURCE_TYPES, BUILDINGS, FOOD_TYPES } from '../../core/defs';
import type { Building, ResourceType } from '../../core/types';
import type { Game } from '../game';
import { dist2, invAdd, invGet, invTake, invTotal } from './util';

export function storageCapacity(b: Building): number {
  const st = BUILDINGS[b.type].storage;
  if (!st) return 0;
  return st.perTile ? st.capacity * b.w * b.h : st.capacity;
}

export function storageUsed(b: Building): number {
  return invTotal(b.inventory);
}

/** Capacity not used and not promised to incoming deliveries. */
export function storageFree(b: Building): number {
  return Math.max(0, storageCapacity(b) - storageUsed(b) - b.reservedIn);
}

export function storageAccepts(b: Building, r: ResourceType): boolean {
  const st = BUILDINGS[b.type].storage;
  return !!st && st.kinds.includes(RESOURCES[r].storage);
}

/** Markets & trading posts are "shops": not used as general deposit targets. */
export function isShop(b: Building): boolean {
  return b.type === 'market' || b.type === 'tradingPost';
}

/** Items present and not promised to anybody. */
export function unreserved(b: Building, r: ResourceType): number {
  return Math.max(0, invGet(b.inventory, r) - invGet(b.reservedOut, r));
}

export interface SourceOpts {
  /** Include markets (households, eating). Default false. */
  markets?: boolean;
  /** Include trading posts (default true). */
  posts?: boolean;
  /** Minimum unreserved amount (default 1). */
  min?: number;
  /** Building id to skip. */
  exclude?: number;
  /** Only consider sources within this distance. */
  maxDist?: number;
  /** Reject sources for which this returns false (e.g. unreachable). */
  filter?: (b: Building) => boolean;
}

/** Nearest active storage with at least `min` unreserved units of r. */
export function findSource(g: Game, r: ResourceType, x: number, z: number, opts: SourceOpts = {}): Building | null {
  const min = opts.min ?? 1;
  const maxD2 = opts.maxDist !== undefined ? opts.maxDist * opts.maxDist : Infinity;
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of g.rt.storages(g.state)) {
    if (b.state !== 'active' || b.id === opts.exclude) continue;
    if (b.type === 'market' && !opts.markets) continue;
    if (b.type === 'tradingPost' && opts.posts === false) continue;
    if (unreserved(b, r) < min) continue;
    const d = dist2(x, z, b.doorX + 0.5, b.doorZ + 0.5);
    if (d >= bestD || d > maxD2) continue;
    if (opts.filter && !opts.filter(b)) continue;
    best = b;
    bestD = d;
  }
  return best;
}

/** Nearest storage holding at least `min` units of any food. */
export function findFoodSource(g: Game, x: number, z: number, opts: SourceOpts = {}): Building | null {
  const min = opts.min ?? 1;
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of g.rt.storages(g.state)) {
    if (b.state !== 'active' || b.id === opts.exclude) continue;
    if (b.type === 'market' && opts.markets === false) continue;
    if (b.type === 'tradingPost' && opts.posts === false) continue;
    if (unreservedFood(b) < min) continue;
    const d = dist2(x, z, b.doorX + 0.5, b.doorZ + 0.5);
    if (d >= bestD) continue;
    if (opts.filter && !opts.filter(b)) continue;
    best = b;
    bestD = d;
  }
  return best;
}

export function unreservedFood(b: Building): number {
  let t = 0;
  for (const r of FOOD_TYPES) t += unreserved(b, r);
  return t;
}

export interface DepositOpts {
  /** Allow markets / trading posts as targets (default: only as a fallback). */
  shops?: boolean;
  exclude?: number;
  filter?: (b: Building) => boolean;
}

/**
 * Nearest active storage that accepts r and has free capacity. Stockpiles/barns first; shops only when nothing
 * else has room (or opts.shops).
 */
export function findDepositTarget(g: Game, r: ResourceType, x: number, z: number, opts: DepositOpts = {}): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  let shop: Building | null = null;
  let shopD = Infinity;
  for (const b of g.rt.storages(g.state)) {
    if (b.state !== 'active' || b.id === opts.exclude) continue;
    if (!storageAccepts(b, r)) continue;
    if (storageFree(b) < 1) continue;
    const d = dist2(x, z, b.doorX + 0.5, b.doorZ + 0.5);
    if (isShop(b) && !opts.shops) {
      if (d < shopD && (!opts.filter || opts.filter(b))) {
        shop = b;
        shopD = d;
      }
      continue;
    }
    if (d >= bestD) continue;
    if (opts.filter && !opts.filter(b)) continue;
    best = b;
    bestD = d;
  }
  return best ?? shop;
}

/** Instantly store resources (nearest storages first). Returns amount stored. */
export function addToStorageNow(g: Game, r: ResourceType, amount: number, nearX?: number, nearZ?: number, excludeId = -1): number {
  if (!(amount > 0)) return 0;
  const list = g.rt.storages(g.state).filter((b) => b.state === 'active' && b.id !== excludeId && storageAccepts(b, r) && storageFree(b) > 0);
  if (nearX !== undefined && nearZ !== undefined) {
    list.sort((a, b) => {
      const pa = isShop(a) ? 1e9 : 0;
      const pb = isShop(b) ? 1e9 : 0;
      return pa + dist2(nearX, nearZ, a.doorX, a.doorZ) - (pb + dist2(nearX, nearZ, b.doorX, b.doorZ));
    });
  } else {
    list.sort((a, b) => (isShop(a) ? 1 : 0) - (isShop(b) ? 1 : 0));
  }
  let left = amount;
  for (const b of list) {
    if (left <= 0) break;
    const put = Math.min(left, storageFree(b));
    if (put <= 0) continue;
    invAdd(b.inventory, r, put);
    left -= put;
  }
  return amount - left;
}

/** Instantly remove unreserved resources from storages. Returns amount taken. */
export function takeFromStorageNow(g: Game, r: ResourceType, amount: number): number {
  if (!(amount > 0)) return 0;
  let left = amount;
  // shops last so market stock stays for households
  const list = [...g.rt.storages(g.state)].sort((a, b) => (isShop(a) ? 1 : 0) - (isShop(b) ? 1 : 0));
  for (const b of list) {
    if (left <= 0) break;
    if (b.state !== 'active' && b.state !== 'demolishing') continue;
    const take = Math.min(left, unreserved(b, r));
    if (take <= 0) continue;
    left -= invTake(b.inventory, r, take);
  }
  return amount - left;
}

/** Unreserved amount of r in all storages. */
export function availableInStorage(g: Game, r: ResourceType, markets = false): number {
  let t = 0;
  for (const b of g.rt.storages(g.state)) {
    if (b.state !== 'active') continue;
    if (b.type === 'market' && !markets) continue;
    t += unreserved(b, r);
  }
  return t;
}

export function resourceTotalsOf(g: Game): Record<ResourceType, number> {
  const out = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) out[r] = 0;
  for (const b of g.rt.storages(g.state)) {
    for (const k in b.inventory) {
      const r = k as ResourceType;
      const v = b.inventory[r];
      if (v !== undefined && v > 0) out[r] += v;
    }
  }
  return out;
}

export function storageUsageOf(g: Game): { stockpileUsed: number; stockpileCap: number; barnUsed: number; barnCap: number } {
  let stockpileUsed = 0;
  let stockpileCap = 0;
  let barnUsed = 0;
  let barnCap = 0;
  for (const b of g.rt.storages(g.state)) {
    if (b.state !== 'active') continue;
    const st = BUILDINGS[b.type].storage!;
    const cap = storageCapacity(b);
    const used = storageUsed(b);
    const hasPile = st.kinds.includes('stockpile');
    const hasBarn = st.kinds.includes('barn');
    if (hasPile && hasBarn) {
      // mixed storage (market / trading post): split by actual content, capacity half/half
      let pile = 0;
      for (const k in b.inventory) {
        const r = k as ResourceType;
        if (RESOURCES[r].storage === 'stockpile') pile += invGet(b.inventory, r);
      }
      stockpileUsed += pile;
      barnUsed += used - pile;
      stockpileCap += cap / 2;
      barnCap += cap / 2;
    } else if (hasPile) {
      stockpileUsed += used;
      stockpileCap += cap;
    } else {
      barnUsed += used;
      barnCap += cap;
    }
  }
  return { stockpileUsed, stockpileCap, barnUsed, barnCap };
}
