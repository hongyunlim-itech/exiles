/**
 * Integration test helpers: run a full headless game (real Game.create + every sim module) driven by the scripted
 * bot player from tests/simcore.bot.ts, watching for exceptions, invariant violations and module errors.
 * Not a test file (no `.test.ts`).
 */
import { vi } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import type { Difficulty, NewGameSettings, TerrainStyle } from '../src/core/types';
import { Game } from '../src/sim/game';
import { Bot } from './simcore.bot';
import { foodTotal, stuckReport } from './simcore.helpers';

export interface YearRow {
  year: number;
  pop: number;
  adults: number;
  food: number;
  firewood: number;
  buildings: number;
  deaths: number;
}

export interface RunResult {
  game: Game;
  startPop: number;
  minPop: number;
  rows: YearRow[];
  /** Invariant problems and stuck citizens seen during the run (sampled every 3 months). */
  problems: string[];
  /** console.error calls made by any module while the game ran (sim guards log swallowed exceptions there). */
  errors: string[];
  placed: string[];
}

export function integrationSettings(difficulty: Difficulty, terrain: TerrainStyle, seed: number): NewGameSettings {
  return { seed, townName: 'Integration', mapSize: 'medium', terrain, climate: 'fair', difficulty, disasters: true };
}

/** Play `years` game years with the bot at dt 0.25 (the real-time sub-step size). */
export function playYears(settings: NewGameSettings, years: number): RunResult {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const game = Game.create(settings);
    const bot = new Bot(game);
    const startPop = game.state.citizens.length;
    let minPop = startPop;
    const rows: YearRow[] = [];
    const problems: string[] = [];
    const stepsPerYear = YEAR_SECONDS / 0.25;
    const sampleEvery = (3 * MONTH_SECONDS) / 0.25;
    for (let y = 0; y < years && !game.state.gameOver; y++) {
      for (let i = 0; i < stepsPerYear; i++) {
        game.step(0.25);
        bot.tick();
        if (game.state.gameOver) break;
        if (i % sampleEvery === 0) {
          problems.push(...game.validate().slice(0, 3));
          // nobody may sit in one task for more than two game minutes (stuck / idle-forever citizens)
          problems.push(...stuckReport(game).slice(0, 3));
          minPop = Math.min(minPop, game.state.citizens.length);
        }
      }
      const p = game.populationSummary();
      const tally = game.state.tally.deaths;
      rows.push({
        year: y + 1,
        pop: p.total,
        adults: p.adults,
        food: Math.round(foodTotal(game)),
        firewood: Math.round(game.resourceTotals().firewood),
        buildings: game.state.buildings.filter((b) => b.state === 'active').length,
        deaths: Object.values(tally).reduce((a, b) => a + (b ?? 0), 0),
      });
    }
    const errors = spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '));
    return { game, startPop, minPop, rows, problems, errors, placed: bot.placed.slice() };
  } finally {
    spy.mockRestore();
  }
}

/** Test diagnostics straight to stderr (vitest hides console output of passing tests). */
export function report(label: string, r: RunResult): void {
  const lines = r.rows.map((x) => `  y${x.year}: pop=${x.pop} adults=${x.adults} food=${x.food} firewood=${x.firewood} active=${x.buildings} deaths=${x.deaths}`);
  process.stderr.write(`${label}: start pop ${r.startPop}, min ${r.minPop}\n${lines.join('\n')}\n`);
}
