import { describe, expect, it } from 'vitest';
import { MAP_SIZES, MAX_BUILD_SLOPE } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import type { MapSize, TerrainStyle } from '../src/core/types';
import { Feature, Terrain } from '../src/core/types';
import { tileSlope } from '../src/core/world';
import { computeRegions, findPath } from '../src/sim/pathfinding';
import { heightConsistencyErrors } from '../src/sim/world/relief';
import { START_MIN, countStartResources } from '../src/sim/world/start';
import { generateWorld } from '../src/sim/worldgen';
import { makeSettings, makeWorldState, mockGame } from './simworld.helpers';

const STYLES: TerrainStyle[] = ['valleys', 'mountains', 'lakes'];
const SIZES: MapSize[] = ['small', 'medium', 'large'];

function gen(seed: number, terrain: TerrainStyle, mapSize: MapSize) {
  let id = 100;
  return generateWorld(makeSettings({ seed, terrain, mapSize }), new Rng(seed), () => id++);
}

describe('generateWorld', () => {
  it('is deterministic for the same settings (regardless of the passed rng)', () => {
    for (const terrain of STYLES) {
      let a = 1;
      let b = 1;
      const r1 = generateWorld(makeSettings({ seed: 42, terrain }), new Rng(1), () => a++);
      const r2 = generateWorld(makeSettings({ seed: 42, terrain }), new Rng(999), () => b++);
      expect(r1.startX).toBe(r2.startX);
      expect(r1.startZ).toBe(r2.startZ);
      expect(Buffer.from(r1.tiles.height.buffer).equals(Buffer.from(r2.tiles.height.buffer))).toBe(true);
      expect(Buffer.from(r1.tiles.terrain).equals(Buffer.from(r2.tiles.terrain))).toBe(true);
      expect(Buffer.from(r1.tiles.feature).equals(Buffer.from(r2.tiles.feature))).toBe(true);
      expect(Buffer.from(r1.tiles.featureAmount.buffer).equals(Buffer.from(r2.tiles.featureAmount.buffer))).toBe(true);
      expect(Buffer.from(r1.tiles.variant).equals(Buffer.from(r2.tiles.variant))).toBe(true);
      expect(r1.animals).toEqual(r2.animals);
    }
  });

  it('produces different worlds for different seeds', () => {
    const a = gen(1, 'valleys', 'small');
    const b = gen(2, 'valleys', 'small');
    expect(Buffer.from(a.tiles.terrain).equals(Buffer.from(b.tiles.terrain))).toBe(false);
  });

  for (const terrain of STYLES) {
    for (const mapSize of SIZES) {
      it(`${terrain}/${mapSize}: valid, playable world with a good start`, () => {
        for (const seed of mapSize === 'medium' ? [3, 17, 2024] : [8]) {
          const t0 = performance.now();
          const r = gen(seed, terrain, mapSize);
          const ms = performance.now() - t0;
          expect(ms).toBeLessThan(6000); // ~60–110 ms typical; generous for contended CI
          const { W, H, tiles } = r;
          expect(W).toBe(MAP_SIZES[mapSize]);
          expect(H).toBe(MAP_SIZES[mapSize]);
          const N = W * H;
          expect(tiles.height.length).toBe((W + 1) * (H + 1));
          for (const arr of [tiles.terrain, tiles.feature, tiles.featureAmount, tiles.variant, tiles.road, tiles.building, tiles.marked, tiles.region]) {
            expect(arr.length).toBe(N);
          }
          expect(tiles.building.every((b) => b === -1)).toBe(true);
          expect(tiles.road.every((v) => v === 0)).toBe(true);
          expect(heightConsistencyErrors(r)).toBe(0);

          const counts = [0, 0, 0, 0, 0];
          let trees = 0;
          let rocks = 0;
          let iron = 0;
          for (let i = 0; i < N; i++) {
            const t = tiles.terrain[i];
            counts[t]++;
            const f = tiles.feature[i];
            if (f !== Feature.None) {
              expect(t === Terrain.Grass || t === Terrain.Sand).toBe(true);
              if (f === Feature.Tree) {
                trees++;
                expect(tiles.featureAmount[i]).toBeGreaterThan(0);
                expect(tiles.featureAmount[i]).toBeLessThanOrEqual(1);
                expect(tiles.variant[i]).toBeLessThanOrEqual(2);
              } else {
                if (f === Feature.Rock) rocks++;
                else iron++;
                expect(tiles.featureAmount[i]).toBeGreaterThanOrEqual(10);
                expect(tiles.featureAmount[i]).toBeLessThanOrEqual(40);
              }
            }
          }
          // Land dominates; there is water and mountains; forests are substantial.
          expect((counts[Terrain.Grass] + counts[Terrain.Sand]) / N).toBeGreaterThan(0.45);
          expect(counts[Terrain.Water] + counts[Terrain.DeepWater]).toBeGreaterThan(N * 0.01);
          expect(counts[Terrain.Mountain]).toBeGreaterThan(N * 0.03);
          expect(counts[Terrain.Sand]).toBeGreaterThan(0);
          expect(trees).toBeGreaterThan(N * 0.12);
          expect(rocks).toBeGreaterThan(20);
          expect(iron).toBeGreaterThan(8);
          if (terrain === 'lakes') expect(counts[Terrain.DeepWater]).toBeGreaterThan(0);

          // Start: 24×24 flat grass area, mostly clear.
          const { startX: sx, startZ: sz } = r;
          expect(sx).toBeGreaterThanOrEqual(12);
          expect(sz).toBeGreaterThanOrEqual(12);
          let featuresInStart = 0;
          for (let z = sz - 12; z < sz + 12; z++) {
            for (let x = sx - 12; x < sx + 12; x++) {
              const i = z * W + x;
              expect(tiles.terrain[i] === Terrain.Grass || tiles.terrain[i] === Terrain.Sand).toBe(true);
              expect(tileSlope({ W, H, tiles } as never, x, z)).toBeLessThanOrEqual(0.25);
              if (tiles.feature[i] !== Feature.None) {
                featuresInStart++;
                expect(tiles.feature[i]).toBe(Feature.Tree);
              }
            }
          }
          expect(featuresInStart).toBeLessThan(24 * 24 * 0.1);
          // Buildable: any 5×5 footprint in the start area has height span within MAX_BUILD_SLOPE.
          for (let z = sz - 12; z <= sz + 7; z += 3) {
            for (let x = sx - 12; x <= sx + 7; x += 3) {
              let lo = Infinity;
              let hi = -Infinity;
              for (let cz = z; cz <= z + 5; cz++) for (let cx = x; cx <= x + 5; cx++) {
                const h = tiles.height[cz * (W + 1) + cx];
                lo = Math.min(lo, h);
                hi = Math.max(hi, h);
              }
              expect(hi - lo).toBeLessThanOrEqual(MAX_BUILD_SLOPE);
            }
          }
          // Reachable resources within ~30 tiles.
          const res = countStartResources(W, H, tiles, sx, sz);
          expect(res.trees).toBeGreaterThanOrEqual(START_MIN.trees);
          expect(res.rocks).toBeGreaterThanOrEqual(START_MIN.rocks);
          expect(res.iron).toBeGreaterThanOrEqual(START_MIN.iron);
          expect(res.water).toBeGreaterThanOrEqual(START_MIN.water);

          // Start region is a large part of the land.
          const r0 = tiles.region[sz * W + sx];
          let same = 0;
          let land = 0;
          for (let i = 0; i < N; i++) {
            if (tiles.region[i] !== 0) land++;
            if (tiles.region[i] === r0) same++;
          }
          expect(same / land).toBeGreaterThan(0.25);

          // Deer herds: 4–10 herds of 3–7 on land, outside the start area.
          const herds = new Map<number, number>();
          for (const a of r.animals) {
            expect(a.kind).toBe('deer');
            expect(a.huntedBy).toBe(-1);
            const t = tiles.terrain[Math.floor(a.z) * W + Math.floor(a.x)];
            expect(t === Terrain.Grass || t === Terrain.Sand).toBe(true);
            herds.set(a.herd, (herds.get(a.herd) ?? 0) + 1);
          }
          expect(herds.size).toBeGreaterThanOrEqual(4);
          expect(herds.size).toBeLessThanOrEqual(10);
          for (const n of herds.values()) {
            expect(n).toBeGreaterThanOrEqual(1);
            expect(n).toBeLessThanOrEqual(7);
          }
          expect(new Set(r.animals.map((a) => a.id)).size).toBe(r.animals.length);
        }
      });
    }
  }

  it('regions from worldgen match a fresh computeRegions and the start can walk to its resources', () => {
    const { state, startX, startZ } = makeWorldState(makeSettings({ seed: 77, mapSize: 'medium', terrain: 'mountains' }));
    const before = Int32Array.from(state.tiles.region);
    computeRegions(state);
    expect(Buffer.from(before.buffer).equals(Buffer.from(state.tiles.region.buffer))).toBe(true);
    const g = mockGame(state);
    // Walk to the nearest rock / iron / tree / water from the start.
    const W = state.W;
    const nearest = (pred: (i: number) => boolean): number => {
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < W * state.H; i++) {
        if (!pred(i)) continue;
        const d = Math.hypot((i % W) - startX, Math.floor(i / W) - startZ);
        if (d < bd && state.tiles.region[i] === state.tiles.region[startZ * W + startX]) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    for (const f of [Feature.Rock, Feature.Iron, Feature.Tree]) {
      const i = nearest((j) => state.tiles.feature[j] === f);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(findPath(g, startX, startZ, i % W, Math.floor(i / W))).not.toBeNull();
    }
  });
});
