/**
 * Citizen behaviour data model: the opaque `Citizen.task` holds a {@link Brain} (planner memory + current task).
 * A {@link Task} is a JSON-serializable list of {@link Step}s executed in order, plus the {@link Claim}s
 * (reservations) it holds. Every claim is released when the task completes or aborts, so reservations can never
 * leak. OWNER: sim-core.
 */
import type { Activity, Citizen, Inventory, ResourceType } from '../../core/types';

/** A reservation held by a task. Released on completion/abort (see claims.ts). */
export type Claim =
  /** Items promised for pickup from building `b` (Building.reservedOut). */
  | { k: 'out'; b: number; r: ResourceType; n: number }
  /** Storage capacity promised in building `b` (Building.reservedIn). */
  | { k: 'in'; b: number; n: number }
  /** Construction materials on the way to site `b` (Building.incoming). */
  | { k: 'inc'; b: number; r: ResourceType; n: number }
  /** Exclusive work claim on a tile (feature to clear, field tile, sapling spot...). */
  | { k: 'tile'; i: number }
  /** Deer reserved by a hunter (Animal.huntedBy). */
  | { k: 'deer'; a: number }
  /** This citizen is the household supply fetcher of house `b`. */
  | { k: 'fetch'; b: number }
  /** A worker slot on a construction / demolition site `b` (limits crowding). */
  | { k: 'site'; b: number };

export type Step =
  /** Path-find to tile (x, z) (adjacent tile if blocked). Fails if building `b` vanished or unreachable. */
  | { op: 'go'; x: number; z: number; b?: number; tries?: number }
  /** Walk in a straight line to world point (x, z) — used to step inside/out of buildings. */
  | { op: 'direct'; x: number; z: number; inside?: number }
  /** Timed activity (loiter, play, track...). Fails if building `b` given and gone. */
  | { op: 'wait'; t: number; act: Activity; b?: number }
  /** Take every 'out' claim on building b into the hands. */
  | { op: 'pickup'; b: number }
  /** Put the carried load into building b (storage, site, house, workplace buffer). */
  | { op: 'deposit'; b: number }
  /** Chop a tree on tile i (logs into hands). `b`: workplace credited with the logs (forester). */
  | { op: 'chop'; i: number; b?: number }
  /** Quarry a rock/iron deposit on tile i (one load into hands). */
  | { op: 'mineRock'; i: number }
  | { op: 'build'; b: number }
  | { op: 'demolish'; b: number }
  | { op: 'eat'; b: number }
  | { op: 'warm'; b: number }
  | { op: 'rest'; t: number; b: number }
  /** Workshop batch. `r` = recipe index. Inputs are claimed ('out') on the workshop itself. */
  | { op: 'craft'; b: number; r: number }
  | { op: 'gather'; b: number; herbs: boolean }
  | { op: 'hunt'; a: number; b: number }
  | { op: 'fish'; b: number }
  /** Forester: plant a sapling on tile i. */
  | { op: 'plant'; i: number; b: number }
  /** Farmer: work a field/orchard tile (world tile index i). */
  | { op: 'field'; b: number; i: number; act: 'plant' | 'harvest' }
  | { op: 'herd'; b: number; act: 'slaughter' | 'collect' | 'tend' }
  /** Quarry / mine shift. */
  | { op: 'extract'; b: number }
  /** Stay at a service building for `t` seconds doing `act`. */
  | { op: 'serve'; b: number; t: number; act: Activity }
  | { op: 'study'; b: number; t: number }
  | { op: 'fight'; b: number }
  /** Turn the carried tool / coat into equipment. */
  | { op: 'equip' };

export type TaskKind =
  | 'deposit' | 'haul' | 'deliver' | 'clear' | 'build' | 'demolish' | 'eat' | 'warm' | 'rest' | 'fetch' | 'equip'
  | 'work' | 'idle' | 'play' | 'study' | 'fight' | 'exit' | 'supply';

