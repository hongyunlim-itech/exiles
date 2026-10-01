/**
 * Invariant checker (used by tests and available for debugging via `game.validate()`): finite numbers,
 * non-negative inventories, reservations exactly matching the claims held by tasks, consistent home/work links
 * and tile ownership. OWNER: sim-core.
 */
import type { Inventory, ResourceType } from '../../core/types';
import type { Game } from '../game';
import { brainOf } from './tasks';
import { invAdd, invGet } from './util';

function checkInv(label: string, inv: Inventory, out: string[]): void {
  for (const k in inv) {
    const v = inv[k as ResourceType];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) out.push(`${label}.${k} is not finite (${v})`);
    else if (v < -1e-6) out.push(`${label}.${k} is negative (${v})`);
  }
}

export function validateGame(g: Game): string[] {
  const s = g.state;
  const out: string[] = [];
  const expOut = new Map<number, Inventory>();
  const expIn = new Map<number, number>();
  const expInc = new Map<number, Inventory>();
  const tileOwners = new Map<number, number>();
  for (const c of s.citizens) {
    for (const [k, v] of Object.entries({ x: c.x, z: c.z, food: c.food, warmth: c.warmth, age: c.age, health: c.health })) {
      if (!Number.isFinite(v)) out.push(`citizen ${c.id} ${k} not finite`);
    }
    if (c.x < 0 || c.z < 0 || c.x > s.W || c.z > s.H) out.push(`citizen ${c.id} outside map (${c.x}, ${c.z})`);
    if (c.carrying && !(c.carrying.amount > 0)) out.push(`citizen ${c.id} carries a non-positive amount`);
    if (c.homeId >= 0) {
      const h = g.buildingById.get(c.homeId);
      if (!h) out.push(`citizen ${c.id} home ${c.homeId} missing`);
      else if (!h.residentIds.includes(c.id)) out.push(`citizen ${c.id} not in residents of ${h.id}`);
    }
    if (c.workplaceId >= 0) {
      const w = g.buildingById.get(c.workplaceId);
      if (!w) out.push(`citizen ${c.id} workplace ${c.workplaceId} missing`);
    }
    const t = brainOf(c).cur;
    if (!t) continue;
    if (t.bundle) checkInv(`citizen ${c.id} bundle`, t.bundle, out);
    for (const cl of t.claims) {
      switch (cl.k) {
        case 'out': {
          const m = expOut.get(cl.b) ?? {};
          invAdd(m, cl.r, cl.n);
          expOut.set(cl.b, m);
          break;
        }
        case 'in':
          expIn.set(cl.b, (expIn.get(cl.b) ?? 0) + cl.n);
          break;
        case 'inc': {
          const m = expInc.get(cl.b) ?? {};
          invAdd(m, cl.r, cl.n);
          expInc.set(cl.b, m);
          break;
        }
        case 'tile':
          if (tileOwners.has(cl.i)) out.push(`tile ${cl.i} claimed twice`);
          tileOwners.set(cl.i, c.id);
          if (g.rt.tileClaim[cl.i] !== c.id) out.push(`tile claim ${cl.i} of ${c.id} not indexed`);
          break;
        case 'deer': {
          const a = g.findAnimal(cl.a);
          if (a && a.huntedBy !== c.id) out.push(`deer ${cl.a} claim mismatch`);
          break;
        }
        default:
          break;
      }
    }
  }
  for (let i = 0; i < g.rt.tileClaim.length; i++) {
    const cid = g.rt.tileClaim[i];
    if (cid >= 0 && tileOwners.get(i) !== cid) out.push(`stale tile claim ${i} -> ${cid}`);
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  for (const b of s.buildings) {
    checkInv(`building ${b.id} inventory`, b.inventory, out);
    checkInv(`building ${b.id} reservedOut`, b.reservedOut, out);
    checkInv(`building ${b.id} incoming`, b.incoming, out);
    checkInv(`building ${b.id} delivered`, b.delivered, out);
    if (!Number.isFinite(b.reservedIn) || b.reservedIn < -1e-6) out.push(`building ${b.id} reservedIn invalid (${b.reservedIn})`);
    if (!Number.isFinite(b.workRemaining)) out.push(`building ${b.id} workRemaining not finite`);
    const eo = expOut.get(b.id) ?? {};
    for (const k of new Set([...Object.keys(eo), ...Object.keys(b.reservedOut)])) {
      const r = k as ResourceType;
      if (!near(invGet(eo, r), invGet(b.reservedOut, r))) {
        out.push(`building ${b.id} reservedOut.${r} = ${invGet(b.reservedOut, r)} but claims = ${invGet(eo, r)}`);
      }
    }
    if (!near(expIn.get(b.id) ?? 0, b.reservedIn)) out.push(`building ${b.id} reservedIn = ${b.reservedIn} but claims = ${expIn.get(b.id) ?? 0}`);
    const ei = expInc.get(b.id) ?? {};
    for (const k of new Set([...Object.keys(ei), ...Object.keys(b.incoming)])) {
      const r = k as ResourceType;
      if (!near(invGet(ei, r), invGet(b.incoming, r))) {
        out.push(`building ${b.id} incoming.${r} = ${invGet(b.incoming, r)} but claims = ${invGet(ei, r)}`);
      }
    }
    for (const id of b.residentIds) {
      const c = g.citizenById.get(id);
      if (!c || c.homeId !== b.id) out.push(`building ${b.id} resident ${id} invalid`);
    }
    for (const id of b.workerIds) {
      const c = g.citizenById.get(id);
      if (!c || c.workplaceId !== b.id) out.push(`building ${b.id} worker ${id} invalid`);
    }
    for (let zz = b.z; zz < b.z + b.h; zz++) {
      for (let xx = b.x; xx < b.x + b.w; xx++) {
        if (s.tiles.building[zz * s.W + xx] !== b.id) out.push(`building ${b.id} tile (${xx},${zz}) not owned`);
      }
    }
  }
  for (let i = 0; i < s.tiles.building.length; i++) {
    const id = s.tiles.building[i];
    if (id >= 0 && !g.buildingById.has(id)) out.push(`tile ${i} references missing building ${id}`);
  }
  if (g.citizenById.size !== s.citizens.length) out.push('citizenById out of sync');
  if (g.buildingById.size !== s.buildings.length) out.push('buildingById out of sync');
  return out;
}
