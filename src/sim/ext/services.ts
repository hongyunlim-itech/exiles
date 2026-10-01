/**
 * Service coverage index: which town services (well, chapel, tavern, hospital, school) are operational and where
 * they reach. Rebuilt every couple of game seconds or whenever the building list changes.
 */
import { BUILDINGS } from '../../core/defs';
import type { Building, BuildingType } from '../../core/types';
import { buildingCenter } from '../../core/world';
import type { Game } from '../game';
import { rt } from './runtime';
import { SERVICE_REFRESH } from './tuning';
import { availableIn } from './util';

export const COVER_WELL = 1;
export const COVER_CHAPEL = 2;
export const COVER_TAVERN = 4;
export const COVER_HOSPITAL = 8;
export const COVER_SCHOOL = 16;

export interface ServicePoint {
  b: Building;
  cx: number;
  cz: number;
  r: number;
}

export interface ServiceIndex {
  /** Active wells. */
  wells: ServicePoint[];
  /** Chapels with a priest. */
  chapels: ServicePoint[];
  /** Taverns with a tavern keeper and ale. */
  taverns: ServicePoint[];
  /** Taverns with a keeper (ale or not) — for advisors. */
  tavernsStaffed: ServicePoint[];
  /** Hospitals with a healer and herbs. */
  hospitals: ServicePoint[];
  /** Hospitals with a healer (herbs or not). */
  hospitalsStaffed: ServicePoint[];
  /** Schools with a teacher. */
  schools: ServicePoint[];
  /** Active cemeteries. */
  cemeteries: Building[];
  /** Houses (any state; residents only live in active ones). */
  houses: Building[];
  /** Active trading posts. */
  tradingPosts: Building[];
  /** Active town halls. */
  townHalls: Building[];
}

function point(b: Building, radius?: number): ServicePoint {
  const [cx, cz] = buildingCenter(b);
  return { b, cx, cz, r: radius ?? BUILDINGS[b.type]?.workRadius ?? 0 };
}

const SERVICE_TYPES = new Set<BuildingType>(['well', 'chapel', 'tavern', 'hospital', 'school', 'cemetery', 'tradingPost', 'townHall']);

export function buildServiceIndex(game: Game): ServiceIndex {
  const idx: ServiceIndex = {
    wells: [], chapels: [], taverns: [], tavernsStaffed: [], hospitals: [], hospitalsStaffed: [], schools: [],
    cemeteries: [], houses: [], tradingPosts: [], townHalls: [],
  };
  for (const b of game.state.buildings) {
    const def = BUILDINGS[b.type];
    if (!def) continue;
    if (def.housing) {
      idx.houses.push(b);
      continue;
    }
    if (b.state !== 'active' || !SERVICE_TYPES.has(b.type)) continue;
    const staffed = b.workerIds.length > 0;
    switch (b.type) {
      case 'well':
        idx.wells.push(point(b));
        break;
      case 'chapel':
        if (staffed) idx.chapels.push(point(b));
        break;
      case 'tavern':
        if (staffed) {
          const p = point(b);
          idx.tavernsStaffed.push(p);
          if (availableIn(b, 'ale') > 0) idx.taverns.push(p);
        }
        break;
      case 'hospital':
        if (staffed) {
          const p = point(b);
          idx.hospitalsStaffed.push(p);
          if (availableIn(b, 'herbs') > 0) idx.hospitals.push(p);
        }
        break;
      case 'school':
        if (staffed) idx.schools.push(point(b));
        break;
      case 'cemetery':
        idx.cemeteries.push(b);
        break;
      case 'tradingPost':
        idx.tradingPosts.push(b);
        break;
      case 'townHall':
        idx.townHalls.push(b);
        break;
    }
  }
  return idx;
}

/**
 * Current service index for the game (refreshed lazily): rebuilt on the first use in every sim step (and whenever
 * the building list changes). Lockstep determinism: the index is a pure function of the state at a fixed point of
 * the step, so a game restored from a snapshot (whose index starts empty) uses exactly the same index as the
 * original — a countdown-based refresh would make a restored game see a fresher index than the original.
 */
export function getServices(game: Game, force = false): ServiceIndex {
  const r = rt(game);
  const stamp = game.state.time.elapsed;
  if (force || !r.services || r.serviceRev !== game.state.rev.buildings || r.serviceStamp !== stamp) {
    r.services = buildServiceIndex(game);
    r.serviceRev = game.state.rev.buildings;
    r.serviceStamp = stamp;
    if (r.serviceTimer <= 0) r.serviceTimer = SERVICE_REFRESH;
  }
  return r.services;
}

/** Tick the refresh timer (call once per step). */
export function tickServices(game: Game, dt: number): void {
  rt(game).serviceTimer -= dt;
}

function covers(list: ServicePoint[], x: number, z: number): ServicePoint | null {
  for (const p of list) {
    const dx = p.cx - x;
    const dz = p.cz - z;
    if (dx * dx + dz * dz <= p.r * p.r) return p;
  }
  return null;
}

/** Bitmask of COVER_* services reaching world point (x, z). */
export function coverageAt(idx: ServiceIndex, x: number, z: number): number {
  let m = 0;
  if (covers(idx.wells, x, z)) m |= COVER_WELL;
  if (covers(idx.chapels, x, z)) m |= COVER_CHAPEL;
  if (covers(idx.taverns, x, z)) m |= COVER_TAVERN;
  if (covers(idx.hospitals, x, z)) m |= COVER_HOSPITAL;
  if (covers(idx.schools, x, z)) m |= COVER_SCHOOL;
  return m;
}

/** The first hospital (staffed, with herbs) covering (x, z), if any. */
export function hospitalCovering(idx: ServiceIndex, x: number, z: number): Building | null {
  return covers(idx.hospitals, x, z)?.b ?? null;
}

/** Whether any active well covers the building's center. */
export function wellCoversBuilding(idx: ServiceIndex, b: Building): boolean {
  const [cx, cz] = buildingCenter(b);
  return covers(idx.wells, cx, cz) !== null;
}

/** Graves available in a cemetery. */
export function graveCapacity(b: Building): number {
  const per = BUILDINGS[b.type]?.gravesPerTile ?? 0;
  return Math.floor(b.w * b.h * per);
}
