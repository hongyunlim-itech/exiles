/**
 * Health, happiness, education, disease progression & service effects (well, school, hospital, chapel, tavern,
 * cemetery). OWNER: sim-ext agent. Sole writer of Citizen.health / happiness / education / sick.
 *
 * Model (ARCHITECTURE §3.8):
 * - Health and happiness drift exponentially toward a target = sum of factors (see ext/factors.ts). Slow factors
 *   (service coverage, home, herbs) are evaluated for every citizen about once per game second in rotating batches;
 *   acute effects (starving, freezing, disease) drain health every step from live values.
 * - Health 0 -> death via game.killCitizen (starvation / freezing / disease / old age).
 * - Students `studying` at a staffed school gain education (~4 years of school -> 1.0).
 * - Grief decays over ~8 months; unburied dead are moved into free cemetery graves over time.
 * - Taverns pour ale for the people they cover; households slowly use herbs; hospitals use herbs to treat.
 */
import { MONTH_SECONDS } from '../core/constants';
import type { CauseOfDeath, Citizen } from '../core/types';
import { updateDisease, useHerbs, useSupply } from './ext/disease';
import {
  anchorOf, citizenCoverage, computeHappinessFactors, computeHealthFactors, homeHasHerbs, sumFactors,
} from './ext/factors';
import { rt, type CitizenCache } from './ext/runtime';
import { COVER_HOSPITAL, getServices, graveCapacity, tickServices, type ServiceIndex } from './ext/services';
import {
  ALE_PER_CITIZEN_MONTH, BURIAL_INTERVAL, DISEASE_DRAIN, EDUCATION_RATE, EVAL_PERIOD, FREEZE_DRAIN, GRIEF_DURATION,
  HAPPINESS_MAX_RATE, HAPPINESS_TAU, HEALTH_MAX_RATE, HEALTH_TAU_DOWN, HEALTH_TAU_UP, HOUSE_HERB_INTERVAL, STARVE_DRAIN,
  TREATED_DRAIN_FACTOR,
} from './ext/tuning';
import { availableIn, clamp, pointInFootprint } from './ext/util';
import type { Game } from './game';
import * as dm from './core/dmath';

export interface Factor {
  label: string;
  /** Signed contribution (points). */
  value: number;
}

/** Below this happiness citizens work at UNHAPPY_EFFICIENCY. */
export const UNHAPPY_LEVEL = 30;
export const UNHAPPY_EFFICIENCY = 0.7;

/** Seconds between the 1 Hz service bookkeeping ticks (ale, household herbs). */
const SLOW_TICK = 1;
const CLEANUP_INTERVAL = 10;

export function updateWellbeing(game: Game, dt: number): void {
  if (!(dt > 0)) return;
  const s = game.state;
  const r = rt(game);
  tickServices(game, dt);
  const services = getServices(game);

  evaluateBatch(game, services, dt);

  const deaths: { id: number; cause: CauseOfDeath }[] = [];
  const griefDecay = (100 / GRIEF_DURATION) * dt;
  const healthUp = 1 - dm.exp(-dt / HEALTH_TAU_UP);
  const healthDown = 1 - dm.exp(-dt / HEALTH_TAU_DOWN);
  const happyK = 1 - dm.exp(-dt / HAPPINESS_TAU);

  for (const c of s.citizens) {
    const cache = r.cache.get(c.id) ?? evaluateCitizen(game, services, c);

    // ---- health ----
    let health = sanitize(c.health, 70);
    const diff = cache.healthTarget - health;
    let delta = clamp(diff * (diff > 0 ? healthUp : healthDown), -HEALTH_MAX_RATE * dt, HEALTH_MAX_RATE * dt);
    if (c.food <= 0.5) delta -= STARVE_DRAIN * dt;
    if (c.warmth <= 0.5) delta -= FREEZE_DRAIN * dt;
    if (c.sick > 0) delta -= DISEASE_DRAIN * c.sick * (cache.treated ? TREATED_DRAIN_FACTOR : 1) * dt;
    health = clamp(health + delta, 0, 100);
    c.health = health;
    if (health <= 0) deaths.push({ id: c.id, cause: deathCause(c) });

    // ---- happiness ----
    const happiness = sanitize(c.happiness, 50);
    const hd = clamp((cache.happinessTarget - happiness) * happyK, -HAPPINESS_MAX_RATE * dt, HAPPINESS_MAX_RATE * dt);
    c.happiness = clamp(happiness + hd, 0, 100);

    // ---- grief ----
    if (c.grief > 0) c.grief = Math.max(0, c.grief - griefDecay);

    // ---- education ----
    if (c.activity === 'studying' && c.education < 1 && atStaffedSchool(services, c)) {
      c.education = Math.min(1, sanitize(c.education, 0) + EDUCATION_RATE * dt);
    }
  }

  updateDisease(game, dt);

  slowTick(game, services, dt);
  updateBurials(game, services, dt);

  for (const d of deaths) {
    if (game.getCitizen(d.id)) game.killCitizen(d.id, d.cause);
  }

  r.cleanupTimer += dt;
  if (r.cleanupTimer >= CLEANUP_INTERVAL) {
    r.cleanupTimer = 0;
    cleanup(game);
  }
}

