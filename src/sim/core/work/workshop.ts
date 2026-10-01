/**
 * Workshops (woodcutter, blacksmith, tailor, brewery) and extraction sites (quarry, mine).
 * ARCHITECTURE §3.5 "Workshops" / "Quarry" / "Mine". OWNER: sim-core.
 */
import { CARRY_CAPACITY } from '../../../core/constants';
import { BUILDINGS, type RecipeDef } from '../../../core/defs';
import type { Building, Citizen, ResourceType } from '../../../core/types';
import type { Game } from '../../game';
import { bufferUsed, haulableOutputs } from '../buildings';
import { claimOut } from '../claims';
import { availableInStorage, findSource, unreserved } from '../storage';
import { mkTask, type Task } from '../tasks';
import { invGet, invTotal, resName } from '../util';
import { fetchIntoTask, goDoor, reachableB } from './common';
import { haulOwn } from './gather';
import * as dm from '../dmath';

function recipeOutputTotal(rc: RecipeDef): number {
  let n = 0;
  for (const k in rc.outputs) n += invGet(rc.outputs, k as ResourceType);
  return n;
}

/** How many batches of the recipe could be made from inputs in the building + storage. */
function batchesAvailable(g: Game, w: Building, rc: RecipeDef): number {
  let batches = Infinity;
  for (const k in rc.inputs) {
    const r = k as ResourceType;
    const need = invGet(rc.inputs, r);
    if (need <= 0) continue;
    const have = unreserved(w, r) + availableInStorage(g, r);
    batches = Math.min(batches, Math.floor(have / need));
  }
  return batches === Infinity ? 0 : batches;
}

/** Selected recipe, or the automatic choice (the feasible recipe with the most input stock). */
export function chooseRecipe(g: Game, w: Building): number {
  const recipes = BUILDINGS[w.type].recipes ?? [];
  if (recipes.length === 0) return -1;
  if (w.recipe !== undefined && w.recipe >= 0 && w.recipe < recipes.length) return w.recipe;
  let best = -1;
  let bestN = 0;
  for (let i = 0; i < recipes.length; i++) {
    if (recipes.length > 1 && limitReached(g, recipes[i])) continue;
    const n = batchesAvailable(g, w, recipes[i]);
    if (n > bestN) {
      bestN = n;
      best = i;
    }
  }
  return best;
}

function hasInputs(w: Building, rc: RecipeDef): boolean {
  for (const k in rc.inputs) {
    const r = k as ResourceType;
    if (unreserved(w, r) + 1e-6 < invGet(rc.inputs, r)) return false;
  }
  return true;
}

/**
 * Automatic production limit per output resource (Banished's default resource limits): workshops stop once
 * the town has plenty, freeing the workers to help as laborers. null = unlimited.
 */
export function productionLimit(g: Game, r: ResourceType): number | null {
  const s = g.state;
  const pop = s.citizens.length;
  switch (r) {
    case 'firewood': {
      let houses = 0;
      for (const h of g.rt.houses(s)) if (h.state === 'active') houses++;
      return 150 + houses * 45;
    }
    case 'tool':
      return 12 + Math.ceil(pop * 1.2);
    case 'woolCoat':
    case 'leatherCoat':
      return 10 + Math.ceil(pop * 0.8);
    case 'ale':
      return 60 + pop * 3;
    default:
      return null;
  }
}

function limitReached(g: Game, rc: RecipeDef): boolean {
  const totals = g.resourceTotals();
  for (const k in rc.outputs) {
    const r = k as ResourceType;
    const lim = productionLimit(g, r);
    if (lim === null || totals[r] < lim) return false;
  }
  return true;
}

