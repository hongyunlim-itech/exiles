/**
 * Step handlers of the task engine. Each handler validates its target every tick (buildings may burn down, trees
 * may be taken, deer may vanish) and returns RUN / DONE / FAIL. A FAIL aborts the task and releases every claim.
 * OWNER: sim-core.
 */
import {
  CARRY_CAPACITY, COAT_LIFETIME, HOUSE_CAPACITY, LOGS_PER_TREE, TOOL_LIFETIME, WORK_TIME_CHOP, WORK_TIME_MINE_ROCK,
} from '../../core/constants';
import { BUILDINGS, CROPS, LIVESTOCK, ORCHARDS, RESOURCES } from '../../core/defs';
import type { Building, Citizen, Inventory, ResourceType } from '../../core/types';
import { Feature, Road, Terrain } from '../../core/types';
import { isLandTerrain, isWaterTerrain } from '../../core/world';
import type { Game } from '../game';
import { completeConstruction, finishDemolition, recordProduction } from './buildings';
import { coldHomeLevel, HEARTH_TARGET, homeHeated } from './citizens';
import { dropClaim, releaseClaim, releaseKind } from './claims';
import { applyMeal, chooseMeal, mealUnits } from './diet';
import { CROP_MIN_TEMP, PLANT_MONTHS, PRODUCT_BATCH, pastureWantsSlaughter } from './farming';
import { faceTowards, followPath, moveDirect, tileOf } from './movement';
import { storageAccepts, storageCapacity, storageUsed } from './storage';
import type { Step, Task } from './tasks';
import {
  BUILD_SLICE, CATTLE_SLAUGHTER_LEATHER, CHOP_ACCIDENT_CHANCE, DEMOLISH_SLICE, EAT_TIME, EXTRACT_TIME, FIELD_HARVEST_TIME,
  FIELD_PLANT_TIME, FISH_TIME, GATHER_TIME, GATHER_YIELD, HERB_YIELD, HERD_TIME, HUNT_TIME, LEATHER_YIELD, MAX_WALK_TIME,
  MINE_ACCIDENT_CHANCE, MINE_IRON, MINE_STONE, PLANT_TREE_TIME, QUARRY_IRON_CHANCE, QUARRY_STONE, VENISON_YIELD, WARM_MAX_TIME,
  FISH_YIELD,
} from './tuning';
import { clamp, deliveredFraction, distToFootprint, invAdd, invGet, invKeys, invTake, invTotal, totalBuildWork } from './util';
import { addCarried, carriedItems, efficiency, setCarried } from './work/common';
import * as dm from './dmath';

export const RUN = 0;
export const DONE = 1;
export const FAIL = 2;
/** The citizen died during the step (task already cleaned up). */
export const DEAD = 3;
export type StepResult = 0 | 1 | 2 | 3;

/** Max time a step may take before the watchdog aborts the task. */
export function stepTimeout(st: Step): number {
  switch (st.op) {
    case 'go':
    case 'direct':
      return MAX_WALK_TIME;
    case 'wait':
    case 'serve':
    case 'study':
    case 'rest':
      return st.t + 10;
    case 'fight':
      return 95;
    case 'extract':
      return EXTRACT_TIME * 8;
    case 'craft':
      return 200;
    default:
      return 70;
  }
}

/** Periodic sound helper: true once every `period` seconds of step time. */
function every(t: Task, dt: number, period: number): boolean {
  return Math.floor((t.tm - dt) / period) !== Math.floor(t.tm / period);
}

function alive(g: Game, id: number): Building | null {
  return g.buildingById.get(id) ?? null;
}

