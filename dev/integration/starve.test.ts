/** Probe: why does the bot starve on medium/valleys/303 and hard/valleys/306? Monthly food diagnostics. */
import { it } from 'vitest';
import { MONTH_SECONDS } from '../../src/core/constants';
import { BUILDINGS, FOOD_TYPES } from '../../src/core/defs';
import type { Difficulty } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { Bot } from '../../tests/simcore.bot';
import { foodTotal, log, settings } from '../../tests/simcore.helpers';

const CASE = (process.env.CASE ?? 'medium:303').split(':');

it('starve probe', () => {
  const g = Game.create(settings({ seed: Number(CASE[1]), difficulty: CASE[0] as Difficulty, mapSize: 'medium', terrain: (CASE[2] ?? 'valleys') as never, disasters: true }));
  const bot = new Bot(g);
  const months = Number(process.env.MONTHS ?? 30);
  for (let m = 0; m < months && !g.state.gameOver; m++) {
    for (let i = 0; i < MONTH_SECONDS / 0.25; i++) { g.step(0.25); bot.tick(); if (g.state.gameOver) break; }
    const s = g.state;
    const food: string[] = [];
    for (const b of s.buildings) {
      const def = BUILDINGS[b.type];
      if (!['gathererHut', 'hunterCabin', 'fishingDock', 'cropField', 'orchard', 'pasture'].includes(b.type)) continue;
      let buf = 0;
      for (const r of FOOD_TYPES) buf += b.inventory[r] ?? 0;
      let made = 0;
      for (const r of FOOD_TYPES) made += b.producedThisYear[r] ?? 0;
      const extra = b.type === 'cropField' ? ` st=${[0, 1, 2, 3, 4].map((k) => b.fieldTiles!.filter((t) => t.stage === k).length).join('/')}` : '';
      food.push(`${def.name.split(' ')[0]}#${b.id}:${b.state[0]} w${b.workerIds.length}/${b.workersDesired} buf${Math.round(buf)} made${Math.round(made)}${extra}`);
    }
    const acts: Record<string, number> = {};
    for (const c of s.citizens) if (c.age >= 10) { const k = c.profession + ':' + c.taskLabel; acts[k] = (acts[k] ?? 0) + 1; }
    const hungry = s.citizens.filter((c) => c.food < 20).length;
    log(`Y${s.time.year} M${s.time.month} T=${s.weather.temperature.toFixed(0)} pop=${s.citizens.length} store=${Math.round(g.foodTotal())} total=${Math.round(foodTotal(g))} hungry=${hungry} builders=${g.populationSummary().builders} | ${food.join(' | ')}`);
    if (process.env.ACTS) log('   ' + JSON.stringify(acts) + ` marked=${g.rt.marked.size} logs=${Math.round(g.resourceTotals().log)} stone=${Math.round(g.resourceTotals().stone)} sites=${s.buildings.filter((b) => b.state !== 'active').map((b) => b.type + ':' + b.state).join(',')}`);
  }
  log('messages:', g.state.messages.slice(-25).map((m) => `Y${m.year}M${m.month} ${m.text}`).join('\n'));
});
