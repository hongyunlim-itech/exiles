/** Probe: the scripted bot across difficulties / terrains / seeds; prints yearly stats. */
import { describe, it } from 'vitest';
import { YEAR_SECONDS } from '../../src/core/constants';
import { BUILDINGS } from '../../src/core/defs';
import type { Difficulty, TerrainStyle } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { Bot, yearlyProduction } from '../../tests/simcore.bot';
import { foodTotal, log, settings, stuckReport } from '../../tests/simcore.helpers';

const CASES: [Difficulty, TerrainStyle, number, number][] = [];
for (const seed of [101, 202, 303]) {
  CASES.push(['medium', 'valleys', seed, 6]);
  CASES.push(['medium', 'lakes', seed + 1, 6]);
  CASES.push(['easy', 'mountains', seed + 2, 3]);
  CASES.push(['hard', 'valleys', seed + 3, 3]);
  CASES.push(['hard', 'lakes', seed + 4, 3]);
}

describe.concurrent('explore', () => {
  for (const [difficulty, terrain, seed, years] of CASES) {
    it(`${difficulty}/${terrain}/${seed}`, () => {
      const g = Game.create(settings({ seed, difficulty, mapSize: 'medium', terrain, disasters: true }));
      const bot = new Bot(g);
      const start = g.state.citizens.length;
      const rows: string[] = [`${difficulty}/${terrain}/${seed}: start pop ${start}`];
      const stuck: string[] = [];
      for (let y = 0; y < years && !g.state.gameOver; y++) {
        for (let i = 0; i < YEAR_SECONDS / 0.25; i++) {
          g.step(0.25);
          bot.tick();
          if (g.state.gameOver) break;
          if (i % 240 === 0) { const st = stuckReport(g); if (st.length) stuck.push(`y${y + 1}.${i}: ${st.slice(0, 3).join('; ')}`); }
        }
        const tot = g.resourceTotals();
        let houseFw = 0;
        for (const b of g.state.buildings) if (BUILDINGS[b.type].housing) houseFw += b.inventory.firewood ?? 0;
        const prod = yearlyProduction(g);
        const woodcutters = g.state.buildings.filter((b) => b.type === 'woodcutter').map((b) => `${b.state}:${b.workerIds.length}/${b.workersDesired}`).join(',');
        rows.push(`  y${y + 1}: pop=${g.state.citizens.length} food=${Math.round(foodTotal(g))} fwStore=${Math.round(tot.firewood)} fwHouse=${Math.round(houseFw)} fwMade=${prod.firewood ?? 0} logs=${Math.round(tot.log)} stone=${Math.round(tot.stone)} wc=[${woodcutters}] lab=${g.populationSummary().laborers} deaths=${JSON.stringify(g.state.tally.deaths)} err=${JSON.stringify(g.moduleErrors())} inv=${g.validate().length}`);
      }
      rows.push(`  stuck samples: ${stuck.length} ${stuck.slice(0, 4).join(' | ')}`);
      log(rows.join('\n'));
    });
  }
});