export function runStep(g: Game, c: Citizen, t: Task, st: Step, dt: number): StepResult {
  switch (st.op) {
    case 'go': return stepGo(g, c, st, dt);
    case 'direct': return stepDirect(g, c, t, st, dt);
    case 'wait': {
      if (st.b !== undefined && !alive(g, st.b)) return FAIL;
      c.activity = st.act;
      c.moving = false;
      return t.tm >= st.t ? DONE : RUN;
    }
    case 'pickup': return stepPickup(g, c, t, st.b);
    case 'deposit': return stepDeposit(g, c, t, st.b);
    case 'chop': return stepChop(g, c, t, st, dt);
    case 'mineRock': return stepMineRock(g, c, t, st, dt);
    case 'build': return stepBuild(g, c, t, st.b, dt);
    case 'demolish': return stepDemolish(g, c, t, st.b, dt);
    case 'eat': return stepEat(g, c, t, st.b);
    case 'warm': return stepWarm(g, c, t, st.b);
    case 'rest': {
      if (st.b >= 0 && !alive(g, st.b)) return FAIL;
      c.activity = 'sick';
      c.moving = false;
      return t.tm >= st.t || c.sick <= 0.02 ? DONE : RUN;
    }
    case 'craft': return stepCraft(g, c, t, st, dt);
    case 'gather': return stepGather(g, c, t, st);
    case 'hunt': return stepHunt(g, c, t, st);
    case 'fish': return stepFish(g, c, t, st.b, dt);
    case 'plant': return stepPlant(g, c, t, st);
    case 'field': return stepField(g, c, t, st);
    case 'herd': return stepHerd(g, c, t, st);
    case 'extract': return stepExtract(g, c, t, st.b, dt);
    case 'serve': {
      const b = alive(g, st.b);
      if (!b || b.state !== 'active') return FAIL;
      c.activity = st.act;
      c.moving = false;
      return t.tm >= st.t ? DONE : RUN;
    }
    case 'study': {
      const b = alive(g, st.b);
      if (!b || b.state !== 'active' || b.workerIds.length === 0) return FAIL;
      c.activity = 'studying';
      c.moving = false;
      const day = g.state.time.dayTime;
      return t.tm >= st.t || day < 0.24 || day > 0.78 ? DONE : RUN;
    }
    case 'fight': return stepFight(g, c, t, st.b);
    case 'equip': {
      if (c.carrying?.type === 'tool') c.toolWear = TOOL_LIFETIME;
      else if (c.carrying && (c.carrying.type === 'woolCoat' || c.carrying.type === 'leatherCoat')) c.coatWear = COAT_LIFETIME;
      else return FAIL;
      c.carrying.amount -= 1;
      if (c.carrying.amount <= 1e-6) c.carrying = null;
      return DONE;
    }
  }
  return FAIL;
}

// ---------------------------------------------------------------------------------------------
// movement
// ---------------------------------------------------------------------------------------------

function stepGo(g: Game, c: Citizen, st: Extract<Step, { op: 'go' }>, dt: number): StepResult {
  if (st.b !== undefined && !alive(g, st.b)) return FAIL;
  c.activity = c.carrying ? 'hauling' : 'walking';
  if (!c.path) {
    const [cx, cz] = tileOf(g, c);
    if (cx === st.x && cz === st.z) {
      c.moving = false;
      return DONE;
    }
    if (Math.abs(cx - st.x) <= 1 && Math.abs(cz - st.z) <= 1 && !g.isWalkableXZ(st.x, st.z)) {
      c.moving = false;
      return DONE;
    }
    if (g.rt.pathBudget <= 0) {
      c.moving = false;
      return RUN;
    }
    st.tries = (st.tries ?? 0) + 1;
    if (st.tries > 5) return FAIL;
    g.rt.pathBudget--;
    const p = g.findPathSafe(cx, cz, st.x, st.z);
    if (p === null) return FAIL;
    if (p.length === 0) {
      c.moving = false;
      return DONE;
    }
    c.path = p;
    c.pathIndex = 0;
  }
  const r = followPath(g, c, dt);
  if (r === 'arrived') return DONE;
  if (r === 'blocked') {
    c.path = null;
    c.pathIndex = 0;
  }
  return RUN;
}

