/**
 * Land-based workplaces: gatherers & herbalists (forest yields), hunters (deer), fishermen (shore) and foresters
 * (plant saplings, fell mature trees). ARCHITECTURE §3.5 "Workplaces". OWNER: sim-core.
 */
import { BUILDINGS } from '../../../core/defs';
import type { Building, Citizen } from '../../../core/types';
import { Feature } from '../../../core/types';
import { isLandTerrain, isWaterTerrain, tileSlope } from '../../../core/world';
import type { Game } from '../../game';
import { bufferUsed, haulableOutputs } from '../buildings';
import { claimDeer, claimTile, tileFree } from '../claims';
import { plantable } from '../steps';
import { isBlacklisted, mkTask, type Brain, type Step, type Task } from '../tasks';
import { HUNT_TRACK_TIME } from '../tuning';
import { centerOf } from '../util';
import { goDoor, goTile, haulTask, reachable } from './common';
import * as dm from '../dmath';

/** Hunters leave this many animals of a herd alone (a breeding pair). */
const HUNT_KEEP = 2;

/** Workers haul their own buffer to storage once it is this full (laborers haul earlier). */
export const OWN_HAUL_SHARE = 0.8;

function isWinter(g: Game): boolean {
  return g.state.time.month >= 9;
}

/** Haul the workplace's own buffer when it is getting full (or always when `force`). */
export function haulOwn(g: Game, c: Citizen, b: Building, share = 0.5, force = false): Task | null {
  const cap = BUILDINGS[b.type].bufferCapacity ?? 60;
  const used = bufferUsed(b);
  if (!force && used < cap * share) return null;
  const outs = haulableOutputs(b);
  if (outs.length === 0 || outs[0].n < 1) return null;
  return haulTask(g, c, b, outs[0].r, undefined, true);
}

function bufferFull(b: Building): boolean {
  return bufferUsed(b) >= (BUILDINGS[b.type].bufferCapacity ?? 60);
}

/** Random mature tree tile within the work radius. */
function randomTreeTile(g: Game, c: Citizen, b: Building, radius: number, brain: Brain): number {
  const s = g.state;
  const [cx, cz] = centerOf(b);
  const tl = s.tiles;
  const now = s.time.elapsed;
  for (let k = 0; k < 40; k++) {
    const a = g.rng.next() * Math.PI * 2;
    const r = Math.sqrt(g.rng.next()) * radius;
    const x = Math.floor(cx + dm.cos(a) * r);
    const z = Math.floor(cz + dm.sin(a) * r);
    if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
    const i = z * s.W + x;
    if (tl.feature[i] !== Feature.Tree || tl.featureAmount[i] < 0.5 || tl.building[i] >= 0) continue;
    if (isBlacklisted(brain, `t${i}`, now) || !reachable(g, c, x, z)) continue;
    return i;
  }
  return -1;
}

/** Gatherer / herbalist: forage around a tree in range, bring the yield back to the hut. */
export function planForager(g: Game, c: Citizen, b: Building, brain: Brain, herbs: boolean): Task | null {
  const own = haulOwn(g, c, b, OWN_HAUL_SHARE) ?? (isWinter(g) ? haulOwn(g, c, b, 0, true) : null);
  if (own) return own;
  if (isWinter(g) || bufferFull(b)) return null;
  const radius = BUILDINGS[b.type].workRadius ?? 12;
  const i = randomTreeTile(g, c, b, radius, brain);
  if (i < 0) return null;
  // forage at two nearby spots before carrying the basket home
  const W = g.state.W;
  const j = treeNear(g, c, i % W, Math.floor(i / W), 4);
  const steps: Step[] = [goTile(g, i, b.id), { op: 'gather', b: b.id, herbs }];
  if (j >= 0 && j !== i) steps.push(goTile(g, j, b.id), { op: 'gather', b: b.id, herbs });
  steps.push(goDoor(b), { op: 'deposit', b: b.id });
  return mkTask('work', herbs ? 'Collecting herbs' : 'Gathering food', steps, { job: true });
}

/** A mature tree tile within r of (x, z) other than the start, or -1. */
function treeNear(g: Game, c: Citizen, x: number, z: number, r: number): number {
  const s = g.state;
  const tl = s.tiles;
  for (let k = 0; k < 12; k++) {
    const tx = x + Math.round(g.rng.range(-r, r));
    const tz = z + Math.round(g.rng.range(-r, r));
    if ((tx === x && tz === z) || tx < 0 || tz < 0 || tx >= s.W || tz >= s.H) continue;
    const i = tz * s.W + tx;
    if (tl.feature[i] !== Feature.Tree || tl.featureAmount[i] < 0.5 || tl.building[i] >= 0) continue;
    if (!reachable(g, c, tx, tz)) continue;
    return i;
  }
  return -1;
}

