/**
 * Helpers for the net-core tests: a Game proxy that turns the scripted bot's direct mutations into Commands (so
 * the same command stream can be replayed on other peers), and a strict state comparison.
 */
import type { BuildingType, Rotation } from '../src/core/types';
import { applyCommand } from '../src/net/commands';
import type { Command } from '../src/net/types';
import type { Game } from '../src/sim/game';
import { MemoryHub, type MemoryHubOptions, type MemoryPeerOptions, type MemoryTransport } from '../src/net/transport-memory';
import { NetSession } from '../src/net/session';

/**
 * Wrap `game` so that the player-command methods the scripted Bot uses are routed through `sink(cmd)` (which must
 * apply it — e.g. applyCommand or a NetSession.dispatch) instead of mutating directly. Reads pass through.
 */
export function commandProxy(game: Game, sink: (cmd: Command) => { buildingId?: number; count?: number } | void): Game {
  const wrap: Record<string, (...a: never[]) => unknown> = {
    placeBuilding: (type: BuildingType, x: number, z: number, rot: Rotation, w?: number, h?: number) => {
      const cmd: Command = { op: 'place', type, x: Math.floor(x), z: Math.floor(z), rot };
      if (w !== undefined) cmd.w = w;
      if (h !== undefined) cmd.h = h;
      const r = sink(cmd);
      return r && r.buildingId !== undefined ? game.getBuilding(r.buildingId) ?? null : null;
    },
    setWorkers: (id: number, n: number) => void sink({ op: 'workers', id, n: Math.round(n) }),
    setBuilders: (n: number) => void sink({ op: 'builders', n: Math.round(n) }),
    setPriority: (id: number, priority: boolean) => void sink({ op: 'priority', id, priority }),
    setPaused: (id: number, paused: boolean) => void sink({ op: 'pause', id, paused }),
    markForRemoval: (x0: number, z0: number, x1: number, z1: number, filter: 'all' | 'trees' | 'stone' | 'iron') => {
      const r = sink({ op: 'mark', x0: Math.floor(x0), z0: Math.floor(z0), x1: Math.floor(x1), z1: Math.floor(z1), filter });
      return r?.count ?? 0;
    },
    respondToNomads: (accept: boolean) => void sink({ op: 'nomads', accept }),
    placeRoad: (tiles: number[], kind: 'dirt' | 'stone') => sink({ op: 'road', kind, tiles })?.count ?? 0,
  };
  return new Proxy(game, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in wrap) return wrap[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** A command log entry: applied right after the step that reached `tick`. */
export interface LoggedCommand {
  tick: number;
  cmd: Command;
}

/** Proxy that applies commands to `game` at once and records them with the current tick. */
export function recordingProxy(game: Game, log: LoggedCommand[], tick: () => number): Game {
  return commandProxy(game, (cmd) => {
    log.push({ tick: tick(), cmd: JSON.parse(JSON.stringify(cmd)) });
    return applyCommand(game, cmd);
  });
}

/** Canonical comparable form of the whole game state (+ rng), tiles included. */
function canon(g: Game): Record<string, unknown> {
  g.save(); // flushes the sim-ext runtime into state.ext and the rng into state.rngState
  const s = g.state;
  const { tiles, ext, ...rest } = s;
  // rev.features is a render-only invalidation counter (batched by a runtime timer in nature.ts; the sim never reads
  // it), so it is not part of the lockstep state
  const r = JSON.parse(JSON.stringify(rest)) as { rev: { features?: number } };
  delete r.rev.features;
  const t: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(tiles)) t[k] = Array.from(v as ArrayLike<number>);
  return { rest: r, tiles: t, ext: sortKeys(JSON.parse(JSON.stringify(ext ?? {}))), rng: g.rng.state };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** First difference between two games' full states ('' when identical). Key order counts (outside `ext`). */
export function stateDiff(a: Game, b: Game): string {
  return diff(canon(a), canon(b), '');
}

function diff(a: unknown, b: unknown, path: string): string {
  if (a === b) return '';
  if (typeof a === 'number' && typeof b === 'number') {
    if (Object.is(a, b) || (a === 0 && b === 0)) return '';
    return `${path}: ${a} != ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join(',') !== kb.join(',')) return `${path} keys: [${ka.join(',')}] != [${kb.join(',')}]`;
    for (const k of ka) {
      const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return '';
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`;
}

// ---------------------------------------------------------------------------------------------
// A MemoryHub room of NetSessions driven frame by frame (virtual clock)
// ---------------------------------------------------------------------------------------------


export interface RoomMember {
  label: string;
  t: MemoryTransport;
  s: NetSession;
  gone: boolean;
  rejected: number;
}

export class TestRoom {
  readonly hub: MemoryHub;
  readonly members: RoomMember[] = [];

  constructor(opts: MemoryHubOptions) {
    this.hub = new MemoryHub(opts);
  }

  add(label: string, game: Game, peer: MemoryPeerOptions = {}): RoomMember {
    const t = this.hub.connect(peer);
    const s = new NetSession(game, t, { now: () => this.hub.now, cpuNow: () => 0, joinBudgetMs: 60, frameBudgetMs: 30 }); // virtual CPU clock: frame budgets never depend on machine load
    const m: RoomMember = { label, t, s, gone: false, rejected: 0 };
    s.events.on('rejected', () => m.rejected++);
    this.members.push(m);
    return m;
  }

  get(label: string): RoomMember {
    const m = this.members.find((x) => x.label === label);
    if (!m) throw new Error(`no member ${label}`);
    return m;
  }

  /** The member's tab closes (its peers see it leave). */
  remove(label: string): void {
    const m = this.get(label);
    m.gone = true;
    this.hub.disconnect(m.t);
    m.s.dispose();
  }

  /** Run `n` frames of `ms` each: deliver due messages, update every session, run `each`, yield to async work. */
  async frames(n: number, ms = 50, each?: (i: number) => void): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.hub.advance(ms);
      for (const m of this.members) if (!m.gone) m.s.update(ms / 1000);
      each?.(i);
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  /** Run frames until `cond` holds (or `max` frames). Returns whether it held. */
  async until(cond: () => boolean, max: number, ms = 50, each?: (i: number) => void): Promise<boolean> {
    for (let i = 0; i < max; i++) {
      if (cond()) return true;
      await this.frames(1, ms, each);
    }
    return cond();
  }
}
