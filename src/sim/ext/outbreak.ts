/**
 * Random disease outbreaks. More likely after merchants or nomads arrive (risk added via addOutbreakRisk) and in
 * winter. The spreading itself is handled by ext/disease.ts.
 */
import { ADULT_AGE, YEAR_SECONDS } from '../../core/constants';
import type { Citizen } from '../../core/types';
import type { Game } from '../game';
import { infectCitizen } from './disease';
import { rt } from './runtime';
import { OUTBREAK_BASE_RATE, OUTBREAK_MIN_POP, OUTBREAK_RISK_DECAY } from './tuning';
import { isWinterMonth } from './util';
import * as dm from '../core/dmath';

/** Raise the extra yearly outbreak rate (decays over a few months). */
export function addOutbreakRisk(game: Game, amount: number): void {
  const r = rt(game);
  r.outbreakRisk = Math.min(4, r.outbreakRisk + amount);
}

/** Decay the extra outbreak risk. */
export function decayOutbreakRisk(game: Game, dt: number): void {
  const r = rt(game);
  if (r.outbreakRisk > 0) r.outbreakRisk *= dm.exp(-dt / OUTBREAK_RISK_DECAY);
  if (r.outbreakRisk < 1e-4) r.outbreakRisk = 0;
}

/** Current yearly outbreak rate (for tests/debug). */
export function outbreakRate(game: Game): number {
  const winter = isWinterMonth(game.state.time.month) ? 1.5 : 1;
  return OUTBREAK_BASE_RATE * winter + rt(game).outbreakRisk;
}

/** Roll for a random outbreak. Call ~1 Hz. */
export function rollOutbreak(game: Game, tickDt: number): void {
  const r = rt(game);
  if (r.outbreakActive || game.state.citizens.length < OUTBREAK_MIN_POP) return;
  const p = (outbreakRate(game) * tickDt) / YEAR_SECONDS;
  if (game.rng.next() < p) startOutbreak(game);
}

/**
 * Start an outbreak now: patient zero (preferably an adult, near `near` if given) plus possibly household members
 * fall ill. `intro` replaces the first sentence of the message. Returns patient zero, or null if nobody is left.
 */
export function startOutbreak(game: Game, near?: { x: number; z: number }, intro?: string): Citizen | null {
  const s = game.state;
  const candidates = s.citizens.filter((c) => c.sick <= 0);
  if (candidates.length === 0) return null;
  let pool = candidates.filter((c) => c.age >= ADULT_AGE);
  if (pool.length === 0) pool = candidates;
  let zero: Citizen;
  if (near) {
    pool.sort((a, b) => dm.hypot(a.x - near.x, a.z - near.z) - dm.hypot(b.x - near.x, b.z - near.z));
    zero = pool[Math.min(pool.length - 1, game.rng.int(0, 2))];
  } else {
    zero = game.rng.pick(pool);
  }
  infectCitizen(game, zero, 0.4 + game.rng.next() * 0.2, { force: true });
  rt(game).outbreakActive = true;

  // Often a family member is already coughing too.
  if (zero.homeId >= 0) {
    const home = game.getBuilding(zero.homeId);
    if (home) {
      for (const id of home.residentIds) {
        const c = id !== zero.id ? game.getCitizen(id) : undefined;
        if (c && game.rng.next() < 0.35) infectCitizen(game, c, 0.25 + game.rng.next() * 0.2, { force: true });
      }
    }
  }
  game.addMessage(
    `${intro ?? `Sickness has broken out in ${s.settings.townName}.`} ${zero.name} is the first to fall ill — herbs and a Hospital will help.`,
    'danger',
    { kind: 'citizen', id: zero.id },
  );
  return zero;
}