/** Hunter: stalk a deer in range. */
export function planHunter(g: Game, c: Citizen, b: Building, brain: Brain): Task | null {
  const own = haulOwn(g, c, b, OWN_HAUL_SHARE);
  if (own) return own;
  if (bufferFull(b)) return haulOwn(g, c, b, 0, true);
  const s = g.state;
  const radius = BUILDINGS[b.type].workRadius ?? 18;
  const [cx, cz] = centerOf(b);
  const now = s.time.elapsed;
  // sustainable hunting: never take a herd's last breeding pair (it regrows, so the cabin keeps its game)
  const free = new Map<number, number>();
  for (const a of s.animals) if (a.huntedBy < 0) free.set(a.herd, (free.get(a.herd) ?? 0) + 1);
  let best = null as (typeof s.animals)[number] | null;
  let bestD = Infinity;
  for (const a of s.animals) {
    if (a.huntedBy >= 0 || (free.get(a.herd) ?? 0) <= HUNT_KEEP) continue;
    const d = dm.hypot(a.x - cx, a.z - cz);
    if (d > radius) continue;
    const dc = dm.hypot(a.x - c.x, a.z - c.z);
    if (dc >= bestD) continue;
    if (isBlacklisted(brain, `a${a.id}`, now)) continue;
    const ax = Math.floor(a.x);
    const az = Math.floor(a.z);
    if (!reachable(g, c, ax, az)) continue;
    best = a;
    bestD = dc;
  }
  if (!best) return haulOwn(g, c, b, 0, true);
  const t = mkTask('work', 'Hunting deer', [
    { op: 'go', x: Math.floor(best.x), z: Math.floor(best.z) },
    { op: 'wait', t: HUNT_TRACK_TIME, act: 'hunting' },
    { op: 'hunt', a: best.id, b: b.id },
    goDoor(b), { op: 'deposit', b: b.id },
  ], { job: true });
  if (!claimDeer(t, c, best)) return null;
  return t;
}

/** Walkable land tiles next to water within the dock's radius (cached per dock). */
function shoreTiles(g: Game, b: Building): number[] {
  const s = g.state;
  const key = s.rev.terrain * 100003 + s.rev.roads * 7 + s.rev.buildings;
  if (g.rt.shoreCacheRev !== key) {
    g.rt.shoreCache.clear();
    g.rt.shoreCacheRev = key;
  }
  let list = g.rt.shoreCache.get(b.id);
  if (list) return list;
  list = [];
  const radius = BUILDINGS[b.type].workRadius ?? 10;
  const [cx, cz] = centerOf(b);
  const tl = s.tiles;
  const W = s.W;
  const x0 = Math.max(1, Math.floor(cx - radius));
  const x1 = Math.min(W - 2, Math.ceil(cx + radius));
  const z0 = Math.max(1, Math.floor(cz - radius));
  const z1 = Math.min(s.H - 2, Math.ceil(cz + radius));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (dm.sq(x + 0.5 - cx) + dm.sq(z + 0.5 - cz) > radius * radius) continue;
      const i = z * W + x;
      if (!isLandTerrain(tl.terrain[i]) || !g.isWalkableTile(i)) continue;
      if (isWaterTerrain(tl.terrain[i - 1]) || isWaterTerrain(tl.terrain[i + 1]) || isWaterTerrain(tl.terrain[i - W]) ||
        isWaterTerrain(tl.terrain[i + W])) list.push(i);
    }
  }
  g.rt.shoreCache.set(b.id, list);
  return list;
}

export function planFisherman(g: Game, c: Citizen, b: Building, brain: Brain): Task | null {
  const own = haulOwn(g, c, b, OWN_HAUL_SHARE);
  if (own) return own;
  if (bufferFull(b)) return haulOwn(g, c, b, 0, true);
  const list = shoreTiles(g, b);
  if (list.length === 0) return null;
  const now = g.state.time.elapsed;
  const W = g.state.W;
  for (let k = 0; k < 8; k++) {
    const i = list[Math.floor(g.rng.next() * list.length)];
    const x = i % W;
    const z = Math.floor(i / W);
    if (isBlacklisted(brain, `t${i}`, now) || !reachable(g, c, x, z)) continue;
    // cast at a few spots along the shore before carrying the catch back (a full basket per trip)
    const steps: Step[] = [goTile(g, i, b.id), { op: 'fish', b: b.id }];
    let last = i;
    for (let n = 1; n < FISH_CASTS; n++) {
      const j = shoreNear(g, list, last, 4);
      if (j < 0 || !reachable(g, c, j % W, Math.floor(j / W))) {
        steps.push({ op: 'fish', b: b.id }); // same spot again
        continue;
      }
      steps.push(goTile(g, j, b.id), { op: 'fish', b: b.id });
      last = j;
    }
    steps.push(goDoor(b), { op: 'deposit', b: b.id });
    return mkTask('work', 'Fishing', steps, { job: true });
  }
  return null;
}

