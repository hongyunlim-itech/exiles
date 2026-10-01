/**
 * Lockstep co-op end-to-end on the in-memory room: a host and two guests (one admin, one view-only) over a lossy,
 * jittery network play several game years with a scripted command stream from every peer; state hashes must match at
 * every check, a guest joining mid-game converges, an injected desync is detected and repaired, the host leaving
 * hands over to the admin guest, and every event / presence payload stays within the size limit.
 */
import { describe, expect, it } from 'vitest';
import { YEAR_SECONDS } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import type { GameSpeed } from '../src/core/types';
import { Feature } from '../src/core/types';
import { MAX_PAYLOAD_BYTES } from '../src/net/transport';
import type { NetSession } from '../src/net/session';
import { Game } from '../src/sim/game';
import { Bot } from './simcore.bot';
import { findPlacement, log, settings } from './simcore.helpers';
import { commandProxy, stateDiff, TestRoom, type RoomMember } from './net.helpers';

/** A guest player's scripted actions (roads, clearing, houses, staffing, priorities, speed). */
class GuestScript {
  private next = 0;
  private readonly rng: Rng;
  issued = 0;

  constructor(private readonly m: RoomMember, private readonly style: 'builder' | 'manager', seed: number) {
    this.rng = new Rng(seed);
  }

  tick(): void {
    const s = this.m.s;
    if (this.m.gone || s.status().mode !== 'guest') return;
    const g = s.game;
    const now = g.state.time.elapsed;
    if (now < this.next) return;
    this.next = now + 8 + this.rng.next() * 12;
    const c = g.townCenter();
    const W = g.state.W;
    const r = this.rng.next();
    if (this.style === 'builder') {
      if (r < 0.35) {
        // a straight dirt road leaving the centre
        const dir = this.rng.int(0, 3);
        const len = this.rng.int(5, 26);
        const x0 = Math.floor(c.x) + this.rng.int(-10, 10);
        const z0 = Math.floor(c.z) + this.rng.int(-10, 10);
        const tiles: number[] = [];
        for (let k = 0; k < len; k++) {
          const x = x0 + (dir === 0 ? k : dir === 1 ? -k : 0);
          const z = z0 + (dir === 2 ? k : dir === 3 ? -k : 0);
          if (x > 0 && z > 0 && x < W - 1 && z < g.state.H - 1) tiles.push(z * W + x);
        }
        s.dispatch({ op: 'road', kind: 'dirt', tiles });
      } else if (r < 0.65) {
        const x = Math.floor(c.x) + this.rng.int(-35, 35);
        const z = Math.floor(c.z) + this.rng.int(-35, 35);
        s.dispatch({ op: 'mark', x0: x, z0: z, x1: x + this.rng.int(2, 6), z1: z + this.rng.int(2, 6), filter: this.rng.chance(0.7) ? 'trees' : 'all' });
      } else if (r < 0.8) {
        const x = Math.floor(c.x) + this.rng.int(-35, 35);
        const z = Math.floor(c.z) + this.rng.int(-35, 35);
        s.dispatch({ op: 'unmark', x0: x, z0: z, x1: x + 3, z1: z + 3 });
      } else if (g.state.buildings.length < 45) {
        const p = findPlacement(g, 'woodenHouse', c.x + this.rng.int(-12, 12), c.z + this.rng.int(-12, 12), { maxR: 14, allowClearing: true });
        if (p) s.dispatch({ op: 'place', type: 'woodenHouse', x: p.x, z: p.z, rot: p.rot });
      }
    } else {
      const work = g.state.buildings.filter((b) => b.state === 'active' && b.workersDesired > 0);
      const sites = g.state.buildings.filter((b) => b.state === 'construction' || b.state === 'clearing');
      if (r < 0.3 && work.length > 0) {
        const b = work[this.rng.int(0, work.length - 1)];
        s.dispatch({ op: 'workers', id: b.id, n: Math.max(1, b.workersDesired + this.rng.int(-1, 1)) });
      } else if (r < 0.55 && sites.length > 0) {
        const b = sites[this.rng.int(0, sites.length - 1)];
        s.dispatch({ op: 'priority', id: b.id, priority: this.rng.chance(0.5) });
      } else if (r < 0.7) {
        s.dispatch({ op: 'builders', n: this.rng.int(1, 4) });
      } else if (r < 0.78) {
        // a short speed change by a guest (any player may change the shared speed)
        s.setSpeed((this.rng.chance(0.5) ? 5 : 10) as GameSpeed);
      } else if (r < 0.85) {
        // the same well ordered twice: the second one passes the local pre-check (our view lags) but is rejected when
        // the host applies it → a 'rejected' event for this issuer only
        const p = findPlacement(g, 'well', c.x + this.rng.int(-15, 15), c.z + this.rng.int(-15, 15), { maxR: 12 });
        if (p) {
          s.dispatch({ op: 'place', type: 'well', x: p.x, z: p.z, rot: 0 });
          s.dispatch({ op: 'place', type: 'well', x: p.x, z: p.z, rot: 0 });
        }
      } else {
        s.setSpeed(10);
      }
    }
    this.issued++;
  }
}