function stepDirect(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'direct' }>, dt: number): StepResult {
  if (st.inside !== undefined && st.inside >= 0) {
    if (!alive(g, st.inside)) {
      t.inside = -1;
    } else t.inside = st.inside;
  }
  c.activity = c.carrying ? 'hauling' : 'walking';
  if (!moveDirect(g, c, st.x, st.z, dt)) return RUN;
  const W = g.state.W;
  const i = Math.floor(st.z) * W + Math.floor(st.x);
  if (i >= 0 && i < W * g.state.H && g.isWalkableTile(i)) t.inside = -1;
  return DONE;
}

// ---------------------------------------------------------------------------------------------
// goods
// ---------------------------------------------------------------------------------------------

function stepPickup(g: Game, c: Citizen, t: Task, bid: number): StepResult {
  const b = alive(g, bid);
  if (!b) return FAIL;
  let got = 0;
  for (const cl of [...t.claims]) {
    if (cl.k !== 'out' || cl.b !== bid) continue;
    const n = Math.min(cl.n, invGet(b.inventory, cl.r));
    releaseClaim(g, c.id, cl);
    dropClaim(t, cl);
    if (n > 0) {
      invTake(b.inventory, cl.r, n);
      addCarried(c, t, cl.r, n);
      got += n;
    }
  }
  c.activity = 'hauling';
  return got > 0 ? DONE : FAIL;
}

function stepDeposit(g: Game, c: Citizen, t: Task, bid: number): StepResult {
  const b = alive(g, bid);
  if (!b) return FAIL;
  const def = BUILDINGS[b.type];
  const items = carriedItems(c, t);
  const left: Inventory = {};
  if (b.state === 'construction' || b.state === 'clearing') {
    releaseKind(g, c, t, 'inc', bid);
    for (const r of invKeys(items)) {
      const n = invGet(items, r);
      const need = Math.max(0, invGet(b.cost, r) - invGet(b.delivered, r));
      const put = Math.min(n, need);
      if (put > 0) invAdd(b.delivered, r, put);
      if (n - put > 1e-6) left[r] = n - put;
    }
  } else if (b.state !== 'active') {
    return FAIL;
  } else if (def.storage) {
    releaseKind(g, c, t, 'in', bid);
    let free = Math.max(0, storageCapacity(b) - storageUsed(b) - b.reservedIn);
    for (const r of invKeys(items)) {
      const n = invGet(items, r);
      const put = storageAccepts(b, r) ? Math.min(n, free) : 0;
      if (put > 0) {
        invAdd(b.inventory, r, put);
        free -= put;
      }
      if (n - put > 1e-6) left[r] = n - put;
    }
  } else if (def.housing) {
    releaseKind(g, c, t, 'fetch', bid);
    let free = Math.max(0, HOUSE_CAPACITY - invTotal(b.inventory));
    let stored = 0;
    for (const r of invKeys(items)) {
      const n = invGet(items, r);
      const put = Math.min(n, free);
      if (put > 0) {
        invAdd(b.inventory, r, put);
        free -= put;
        stored += put;
      }
      if (n - put > 1e-6) left[r] = n - put;
    }
    // a full home took nothing: fail (blacklists the home) so the load goes elsewhere instead of looping here
    if (stored <= 1e-6 && invTotal(items) > 1e-6) return FAIL;
  } else {
    // workplace buffer / service stock (hospital herbs, tavern ale, workshop inputs)
    releaseKind(g, c, t, 'in', bid);
    const cap = Math.max(def.bufferCapacity ?? 60, 40) * 2;
    let free = Math.max(0, cap - invTotal(b.inventory));
    for (const r of invKeys(items)) {
      const n = invGet(items, r);
      const put = Math.min(n, free);
      if (put > 0) {
        invAdd(b.inventory, r, put);
        free -= put;
      }
      if (n - put > 1e-6) left[r] = n - put;
    }
  }
  setCarried(c, t, left);
  c.activity = 'hauling';
  return DONE;
}

// ---------------------------------------------------------------------------------------------
// clearing & gathering from the land
// ---------------------------------------------------------------------------------------------

