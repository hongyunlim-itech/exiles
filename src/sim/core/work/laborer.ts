/**
 * Laborer job board & builders (ARCHITECTURE §3.5): deliver construction materials, clear marked
 * trees/rocks/iron, haul workplace buffers to storage, demolish buildings and clear ruins; builders additionally
 * construct. Every job is reserved via claims so two citizens never take the same work. OWNER: sim-core.
 */
import { CARRY_CAPACITY } from '../../../core/constants';
import { BUILDINGS } from '../../../core/defs';
import type { Building, Citizen, ResourceType } from '../../../core/types';
import { Feature } from '../../../core/types';
import type { Game } from '../../game';
import { haulableOutputs, bufferUsed } from '../buildings';
import { claimSite, claimTile, siteWorkers, tileFree } from '../claims';
import { findDepositTarget, findSource, unreserved } from '../storage';
import { isBlacklisted, mkTask, type Brain, type Task } from '../tasks';
import { HAUL_MIN, SITE_BUILDERS } from '../tuning';
import { buildingName, deliveredFraction, invGet, invKeys, missingMaterial, totalBuildWork } from '../util';
import { deliveryTask, haulTask, isFoodType, reachable, reachableB } from './common';
import * as dm from '../dmath';

export interface LaborOpts {
  /** Only consider jobs within this distance of (nearX, nearZ). */
  maxDist?: number;
  nearX?: number;
  nearZ?: number;
}

type Job = { cost: number; make: () => Task | null; key: number };

/** Units a builder brings to a construction site per trip (they use a hand cart). */
const BUILDER_CARRY = 25;

/** Iterate the marked-tile set directly below this size; above it use a ring search around the citizen. */
const MARKED_SCAN_LIMIT = 400;
const RING_SEARCH_MAX = 70;
/** Candidate jobs kept per plan (fallbacks when the cheapest one cannot be turned into a task). */
const JOB_CANDIDATES = 4;

/** Drop marked-set entries whose feature is gone (features can vanish via nature / tornadoes). */
export function sweepMarked(g: Game): void {
  const tl = g.state.tiles;
  for (const i of g.rt.marked) {
    if (tl.feature[i] === Feature.None || !tl.marked[i]) {
      g.rt.marked.delete(i);
      if (tl.feature[i] === Feature.None) tl.marked[i] = 0;
    }
  }
}

function maxBuilders(b: Building): number {
  return SITE_BUILDERS + Math.floor((b.w * b.h) / 20);
}

/** A random footprint tile of a building (builders spread around the site). */
function siteTile(g: Game, b: Building): [number, number] {
  return [b.x + Math.floor(g.rng.next() * b.w), b.z + Math.floor(g.rng.next() * b.h)];
}

export function buildTask(g: Game, b: Building): Task {
  const [x, z] = siteTile(g, b);
  const t = mkTask('build', `Building the ${buildingName(b)}`, [{ op: 'go', x, z, b: b.id }, { op: 'build', b: b.id }]);
  claimSite(g, t, b);
  return t;
}

function demolishTask(g: Game, b: Building): Task {
  const [x, z] = siteTile(g, b);
  const label = b.state === 'ruin' ? `Clearing the ruins of the ${buildingName(b)}` : `Demolishing the ${buildingName(b)}`;
  const t = mkTask('demolish', label, [{ op: 'go', x, z, b: b.id }, { op: 'demolish', b: b.id }]);
  claimSite(g, t, b);
  return t;
}

function clearTask(g: Game, c: Citizen, i: number): Task | null {
  const s = g.state;
  const f = s.tiles.feature[i];
  const W = s.W;
  const x = i % W;
  const z = Math.floor(i / W);
  const label = f === Feature.Tree ? 'Cutting down a tree' : f === Feature.Rock ? 'Quarrying a rock' : 'Mining iron ore';
  const t = mkTask('clear', label, [{ op: 'go', x, z }, f === Feature.Tree ? { op: 'chop', i } : { op: 'mineRock', i }]);
  if (!claimTile(g, t, c, i)) return null;
  return t;
}

