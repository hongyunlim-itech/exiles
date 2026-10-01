/**
 * Citizens: creation, needs decay (hunger, warmth, diet), aging, equipment wear, births and deaths.
 * ARCHITECTURE §3.3 / §3.4. OWNER: sim-core.
 */
import {
  ADULT_AGE, COLD_TEMP, FREEZE_DEATH_SECONDS, HUNGER_RATE, LIFESPAN_MAX, LIFESPAN_MIN, MAX_CHILDREN_PER_HOUSE, MEAL_SIZE,
  MONTH_SECONDS, STARVE_DEATH_SECONDS, YEAR_SECONDS,
} from '../../core/constants';
import { BUILDINGS, FEMALE_NAMES, MALE_NAMES, SURNAMES } from '../../core/defs';
import type { Activity, Building, CauseOfDeath, Citizen, Gender } from '../../core/types';
import type { Game } from '../game';
import { brainOf, newBrain, type TaskKind } from './tasks';

/** Warmth lost per second per degree below COLD_TEMP while outdoors. */
export const WARMTH_LOSS = 0.095;
/** Coats reduce cold exposure to this factor. */
export const COAT_FACTOR = 0.35;
/** Warmth regained per second in warm weather. */
const WARMTH_RECOVER = 2.5;
/** Warmth regained per second at a home with a burning fire. */
export const HEARTH_WARM_RATE = 12;
/** A heated home warms its residents up to this. */
export const HEARTH_TARGET = 99;
/** Inside an unheated home the cold bites at this fraction of the outdoor rate (no wind)... */
const COLD_HOME_LOSS = 0.5;
/** ...and people slowly warm up (body heat, blankets) while below the cold-home level. */
const COLD_HOME_RECOVER = 1;
/** freezeTime recovers at this fraction of real time once warmth is above 0 again (brief relief doesn't reset it). */
const FREEZE_RECOVERY = 0.5;
/** Chance per year that a fertile couple with room has a child (at average happiness and enough food). */
export const BIRTH_RATE = 1.0;
export const FERTILE_MIN = 16;
export const FERTILE_MAX = 45;
/** Young adults may leave their parents' home to marry (or live alone) and found a household from this age. */
export const MARRY_AGE = 14;
/** Chance that the mother dies in childbirth. */
const CHILDBIRTH_DEATH = 0.004;
/** Children eat less. */
export const CHILD_HUNGER_FACTOR = 0.6;
/** Food eaten per citizen per month (satiation 100 -> 0 in three months, MEAL_SIZE units refill it). */
export const FOOD_PER_CITIZEN_MONTH = (MEAL_SIZE * HUNGER_RATE * MONTH_SECONDS) / 100;

/** Activities during which a citizen is sheltered from the cold (indoors / by a fire), wherever they are. */
const SHELTERED = new Set<Activity>(['warming', 'studying', 'working', 'healing', 'praying']);
/** Activities that wear tools. */
export const WORK_ACTIVITIES = new Set<Activity>([
  'working', 'building', 'gathering', 'chopping', 'mining', 'farming', 'fishing', 'hunting', 'healing',
]);
/** Task kinds that count as work: tools wear while walking to / carrying for the job, too. */
const WORK_TASKS = new Set<TaskKind>(['work', 'haul', 'deliver', 'clear', 'build', 'demolish']);

/**
 * Warmth an unheated home can keep its residents at, by outdoor temperature: a cold hearth offers shelter from the
 * wind but no warmth; below about -3 C it cannot keep anybody from freezing.
 */
export function coldHomeLevel(temp: number): number {
  return Math.max(0, Math.min(40, 8 + 3 * temp));
}

/** Does the home have a fire going (firewood in it)? */
export function homeHeated(b: Building): boolean {
  return (b.inventory.firewood ?? 0) > 0.01;
}

/**
 * Where the citizen is sheltering right now: their home (warming, eating or resting there), another building
 * (indoor work, school, eating at a barn...) or outdoors (null).
 */
