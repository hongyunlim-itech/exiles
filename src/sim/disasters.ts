/**
 * Disasters: fire (start/spread/extinguish), tornadoes, disease outbreaks. OWNER: sim-ext agent.
 *
 * - Fires and an active tornado are always simulated (so debug-started ones play out), but random ignitions,
 *   tornadoes and outbreaks only happen when `settings.disasters` is on (after a short grace period).
 * - See ext/fire.ts, ext/tornado.ts, ext/outbreak.ts for the details and ext/tuning.ts for the numbers.
 */
import type { Citizen } from '../core/types';
import { countSick, infectCitizen } from './ext/disease';
import { burningCount, ignitionRate, rollIgnitions, startFire, updateFires } from './ext/fire';
import { addOutbreakRisk, decayOutbreakRisk, outbreakRate, rollOutbreak, startOutbreak } from './ext/outbreak';
import { rt } from './ext/runtime';
import { rollTornado, spawnTornadoNow, updateTornado } from './ext/tornado';
import { DISASTER_GRACE, FIRE_GRACE } from './ext/tuning';
import type { Game } from './game';

export { addOutbreakRisk, burningCount, countSick, ignitionRate, infectCitizen, outbreakRate, startOutbreak };

/** Seconds between random-event rolls. */
const ROLL_TICK = 1;

export function updateDisasters(game: Game, dt: number): void {
  if (!(dt > 0)) return;
  const s = game.state;
  const r = rt(game);

  r.disasterTimer += dt;
  let tick = 0;
  if (r.disasterTimer >= ROLL_TICK) {
    tick = r.disasterTimer;
    r.disasterTimer = 0;
  }

  updateFires(game, dt, tick);
  updateTornado(game, dt);

  if (tick <= 0) return;
  decayOutbreakRisk(game, tick);
  if (!s.settings.disasters || s.gameOver || s.citizens.length === 0) return;

  const elapsed = s.time.elapsed;
  if (elapsed >= FIRE_GRACE) rollIgnitions(game, tick);
  if (elapsed >= DISASTER_GRACE) {
    rollTornado(game, tick);
    rollOutbreak(game, tick);
  }
}

/** Set a building on fire (also used by debug tools). */
export function igniteBuilding(game: Game, buildingId: number): void {
  const b = game.getBuilding(buildingId);
  if (b) startFire(game, b, { cause: 'debug' });
}

/** Spawn a tornado at a random map edge heading across the map (debug + random event). */
export function spawnTornado(game: Game): void {
  spawnTornadoNow(game);
}

/** Debug: make a citizen sick right now. */
export function makeSick(game: Game, c: Citizen, severity = 0.5): void {
  infectCitizen(game, c, severity, { force: true, announce: true });
}
