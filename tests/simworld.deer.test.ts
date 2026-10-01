/**
 * Deer regressions (review finding "hunters produce almost nothing after year 1"): the global deer cap no longer
 * freezes breeding everywhere — a hunted-out herd near a cabin regrows even while far-away herds are full — and
 * hunters leave a herd's last breeding pair alone.
 */
import { describe, expect, it } from 'vitest';
import { YEAR_SECONDS } from '../src/core/constants';
import { deerCap, removeAnimal, updateNature } from '../src/sim/nature';
import { brainOf } from '../src/sim/core/tasks';
import { planHunter } from '../src/sim/core/work/gather';
import { HERD_MAX } from '../src/sim/world/deer';
import { fixtureSettings, forceBuild, Game } from './simcore.fixtures';
import { makeSettings, makeWorldState, mockGame } from './simworld.helpers';

describe('deer herds', () => {
  it('a hunted-down herd regrows even while the map is at its deer cap', () => {
    const { state } = makeWorldState(makeSettings({ seed: 21, mapSize: 'small' }));
    const g = mockGame(state);
    // let the herds fill the map up to (above) the global cap, then hunt one herd down to a pair
    let guard = 0;
    while (state.animals.length < deerCap(state) + 8 && guard++ < 400) {
      for (let t = 0; t < 10; t += 1) updateNature(g, 1);
    }
    const hunted = state.animals[0].herd;
    for (const a of state.animals.filter((x) => x.herd === hunted).slice(2)) removeAnimal(g, a.id);
    expect(state.animals.length).toBeGreaterThanOrEqual(deerCap(state));
    const before = state.animals.filter((a) => a.herd === hunted).length;
    expect(before).toBeLessThanOrEqual(HERD_MAX);
    for (let t = 0; t < YEAR_SECONDS; t += 1) updateNature(g, 1);
    const after = state.animals.filter((a) => a.herd === hunted).length;
    expect(after).toBeGreaterThan(before);
  });
});

describe('hunters', () => {
  it('leave the last breeding pair of a herd alone', () => {
    const g = Game.create(fixtureSettings({ seed: 4242 }));
    const cabin = forceBuild(g, 'hunterCabin');
    const s = g.state;
    const cx = cabin.x + cabin.w / 2;
    const cz = cabin.z + cabin.h / 2;
    // keep only one herd, reduced to two animals, right next to the cabin
    const herd = s.animals[0].herd;
    for (const a of [...s.animals]) if (a.herd !== herd) g.removeAnimalSafe(a.id);
    for (const a of s.animals.filter((x) => x.herd === herd).slice(2)) g.removeAnimalSafe(a.id);
    for (const a of s.animals) {
      a.x = cx + 4;
      a.z = cz + 4;
    }
    expect(s.animals.length).toBe(2);
    const c = s.citizens.find((x) => x.age >= 16)!;
    expect(planHunter(g, c, cabin, brainOf(c))?.label).not.toBe('Hunting deer');
    // a third animal makes one huntable
    s.animals.push({ ...s.animals[0], id: g.newId(), huntedBy: -1, wander: { ...(s.animals[0].wander as object) } });
    g.animalById.set(s.animals[2].id, s.animals[2]);
    expect(planHunter(g, c, cabin, brainOf(c))?.label).toBe('Hunting deer');
  });
});