function tileCenter(g: Game, i: number): [number, number] {
  const W = g.state.W;
  return [(i % W) + 0.5, Math.floor(i / W) + 0.5];
}

function stepChop(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'chop' }>, dt: number): StepResult {
  const s = g.state;
  const tl = s.tiles;
  const i = st.i;
  if (tl.feature[i] !== Feature.Tree) return FAIL;
  if (g.rt.tileClaim[i] !== c.id) return FAIL;
  if (t.kind === 'clear' && !tl.marked[i]) return FAIL;
  const [x, z] = tileCenter(g, i);
  faceTowards(c, x, z);
  c.activity = 'chopping';
  c.moving = false;
  if (every(t, dt, 1.6)) g.sound('chop', x, z);
  const growth = clamp(tl.featureAmount[i], 0, 1);
  const need = (WORK_TIME_CHOP * (0.35 + 0.65 * growth)) / efficiency(g, c);
  if (t.tm < need) return RUN;
  const logs = growth >= 0.25 ? Math.max(1, Math.round(LOGS_PER_TREE * growth)) : 0;
  g.removeFeature(i);
  releaseKind(g, c, t, 'tile');
  if (logs > 0) {
    addCarried(c, t, 'log', logs);
    if (st.b !== undefined) {
      const b = alive(g, st.b);
      if (b) recordProduction(b, 'log', logs);
    }
  }
  if (g.rng.chance(CHOP_ACCIDENT_CHANCE) && c.age >= 10) {
    g.addMessage(`${c.name} was crushed by a falling tree.`, 'danger', { kind: 'tile', id: i });
    g.killCitizen(c.id, 'accident');
    return DEAD;
  }
  return DONE;
}

function stepMineRock(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'mineRock' }>, dt: number): StepResult {
  const s = g.state;
  const tl = s.tiles;
  const i = st.i;
  const f = tl.feature[i];
  if (f !== Feature.Rock && f !== Feature.Iron) return FAIL;
  if (g.rt.tileClaim[i] !== c.id) return FAIL;
  if (!tl.marked[i]) return FAIL;
  const [x, z] = tileCenter(g, i);
  faceTowards(c, x, z);
  c.activity = 'mining';
  c.moving = false;
  if (every(t, dt, 1.5)) g.sound('dig', x, z);
  if (t.tm < WORK_TIME_MINE_ROCK / efficiency(g, c)) return RUN;
  const amount = tl.featureAmount[i];
  const take = Math.min(CARRY_CAPACITY, Math.max(0, Math.floor(amount + 1e-6)));
  const res: ResourceType = f === Feature.Rock ? 'stone' : 'iron';
  if (amount - take < 0.5) g.removeFeature(i);
  else {
    tl.featureAmount[i] = amount - take;
    g.bumpFeatures();
  }
  releaseKind(g, c, t, 'tile');
  if (take > 0) addCarried(c, t, res, take);
  return DONE;
}

// ---------------------------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------------------------

function stepBuild(g: Game, c: Citizen, t: Task, bid: number, dt: number): StepResult {
  const b = alive(g, bid);
  if (!b) return FAIL;
  if (b.state === 'active') return DONE;
  if (b.state !== 'construction') return FAIL;
  if (b.paused) return DONE;
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  faceTowards(c, cx, cz);
  c.activity = 'building';
  c.moving = false;
  const total = totalBuildWork(b);
  const frac = deliveredFraction(b);
  const minRemaining = total * (1 - frac);
  if (b.workRemaining <= minRemaining + 1e-6) {
    if (frac >= 1 && b.workRemaining <= 1e-6) {
      completeConstruction(g, b);
      return DONE;
    }
    return DONE; // waiting for materials
  }
  if (every(t, dt, 1.25)) g.sound('hammer', cx, cz);
  b.workRemaining = Math.max(minRemaining, b.workRemaining - efficiency(g, c) * dt);
  b.progress = total > 0 ? clamp(1 - b.workRemaining / total, 0, 1) : frac;
  if (b.workRemaining <= 1e-6 && frac >= 1) {
    completeConstruction(g, b);
    return DONE;
  }
  return t.tm > BUILD_SLICE ? DONE : RUN;
}

