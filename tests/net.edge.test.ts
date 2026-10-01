/**
 * NetSession edge cases: solo mode is exactly today's behaviour; lobby; host election conflicts; view-only guests
 * waiting for a host and following a new one; command bursts larger than a turn; chat relay; player list; leaving.
 */
import { describe, expect, it } from 'vitest';
import { NetSession } from '../src/net/session';
import { MAX_PAYLOAD_BYTES } from '../src/net/transport';
import type { ChatLine, NetStatus } from '../src/net/types';
import { Game } from '../src/sim/game';
import { findPlacement, settings } from './simcore.helpers';
import { stateDiff, TestRoom } from './net.helpers';

describe('solo', () => {
  it('without a transport the session is plain single player (same results as Game.update)', () => {
    const a = Game.create(settings({ seed: 77 }));
    const b = Game.fromSave(a.save());
    const s = new NetSession(a, null);
    let replaced = 0;
    s.events.on('gameReplaced', () => replaced++);
    expect(s.status()).toMatchObject({ mode: 'solo', connected: false, canHost: false, label: 'Single player' });
    s.setSpeed(5);
    b.speed = 5;
    expect(s.speed()).toBe(5);
    const c = a.townCenter();
    const spot = findPlacement(a, 'well', c.x + 5, c.z + 5)!;
    const r = s.dispatch({ op: 'place', type: 'well', x: spot.x, z: spot.z, rot: 0 });
    expect(r.ok).toBe(true);
    expect(r.buildingId).toBeDefined();
    expect(r.pending).toBeUndefined();
    b.placeBuilding('well', spot.x, spot.z, 0);
    let gameDt = 0;
    for (let i = 0; i < 600; i++) {
      gameDt += s.update(1 / 60);
      b.update(1 / 60);
    }
    expect(gameDt).toBeCloseTo(a.state.time.elapsed - 0, 3);
    expect(stateDiff(a, b)).toBe('');
    s.hostGame(b);
    expect(s.game).toBe(b);
    expect(replaced).toBe(1);
    expect(s.players()).toHaveLength(1);
    expect(s.hostedTown()).toBeNull();
    s.leave();
    s.dispose();
  });
});

