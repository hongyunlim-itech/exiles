/**
 * Planners for personal needs and non-work activities: depositing carried goods, eating, warming up, resting
 * when sick, fetching tools & coats, household supply trips, children's play, students' school days, idling,
 * getting unstuck, firefighting. ARCHITECTURE §3.3 / §3.4 / §3.5 "Fire fighting". OWNER: sim-core.
 */
import {
  ADULT_AGE, COLD_TEMP, HOUSE_CAPACITY, HOUSE_FIREWOOD_TARGET, HOUSE_FOOD_TARGET, HUNGER_RATE, WALK_SPEED,
} from '../../../core/constants';
import { BUILDINGS, CLOTHING_TYPES, FOOD_TYPES, RESOURCES } from '../../../core/defs';
import type { Building, Citizen, Inventory, ResourceType } from '../../../core/types';
import type { Game } from '../../game';
import { claimFetch, claimIn, claimOut } from '../claims';
import { chooseMeal, mealUnits } from '../diet';
import { homeWarmth } from '../steps';
import { nearestWalkable, tileOf } from '../movement';
import { findDepositTarget, findFoodSource, findSource, storageFree, unreserved } from '../storage';
import { isBlacklisted, mkTask, type Brain, type Task } from '../tasks';
import { CHILD_HUNGER_FACTOR } from '../citizens';
import {
  EAT_TIME, HOUSEHOLD_CARRY, HOUSE_HERBS_TARGET, HUNGER_TRAVEL_MARGIN, HUNGRY_EARLY, IDLE_MAX, IDLE_MIN, URGENT_FOOD,
} from '../tuning';
import { buildingName, invFood, invGet, invKeys, invTotal, resName } from '../util';
import { goDoor, goTile, isFoodType, randomTileNear, reachable, reachableB } from './common';
import * as dm from '../dmath';

export function homeOf(g: Game, c: Citizen): Building | null {
  if (c.homeId < 0) return null;
  const h = g.buildingById.get(c.homeId);
  return h && h.state === 'active' ? h : null;
}

/** Store whatever the citizen is carrying. */
export function planDeposit(g: Game, c: Citizen, brain: Brain): Task | null {
  const load = c.carrying;
  if (!load || !(load.amount > 0)) {
    c.carrying = null;
    return null;
  }
  const target = findDepositTarget(g, load.type, c.x, c.z, { filter: (b) => reachableB(g, c, b) });
  if (target) {
    brain.failDeposit = 0;
    const n = Math.min(load.amount, Math.max(1, storageFree(target)));
    const t = mkTask('deposit', `Storing ${resName(load.type)} in ${buildingName(target)}`, [
      goDoor(target), { op: 'deposit', b: target.id },
    ]);
    claimIn(t, target, n);
    return t;
  }
  const home = homeOf(g, c);
  // household goods may go home instead — but only into a home with room (a full home would take nothing and the
  // citizen would re-plan the same useless trip every tick) and not one that just refused a delivery
  if (home && (isFoodType(load.type) || load.type === 'firewood' || load.type === 'herbs') &&
    HOUSE_CAPACITY - invTotal(home.inventory) >= 1 && !isBlacklisted(brain, `b${home.id}`, g.state.time.elapsed) &&
    reachableB(g, c, home)) {
    brain.failDeposit = 0;
    return mkTask('deposit', `Bringing ${resName(load.type)} home`, [goDoor(home), { op: 'deposit', b: home.id }]);
  }
  brain.failDeposit++;
  if (brain.failDeposit >= 4) {
    // nowhere to put it: drop the load rather than being stuck forever
    c.carrying = null;
    brain.failDeposit = 0;
  }
  return null;
}

/** Straight-line distance factor for walking routes (paths bend around obstacles). */
const ROUTE_FACTOR = 1.3;

/** Seconds of food left before satiation reaches 0. */
function foodSecondsLeft(c: Citizen): number {
  return c.food / (HUNGER_RATE * (c.age < ADULT_AGE ? CHILD_HUNGER_FACTOR : 1));
}

/** Estimated seconds to walk from the citizen to building b's door and eat there. */
function mealSeconds(c: Citizen, b: Building): number {
  return (dm.hypot(b.doorX + 0.5 - c.x, b.doorZ + 0.5 - c.z) * ROUTE_FACTOR) / WALK_SPEED + EAT_TIME;
}