/** Best laborer job for this citizen, or null. */
export function planLaborer(g: Game, c: Citizen, brain: Brain, opts: LaborOpts = {}): Task | null {
  const s = g.state;
  const now = s.time.elapsed;
  const nx = opts.nearX ?? c.x;
  const nz = opts.nearZ ?? c.z;
  const maxD = opts.maxDist ?? Infinity;
  // The best few candidates, cheapest first. A candidate's task can still fail to materialise (e.g. a haul whose
  // storage filled up), so planning falls back to the next one instead of leaving the citizen idle.
  const jobs: Job[] = [];
  // ties are broken by a stable key so the choice never depends on set/list iteration order (save/load)
  const better = (a: Job, cost: number, key: number) => cost < a.cost - 1e-9 || (cost < a.cost + 1e-9 && key < a.key);
  const consider = (cost: number, make: () => Task | null, key = 0) => {
    if (jobs.length >= JOB_CANDIDATES && !better(jobs[jobs.length - 1], cost, key)) return;
    let k = jobs.length;
    while (k > 0 && better(jobs[k - 1], cost, key)) k--;
    jobs.splice(k, 0, { cost, make, key });
    if (jobs.length > JOB_CANDIDATES) jobs.pop();
  };
  /** Cost a new candidate must beat to be kept (pruning bound). */
  const bound = (): number => (jobs.length >= JOB_CANDIDATES ? jobs[jobs.length - 1].cost : Infinity);
  const tooFar = (x: number, z: number) => maxD < Infinity && dm.hypot(x - nx, z - nz) > maxD;

  // 1. construction deliveries (also for sites still being cleared, so materials are ready); builders use a cart
  const carry = c.profession === 'builder' ? BUILDER_CARRY : CARRY_CAPACITY;
  for (const site of g.rt.sites(s)) {
    if ((site.state !== 'construction' && site.state !== 'clearing') || site.paused) continue;
    if (tooFar(site.doorX, site.doorZ)) continue;
    if (isBlacklisted(brain, `b${site.id}`, now)) continue;
    if (!reachableB(g, c, site)) continue;
    for (const r of invKeys(site.cost)) {
      const need = missingMaterial(site, r);
      if (need < 0.5) continue;
      const src = findSource(g, r, site.doorX + 0.5, site.doorZ + 0.5, { filter: (b) => reachableB(g, c, b) });
      if (!src) continue;
      const dSrc = dm.hypot(src.doorX - c.x, src.doorZ - c.z);
      const dSite = dm.hypot(src.doorX - site.doorX, src.doorZ - site.doorZ);
      const cost = dSrc + dSite * 0.5 - 12 - (site.priority ? 40 : 0) - (site.state === 'construction' ? 6 : 0);
      consider(cost, () => {
        const n = Math.min(carry, Math.ceil(need), Math.floor(unreserved(src, r)));
        return n >= 1 ? deliveryTask(c, site, src, r as ResourceType, n) : null;
      });
    }
  }

  // 2. clearing marked features: construction sites first, then the nearest marked tile
  const tl = s.tiles;
  const W = s.W;
  const considerTile = (i: number, bonus: number): void => {
    const f = tl.feature[i];
    if (f === Feature.None || !tl.marked[i] || !tileFree(g, i, c)) return;
    const x = i % W;
    const z = (i - x) / W;
    const d = dm.hypot(x + 0.5 - c.x, z + 0.5 - c.z) - bonus;
    if (d > bound() + 1e-9) return;
    if (tooFar(x, z)) return;
    if (bonus === 0 && f !== Feature.Tree) {
      // stone/iron clearing needs somewhere to store the load
      if (!findDepositTarget(g, f === Feature.Rock ? 'stone' : 'iron', x, z)) return;
    }
    if (isBlacklisted(brain, `t${i}`, now)) return;
    if (!reachable(g, c, x, z)) return;
    consider(d, () => clearTask(g, c, i), i);
  };
  for (const site of g.rt.sites(s)) {
    if (site.state !== 'clearing' || site.paused) continue; // a paused site is not cleared either
    const bonus = 25 + (site.priority ? 40 : 0);
    for (let zz = site.z; zz < site.z + site.h; zz++) {
      for (let xx = site.x; xx < site.x + site.w; xx++) considerTile(zz * W + xx, bonus);
    }
  }
  if (g.rt.marked.size <= MARKED_SCAN_LIMIT) {
    let stale: number[] | null = null;
    for (const i of g.rt.marked) {
      if (tl.feature[i] === Feature.None || !tl.marked[i]) {
        (stale ??= []).push(i);
        continue;
      }
      if (tl.building[i] >= 0) continue; // handled with its site (paused sites wait)
      considerTile(i, 0);
    }
    if (stale) {
      for (const i of stale) {
        g.rt.marked.delete(i);
        if (tl.feature[i] === Feature.None) tl.marked[i] = 0;
      }
    }
  } else {
    // large marked areas: ring search outward from the citizen, stop at the first ring with a candidate
    const cx = Math.floor(c.x);
    const cz = Math.floor(c.z);
    const b0 = bound();
    const maxR = Math.min(RING_SEARCH_MAX, b0 < Infinity ? Math.ceil(b0) + 2 : RING_SEARCH_MAX);
    let found = false;
    for (let r = 0; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= s.H) continue;
        const step = dz === -r || dz === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += step || 1) {
          const x = cx + dx;
          if (x < 0 || x >= W) continue;
          const i = z * W + x;
          if (tl.marked[i] && tl.building[i] < 0) {
            const had = jobs.length > 0 ? jobs[jobs.length - 1] : null;
            const n0 = jobs.length;
            considerTile(i, 0);
            if (jobs.length !== n0 || (jobs.length > 0 && jobs[jobs.length - 1] !== had)) found = true;
          }
        }
      }
      if (r > bound() + 1) break;
    }
    if (!found && jobs.length === 0) {
      // nothing nearby: scan the whole set for far-away marked areas. (Not just its first entries: the Set's
      // insertion order differs between a restored snapshot and the original game, while the ranking by
      // (cost, tile index) over the whole set does not — lockstep co-op. Rare path; the distance bound keeps it cheap.)
      for (const i of g.rt.marked) {
        if (tl.building[i] < 0) considerTile(i, 0);
      }
    }
  }

  // 3. haul full workplace buffers to storage
  for (const b of g.rt.workplaces(s)) {
    if (b.state !== 'active' && b.state !== 'demolishing') continue;
    const outs = haulableOutputs(b);
    if (outs.length === 0) continue;
    const cap = BUILDINGS[b.type].bufferCapacity ?? 60;
    const used = bufferUsed(b);
    if (outs[0].n < HAUL_MIN && used < cap * 0.5) continue;
    if (tooFar(b.doorX, b.doorZ)) continue;
    if (isBlacklisted(brain, `b${b.id}`, now)) continue;
    if (!reachableB(g, c, b)) continue;
    // only outputs that some storage can take right now (no barn / full barns must not stall the job board)
    const out = outs.find((o) => !!findDepositTarget(g, o.r, b.doorX + 0.5, b.doorZ + 0.5, { exclude: b.id }));
    if (!out) continue;
    const d = dm.hypot(b.doorX - c.x, b.doorZ - c.z);
    const cost = d - (used >= cap * 0.9 ? 30 : 8);
    consider(cost, () => haulTask(g, c, b, out.r));
  }

  // 3b. salvage: carry what survived in ruins to storage
  for (const site of g.rt.sites(s)) {
    if (site.state !== 'ruin') continue;
    if (tooFar(site.doorX, site.doorZ)) continue;
    if (isBlacklisted(brain, `b${site.id}`, now)) continue;
    let out: ResourceType | null = null;
    for (const r of invKeys(site.inventory)) {
      if (unreserved(site, r) < 1) continue;
      if (findDepositTarget(g, r, site.doorX + 0.5, site.doorZ + 0.5, { exclude: site.id })) {
        out = r;
        break;
      }
    }
    if (!out || !reachableB(g, c, site)) continue;
    const r = out;
    const d = dm.hypot(site.doorX - c.x, site.doorZ - c.z);
    consider(d - 20, () => haulTask(g, c, site, r));
  }

  // 4. demolition & ruins (a ruin is cleared once its salvage is out: food waits to be eaten if no barn can take it)
  for (const site of g.rt.sites(s)) {
    if (site.state !== 'demolishing' && site.state !== 'ruin') continue;
    if (site.state === 'ruin' && salvageWaiting(g, site)) continue;
    if (siteWorkers(g, site.id) >= 4) continue;
    if (tooFar(site.doorX, site.doorZ)) continue;
    if (isBlacklisted(brain, `b${site.id}`, now)) continue;
    if (!reachable(g, c, site.x, site.z) && !reachableB(g, c, site)) continue;
    const d = dm.hypot(site.x + site.w / 2 - c.x, site.z + site.h / 2 - c.z);
    consider(d - 5, () => demolishTask(g, site));
  }

  for (const j of jobs) {
    const t = j.make();
    if (t) return t;
  }
  return null;
}

