/**
 * Performance: ~300 citizens with an active economy must step quickly (a few ms per 0.25 s step).
 */
import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { Bot } from './simcore.bot';
import { log, settings } from './simcore.helpers';

describe('simcore performance', () => {
  it('300 citizens step in a few ms', () => {
    const g = Game.create(settings({ seed: 99, mapSize: 'large', difficulty: 'easy' }));
    const bot = new Bot(g);
    // warm up the town with the bot for a while, then add a crowd
    for (let i = 0; i < 1200; i++) {
      g.step(0.25);
      bot.tick();
    }
    const c0 = g.townCenter();
    while (g.state.citizens.length < 300) {
      g.spawnCitizen({ x: c0.x + (Math.random() - 0.5) * 20, z: c0.z + (Math.random() - 0.5) * 20, age: 12 + Math.random() * 40 });
    }
    // lots of work: mark a big forest area
    g.markForRemoval(c0.x - 60, c0.z - 60, c0.x + 60, c0.z + 60, 'trees');
    g.setBuilders(30);
    for (let i = 0; i < 40; i++) {
      g.step(0.25);
      bot.tick();
    }
    g.profile = {};
    const N = 400;
    const t0 = performance.now();
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      g.step(0.25);
      worst = Math.max(worst, performance.now() - a);
    }
    const ms = (performance.now() - t0) / N;
    const prof = Object.fromEntries(Object.entries(g.profile).map(([k, v]) => [k, +(v / N).toFixed(3)]));
    log(`perf: ${g.state.citizens.length} citizens, ${ms.toFixed(2)} ms/step avg, worst ${worst.toFixed(1)} ms`, prof);
    log('errors', g.moduleErrors());
    expect(ms).toBeLessThan(8);
  });
});