export function planWorkshop(g: Game, c: Citizen, w: Building): Task | null {
  const def = BUILDINGS[w.type];
  const recipes = def.recipes ?? [];
  const cap = def.bufferCapacity ?? 40;
  const used = bufferUsed(w);
  const outs = haulableOutputs(w);
  if (outs.length > 0 && (used >= cap * 0.5 || (outs[0].n >= CARRY_CAPACITY && g.rng.chance(0.25)))) {
    const t = haulOwn(g, c, w, 0, true);
    if (t) return t;
  }
  const ri = chooseRecipe(g, w);
  if (ri < 0) return outs.length > 0 ? haulOwn(g, c, w, 0, true) : null;
  const rc = recipes[ri];
  if (limitReached(g, rc)) return outs.length > 0 ? haulOwn(g, c, w, 0, true) : null;
  // craft a batch if inputs are here and there is room for the output
  if (hasInputs(w, rc) && used + recipeOutputTotal(rc) <= cap) {
    const t = mkTask('work', `Making ${rc.label.toLowerCase()}`, [goDoor(w), { op: 'craft', b: w.id, r: ri }], { job: true });
    for (const k in rc.inputs) claimOut(t, w, k as ResourceType, invGet(rc.inputs, k as ResourceType));
    return t;
  }
  if (used + recipeOutputTotal(rc) > cap) return haulOwn(g, c, w, 0, true);
  // fetch the scarcest input
  const room = Math.max(0, cap * 1.5 - invTotal(w.inventory));
  let bestR: ResourceType | null = null;
  let bestRatio = Infinity;
  for (const k in rc.inputs) {
    const r = k as ResourceType;
    const need = invGet(rc.inputs, r);
    const ratio = unreserved(w, r) / need;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestR = r;
    }
  }
  if (bestR && room >= 1) {
    const src = findSource(g, bestR, w.doorX + 0.5, w.doorZ + 0.5, { filter: (b) => reachableB(g, c, b) });
    if (src) {
      const per = invGet(rc.inputs, bestR);
      let n = Math.min(CARRY_CAPACITY, Math.floor(unreserved(src, bestR)), Math.floor(room));
      if (per > 1) n = Math.max(per, Math.floor(n / per) * per);
      n = Math.min(n, Math.floor(unreserved(src, bestR)));
      if (n >= 1) return fetchIntoTask(src, w, bestR, n, `Fetching ${resName(bestR).toLowerCase()}`);
    }
  }
  return outs.length > 0 ? haulOwn(g, c, w, 0, true) : null;
}

/** Quarry / mine: dig inside the site, output into the buffer; haul when it fills. */
export function planExtraction(g: Game, c: Citizen, w: Building): Task | null {
  const cap = BUILDINGS[w.type].bufferCapacity ?? 100;
  const used = bufferUsed(w);
  if (used >= cap * 0.5) {
    const t = haulOwn(g, c, w, 0, true);
    if (t) return t;
  }
  if (used >= cap) return null;
  let px: number;
  let pz: number;
  if (w.type === 'quarry') {
    px = w.x + 1 + g.rng.next() * Math.max(0.5, w.w - 2);
    pz = w.z + 1 + g.rng.next() * Math.max(0.5, w.h - 2);
  } else {
    // just inside the tunnel mouth, one tile in from the door
    const cx = w.x + w.w / 2;
    const cz = w.z + w.h / 2;
    const dx = w.doorX + 0.5 - cx;
    const dz = w.doorZ + 0.5 - cz;
    const d = dm.hypot(dx, dz) || 1;
    px = w.doorX + 0.5 - (dx / d) * 1.4 + (g.rng.next() - 0.5) * 1.2;
    pz = w.doorZ + 0.5 - (dz / d) * 1.4 + (g.rng.next() - 0.5) * 1.2;
  }
  const label = w.type === 'quarry' ? 'Cutting stone' : 'Mining iron';
  return mkTask('work', label, [
    goDoor(w),
    { op: 'direct', x: px, z: pz, inside: w.id },
    { op: 'extract', b: w.id },
    { op: 'direct', x: w.doorX + 0.5, z: w.doorZ + 0.5, inside: w.id },
  ], { job: true });
}
