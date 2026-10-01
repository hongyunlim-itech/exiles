/**
 * Shared helpers for task planners: work efficiency, reachability, standard step sequences (haul, deliver,
 * fetch), carried-goods bookkeeping. OWNER: sim-core.
 */
import { CARRY_CAPACITY, ELDERLY_AGE } from '../../../core/constants';
import { RESOURCES } from '../../../core/defs';
import type { Building, Citizen, Inventory, ResourceType } from '../../../core/types';
import type { Game } from '../../game';
import { claimIn, claimInc, claimOut } from '../claims';
import { findDepositTarget, storageFree, unreserved } from '../storage';
import { mkTask, type Step, type Task } from '../tasks';
import { buildingName, invAdd, invGet, invKeys, resName } from '../util';
import * as dm from '../dmath';

/** Work speed multiplier: wellbeing × tool × age. */
export function efficiency(g: Game, c: Citizen): number {
  let e = g.wellbeingEff(c);
  if (c.toolWear <= 0) e *= 0.5;
  if (c.age >= ELDERLY_AGE) e *= 0.7;
  return Math.min(2, Math.max(0.15, e));
}

/** Region-based reachability from the citizen to a tile (cheap, ignores buildings). */
export function reachable(g: Game, c: Citizen, tx: number, tz: number): boolean {
  return g.sameRegionSafe(Math.floor(c.x), Math.floor(c.z), tx, tz);
}

export function reachableB(g: Game, c: Citizen, b: Building): boolean {
  return reachable(g, c, b.doorX, b.doorZ);
}

export function goDoor(b: Building): Step {
  return { op: 'go', x: b.doorX, z: b.doorZ, b: b.id };
}

export function goTile(g: Game, i: number, b?: number): Step {
  const W = g.state.W;
  const st: Step = { op: 'go', x: i % W, z: Math.floor(i / W) };
  if (b !== undefined) st.b = b;
  return st;
}

export function dist(c: Citizen, x: number, z: number): number {
  return dm.hypot(c.x - x, c.z - z);
}

/** Add goods to the citizen's hands (first type in `carrying`, others in the task bundle). */
export function addCarried(c: Citizen, t: Task, r: ResourceType, n: number): void {
  if (!(n > 0)) return;
  if (!c.carrying) c.carrying = { type: r, amount: n };
  else if (c.carrying.type === r) c.carrying.amount += n;
  else {
    t.bundle ??= {};
    invAdd(t.bundle, r, n);
  }
}

/** Everything the citizen currently carries for this task (carrying + bundle + extra). */
export function carriedItems(c: Citizen, t: Task | null): Inventory {
  const inv: Inventory = {};
  if (c.carrying && c.carrying.amount > 0) invAdd(inv, c.carrying.type, c.carrying.amount);
  if (t?.bundle) for (const r of invKeys(t.bundle)) invAdd(inv, r, invGet(t.bundle, r));
  if (t?.extra) for (const r of invKeys(t.extra)) invAdd(inv, r, invGet(t.extra, r));
  return inv;
}

/** Replace the carried goods with `left` (what could not be deposited). */
export function setCarried(c: Citizen, t: Task, left: Inventory): void {
  const keys = invKeys(left);
  t.extra = null;
  t.bundle = null;
  if (keys.length === 0) {
    c.carrying = null;
    return;
  }
  // keep the current carrying type first if still present
  const first = c.carrying && invGet(left, c.carrying.type) > 0 ? c.carrying.type : keys[0];
  c.carrying = { type: first, amount: invGet(left, first) };
  for (const r of keys) {
    if (r === first) continue;
    t.bundle ??= {};
    t.bundle[r] = invGet(left, r);
  }
}

/** Haul up to a load of r from building `from` to the nearest storage. */
export function haulTask(g: Game, c: Citizen, from: Building, r: ResourceType, max = CARRY_CAPACITY, job = false): Task | null {
  const avail = Math.floor(unreserved(from, r) + 1e-6);
  if (avail < 1) return null;
  const target = findDepositTarget(g, r, from.doorX + 0.5, from.doorZ + 0.5, {
    exclude: from.id, filter: (b) => g.sameRegionSafe(from.doorX, from.doorZ, b.doorX, b.doorZ),
  });
  if (!target) return null;
  const n = Math.min(avail, max, Math.floor(storageFree(target)));
  if (n < 1) return null;
  const t = mkTask('haul', `Hauling ${resName(r)} to ${buildingName(target)}`, [
    goDoor(from), { op: 'pickup', b: from.id }, goDoor(target), { op: 'deposit', b: target.id },
  ], { job });
  claimOut(t, from, r, n);
  claimIn(t, target, n);
  return t;
}

/** Bring n of r from storage `src` to construction site `site`. */
export function deliveryTask(c: Citizen, site: Building, src: Building, r: ResourceType, n: number): Task {
  void c;
  const t = mkTask('deliver', `Delivering ${resName(r)} to ${buildingName(site)}`, [
    goDoor(src), { op: 'pickup', b: src.id }, goDoor(site), { op: 'deposit', b: site.id },
  ]);
  claimOut(t, src, r, n);
  claimInc(t, site, r, n);
  return t;
}

/** Fetch n of r from storage `src` into workplace `w` (workshop inputs, service stock). */
export function fetchIntoTask(src: Building, w: Building, r: ResourceType, n: number, label?: string): Task {
  const t = mkTask('work', label ?? `Fetching ${resName(r)}`, [
    goDoor(src), { op: 'pickup', b: src.id }, goDoor(w), { op: 'deposit', b: w.id },
  ], { job: true });
  claimOut(t, src, r, n);
  if (w.type === 'market' || w.type === 'tradingPost') claimIn(t, w, n);
  return t;
}

export function isFoodType(r: ResourceType): boolean {
  return RESOURCES[r].category === 'food';
}

/** A random walkable tile within radius r of (cx, cz) in the same region as the citizen, or -1. */
export function randomTileNear(g: Game, c: Citizen, cx: number, cz: number, r: number, tries = 10): number {
  const s = g.state;
  for (let k = 0; k < tries; k++) {
    const x = Math.floor(cx + g.rng.range(-r, r));
    const z = Math.floor(cz + g.rng.range(-r, r));
    if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
    const i = z * s.W + x;
    if (!g.isWalkableTile(i)) continue;
    if (!reachable(g, c, x, z)) continue;
    return i;
  }
  return -1;
}