/** Salvage in a ruin that still has somewhere to go (a storage that takes it) or is food (people eat from ruins). */
export function salvageWaiting(g: Game, ruin: Building): boolean {
  for (const r of invKeys(ruin.inventory)) {
    if (invGet(ruin.inventory, r) < 1) continue;
    if (isFoodType(r)) return true;
    if (findDepositTarget(g, r, ruin.doorX + 0.5, ruin.doorZ + 0.5, { exclude: ruin.id })) return true;
  }
  return false;
}

/** Builders: construct sites with delivered materials, else deliver, else laborer work. */
export function planBuilder(g: Game, c: Citizen, brain: Brain): Task | null {
  const s = g.state;
  const now = s.time.elapsed;
  let bestSite: Building | null = null;
  let bestCost = Infinity;
  for (const site of g.rt.sites(s)) {
    if (site.state !== 'construction' || site.paused) continue;
    if (siteWorkers(g, site.id) >= maxBuilders(site)) continue;
    const total = totalBuildWork(site);
    const minRemaining = total * (1 - deliveredFraction(site));
    const ready = site.workRemaining > minRemaining + 0.5 || (site.workRemaining <= 1e-6 && deliveredFraction(site) >= 1);
    if (!ready) continue;
    if (isBlacklisted(brain, `b${site.id}`, now)) continue;
    if (!reachable(g, c, site.doorX, site.doorZ)) continue;
    const cost = dm.hypot(site.x + site.w / 2 - c.x, site.z + site.h / 2 - c.z) - (site.priority ? 60 : 0) -
      siteWorkers(g, site.id) * 2;
    if (cost < bestCost) {
      bestCost = cost;
      bestSite = site;
    }
  }
  if (bestSite) return buildTask(g, bestSite);
  return planLaborer(g, c, brain);
}
