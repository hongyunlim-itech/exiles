import { test } from 'vitest';
import { Rng } from '../../src/core/rng';
import { breedDeer, updateDeer } from '../../src/sim/world/deer';
import { updateTrees } from '../../src/sim/world/trees';
import { updateNature } from '../../src/sim/nature';
import { generateWorld } from '../../src/sim/worldgen';
import { makeSettings, makeWorldState, mockGame } from '../../tests/simworld.helpers';

test('nature cost breakdown', () => {
  for (const terrain of ['valleys', 'mountains', 'lakes'] as const) {
    const s = makeSettings({ seed: 11, terrain, mapSize: 'large' });
    let id = 1;
    const gens: number[] = [];
    for (let k = 0; k < 5; k++) {
      const tg = performance.now();
      generateWorld(s, new Rng(1), () => id++);
      gens.push(performance.now() - tg);
    }
    const { state } = makeWorldState(s);
    const g = mockGame(state);
    const rng = new Rng(5);
    const STEPS = 4000;
    const t0 = performance.now();
    for (let k = 0; k < STEPS; k++) updateDeer(g, 0.25);
    const deerMs = (performance.now() - t0) / STEPS;
    const t1 = performance.now();
    for (let k = 0; k < 200; k++) updateTrees(state, rng, 2);
    const treeMs = (performance.now() - t1) / 200;
    const t2 = performance.now();
    for (let k = 0; k < 200; k++) breedDeer(g, 2);
    const breedMs = (performance.now() - t2) / 200;
    const t3 = performance.now();
    for (let k = 0; k < STEPS; k++) updateNature(g, 0.25);
    const natMs = (performance.now() - t3) / STEPS;
    console.log(`  updateNature per step (dt 0.25): ${natMs.toFixed(4)}ms`);
    gens.sort((a, b) => a - b);
    console.log(`${terrain}/large: generateWorld median ${gens[2].toFixed(0)}ms (min ${gens[0].toFixed(0)}), updateDeer ${deerMs.toFixed(4)}ms/step for ${state.animals.length} deer, tree pass ${treeMs.toFixed(3)}ms (every ${2}s game time), breed ${breedMs.toFixed(4)}ms`);
  }
});
