/**
 * Economy / balance: a scripted bot on medium must survive and grow for 8 years, producing food and firewood;
 * neglecting food production must cause hardship.
 */
import { describe, expect, it } from 'vitest';
import { YEAR_SECONDS } from '../src/core/constants';
import { Game } from '../src/sim/game';
import { Bot, foodProducedLastYear, yearlyProduction } from './simcore.bot';
import { foodTotal, log, settings, stuckReport } from './simcore.helpers';

interface YearRow {
  year: number;
  pop: number;
  adults: number;
  kids: number;
  homeless: number;
  food: number;
  firewood: number;
  logs: number;
  stone: number;
  iron: number;
  tools: number;
  births: number;
  deaths: number;
  foodMade: number;
  firewoodMade: number;
  happy: number;
  health: number;
  workers: number;
}

function simulate(seed: number, years: number, opts: { neglectFood?: boolean; terrain?: 'valleys' | 'lakes' | 'mountains' } = {}) {
  const g = Game.create(settings({ seed, difficulty: 'medium', mapSize: 'medium', terrain: opts.terrain ?? 'valleys', disasters: false }));
  const bot = new Bot(g, opts);
  const rows: YearRow[] = [];
  const problems: string[] = [];
  const dt = 0.25;
  const stepsPerYear = Math.round(YEAR_SECONDS / dt);
  let minPop = g.state.citizens.length;
  const t0 = performance.now();
  for (let y = 0; y < years && !g.state.gameOver; y++) {
    for (let i = 0; i < stepsPerYear; i++) {
      g.step(dt);
      bot.tick();
      if (g.state.gameOver) break;
      minPop = Math.min(minPop, g.state.citizens.length);
      if (i % 480 === 0) {
        const v = g.validate();
        if (v.length) problems.push(`y${y} ${v.slice(0, 3).join('; ')}`);
      }
    }
    // make sure the new year has started (float drift) so producedLastYear holds the finished year
    while (g.state.time.month !== 0 && !g.state.gameOver) {
      g.step(dt);
      bot.tick();
    }
    const tot = g.resourceTotals();
    const pop = g.populationSummary();
    const prod = yearlyProduction(g);
    rows.push({
      year: y + 1,
      pop: pop.total,
      adults: pop.adults,
      kids: pop.children + pop.students,
      homeless: pop.homeless,
      food: Math.round(foodTotal(g)),
      firewood: Math.round(tot.firewood),
      logs: Math.round(tot.log),
      stone: Math.round(tot.stone),
      iron: Math.round(tot.iron),
      tools: Math.round(tot.tool),
      births: g.state.tally.births,
      deaths: Object.values(g.state.tally.deaths).reduce((a, b) => a + (b ?? 0), 0),
      foodMade: foodProducedLastYear(g),
      firewoodMade: prod.firewood ?? 0,
      happy: Math.round(g.state.citizens.reduce((a, c) => a + c.happiness, 0) / Math.max(1, g.state.citizens.length)),
      health: Math.round(g.state.citizens.reduce((a, c) => a + c.health, 0) / Math.max(1, g.state.citizens.length)),
      workers: g.state.buildings.reduce((a, b) => a + b.workerIds.length, 0),
    });
  }
  const ms = performance.now() - t0;
  return { g, bot, rows, problems, minPop, ms };
}

describe('simcore economy', () => {
  it('bot on medium survives and grows for 8 years', () => {
    const { g, bot, rows, problems, minPop, ms } = simulate(777, 8);
    log(`bot run ${ms.toFixed(0)} ms; placed: ${bot.placed.join(',')}; skipped: ${bot.skipped.join(',')}`);
    for (const r of rows) log(JSON.stringify(r));
    log('deaths', g.state.tally.deaths, 'errors', g.moduleErrors());
    log('production last year', yearlyProduction(g));
    log('stuck', stuckReport(g));
    expect(problems).toEqual([]);
    expect(g.state.gameOver).toBe(false);
    const start = rows[0] ? rows[0].pop : 0;
    expect(minPop).toBeGreaterThan(5);
    expect(rows[rows.length - 1].pop).toBeGreaterThan(start);
    expect(rows.some((r) => r.foodMade > 300)).toBe(true);
    expect(rows.some((r) => r.firewoodMade > 100)).toBe(true);
  });

  it('neglecting food production causes hardship', () => {
    const { g, rows } = simulate(777, 3, { neglectFood: true });
    for (const r of rows) log('neglect', JSON.stringify(r));
    log('neglect deaths', g.state.tally.deaths);
    const starved = (g.state.tally.deaths.starvation ?? 0) + (g.state.tally.deaths.disease ?? 0) + (g.state.tally.deaths.freezing ?? 0);
    expect(starved > 0 || g.state.gameOver).toBe(true);
  });
});
