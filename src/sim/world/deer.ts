/**
 * Wild deer herds: initial placement (world generation) and wandering / breeding (nature update).
 * OWNER: sim-world agent.
 *
 * Herd model
 * - Every animal has a `herd` id. The herd's *leader* is its lowest-id member; the leader's wander state carries the
 *   herd's home (hx, hz) and roaming goal (gx, gz). The goal drifts every 40–90 s to another forest spot 6–18 tiles
 *   away that can be reached in a straight line over deer-walkable ground, preferring dense forest, staying within
 *   ~HOME_RANGE of home, away from buildings and from other herds. Herds therefore keep a stable home range (hunters
 *   placed near a herd keep finding it); when the home forest is cut down the herd relocates to a forest nearby.
 * - Every member picks short legs (≤ 6 tiles) towards random points around the goal, walks them with smooth heading
 *   changes, then grazes for a few seconds. Legs are validated by sampling the straight line, so deer never step into
 *   water, onto mountains or into non-walkable buildings.
 * - `huntedBy >= 0` freezes the animal (hunters need a still target); if the hunter no longer exists the reservation
 *   is released.
 * - Herds breed (≈ BREED_PER_YEAR fawns/year, lone survivors at half rate) up to HERD_MAX members; full herds
 *   occasionally split off a new herd that settles in another forest away from the other herds (re-seeding hunted-out
 *   ranges). Splitting is bounded by a global cap that scales with the map area. When the population collapses, a
 *   small herd occasionally wanders in from the wilds far away from the town.
 *
 * All wander state is plain JSON (numbers) inside `Animal.wander`, so it survives save/load.
 */
import { YEAR_SECONDS } from '../../core/constants';
import { BUILDINGS } from '../../core/defs';
import type { Rng } from '../../core/rng';
import type { Animal, GameState } from '../../core/types';
import { Feature, Terrain } from '../../core/types';
import type { Game } from '../game';
import type { GenContext } from './context';
import { START_HALF } from './context';
import { IntegralImage } from './grid';
import * as dm from '../core/dmath';

export interface DeerWander {
  /** Current leg target (world coords). */
  tx: number;
  tz: number;
  /** Seconds left grazing before the next leg. */
  wait: number;
  /** Walking speed multiplier for the current leg. */
  sp: number;
  /** Leader only: herd roaming goal and seconds until it moves. */
  gx?: number;
  gz?: number;
  gt?: number;
  /** Leader only: centre of the herd's home range. */
  hx?: number;
  hz?: number;
}

export const DEER_SPEED = 0.85;
const TURN_RATE = 5;
const LEG_MAX = 6;
export const HERD_MAX = 8;
/** Expected fawns per herd per year (herds below HERD_MAX always breed, so hunted ranges refill). */
const BREED_PER_YEAR = 5;
/** Chance per year that a full herd splits off a new herd (when below the global cap). */
const SPLIT_PER_YEAR = 1;
/** Herds keep their roaming goals within about this distance (tiles) of home. */
export const HOME_RANGE = 16;

export function deerCap(state: Pick<GameState, 'W' | 'H'>): number {
  return Math.max(30, Math.round((state.W * state.H) / 320));
}

/** Most herds the map supports (full herds split off new ones below this). */
export function maxHerds(state: Pick<GameState, 'W' | 'H'>): number {
  return Math.max(5, Math.round(deerCap(state) / 6));
}

// ---------------------------------------------------------------------------------------------
// Walkability for deer
// ---------------------------------------------------------------------------------------------

/** Deer walk on land, avoid non-walkable buildings (walkable zones such as fields are crossed). */
export function deerCanWalk(game: Game, i: number): boolean {
  const t = game.state.tiles;
  const ter = t.terrain[i];
  if (ter !== Terrain.Grass && ter !== Terrain.Sand) return false;
  const b = t.building[i];
  if (b < 0) return true;
  const bd = game.buildingById.get(b);
  return !!bd && !!BUILDINGS[bd.type]?.walkable;
}

/** Deer prefer to stand on land without any building (zones included). */
function deerCanRest(game: Game, i: number): boolean {
  const t = game.state.tiles;
  const ter = t.terrain[i];
  return (ter === Terrain.Grass || ter === Terrain.Sand) && t.building[i] < 0;
}

/** Straight segment check (samples every 0.4 tiles). */
function lineWalkable(game: Game, x0: number, z0: number, x1: number, z1: number): boolean {
  const s = game.state;
  const d = dm.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(d / 0.4));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const x = Math.floor(x0 + (x1 - x0) * t);
    const z = Math.floor(z0 + (z1 - z0) * t);
    if (x < 0 || z < 0 || x >= s.W || z >= s.H) return false;
    if (!deerCanWalk(game, z * s.W + x)) return false;
  }
  return true;
}

