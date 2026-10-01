import { test } from 'vitest';
import { Game } from '../../src/sim/game';
import { pathStats, resetPathStats } from '../../src/sim/pathfinding';
import { makeSettings } from '../../tests/simworld.helpers';

test('integration smoke: create, simulate, save/load', () => {
  for (const terrain of ['valleys', 'mountains', 'lakes'] as const) {
    const t0 = performance.now();
    const g = Game.create(makeSettings({ seed: 11, terrain, mapSize: 'medium' }));
    const tCreate = performance.now() - t0;
    resetPathStats();
    const t1 = performance.now();
    const SECONDS = Number(process.env.SECS ?? 600);
    for (let t = 0; t < SECONDS; t += 0.25) g.step(0.25);
    const tSim = performance.now() - t1;
    const ps = pathStats();
    const json = g.save();
    const g2 = Game.fromSave(json);
    const json2 = g2.save();
    const pop = g.state.citizens.length;
    const deer = g.state.animals.length;
    console.log(
      `${terrain}: create ${tCreate.toFixed(0)}ms, sim ${SECONDS}s in ${tSim.toFixed(0)}ms (${((tSim / SECONDS) * 0.25).toFixed(2)}ms/step), ` +
        `pop ${pop}, deer ${deer}, buildings ${g.state.buildings.length}, paths ${ps.searches} (${(ps.nodes / Math.max(1, ps.searches)).toFixed(0)} nodes avg), ` +
        `save ${(json.length / 1024).toFixed(1)}KB, reload identical: ${json === json2}`,
    );
  }
});
