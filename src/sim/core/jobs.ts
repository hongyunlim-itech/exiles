/**
 * Job assignment (~1 Hz, ARCHITECTURE §3.5 "Jobs"): age-based professions (child / student / laborer), builders
 * from the laborer pool, workplace staffing (nearest laborers first), releasing workers when counts drop.
 * OWNER: sim-core.
 */
import { ADULT_AGE, STUDENT_GRADUATE_AGE } from '../../core/constants';
import { BUILDINGS } from '../../core/defs';
import type { Building, BuildingType, Citizen, Profession } from '../../core/types';
import type { Game } from '../game';
import { brainOf } from './tasks';
import * as dm from './dmath';

export function setProfession(g: Game, c: Citizen, p: Profession, workplaceId = -1): void {
  if (c.profession === p && c.workplaceId === workplaceId) return;
  if (c.workplaceId >= 0 && c.workplaceId !== workplaceId) {
    const old = g.buildingById.get(c.workplaceId);
    if (old) old.workerIds = old.workerIds.filter((x) => x !== c.id);
  }
  c.profession = p;
  c.workplaceId = workplaceId;
  g.onJobChanged(c);
}

/** Active school with a teacher whose radius covers the citizen's home (or position when homeless). */
export function schoolFor(g: Game, c: Citizen): Building | null {
  const s = g.state;
  const home = c.homeId >= 0 ? g.buildingById.get(c.homeId) : undefined;
  const px = home ? home.x + home.w / 2 : c.x;
  const pz = home ? home.z + home.h / 2 : c.z;
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of g.rt.ofType(s, 'school')) {
    if (b.state !== 'active' || b.workerIds.length === 0) continue;
    const d = dm.hypot(b.x + b.w / 2 - px, b.z + b.h / 2 - pz);
    if (d <= (BUILDINGS.school.workRadius ?? 26) && d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/** The citizen stands on walkable ground that has no connection to the workplace's door. */
function cutOff(g: Game, c: Citizen, b: Building): boolean {
  const x = Math.floor(c.x);
  const z = Math.floor(c.z);
  if (!g.sameRegionSafe(x, z, x, z)) return false; // standing somewhere odd (inside a pit, mid-exit): not decisive
  return !g.sameRegionSafe(x, z, b.doorX, b.doorZ);
}

/** Services whose staff is never taken away for priority workplaces (their effect needs continuity). */
const PROTECTED_SERVICES = new Set<BuildingType>(['school', 'hospital', 'chapel']);

function homePos(g: Game, c: Citizen): [number, number] {
  const h = c.homeId >= 0 ? g.buildingById.get(c.homeId) : undefined;
  return h ? [h.doorX + 0.5, h.doorZ + 0.5] : [c.x, c.z];
}

export function updateJobs(g: Game): void {
  const s = g.state;

  // 1. age-based professions
  for (const c of s.citizens) {
    if (c.age < ADULT_AGE) {
      if (c.profession !== 'child') setProfession(g, c, 'child');
      continue;
    }
    if (c.profession === 'child') {
      const school = c.age < STUDENT_GRADUATE_AGE ? schoolFor(g, c) : null;
      if (school) {
        brainOf(c).school = school.id;
        setProfession(g, c, 'student');
      } else setProfession(g, c, 'laborer');
    } else if (c.profession === 'student') {
      const brain = brainOf(c);
      const sch = brain.school >= 0 ? g.buildingById.get(brain.school) : undefined;
      if (c.age >= STUDENT_GRADUATE_AGE || !sch || sch.state !== 'active') {
        const other = c.age < STUDENT_GRADUATE_AGE ? schoolFor(g, c) : null;
        if (other) brain.school = other.id;
        else {
          brain.school = -1;
          setProfession(g, c, 'laborer');
        }
      }
    }
  }

  // 2. validate workplace links
  const workplaces = g.rt.workplaces(s);
  for (const b of workplaces) {
    const def = BUILDINGS[b.type];
    b.workersDesired = Math.max(0, Math.min(def.maxWorkers, Math.round(b.workersDesired)));
    if (b.workerIds.length === 0) continue;
    b.workerIds = b.workerIds.filter((id) => {
      const c = g.citizenById.get(id);
      return !!c && c.workplaceId === b.id;
    });
    if (b.state !== 'active') {
      for (const id of b.workerIds) {
        const c = g.citizenById.get(id);
        if (c) setProfession(g, c, 'laborer');
      }
      b.workerIds = [];
    }
  }
  for (const c of s.citizens) {
    if (c.workplaceId < 0) {
      if (c.profession !== 'laborer' && c.profession !== 'builder' && c.profession !== 'child' && c.profession !== 'student') {
        setProfession(g, c, 'laborer');
      }
      continue;
    }
    const b = g.buildingById.get(c.workplaceId);
    if (!b || b.state !== 'active' || !b.workerIds.includes(c.id)) setProfession(g, c, 'laborer');
    else if (cutOff(g, c, b)) {
      // cut off from the workplace (e.g. its bridge was removed): release them so someone who can reach it is hired
      b.workerIds = b.workerIds.filter((x) => x !== c.id);
      setProfession(g, c, 'laborer');
    }
  }

  // 3. builders
  let builders = 0;
  for (const c of s.citizens) if (c.profession === 'builder') builders++;
  const desired = Math.max(0, s.buildersDesired | 0);
  if (builders > desired) {
    for (let i = s.citizens.length - 1; i >= 0 && builders > desired; i--) {
      const c = s.citizens[i];
      if (c.profession !== 'builder') continue;
      setProfession(g, c, 'laborer');
      builders--;
    }
  }
  if (builders < desired) {
    for (const c of s.citizens) {
      if (builders >= desired) break;
      if (c.profession !== 'laborer') continue;
      setProfession(g, c, 'builder');
      builders++;
    }
  }

  // 4. workplaces: release extras, then fill from the nearest laborers
  const active = workplaces.filter((b) => b.state === 'active' && BUILDINGS[b.type].maxWorkers > 0);
  for (const b of active) {
    while (b.workerIds.length > b.workersDesired) {
      const id = b.workerIds[b.workerIds.length - 1];
      const c = g.citizenById.get(id);
      b.workerIds.pop();
      if (c) setProfession(g, c, 'laborer');
    }
  }
  const pool: Citizen[] = s.citizens.filter((c) => c.profession === 'laborer');
  const ordered = [...active].sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || a.id - b.id);
  // priority workplaces that no laborer can fill take workers from non-priority workplaces (newest first)
  if (pool.length === 0) {
    stealForPriority(g, ordered);
    return;
  }
  for (const b of ordered) {
    const prof = BUILDINGS[b.type].profession;
    if (!prof) continue;
    while (b.workerIds.length < b.workersDesired && pool.length > 0) {
      const bx = b.doorX + 0.5;
      const bz = b.doorZ + 0.5;
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const [hx, hz] = homePos(g, pool[i]);
        const d = dm.hypot(hx - bx, hz - bz);
        if (d < bestD && g.sameRegionSafe(Math.floor(pool[i].x), Math.floor(pool[i].z), b.doorX, b.doorZ)) {
          bestD = d;
          bestI = i;
        }
      }
      if (bestI < 0) break;
      const c = pool[bestI];
      pool.splice(bestI, 1);
      setProfession(g, c, prof, b.id);
      b.workerIds.push(c.id);
    }
    if (pool.length === 0) break;
  }
  if (pool.length === 0) stealForPriority(g, ordered);
}