function hostBot(s: NetSession): Bot {
  return new Bot(commandProxy(s.game, (cmd) => s.dispatch(cmd)));
}

function yearOf(g: Game): number {
  return g.state.time.elapsed / YEAR_SECONDS;
}

/** Pause the shared clock and let every guest reach the host's tick; then compare full states. */
async function settleAndCompare(room: TestRoom, host: RoomMember, guests: RoomMember[]): Promise<void> {
  host.s.setSpeed(0);
  const ok = await room.until(() => guests.every((g) => g.s.status().mode === 'guest' && g.s.currentTick === host.s.currentTick &&
    g.s.status().pendingCommands === 0), 600);
  if (!ok) {
    for (const g of guests) log(`${g.label}: mode ${g.s.status().mode} tick ${g.s.currentTick} vs host ${host.s.currentTick}, pending ${g.s.status().pendingCommands}`);
  }
  expect(ok).toBe(true);
  for (const g of guests) expect(stateDiff(host.s.game, g.s.game)).toBe('');
}

describe('co-op lockstep over a lossy room', () => {
  it('host + 2 guests, 15% event drop, latency & jitter: years of play stay in sync; late join, desync repair, failover', async () => {
    const room = new TestRoom({ latencyMs: 40, jitterMs: 80, drop: 0.15, seed: 11 });
    const hostGame = Game.create(settings({ seed: 2024, difficulty: 'medium', mapSize: 'small', disasters: true }));
    hostGame.speed = 10;
    const host = room.add('host', hostGame, { peer: 'p1-host', admin: true, name: 'Hana' });
    const alice = room.add('alice', Game.create(settings({ seed: 1, mapSize: 'small' })), { peer: 'p2-alice', admin: true, name: 'Alice' });
    const bob = room.add('bob', Game.create(settings({ seed: 2, mapSize: 'small' })), { peer: 'p3-bob', admin: false, guest: true, name: 'Bob' });

    host.s.hostGame(hostGame);
    expect(await room.until(() => alice.s.hostedTown() !== null && bob.s.hostedTown() !== null, 100)).toBe(true);
    expect(host.s.status().mode).toBe('host');
    expect(alice.s.hostedTown()?.townName).toBe('Testvale');
    alice.s.join();
    const joined = await room.until(() => alice.s.status().mode === 'guest', 400);
    expect(joined).toBe(true);
    expect(alice.s.game).not.toBe(hostGame);

    let bot = hostBot(host.s);
    const aliceScript = new GuestScript(alice, 'builder', 5);
    const bobScript = new GuestScript(bob, 'manager', 6);
    let chats = 0;
    bob.s.events.on('chat', () => chats++);
    const each = (): void => {
      if (!host.gone) bot.tick();
      aliceScript.tick();
      bobScript.tick();
    };

    // ---- year 1: host + alice; bob joins mid-game ----
    await room.until(() => yearOf(host.s.game) >= 0.8, 20_000, 50, each);
    bob.s.join();
    const bobIn = await room.until(() => bob.s.status().mode === 'guest', 2000, 50, each);
    expect(bobIn).toBe(true);
    log(`bob joined at year ${yearOf(host.s.game).toFixed(2)}: ${JSON.stringify(bob.s.stats.lastJoin)}; host snapshot ${JSON.stringify(host.s.stats.lastSnapshot)}`);
    alice.s.sendChat('hello from alice');
    bob.s.sendChat('bob here');

    // ---- play on to year 2.5 ----
    await room.until(() => yearOf(host.s.game) >= 2.5, 60_000, 50, each);
    expect(alice.s.status().resyncs).toBe(0);
    expect(bob.s.status().resyncs).toBe(0);
    expect(alice.s.stats.hashMismatches).toBe(0);
    expect(bob.s.stats.hashMismatches).toBe(0);
    expect(alice.s.stats.hashChecks).toBeGreaterThan(200);
    expect(bob.s.stats.hashChecks).toBeGreaterThan(100);
    await settleAndCompare(room, host, [alice, bob]);
    log(`year ${yearOf(host.s.game).toFixed(2)}: pop ${host.s.game.state.citizens.length}, buildings ${host.s.game.state.buildings.length}, ` +
      `commands ${host.s.stats.commandsApplied} (alice issued ${aliceScript.issued}, bob ${bobScript.issued}), rejected alice ${alice.rejected} bob ${bob.rejected}, ` +
      `hash checks alice ${alice.s.stats.hashChecks} bob ${bob.s.stats.hashChecks}, turns ${host.s.stats.turnsSent}, cmd msgs ${host.s.stats.cmdMsgsSent}, ` +
      `chunks ${host.s.stats.chunksSent}, hub ${JSON.stringify(room.hub.stats)}`);
    expect(bob.rejected).toBeGreaterThan(0); // the duplicate orders came back rejected to their issuer
    expect(alice.rejected).toBe(0);
    expect(chats).toBeGreaterThanOrEqual(1);
    host.s.setSpeed(10);

    // ---- injected desync on alice: detected by the hash check and repaired from a fresh snapshot ----
    const victim = alice.s.game.state.citizens[0];
    victim.food = Math.max(0, victim.food - 30);
    victim.x += 0.5;
    await room.until(() => alice.s.status().resyncs >= 1 && alice.s.status().mode === 'guest', 3000, 50, each);
    expect(alice.s.status().resyncs).toBe(1);
    await room.frames(400, 50, each);
    expect(alice.s.status().resyncs).toBe(1);
    expect(bob.s.status().resyncs).toBe(0);
    await settleAndCompare(room, host, [alice, bob]);
    host.s.setSpeed(10);

    // ---- the host leaves: alice (admin) takes over, bob follows her ----
    await room.frames(100, 50, each);
    room.remove('host');
    const took = await room.until(() => alice.s.status().mode === 'host', 400, 50, () => { aliceScript.tick(); bobScript.tick(); });
    expect(took).toBe(true);
    bot = hostBot(alice.s);
    const each2 = (): void => {
      bot.tick();
      bobScript.tick();
    };
    const bobFollows = await room.until(() => bob.s.status().mode === 'guest' && !bob.s.status().label.startsWith('Waiting'), 600, 50, each2);
    expect(bobFollows).toBe(true);
    const bobResyncsAtFailover = bob.s.status().resyncs;
    const checksBefore = bob.s.stats.hashChecks;
    const until = yearOf(alice.s.game) + 0.4;
    await room.until(() => yearOf(alice.s.game) >= until, 20_000, 50, each2);
    expect(bob.s.stats.hashChecks).toBeGreaterThan(checksBefore + 20);
    expect(bob.s.stats.hashMismatches).toBe(0);
    expect(bob.s.status().resyncs).toBe(bobResyncsAtFailover);
    await settleAndCompare(room, alice, [bob]);
    log(`after failover: alice hosts at year ${yearOf(alice.s.game).toFixed(2)}, bob resyncs ${bob.s.status().resyncs}, ` +
      `bob hash checks ${bob.s.stats.hashChecks}`);

    // ---- payloads always within the limit ----
    expect(room.hub.stats.maxEventBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(room.hub.stats.maxPresenceBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    for (const m of room.members) {
      expect(m.s.stats.maxEmitBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(m.s.stats.maxPresenceBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    }
    expect(host.s.game.moduleErrors()).toEqual({});
    expect(bob.s.game.moduleErrors()).toEqual({});
    void Feature;
  });
});
