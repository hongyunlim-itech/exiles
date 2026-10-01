import { describe, expect, it } from 'vitest';
import { TREE_GROWTH_RATE, YEAR_SECONDS } from '../src/core/constants';
import type { Animal } from '../src/core/types';
import { Feature, Road, Terrain } from '../src/core/types';
import { FEATURE_BUMP_INTERVAL, countTreesInRadius, deerCap, removeAnimal, updateNature } from '../src/sim/nature';
import { TREE_SWEEP_SECONDS } from '../src/sim/world/trees';
import { HERD_MAX, type DeerWander } from '../src/sim/world/deer';
import { addBuilding, makeSettings, makeState, makeWorldState, mockGame } from './simworld.helpers';

function run(game: ReturnType<typeof mockGame>, seconds: number, dt = 0.25, each?: () => void): void {
  for (let t = 0; t < seconds; t += dt) {
    updateNature(game, dt);
    each?.();
  }
}

describe('trees', () => {
  it('saplings grow at TREE_GROWTH_RATE and cap at 1; rev.features bumps are batched', () => {
    const s = makeState(20, 20);
    const i = 5 * 20 + 5;
    s.tiles.feature[i] = Feature.Tree;
    s.tiles.featureAmount[i] = 0.1;
    const j = 6 * 20 + 6;
    s.tiles.feature[j] = Feature.Tree;
    s.tiles.featureAmount[j] = 0.999;
    const g = mockGame(s);
    const rev0 = s.rev.features;
    run(g, 60);
    // Rows are swept incrementally: growth lags by at most one sweep period.
    const grown = s.tiles.featureAmount[i] - 0.1;
    expect(grown).toBeLessThanOrEqual(60 * TREE_GROWTH_RATE + 1e-6);
    expect(grown).toBeGreaterThanOrEqual((60 - TREE_SWEEP_SECONDS) * TREE_GROWTH_RATE - 1e-6);
    expect(s.tiles.featureAmount[j]).toBe(1);
    // Batched: at most one bump per FEATURE_BUMP_INTERVAL.
    expect(s.rev.features - rev0).toBeLessThanOrEqual(Math.ceil(60 / FEATURE_BUMP_INTERVAL));
    expect(s.rev.features - rev0).toBeGreaterThan(0);
  });

  it('does not bump rev.features when nothing visibly changes', () => {
    const s = makeState(10, 10);
    const g = mockGame(s);
    run(g, 30);
    expect(s.rev.features).toBe(0);
  });

  it('forests spread slowly, never onto buildings, roads, water, sand or marked tiles', () => {
    const s = makeState(40, 40);
    const W = 40;
    // A block of mature trees surrounded by forbidden tiles and a free strip.
    for (let z = 10; z < 30; z++) for (let x = 10; x < 30; x++) {
      const i = z * W + x;
      s.tiles.feature[i] = Feature.Tree;
      s.tiles.featureAmount[i] = 1;
    }
    for (let z = 0; z < 40; z++) {
      for (const x of [7, 8, 9]) s.tiles.road[z * W + x] = Road.Dirt;
      for (const x of [30, 31]) s.tiles.terrain[z * W + x] = Terrain.Water;
      s.tiles.terrain[z * W + 32] = Terrain.Sand;
    }
    for (let x = 10; x < 30; x++) s.tiles.marked[31 * W + x] = 1;
    const g = mockGame(s);
    addBuilding(g, 'woodenHouse', 12, 5, 3, 3);
    const treesBefore = s.tiles.feature.reduce((n, f) => n + (f === Feature.Tree ? 1 : 0), 0);
    run(g, YEAR_SECONDS * 30, 1);
    let spread = 0;
    for (let i = 0; i < W * 40; i++) {
      if (s.tiles.feature[i] !== Feature.Tree) continue;
      const x = i % W;
      const z = Math.floor(i / W);
      if (x >= 10 && x < 30 && z >= 10 && z < 30) continue;
      spread++;
      expect(s.tiles.terrain[i]).toBe(Terrain.Grass);
      expect(s.tiles.road[i]).toBe(Road.None);
      expect(s.tiles.building[i]).toBe(-1);
      expect(s.tiles.marked[i]).toBe(0);
    }
    // Only edge trees find room: a handful to a few dozen seedlings over 30 years.
    expect(spread).toBeGreaterThan(3);
    expect(spread).toBeLessThan(treesBefore * 0.4);
  });

  it('countTreesInRadius counts mature (>= 0.5) trees in a circle', () => {
    const s = makeState(20, 20);
    const g = mockGame(s);
    const put = (x: number, z: number, a: number) => {
      s.tiles.feature[z * 20 + x] = Feature.Tree;
      s.tiles.featureAmount[z * 20 + x] = a;
    };
    put(10, 10, 1);
    put(11, 10, 0.5);
    put(12, 10, 0.49);
    put(15, 10, 1);
    s.tiles.feature[9 * 20 + 10] = Feature.Rock;
    expect(countTreesInRadius(g, 10.5, 10.5, 2.5)).toBe(2);
    expect(countTreesInRadius(g, 10.5, 10.5, 6)).toBe(3);
  });
});

