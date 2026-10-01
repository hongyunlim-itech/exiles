/**
 * Co-op performance numbers for a medium-map town in year 5: snapshot save / gzip / chunk / unpack / load, the state
 * hash, the simulation step, and a real join over a lossy in-memory room followed by half a year of lockstep play.
 */
import { describe, expect, it } from 'vitest';
import { YEAR_SECONDS } from '../src/core/constants';
import { hashGameState } from '../src/net/hash';
import { SNAP_CHUNK_CHARS } from '../src/net/protocol';
import { chunkString, packSnapshot, unpackSnapshot } from '../src/net/snapshot';
import { MAX_PAYLOAD_BYTES } from '../src/net/transport';
import { NET_STEP } from '../src/net/types';
import { Game } from '../src/sim/game';
import { Bot } from './simcore.bot';
import { log, settings } from './simcore.helpers';
import { commandProxy, stateDiff, TestRoom } from './net.helpers';

const ms = (t0: number) => performance.now() - t0;

describe('co-op performance (medium map, year 5)', () => {
  it('snapshot, hash and join numbers', async () => {
    const g = Game.create(settings({ seed: 9001, mapSize: 'medium', difficulty: 'easy', disasters: true }));
    const bot = new Bot(g);
    let t0 = performance.now();
    let ticks = 0;
    while (g.state.time.elapsed < 4 * YEAR_SECONDS + 60 && !g.state.gameOver) {
      g.step(NET_STEP);
      bot.tick();
      ticks++;
    }
    const simMs = ms(t0);
    const s = g.state;
    log(`town: year ${s.time.year}, pop ${s.citizens.length}, buildings ${s.buildings.length}, animals ${s.animals.length}; ` +
      `${ticks} ticks in ${(simMs / 1000).toFixed(1)} s (${(simMs / ticks).toFixed(3)} ms/tick incl. bot)`);
    expect(s.time.year).toBeGreaterThanOrEqual(5);

    // step cost at this size
    t0 = performance.now();
    for (let i = 0; i < 200; i++) g.step(NET_STEP);
    const stepMs = ms(t0) / 200;
    // hash cost
    t0 = performance.now();
    let h = 0;
    for (let i = 0; i < 50; i++) h ^= hashGameState(g);
    const hashMs = ms(t0) / 50;
    // snapshot
    t0 = performance.now();
    const save = g.save();
    const saveMs = ms(t0);
    t0 = performance.now();
    const packed = await packSnapshot(save);
    const packMs = ms(t0);
    const chunks = chunkString(packed.data, SNAP_CHUNK_CHARS);
    t0 = performance.now();
    const back = await unpackSnapshot(chunks.join(''), packed.z);
    const unpackMs = ms(t0);
    t0 = performance.now();
    const loaded = Game.fromSave(back);
    const loadMs = ms(t0);
    expect(back).toBe(save);
    expect(hashGameState(loaded)).toBe(hashGameState(g));
    log(`step ${stepMs.toFixed(3)} ms/tick · hash ${hashMs.toFixed(3)} ms (every 20 ticks) · save ${saveMs.toFixed(1)} ms · ` +
      `raw ${(packed.rawBytes / 1024).toFixed(1)} KiB → gzip ${(packed.packedBytes / 1024).toFixed(1)} KiB (z=${packed.z}) → base64 ` +
      `${(packed.data.length / 1024).toFixed(1)} KiB = ${chunks.length} chunks · gzip ${packMs.toFixed(1)} ms · gunzip ${unpackMs.toFixed(1)} ms · ` +
      `load ${loadMs.toFixed(1)} ms`);
    void h;

    // a real join over a lossy room, then half a year of lockstep play at speed 10
    const room = new TestRoom({ latencyMs: 50, jitterMs: 60, drop: 0.1, seed: 21 });
    g.speed = 10;
    const host = room.add('host', g, { peer: 'p1' });
    const guest = room.add('guest', Game.create(settings({ seed: 1 })), { peer: 'p2', admin: false });
    host.s.hostGame(g);
    expect(await room.until(() => guest.s.hostedTown() !== null, 100)).toBe(true);
    const b2 = new Bot(commandProxy(g, (c) => host.s.dispatch(c)));
    const joinAt = room.hub.now;
    guest.s.join();
    expect(await room.until(() => guest.s.status().mode === 'guest', 3000, 50, () => b2.tick())).toBe(true);
    log(`join over the room: ${((room.hub.now - joinAt) / 1000).toFixed(1)} s virtual, ${JSON.stringify(guest.s.stats.lastJoin)}`);
    const end = g.state.time.elapsed + YEAR_SECONDS / 2;
    const f0 = performance.now();
    let frames = 0;
    await room.until(() => g.state.time.elapsed >= end, 20_000, 50, () => {
      b2.tick();
      frames++;
    });
    const frameMs = ms(f0) / frames;
    host.s.setSpeed(0);
    expect(await room.until(() => guest.s.currentTick === host.s.currentTick, 600)).toBe(true);
    expect(stateDiff(g, guest.s.game)).toBe('');
    expect(guest.s.stats.hashMismatches).toBe(0);
    expect(guest.s.status().resyncs).toBe(0);
    expect(room.hub.stats.maxEventBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    log(`half a year of co-op at 10x: ${frames} frames, ${frameMs.toFixed(2)} ms per frame for BOTH peers (of which ~${(2 * 2 * stepMs).toFixed(2)} ms simulating 2 ticks per peer), ` +
      `guest hash checks ${guest.s.stats.hashChecks}, turns ${host.s.stats.turnsSent}, events ${room.hub.stats.events}, dropped ${room.hub.stats.dropped}`);
  });
});
