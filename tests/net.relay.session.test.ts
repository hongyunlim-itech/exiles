/**
 * Lockstep co-op over the PUBLIC relay: NetSessions on RelayTransport, bridged to the real room logic
 * (cloud/room-core.ts) with latency on a virtual clock. The first peer in the room holds the host seat and hosts;
 * guests join and play (commands flow both ways, state hashes agree); when the host's tab crashes the relay promotes
 * the next-oldest peer after its reconnect grace and that peer takes the town over — the remaining guest keeps
 * matching hashes. A host whose connection blips reconnects within the grace without anyone noticing; one that is
 * away longer finds the host seat taken, steps down and follows the new host. Kicks and nicknames work end to end.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { NetSession } from '../src/net/session';
import { MAX_PAYLOAD_BYTES } from '../src/net/transport';
import type { RelayTransport } from '../src/net/transport-relay';
import { Game } from '../src/sim/game';
import { commandProxy, stateDiff } from './net.helpers';
import { RelayNet, type RelayNetOptions } from './net.relay.helpers';
import { Bot } from './simcore.bot';
import { findPlacement, log, settings } from './simcore.helpers';

interface Member {
  label: string;
  cid: string;
  t: RelayTransport;
  s: NetSession;
  gone: boolean;
  rejected: number;
}

class RelayRoom {
  readonly net: RelayNet;
  readonly members: Member[] = [];

  constructor(opts: RelayNetOptions) {
    this.net = new RelayNet(opts);
  }

  add(label: string, game: Game): Member {
    const cid = `client-${label}-0123456789`;
    const t = this.net.transport(cid);
    const s = new NetSession(game, t, { now: () => this.net.clock.now(), cpuNow: () => 0, joinBudgetMs: 60, frameBudgetMs: 30 }); // virtual CPU clock: deterministic under load
    const m: Member = { label, cid, t, s, gone: false, rejected: 0 };
    s.events.on('rejected', () => m.rejected++);
    this.members.push(m);
    return m;
  }

  /** The tab crashes: the relay sees an abnormal close, nothing else is ever heard from it. */
  crash(m: Member): void {
    m.gone = true;
    const sock = this.net.socketOf(m.cid);
    if (sock) this.net.crash(sock);
    m.s.dispose();
    m.t.dispose();
  }

  async frames(n: number, ms = 50, each?: () => void): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.net.advance(ms);
      for (const m of this.members) if (!m.gone) m.s.update(ms / 1000);
      each?.();
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  async until(cond: () => boolean, max: number, ms = 50, each?: () => void): Promise<boolean> {
    for (let i = 0; i < max; i++) {
      if (cond()) return true;
      await this.frames(1, ms, each);
    }
    return cond();
  }
}

/** A guest's scripted orders (roads, clearing, houses, staffing, priorities). */
class GuestScript {
  private next = 0;
  private readonly rng: Rng;
  issued = 0;

  constructor(private readonly m: Member, seed: number) {
    this.rng = new Rng(seed);
  }

  tick(): void {
    const s = this.m.s;
    if (this.m.gone || s.status().mode !== 'guest') return;
    const g = s.game;
    const now = g.state.time.elapsed;
    if (now < this.next) return;
    this.next = now + 5 + this.rng.next() * 8;
    const c = g.townCenter();
    const W = g.state.W;
    const r = this.rng.next();
    if (r < 0.3) {
      const x0 = Math.floor(c.x) + this.rng.int(-10, 10);
      const z0 = Math.floor(c.z) + this.rng.int(-10, 10);
      const tiles: number[] = [];
      for (let k = 0; k < this.rng.int(4, 14); k++) if (x0 + k > 0 && x0 + k < W - 1) tiles.push(z0 * W + x0 + k);
      s.dispatch({ op: 'road', kind: 'dirt', tiles });
    } else if (r < 0.55) {
      const x = Math.floor(c.x) + this.rng.int(-30, 30);
      const z = Math.floor(c.z) + this.rng.int(-30, 30);
      s.dispatch({ op: 'mark', x0: x, z0: z, x1: x + 3, z1: z + 3, filter: 'trees' });
    } else if (r < 0.75 && g.state.buildings.length < 40) {
      const p = findPlacement(g, 'woodenHouse', c.x + this.rng.int(-12, 12), c.z + this.rng.int(-12, 12), { maxR: 14, allowClearing: true });
      if (p) s.dispatch({ op: 'place', type: 'woodenHouse', x: p.x, z: p.z, rot: p.rot });
    } else if (r < 0.9) {
      s.dispatch({ op: 'builders', n: this.rng.int(1, 4) });
    } else {
      const sites = g.state.buildings.filter((b) => b.state === 'construction');
      if (sites.length > 0) s.dispatch({ op: 'priority', id: sites[this.rng.int(0, sites.length - 1)].id, priority: true });
    }
    this.issued++;
  }
}

