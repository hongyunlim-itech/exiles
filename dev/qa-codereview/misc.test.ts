import { describe, expect, it } from 'vitest';
import { Feature } from '../../src/core/types';
import { FOOD_TYPES } from '../../src/core/defs';
import { claimOut } from '../../src/sim/core/claims';
import { mkTask, brainOf } from '../../src/sim/core/tasks';
import { startTask } from '../../src/sim/core/behavior';
import { forceBuild, Game, settings, steps, log } from './helpers';

describe('misc', () => {
  it('cancelling a construction site in a forest leaves its trees marked and laborers still fell them', () => {
    const g = Game.create(settings({ difficulty: 'medium', seed: 4242 }));
    const s = g.state;
    // find a 3x3 spot full of trees
    let spot: { x: number; z: number } | null = null;
    const c = g.townCenter();
    for (let r = 5; r < 50 && !spot; r++) for (let a = 0; a < 32 && !spot; a++) {
      const x = Math.floor(c.x + Math.cos(a) * r), z = Math.floor(c.z + Math.sin(a) * r);
      const chk = g.checkPlacement('woodenHouse', x, z, 0);
      if (chk.ok && chk.clearing.length >= 6) spot = { x, z };
    }
    expect(spot).toBeTruthy();
    const b = g.placeBuilding('woodenHouse', spot!.x, spot!.z, 0)!;
    const tiles: number[] = [];
    for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) if (s.tiles.feature[zz * s.W + xx] === Feature.Tree) tiles.push(zz * s.W + xx);
    g.demolish(b.id); // player changes their mind immediately
    const markedAfterCancel = tiles.filter((i) => s.tiles.marked[i]).length;
    steps(g, 240);
    const felled = tiles.filter((i) => s.tiles.feature[i] !== Feature.Tree).length;
    log('trees on cancelled site', tiles.length, 'still marked after cancel', markedAfterCancel, 'felled within 4 min', felled);
    expect(markedAfterCancel).toBe(0);
  });

  it('demolishing a storage barn destroys goods that were reserved for pickup', () => {
    const g = Game.create(settings({ difficulty: 'easy', seed: 4242 }));
    const s = g.state;
    const barn = s.buildings.find((b) => b.type === 'storageBarn')!;
    forceBuild(g, 'storageBarn'); // somewhere for the goods to go
    const foodBefore = g.foodTotal();
    // a citizen plans to fetch 30 food from the barn (as household suppliers / vendors / eaters do)
    const cit = s.citizens.find((x) => x.age > 16)!;
    const t = mkTask('supply', 'test fetch', [{ op: 'go', x: barn.doorX, z: barn.doorZ, b: barn.id }, { op: 'pickup', b: barn.id }]);
    const r = FOOD_TYPES.find((f) => (barn.inventory[f] ?? 0) >= 30)!;
    g.abortTask(cit);
    claimOut(t, barn, r, 30);
    startTask(g, cit, brainOf(cit), t);
    g.demolish(barn.id);
    const foodAfter = g.foodTotal();
    log('reserved', 30, r, 'food before demolish', foodBefore, 'after (evacuated)', foodAfter, 'lost', foodBefore - foodAfter);
    expect(foodBefore - foodAfter).toBeLessThan(1);
  });
});
