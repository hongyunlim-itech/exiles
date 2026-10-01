/**
 * Natural world simulation: tree growth & spread, deer herds. OWNER: sim-world agent.
 *
 * - Deer move every step (smooth continuous movement, see world/deer.ts; all state lives in Animal.wander).
 * - Trees: rows are swept on a fixed schedule so the whole map is visited every TREE_SWEEP_SECONDS of game time
 *   (smooth per-step cost, no spikes). Saplings grow by TREE_GROWTH_RATE; mature trees rarely drop seedlings on free
 *   grass nearby (never onto buildings/fields, roads, water, sand or marked tiles).
 * - Deer breeding / immigration is checked every NATURE_PASS game seconds.
 * - `rev.features` is bumped at most once per FEATURE_BUMP_INTERVAL game seconds, and only when a sapling crossed a
 *   visible growth step or a seedling appeared.
 *
 * Determinism: randomness uses `game.rng` (seeded & saved) and every schedule is derived from the saved game clock
 * (`state.time.elapsed`, advanced by the time step before nature runs): the rows swept and the breeding checks in a
 * step are those whose slots fall in (elapsed − dt, elapsed]. Nothing that influences the RNG stream lives in runtime
 * memory, so a game restored from a save continues exactly like the original. (When the clock is not advancing —
 * e.g. tests calling updateNature directly — a private runtime clock is used instead.)
 */
import type { GameState } from '../core/types';
import { Feature } from '../core/types';
import type { Game } from './game';
import { breedDeer, updateDeer } from './world/deer';
import { TREE_SWEEP_SECONDS, updateTreeRow } from './world/trees';

/** Game seconds between deer breeding checks. */
export const NATURE_PASS = 2;
/** Minimum game seconds between rev.features bumps caused by natural growth. */
export const FEATURE_BUMP_INTERVAL = 1;

/** Runtime-only bookkeeping (never influences the simulation outcome). */
interface NatureRuntime {
  /** Last game clock value seen, and the private fallback clock. */
  lastElapsed: number;
  clock: number;
  sinceBump: number;
  dirty: boolean;
}

const runtimes = new WeakMap<GameState, NatureRuntime>();

function runtimeOf(state: GameState): NatureRuntime {
  let r = runtimes.get(state);
  if (!r) {
    r = { lastElapsed: -1, clock: Math.max(0, state.time.elapsed), sinceBump: 0, dirty: false };
    runtimes.set(state, r);
  }
  return r;
}

/** Time window (t0, t1] covered by this step. */
function stepWindow(state: GameState, rt: NatureRuntime, dt: number): [number, number] {
  const e = state.time.elapsed;
  if (e > 0 && e !== rt.lastElapsed) {
    rt.lastElapsed = e;
    rt.clock = e;
    return [e - dt, e];
  }
  const t0 = rt.clock;
  rt.clock += dt;
  return [t0, rt.clock];
}

/** Called every sim step. Grow saplings, occasionally seed new trees near forests, wander/breed deer herds. */
export function updateNature(game: Game, dt: number): void {
  if (!(dt > 0)) return;
  const state = game.state;
  const rt = runtimeOf(state);
  const [t0, t1] = stepWindow(state, rt, dt);

  updateDeer(game, dt);

  // Tree rows whose sweep slot falls inside the window.
  const H = state.H;
  const slots = H / TREE_SWEEP_SECONDS;
  const c0 = Math.floor(t0 * slots);
  const c1 = Math.floor(t1 * slots);
  let changed = false;
  if (c1 - c0 >= H) {
    // Huge step: every row once, growing by the whole window.
    for (let z = 0; z < H; z++) if (updateTreeRow(state, game.rng, z, t1 - t0)) changed = true;
  } else {
    for (let c = c0 + 1; c <= c1; c++) {
      const z = ((c % H) + H) % H;
      if (updateTreeRow(state, game.rng, z, TREE_SWEEP_SECONDS)) changed = true;
    }
  }

  // Breeding checks on fixed NATURE_PASS slots.
  const p0 = Math.floor(t0 / NATURE_PASS);
  const p1 = Math.floor(t1 / NATURE_PASS);
  if (p1 > p0) breedDeer(game, (p1 - p0) * NATURE_PASS);

  // Batched render invalidation.
  if (changed) rt.dirty = true;
  rt.sinceBump += dt;
  if (rt.dirty && rt.sinceBump >= FEATURE_BUMP_INTERVAL) {
    state.rev.features++;
    rt.dirty = false;
    rt.sinceBump = 0;
  }
}

/** Remove an animal (killed by a hunter / tornado). */
export function removeAnimal(game: Game, id: number): void {
  const list = game.state.animals;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list.splice(i, 1);
      break;
    }
  }
  game.animalById.delete(id);
}

/** Count mature trees (growth >= 0.5) within radius r of world point (cx, cz). */
export function countTreesInRadius(game: Game, cx: number, cz: number, r: number): number {
  const s = game.state;
  const W = s.W;
  const feature = s.tiles.feature;
  const amount = s.tiles.featureAmount;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const z0 = Math.max(0, Math.floor(cz - r));
  const z1 = Math.min(s.H - 1, Math.ceil(cz + r));
  const r2 = r * r;
  let n = 0;
  for (let z = z0; z <= z1; z++) {
    const dz = z + 0.5 - cz;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dz * dz > r2) continue;
      const i = z * W + x;
      if (feature[i] === Feature.Tree && amount[i] >= 0.5) n++;
    }
  }
  return n;
}

export { deerCanWalk, deerCap } from './world/deer';
