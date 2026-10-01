/**
 * Behaviour engine: runs every citizen's task each step (with planning & path-search budgets, a watchdog and
 * clean aborts), dispatches firefighters. ARCHITECTURE §3.1 step 6. OWNER: sim-core.
 */
import { ADULT_AGE, COLD_TEMP } from '../../core/constants';
import { BUILDINGS, FOOD_TYPES } from '../../core/defs';
import type { Building, Citizen } from '../../core/types';
import type { Game } from '../game';
import { releaseAll } from './claims';
import { planTask } from './planner';
import { DEAD, DONE, FAIL, RUN, runStep, stepTimeout } from './steps';
import { blacklist, brainOf, stepTargetKey, type Brain, type Task } from './tasks';
import {
  BLACKLIST_TIME, FIREFIGHT_RADIUS, MAX_FIREFIGHTERS, MAX_TASK_AGE, PATHS_PER_SECOND, PLANS_PER_SECOND, URGENT_FOOD,
  URGENT_WARMTH,
} from './tuning';
import { invGet, invKeys } from './util';
import { canWarmAtHome, fightTask, foodAvailableFor, hungerIsUrgent } from './work/needs';
import { FOOD_PER_CITIZEN_MONTH } from './citizens';
import * as dm from './dmath';

/** Rationing starts when the town has less than this many months of food. */
const RATION_MONTHS = 1;

/**
 * Refresh (every step, see Game.step) `rt.foodAvailable` (any unreserved food a hungry citizen could reach: storages, workplace buffers,
 * salvage in ruins), `rt.townFood` (every unit of food in town, homes included) and `rt.rationing`.
 */
export function refreshFoodAvailability(g: Game): void {
  const s = g.state;
  let found = false;
  let total = 0;
  for (const b of s.buildings) {
    const def = BUILDINGS[b.type];
    const inv = b.inventory;
    let any = false;
    for (const k in inv) {
      if (inv[k as keyof typeof inv]! > 0 && FOOD_SET.has(k)) {
        any = true;
        break;
      }
    }
    if (!any) continue;
    for (const r of FOOD_TYPES) {
      const n = invGet(inv, r);
      if (n <= 0) continue;
      total += n;
      if (!found && !def.housing && !def.recipes && (b.state === 'active' || b.state === 'ruin') && n - invGet(b.reservedOut, r) >= 1) {
        found = true;
      }
    }
  }
  g.rt.foodAvailable = found;
  g.rt.townFood = total;
  g.rt.rationing = s.citizens.length > 0 && total < s.citizens.length * FOOD_PER_CITIZEN_MONTH * RATION_MONTHS;
}

const FOOD_SET = new Set<string>(FOOD_TYPES);

/** Tasks that satisfy needs are never interrupted by needs. */
const NEED_KINDS = new Set(['eat', 'warm', 'rest', 'fight', 'exit']);

export function startTask(g: Game, c: Citizen, brain: Brain, t: Task): void {
  brain.cur = t;
  c.taskLabel = t.label;
  c.path = null;
  c.pathIndex = 0;
  void g;
}

/** Abort the current task: release every claim, return extra goods to storage. Carried goods stay in hand. */
export function abortTask(g: Game, c: Citizen, dying = false): void {
  const brain = brainOf(c);
  const t = brain.cur;
  if (!t) return;
  releaseAll(g, c, t);
  for (const inv of [t.bundle, t.extra]) {
    if (!inv) continue;
    for (const r of invKeys(inv)) g.addToStorage(r, invGet(inv, r), c.x, c.z);
  }
  t.bundle = null;
  t.extra = null;
  brain.cur = null;
  c.path = null;
  c.pathIndex = 0;
  c.moving = false;
  if (!dying) {
    c.activity = 'idle';
    c.taskLabel = 'Idle';
  }
}

function completeTask(g: Game, c: Citizen, brain: Brain, t: Task): void {
  releaseAll(g, c, t);
  if (t.bundle || t.extra) {
    // anything left in the basket goes back to storage (should be rare)
    for (const inv of [t.bundle, t.extra]) {
      if (!inv) continue;
      for (const r of invKeys(inv)) g.addToStorage(r, invGet(inv, r), c.x, c.z);
    }
  }
  brain.cur = null;
  c.path = null;
  c.pathIndex = 0;
  c.moving = false;
}