/** Nearest place this citizen could eat at (home with food, storage/market with food, workplace buffer / ruin). */
function nearestMeal(g: Game, c: Citizen): { b: Building; home: boolean } | null {
  const home = homeOf(g, c);
  const homeOk = !!home && invFood(home.inventory) >= 0.5 && reachableB(g, c, home);
  const src = findFoodSource(g, c.x, c.z, { markets: true, filter: (b) => reachableB(g, c, b) }) ?? findBufferFood(g, c);
  if (homeOk && (!src || mealSeconds(c, home!) <= mealSeconds(c, src))) return { b: home!, home: true };
  return src ? { b: src, home: false } : null;
}

/**
 * Must this citizen stop what they are doing and go eat now? Below URGENT_FOOD always; below HUNGRY_EARLY when the
 * food left barely covers the walk to the nearest meal (plus a margin), so long hauls far from the barn end in time.
 */
export function hungerIsUrgent(g: Game, c: Citizen): boolean {
  if (c.food < URGENT_FOOD) return true;
  if (c.food >= HUNGRY_EARLY) return false;
  if (c.carrying && isFoodType(c.carrying.type)) return false; // can eat from the hands any time
  const m = nearestMeal(g, c);
  if (!m) return false;
  return foodSecondsLeft(c) < mealSeconds(c, m.b) * 1.25 + HUNGER_TRAVEL_MARGIN;
}

/** Eat at home if there is food, else at the nearest storage with food. When hunger is urgent, eat wherever food is
 *  nearest (a barn on the way beats a far-away home). */
export function planEat(g: Game, c: Citizen): Task | null {
  const inHands = !!c.carrying && isFoodType(c.carrying.type);
  const urgent = hungerIsUrgent(g, c);
  // food in the hands (a gatherer's basket, a household fetch) is eaten on the spot when it is urgent
  if (urgent && inHands) return mkTask('eat', 'Eating', [{ op: 'eat', b: -1 }]);
  const home = homeOf(g, c);
  if (home && invFood(home.inventory) >= 0.5 && reachableB(g, c, home)) {
    if (urgent) {
      const m = nearestMeal(g, c);
      if (m && !m.home) {
        const t = eatAt(g, c, m.b);
        if (t) return t;
      }
    }
    return mkTask('eat', 'Eating at home', [goDoor(home), { op: 'eat', b: home.id }]);
  }
  // food in the hands (a gatherer's basket, a household fetch) is eaten on the spot
  if (inHands) return mkTask('eat', 'Eating', [{ op: 'eat', b: -1 }]);
  // while food is rationed, those who produce it eat at their own workplace (the town's food keeps coming in)
  if (g.rt.rationing && c.workplaceId >= 0) {
    const w = g.buildingById.get(c.workplaceId);
    if (w && w.state === 'active' && !BUILDINGS[w.type].storage && !BUILDINGS[w.type].recipes && unreservedFoodIn(w) >= 1 && reachableB(g, c, w)) {
      return eatAt(g, c, w);
    }
  }
  // storage (markets included); when storages are empty, desperate citizens eat from workplace buffers / ruins
  const src = findFoodSource(g, c.x, c.z, { markets: true, filter: (b) => reachableB(g, c, b) }) ?? findBufferFood(g, c);
  if (!src) return null;
  return eatAt(g, c, src);
}

/** Walk to a storage / workplace and eat a meal from its stock (claimed on the way). */
function eatAt(g: Game, c: Citizen, src: Building): Task | null {
  const meal = chooseMeal(src.inventory, src.reservedOut, mealUnits(c, g.rt.rationing), c);
  const t = mkTask('eat', `Eating at the ${buildingName(src)}`, [goDoor(src), { op: 'eat', b: src.id }]);
  for (const r of invKeys(meal)) claimOut(t, src, r, invGet(meal, r));
  if (t.claims.length === 0) return null;
  return t;
}

/** Nearest active workplace (gatherer hut, field, dock...) buffer or ruin (salvage) holding food. */
function findBufferFood(g: Game, c: Citizen, x = c.x, z = c.z, min = 1): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  const consider = (b: Building): void => {
    let food = 0;
    for (const r of FOOD_TYPES) food += unreserved(b, r);
    if (food < min) return;
    const d = dm.hypot(b.doorX - x, b.doorZ - z);
    if (d < bestD && reachableB(g, c, b)) {
      best = b;
      bestD = d;
    }
  };
  for (const b of g.rt.workplaces(g.state)) {
    if (b.state !== 'active' || BUILDINGS[b.type].storage || BUILDINGS[b.type].recipes) continue;
    consider(b);
  }
  for (const b of g.rt.sites(g.state)) if (b.state === 'ruin') consider(b);
  return best;
}

