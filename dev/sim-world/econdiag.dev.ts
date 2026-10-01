import { test } from 'vitest';
import { YEAR_SECONDS } from '../../src/core/constants';
import { Game } from '../../src/sim/game';
import { countTreesInRadius } from '../../src/sim/nature';
import { Bot, yearlyProduction } from '../../tests/simcore.bot';
import { settings } from '../../tests/simcore.helpers';

test('economy diag (world-side factors)', () => {
  const g = Game.create(settings({ seed: 777, difficulty: 'medium', mapSize: 'medium', terrain: 'valleys', disasters: false }));
  const bot = new Bot(g, {});
  for (let y = 0; y < 3; y++) {
    for (let i = 0; i < YEAR_SECONDS / 0.25; i++) {
      g.step(0.25);
      bot.tick();
    }
    const huts = g.state.buildings.filter((b) => b.type === 'gathererHut' || b.type === 'hunterCabin' || b.type === 'fishingDock');
    const info = huts.map((b) => {
      const cx = b.x + b.w / 2;
      const cz = b.z + b.h / 2;
      const deerNear = g.state.animals.filter((a) => Math.hypot(a.x - cx, a.z - cz) < 18).length;
      return `${b.type}@${b.x},${b.z} ${b.state} workers ${b.workerIds.length} trees14 ${countTreesInRadius(g, cx, cz, 14)} deer18 ${deerNear}`;
    });
    console.log(`year ${y + 1}: pop ${g.state.citizens.length} deer ${g.state.animals.length} prod ${JSON.stringify(yearlyProduction(g))}`);
    for (const s of info) console.log('   ', s);
  }
});
