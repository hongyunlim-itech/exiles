/**
 * Reservation bookkeeping. Every reservation lives both in shared state (Building.reservedOut / reservedIn /
 * incoming, Animal.huntedBy) or runtime indexes (tile claims, house fetchers, site slots) AND as a {@link Claim} in
 * the owning task — so it can always be released exactly once. OWNER: sim-core.
 */
import type { Animal, Building, Citizen, ResourceType } from '../../core/types';
import type { Game } from '../game';
import { brainOf, type Claim, type Task } from './tasks';
import { EPS, invAdd, invGet } from './util';

export function claimOut(t: Task, b: Building, r: ResourceType, n: number): void {
  if (!(n > 0)) return;
  invAdd(b.reservedOut, r, n);
  t.claims.push({ k: 'out', b: b.id, r, n });
}

export function claimIn(t: Task, b: Building, n: number): void {
  if (!(n > 0)) return;
  b.reservedIn += n;
  t.claims.push({ k: 'in', b: b.id, n });
}

export function claimInc(t: Task, b: Building, r: ResourceType, n: number): void {
  if (!(n > 0)) return;
  invAdd(b.incoming, r, n);
  t.claims.push({ k: 'inc', b: b.id, r, n });
}

export function claimTile(g: Game, t: Task, c: Citizen, i: number): boolean {
  const cur = g.rt.tileClaim[i];
  if (cur >= 0 && cur !== c.id) return false;
  g.rt.tileClaim[i] = c.id;
  t.claims.push({ k: 'tile', i });
  return true;
}

export function tileFree(g: Game, i: number, c?: Citizen): boolean {
  const cur = g.rt.tileClaim[i];
  return cur < 0 || (c !== undefined && cur === c.id);
}

export function claimDeer(t: Task, c: Citizen, a: Animal): boolean {
  if (a.huntedBy >= 0 && a.huntedBy !== c.id) return false;
  a.huntedBy = c.id;
  t.claims.push({ k: 'deer', a: a.id });
  return true;
}

export function claimFetch(g: Game, t: Task, c: Citizen, house: Building): boolean {
  const cur = g.rt.houseFetcher.get(house.id);
  if (cur !== undefined && cur !== c.id) return false;
  g.rt.houseFetcher.set(house.id, c.id);
  t.claims.push({ k: 'fetch', b: house.id });
  return true;
}

export function claimSite(g: Game, t: Task, b: Building): void {
  g.rt.siteCount.set(b.id, (g.rt.siteCount.get(b.id) ?? 0) + 1);
  t.claims.push({ k: 'site', b: b.id });
}

export function siteWorkers(g: Game, id: number): number {
  return g.rt.siteCount.get(id) ?? 0;
}

/** Undo the shared-state effect of one claim (safe if the target no longer exists). */
export function releaseClaim(g: Game, cid: number, cl: Claim): void {
  switch (cl.k) {
    case 'out': {
      const b = g.buildingById.get(cl.b);
      if (b) {
        const v = invGet(b.reservedOut, cl.r) - cl.n;
        if (v > EPS) b.reservedOut[cl.r] = v;
        else delete b.reservedOut[cl.r];
      }
      break;
    }
    case 'in': {
      const b = g.buildingById.get(cl.b);
      if (b) {
        b.reservedIn -= cl.n;
        if (b.reservedIn < EPS) b.reservedIn = 0;
      }
      break;
    }
    case 'inc': {
      const b = g.buildingById.get(cl.b);
      if (b) {
        const v = invGet(b.incoming, cl.r) - cl.n;
        if (v > EPS) b.incoming[cl.r] = v;
        else delete b.incoming[cl.r];
      }
      break;
    }
    case 'tile':
      if (cl.i >= 0 && cl.i < g.rt.tileClaim.length && g.rt.tileClaim[cl.i] === cid) g.rt.tileClaim[cl.i] = -1;
      break;
    case 'deer': {
      const a = g.findAnimal(cl.a);
      if (a && a.huntedBy === cid) a.huntedBy = -1;
      break;
    }
    case 'fetch':
      if (g.rt.houseFetcher.get(cl.b) === cid) g.rt.houseFetcher.delete(cl.b);
      break;
    case 'site': {
      const n = (g.rt.siteCount.get(cl.b) ?? 0) - 1;
      if (n > 0) g.rt.siteCount.set(cl.b, n);
      else g.rt.siteCount.delete(cl.b);
      break;
    }
  }
}

export function releaseAll(g: Game, c: Citizen, t: Task): void {
  for (const cl of t.claims) releaseClaim(g, c.id, cl);
  t.claims.length = 0;
}

/** Release and drop every claim of kind `k` (optionally only those on building `b`). */
export function releaseKind(g: Game, c: Citizen, t: Task, k: Claim['k'], b?: number): void {
  for (let i = t.claims.length - 1; i >= 0; i--) {
    const cl = t.claims[i];
    if (cl.k !== k) continue;
    if (b !== undefined && 'b' in cl && cl.b !== b) continue;
    releaseClaim(g, c.id, cl);
    t.claims.splice(i, 1);
  }
}

/** Drop a claim from the task WITHOUT releasing it (its effect was consumed, e.g. items picked up). */
export function dropClaim(t: Task, cl: Claim): void {
  const i = t.claims.indexOf(cl);
  if (i >= 0) t.claims.splice(i, 1);
}

/**
 * Recompute every reservation from the citizens' tasks (after load, or to repair drift). Resets
 * Building.reservedOut/reservedIn/incoming, Animal.huntedBy and all runtime claim indexes.
 */
export function rebuildClaims(g: Game): void {
  const s = g.state;
  for (const b of s.buildings) {
    b.reservedOut = {};
    b.reservedIn = 0;
    b.incoming = {};
  }
  for (const a of s.animals) a.huntedBy = -1;
  g.rt.tileClaim.fill(-1);
  g.rt.houseFetcher.clear();
  g.rt.siteCount.clear();
  for (const c of s.citizens) {
    const t = brainOf(c).cur;
    if (!t) continue;
    const keep: Claim[] = [];
    for (const cl of t.claims) {
      switch (cl.k) {
        case 'out': {
          const b = g.buildingById.get(cl.b);
          if (!b) continue;
          invAdd(b.reservedOut, cl.r, cl.n);
          break;
        }
        case 'in': {
          const b = g.buildingById.get(cl.b);
          if (!b) continue;
          b.reservedIn += cl.n;
          break;
        }
        case 'inc': {
          const b = g.buildingById.get(cl.b);
          if (!b) continue;
          invAdd(b.incoming, cl.r, cl.n);
          break;
        }
        case 'tile':
          if (cl.i < 0 || cl.i >= g.rt.tileClaim.length || g.rt.tileClaim[cl.i] >= 0) continue;
          g.rt.tileClaim[cl.i] = c.id;
          break;
        case 'deer': {
          const a = g.findAnimal(cl.a);
          if (!a || a.huntedBy >= 0) continue;
          a.huntedBy = c.id;
          break;
        }
        case 'fetch':
          if (g.rt.houseFetcher.has(cl.b)) continue;
          g.rt.houseFetcher.set(cl.b, c.id);
          break;
        case 'site':
          g.rt.siteCount.set(cl.b, (g.rt.siteCount.get(cl.b) ?? 0) + 1);
          break;
      }
      keep.push(cl);
    }
    t.claims = keep;
  }
}
