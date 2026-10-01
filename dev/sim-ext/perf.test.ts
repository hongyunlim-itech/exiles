/** Dev probe: cost of sim-ext updates on a real Game state. */
import { it } from 'vitest';
import { Game } from '../../src/sim/game';
import { updateDisasters } from '../../src/sim/disasters';
import { updateNomads } from '../../src/sim/nomads';
import { updateStats } from '../../src/sim/stats';
import { updateTrade } from '../../src/sim/trade';
import { updateWellbeing } from '../../src/sim/wellbeing';

it('real-state timing', () => {
  const game = Game.create({ seed: 7, townName: 'T', mapSize: 'large', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: true });
  for (let i = 0; i < 240; i++) game.step(0.25);
  // inflate the population to ~200 by cloning citizens around town
  const s = game.state;
  const base = [...s.citizens];
  while (s.citizens.length < 200) {
    const c = base[s.citizens.length % base.length];
    game.spawnCitizen({ x: c.x + Math.random(), z: c.z + Math.random(), age: 25 });
  }
  const fns: [string, (g: Game, dt: number) => void][] = [['wellbeing', updateWellbeing], ['disasters', updateDisasters], ['trade', updateTrade], ['nomads', updateNomads], ['stats', updateStats]];
  for (const [name, fn] of fns) {
    const n = 4000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(game, 0.25);
    console.log(`${name}: ${((performance.now() - t0) / n * 1000).toFixed(1)} us/step (${s.citizens.length} citizens, ${s.buildings.length} buildings)`);
  }
  const t0 = performance.now();
  for (let i = 0; i < 400; i++) game.step(0.25);
  console.log(`full Game.step: ${((performance.now() - t0) / 400).toFixed(3)} ms/step`);
});