function stepDemolish(g: Game, c: Citizen, t: Task, bid: number, dt: number): StepResult {
  const b = alive(g, bid);
  if (!b) return DONE;
  if (b.state !== 'demolishing' && b.state !== 'ruin') return FAIL;
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  faceTowards(c, cx, cz);
  c.activity = 'building';
  c.moving = false;
  if (every(t, dt, 1.4)) g.sound('hammer', cx, cz);
  const total = Math.max(6, totalBuildWork(b) * (b.state === 'ruin' ? 0.2 : 0.35));
  b.workRemaining -= efficiency(g, c) * dt;
  b.progress = clamp(1 - b.workRemaining / total, 0, 1);
  if (b.workRemaining <= 0) {
    finishDemolition(g, b);
    return DONE;
  }
  return t.tm > DEMOLISH_SLICE ? DONE : RUN;
}

// ---------------------------------------------------------------------------------------------
// needs
// ---------------------------------------------------------------------------------------------

function stepEat(g: Game, c: Citizen, t: Task, bid: number): StepResult {
  if (bid < 0) return eatFromHands(g, c, t);
  const b = alive(g, bid);
  if (!b) return FAIL;
  c.activity = 'eating';
  c.moving = false;
  if (t.tm < EAT_TIME) return RUN;
  const meal: Inventory = {};
  let claimed = false;
  for (const cl of [...t.claims]) {
    if (cl.k !== 'out' || cl.b !== bid) continue;
    claimed = true;
    const n = Math.min(cl.n, invGet(b.inventory, cl.r));
    releaseClaim(g, c.id, cl);
    dropClaim(t, cl);
    if (n > 0) invAdd(meal, cl.r, invTake(b.inventory, cl.r, n));
  }
  if (!claimed || invTotal(meal) < 1e-6) {
    // eat what is there (home, or claimed stock already gone)
    const pick = chooseMeal(b.inventory, b.reservedOut, mealUnits(c, g.rt.rationing) - invTotal(meal), c);
    for (const r of invKeys(pick)) invAdd(meal, r, invTake(b.inventory, r, invGet(pick, r)));
  }
  const eaten = applyMeal(c, meal);
  return eaten > 0 ? DONE : FAIL;
}

/** The citizen eats (part of) the food in their hands, on the spot. */
function eatFromHands(g: Game, c: Citizen, t: Task): StepResult {
  c.activity = 'eating';
  c.moving = false;
  if (t.tm < EAT_TIME) return RUN;
  const load = c.carrying;
  if (!load || !(load.amount > 0) || RESOURCES[load.type].category !== 'food') return FAIL;
  const n = Math.min(load.amount, mealUnits(c, g.rt.rationing));
  const eaten = applyMeal(c, { [load.type]: n });
  load.amount -= n;
  if (load.amount <= 1e-6) c.carrying = null;
  return eaten > 0 ? DONE : FAIL;
}

function stepWarm(g: Game, c: Citizen, t: Task, bid: number): StepResult {
  const b = alive(g, bid);
  if (!b || b.state !== 'active') return FAIL;
  c.activity = 'warming';
  c.moving = false;
  // the warming itself happens in the lifecycle update (see citizens.ts): wait until warm enough
  const { target } = homeWarmth(g, b);
  if (c.warmth >= target - 0.5 || t.tm > WARM_MAX_TIME) return DONE;
  return RUN;
}

/**
 * How warm a home keeps its residents: a fire makes it cosy; a cold hearth only shelters from the wind (see
 * coldHomeLevel — nothing at all below about -3 C).
 */
export function homeWarmth(g: Game, b: Building): { target: number } {
  if (homeHeated(b)) return { target: HEARTH_TARGET };
  return { target: coldHomeLevel(g.state.weather.temperature) };
}

