/**
 * Building fires: random ignition, growth, fire fighting (citizens with a well in range), spreading to neighbours
 * and burning down. Building.fire is 0 (not burning) .. 1 (fully engulfed).
 */
import { YEAR_SECONDS } from '../../core/constants';
import { BUILDINGS } from '../../core/defs';
import type { Building, BuildingType, CauseOfDeath } from '../../core/types';
import { buildingCenter } from '../../core/world';
import type { Game } from '../game';
import { rt } from './runtime';
import { getServices, wellCoversBuilding, type ServiceIndex } from './services';
import {
  FIRE_BASE_RATE, FIRE_BURNOUT_SECONDS, FIRE_DEATH_CHANCE, FIRE_FIGHT_RATE, FIRE_GROWTH, FIRE_RAIN_DAMP,
  FIRE_SPREAD_CHANCE, FIRE_SPREAD_RANGE, FIRE_SPREAD_THRESHOLD, FIRE_START, FIRE_STONE_FACTOR, FIRE_SUMMER_FACTOR,
  FIRE_WELL_FACTOR, FIRE_WORKSHOP_FACTOR,
} from './tuning';
import { buildingName, footprintGap, pointInFootprint, seasonNow } from './util';

/** Structures that cannot burn (open zones, stone wells, pits). */
const NON_FLAMMABLE = new Set<BuildingType>(['well', 'cemetery', 'stockpile', 'cropField', 'orchard', 'pasture', 'quarry']);
/** Workshops with open flames. */
const FIRE_WORKSHOPS = new Set<BuildingType>(['blacksmith', 'brewery', 'tavern']);
/** Mostly-stone structures burn less readily. */
const STONE_BUILDINGS = new Set<BuildingType>(['stoneHouse', 'chapel', 'townHall']);

const FIRE_SOUND_INTERVAL = 4;

export function isFlammable(b: Building): boolean {
  return b.state === 'active' && !NON_FLAMMABLE.has(b.type) && !!BUILDINGS[b.type];
}

export interface IgniteOptions {
  /** 'random' (spontaneous), 'spread' (from a neighbour) or 'debug'. Affects the message text. */
  cause?: 'random' | 'spread' | 'debug' | 'tornado';
  silent?: boolean;
}

/** Set a building on fire. Returns false if it can't burn or is already burning. */
export function startFire(game: Game, b: Building, opts: IgniteOptions = {}): boolean {
  if (!isFlammable(b) || b.fire > 0) return false;
  const r = rt(game);
  b.fire = FIRE_START;
  r.burning.add(b.id);
  r.burnFull.delete(b.id);
  r.fireSound.set(b.id, 0);
  game.state.rev.buildings++;
  game.events.emit('fireStarted', { buildingId: b.id });
  const [cx, cz] = buildingCenter(b);
  game.events.emit('sound', { cue: 'bell', x: cx, z: cz });
  if (!opts.silent) {
    const name = buildingName(b);
    const covered = wellCoversBuilding(getServices(game), b);
    let text: string;
    if (opts.cause === 'spread') text = `The fire has spread to the ${name}!`;
    else if (covered) text = `Fire! The ${name} is burning. Townsfolk are running for buckets.`;
    else text = `Fire! The ${name} is burning and no well is close enough to fight it.`;
    game.addMessage(text, 'danger', { kind: 'building', id: b.id });
  }
  return true;
}

/** Yearly ignition rate for a building (see ARCHITECTURE §3.9). */
export function ignitionRate(game: Game, services: ServiceIndex, b: Building): number {
  let rate = FIRE_BASE_RATE;
  if (FIRE_WORKSHOPS.has(b.type)) rate *= FIRE_WORKSHOP_FACTOR;
  else if (BUILDINGS[b.type]?.housing && b.smoking) rate *= 1.5;
  if (STONE_BUILDINGS.has(b.type)) rate *= FIRE_STONE_FACTOR;
  if (seasonNow(game.state) === 'summer') rate *= FIRE_SUMMER_FACTOR;
  if (wellCoversBuilding(services, b)) rate *= FIRE_WELL_FACTOR;
  return rate;
}

/** Random ignitions (call ~1 Hz with the elapsed time). */
export function rollIgnitions(game: Game, tickDt: number): void {
  const services = getServices(game);
  const rng = game.rng;
  // Snapshot: startFire does not change the building list.
  for (const b of game.state.buildings) {
    if (b.fire > 0 || !isFlammable(b)) continue;
    const p = (ignitionRate(game, services, b) * tickDt) / YEAR_SECONDS;
    if (rng.next() < p) startFire(game, b, { cause: 'random' });
  }
}