export interface Task {
  kind: TaskKind;
  label: string;
  steps: Step[];
  /** Current step index. */
  si: number;
  /** Seconds spent in the current step. */
  tm: number;
  /** Seconds since the task started (watchdog). */
  age: number;
  claims: Claim[];
  /** Extra goods carried besides `Citizen.carrying` (multi-type household baskets). */
  bundle: Inventory | null;
  /** Bonus goods delivered together with the load (e.g. hunter's leather). */
  extra: Inventory | null;
  /** Building the citizen is allowed to stand inside of (quarry pit, mine tunnel), -1 none. */
  inside: number;
  /** Workplace-type task (aborted when the citizen changes job). */
  job: boolean;
}

/** Planner memory + current task. Stored in `Citizen.task` (JSON-serializable). */
export interface Brain {
  cur: Task | null;
  /** Game-time cooldowns (state.time.elapsed) before retrying a plan that failed. */
  cdTool: number;
  cdCoat: number;
  cdFetch: number;
  cdEat: number;
  cdWarm: number;
  cdWork: number;
  /** Consecutive failures to find storage for the carried load. */
  failDeposit: number;
  /** Temporarily avoided targets: [key, until]. Keys: 'b<id>' building, 't<tile>' tile, 'a<id>' animal. */
  bl: [string, number][];
  /** School a student attends (-1 none). */
  school: number;
  /** Next game time for the (cheap) interrupt check. */
  nextCheck: number;
}

export function newBrain(): Brain {
  return {
    cur: null, cdTool: 0, cdCoat: 0, cdFetch: 0, cdEat: 0, cdWarm: 0, cdWork: 0, failDeposit: 0, bl: [], school: -1,
    nextCheck: 0,
  };
}

/** The citizen's brain; (re)initialises a missing or malformed one. */
export function brainOf(c: Citizen): Brain {
  const t = c.task as Brain | null | undefined;
  if (!t || typeof t !== 'object' || !('cur' in t) || !Array.isArray((t as Brain).bl)) {
    const b = newBrain();
    c.task = b;
    return b;
  }
  return t;
}

export function mkTask(kind: TaskKind, label: string, steps: Step[], opts?: { job?: boolean }): Task {
  return {
    kind, label, steps, si: 0, tm: 0, age: 0, claims: [], bundle: null, extra: null, inside: -1, job: !!opts?.job,
  };
}

/**
 * Pure read (no clean-up here): planners probe the blacklist while iterating candidate sets whose order may differ
 * between a restored snapshot and the original game (e.g. the marked-tile Set), so a probe must never mutate state
 * (lockstep co-op). Expired entries are dropped by {@link blacklist} instead.
 */
export function isBlacklisted(brain: Brain, key: string, now: number): boolean {
  for (let i = 0; i < brain.bl.length; i++) {
    const e = brain.bl[i];
    if (e[0] === key) return e[1] > now;
  }
  return false;
}

export function blacklist(brain: Brain, key: string, until: number, now = -Infinity): void {
  if (brain.bl.some((e) => e[1] <= now)) brain.bl = brain.bl.filter((e) => e[1] > now);
  for (const e of brain.bl) {
    if (e[0] === key) {
      e[1] = until;
      return;
    }
  }
  brain.bl.push([key, until]);
  if (brain.bl.length > 8) brain.bl.shift();
}

/** Blacklist key of the main target of a step (for unreachable-target memory). */
export function stepTargetKey(s: Step): string | null {
  switch (s.op) {
    case 'go':
      return s.b !== undefined ? `b${s.b}` : null;
    case 'chop':
    case 'mineRock':
    case 'plant':
    case 'field':
      return `t${s.i}`;
    case 'hunt':
      return `a${s.a}`;
    default:
      return 'b' in s && typeof s.b === 'number' ? `b${s.b}` : null;
  }
}