function hostBot(s: NetSession): Bot {
  return new Bot(commandProxy(s.game, (cmd) => s.dispatch(cmd)));
}

/** Pause the shared clock, let every guest reach the host's tick, then compare full states. */
async function settleAndCompare(room: RelayRoom, host: Member, guests: Member[]): Promise<void> {
  host.s.setSpeed(0);
  const ok = await room.until(() => guests.every((g) => g.s.status().mode === 'guest' && g.s.currentTick === host.s.currentTick &&
    g.s.status().pendingCommands === 0), 600);
  if (!ok) {
    for (const g of guests) log(`${g.label}: mode ${g.s.status().mode} tick ${g.s.currentTick} vs host ${host.s.currentTick}, pending ${g.s.status().pendingCommands}`);
  }
  expect(ok).toBe(true);
  for (const g of guests) expect(stateDiff(host.s.game, g.s.game)).toBe('');
}

const mode = (m: Member): string => m.s.status().mode;

describe('co-op over the public relay', () => {
  it('host = first in the room; guests join and play; the host crashes → the relay promotes the next-oldest → failover keeps hashes equal', async () => {
    const room = new RelayRoom({ latencyMs: 40 });
    const hostGame = Game.create(settings({ seed: 4242, mapSize: 'small', townName: 'Relayton' }));
    hostGame.speed = 10;
    const a = room.add('a', hostGame);
    await room.frames(10);
    expect(a.s.status()).toMatchObject({ connected: true, canHost: true, mode: 'lobby' });
    const b = room.add('b', Game.create(settings({ seed: 1 })));
    const c = room.add('c', Game.create(settings({ seed: 2 })));
    expect(await room.until(() => b.s.status().connected && c.s.status().connected, 100)).toBe(true);
    expect(b.s.status().canHost).toBe(false);
    expect(c.s.status().canHost).toBe(false);
    expect(a.s.transportKind()).toBe('relay');
    expect(a.s.inviteLink()).toBe('https://exiles.example/?room=test-room');
    expect(a.s.canKick()).toBe(true);
    expect(b.s.canKick()).toBe(false);
    b.s.setNickname('  Bea\u0000 ');
    expect(b.s.getNickname()).toBe('Bea');

    a.s.hostGame(hostGame);
    expect(mode(a)).toBe('host');
    expect(await room.until(() => b.s.hostedTown() !== null && c.s.hostedTown() !== null, 100)).toBe(true);
    expect(c.s.hostedTown()).toMatchObject({ townName: 'Relayton' });
    b.s.join();
    c.s.join();
    expect(await room.until(() => mode(b) === 'guest' && mode(c) === 'guest', 600)).toBe(true);
    expect(a.s.players().find((p) => p.peer === b.t.selfPeer())?.name).toBe('Bea');

    let bot = hostBot(a.s);
    const bs = new GuestScript(b, 11);
    const cs = new GuestScript(c, 12);
    const each = (): void => {
      if (!a.gone) bot.tick();
      bs.tick();
      cs.tick();
    };
    await room.until(() => a.s.game.state.time.elapsed >= 150, 4000, 50, each);
    expect(bs.issued + cs.issued).toBeGreaterThan(10);
    await settleAndCompare(room, a, [b, c]);
    for (const g of [b, c]) {
      expect(g.s.stats.hashChecks).toBeGreaterThan(20);
      expect(g.s.stats.hashMismatches).toBe(0);
      expect(g.s.status().resyncs).toBe(0);
    }
    log(`relay: ${a.s.stats.commandsApplied} commands, turns ${a.s.stats.turnsSent}, chunks ${a.s.stats.chunksSent}, ` +
      `hash checks b ${b.s.stats.hashChecks} c ${c.s.stats.hashChecks}, net ${JSON.stringify(room.net.stats)}`);
    a.s.setSpeed(10);
    await room.frames(20, 50, each);

    // ---- the host's tab crashes: after the relay's grace b (next-oldest) gets the host seat and takes the town over
    const bResyncs = b.s.status().resyncs;
    room.crash(a);
    await room.frames(40, 50, () => { bs.tick(); cs.tick(); }); // within the grace: nothing decided yet
    expect(b.s.status().canHost).toBe(false);
    expect(await room.until(() => mode(b) === 'host', 300, 50, () => { bs.tick(); cs.tick(); })).toBe(true);
    expect(b.s.status().canHost).toBe(true);
    expect(b.t.adminPeer()).toBe(b.t.selfPeer());
    expect(c.t.adminPeer()).toBe(b.t.selfPeer());
    bot = hostBot(b.s);
    const each2 = (): void => {
      bot.tick();
      cs.tick();
    };
    expect(await room.until(() => mode(c) === 'guest' && !c.s.waitingForHost, 600, 50, each2)).toBe(true);
    const checks = c.s.stats.hashChecks;
    const until = b.s.game.state.time.elapsed + 90;
    await room.until(() => b.s.game.state.time.elapsed >= until, 3000, 50, each2);
    expect(c.s.stats.hashChecks).toBeGreaterThan(checks + 10);
    expect(c.s.stats.hashMismatches).toBe(0);
    expect(c.s.status().resyncs).toBe(0);
    expect(b.s.status().resyncs).toBe(bResyncs);
    await settleAndCompare(room, b, [c]);

    // ---- the new host kicks c: c is out for good and keeps its copy locally
    expect(b.s.canKick()).toBe(true);
    c.s.kick(b.t.selfPeer()); // not the host seat: no-op
    b.s.kick(c.t.selfPeer());
    await room.frames(10);
    expect(c.s.closeReason()).toBe('kicked');
    expect(c.s.status()).toMatchObject({ mode: 'lobby', connected: false, label: 'Removed from the room by the host' });
    expect(b.s.players().map((p) => p.peer)).toEqual([b.t.selfPeer()]);
    expect(room.net.stats.maxClientFrame).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES + 512);
    for (const m of [a, b, c]) expect(m.s.stats.maxEmitBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(b.s.game.moduleErrors()).toEqual({});
    b.s.dispose();
    b.t.dispose();
    c.s.dispose();
    c.t.dispose();
  });

  it('a host blip within the grace goes unnoticed; a longer outage hands the seat on and the old host steps down', async () => {
    const room = new RelayRoom({ latencyMs: 30 });
    const hostGame = Game.create(settings({ seed: 99, mapSize: 'small', townName: 'Blipford' }));
    hostGame.speed = 10;
    const a = room.add('a', hostGame);
    await room.frames(10);
    const b = room.add('b', Game.create(settings({ seed: 3 })));
    await room.frames(10);
    a.s.hostGame(hostGame);
    expect(await room.until(() => b.s.hostedTown() !== null, 100)).toBe(true);
    b.s.join();
    expect(await room.until(() => mode(b) === 'guest', 600)).toBe(true);
    const bot = hostBot(a.s);
    const bs = new GuestScript(b, 21);
    let waited = false;
    const each = (): void => {
      if (mode(a) === 'host') bot.tick();
      bs.tick();
      if (b.s.waitingForHost) waited = true;
    };
    await room.until(() => a.s.game.state.time.elapsed >= 60, 2000, 50, each);

    // ---- a blip: both ends see the socket drop; a is back within the grace on the same seat
    const label = a.t.selfPeer();
    room.net.drop(room.net.socketOf(a.cid)!);
    await room.frames(80, 50, each);
    expect(a.t.connected()).toBe(true);
    expect(a.t.selfPeer()).toBe(label);
    expect(mode(a)).toBe('host');
    expect(mode(b)).toBe('guest');
    expect(waited).toBe(false);
    expect(b.s.status().resyncs).toBe(0);
    await room.frames(200, 50, each);
    await settleAndCompare(room, a, [b]);
    expect(b.s.stats.hashMismatches).toBe(0);
    a.s.setSpeed(10);

    // ---- a longer outage: a cannot reconnect for 9 s — b gets the seat after the grace and takes over; a comes back
    // as a newcomer without the seat, steps down and follows b's town
    room.net.offlineUntil.set(a.cid, room.net.clock.now() + 9000);
    room.net.drop(room.net.socketOf(a.cid)!);
    expect(await room.until(() => mode(b) === 'host', 400, 50, () => bs.tick())).toBe(true);
    expect(await room.until(() => a.t.connected(), 600)).toBe(true);
    expect(a.s.status().canHost).toBe(false);
    expect(await room.until(() => mode(a) === 'guest', 600)).toBe(true);
    expect(a.s.sharedGameId).toBe(b.s.sharedGameId);
    const bot2 = hostBot(b.s);
    await room.frames(300, 50, () => bot2.tick());
    await settleAndCompare(room, b, [a]);
    expect(a.s.stats.hashMismatches).toBe(0);
    for (const m of [a, b]) {
      m.s.dispose();
      m.t.dispose();
    }
  });

  it('untrusted players cannot hijack the town: host claims from anyone but the relay host seat are ignored', async () => {
    const room = new RelayRoom({ latencyMs: 30 });
    const hostGame = Game.create(settings({ seed: 7, mapSize: 'small', townName: 'Trueton' }));
    const a = room.add('a', hostGame);
    await room.frames(10);
    const b = room.add('b', Game.create(settings({ seed: 5 })));
    await room.frames(10);
    a.s.hostGame(hostGame);
    expect(await room.until(() => b.s.hostedTown() !== null, 100)).toBe(true);
    b.s.join();
    expect(await room.until(() => mode(b) === 'guest', 600)).toBe(true);

    // a rogue client (a raw transport, no game) forges the admin flag and an OLDER host claim for another town — in a
    // Claude room the earliest claim wins, so without the host-seat rule the host would give way and everyone would
    // try to join a town that nobody can send
    const rogue = room.net.transport('client-rogue-0123456789');
    await room.frames(5);
    expect(rogue.connected()).toBe(true);
    await rogue.setPresence({ v: 1, n: 'Mallory', c: '#ffffff', ad: 1, h: { id: 'forged-town', s: -1e12, e: 99, t: 'Fakeville', y: 9, p: 999, k: 0 } });
    const c = room.add('c', Game.create(settings({ seed: 6 })));
    await room.frames(60);
    expect(mode(a)).toBe('host');
    expect(mode(b)).toBe('guest');
    expect(c.s.status().mode).toBe('lobby');
    expect(c.s.hostedTown()).toMatchObject({ townName: 'Trueton' });
    expect(b.s.hostedTown()).toMatchObject({ townName: 'Trueton' });
    expect(a.s.players().find((p) => p.peer === rogue.selfPeer())).toMatchObject({ name: 'Mallory', isHost: false });
    expect(c.t.adminPeer()).toBe(a.t.selfPeer());

    // the host seat removes the rogue for the room's lifetime
    expect(a.s.canKick()).toBe(true);
    a.s.kick(rogue.selfPeer());
    await room.frames(10);
    expect(rogue.closeReason()).toBe('kicked');
    expect(a.s.players().some((p) => p.peer === rogue.selfPeer())).toBe(false);
    expect(mode(b)).toBe('guest');
    rogue.dispose();
    for (const m of [a, b, c]) {
      m.s.dispose();
      m.t.dispose();
    }
  });
});
