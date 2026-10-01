import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { MapSize, NewGameSettings, TerrainStyle } from '../../src/core/types';
import { Feature, Terrain } from '../../src/core/types';
import { generateWorld } from '../../src/sim/worldgen';
import { countStartResources } from '../../src/sim/world/start';
import { heightConsistencyErrors } from '../../src/sim/world/relief';
import { renderWorld } from './mapimage';
import { encodePng } from './png';

const styles: TerrainStyle[] = (process.env.STYLES?.split(',') as TerrainStyle[]) ?? ['valleys', 'mountains', 'lakes'];
const sizes: MapSize[] = (process.env.SIZES?.split(',') as MapSize[]) ?? ['medium'];
const seeds = (process.env.SEEDS ?? '1,2').split(',').map(Number);

test('render maps', () => {
  mkdirSync('dev/sim-world/out', { recursive: true });
  for (const style of styles) {
    for (const size of sizes) {
      for (const seed of seeds) {
        const settings: NewGameSettings = { seed, townName: 'T', mapSize: size, terrain: style, climate: 'fair', difficulty: 'medium', disasters: true };
        let id = 1;
        const t0 = performance.now();
        const res = generateWorld(settings, new Rng(seed), () => id++);
        const ms = performance.now() - t0;
        const N = res.W * res.H;
        const counts = [0, 0, 0, 0, 0];
        let trees = 0, rocks = 0, iron = 0;
        for (let i = 0; i < N; i++) {
          counts[res.tiles.terrain[i]]++;
          const f = res.tiles.feature[i];
          if (f === Feature.Tree) trees++;
          else if (f === Feature.Rock) rocks++;
          else if (f === Feature.Iron) iron++;
        }
        const sr = countStartResources(res.W, res.H, res.tiles, res.startX, res.startZ);
        const bad = heightConsistencyErrors(res);
        const pct = (n: number) => ((n / N) * 100).toFixed(1) + '%';
        console.log(`${style}/${size}/seed${seed}: ${ms.toFixed(0)}ms grass ${pct(counts[Terrain.Grass])} sand ${pct(counts[Terrain.Sand])} water ${pct(counts[Terrain.Water])} deep ${pct(counts[Terrain.DeepWater])} mtn ${pct(counts[Terrain.Mountain])} | trees ${trees} rocks ${rocks} iron ${iron} deer ${res.animals.length} | start (${res.startX},${res.startZ}) res ${JSON.stringify(sr)} | heightErr ${bad}`);
        const img = renderWorld(res.W, res.H, res.tiles, res.animals, res.startX, res.startZ, Number(process.env.SCALE ?? 3));
        writeFileSync(`dev/sim-world/out/${style}-${size}-${seed}.png`, encodePng(img.w, img.h, img.rgb));
      }
    }
  }
});