describe('room edge cases', () => {
  it('a solo session can attach the room later; a town handed to hostGame() before is hosted then', async () => {
    const room = new TestRoom({ latencyMs: 20 });
    const other = room.add('o', Game.create(settings({ seed: 5 })), { peer: 'po', admin: false });
    const g = Game.create(settings({ seed: 6, townName: 'Latecomer' }));
    const s = new NetSession(g, null, { now: () => room.hub.now });
    s.hostGame(g);
    expect(s.status().mode).toBe('solo');
    s.update(0.05);
    const t = room.hub.connect({ peer: 'pl' });
    s.attachTransport(t);
    expect(s.status().mode).toBe('lobby');
    await room.until(() => {
      s.update(0.05);
      return s.status().mode === 'host' && other.s.hostedTown()?.townName === 'Latecomer';
    }, 100);
    expect(s.status().mode).toBe('host');
    expect(other.s.hostedTown()?.townName).toBe('Latecomer');
    s.dispose();
  });

  it('lobby: connected, nobody hosting — local play; a view-only viewer cannot host', async () => {
    const room = new TestRoom({ latencyMs: 20 });
    const viewer = room.add('v', Game.create(settings({ seed: 3 })), { admin: false });
    await room.frames(3);
    expect(viewer.s.status()).toMatchObject({ mode: 'lobby', connected: true, canHost: false });
    viewer.s.hostGame(viewer.s.game);
    await room.frames(3);
    expect(viewer.s.status().mode).toBe('lobby');
    const before = viewer.s.game.state.time.elapsed;
    await room.frames(20);
    expect(viewer.s.game.state.time.elapsed).toBeGreaterThan(before); // plays on locally
    expect(viewer.s.hostedTown()).toBeNull();
  });

  it('two admins host at once: the earlier host wins, the other joins its town', async () => {
    const room = new TestRoom({ latencyMs: 30, jitterMs: 30 });
    const a = room.add('a', Game.create(settings({ seed: 10, townName: 'Alpha' })), { peer: 'pa' });
    const b = room.add('b', Game.create(settings({ seed: 11, townName: 'Beta' })), { peer: 'pb' });
    await room.frames(2);
    a.s.hostGame(a.s.game);
    await room.frames(1);
    b.s.hostGame(b.s.game); // later `since`
    const ok = await room.until(() => b.s.status().mode === 'guest', 400);
    expect(ok).toBe(true);
    expect(a.s.status().mode).toBe('host');
    expect(b.s.game.state.settings.townName).toBe('Alpha');
    expect(b.s.sharedGameId).toBe(a.s.sharedGameId);
  });

  it('view-only guests wait when the host leaves with no admin to take over, then follow a new host', async () => {
    const room = new TestRoom({ latencyMs: 30 });
    const h = room.add('h', Game.create(settings({ seed: 20, townName: 'First' })), { peer: 'ph' });
    const v = room.add('v', Game.create(settings({ seed: 21 })), { peer: 'pv', admin: false });
    const statuses: NetStatus[] = [];
    v.s.events.on('status', (st) => statuses.push(st));
    h.s.hostGame(h.s.game);
    expect(await room.until(() => v.s.hostedTown() !== null, 100)).toBe(true);
    v.s.join();
    expect(await room.until(() => v.s.status().mode === 'guest', 400)).toBe(true);
    room.remove('h');
    expect(await room.until(() => v.s.status().label.startsWith('Waiting'), 200)).toBe(true);
    expect(v.s.speed()).toBe(0);
    const tick = v.s.currentTick;
    await room.frames(40);
    expect(v.s.currentTick).toBe(tick); // paused
    // an admin opens the page and starts a new town: the waiting guest follows it
    const n = room.add('n', Game.create(settings({ seed: 22, townName: 'Second' })), { peer: 'pn' });
    let replaced = 0;
    v.s.events.on('gameReplaced', () => replaced++);
    await room.frames(2);
    n.s.hostGame(n.s.game);
    expect(await room.until(() => v.s.status().mode === 'guest' && v.s.game.state.settings.townName === 'Second', 600)).toBe(true);
    expect(replaced).toBe(1);
    expect(statuses.some((s) => s.mode === 'joining')).toBe(true);
  });

  it('a burst of long road drags from a guest: queued within the presence budget, all applied, overflow turns split', async () => {
    const room = new TestRoom({ latencyMs: 25, jitterMs: 20, drop: 0.1, seed: 4 });
    const h = room.add('h', Game.create(settings({ seed: 30 })), { peer: 'ph' });
    const g = room.add('g', Game.create(settings({ seed: 31 })), { peer: 'pg', admin: false });
    h.s.hostGame(h.s.game);
    h.s.setSpeed(1);
    expect(await room.until(() => g.s.hostedTown() !== null, 100)).toBe(true);
    g.s.join();
    expect(await room.until(() => g.s.status().mode === 'guest', 400)).toBe(true);
    const s = g.s.game.state;
    const W = s.W;
    let issued = 0;
    for (let z = 4; z < s.H - 4 && issued < 30; z += 4) {
      const tiles: number[] = [];
      for (let x = 2; x < W - 2; x++) tiles.push(z * W + x);
      const r = g.s.dispatch({ op: 'road', kind: 'dirt', tiles });
      if (r.ok) issued++;
    }
    expect(issued).toBeGreaterThan(10);
    expect(g.s.status().pendingCommands).toBeGreaterThan(issued); // each drag became several commands
    expect(await room.until(() => g.s.status().pendingCommands === 0, 2000)).toBe(true);
    // the host's own burst: more new entries in one turn cycle than a turn can carry → extra 'cmds' messages
    for (let z = 6; z < s.H - 4; z += 4) {
      const tiles: number[] = [];
      for (let x = 2; x < W - 2; x++) tiles.push(z * W + x);
      h.s.dispatch({ op: 'removeRoad', tiles });
    }
    await room.frames(10);
    h.s.setSpeed(0);
    expect(await room.until(() => g.s.currentTick === h.s.currentTick, 400)).toBe(true);
    await room.frames(20);
    expect(stateDiff(h.s.game, g.s.game)).toBe('');
    expect(h.s.stats.cmdMsgsSent).toBeGreaterThan(0);
    expect(room.hub.stats.maxEventBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(room.hub.stats.maxPresenceBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('chat: admins emit, view-only guests are relayed by the host; names and colours in the player list', async () => {
    const room = new TestRoom({ latencyMs: 20 });
    const h = room.add('h', Game.create(settings({ seed: 40 })), { peer: 'ph', name: 'Hana' });
    const a = room.add('a', Game.create(settings({ seed: 41 })), { peer: 'pa', name: 'Aki' });
    const v = room.add('v', Game.create(settings({ seed: 42 })), { peer: 'pv', admin: false, guest: true, name: '' });
    h.s.hostGame(h.s.game);
    expect(await room.until(() => a.s.hostedTown() !== null, 100)).toBe(true);
    a.s.join();
    v.s.join();
    expect(await room.until(() => a.s.status().mode === 'guest' && v.s.status().mode === 'guest', 600)).toBe(true);
    const atA: ChatLine[] = [];
    const atV: ChatLine[] = [];
    a.s.events.on('chat', (l) => atA.push(l));
    v.s.events.on('chat', (l) => atV.push(l));
    v.s.sendChat('  hi​ all \u0007 ');
    h.s.sendChat('welcome');
    await room.frames(20);
    expect(atA.map((l) => [l.peer, l.text])).toEqual(expect.arrayContaining([['pv', 'hi all'], ['ph', 'welcome']]));
    expect(atV.map((l) => l.text)).toEqual(['hi all', 'welcome']); // own line echoed once, locally
    expect(atA.find((l) => l.peer === 'ph')?.name).toBe('Hana');
    v.s.setLocalPresence({ cursor: [10.123, 20.456], camera: { x: 1, z: 2, yaw: 0.5, dist: 30 }, ghost: { type: 'well', x: 3, z: 4, rot: 1, w: 2, h: 2, valid: true }, tool: 'Building: Well' });
    await room.frames(10);
    const players = a.s.players();
    expect(players.map((p) => p.name).sort()).toEqual(['Aki', 'Hana', expect.stringMatching(/^Settler \d+$/)].sort());
    const pv = players.find((p) => p.peer === 'pv')!;
    expect(pv.guest).toBe(true);
    expect(pv.cursor).toEqual([10.1, 20.45]); // 1/20 tile precision
    expect(pv.ghost).toMatchObject({ type: 'well', x: 3, z: 4, rot: 1, valid: true });
    expect(pv.tool).toBe('Building: Well');
    expect(players.find((p) => p.peer === 'ph')!.isHost).toBe(true);
    expect(players.find((p) => p.peer === 'pa')!.isMe).toBe(true);
    expect(new Set(players.map((p) => p.color)).size).toBe(3);
  });

  it('the host switching to another town takes its guests along; a guest can leave and play on alone', async () => {
    const room = new TestRoom({ latencyMs: 20 });
    const h = room.add('h', Game.create(settings({ seed: 50, townName: 'Old' })), { peer: 'ph' });
    const g = room.add('g', Game.create(settings({ seed: 51 })), { peer: 'pg' });
    h.s.hostGame(h.s.game);
    expect(await room.until(() => g.s.hostedTown() !== null, 100)).toBe(true);
    g.s.join();
    expect(await room.until(() => g.s.status().mode === 'guest', 400)).toBe(true);
    h.s.hostGame(Game.create(settings({ seed: 52, townName: 'New' })));
    expect(await room.until(() => g.s.status().mode === 'guest' && g.s.game.state.settings.townName === 'New', 600)).toBe(true);
    g.s.leave();
    expect(g.s.status().mode).toBe('lobby');
    const t = g.s.game.state.time.elapsed;
    await room.frames(20);
    expect(g.s.game.state.time.elapsed).toBeGreaterThan(t);
    expect(g.s.hostedTown()?.townName).toBe('New');
    h.s.leave();
    await room.frames(5);
    expect(h.s.status().mode).toBe('lobby');
    expect(g.s.hostedTown()).toBeNull();
  });
});