/** Is there any food this citizen could eat (home, storage or a workplace buffer)? Cached per second. */
export function foodAvailableFor(g: Game, c: Citizen): boolean {
  const home = homeOf(g, c);
  if (home && invFood(home.inventory) >= 0.5) return true;
  return g.rt.foodAvailable;
}

/** Would going home warm this citizen up? (A heated home does; a cold hearth only in mild cold, a little.) */
export function canWarmAtHome(g: Game, c: Citizen): boolean {
  const home = homeOf(g, c);
  return !!home && homeWarmth(g, home).target > c.warmth + 5 && reachableB(g, c, home);
}

export function planWarm(g: Game, c: Citizen): Task | null {
  // a cold (unheated) home that cannot warm them further is no use
  if (!canWarmAtHome(g, c)) return null;
  const home = homeOf(g, c)!;
  return mkTask('warm', 'Warming up at home', [goDoor(home), { op: 'warm', b: home.id }]);
}

export function planRest(g: Game, c: Citizen): Task {
  const home = homeOf(g, c);
  if (home && reachableB(g, c, home)) {
    return mkTask('rest', 'Resting at home (sick)', [goDoor(home), { op: 'rest', t: 20, b: home.id }]);
  }
  return mkTask('rest', 'Resting (sick)', [{ op: 'rest', t: 10, b: -1 }]);
}

/** Pick up a tool or a coat from storage. */
export function planEquip(g: Game, c: Citizen, kind: 'tool' | 'coat'): Task | null {
  const types: ResourceType[] = kind === 'tool' ? ['tool'] : CLOTHING_TYPES;
  let best: Building | null = null;
  let bestR: ResourceType = types[0];
  let bestD = Infinity;
  for (const r of types) {
    const src = findSource(g, r, c.x, c.z, { markets: true, filter: (b) => reachableB(g, c, b) });
    if (!src) continue;
    const d = dm.hypot(src.doorX - c.x, src.doorZ - c.z);
    if (d < bestD) {
      best = src;
      bestR = r;
      bestD = d;
    }
  }
  if (!best) return null;
  const t = mkTask('equip', kind === 'tool' ? 'Fetching a new tool' : 'Fetching a warm coat', [
    goDoor(best), { op: 'pickup', b: best.id }, { op: 'equip' },
  ]);
  claimOut(t, best, bestR, 1);
  return t;
}

