/**
 * Invariants over long runs and under stress: no NaN, no negative inventories, reservations exactly matching
 * the claims held by tasks, nobody stuck in one task for more than two months, targets vanishing mid-task.
 */
import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import type { Citizen } from '../src/core/types';
import { Game } from '../src/sim/game';
import { Bot } from './simcore.bot';
import { log, place, settings } from './simcore.helpers';

function taskAge(c: Citizen): number {
  const t = (c.task as { cur?: { age: number } | null })?.cur;
  return t ? t.age : 0;
}

function checkAll(g: Game, label: string): void {
  const v = g.validate();
  if (v.length) log(label, v.slice(0, 5));
  expect(v).toEqual([]);
  for (const c of g.state.citizens) {
    expect(taskAge(c), `${c.name} task age`).toBeLessThan(2 * MONTH_SECONDS);
  }
}

describe('simcore invariants', () => {
  it('2 idle years on medium keep every invariant', () => {
    const g = Game.create(settings({ seed: 31337, difficulty: 'medium', mapSize: 'medium', disasters: true }));
    const dt = 0.25;
    const steps = (2 * YEAR_SECONDS) / dt;
    for (let i = 0; i < steps && !g.state.gameOver; i++) {
      g.step(dt);
      if (i % 240 === 0) checkAll(g, `idle step ${i}`);
    }
    checkAll(g, 'idle end');
    expect(g.moduleErrors()).toEqual({});
  });

  it('survives buildings vanishing, demolitions and fires mid-task', () => {
    const g = Game.create(settings({ seed: 2024, difficulty: 'easy', mapSize: 'medium', disasters: false }));
    const bot = new Bot(g);
    const dt = 0.25;
    let chaos = 0;
    for (let i = 0; i < (YEAR_SECONDS * 1.5) / dt; i++) {
      g.step(dt);
      bot.tick();
      if (i % 200 === 100) {
        // pick a random victim: under construction / active workplace / storage
        const list = g.state.buildings.filter((b) => b.type !== 'storageBarn');
        if (list.length > 0) {
          const b = list[(i * 7919) % list.length];
          const mode = chaos++ % 4;
          if (mode === 0) g.demolish(b.id);
          else if (mode === 1) g.removeBuilding(b.id, 'fire');
          else if (mode === 2) g.removeBuilding(b.id, 'tornado');
          else g.setPaused(b.id, true);
          // and place something new on top of citizens occasionally
          const c = g.state.citizens[i % g.state.citizens.length];
          if (c) place(g, 'woodenHouse', c.x, c.z, { maxR: 4 });
        }
      }
      if (i % 40 === 0) checkAll(g, `chaos step ${i}`);
    }
    checkAll(g, 'chaos end');
    // nobody stands on a blocked tile for long: after a few seconds everyone is on walkable ground or inside a site
    for (let k = 0; k < 40; k++) g.step(dt);
    const s = g.state;
    const blocked = s.citizens.filter((c) => {
      const i = Math.floor(c.z) * s.W + Math.floor(c.x);
      if (g.isWalkableTile(i)) return false;
      const t = (c.task as { cur?: { inside: number } | null })?.cur;
      return !t || t.inside < 0;
    });
    const stuck = blocked.filter((c) => c.activity !== 'walking');
    expect(stuck.map((c) => `${c.name} ${c.activity} ${c.taskLabel}`)).toEqual([]);
    expect(g.moduleErrors()).toEqual({});
  });

  it('reservations are released when targets vanish (storage demolished while hauling)', () => {
    const g = Game.create(settings({ seed: 5, difficulty: 'easy', mapSize: 'small' }));
    const pile = g.state.buildings.find((b) => b.type === 'stockpile')!;
    // lots of hauling: mark trees near the pile
    g.markForRemoval(pile.x - 20, pile.z - 20, pile.x + 20, pile.z + 20, 'all');
    for (let i = 0; i < 400; i++) g.step(0.25);
    checkAll(g, 'before');
    g.demolish(pile.id);
    for (let i = 0; i < 400; i++) {
      g.step(0.25);
      if (i % 20 === 0) checkAll(g, `after ${i}`);
    }
    expect(g.getBuilding(pile.id)?.state ?? 'gone').not.toBe('active');
  });
});
