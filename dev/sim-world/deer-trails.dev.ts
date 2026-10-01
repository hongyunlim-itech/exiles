import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { updateNature } from '../../src/sim/nature';
import { makeSettings, makeWorldState, mockGame } from '../../tests/simworld.helpers';
import { renderWorld } from './mapimage';
import { encodePng } from './png';

test('deer trails', () => {
  const { state, startX, startZ } = makeWorldState(makeSettings({ seed: 4, mapSize: 'small', terrain: 'valleys' }));
  const g = mockGame(state);
  const scale = 5;
  const img = renderWorld(state.W, state.H, state.tiles, [], startX, startZ, scale);
  const colors = [[255, 40, 40], [255, 160, 0], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [0, 128, 255], [128, 255, 0], [255, 128, 128], [160, 80, 255]];
  const minutes = Number(process.env.MIN ?? 20);
  let movingFrac = 0, samples = 0;
  for (let t = 0; t < minutes * 60; t += 0.25) {
    updateNature(g, 0.25);
    for (const a of state.animals) {
      const px = Math.floor(a.x * scale), pz = Math.floor(a.z * scale);
      const o = (pz * img.w + px) * 3;
      const c = colors[a.herd % colors.length];
      img.rgb[o] = c[0]; img.rgb[o + 1] = c[1]; img.rgb[o + 2] = c[2];
      if (a.moving) movingFrac++;
      samples++;
    }
  }
  console.log(`deer ${state.animals.length}, moving ${(100 * movingFrac / samples).toFixed(0)}% of the time`);
  writeFileSync('dev/sim-world/out/deer-trails.png', encodePng(img.w, img.h, img.rgb));
});
