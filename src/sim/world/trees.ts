/**
 * Tree growth and natural forest spread. OWNER: sim-world agent.
 *
 * The map is swept incrementally, a slice of rows per sim step, so that every row is visited once per
 * TREE_SWEEP_SECONDS of game time (smooth per-step cost, no spikes; scheduling lives in nature.ts). Each visit grows
 * saplings by one sweep period and occasionally lets a mature tree drop a seedling nearby.
 * Scanning the tile arrays (instead of keeping an index) is robust against trees planted/removed by other systems
 * (foresters, clearing, tornadoes).
 */
import { TREE_GROWTH_RATE, YEAR_SECONDS } from '../../core/constants';
import type { Rng } from '../../core/rng';
import type { GameState } from '../../core/types';
import { Feature, Road, Terrain } from '../../core/types';

/** Chance per mature tree per year to try dropping a seedling nearby (most tries inside dense forest find no room). */
export const SPREAD_PER_TREE_PER_YEAR = 0.012;
/** Growth of a freshly spread seedling. */
export const SEEDLING_GROWTH = 0.02;
/** Game seconds for one full sweep over all rows. */
export const TREE_SWEEP_SECONDS = 2;
/** Growth steps that count as a visible change (bump rev.features when crossed). */
const VISUAL_STEPS = 16;

const TREE = Feature.Tree;
const NONE = Feature.None;
const GRASS = Terrain.Grass;
const NO_ROAD = Road.None;

let matureBuf = new Int32Array(0);

/** Grow saplings in row z by `dt` game seconds and maybe spread seedlings from its mature trees. */
export function updateTreeRow(state: GameState, rng: Rng, z: number, dt: number): boolean {
  const W = state.W;
  const { feature, featureAmount } = state.tiles;
  if (matureBuf.length < W) matureBuf = new Int32Array(W);
  const grow = TREE_GROWTH_RATE * dt;
  let changed = false;
  let mature = 0;
  const end = (z + 1) * W;
  for (let i = z * W; i < end; i++) {
    if (feature[i] !== TREE) continue;
    const a = featureAmount[i];
    if (a < 1) {
      const na = a + grow >= 1 ? 1 : a + grow;
      if (((na * VISUAL_STEPS) | 0) !== ((a * VISUAL_STEPS) | 0)) changed = true;
      featureAmount[i] = na;
    } else {
      if (a > 1) featureAmount[i] = 1;
      matureBuf[mature++] = i;
    }
  }
  if (mature > 0) {
    const expected = (mature * SPREAD_PER_TREE_PER_YEAR * dt) / YEAR_SECONDS;
    let n = Math.floor(expected);
    if (rng.next() < expected - n) n++;
    for (let k = 0; k < n; k++) {
      const src = matureBuf[Math.floor(rng.next() * mature)];
      if (trySpread(state, rng, src)) changed = true;
    }
  }
  return changed;
}

/** Grow/spread over the whole map at once (tests, catch-up). */
export function updateTrees(state: GameState, rng: Rng, dt: number): boolean {
  let changed = false;
  for (let z = 0; z < state.H; z++) if (updateTreeRow(state, rng, z, dt)) changed = true;
  return changed;
}

/** Seed a sapling on a random free grass tile within 2 tiles of `src`. */
export function trySpread(state: GameState, rng: Rng, src: number): boolean {
  const { W, H } = state;
  const t = state.tiles;
  const sx = src % W;
  const sz = (src - sx) / W;
  for (let attempt = 0; attempt < 3; attempt++) {
    const dx = rng.int(-2, 2);
    const dz = rng.int(-2, 2);
    if (dx === 0 && dz === 0) continue;
    const x = sx + dx;
    const z = sz + dz;
    if (x < 1 || z < 1 || x >= W - 1 || z >= H - 1) continue;
    const i = z * W + x;
    if (!canSeed(state, i)) continue;
    // Keep towns tidy: never right next to a building.
    if (t.building[i - 1] >= 0 || t.building[i + 1] >= 0 || t.building[i - W] >= 0 || t.building[i + W] >= 0) continue;
    t.feature[i] = TREE;
    t.featureAmount[i] = SEEDLING_GROWTH;
    // Mostly the parent's species, sometimes another one (mixed forest edges).
    t.variant[i] = rng.next() < 0.85 ? t.variant[src] : rng.int(0, 2);
    t.marked[i] = 0;
    return true;
  }
  return false;
}

/** A tile where a tree may appear naturally: free grass, no building/road/field, not marked. */
export function canSeed(state: GameState, i: number): boolean {
  const t = state.tiles;
  return t.terrain[i] === GRASS && t.feature[i] === NONE && t.building[i] < 0 && t.road[i] === NO_ROAD && t.marked[i] === 0;
}