/** Per-step fire simulation. `spreadTick` > 0 on the 1 Hz tick (seconds since last tick) to roll spreading. */
export function updateFires(game: Game, dt: number, spreadTick: number): void {
  const r = rt(game);
  const s = game.state;

  // Resync the burning set about once a second (fires may be set by debug tools or loaded from a save).
  r.fireScanTimer -= dt;
  if (r.fireScanTimer <= 0) {
    r.fireScanTimer = 1;
    for (const b of s.buildings) if (b.fire > 0 && b.state !== 'ruin') r.burning.add(b.id);
  }
  if (r.burning.size === 0) return;

  const services = getServices(game);
  const raining = s.weather.precipitation === 'rain' ? Math.max(0.3, s.weather.precipIntensity) : 0;
  const snowing = s.weather.precipitation === 'snow' ? 0.5 : 0;
  const destroy: Building[] = [];
  const spreaders: Building[] = [];

  for (const id of [...r.burning]) {
    const b = game.getBuilding(id);
    if (!b || b.state === 'ruin' || b.fire <= 0) {
      if (b && b.state === 'ruin') b.fire = 0;
      forget(game, id);
      continue;
    }
    let fire = b.fire + FIRE_GROWTH * (1 - 0.4 * raining) * dt;
    if (b.fireFighters > 0 && wellCoversBuilding(services, b)) fire -= b.fireFighters * FIRE_FIGHT_RATE * dt;
    fire -= FIRE_RAIN_DAMP * (raining + snowing) * dt;

    if (fire <= 0) {
      b.fire = 0;
      forget(game, id);
      s.rev.buildings++;
      game.addMessage(`The fire at the ${buildingName(b)} has been put out.`, 'good', { kind: 'building', id: b.id });
      continue;
    }
    b.fire = Math.min(1, fire);
    if (b.fire >= 1) {
      const t = (r.burnFull.get(id) ?? 0) + dt;
      r.burnFull.set(id, t);
      if (t >= FIRE_BURNOUT_SECONDS) {
        destroy.push(b);
        continue;
      }
    }
    if (b.fire > FIRE_SPREAD_THRESHOLD) spreaders.push(b);

    const snd = (r.fireSound.get(id) ?? 0) - dt;
    if (snd <= 0) {
      const [cx, cz] = buildingCenter(b);
      game.events.emit('sound', { cue: 'fire', x: cx, z: cz });
      r.fireSound.set(id, FIRE_SOUND_INTERVAL);
    } else {
      r.fireSound.set(id, snd);
    }
  }

  if (spreadTick > 0 && spreaders.length > 0) spreadFires(game, spreaders, spreadTick);
  for (const b of destroy) burnDown(game, b);
}

function spreadFires(game: Game, spreaders: Building[], tickDt: number): void {
  const s = game.state;
  const rng = game.rng;
  const wind = 1 + s.weather.windStrength;
  const damp = s.weather.precipitation === 'rain' ? 0.3 : s.weather.precipitation === 'snow' ? 0.5 : 1;
  for (const src of spreaders) {
    const strength = (src.fire - FIRE_SPREAD_THRESHOLD) / (1 - FIRE_SPREAD_THRESHOLD);
    for (const b of s.buildings) {
      if (b === src || b.fire > 0 || !isFlammable(b)) continue;
      const gap = footprintGap(src, b);
      if (gap > FIRE_SPREAD_RANGE) continue;
      const near = 1 - gap / (FIRE_SPREAD_RANGE + 1);
      let p = FIRE_SPREAD_CHANCE * near * strength * wind * damp * tickDt;
      if (STONE_BUILDINGS.has(b.type)) p *= FIRE_STONE_FACTOR;
      if (rng.next() < p) startFire(game, b, { cause: 'spread' });
    }
  }
}

/** The building is lost: citizens caught inside may die, then the building is removed. */
function burnDown(game: Game, b: Building): void {
  const s = game.state;
  const name = buildingName(b);
  const victims: number[] = [];
  for (const c of s.citizens) {
    if (c.activity === 'firefighting') continue;
    if (pointInFootprint(b, c.x, c.z) && game.rng.next() < FIRE_DEATH_CHANCE) victims.push(c.id);
  }
  const [cx, cz] = buildingCenter(b);
  const tile = Math.min(s.H - 1, Math.max(0, Math.floor(cz))) * s.W + Math.min(s.W - 1, Math.max(0, Math.floor(cx)));
  forget(game, b.id);
  game.removeBuilding(b.id, 'fire');
  const still = game.getBuilding(b.id);
  if (still) still.fire = 0; // left behind as a ruin
  game.addMessage(`The ${name} burned to the ground.`, 'danger', still ? { kind: 'building', id: b.id } : { kind: 'tile', id: tile });
  const cause: CauseOfDeath = 'fire';
  for (const id of victims) if (game.getCitizen(id)) game.killCitizen(id, cause);
}

function forget(game: Game, id: number): void {
  const r = rt(game);
  r.burning.delete(id);
  r.burnFull.delete(id);
  r.fireSound.delete(id);
}

/** Number of buildings currently burning. */
export function burningCount(game: Game): number {
  return rt(game).burning.size;
}