/** Breakdown of what is affecting a citizen's happiness (UI tooltip). First entry is the base value; the values
 *  sum to the level the citizen's happiness is drifting toward. */
export function happinessFactors(game: Game, c: Citizen): Factor[] {
  const services = getServices(game);
  const anchor = anchorOf(game, c);
  return computeHappinessFactors(game.state, c, anchor, citizenCoverage(services, anchor));
}

/** Breakdown of what is affecting a citizen's health (UI tooltip). First entry is the base value; the values sum to
 *  the level the citizen's health is drifting toward (starving/freezing/disease also drain health directly). */
export function healthFactors(game: Game, c: Citizen): Factor[] {
  const services = getServices(game);
  const anchor = anchorOf(game, c);
  return computeHealthFactors(c, anchor, citizenCoverage(services, anchor));
}

/** Work speed multiplier from wellbeing (happiness, health, education), ~0.5..1.3. Used by sim-core behavior. */
export function wellbeingEfficiency(c: Citizen): number {
  const happiness = clamp(sanitize(c.happiness, 50), 0, 100);
  const education = clamp(sanitize(c.education, 0), 0, 1);
  let e = 0.6 + 0.4 * (happiness / 100) + 0.25 * education;
  // miserable people barely work; the sick and weak neither
  if (happiness < UNHAPPY_LEVEL) e *= UNHAPPY_EFFICIENCY;
  if (sanitize(c.health, 100) < 30) e *= 0.7;
  if (c.sick > 0) e *= 1 - 0.3 * clamp(c.sick, 0, 1);
  return clamp(e, 0.35, 1.3);
}

/** Target levels the citizen's health / happiness are currently drifting toward (UI: arrows up/down). */
export function wellbeingTargets(game: Game, c: Citizen): { health: number; happiness: number } {
  const cache = rt(game).cache.get(c.id) ?? evaluateCitizen(game, getServices(game), c);
  return { health: cache.healthTarget, happiness: cache.happinessTarget };
}

/** Short word for a 0..100 wellbeing value (UI). */
export function conditionLabel(value: number): string {
  if (value >= 85) return 'Excellent';
  if (value >= 65) return 'Good';
  if (value >= 45) return 'Fair';
  if (value >= 25) return 'Poor';
  return 'Critical';
}

// ---------------------------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------------------------

