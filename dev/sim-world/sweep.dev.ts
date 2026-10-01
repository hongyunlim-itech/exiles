import { test } from 'vitest';
import { MAX_BUILD_SLOPE } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { Feature, Terrain } from '../../src/core/types';
import type { MapSize, TerrainStyle } from '../../src/core/types';
import { generateWorld } from '../../src/sim/worldgen';
import { countStartResources, START_MIN } from '../../src/sim/world/start';
import { heightConsistencyErrors } from '../../src/sim/world/relief';
import { makeSettings } from '../../tests/simworld.helpers';

test('seed sweep', () => {
  const n = Number(process.env.N ?? 40);
  let fails = 0;
  let maxMs = 0;
  let totalMs = 0;
  let runs = 0;
  for (const terrain of ['valleys', 'mountains', 'lakes'] as TerrainStyle[]) {
    for (const mapSize of ['small', 'medium', 'large'] as MapSize[]) {
      for (let seed = 1000; seed < 1000 + n; seed++) {
        let id = 1;
        const t0 = performance.now();
        const r = generateWorld(makeSettings({ seed, terrain, mapSize }), new Rng(1), () => id++);
        const ms = performance.now() - t0;
        maxMs = Math.max(maxMs, ms); totalMs += ms; runs++;
        const { W, H, tiles, startX: sx, startZ: sz } = r;
        const problems: string[] = [];
        if (heightConsistencyErrors(r) > 0) problems.push('heights');
        let feats = 0, maxSlope = 0, nonLand = 0;
        for (let z = sz - 12; z < sz + 12; z++) for (let x = sx - 12; x < sx + 12; x++) {
          const i = z * W + x;
          const t = tiles.terrain[i];
          if (t !== Terrain.Grass && t !== Terrain.Sand) nonLand++;
          if (tiles.feature[i] !== Feature.None) feats++;
          const c = z * (W + 1) + x;
          const hs = [tiles.height[c], tiles.height[c + 1], tiles.height[c + W + 1], tiles.height[c + W + 2]];
          maxSlope = Math.max(maxSlope, Math.max(...hs) - Math.min(...hs));
        }
        if (nonLand) problems.push(`nonLand ${nonLand}`);
        if (maxSlope > 0.25) problems.push(`slope ${maxSlope.toFixed(2)}`);
        if (feats > 57) problems.push(`features ${feats}`);
        const res = countStartResources(W, H, tiles, sx, sz);
        for (const k of ['trees', 'rocks', 'iron', 'water'] as const) if (res[k] < START_MIN[k]) problems.push(`${k} ${res[k]}`);
        const herds = new Set(r.animals.map((a) => a.herd)).size;
        if (herds < 4) problems.push(`herds ${herds}`);
        if (problems.length) { fails++; console.log(`${terrain}/${mapSize}/${seed}: ${problems.join(', ')}`); }
        void MAX_BUILD_SLOPE; void H;
      }
    }
  }
  console.log(`runs ${runs} fails ${fails} avg ${(totalMs / runs).toFixed(0)}ms max ${maxMs.toFixed(0)}ms`);
});
