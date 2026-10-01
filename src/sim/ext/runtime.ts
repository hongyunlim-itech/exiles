/**
 * Per-game runtime caches for the sim-ext modules. Derived indexes (service coverage) are rebuilt after loading;
 * everything that changes behaviour (advisor cooldowns, disease immunity, fire burn-out timers, tornado victim rolls,
 * tick phases, the wellbeing evaluation cache) is written to GameState.ext on save (persistExtRuntime) and restored
 * when the runtime is created for a loaded game, so a loaded game continues exactly like the original.
 */
import type { SimExtState } from '../../core/types';
import type { Game } from '../game';
import type { ServiceIndex } from './services';

/** Cached per-citizen wellbeing evaluation (refreshed about once per game second). */
export interface CitizenCache {
  healthTarget: number;
  happinessTarget: number;
  /** Covered by a staffed hospital that has herbs. */
  treated: boolean;
  /** The citizen's household has herbs available. */
  herbsHome: boolean;
  /** Home building id used for herbs/hospital bookkeeping (-1 homeless). */
  homeId: number;
}

export interface ExtRuntime {
  // wellbeing
  cache: Map<number, CitizenCache>;
  evalCursor: number;
  evalCarry: number;
  services: ServiceIndex | null;
  serviceTimer: number;
  serviceRev: number;
  /** Game time (state.time.elapsed) the service index was built at (runtime only; see getServices). */
  serviceStamp: number;
  /** Fractional herb/ale consumption accumulators per building id. */
  consumption: Map<number, number>;
  /** Accumulator for the 1 Hz service bookkeeping tick (ale, household herbs). */
  slowTimer: number;
  burialTimer: number;
  cleanupTimer: number;

  // disease
  /** Citizen id -> game time until which the citizen is immune. */
  immuneUntil: Map<number, number>;
  /** Citizen id -> game time the current illness started. */
  sickSince: Map<number, number>;
  diseaseTimer: number;
  /** Extra outbreak rate per year (decays). */
  outbreakRisk: number;
  outbreakActive: boolean;

  // disasters
  burning: Set<number>;
  /** Building id -> seconds spent at full intensity. */
  burnFull: Map<number, number>;
  /** Building id -> seconds until next crackle sound. */
  fireSound: Map<number, number>;
  fireScanTimer: number;
  disasterTimer: number;
  tornadoRolled: Set<number>;
  tornadoDestroyed: number;
  tornadoKilled: number;
  tornadoTrees: number;
  /** Current turn rate of the tornado (radians / second). */
  tornadoTurn: number;

  // stats
  lastSampleKey: number;
  advisorTimer: number;
  advisorNext: Map<string, number>;
}

const runtimes = new WeakMap<object, ExtRuntime>();

function createRuntime(): ExtRuntime {
  return {
    cache: new Map(),
    evalCursor: 0,
    evalCarry: 0,
    services: null,
    serviceTimer: 0,
    serviceRev: -1,
    serviceStamp: Number.NaN,
    consumption: new Map(),
    slowTimer: 0,
    burialTimer: 0,
    cleanupTimer: 0,
    immuneUntil: new Map(),
    sickSince: new Map(),
    diseaseTimer: 0,
    outbreakRisk: 0,
    outbreakActive: false,
    burning: new Set(),
    burnFull: new Map(),
    fireSound: new Map(),
    fireScanTimer: 0,
    disasterTimer: 0,
    tornadoRolled: new Set(),
    tornadoDestroyed: 0,
    tornadoKilled: 0,
    tornadoTrees: 0,
    tornadoTurn: 0,
    lastSampleKey: -1,
    advisorTimer: 0,
    advisorNext: new Map(),
  };
}

/** Runtime caches for a game (created lazily; restored from GameState.ext for a loaded game). */
export function rt(game: Game): ExtRuntime {
  let r = runtimes.get(game);
  if (!r) {
    r = createRuntime();
    runtimes.set(game, r);
    try {
      hydrate(game, r);
    } catch {
      /* malformed ext state in an old/corrupt save: start fresh */
    }
  }
  return r;
}