function treesAround(state: GameState, x: number, z: number, r: number): number {
  const { feature, featureAmount } = state.tiles;
  let n = 0;
  for (let zz = Math.max(0, z - r); zz <= Math.min(state.H - 1, z + r); zz++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(state.W - 1, x + r); xx++) {
      const i = zz * state.W + xx;
      if (feature[i] === Feature.Tree && featureAmount[i] >= 0.3) n++;
    }
  }
  return n;
}

function buildingsAround(state: GameState, x: number, z: number, r: number): boolean {
  const b = state.tiles.building;
  for (let zz = Math.max(0, z - r); zz <= Math.min(state.H - 1, z + r); zz++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(state.W - 1, x + r); xx++) {
      if (b[zz * state.W + xx] >= 0) return true;
    }
  }
  return false;
}

function wanderOf(a: Animal): DeerWander {
  const w = a.wander as DeerWander | null | undefined;
  if (w && typeof w === 'object' && typeof w.tx === 'number') return w;
  const nw: DeerWander = { tx: a.x, tz: a.z, wait: 1, sp: 1 };
  a.wander = nw;
  return nw;
}

// ---------------------------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------------------------

/**
 * 4–10 herds of 3–7 deer in dense forest, outside the start area (≥ 20 tiles). The first herd is placed 20–34
 * tiles from the start so the settlement can hunt early; the others anywhere, at least 20 tiles apart.
 */
export function spawnDeerHerds(ctx: GenContext, allocId: () => number): Animal[] {
  const { W, H, N, rng, tiles, startX, startZ } = ctx;
  const { feature, featureAmount, terrain } = tiles;
  const trees = new IntegralImage(W, H, (i) => (feature[i] === Feature.Tree && featureAmount[i] >= 0.3 ? 1 : 0));
  const herdCount = Math.max(4, Math.min(10, Math.round((4 + N / 7000) * rng.range(0.85, 1.15))));
  const centers: [number, number][] = [];
  const animals: Animal[] = [];
  const minStart = START_HALF + 8;
  for (let h = 0; h < herdCount; h++) {
    let found: [number, number] | null = null;
    for (let a = 0; a < 400 && !found; a++) {
      let x: number;
      let z: number;
      if (h === 0 && a < 250) {
        // The first herd lives within hunting reach of the settlement (20–34 tiles from the start).
        const ang = rng.range(0, Math.PI * 2);
        const d = rng.range(minStart, minStart + 14);
        x = Math.round(startX + dm.cos(ang) * d);
        z = Math.round(startZ + dm.sin(ang) * d);
        if (x < 6 || z < 6 || x >= W - 7 || z >= H - 7) continue;
      } else {
        x = rng.int(6, W - 7);
        z = rng.int(6, H - 7);
      }
      const i = z * W + x;
      if (feature[i] !== Feature.Tree) continue;
      const need = a < 250 ? (h === 0 ? 20 : 26) : 14;
      if (trees.sum(x - 4, z - 4, x + 5, z + 5) < need) continue;
      if (dm.hypot(x - startX, z - startZ) < minStart) continue;
      let ok = true;
      for (const c of centers) {
        if (dm.hypot(c[0] - x, c[1] - z) < 20) {
          ok = false;
          break;
        }
      }
      if (ok) found = [x, z];
    }
    if (!found) continue;
    centers.push(found);
    const size = rng.int(3, 7);
    const herdId = h + 1;
    let placed = 0;
    for (let a = 0; a < size * 10 && placed < size; a++) {
      const x = found[0] + 0.5 + rng.gaussian() * 1.8;
      const z = found[1] + 0.5 + rng.gaussian() * 1.8;
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      if (tx < 0 || tz < 0 || tx >= W || tz >= H) continue;
      const t = terrain[tz * W + tx];
      if (t !== Terrain.Grass && t !== Terrain.Sand) continue;
      const w: DeerWander = { tx: x, tz: z, wait: rng.range(0, 6), sp: 1 };
      if (placed === 0) {
        w.gx = w.hx = found[0] + 0.5;
        w.gz = w.hz = found[1] + 0.5;
        w.gt = rng.range(20, 70);
      }
      animals.push({
        id: allocId(), kind: 'deer', x, z, heading: rng.range(-Math.PI, Math.PI), moving: false, herd: herdId, huntedBy: -1, wander: w,
      });
      placed++;
    }
  }
  return animals;
}

