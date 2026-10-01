import { test } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Road, Terrain } from '../../src/core/types';
import { computeRegions, findPath } from '../../src/sim/pathfinding';
import { makeSettings, makeWorldState, mockGame } from '../../tests/simworld.helpers';

test('pathfinding benchmark', () => {
  for (const style of ['valleys', 'mountains', 'lakes'] as const) {
    const { state, startX, startZ } = makeWorldState(makeSettings({ mapSize: 'large', seed: 3, terrain: style }));
    const g = mockGame(state);
    computeRegions(state);
    const W = state.W;
    const land: number[] = [];
    for (let i = 0; i < state.tiles.terrain.length; i++) {
      const t = state.tiles.terrain[i];
      if (t === Terrain.Grass || t === Terrain.Sand) land.push(i);
    }
    const run = (label: string, maxD: number, runs: number) => {
      const rng = new Rng(11);
      let total = 0, max = 0, found = 0;
      const times: number[] = [];
      for (let k = 0; k < runs; k++) {
        let ax: number, az: number;
        if (maxD < 100) {
          ax = Math.max(0, Math.min(W - 1, startX + rng.int(-30, 30)));
          az = Math.max(0, Math.min(W - 1, startZ + rng.int(-30, 30)));
        } else {
          const a = land[Math.floor(rng.next() * land.length)];
          ax = a % W; az = Math.floor(a / W);
        }
        const b = land[Math.floor(rng.next() * land.length)];
        let bx = b % W, bz = Math.floor(b / W);
        if (maxD < 100) { bx = Math.max(0, Math.min(W - 1, ax + rng.int(-maxD, maxD))); bz = Math.max(0, Math.min(W - 1, az + rng.int(-maxD, maxD))); }
        const t0 = performance.now();
        const p = findPath(g, ax, az, bx, bz);
        const dt = performance.now() - t0;
        times.push(dt);
        total += dt; max = Math.max(max, dt); if (p) found++;
      }
      times.sort((a, b) => a - b);
      console.log(`${style} ${label}: avg ${(total / runs).toFixed(3)}ms p95 ${times[Math.floor(runs * 0.95)].toFixed(2)}ms max ${max.toFixed(2)}ms found ${found}/${runs}`);
    };
    run('town trips (<=40) no roads', 40, 500);
    run('cross-map no roads', 999, 200);
    // Road grid in town area (dirt), plus a stone road
    for (let z = startZ - 30; z <= startZ + 30; z++) for (let x = startX - 30; x <= startX + 30; x++) {
      if (x < 0 || z < 0 || x >= W || z >= W) continue;
      const i = z * W + x;
      if ((x - startX) % 8 === 0 || (z - startZ) % 8 === 0) {
        const t = state.tiles.terrain[i];
        if (t === Terrain.Grass || t === Terrain.Sand) state.tiles.road[i] = (z === startZ) ? Road.Stone : Road.Dirt;
      }
    }
    state.rev.roads++;
    run('town trips (<=40) roads', 40, 500);
    run('cross-map roads', 999, 200);
  }
});