function sanitize(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function deathCause(c: Citizen): CauseOfDeath {
  if (c.food <= 1) return 'starvation';
  if (c.warmth <= 1) return 'freezing';
  if (c.sick > 0) return 'disease';
  return 'oldAge';
}

/** Evaluate (and cache) a citizen's slow wellbeing factors. */
function evaluateCitizen(game: Game, services: ServiceIndex, c: Citizen): CitizenCache {
  const r = rt(game);
  const anchor = anchorOf(game, c);
  const cover = citizenCoverage(services, anchor);
  const healthTarget = clamp(sumFactors(computeHealthFactors(c, anchor, cover)), 0, 100);
  const happinessTarget = clamp(sumFactors(computeHappinessFactors(game.state, c, anchor, cover)), 0, 100);
  let entry = r.cache.get(c.id);
  if (!entry) {
    entry = { healthTarget, happinessTarget, treated: false, herbsHome: false, homeId: -1 };
    r.cache.set(c.id, entry);
  }
  entry.healthTarget = healthTarget;
  entry.happinessTarget = happinessTarget;
  entry.treated = (cover & COVER_HOSPITAL) !== 0;
  entry.herbsHome = homeHasHerbs(anchor.home);
  entry.homeId = anchor.home ? anchor.home.id : -1;
  return entry;
}

/** Re-evaluate a rotating slice of citizens so everyone is refreshed about once per EVAL_PERIOD. */
function evaluateBatch(game: Game, services: ServiceIndex, dt: number): void {
  const r = rt(game);
  const list = game.state.citizens;
  if (list.length === 0) return;
  r.evalCarry += (list.length * dt) / EVAL_PERIOD;
  let n = Math.min(list.length, Math.floor(r.evalCarry));
  r.evalCarry -= n;
  if (r.evalCarry > list.length) r.evalCarry = 0;
  while (n-- > 0) {
    if (r.evalCursor >= list.length) r.evalCursor = 0;
    evaluateCitizen(game, services, list[r.evalCursor]);
    r.evalCursor++;
  }
}

function atStaffedSchool(services: ServiceIndex, c: Citizen): boolean {
  for (const p of services.schools) {
    if (pointInFootprint(p.b, c.x, c.z, 3)) return true;
  }
  return false;
}

/** 1 Hz: ale poured by taverns, herbs used up by households. */
function slowTick(game: Game, services: ServiceIndex, dt: number): void {
  const r = rt(game);
  r.slowTimer += dt;
  if (r.slowTimer < SLOW_TICK) return;
  const acc = r.slowTimer;
  r.slowTimer = 0;

  // Taverns pour ale for the residents they cover.
  for (const t of services.taverns) {
    let covered = 0;
    const r2 = t.r * t.r;
    for (const h of services.houses) {
      if (h.residentIds.length === 0) continue;
      const dx = h.x + h.w / 2 - t.cx;
      const dz = h.z + h.h / 2 - t.cz;
      if (dx * dx + dz * dz <= r2) covered += h.residentIds.length;
    }
    if (covered === 0) continue;
    useSupply(game, t.b, 'ale', ((covered * ALE_PER_CITIZEN_MONTH) / MONTH_SECONDS) * acc);
  }

  // Households slowly use up their herbs (medicine for everyday ailments).
  for (const h of services.houses) {
    if (h.residentIds.length === 0 || availableIn(h, 'herbs') <= 0) continue;
    useHerbs(game, h.id, acc / HOUSE_HERB_INTERVAL);
  }
}

/** Move unburied dead into free cemetery graves, one at a time. */
function updateBurials(game: Game, services: ServiceIndex, dt: number): void {
  const s = game.state;
  const r = rt(game);
  if (s.unburied <= 0) {
    r.burialTimer = 0;
    return;
  }
  r.burialTimer += dt;
  if (r.burialTimer < BURIAL_INTERVAL) return;
  r.burialTimer = 0;
  for (const cem of services.cemeteries) {
    if (cem.state !== 'active') continue;
    const used = cem.graves ?? 0;
    if (used >= graveCapacity(cem)) continue;
    cem.graves = used + 1;
    s.unburied = Math.max(0, s.unburied - 1);
    s.rev.buildings++;
    if (s.unburied === 0) game.addMessage('The dead have been laid to rest in the cemetery.', 'good', { kind: 'building', id: cem.id });
    break;
  }
}

/** Drop cached entries of citizens / buildings that no longer exist. */
function cleanup(game: Game): void {
  const r = rt(game);
  for (const id of r.cache.keys()) if (!game.getCitizen(id)) r.cache.delete(id);
  const now = game.state.time.elapsed;
  for (const [id, until] of r.immuneUntil) if (until <= now || !game.getCitizen(id)) r.immuneUntil.delete(id);
  for (const id of r.sickSince.keys()) if (!game.getCitizen(id)) r.sickSince.delete(id);
  for (const id of r.consumption.keys()) if (!game.getBuilding(id)) r.consumption.delete(id);
}