// ---------------------------------------------------------------------------------------------
// Runtime behaviour
// ---------------------------------------------------------------------------------------------

const leaders = new Map<number, Animal>();
const herdSizes = new Map<number, number>();

function collectHerds(animals: Animal[]): void {
  leaders.clear();
  herdSizes.clear();
  for (const a of animals) {
    if (a.kind !== 'deer') continue;
    const l = leaders.get(a.herd);
    if (!l || a.id < l.id) leaders.set(a.herd, a);
    herdSizes.set(a.herd, (herdSizes.get(a.herd) ?? 0) + 1);
  }
}

/** Distance (tiles) within which herds push each other away when choosing roaming goals. */
const HERD_SPACING = 16;

/**
 * Pick a new roaming goal for a herd: a forest spot reachable in a straight line, away from buildings and from the
 * other herds (so herds spread over the map's forests instead of clumping).
 */
function pickHerdGoal(game: Game, rng: Rng, herd: number, gx: number, gz: number, hx: number, hz: number, far = false): [number, number] {
  const s = game.state;
  let best: [number, number] = [gx, gz];
  let bestScore = -Infinity;
  for (let a = 0; a < 14; a++) {
    const ang = rng.range(0, Math.PI * 2);
    const d = far ? rng.range(12, 28) : rng.range(6, 18);
    const nx = gx + dm.cos(ang) * d;
    const nz = gz + dm.sin(ang) * d;
    const tx = Math.floor(nx);
    const tz = Math.floor(nz);
    if (tx < 3 || tz < 3 || tx >= s.W - 3 || tz >= s.H - 3) continue;
    if (!deerCanRest(game, tz * s.W + tx)) continue;
    if (!lineWalkable(game, gx, gz, nx, nz)) continue;
    let score = treesAround(s, tx, tz, 3) + rng.next() * 4;
    if (buildingsAround(s, tx, tz, 5)) score -= 30;
    if (!far) score -= Math.max(0, dm.hypot(nx - hx, nz - hz) - HOME_RANGE) * 3;
    for (const [h, l] of leaders) {
      if (h === herd) continue;
      const lw = l.wander as DeerWander | null;
      const ox = lw?.gx ?? l.x;
      const oz = lw?.gz ?? l.z;
      const od = dm.hypot(ox - nx, oz - nz);
      if (od < HERD_SPACING) score -= (HERD_SPACING - od) * 2.5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = [nx, nz];
    }
  }
  return best;
}