/** Market covering a house (within its work radius) with an active vendor, or null. */
function marketFor(g: Game, home: Building): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  const hx = home.x + home.w / 2;
  const hz = home.z + home.h / 2;
  for (const m of g.rt.ofType(g.state, 'market')) {
    if (m.state !== 'active') continue;
    const d = dm.hypot(m.x + m.w / 2 - hx, m.z + m.h / 2 - hz);
    if (d <= (BUILDINGS.market.workRadius ?? 26) && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

function coldSeason(g: Game): boolean {
  const s = g.state;
  return s.time.month >= 6 || s.time.month <= 1 || s.weather.temperature < COLD_TEMP + 2;
}

/**
 * Household supply: one adult per house fetches food (mixed types for variety), firewood or herbs from the
 * market covering the house, else the nearest storage.
 */
export function planSupply(g: Game, c: Citizen): Task | null {
  const home = homeOf(g, c);
  if (!home || !BUILDINGS[home.type].housing) return null;
  const fetcher = g.rt.houseFetcher.get(home.id);
  if (fetcher !== undefined && fetcher !== c.id) return null;
  const inv = home.inventory;
  const food = invFood(inv);
  const fw = invGet(inv, 'firewood');
  const herbs = invGet(inv, 'herbs');
  const residents = Math.max(1, home.residentIds.length);
  const foodTarget = Math.min(HOUSE_FOOD_TARGET, 10 + residents * 6);
  const needFood = food < foodTarget * 0.5;
  const needWood = fw < HOUSE_FIREWOOD_TARGET * (coldSeason(g) ? 0.6 : 0.3);
  const needHerbs = herbs < 2;
  if (!needFood && !needWood && !needHerbs) return null;
  if (!reachableB(g, c, home)) return null;
  const market = marketFor(g, home);
  const order: ('food' | 'wood' | 'herbs')[] = [];
  if (needWood && coldSeason(g) && fw < HOUSE_FIREWOOD_TARGET * 0.3) order.push('wood');
  if (needFood) order.push('food');
  if (needWood && !order.includes('wood')) order.push('wood');
  if (needHerbs) order.push('herbs');
  for (const what of order) {
    const t = what === 'food'
      ? supplyFood(g, c, home, market, foodTarget - food, herbs < HOUSE_HERBS_TARGET ? HOUSE_HERBS_TARGET - herbs : 0)
      : what === 'wood'
        ? supplySimple(g, c, home, market, 'firewood', HOUSE_FIREWOOD_TARGET - fw)
        : supplySimple(g, c, home, market, 'herbs', HOUSE_HERBS_TARGET - herbs);
    if (t) return t;
  }
  return null;
}

function supplySource(g: Game, c: Citizen, market: Building | null, test: (b: Building) => boolean): Building | null {
  if (market && test(market) && reachableB(g, c, market)) return market;
  return null;
}

function supplyFood(g: Game, c: Citizen, home: Building, market: Building | null, deficit: number, herbDeficit: number): Task | null {
  let src = supplySource(g, c, market, (m) => unreservedFoodIn(m) >= 3);
  if (!src) src = findFoodSource(g, home.doorX, home.doorZ, { markets: true, min: 3, filter: (b) => reachableB(g, c, b) });
  // no food in any storage (no barn, or it burnt down): take it straight from the gatherers / fields / salvage
  if (!src) src = findBufferFood(g, c, home.doorX, home.doorZ, 3);
  if (!src) return null;
  const want = Math.max(4, Math.min(HOUSEHOLD_CARRY, Math.ceil(deficit)));
  // variety: favour types the household has least of, up to 3 types
  const avail: { r: ResourceType; n: number; home: number }[] = [];
  for (const r of FOOD_TYPES) {
    const n = Math.floor(unreserved(src, r));
    if (n >= 1) avail.push({ r, n, home: invGet(home.inventory, r) });
  }
  if (avail.length === 0) return null;
  avail.sort((a, b) => a.home - b.home || b.n - a.n);
  const picks: Inventory = {};
  // prefer distinct food groups first
  const groups = new Set<string>();
  const chosen: typeof avail = [];
  for (const a of avail) {
    const grp = RESOURCES[a.r].foodGroup!;
    if (groups.has(grp)) continue;
    groups.add(grp);
    chosen.push(a);
    if (chosen.length >= 3) break;
  }
  for (const a of avail) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(a)) chosen.push(a);
  }
  let left = want;
  for (let k = 0; k < chosen.length && left > 0; k++) {
    const share = Math.ceil(left / (chosen.length - k));
    const n = Math.min(share, chosen[k].n);
    if (n > 0) {
      picks[chosen[k].r] = n;
      left -= n;
    }
  }
  const t = mkTask('supply', `Fetching food for home from the ${buildingName(src)}`, [
    goDoor(src), { op: 'pickup', b: src.id }, goDoor(home), { op: 'deposit', b: home.id },
  ]);
  if (!claimFetch(g, t, c, home)) return null;
  for (const r of invKeys(picks)) claimOut(t, src, r, invGet(picks, r));
  if (herbDeficit >= 1) {
    const h = Math.min(Math.floor(unreserved(src, 'herbs')), Math.ceil(herbDeficit));
    if (h >= 1) claimOut(t, src, 'herbs', h);
  }
  return t;
}

function unreservedFoodIn(b: Building): number {
  let n = 0;
  for (const r of FOOD_TYPES) n += unreserved(b, r);
  return n;
}

function supplySimple(g: Game, c: Citizen, home: Building, market: Building | null, r: ResourceType, deficit: number): Task | null {
  if (deficit < 1) return null;
  let src = supplySource(g, c, market, (m) => unreserved(m, r) >= 1);
  if (!src) src = findSource(g, r, home.doorX, home.doorZ, { markets: true, filter: (b) => reachableB(g, c, b) });
  if (!src) return null;
  const n = Math.min(Math.floor(unreserved(src, r)), Math.ceil(deficit), HOUSEHOLD_CARRY);
  if (n < 1) return null;
  const t = mkTask('supply', `Fetching ${resName(r).toLowerCase()} for home`, [
    goDoor(src), { op: 'pickup', b: src.id }, goDoor(home), { op: 'deposit', b: home.id },
  ]);
  if (!claimFetch(g, t, c, home)) return null;
  claimOut(t, src, r, n);
  return t;
}