/**
 * Priority workplaces still short of workers take them from non-priority workplaces (the newest workplace gives
 * first, one worker per second per priority workplace so staffing shifts gradually). Builders are never taken:
 * their count is a separate player setting.
 */
function stealForPriority(g: Game, ordered: Building[]): void {
  const donors = ordered.filter((b) => !b.priority && b.workerIds.length > 0 && !b.paused && !PROTECTED_SERVICES.has(b.type));
  if (donors.length === 0) return;
  for (const b of ordered) {
    if (!b.priority) break; // ordered: priority workplaces first
    const prof = BUILDINGS[b.type].profession;
    if (!prof || b.paused || b.workerIds.length >= b.workersDesired) continue;
    let donor: Building | null = null;
    let worker: Citizen | undefined;
    for (let k = donors.length - 1; k >= 0 && !worker; k--) {
      const d = donors[k];
      if (d.workerIds.length === 0) continue;
      const cand = g.citizenById.get(d.workerIds[d.workerIds.length - 1]);
      if (cand && g.sameRegionSafe(Math.floor(cand.x), Math.floor(cand.z), b.doorX, b.doorZ)) {
        donor = d;
        worker = cand;
      }
    }
    if (!donor || !worker) return;
    donor.workerIds.pop();
    setProfession(g, worker, prof, b.id);
    b.workerIds.push(worker.id);
  }
}