function stepFight(g: Game, c: Citizen, t: Task, bid: number): StepResult {
  const b = alive(g, bid);
  if (!b || b.fire <= 0 || b.state === 'ruin') return DONE;
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  faceTowards(c, cx, cz);
  c.activity = 'firefighting';
  c.moving = false;
  if (distToFootprint(b, c.x, c.z) <= 2.6) b.fireFighters++;
  return t.tm > 90 ? DONE : RUN;
}

// ---------------------------------------------------------------------------------------------
// professions
// ---------------------------------------------------------------------------------------------

function stepCraft(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'craft' }>, dt: number): StepResult {
  const b = alive(g, st.b);
  if (!b || b.state !== 'active' || b.paused) return FAIL;
  const recipe = BUILDINGS[b.type].recipes?.[st.r];
  if (!recipe) return FAIL;
  c.activity = 'working';
  c.moving = false;
  b.smoking = true;
  if (b.type === 'blacksmith' && every(t, dt, 1.8)) g.sound('hammer', b.doorX + 0.5, b.doorZ + 0.5);
  if (b.type === 'woodcutter' && every(t, dt, 1.6)) g.sound('chop', b.doorX + 0.5, b.doorZ + 0.5);
  if (t.tm < recipe.seconds / efficiency(g, c)) return RUN;
  // consume claimed inputs
  for (const k in recipe.inputs) {
    const r = k as ResourceType;
    if (invGet(b.inventory, r) + 1e-6 < invGet(recipe.inputs, r)) return FAIL;
  }
  for (const cl of [...t.claims]) {
    if (cl.k !== 'out' || cl.b !== b.id) continue;
    releaseClaim(g, c.id, cl);
    dropClaim(t, cl);
  }
  for (const k in recipe.inputs) invTake(b.inventory, k as ResourceType, invGet(recipe.inputs, k as ResourceType));
  for (const k in recipe.outputs) {
    const r = k as ResourceType;
    const n = invGet(recipe.outputs, r);
    invAdd(b.inventory, r, n);
    recordProduction(b, r, n);
  }
  return DONE;
}

function stepGather(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'gather' }>): StepResult {
  const b = alive(g, st.b);
  if (!b || b.state !== 'active') return FAIL;
  c.activity = 'gathering';
  c.moving = false;
  if (t.tm < GATHER_TIME) return RUN;
  const density = clamp(g.countTrees(c.x, c.z, 4) / 14, 0.4, 1.2);
  const eff = efficiency(g, c);
  let r: ResourceType;
  let n: number;
  if (st.herbs) {
    r = 'herbs';
    n = Math.max(1, Math.round(HERB_YIELD * eff * density));
  } else {
    const roll = g.rng.next();
    r = roll < 0.4 ? 'berries' : roll < 0.7 ? 'mushrooms' : 'roots';
    n = Math.max(1, Math.round(GATHER_YIELD * eff * density));
  }
  addCarried(c, t, r, n);
  recordProduction(b, r, n);
  return DONE;
}

function stepHunt(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'hunt' }>): StepResult {
  const a = g.findAnimal(st.a);
  if (!a || a.huntedBy !== c.id) return FAIL;
  if (dm.hypot(a.x - c.x, a.z - c.z) > 4) return FAIL;
  faceTowards(c, a.x, a.z);
  c.activity = 'hunting';
  c.moving = false;
  if (t.tm < HUNT_TIME) return RUN;
  g.removeAnimalSafe(a.id);
  releaseKind(g, c, t, 'deer');
  const meat = Math.max(4, Math.round(VENISON_YIELD * clamp(0.75 + 0.25 * efficiency(g, c), 0.6, 1.2)));
  addCarried(c, t, 'venison', meat);
  t.extra = { leather: LEATHER_YIELD };
  const b = alive(g, st.b);
  if (b) {
    recordProduction(b, 'venison', meat);
    recordProduction(b, 'leather', LEATHER_YIELD);
  }
  return DONE;
}

