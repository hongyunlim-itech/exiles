import { describe, expect, it } from 'vitest';
import { SAVE_VERSION } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import type { Building, Citizen, GameState } from '../src/core/types';
import { Feature, Road, Terrain } from '../src/core/types';
import { computeRegions } from '../src/sim/pathfinding';
import { deserializeState, serializeState } from '../src/sim/save';
import {
  decodeZigzagVarints, encodeZigzagVarints, fromBase64, packBits, shuffleBytes, toBase64, unpackBits, unshuffleBytes,
} from '../src/sim/world/codec';
import { makeSettings, makeWorldState } from './simworld.helpers';

function richState(): GameState {
  const { state: s, startX, startZ } = makeWorldState(makeSettings({ seed: 31, mapSize: 'medium', terrain: 'valleys' }));
  const W = s.W;
  // Some roads and a bridge.
  for (let x = startX - 8; x < startX + 8; x++) s.tiles.road[startZ * W + x] = Road.Dirt;
  for (let z = startZ - 5; z < startZ + 5; z++) s.tiles.road[z * W + startX] = Road.Stone;
  const water = s.tiles.terrain.findIndex((t) => t === Terrain.Water);
  s.tiles.road[water] = Road.Bridge;
  // Buildings (plain JSON) + tile occupancy.
  const b: Building = {
    id: 5000, type: 'woodenHouse', x: startX + 2, z: startZ + 2, w: 3, h: 3, rotation: 1, doorX: startX + 1, doorZ: startZ + 3,
    state: 'active', progress: 1, cost: { log: 16, stone: 8 }, delivered: { log: 16, stone: 8 }, incoming: {}, workRemaining: 0,
    priority: false, paused: false, workersDesired: 0, workerIds: [], residentIds: [6000], inventory: { firewood: 12.5, wheat: 3 },
    reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0, smoking: true, producedThisYear: {}, producedLastYear: {}, builtAt: 123.25,
  };
  s.buildings.push(b);
  for (let z = b.z; z < b.z + b.h; z++) for (let x = b.x; x < b.x + b.w; x++) s.tiles.building[z * W + x] = b.id;
  const c: Citizen = {
    id: 6000, name: 'Aldric Reed', gender: 'M', age: 23.5, lifespan: 71, spouseId: -1, motherId: -1, fatherId: -1, childIds: [],
    homeId: 5000, workplaceId: -1, profession: 'laborer', food: 80.25, warmth: 99, health: 90, happiness: 55, education: 0.1,
    sick: 0, dietMask: 3, dietTimers: [10, 20, 0, 0], toolWear: 100, coatWear: 0, x: startX + 0.5, z: startZ + 0.5,
    heading: 1.25, moving: true, activity: 'walking', taskLabel: 'Walking', carrying: { type: 'log', amount: 5 },
    task: { kind: 'haul', from: 1, to: 2, nested: { a: [1, 2, 3] } }, path: [1, 2, 3], pathIndex: 1, starveTime: 0,
    freezeTime: 0, bornAt: -1000, grief: 0,
  };
  s.citizens.push(c);
  // Continuous tree growth values (general float path) and marks.
  const rng = new Rng(3);
  for (let i = 0; i < s.tiles.feature.length; i++) {
    if (s.tiles.feature[i] === Feature.Tree && rng.chance(0.2)) s.tiles.featureAmount[i] = rng.next();
    if (s.tiles.feature[i] !== Feature.None && rng.chance(0.01)) s.tiles.marked[i] = 1;
  }
  s.messages.push({ id: 1, time: 5, year: 1, month: 0, text: 'Hello', severity: 'info', target: { kind: 'tile', id: 7 } });
  s.history.push({
    year: 1, month: 0, population: 20, adults: 10, children: 5, students: 0, elderly: 5, births: 0, deaths: 0, food: 600,
    firewood: 200, logs: 150, stone: 60, iron: 30, tools: 25, clothing: 20, herbs: 20, ale: 0, avgHealth: 80, avgHappiness: 50,
    avgEducation: 0,
  });
  s.rev = { terrain: 3, features: 17, roads: 4, buildings: 2, fields: 1 };
  s.rngState = 0xdeadbeef >>> 0;
  s.time.elapsed = 1234.5;
  computeRegions(s);
  return s;
}