function shelterOf(g: Game, c: Citizen): Building | 'indoors' | null {
  const a = c.activity;
  if (a === 'warming' || a === 'eating' || a === 'sick') {
    const t = brainOf(c).cur;
    const st = t ? t.steps[t.si] : undefined;
    const bid = st && (st.op === 'warm' || st.op === 'eat' || st.op === 'rest') ? st.b : -1;
    if (bid < 0) return null; // resting / eating in the open
    const b = g.buildingById.get(bid);
    if (!b) return null;
    if (b.id === c.homeId && BUILDINGS[b.type].housing) return b;
    return BUILDINGS[b.type].walkable ? null : 'indoors';
  }
  return SHELTERED.has(a) ? 'indoors' : null;
}

export function surnameOf(c: Citizen): string {
  const parts = c.name.split(' ');
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

export function randomName(g: Game, gender: Gender, surname?: string): string {
  const first = g.rng.pick(gender === 'M' ? MALE_NAMES : FEMALE_NAMES);
  return `${first} ${surname ?? g.rng.pick(SURNAMES)}`;
}

export interface NewCitizenOpts {
  x: number;
  z: number;
  age: number;
  gender: Gender;
  name?: string;
  surname?: string;
  motherId?: number;
  fatherId?: number;
  sick?: number;
}

export function makeCitizen(g: Game, o: NewCitizenOpts): Citizen {
  const s = g.state;
  const rng = g.rng;
  const c: Citizen = {
    id: g.newId(),
    name: o.name ?? randomName(g, o.gender, o.surname),
    gender: o.gender,
    age: o.age,
    lifespan: rng.range(LIFESPAN_MIN, LIFESPAN_MAX),
    spouseId: -1,
    motherId: o.motherId ?? -1,
    fatherId: o.fatherId ?? -1,
    childIds: [],
    homeId: -1,
    workplaceId: -1,
    profession: o.age < ADULT_AGE ? 'child' : 'laborer',
    food: rng.range(80, 100),
    warmth: 100,
    health: 100,
    happiness: 60,
    education: 0,
    sick: o.sick ?? 0,
    dietMask: 0,
    dietTimers: [0, 0, 0, 0],
    toolWear: 0,
    coatWear: 0,
    x: o.x,
    z: o.z,
    heading: rng.range(0, Math.PI * 2),
    moving: false,
    activity: 'idle',
    taskLabel: 'Idle',
    carrying: null,
    task: newBrain(),
    path: null,
    pathIndex: 0,
    starveTime: 0,
    freezeTime: 0,
    bornAt: s.time.elapsed - o.age * YEAR_SECONDS,
    grief: 0,
  };
  // never let the lifespan be below the current age + a little
  if (c.lifespan < c.age + 2) c.lifespan = c.age + rng.range(2, 8);
  return c;
}

export function addCitizen(g: Game, c: Citizen): void {
  g.state.citizens.push(c);
  g.citizenById.set(c.id, c);
}

/** Per-step needs, aging, wear and natural deaths. */
export function updateLifecycle(g: Game, dt: number): void {
  const s = g.state;
  const temp = s.weather.temperature;
  const cold = temp < COLD_TEMP;
  const yearDt = dt / YEAR_SECONDS;
  let deaths: [number, CauseOfDeath][] | null = null;
  for (const c of s.citizens) {
    c.age += yearDt;
    const child = c.age < ADULT_AGE;
    c.food -= HUNGER_RATE * (child ? CHILD_HUNGER_FACTOR : 1) * dt;
    if (!(c.food > 0)) {
      c.food = 0;
      c.starveTime += dt;
    } else if (c.starveTime > 0) {
      c.starveTime = Math.max(0, c.starveTime - dt * 2);
    }
    let mask = 0;
    const dtm = c.dietTimers;
    for (let k = 0; k < 4; k++) {
      if (dtm[k] > 0) {
        dtm[k] = Math.max(0, dtm[k] - dt);
        if (dtm[k] > 0) mask |= 1 << k;
      }
    }
    c.dietMask = mask;
    if (cold) {
      const where = shelterOf(g, c);
      const coat = c.coatWear > 0 ? COAT_FACTOR : 1;
      const loss = WARMTH_LOSS * (COLD_TEMP - temp) * coat * (child ? 1.1 : 1);
      if (where === null) {
        c.warmth -= loss * dt;
        if (c.coatWear > 0) c.coatWear = Math.max(0, c.coatWear - dt);
      } else if (where !== 'indoors') {
        // at home: a fire warms quickly; a cold hearth only slows the chill down to a low level
        if (homeHeated(where)) {
          if (c.warmth < HEARTH_TARGET) c.warmth = Math.min(HEARTH_TARGET, c.warmth + HEARTH_WARM_RATE * dt);
        } else {
          const level = coldHomeLevel(temp);
          if (c.warmth > level) c.warmth = Math.max(level, c.warmth - loss * COLD_HOME_LOSS * dt);
          else c.warmth = Math.min(level, c.warmth + COLD_HOME_RECOVER * dt);
        }
      }
    } else if (c.warmth < 100) {
      c.warmth = Math.min(100, c.warmth + WARMTH_RECOVER * dt);
    }
    if (!(c.warmth > 0)) {
      c.warmth = 0;
      c.freezeTime += dt;
    } else if (c.freezeTime > 0) {
      c.freezeTime = Math.max(0, c.freezeTime - dt * FREEZE_RECOVERY);
    }
    if (c.toolWear > 0 && (WORK_ACTIVITIES.has(c.activity) || isWorkTask(c))) c.toolWear = Math.max(0, c.toolWear - dt);
    let cause: CauseOfDeath | null = null;
    if (c.age >= c.lifespan) cause = 'oldAge';
    else if (c.starveTime >= STARVE_DEATH_SECONDS) cause = 'starvation';
    else if (c.freezeTime >= FREEZE_DEATH_SECONDS) cause = 'freezing';
    if (cause) (deaths ??= []).push([c.id, cause]);
  }
  if (deaths) for (const [id, cause] of deaths) g.killCitizen(id, cause);
}

function isWorkTask(c: Citizen): boolean {
  const t = brainOf(c).cur;
  return !!t && (t.job || WORK_TASKS.has(t.kind));
}

/** Months of food the town has (storage, homes and workplace buffers) at its current size. */
export function townFoodMonths(g: Game): number {
  const pop = g.state.citizens.length;
  if (pop === 0) return Infinity;
  return g.rt.townFood / (pop * FOOD_PER_CITIZEN_MONTH);
}

/** Birth-rate multiplier from the parents' happiness: miserable couples rarely have children, happy ones more. */
export function happinessBirthFactor(h: number): number {
  if (h < 30) return 0.4;
  if (h > 70) return 1.3;
  return 0.7 + (0.6 * (h - 30)) / 40;
}

/** Births in family homes. Called with the accumulated interval dt. */
export function updateBirths(g: Game, dt: number): void {
  const s = g.state;
  if (s.gameOver) return;
  // babies are rare while the barns are (nearly) empty: couples wait for better times
  const months = townFoodMonths(g);
  const foodFactor = Math.max(0.05, Math.min(1, (months - 2) / 4));
  for (const h of g.rt.houses(s)) {
    if (h.state !== 'active' || !BUILDINGS[h.type].familyHome) continue;
    const cap = BUILDINGS[h.type].housing ?? 0;
    if (h.residentIds.length >= cap) continue;
    let kids = 0;
    let mother: Citizen | null = null;
    let father: Citizen | null = null;
    for (const id of h.residentIds) {
      const c = g.citizenById.get(id);
      if (!c) continue;
      if (c.age < ADULT_AGE) kids++;
      if (c.gender === 'F' && c.spouseId >= 0 && c.age >= FERTILE_MIN && c.age <= FERTILE_MAX) {
        const sp = g.citizenById.get(c.spouseId);
        if (sp && sp.homeId === h.id) {
          mother = c;
          father = sp;
        }
      }
    }
    if (!mother || !father || kids >= MAX_CHILDREN_PER_HOUSE) continue;
    let factor = happinessBirthFactor((mother.happiness + father.happiness) / 2) * foodFactor;
    if (mother.food < 15 || mother.health < 30) factor *= 0.25;
    const p = BIRTH_RATE * (dt / YEAR_SECONDS) * factor;
    if (g.rng.next() >= p) continue;
    giveBirth(g, h, mother, father);
  }
}

function giveBirth(g: Game, h: Building, mother: Citizen, father: Citizen): void {
  const s = g.state;
  const gender: Gender = g.rng.chance(0.5) ? 'M' : 'F';
  const baby = makeCitizen(g, {
    x: h.doorX + 0.5, z: h.doorZ + 0.5, age: 0, gender, surname: surnameOf(father), motherId: mother.id, fatherId: father.id,
  });
  baby.food = 100;
  baby.happiness = Math.round((mother.happiness + father.happiness) / 2);
  baby.homeId = h.id;
  addCitizen(g, baby);
  h.residentIds.push(baby.id);
  mother.childIds.push(baby.id);
  father.childIds.push(baby.id);
  s.tally.births++;
  s.tally.monthBirths++;
  g.events.emit('citizenBorn', { id: baby.id });
  g.sound('birth', baby.x, baby.z);
  g.addMessage(`${baby.name} was born to ${mother.name.split(' ')[0]} and ${father.name.split(' ')[0]}.`, 'good', { kind: 'citizen', id: baby.id });
  if (g.rng.chance(CHILDBIRTH_DEATH)) g.killCitizen(mother.id, 'childbirth');
}

const CAUSE_TEXT: Record<CauseOfDeath, string> = {
  oldAge: 'of old age',
  starvation: 'of starvation',
  freezing: 'from the cold',
  disease: 'of disease',
  accident: 'in an accident',
  fire: 'in a fire',
  tornado: 'in a tornado',
  childbirth: 'in childbirth',
};

/** Remove a citizen (the only way citizens leave the game). */
export function killCitizenImpl(g: Game, id: number, cause: CauseOfDeath): void {
  const s = g.state;
  const c = g.citizenById.get(id);
  if (!c) return;
  g.abortTask(c, true);
  if (c.carrying && c.carrying.amount > 0) g.addToStorage(c.carrying.type, c.carrying.amount, c.x, c.z);
  c.carrying = null;
  const home = c.homeId >= 0 ? g.buildingById.get(c.homeId) : undefined;
  if (home) home.residentIds = home.residentIds.filter((x) => x !== id);
  const work = c.workplaceId >= 0 ? g.buildingById.get(c.workplaceId) : undefined;
  if (work) work.workerIds = work.workerIds.filter((x) => x !== id);
  const sp = c.spouseId >= 0 ? g.citizenById.get(c.spouseId) : undefined;
  if (sp) {
    if (sp.spouseId === id) sp.spouseId = -1;
    sp.grief = 100;
  }
  for (const kid of c.childIds) {
    const k = g.citizenById.get(kid);
    if (k) k.grief = 100;
  }
  for (const pid of [c.motherId, c.fatherId]) {
    const p = pid >= 0 ? g.citizenById.get(pid) : undefined;
    if (p) {
      p.grief = 100;
      p.childIds = p.childIds.filter((x) => x !== id);
    }
  }
  // burial
  let buried = false;
  for (const b of g.rt.ofType(s, 'cemetery')) {
    if (b.state !== 'active') continue;
    const cap = Math.floor(b.w * b.h * (BUILDINGS.cemetery.gravesPerTile ?? 0.5));
    if ((b.graves ?? 0) < cap) {
      b.graves = (b.graves ?? 0) + 1;
      buried = true;
      break;
    }
  }
  if (!buried) s.unburied++;
  const idx = s.citizens.indexOf(c);
  if (idx >= 0) s.citizens.splice(idx, 1);
  g.citizenById.delete(id);
  s.tally.deaths[cause] = (s.tally.deaths[cause] ?? 0) + 1;
  s.tally.monthDeaths++;
  g.events.emit('citizenDied', { id, name: c.name, cause });
  g.sound('death', c.x, c.z);
  g.addMessage(`${c.name} died ${CAUSE_TEXT[cause]}${c.age < ADULT_AGE ? ` at the age of ${Math.max(0, Math.floor(c.age))}` : ''}.`,
    cause === 'oldAge' ? 'info' : 'danger', { kind: 'tile', id: Math.floor(c.z) * s.W + Math.floor(c.x) });
  if (s.citizens.length === 0 && !s.gameOver) {
    s.gameOver = true;
    g.events.emit('gameOver', {});
    g.addMessage(`The last of the people of ${s.settings.townName} has died. The town is abandoned.`, 'danger');
  }
}
