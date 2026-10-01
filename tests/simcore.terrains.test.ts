/**
 * The bot plays every terrain style and difficulty for several years: invariants hold, nothing throws, and
 * easy/medium towns survive.
 */
import { describe, expect, it } from 'vitest';
import { YEAR_SECONDS } from '../src/core/constants';
import type { Difficulty, TerrainStyle } from '../src/core/types';
import { Game } from '../src/sim/game';
import { Bot, foodProducedLastYear } from './simcore.bot';
import { foodTotal, log, settings } from './simcore.helpers';

const CASES: [TerrainStyle, number, Difficulty][] = [
  ['lakes', 11, 'medium'], ['mountains', 12, 'medium'], ['valleys', 13, 'hard'], ['valleys', 14, 'easy'], ['lakes', 15, 'hard'],
  ['mountains', 16, 'easy'],
];

describe('simcore terrains', () => {
  for (const [terrain, seed, difficulty] of CASES) {
    it(`bot survives on ${terrain} / ${difficulty}`, () => {
      const g = Game.create(settings({ seed, difficulty, mapSize: 'medium', terrain, disasters: true }));
      const bot = new Bot(g);
      const rows: string[] = [];
      const problems: string[] = [];
      for (let y = 0; y < 4 && !g.state.gameOver; y++) {
        for (let i = 0; i < YEAR_SECONDS / 0.25; i++) {
          g.step(0.25);
          bot.tick();
          if (g.state.gameOver) break;
          if (i % 720 === 0) problems.push(...g.validate().slice(0, 2));
        }
        const tot = g.resourceTotals();
        rows.push(`y${y + 1}: pop=${g.state.citizens.length} food=${Math.round(foodTotal(g))} made=${foodProducedLastYear(g)} fw=${Math.round(tot.firewood)} logs=${Math.round(tot.log)} deaths=${JSON.stringify(g.state.tally.deaths)}`);
      }
      log(`${terrain}/${difficulty}: placed ${bot.placed.length}, skipped [${bot.skipped.join(',')}]\n  ${rows.join('\n  ')}`);
      expect(problems).toEqual([]);
      expect(g.moduleErrors()).toEqual({});
      if (difficulty !== 'hard') expect(g.state.gameOver).toBe(false);
    });
  }
});
