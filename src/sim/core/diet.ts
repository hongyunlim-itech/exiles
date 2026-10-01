/**
 * Meal composition (variety-maximising) and diet bookkeeping. ARCHITECTURE §3.3 "Food". OWNER: sim-core.
 */
import { MEAL_SIZE } from '../../core/constants';
import { FOOD_GROUP_INDEX, FOOD_TYPES, RESOURCES } from '../../core/defs';
import type { Citizen, Inventory, ResourceType } from '../../core/types';
import { DIET_MEMORY } from './tuning';
import { invAdd, invGet } from './util';

/** Satiation restored per food unit. */
export const SATIATION_PER_UNIT = 100 / MEAL_SIZE;

/** Satiation a rationed meal fills up to (food is short: everybody gets a little rather than a few everything). */
export const RATION_FILL = 60;

/** Food units this citizen needs to eat to be full (whole units, at least 1); smaller meals while rationed. */
export function mealUnits(c: Citizen, rationed = false): number {
  const fill = rationed ? RATION_FILL : 100;
  return Math.max(1, Math.min(MEAL_SIZE, Math.ceil((fill - c.food) / SATIATION_PER_UNIT - 0.25)));
}

/**
 * Pick up to `units` food units from `inv` (minus `reserved`), preferring food groups the citizen has not eaten
 * recently and spreading one meal across groups.
 */
export function chooseMeal(inv: Inventory, reserved: Inventory | null, units: number, c: Citizen): Inventory {
  const picked: Inventory = {};
  const groupCount = [0, 0, 0, 0];
  let left = units;
  let guard = 0;
  while (left > 1e-6 && guard++ < 16) {
    let best: ResourceType | null = null;
    let bestScore = Infinity;
    let bestAvail = 0;
    for (const r of FOOD_TYPES) {
      const avail = invGet(inv, r) - (reserved ? invGet(reserved, r) : 0) - invGet(picked, r);
      if (avail <= 1e-6) continue;
      const gi = FOOD_GROUP_INDEX[RESOURCES[r].foodGroup!];
      const score = c.dietTimers[gi] + groupCount[gi] * 10000 - Math.min(avail, 50) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = r;
        bestAvail = avail;
      }
    }
    if (!best) break;
    const take = Math.min(1, left, bestAvail);
    invAdd(picked, best, take);
    groupCount[FOOD_GROUP_INDEX[RESOURCES[best].foodGroup!]]++;
    left -= take;
  }
  return picked;
}

/** Apply an eaten meal to satiation and diet timers. Returns units eaten. */
export function applyMeal(c: Citizen, meal: Inventory): number {
  let units = 0;
  for (const k in meal) {
    const r = k as ResourceType;
    const n = invGet(meal, r);
    if (n <= 0) continue;
    units += n;
    const grp = RESOURCES[r].foodGroup;
    if (grp) c.dietTimers[FOOD_GROUP_INDEX[grp]] = DIET_MEMORY;
  }
  if (units > 0) {
    c.food = Math.min(100, c.food + units * SATIATION_PER_UNIT);
    let mask = 0;
    for (let k = 0; k < 4; k++) if (c.dietTimers[k] > 0) mask |= 1 << k;
    c.dietMask = mask;
    c.starveTime = 0;
  }
  return units;
}