/** Casts per fishing trip. */
const FISH_CASTS = 3;

/** A random shore tile of the dock's list within r tiles of tile i (other than i), or -1. */
function shoreNear(g: Game, list: number[], i: number, r: number): number {
  const W = g.state.W;
  const x = i % W;
  const z = Math.floor(i / W);
  let pick = -1;
  let seen = 0;
  for (const j of list) {
    if (j === i) continue;
    if (Math.abs((j % W) - x) > r || Math.abs(Math.floor(j / W) - z) > r) continue;
    // reservoir sampling: uniform pick without building an array
    seen++;
    if (g.rng.next() * seen < 1) pick = j;
  }
  return pick;
}

/** Forester: fell mature trees (keeping the forest dense) and plant saplings on free land in range. */
export function planForester(g: Game, c: Citizen, b: Building, brain: Brain): Task | null {
  const own = haulOwn(g, c, b, OWN_HAUL_SHARE);
  if (own) return own;
  const s = g.state;
  const tl = s.tiles;
  const W = s.W;
  const radius = BUILDINGS[b.type].workRadius ?? 12;
  const [cx, cz] = centerOf(b);
  const now = s.time.elapsed;
  const mature: number[] = [];
  const spots: number[] = [];
  let trees = 0;
  let land = 0;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const z0 = Math.max(0, Math.floor(cz - radius));
  const z1 = Math.min(s.H - 1, Math.ceil(cz + radius));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (dm.sq(x + 0.5 - cx) + dm.sq(z + 0.5 - cz) > radius * radius) continue;
      const i = z * W + x;
      if (!isLandTerrain(tl.terrain[i]) || tl.building[i] >= 0 || tl.road[i] !== 0) continue;
      land++;
      if (tl.feature[i] === Feature.Tree) {
        trees++;
        if (tl.featureAmount[i] >= 1 && !tl.marked[i] && tileFree(g, i, c)) mature.push(i);
      } else if (tl.feature[i] === Feature.None && tileSlope(s, x, z) <= 1.2 && tileFree(g, i, c) && plantable(g, i)) {
        spots.push(i);
      }
    }
  }
  const density = land > 0 ? trees / land : 1;
  const wantCut = mature.length > 0 && (spots.length === 0 || density > 0.45 || g.rng.chance(0.45));
  const wantPlant = spots.length > 0 && density < 0.65;
  const tryCut = (): Task | null => {
    if (bufferFull(b)) return haulOwn(g, c, b, 0, true);
    for (let k = 0; k < 6 && mature.length > 0; k++) {
      const j = Math.floor(g.rng.next() * mature.length);
      const i = mature[j];
      mature.splice(j, 1);
      const x = i % W;
      const z = Math.floor(i / W);
      if (isBlacklisted(brain, `t${i}`, now) || !reachable(g, c, x, z)) continue;
      const t = mkTask('work', 'Felling a tree', [
        { op: 'go', x, z }, { op: 'chop', i, b: b.id }, goDoor(b), { op: 'deposit', b: b.id },
      ], { job: true });
      if (claimTile(g, t, c, i)) return t;
    }
    return null;
  };
  const tryPlant = (): Task | null => {
    for (let k = 0; k < 6 && spots.length > 0; k++) {
      const j = Math.floor(g.rng.next() * spots.length);
      const i = spots[j];
      spots.splice(j, 1);
      const x = i % W;
      const z = Math.floor(i / W);
      if (isBlacklisted(brain, `t${i}`, now) || !reachable(g, c, x, z)) continue;
      const t = mkTask('work', 'Planting a sapling', [{ op: 'go', x, z }, { op: 'plant', i, b: b.id }], { job: true });
      if (claimTile(g, t, c, i)) return t;
    }
    return null;
  };
  if (wantCut) {
    const t = tryCut();
    if (t) return t;
  }
  if (wantPlant) {
    const t = tryPlant();
    if (t) return t;
  }
  if (mature.length > 0) {
    const t = tryCut();
    if (t) return t;
  }
  return haulOwn(g, c, b, 0, true);
}