function failTask(g: Game, c: Citizen, brain: Brain, t: Task): void {
  const now = g.state.time.elapsed;
  const st = t.steps[t.si];
  if (st) {
    let key = stepTargetKey(st);
    if (st.op === 'go') key = (t.steps[t.si + 1] && stepTargetKey(t.steps[t.si + 1])) ?? key;
    if (key) blacklist(brain, key, now + BLACKLIST_TIME, now);
  }
  abortTask(g, c);
}

function shouldInterrupt(g: Game, c: Citizen, t: Task, brain: Brain): boolean {
  // needs are never interrupted by needs
  if (NEED_KINDS.has(t.kind)) return false;
  const now = g.state.time.elapsed;
  // a household fetch trip is heading home anyway (it brings firewood/food): only real urgency stops it
  if (t.kind === 'supply') return c.food < URGENT_FOOD * 0.5 && now >= brain.cdEat && foodAvailableFor(g, c);
  // hungry and far from food: stop the job (the load stays in the hands) and go eat before it is too late
  if (now >= brain.cdEat && foodAvailableFor(g, c) && hungerIsUrgent(g, c)) return true;
  // only when the home can actually warm them (a cold hearth can't): otherwise the job would be aborted for nothing
  if (g.state.weather.temperature < COLD_TEMP && c.warmth < URGENT_WARMTH && now >= brain.cdWarm) {
    if (canWarmAtHome(g, c)) return true;
    brain.cdWarm = now + 12;
  }
  return false;
}

/** Long working steps with their own (efficiency-scaled) timeouts don't count toward the task watchdog. */
const UNTIMED_STEPS = new Set(['craft', 'extract']);

function runTask(g: Game, c: Citizen, brain: Brain, t: Task, dt: number): void {
  const cur = t.steps[t.si];
  if (!cur || !UNTIMED_STEPS.has(cur.op)) t.age += dt;
  if (t.age > MAX_TASK_AGE) {
    failTask(g, c, brain, t);
    return;
  }
  let stepDt = dt;
  for (let iter = 0; iter < 6; iter++) {
    const st = t.steps[t.si];
    if (!st) {
      completeTask(g, c, brain, t);
      return;
    }
    t.tm += stepDt;
    if (t.tm > stepTimeout(st)) {
      failTask(g, c, brain, t);
      return;
    }
    const r = runStep(g, c, t, st, stepDt);
    if (r === DEAD || !g.citizenById.has(c.id)) return;
    if (r === RUN) return;
    if (r === FAIL) {
      failTask(g, c, brain, t);
      return;
    }
    // DONE
    t.si++;
    t.tm = 0;
    c.path = null;
    c.pathIndex = 0;
    if (t.si >= t.steps.length) {
      completeTask(g, c, brain, t);
      return;
    }
    stepDt = 0;
  }
}

export function updateBehavior(g: Game, dt: number): void {
  const s = g.state;
  for (const b of s.buildings) if (b.fireFighters !== 0) b.fireFighters = 0;
  g.rt.pathBudget = Math.ceil(dt * PATHS_PER_SECOND) + 2;
  g.rt.planBudget = Math.ceil(dt * PLANS_PER_SECOND) + 3;
  const list = s.citizens;
  const n = list.length;
  if (n === 0) return;
  const snap = list.slice();
  const offset = Math.floor(s.time.elapsed * 8) % n;
  const now = s.time.elapsed;
  for (let k = 0; k < n; k++) {
    const c = snap[(k + offset) % n];
    if (!g.citizenById.has(c.id)) continue;
    try {
      tickCitizen(g, c, dt, now);
    } catch (err) {
      // never let one citizen's bug freeze the whole simulation: reset their behaviour and carry on
      g.reportModuleError('behavior', err);
      try {
        abortTask(g, c);
      } catch {
        const brain = brainOf(c);
        brain.cur = null;
        c.path = null;
      }
    }
  }
}