/** Pick the next short leg for a deer, towards a random point around the herd goal. */
function pickLeg(game: Game, rng: Rng, a: Animal, w: DeerWander, gx: number, gz: number): boolean {
  const s = game.state;
  for (let k = 0; k < 8; k++) {
    let px = gx + rng.gaussian() * 2.6;
    let pz = gz + rng.gaussian() * 2.6;
    if (k >= 5) {
      // Fallback: a random short hop around the current position (gets around obstacles).
      const ang = rng.range(0, Math.PI * 2);
      const d = rng.range(1, 3);
      px = a.x + dm.cos(ang) * d;
      pz = a.z + dm.sin(ang) * d;
    }
    const dx = px - a.x;
    const dz = pz - a.z;
    const d = dm.hypot(dx, dz);
    if (d > LEG_MAX) {
      px = a.x + (dx / d) * LEG_MAX;
      pz = a.z + (dz / d) * LEG_MAX;
    }
    const tx = Math.floor(px);
    const tz = Math.floor(pz);
    if (tx < 1 || tz < 1 || tx >= s.W - 1 || tz >= s.H - 1) continue;
    if (!deerCanRest(game, tz * s.W + tx)) continue;
    if (!lineWalkable(game, a.x, a.z, px, pz)) continue;
    w.tx = px;
    w.tz = pz;
    w.sp = rng.next() < 0.12 ? rng.range(1.8, 2.4) : rng.range(0.75, 1.15);
    return true;
  }
  return false;
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move every deer. Called every sim step. */
export function updateDeer(game: Game, dt: number): void {
  const s = game.state;
  const animals = s.animals;
  if (animals.length === 0) return;
  const rng = game.rng;
  collectHerds(animals);
  const W = s.W;

  for (const a of animals) {
    if (a.kind !== 'deer') continue;
    if (a.huntedBy >= 0) {
      if (game.citizenById.size > 0 && !game.citizenById.has(a.huntedBy)) a.huntedBy = -1;
      else {
        a.moving = false;
        continue;
      }
    }
    const w = wanderOf(a);
    const leader = leaders.get(a.herd) ?? a;
    const lw = leader === a ? w : wanderOf(leader);
    if (leader === a) {
      if (lw.gx === undefined || lw.gz === undefined || lw.gt === undefined) {
        lw.gx = a.x;
        lw.gz = a.z;
        lw.gt = rng.range(20, 60);
      }
      if (lw.hx === undefined || lw.hz === undefined) {
        lw.hx = lw.gx;
        lw.hz = lw.gz;
      }
      lw.gt -= dt;
      if (lw.gt <= 0) {
        // Home forest gone (cut down / built over)? Move the home range to a forest nearby.
        const relocate = treesAround(s, Math.floor(lw.hx), Math.floor(lw.hz), 4) < 8;
        const g = pickHerdGoal(game, rng, a.herd, lw.gx, lw.gz, lw.hx, lw.hz, relocate);
        lw.gx = g[0];
        lw.gz = g[1];
        if (relocate) {
          lw.hx = g[0];
          lw.hz = g[1];
        }
        lw.gt = rng.range(40, 90);
      }
    }
    const gx = lw.gx ?? a.x;
    const gz = lw.gz ?? a.z;

    if (w.wait > 0) {
      w.wait -= dt;
      a.moving = false;
      if (w.wait <= 0 && !pickLeg(game, rng, a, w, gx, gz)) w.wait = rng.range(1, 3);
      continue;
    }

    const dx = w.tx - a.x;
    const dz = w.tz - a.z;
    const dist = dm.hypot(dx, dz);
    if (dist < 0.05) {
      a.moving = false;
      // Mostly graze a while; sometimes just pause briefly before the next leg.
      w.wait = rng.next() < 0.75 ? rng.range(4, 12) : rng.range(0.5, 2);
      continue;
    }
    // Turn smoothly towards the target; walk slower while turning sharply.
    const want = dm.atan2(dz, dx);
    const diff = angleDiff(a.heading, want);
    const maxTurn = TURN_RATE * dt;
    a.heading += Math.abs(diff) <= maxTurn ? diff : Math.sign(diff) * maxTurn;
    if (a.heading > Math.PI) a.heading -= Math.PI * 2;
    else if (a.heading < -Math.PI) a.heading += Math.PI * 2;
    const turnSlow = Math.max(0.25, dm.cos(Math.min(Math.abs(diff), Math.PI / 2)));
    const step = Math.min(dist, DEER_SPEED * w.sp * turnSlow * dt);
    const nx = a.x + (dx / dist) * step;
    const nz = a.z + (dz / dist) * step;
    const tx = Math.floor(nx);
    const tz = Math.floor(nz);
    const cur = Math.floor(a.z) * W + Math.floor(a.x);
    const inside = tx >= 0 && tz >= 0 && tx < W && tz < s.H;
    const curOk = cur >= 0 && cur < W * s.H && deerCanWalk(game, cur);
    if (!inside || (curOk && !deerCanWalk(game, tz * W + tx))) {
      // Something appeared in the way (building, bridge removed…): stop and rethink.
      a.moving = false;
      w.tx = a.x;
      w.tz = a.z;
      w.wait = rng.range(0.5, 1.5);
      continue;
    }
    a.x = nx;
    a.z = nz;
    a.moving = true;
  }
}

/** Slow breeding (per herd) and rare immigration. `dt` is the accumulated period in game seconds. */
export function breedDeer(game: Game, dt: number): boolean {
  const s = game.state;
  const rng = game.rng;
  collectHerds(s.animals);
  let total = 0;
  for (const a of s.animals) if (a.kind === 'deer') total++;
  const cap = deerCap(s);
  let changed = false;
  const p = (BREED_PER_YEAR * dt) / YEAR_SECONDS;
  const pSplit = (SPLIT_PER_YEAR * dt) / YEAR_SECONDS;
  let nextHerd = 0;
  for (const h of herdSizes.keys()) nextHerd = Math.max(nextHerd, h);
  for (const [herd, size] of herdSizes) {
    const parent = leaders.get(herd);
    if (!parent) continue;
    // The cap is per herd (HERD_MAX): a global cap froze breeding everywhere once the far-away herds were full,
    // while the herds near a hunting cabin stayed hunted out. The global cap only limits new herds (splits).
    if (size < HERD_MAX) {
      // A lone survivor still "breeds" at half rate (stragglers joining it), so hunted-out ranges slowly recover.
      if (rng.next() >= (size < 2 ? p * 0.5 : p)) continue;
      if (spawnNear(game, rng, parent.x, parent.z, herd)) {
        total++;
        changed = true;
      }
    } else if (herdSizes.size < maxHerds(s) && rng.next() < pSplit) {
      // new herds (bounded by count, not by total deer) settle in forests away from the others — e.g. a range whose
      // herd was hunted out
      if (splitHerd(game, rng, herd, ++nextHerd)) changed = true;
    }
  }
  // Immigration when the wild population has collapsed.
  const minDeer = Math.max(6, Math.round(cap / 8));
  if (total < minDeer && rng.next() < (0.6 * dt) / YEAR_SECONDS) {
    if (spawnImmigrantHerd(game, rng)) changed = true;
  }
  return changed;
}

/** The three youngest members of a full herd leave to found a new herd in another forest. */
function splitHerd(game: Game, rng: Rng, herd: number, newHerd: number): boolean {
  const s = game.state;
  const members = s.animals.filter((a) => a.kind === 'deer' && a.herd === herd && a.huntedBy < 0).sort((p, q) => q.id - p.id);
  if (members.length < 6) return false;
  const leader = leaders.get(herd);
  if (!leader) return false;
  const lw = wanderOf(leader);
  const fx = lw.gx ?? leader.x;
  const fz = lw.gz ?? leader.z;
  const home = pickHerdGoal(game, rng, newHerd, fx, fz, fx, fz, true);
  if (dm.hypot(home[0] - fx, home[1] - fz) < 8) return false;
  const leaving = members.slice(0, 3).sort((p, q) => p.id - q.id);
  for (const a of leaving) a.herd = newHerd;
  const nl = wanderOf(leaving[0]);
  nl.gx = nl.hx = home[0];
  nl.gz = nl.hz = home[1];
  nl.gt = rng.range(60, 120);
  return true;
}

function spawnNear(game: Game, rng: Rng, x: number, z: number, herd: number): Animal | null {
  const s = game.state;
  for (let k = 0; k < 10; k++) {
    const nx = x + rng.gaussian() * 1.2;
    const nz = z + rng.gaussian() * 1.2;
    const tx = Math.floor(nx);
    const tz = Math.floor(nz);
    if (tx < 1 || tz < 1 || tx >= s.W - 1 || tz >= s.H - 1) continue;
    if (!deerCanRest(game, tz * s.W + tx)) continue;
    if (!lineWalkable(game, x, z, nx, nz)) continue;
    const a: Animal = {
      id: game.newId(), kind: 'deer', x: nx, z: nz, heading: rng.range(-Math.PI, Math.PI), moving: false, herd, huntedBy: -1,
      wander: { tx: nx, tz: nz, wait: rng.range(2, 6), sp: 1 } satisfies DeerWander,
    };
    s.animals.push(a);
    game.animalById.set(a.id, a);
    return a;
  }
  return null;
}

function spawnImmigrantHerd(game: Game, rng: Rng): boolean {
  const s = game.state;
  let herdId = 0;
  for (const a of s.animals) herdId = Math.max(herdId, a.herd);
  herdId++;
  for (let k = 0; k < 60; k++) {
    // Near the map border, in forest, far from buildings.
    const side = rng.int(0, 3);
    const t = rng.range(0.1, 0.9);
    const inset = rng.range(8, 16);
    const x = Math.floor(side === 0 ? inset : side === 1 ? s.W - inset : t * s.W);
    const z = Math.floor(side === 2 ? inset : side === 3 ? s.H - inset : t * s.H);
    if (x < 2 || z < 2 || x >= s.W - 2 || z >= s.H - 2) continue;
    if (!deerCanRest(game, z * s.W + x)) continue;
    if (treesAround(s, x, z, 3) < 8) continue;
    if (buildingsAround(s, x, z, 12)) continue;
    const n = rng.int(3, 4);
    let placed = 0;
    for (let j = 0; j < n; j++) {
      const a = spawnNear(game, rng, x + 0.5, z + 0.5, herdId);
      if (a) {
        if (placed === 0) {
          a.wander = { tx: a.x, tz: a.z, wait: 2, sp: 1, gx: x + 0.5, gz: z + 0.5, gt: rng.range(20, 50), hx: x + 0.5, hz: z + 0.5 } satisfies DeerWander;
        }
        placed++;
      }
    }
    if (placed > 0) {
      game.addMessage?.('A small herd of deer has wandered into the valley.', 'info', { kind: 'tile', id: z * s.W + x });
      return true;
    }
  }
  return false;
}