function stepFish(g: Game, c: Citizen, t: Task, bid: number, dt: number): StepResult {
  const b = alive(g, bid);
  if (!b || b.state !== 'active') return FAIL;
  c.activity = 'fishing';
  c.moving = false;
  const s = g.state;
  if (t.tm <= dt) {
    // face the water
    const [tx, tz] = tileOf(g, c);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = tx + dx;
      const z = tz + dz;
      if (x >= 0 && z >= 0 && x < s.W && z < s.H && isWaterTerrain(s.tiles.terrain[z * s.W + x])) {
        faceTowards(c, x + 0.5, z + 0.5);
        break;
      }
    }
  }
  if (every(t, dt, 4.5)) g.sound('splash', c.x, c.z);
  if (t.tm < FISH_TIME) return RUN;
  const water = countWater(g, Math.floor(c.x), Math.floor(c.z), 3);
  const density = clamp(water / 14, 0.3, 1.2);
  const n = Math.max(1, Math.round(FISH_YIELD * efficiency(g, c) * density));
  addCarried(c, t, 'fish', n);
  recordProduction(b, 'fish', n);
  return DONE;
}

export function countWater(g: Game, tx: number, tz: number, r: number): number {
  const s = g.state;
  let n = 0;
  for (let z = tz - r; z <= tz + r; z++) {
    for (let x = tx - r; x <= tx + r; x++) {
      if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
      if (dm.sq(x - tx) + dm.sq(z - tz) > r * r) continue;
      if (isWaterTerrain(s.tiles.terrain[z * s.W + x])) n++;
    }
  }
  return n;
}

/** Tile is free for a sapling (land, nothing on it). */
export function plantable(g: Game, i: number): boolean {
  const tl = g.state.tiles;
  return isLandTerrain(tl.terrain[i]) && tl.terrain[i] !== Terrain.Sand && tl.feature[i] === Feature.None &&
    tl.building[i] < 0 && tl.road[i] === Road.None && !g.rt.doorTiles.has(i);
}

function stepPlant(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'plant' }>): StepResult {
  const i = st.i;
  if (!plantable(g, i) || g.rt.tileClaim[i] !== c.id) return FAIL;
  const [x, z] = tileCenter(g, i);
  faceTowards(c, x, z);
  c.activity = 'farming';
  c.moving = false;
  if (t.tm < PLANT_TREE_TIME) return RUN;
  const tl = g.state.tiles;
  tl.feature[i] = Feature.Tree;
  tl.featureAmount[i] = 0.05;
  const roll = g.rng.next();
  tl.variant[i] = roll < 0.4 ? 1 : roll < 0.7 ? 0 : 2;
  tl.marked[i] = 0;
  g.bumpFeatures();
  releaseKind(g, c, t, 'tile');
  return DONE;
}

