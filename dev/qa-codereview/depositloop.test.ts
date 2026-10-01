import { describe, expect, it } from 'vitest';
import { updateHousing } from '../../src/sim/core/households';
import { brainOf } from '../../src/sim/core/tasks';
import { forceBuild, Game, settings, steps, log } from './helpers';

describe('carried food with full barns and a full home', () => {
  it('the carrier loops "Bringing X home" forever and never eats', () => {
    const g = Game.create(settings({ difficulty: 'medium', seed: 4242 }));
    const s = g.state;
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    updateHousing(g);
    const home = houses[0];
    const c = home.residentIds.map((id) => g.getCitizen(id)!).find((x) => x.age >= 16)!;
    // barns are full
    for (const b of s.buildings) if (b.type === 'storageBarn') b.inventory.wheat = (b.inventory.wheat ?? 0) + 4000;
    // the home is full (120 units: food + firewood)
    home.inventory = { beans: 90, firewood: 30 };
    g.abortTask(c);
    c.carrying = { type: 'berries', amount: 12 };
    c.food = 20;
    const labels: Record<string, number> = {};
    g.events.on('citizenDied', (e) => { if (e.id === c.id) log('DIED', e.cause, 't', s.time.elapsed.toFixed(1), 'food', c.food.toFixed(1), 'health', c.health.toFixed(1), 'warmth', c.warmth.toFixed(1)); });
    const seq: string[] = [];
    let minFood = 100;
    steps(g, 120, 0.25, () => {
      home.inventory.beans = 90; home.inventory.firewood = 30; // other residents' meals are topped up: stays full
      const t = brainOf(c).cur; if (t) labels[t.label] = (labels[t.label] ?? 0) + 1;
      const lab = t ? t.label + ':' + t.si : '-'; if (seq[seq.length - 1] !== lab && seq.length < 40) seq.push(lab);
      if (g.getCitizen(c.id)) minFood = Math.min(minFood, c.food);
    });
    log('seq', seq.join(' | '));
    log('task ticks', labels, 'carrying', c.carrying, 'food min', minFood.toFixed(1), 'starveTime', c.starveTime.toFixed(0), 'alive', !!g.getCitizen(c.id));
    expect(minFood).toBeGreaterThan(5);
  });
});
