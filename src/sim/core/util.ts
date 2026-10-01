/**
 * Small shared helpers for the simulation core (inventories, math). OWNER: sim-core.
 */
import { BUILDINGS, RESOURCES } from '../../core/defs';
import type { Building, Inventory, ResourceType } from '../../core/types';
import * as dm from './dmath';

/** Amounts at or below this are treated as zero and removed from inventories. */
export const EPS = 1e-6;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function invGet(inv: Inventory | undefined, r: ResourceType): number {
  if (!inv) return 0;
  const v = inv[r];
  return v === undefined || !(v > 0) ? 0 : v;
}

/** Add (or subtract with negative n) and keep the inventory tidy (no zero / negative / NaN entries). */
export function invAdd(inv: Inventory, r: ResourceType, n: number): void {
  if (!Number.isFinite(n) || n === 0) return;
  const v = (inv[r] ?? 0) + n;
  if (!(v > EPS)) delete inv[r];
  else inv[r] = v;
}

/** Remove up to n; returns the amount actually removed (never makes the entry negative). */
export function invTake(inv: Inventory, r: ResourceType, n: number): number {
  if (!(n > 0)) return 0;
  const have = invGet(inv, r);
  const take = Math.min(have, n);
  if (take <= 0) return 0;
  invAdd(inv, r, -take);
  return take;
}

export function invTotal(inv: Inventory | undefined): number {
  if (!inv) return 0;
  let t = 0;
  for (const k in inv) {
    const v = inv[k as ResourceType];
    if (v !== undefined && v > 0) t += v;
  }
  return t;
}

export function invKeys(inv: Inventory | undefined): ResourceType[] {
  if (!inv) return [];
  const out: ResourceType[] = [];
  for (const k in inv) {
    const v = inv[k as ResourceType];
    if (v !== undefined && v > EPS) out.push(k as ResourceType);
  }
  return out;
}

/** Sum of inventory values whose resource is food. */
export function invFood(inv: Inventory | undefined): number {
  if (!inv) return 0;
  let t = 0;
  for (const k in inv) {
    const v = inv[k as ResourceType];
    if (v !== undefined && v > 0 && RESOURCES[k as ResourceType].category === 'food') t += v;
  }
  return t;
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Continuous center of a building footprint. */
export function centerOf(b: Building): [number, number] {
  return [b.x + b.w / 2, b.z + b.h / 2];
}

/** Distance from a point to the nearest point of a building's footprint rectangle (0 inside). */
export function distToFootprint(b: Building, x: number, z: number): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
  const dz = Math.max(b.z - z, 0, z - (b.z + b.h));
  return dm.hypot(dx, dz);
}

/** Total builder-seconds needed for a building's construction. */
export function totalBuildWork(b: Building): number {
  const def = BUILDINGS[b.type];
  const tiles = b.w * b.h;
  return def.costPerTile ? def.buildWork * tiles : def.buildWork;
}

/** Fraction (0..1) of construction materials delivered. 1 when the building costs nothing. */
export function deliveredFraction(b: Building): number {
  let need = 0;
  let have = 0;
  for (const k in b.cost) {
    const r = k as ResourceType;
    const c = invGet(b.cost, r);
    need += c;
    have += Math.min(c, invGet(b.delivered, r));
  }
  return need <= 0 ? 1 : have / need;
}

/** Materials still missing (cost - delivered - incoming) for resource r. */
export function missingMaterial(b: Building, r: ResourceType): number {
  return Math.max(0, invGet(b.cost, r) - invGet(b.delivered, r) - invGet(b.incoming, r));
}

export function resName(r: ResourceType): string {
  return RESOURCES[r].name;
}

export function buildingName(b: Building): string {
  return BUILDINGS[b.type].name;
}