describe('codec', () => {
  it('packBits round-trips random, repetitive and edge-case data', () => {
    const rng = new Rng(1);
    const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([7]), new Uint8Array(1000).fill(3), new Uint8Array(129).fill(9)];
    for (let k = 0; k < 20; k++) {
      const n = rng.int(1, 5000);
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = rng.chance(0.7) ? (i > 0 && rng.chance(0.8) ? a[i - 1] : 0) : rng.int(0, 255);
      cases.push(a);
    }
    for (const c of cases) expect(Array.from(unpackBits(packBits(c), c.length))).toEqual(Array.from(c));
    expect(packBits(new Uint8Array(10000)).length).toBeLessThan(200);
  });

  it('base64 matches Node Buffer encoding', () => {
    const rng = new Rng(2);
    for (let n = 0; n < 40; n++) {
      const a = new Uint8Array(n * 7 + (n % 3));
      for (let i = 0; i < a.length; i++) a[i] = rng.int(0, 255);
      const s = toBase64(a);
      expect(s).toBe(Buffer.from(a).toString('base64'));
      expect(Array.from(fromBase64(s))).toEqual(Array.from(a));
    }
    expect(() => fromBase64('abc')).toThrow();
    expect(() => fromBase64('ab$=')).toThrow();
  });

  it('zigzag varints and byte shuffling round-trip', () => {
    const v = new Int32Array([0, 1, -1, 63, -64, 64, 1000000, -1000000, 2147483647, -2147483648]);
    expect(Array.from(decodeZigzagVarints(encodeZigzagVarints(v), v.length))).toEqual(Array.from(v));
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(unshuffleBytes(shuffleBytes(b, 4), 4))).toEqual(Array.from(b));
  });
});

describe('serializeState / deserializeState', () => {
  it('round-trips a full game state exactly (typed arrays included, region rebuilt)', () => {
    const s = richState();
    const json = serializeState(s);
    const back = deserializeState(json);
    expect(back).toStrictEqual({ ...s, version: SAVE_VERSION });
    expect(back.tiles.height).toBeInstanceOf(Float32Array);
    expect(back.tiles.building).toBeInstanceOf(Int32Array);
    expect(back.tiles.region).toBeInstanceOf(Int32Array);
    // Idempotent
    expect(serializeState(back)).toBe(json);
  });

  it('handles non-quantised heights (float fallback) and negative zero', () => {
    const s = richState();
    s.tiles.height[5] = 0.123456789;
    s.tiles.height[6] = -0;
    const back = deserializeState(serializeState(s));
    expect(back.tiles.height[5]).toBe(Math.fround(0.123456789));
    expect(Object.is(back.tiles.height[6], -0)).toBe(true);
    expect(Buffer.from(back.tiles.height.buffer).equals(Buffer.from(s.tiles.height.buffer))).toBe(true);
  });

  it('is compact', () => {
    const s = richState();
    const json = serializeState(s);
    console.log(`[save] medium map save: ${(json.length / 1024).toFixed(1)} KB`);
    expect(json.length).toBeLessThan(250 * 1024);
  });

  it('rejects corrupt or incompatible data with clear errors', () => {
    const s = richState();
    const json = serializeState(s);
    expect(() => deserializeState('')).toThrow(/empty/);
    expect(() => deserializeState('{not json')).toThrow(/JSON/);
    expect(() => deserializeState('{"a":1}')).toThrow(/Not an Exiles save/);
    const env = JSON.parse(json);
    expect(() => deserializeState(JSON.stringify({ ...env, version: SAVE_VERSION + 1 }))).toThrow(/newer version/);
    expect(() => deserializeState(JSON.stringify({ ...env, W: -5 }))).toThrow(/map size/);
    const noTerrain = JSON.parse(json);
    delete noTerrain.tiles.terrain;
    expect(() => deserializeState(JSON.stringify(noTerrain))).toThrow(/tiles.terrain/);
    const truncated = JSON.parse(json);
    truncated.tiles.feature = truncated.tiles.feature.slice(0, 40);
    expect(() => deserializeState(JSON.stringify(truncated))).toThrow(/tiles.feature/);
    const noCitizens = JSON.parse(json);
    delete noCitizens.state.citizens;
    expect(() => deserializeState(JSON.stringify(noCitizens))).toThrow(/citizens/);
  });
});
