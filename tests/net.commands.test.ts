/**
 * Command layer: sanitising untrusted commands, applying them with real results, and side-effect-free pre-checks.
 */
import { describe, expect, it } from 'vitest';
import { applyCommand, precheckCommand, sanitizeCommand } from '../src/net/commands';
import { hashGameState } from '../src/net/hash';
import type { Command } from '../src/net/types';
import { Game } from '../src/sim/game';
import { findPlacement, settings } from './simcore.helpers';

describe('sanitizeCommand', () => {
  it('accepts well-formed commands and returns clean copies', () => {
    const raw = { op: 'place', type: 'woodenHouse', x: 10, z: 12, rot: 1, extra: 'junk' };
    expect(sanitizeCommand(raw)).toEqual({ op: 'place', type: 'woodenHouse', x: 10, z: 12, rot: 1 });
    expect(sanitizeCommand({ op: 'road', kind: 'stone', tiles: [1, 2, 3] })).toEqual({ op: 'road', kind: 'stone', tiles: [1, 2, 3] });
    expect(sanitizeCommand({ op: 'speed', speed: 5 })).toEqual({ op: 'speed', speed: 5 });
    expect(sanitizeCommand({ op: 'requestMerchant', kind: null })).toEqual({ op: 'requestMerchant', kind: null });
    expect(sanitizeCommand({ op: 'trade', give: { log: 10, stone: 0 }, take: [{ offerIndex: 1, amount: 2 }] }))
      .toEqual({ op: 'trade', give: { log: 10 }, take: [{ offerIndex: 1, amount: 2 }] });
  });

  it('rejects malformed or hostile commands', () => {
    const bad: unknown[] = [
      null, 42, {}, { op: 'nuke' }, { op: 'place', type: '__proto__', x: 1, z: 1, rot: 0 }, { op: 'place', type: 'well', x: 1.5, z: 1, rot: 0 },
      { op: 'place', type: 'well', x: 1, z: 1, rot: 7 }, { op: 'road', kind: 'gold', tiles: [1] }, { op: 'road', kind: 'dirt', tiles: new Array(401).fill(1) },
      { op: 'road', kind: 'dirt', tiles: [-1] }, { op: 'mark', x0: 0, z0: 0, x1: 1, z1: 1, filter: 'people' }, { op: 'workers', id: 1, n: 1e9 },
      { op: 'speed', speed: 3 }, { op: 'crop', id: 1, choice: 'toString' }, { op: 'trade', give: { gold: 1 }, take: [] },
      { op: 'pause', id: 1, paused: 'yes' }, { op: 'nomads', accept: 1 },
    ];
    for (const b of bad) expect(sanitizeCommand(b), JSON.stringify(b)).toBeNull();
  });
});

describe('applyCommand / precheckCommand', () => {
  it('reports real outcomes and pre-checks without mutating', () => {
    const g = Game.create(settings({ seed: 5150 }));
    const c = g.townCenter();
    const spot = findPlacement(g, 'woodenHouse', c.x + 6, c.z + 6, { allowClearing: true })!;
    const place: Command = { op: 'place', type: 'woodenHouse', x: spot.x, z: spot.z, rot: spot.rot };
    const before = hashGameState(g);
    expect(precheckCommand(g, place).ok).toBe(true);
    expect(precheckCommand(g, { op: 'workers', id: 424242, n: 2 })).toMatchObject({ ok: false });
    expect(precheckCommand(g, { op: 'nomads', accept: true })).toMatchObject({ ok: false });
    expect(precheckCommand(g, { op: 'trade', give: { log: 5 }, take: [{ offerIndex: 0, amount: 1 }] })).toMatchObject({ ok: false });
    expect(hashGameState(g)).toBe(before);

    const r = applyCommand(g, place);
    expect(r.ok).toBe(true);
    expect(g.getBuilding(r.buildingId!)?.type).toBe('woodenHouse');
    const again = applyCommand(g, place);
    expect(again.ok).toBe(false);
    expect(again.reason).toBeTruthy();
    expect(precheckCommand(g, place).ok).toBe(false);

    const W = g.state.W;
    const tiles = [];
    for (let k = 0; k < 8; k++) tiles.push(Math.floor(c.z - 8) * W + Math.floor(c.x) + k);
    const road = applyCommand(g, { op: 'road', kind: 'dirt', tiles });
    expect(road.ok).toBe(true);
    expect(road.count).toBeGreaterThan(0);
    expect(applyCommand(g, { op: 'road', kind: 'dirt', tiles }).count).toBe(0); // already there: fine, nothing new
    expect(applyCommand(g, { op: 'removeRoad', tiles }).count).toBe(road.count);
    const marked = applyCommand(g, { op: 'mark', x0: 0, z0: 0, x1: W - 1, z1: 20, filter: 'trees' });
    expect(marked.count).toBeGreaterThan(0);
    expect(applyCommand(g, { op: 'unmark', x0: 0, z0: 0, x1: W - 1, z1: 20 }).count).toBeGreaterThan(0);
    const house = g.getBuilding(r.buildingId!)!;
    expect(applyCommand(g, { op: 'priority', id: house.id, priority: true }).ok).toBe(true);
    expect(house.priority).toBe(true);
    expect(applyCommand(g, { op: 'builders', n: 3 }).ok).toBe(true);
    expect(g.state.buildersDesired).toBe(3);
    const field = g.state.buildings.find((b) => b.type === 'cropField');
    if (field) expect(applyCommand(g, { op: 'crop', id: field.id, choice: 'cherry' }).ok).toBe(false);
    expect(applyCommand(g, { op: 'speed', speed: 5 }).ok).toBe(true);
    expect(g.speed).toBe(5);
    expect(applyCommand(g, { op: 'demolish', id: house.id }).ok).toBe(true);
    expect(g.getBuilding(house.id)).toBeUndefined(); // a construction site is cancelled at once
    expect(applyCommand(g, { op: 'bogus' } as unknown as Command)).toMatchObject({ ok: false, reason: 'Invalid command.' });
  });
});