function tickCitizen(g: Game, c: Citizen, dt: number, now: number): void {
  const brain = brainOf(c);
  if (brain.cur && now >= brain.nextCheck) {
    brain.nextCheck = now + 1;
    if (shouldInterrupt(g, c, brain.cur, brain)) abortTask(g, c);
  }
  if (!brain.cur) {
    if (g.rt.planBudget <= 0) {
      c.moving = false;
      return;
    }
    g.rt.planBudget--;
    if (g.profile) {
      const t0 = performance.now();
      const t = planTask(g, c, brain);
      const key = `plan.${c.profession}`;
      g.profile[key] = (g.profile[key] ?? 0) + performance.now() - t0;
      g.profile['plan.n'] = (g.profile['plan.n'] ?? 0) + 1;
      startTask(g, c, brain, t);
    } else startTask(g, c, brain, planTask(g, c, brain));
    if (!g.citizenById.has(c.id)) return;
  }
  const t = brain.cur;
  if (t) runTask(g, c, brain, t, dt);
  sanitizeCitizen(c);
  if (g.rngTrace) g.rngTrace.push(`c${c.id}:${g.rng.state}:${c.taskLabel}:${t?.si}`);
}

/** Last line of defence against NaN positions / negative carried amounts. */
function sanitizeCitizen(c: Citizen): void {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) {
    c.x = Number.isFinite(c.x) ? c.x : 1;
    c.z = Number.isFinite(c.z) ? c.z : 1;
  }
  if (c.carrying && !(c.carrying.amount > 1e-6)) c.carrying = null;
}

/** Well covering the building (fire fighting needs water nearby). */
function wellCovers(g: Game, b: Building): boolean {
  const cx = b.x + b.w / 2;
  const cz = b.z + b.h / 2;
  const r = BUILDINGS.well.workRadius ?? 14;
  for (const w of g.rt.ofType(g.state, 'well')) {
    if (w.state !== 'active') continue;
    if (dm.hypot(w.x + w.w / 2 - cx, w.z + w.h / 2 - cz) <= r) return true;
  }
  return false;
}

/** Send nearby adults to burning buildings covered by a well (1 Hz). */
export function dispatchFirefighters(g: Game): void {
  const s = g.state;
  const burning = s.buildings.filter((b) => b.fire > 0 && b.state !== 'ruin');
  if (burning.length === 0) return;
  // current assignments
  const assigned = new Map<number, number>();
  for (const c of s.citizens) {
    const t = brainOf(c).cur;
    if (t?.kind !== 'fight') continue;
    const st = t.steps.find((x) => x.op === 'fight');
    if (st && st.op === 'fight') assigned.set(st.b, (assigned.get(st.b) ?? 0) + 1);
  }
  for (const b of burning) {
    if (!wellCovers(g, b)) continue;
    let have = assigned.get(b.id) ?? 0;
    if (have >= MAX_FIREFIGHTERS) continue;
    const cx = b.x + b.w / 2;
    const cz = b.z + b.h / 2;
    const cands: { c: Citizen; d: number }[] = [];
    for (const c of s.citizens) {
      if (c.age < ADULT_AGE || c.profession === 'student' || c.sick > 0.5) continue;
      const d = dm.hypot(c.x - cx, c.z - cz);
      if (d > FIREFIGHT_RADIUS) continue;
      const t = brainOf(c).cur;
      if (t?.kind === 'fight') continue;
      if (!g.sameRegionSafe(Math.floor(c.x), Math.floor(c.z), b.doorX, b.doorZ)) continue;
      cands.push({ c, d });
    }
    cands.sort((a, b2) => a.d - b2.d);
    for (const { c } of cands) {
      if (have >= MAX_FIREFIGHTERS) break;
      const brain = brainOf(c);
      abortTask(g, c);
      startTask(g, c, brain, fightTask(g, c, b));
      have++;
    }
    assigned.set(b.id, have);
  }
}

/** Abort job tasks after a profession/workplace change. */
export function onJobChanged(g: Game, c: Citizen): void {
  const brain = brainOf(c);
  if (brain.cur?.job) abortTask(g, c);
}