describe('deer', () => {
  it('wander smoothly on walkable land near their herd for a long time', () => {
    const { state } = makeWorldState(makeSettings({ seed: 4, mapSize: 'small', terrain: 'valleys' }));
    const g = mockGame(state);
    const W = state.W;
    const start = new Map(state.animals.map((a) => [a.id, { x: a.x, z: a.z }]));
    let movedSteps = 0;
    let maxStep = 0;
    const last = new Map(state.animals.map((a) => [a.id, { x: a.x, z: a.z }]));
    run(g, 600, 0.25, () => {
      for (const a of state.animals) {
        const t = state.tiles.terrain[Math.floor(a.z) * W + Math.floor(a.x)];
        expect(t === Terrain.Grass || t === Terrain.Sand).toBe(true);
        expect(Number.isFinite(a.heading)).toBe(true);
        const p = last.get(a.id);
        if (p) {
          const d = Math.hypot(a.x - p.x, a.z - p.z);
          maxStep = Math.max(maxStep, d);
          if (a.moving) movedSteps++;
        }
        last.set(a.id, { x: a.x, z: a.z });
      }
    });
    expect(movedSteps).toBeGreaterThan(0);
    expect(maxStep).toBeLessThan(0.8); // continuous movement, no teleports
    // Herds stay cohesive: every deer within ~16 tiles of its herd's centroid.
    const herds = new Map<number, Animal[]>();
    for (const a of state.animals) herds.set(a.herd, [...(herds.get(a.herd) ?? []), a]);
    for (const list of herds.values()) {
      const cx = list.reduce((s, a) => s + a.x, 0) / list.length;
      const cz = list.reduce((s, a) => s + a.z, 0) / list.length;
      for (const a of list) expect(Math.hypot(a.x - cx, a.z - cz)).toBeLessThan(16);
    }
    // Most deer moved from where they started.
    let moved = 0;
    for (const a of state.animals) {
      const s0 = start.get(a.id);
      if (s0 && Math.hypot(a.x - s0.x, a.z - s0.z) > 1) moved++;
    }
    expect(moved).toBeGreaterThan(state.animals.length / 2);
  });

  it('never walk into non-walkable buildings or water', () => {
    const s = makeState(30, 30);
    const W = 30;
    for (let z = 0; z < 30; z++) for (let x = 0; x < 30; x++) {
      if (x < 3 || x > 26) s.tiles.terrain[z * W + x] = Terrain.Water;
      else if ((x + z) % 3 === 0) {
        s.tiles.feature[z * W + x] = Feature.Tree;
        s.tiles.featureAmount[z * W + x] = 1;
      }
    }
    const g = mockGame(s);
    addBuilding(g, 'storageBarn', 12, 12, 5, 5);
    for (let k = 0; k < 6; k++) {
      const a: Animal = { id: 900 + k, kind: 'deer', x: 8 + k * 0.5, z: 8, heading: 0, moving: false, herd: 1, huntedBy: -1, wander: null };
      s.animals.push(a);
      g.animalById.set(a.id, a);
    }
    run(g, 900, 0.25, () => {
      for (const a of s.animals) {
        const i = Math.floor(a.z) * W + Math.floor(a.x);
        expect(s.tiles.terrain[i]).toBe(Terrain.Grass);
        expect(s.tiles.building[i]).toBe(-1);
      }
    });
  });

  it('hunted deer stand still; released when the hunter disappears', () => {
    const { state } = makeWorldState(makeSettings({ seed: 9, mapSize: 'small' }));
    const g = mockGame(state);
    const a = state.animals[0];
    a.huntedBy = 12345;
    (g.citizenById as Map<number, unknown>).set(12345, { id: 12345 });
    const x = a.x;
    const z = a.z;
    run(g, 30);
    expect(a.x).toBe(x);
    expect(a.z).toBe(z);
    expect(a.moving).toBe(false);
    (g.citizenById as Map<number, unknown>).delete(12345);
    (g.citizenById as Map<number, unknown>).set(1, { id: 1 });
    run(g, 1);
    expect(a.huntedBy).toBe(-1);
  });

  it('removeAnimal removes from state and index; herd leadership passes on', () => {
    const { state } = makeWorldState(makeSettings({ seed: 9, mapSize: 'small' }));
    const g = mockGame(state);
    const herd = state.animals[0].herd;
    const leader = state.animals.filter((a) => a.herd === herd).sort((p, q) => p.id - q.id)[0];
    removeAnimal(g, leader.id);
    expect(state.animals.find((a) => a.id === leader.id)).toBeUndefined();
    expect(g.animalById.has(leader.id)).toBe(false);
    run(g, 5);
    const newLeader = state.animals.filter((a) => a.herd === herd).sort((p, q) => p.id - q.id)[0];
    if (newLeader) expect(typeof (newLeader.wander as DeerWander).gx).toBe('number');
  });

  it('breed slowly up to the caps and keep wander state JSON-serializable', () => {
    const { state } = makeWorldState(makeSettings({ seed: 21, mapSize: 'small' }));
    const g = mockGame(state);
    const n0 = state.animals.length;
    run(g, YEAR_SECONDS * 2, 1);
    const n2 = state.animals.length;
    expect(n2).toBeGreaterThanOrEqual(n0);
    run(g, YEAR_SECONDS * 20, 2);
    // herds always refill up to HERD_MAX (so hunted-out ranges recover); the global cap only stops new herds from
    // splitting off, which keeps the total bounded
    expect(state.animals.length).toBeLessThanOrEqual(deerCap(state) * 2);
    const sizes = new Map<number, number>();
    for (const a of state.animals) sizes.set(a.herd, (sizes.get(a.herd) ?? 0) + 1);
    for (const n of sizes.values()) expect(n).toBeLessThanOrEqual(HERD_MAX);
    expect(new Set(state.animals.map((a) => a.id)).size).toBe(state.animals.length);
    for (const a of state.animals) expect(g.animalById.get(a.id)).toBe(a);
    const copy = JSON.parse(JSON.stringify(state.animals));
    expect(copy).toEqual(state.animals);
  });

  it('a new herd wanders in when the wild population collapses', () => {
    const { state } = makeWorldState(makeSettings({ seed: 21, mapSize: 'small' }));
    const g = mockGame(state);
    for (const a of [...state.animals]) removeAnimal(g, a.id);
    run(g, YEAR_SECONDS * 12, 2);
    expect(state.animals.length).toBeGreaterThan(0);
  });
});
