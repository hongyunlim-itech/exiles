/**
 * Disease: infection, progression, treatment (herbs at home, hospitals) and spread between citizens.
 * Citizen.sick is 0 (healthy) .. 1 (gravely ill). Written only here (and via infectCitizen from disasters/nomads).
 */
import { ADULT_AGE, ELDERLY_AGE, MONTH_SECONDS } from '../../core/constants';
import type { Building, Citizen, ResourceType } from '../../core/types';
import type { Game } from '../game';
import { anchorOf, homeHasHerbs } from './factors';
import { rt } from './runtime';
import { getServices, hospitalCovering } from './services';
import {
  CONTACT_INFECTION, CONTACT_RADIUS, DISEASE_COURSE_RECOVERY, DISEASE_HERB_RECOVERY, DISEASE_HOSPITAL_RECOVERY, DISEASE_NATURAL_RECOVERY,
  DISEASE_PROGRESS, HERBS_INFECTION_FACTOR, HOME_HERBS_PER_MONTH, HOSPITAL_HERBS_PER_MONTH, HOUSEHOLD_INFECTION,
  IMMUNITY_SECONDS,
} from './tuning';
import { clamp, consumeFrom } from './util';

/** Seconds between disease spread / treatment bookkeeping ticks. */
const DISEASE_TICK = 1;

export interface InfectOptions {
  /** Ignore post-recovery immunity (outbreak patient zero, sick newcomers). */
  force?: boolean;
  /** Post a message if this starts a new outbreak. */
  announce?: boolean;
}

/**
 * Make a citizen sick with the given initial severity. Returns true if the citizen became (or already was) sick.
 * Starting the first case while no outbreak is active marks an outbreak as running.
 */
export function infectCitizen(game: Game, c: Citizen, severity: number, opts: InfectOptions = {}): boolean {
  const r = rt(game);
  if (c.sick > 0) return true;
  if (!opts.force && (r.immuneUntil.get(c.id) ?? -1) > game.state.time.elapsed) return false;
  c.sick = clamp(severity, 0.05, 1);
  if (!r.outbreakActive) {
    r.outbreakActive = true;
    if (opts.announce) {
      game.addMessage(
        `${c.name} has fallen ill and the sickness is spreading. Herbs and a Hospital will help.`,
        'danger',
        { kind: 'citizen', id: c.id },
      );
    }
  }
  return true;
}

/** How easily a healthy citizen catches the disease (multiplier). */
export function susceptibility(c: Citizen, herbsHome: boolean): number {
  let s = 0.5 + (100 - clamp(c.health, 0, 100)) / 100;
  if (c.age < ADULT_AGE || c.age >= ELDERLY_AGE) s *= 1.3;
  if (herbsHome) s *= HERBS_INFECTION_FACTOR;
  return s;
}

/** Severity change per second for a sick citizen (sick for `monthsSick` months). Negative = recovering. */
export function diseaseRate(c: Citizen, herbsHome: boolean, treated: boolean, monthsSick = 0): number {
  let rate = DISEASE_PROGRESS - DISEASE_NATURAL_RECOVERY * (clamp(c.health, 0, 100) / 100) -
    DISEASE_COURSE_RECOVERY * Math.max(0, monthsSick);
  if (herbsHome) rate -= DISEASE_HERB_RECOVERY;
  if (treated) rate -= DISEASE_HOSPITAL_RECOVERY;
  return rate;
}

/**
 * Per-step disease progression for every sick citizen, plus a 1 Hz tick for spreading and herb consumption.
 * Uses the wellbeing cache for herbs/treatment flags (falls back to "no help").
 */