function stepField(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'field' }>): StepResult {
  const b = alive(g, st.b);
  if (!b || b.state !== 'active' || !b.fieldTiles) return FAIL;
  if (g.rt.tileClaim[st.i] !== c.id) return FAIL;
  const W = g.state.W;
  const tx = st.i % W;
  const tz = Math.floor(st.i / W);
  const li = (tz - b.z) * b.w + (tx - b.x);
  const tile = b.fieldTiles[li];
  if (!tile) return FAIL;
  const s = g.state;
  c.activity = 'farming';
  c.moving = false;
  if (st.act === 'plant') {
    if (!(tile.stage === 0 || tile.stage === 1 || tile.stage === 4)) return DONE;
    if (!PLANT_MONTHS.includes(s.time.month) || b.type !== 'cropField') return FAIL;
    if (t.tm >= FIELD_PLANT_TIME * 0.5 && tile.stage !== 1) {
      tile.stage = 1; // plowed
      s.rev.fields++;
    }
    if (t.tm < FIELD_PLANT_TIME / efficiency(g, c)) return RUN;
    tile.stage = 2;
    tile.growth = 0;
    s.rev.fields++;
    if (s.weather.temperature < CROP_MIN_TEMP) tile.growth = 0;
    releaseKind(g, c, t, 'tile');
    return DONE;
  }
  if (tile.stage !== 3) return DONE;
  if (t.tm < FIELD_HARVEST_TIME / efficiency(g, c)) return RUN;
  tile.stage = 4;
  tile.growth = 0;
  s.rev.fields++;
  let r: ResourceType;
  let n: number;
  if (b.type === 'cropField') {
    const def = CROPS[b.crop ?? 'wheat'];
    r = def.resource;
    n = def.yieldPerTile;
  } else {
    const o = b.orchard;
    if (!o) return FAIL;
    const def = ORCHARDS[o.type];
    r = def.resource;
    n = def.yieldPerTile * clamp(o.maturity, 0, 1);
  }
  n = Math.max(1, Math.round(n));
  invAdd(b.inventory, r, n);
  recordProduction(b, r, n);
  releaseKind(g, c, t, 'tile');
  if (tile && b.orchard) {
    let ripe = 0;
    for (const ft of b.fieldTiles) if (ft.stage === 3) ripe++;
    b.orchard.fruit = ripe / b.fieldTiles.length;
  }
  return DONE;
}

function stepHerd(g: Game, c: Citizen, t: Task, st: Extract<Step, { op: 'herd' }>): StepResult {
  const b = alive(g, st.b);
  if (!b || b.state !== 'active') return FAIL;
  c.activity = 'farming';
  c.moving = false;
  if (t.tm < HERD_TIME / efficiency(g, c)) return RUN;
  const l = b.livestock;
  if (!l) return st.act === 'tend' ? DONE : FAIL;
  const def = LIVESTOCK[l.type];
  if (st.act === 'slaughter') {
    // re-check at the moment of the cull (another herder may have culled already): always keep a breeding pair
    if (l.count <= 2 || !pastureWantsSlaughter(b)) return DONE;
    l.count -= 1;
    invAdd(b.inventory, def.meat, def.meatPerAnimal);
    recordProduction(b, def.meat, def.meatPerAnimal);
    if (l.type === 'cattle') {
      invAdd(b.inventory, 'leather', CATTLE_SLAUGHTER_LEATHER);
      recordProduction(b, 'leather', CATTLE_SLAUGHTER_LEATHER);
    }
  } else if (st.act === 'collect') {
    if (l.product < 1) return DONE;
    l.product -= 1;
    invAdd(b.inventory, def.product, PRODUCT_BATCH);
    recordProduction(b, def.product, PRODUCT_BATCH);
  }
  return DONE;
}

function stepExtract(g: Game, c: Citizen, t: Task, bid: number, dt: number): StepResult {
  const b = alive(g, bid);
  if (!b || b.state !== 'active' || b.paused) return FAIL;
  c.activity = 'mining';
  c.moving = false;
  if (every(t, dt, 2.2)) g.sound('dig', c.x, c.z);
  if (t.tm < EXTRACT_TIME / efficiency(g, c)) return RUN;
  if (b.type === 'quarry') {
    invAdd(b.inventory, 'stone', QUARRY_STONE);
    recordProduction(b, 'stone', QUARRY_STONE);
    if (g.rng.chance(QUARRY_IRON_CHANCE)) {
      invAdd(b.inventory, 'iron', 1);
      recordProduction(b, 'iron', 1);
    }
  } else {
    invAdd(b.inventory, 'iron', MINE_IRON);
    invAdd(b.inventory, 'stone', MINE_STONE);
    recordProduction(b, 'iron', MINE_IRON);
    recordProduction(b, 'stone', MINE_STONE);
    if (g.rng.chance(MINE_ACCIDENT_CHANCE)) {
      g.addMessage(`${c.name} was killed in a mining accident.`, 'danger', { kind: 'building', id: b.id });
      g.killCitizen(c.id, 'accident');
      return DEAD;
    }
  }
  return DONE;
}