/** Timer / cursor fields of ExtRuntime saved under SimExtState.timers. */
const TIMER_KEYS = [
  'evalCursor', 'evalCarry', 'serviceTimer', 'slowTimer', 'burialTimer', 'cleanupTimer', 'diseaseTimer', 'fireScanTimer',
  'disasterTimer', 'tornadoDestroyed', 'tornadoKilled', 'tornadoTrees', 'tornadoTurn', 'lastSampleKey', 'advisorTimer',
] as const satisfies readonly (keyof ExtRuntime)[];

function numRecord<K>(m: Map<K, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of m) if (Number.isFinite(v)) out[String(k)] = v;
  return out;
}

/** Write the behaviour-relevant runtime state into GameState.ext (call right before serialising). */
export function persistExtRuntime(game: Game): void {
  const r = runtimes.get(game);
  if (!r) return; // never stepped since creation/load: whatever is in state.ext is still current
  const timers: Record<string, number> = {};
  for (const k of TIMER_KEYS) timers[k] = r[k];
  const wellbeing: NonNullable<SimExtState['wellbeing']> = {};
  for (const [id, c] of r.cache) {
    wellbeing[String(id)] = [c.healthTarget, c.happinessTarget, c.treated ? 1 : 0, c.herbsHome ? 1 : 0, c.homeId];
  }
  game.state.ext = {
    advisorNext: numRecord(r.advisorNext),
    immuneUntil: numRecord(r.immuneUntil),
    sickSince: numRecord(r.sickSince),
    burnFull: numRecord(r.burnFull),
    consumption: numRecord(r.consumption),
    tornadoRolled: [...r.tornadoRolled],
    outbreakRisk: r.outbreakRisk,
    outbreakActive: r.outbreakActive,
    timers,
    wellbeing,
  };
}

function hydrate(game: Game, r: ExtRuntime): void {
  const s = game.state;
  const e = s.ext;
  // fires in progress keep burning right away (the 1 Hz rescan would pick them up a moment later otherwise)
  for (const b of s.buildings) if (b.fire > 0 && b.state !== 'ruin') r.burning.add(b.id);
  if (!e || typeof e !== 'object') return;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const [k, v] of Object.entries(e.advisorNext ?? {})) if (num(v) !== null) r.advisorNext.set(k, v);
  for (const [k, v] of Object.entries(e.immuneUntil ?? {})) if (num(v) !== null) r.immuneUntil.set(Number(k), v);
  for (const [k, v] of Object.entries(e.sickSince ?? {})) if (num(v) !== null) r.sickSince.set(Number(k), v);
  for (const [k, v] of Object.entries(e.burnFull ?? {})) if (num(v) !== null) r.burnFull.set(Number(k), v);
  for (const [k, v] of Object.entries(e.consumption ?? {})) if (num(v) !== null) r.consumption.set(Number(k), v);
  if (Array.isArray(e.tornadoRolled)) for (const id of e.tornadoRolled) if (num(id) !== null) r.tornadoRolled.add(id);
  if (num(e.outbreakRisk) !== null) r.outbreakRisk = e.outbreakRisk!;
  if (typeof e.outbreakActive === 'boolean') r.outbreakActive = e.outbreakActive;
  if (e.timers && typeof e.timers === 'object') {
    for (const k of TIMER_KEYS) {
      const v = num(e.timers[k]);
      if (v !== null) r[k] = v;
    }
  }
  for (const [k, v] of Object.entries(e.wellbeing ?? {})) {
    if (!Array.isArray(v) || v.length < 5 || !v.every((x) => num(x) !== null)) continue;
    r.cache.set(Number(k), { healthTarget: v[0], happinessTarget: v[1], treated: v[2] !== 0, herbsHome: v[3] !== 0, homeId: v[4] });
  }
}

/** Drop the runtime for a game (tests). */
export function resetRuntime(game: Game): void {
  runtimes.delete(game);
}
