import { describe, expect, it } from 'vitest';
import { igniteBuilding, updateDisasters } from '../src/sim/disasters';
import { infectCitizen } from '../src/sim/ext/disease';
import { updateNomads } from '../src/sim/nomads';
import { updateStats } from '../src/sim/stats';
import { updateTrade } from '../src/sim/trade';
import { updateWellbeing } from '../src/sim/wellbeing';
import { advanceTime, createFakeGame } from './simext.fake';

describe('sim-ext performance', () => {
  it('keeps the per-step cost low with ~200 citizens and ~120 buildings', () => {
    const g = createFakeGame({ W: 160, H: 160, seed: 99 });
    const houses = [];
    for (let i = 0; i < 100; i++) {
      houses.push(g.addBuilding('woodenHouse', 4 + (i % 20) * 7, 4 + Math.floor(i / 20) * 7, { inventory: { herbs: 3 } }));
    }
    for (let i = 0; i < 6; i++) g.addBuilding('well', 10 + i * 20, 50);
    const chapel = g.addBuilding('chapel', 30, 60);
    const tavern = g.addBuilding('tavern', 60, 60, { inventory: { ale: 500 } });
    const hospital = g.addBuilding('hospital', 90, 60, { inventory: { herbs: 500 } });
    g.addBuilding('storageBarn', 120, 60, { inventory: { wheat: 2000, tool: 50 } });
    g.addBuilding('stockpile', 120, 70, { inventory: { log: 200, firewood: 100 } });
    g.addBuilding('cemetery', 130, 90, { w: 8, h: 8 });
    for (let i = 0; i < 200; i++) {
      const h = houses[i % houses.length];
      g.addCitizen({ homeId: h.id, x: h.x + 1.5, z: h.z + 3.5, age: 5 + (i % 60), dietMask: i % 16 });
    }
    for (const b of [chapel, tavern, hospital]) b.workerIds.push(g.state.citizens[b.id % 200].id);
    for (let i = 0; i < 20; i++) infectCitizen(g.asGame(), g.state.citizens[i * 7], 0.5, { force: true });
    igniteBuilding(g.asGame(), houses[50].id);

    const game = g.asGame();
    const dt = 0.25;
    const step = () => {
      advanceTime(g, dt);
      updateWellbeing(game, dt);
      updateDisasters(game, dt);
      updateTrade(game, dt);
      updateNomads(game, dt);
      updateStats(game, dt);
    };
    for (let i = 0; i < 200; i++) step(); // warm up
    const n = 2000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) step();
    const per = (performance.now() - t0) / n;
    console.log(`[simext.perf] ${per.toFixed(3)} ms per step (${g.state.citizens.length} citizens)`);
    expect(per).toBeLessThan(1.5);
  });
});