/** Loiter near a point (idle laborers near storage, workers near their workplace). */
export function planIdle(g: Game, c: Citizen, near?: Building | null): Task {
  const s = g.state;
  let anchor: Building | null = near ?? null;
  if (!anchor) {
    let bestD = Infinity;
    for (const b of g.rt.storages(s)) {
      if (b.state !== 'active') continue;
      const d = dm.hypot(b.doorX - c.x, b.doorZ - c.z);
      if (d < bestD && reachableB(g, c, b)) {
        bestD = d;
        anchor = b;
      }
    }
  }
  const wait = g.rng.range(IDLE_MIN, IDLE_MAX);
  if (anchor) {
    const i = randomTileNear(g, c, anchor.doorX + 0.5, anchor.doorZ + 0.5, 4, 6);
    if (i >= 0) return mkTask('idle', 'Idle', [goTile(g, i), { op: 'wait', t: wait, act: 'idle' }]);
  }
  return mkTask('idle', 'Idle', [{ op: 'wait', t: wait, act: 'idle' }]);
}

/** Children play near home (or near their parents / storage when homeless). */
export function planPlay(g: Game, c: Citizen): Task {
  const home = homeOf(g, c);
  let ax = c.x;
  let az = c.z;
  if (home) {
    ax = home.doorX + 0.5;
    az = home.doorZ + 0.5;
  } else {
    const parent = g.citizenById.get(c.motherId) ?? g.citizenById.get(c.fatherId);
    if (parent) {
      ax = parent.x;
      az = parent.z;
    }
  }
  const wait = g.rng.range(3, 7);
  const i = randomTileNear(g, c, ax, az, 5, 6);
  if (i >= 0) return mkTask('play', 'Playing', [goTile(g, i), { op: 'wait', t: wait, act: 'playing' }]);
  return mkTask('play', 'Playing', [{ op: 'wait', t: wait, act: 'playing' }]);
}

export function planStudy(g: Game, c: Citizen, brain: Brain): Task | null {
  const day = g.state.time.dayTime;
  if (day < 0.26 || day > 0.72) return null;
  const school = brain.school >= 0 ? g.buildingById.get(brain.school) : undefined;
  if (!school || school.state !== 'active' || school.workerIds.length === 0) return null;
  if (!reachableB(g, c, school)) return null;
  return mkTask('study', 'Studying at school', [goDoor(school), { op: 'study', b: school.id, t: 40 }]);
}

/** Walk off a blocked tile (building placed on top, bridge removed, left inside a quarry...). */
export function planExit(g: Game, c: Citizen): Task {
  const s = g.state;
  const [tx, tz] = tileOf(g, c);
  const bid = s.tiles.building[tz * s.W + tx];
  const b = bid >= 0 ? g.buildingById.get(bid) : undefined;
  if (b && g.isWalkableXZ(b.doorX, b.doorZ)) {
    return mkTask('exit', 'Leaving the building', [{ op: 'direct', x: b.doorX + 0.5, z: b.doorZ + 0.5, inside: b.id }]);
  }
  let i = nearestWalkable(g, tx, tz, 8, c.x, c.z);
  if (i < 0) i = nearestWalkable(g, tx, tz, 40, c.x, c.z);
  if (i < 0) return mkTask('exit', 'Stuck', [{ op: 'wait', t: 2, act: 'idle' }]);
  const x = (i % s.W) + 0.5;
  const z = Math.floor(i / s.W) + 0.5;
  if (dm.hypot(x - c.x, z - c.z) > 10) {
    // far away (e.g. stranded in water): teleport as a last resort
    c.x = x;
    c.z = z;
    return mkTask('exit', 'Idle', [{ op: 'wait', t: 0.5, act: 'idle' }]);
  }
  return mkTask('exit', 'Finding solid ground', [{ op: 'direct', x, z, inside: bid >= 0 ? bid : undefined }]);
}

export function fightTask(g: Game, c: Citizen, b: Building): Task {
  // spread firefighters around the footprint
  const x = b.x + Math.floor(g.rng.next() * b.w);
  const z = b.z + Math.floor(g.rng.next() * b.h);
  void c;
  return mkTask('fight', `Fighting the fire at the ${buildingName(b)}`, [
    { op: 'go', x, z, b: b.id }, { op: 'fight', b: b.id },
  ]);
}