export function updateDisease(game: Game, dt: number): void {
  const r = rt(game);
  const s = game.state;
  let anySick = false;

  const now = s.time.elapsed;
  for (const c of s.citizens) {
    if (c.sick <= 0) continue;
    anySick = true;
    const cache = r.cache.get(c.id);
    let since = r.sickSince.get(c.id);
    if (since === undefined) {
      since = now;
      r.sickSince.set(c.id, now);
    }
    const months = (now - since) / MONTH_SECONDS;
    const next = c.sick + diseaseRate(c, cache?.herbsHome ?? false, cache?.treated ?? false, months) * dt;
    if (next <= 0) {
      c.sick = 0;
      r.sickSince.delete(c.id);
      r.immuneUntil.set(c.id, s.time.elapsed + IMMUNITY_SECONDS);
    } else {
      c.sick = Math.min(1, next);
    }
  }

  r.diseaseTimer += dt;
  if (r.diseaseTimer < DISEASE_TICK) return;
  const tickDt = r.diseaseTimer;
  r.diseaseTimer = 0;

  if (!anySick) {
    if (r.outbreakActive) {
      r.outbreakActive = false;
      if (s.citizens.length > 0) game.addMessage('The sickness has passed. The town breathes easier.', 'good');
    }
    return;
  }
  r.outbreakActive = true;
  spreadAndTreat(game, tickDt);
}

function spreadAndTreat(game: Game, tickDt: number): void {
  const r = rt(game);
  const s = game.state;
  const services = getServices(game);
  const now = s.time.elapsed;
  const newlySick: Citizen[] = [];
  const rng = game.rng;
  const cr2 = CONTACT_RADIUS * CONTACT_RADIUS;

  // Snapshot of sick citizens so fresh infections don't spread within the same tick.
  const sickList: Citizen[] = [];
  for (const c of s.citizens) if (c.sick > 0) sickList.push(c);

  const tryInfect = (t: Citizen, p: number) => {
    if (t.sick > 0 || newlySick.includes(t)) return;
    if ((r.immuneUntil.get(t.id) ?? -1) > now) return;
    const home = t.homeId >= 0 ? game.getBuilding(t.homeId) ?? null : null;
    if (rng.next() < p * susceptibility(t, homeHasHerbs(home))) newlySick.push(t);
  };

  for (const sc of sickList) {
    // Household contacts.
    const home = sc.homeId >= 0 ? game.getBuilding(sc.homeId) : undefined;
    if (home) {
      const pHouse = HOUSEHOLD_INFECTION * sc.sick * tickDt;
      for (const rid of home.residentIds) {
        if (rid === sc.id) continue;
        const t = game.getCitizen(rid);
        if (t) tryInfect(t, pHouse);
      }
    }
    // Close contacts anywhere in town.
    const pContact = CONTACT_INFECTION * sc.sick * tickDt;
    for (const t of s.citizens) {
      if (t === sc || t.sick > 0) continue;
      const dx = t.x - sc.x;
      const dz = t.z - sc.z;
      if (dx * dx + dz * dz <= cr2) tryInfect(t, pContact);
    }

    // Treatment consumes herbs: the hospital first, otherwise the household's own supply.
    const anchor = anchorOf(game, sc);
    const hospital = hospitalCovering(services, anchor.x, anchor.z);
    if (hospital) {
      useHerbs(game, hospital.id, (HOSPITAL_HERBS_PER_MONTH / MONTH_SECONDS) * tickDt);
    } else if (anchor.home && homeHasHerbs(anchor.home)) {
      useHerbs(game, anchor.home.id, (HOME_HERBS_PER_MONTH / MONTH_SECONDS) * tickDt);
    }
  }

  for (const t of newlySick) infectCitizen(game, t, 0.25 + rng.next() * 0.25);
}

/** Use herbs from a building (see useSupply). */
export function useHerbs(game: Game, buildingId: number, amount: number): void {
  const b = game.getBuilding(buildingId);
  if (b) useSupply(game, b, 'herbs', amount);
}

/**
 * Consume a fractional amount of a supply from a building's inventory. Whole units are taken up-front (the first
 * use of a fresh unit removes it immediately) and the remainder is kept as per-building credit, so small ongoing
 * uses still visibly consume stock. Returns false when nothing was available.
 */
export function useSupply(game: Game, b: Building, type: ResourceType, amount: number): boolean {
  const r = rt(game);
  let credit = (r.consumption.get(b.id) ?? 0) - amount;
  while (credit < 0) {
    if (consumeFrom(b, type, 1) < 1) {
      r.consumption.set(b.id, 0);
      return false;
    }
    credit += 1;
  }
  r.consumption.set(b.id, credit);
  return true;
}

/** Number of currently sick citizens. */
export function countSick(game: Game): number {
  let n = 0;
  for (const c of game.state.citizens) if (c.sick > 0) n++;
  return n;
}
