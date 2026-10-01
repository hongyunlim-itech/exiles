import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import { Feature } from '../src/core/types';
import { igniteBuilding, spawnTornado, startOutbreak, updateDisasters } from '../src/sim/disasters';
import { rt } from '../src/sim/ext/runtime';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function run(g: FakeGame, seconds: number, dt = 0.25, each?: () => void): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    advanceTime(g, dt);
    each?.();
    updateDisasters(g.asGame(), dt);
  }
}

describe('fire', () => {
  it('ignites, grows and burns a building down without fire fighting', () => {
    const g = createFakeGame({ disasters: false });
    const house = g.addBuilding('woodenHouse', 10, 10);
    igniteBuilding(g.asGame(), house.id);
    expect(house.fire).toBeGreaterThan(0);
    expect(g.emitted.some((e) => e.type === 'fireStarted')).toBe(true);
    expect(g.emitted.some((e) => e.type === 'sound' && (e.payload as { cue: string }).cue === 'bell')).toBe(true);
    expect(g.state.messages.at(-1)?.severity).toBe('danger');

    run(g, 50);
    expect(house.fire).toBeGreaterThan(0.7);
    run(g, 40);
    expect(g.removed).toEqual([{ id: house.id, cause: 'fire' }]);
    expect(g.state.messages.some((m) => m.text.includes('burned to the ground'))).toBe(true);
  });

  it('fire fighters with a well in range put the fire out', () => {
    const g = createFakeGame({ disasters: false });
    const house = g.addBuilding('woodenHouse', 10, 10);
    g.addBuilding('well', 15, 10);
    igniteBuilding(g.asGame(), house.id);
    run(g, 20); // let it grow a bit
    const peak = house.fire;
    expect(peak).toBeGreaterThan(0.2);
    run(g, 40, 0.25, () => (house.fireFighters = 5));
    expect(house.fire).toBe(0);
    expect(g.removed).toHaveLength(0);
    expect(g.state.messages.some((m) => m.text.includes('put out'))).toBe(true);
  });

  it('fire fighters without a well cannot stop the fire', () => {
    const g = createFakeGame({ disasters: false });
    const house = g.addBuilding('woodenHouse', 10, 10);
    igniteBuilding(g.asGame(), house.id);
    run(g, 100, 0.25, () => (house.fireFighters = 6));
    expect(g.removed.map((r) => r.id)).toContain(house.id);
  });

  it('spreads to close neighbours but not to distant buildings', () => {
    const g = createFakeGame({ disasters: false, seed: 3 });
    const a = g.addBuilding('woodenHouse', 10, 10);
    const near = g.addBuilding('woodenHouse', 14, 10); // gap of 1 tile
    const far = g.addBuilding('woodenHouse', 30, 30);
    igniteBuilding(g.asGame(), a.id);
    a.fire = 1;
    let spread = false;
    run(g, 19, 0.25, () => {
      if (near.fire > 0) spread = true;
    });
    // Run a few more trials if the dice were unkind.
    for (let k = 0; k < 200 && !spread; k++) {
      a.fire = 1;
      rt(g.asGame()).burnFull.set(a.id, 0);
      run(g, 10, 0.25, () => {
        if (near.fire > 0) spread = true;
      });
    }
    expect(spread).toBe(true);
    expect(far.fire).toBe(0);
  });

  it('does not start random fires when disasters are disabled', () => {
    const g = createFakeGame({ disasters: false });
    for (let i = 0; i < 20; i++) g.addBuilding('woodenHouse', (i % 10) * 4 + 1, Math.floor(i / 10) * 4 + 1);
    g.addCitizen();
    run(g, 5 * YEAR_SECONDS, 1);
    expect(g.emitted.filter((e) => e.type === 'fireStarted')).toHaveLength(0);
    expect(g.state.tornado).toBeNull();
  });

  it('starts occasional random fires when disasters are enabled', () => {
    const g = createFakeGame({ disasters: true, seed: 11 });
    for (let i = 0; i < 40; i++) g.addBuilding('blacksmith', (i % 10) * 4 + 1, Math.floor(i / 10) * 4 + 1);
    g.addCitizen();
    run(g, 6 * YEAR_SECONDS, 1);
    const fires = g.emitted.filter((e) => e.type === 'fireStarted').length;
    expect(fires).toBeGreaterThan(0);
  });

  it('non-flammable zones never burn', () => {
    const g = createFakeGame({ disasters: false });
    const pile = g.addBuilding('stockpile', 10, 10);
    igniteBuilding(g.asGame(), pile.id);
    expect(pile.fire).toBe(0);
  });
});

describe('tornado', () => {
  it('crosses the map destroying buildings and trees in its path, then ends', () => {
    const g = createFakeGame({ W: 40, H: 40 });
    for (let x = 0; x < 40; x++) {
      const i = 20 * 40 + x;
      g.state.tiles.feature[i] = Feature.Tree;
      g.state.tiles.featureAmount[i] = 1;
    }
    const target = g.addBuilding('boardingHouse', 12, 18); // spans z 18..23, 12 tiles from the edge
    spawnTornado(g.asGame());
    const t = g.state.tornado!;
    expect(t).not.toBeNull();
    // Point it straight through the house along the tree line.
    t.x = 0.5;
    t.z = 20.5;
    t.dirX = 1;
    t.dirZ = 0;
    run(g, 40);
    expect(g.state.tornado).toBeNull();
    expect(g.removed).toContainEqual({ id: target.id, cause: 'tornado' });
    let trees = 0;
    for (let x = 0; x < 40; x++) if (g.state.tiles.feature[20 * 40 + x] === Feature.Tree) trees++;
    expect(trees).toBeLessThan(30);
    expect(g.state.messages.some((m) => m.text.includes('tornado has passed'))).toBe(true);
  });

  it('only one tornado at a time', () => {
    const g = createFakeGame();
    spawnTornado(g.asGame());
    const first = g.state.tornado;
    spawnTornado(g.asGame());
    expect(g.state.tornado).toBe(first);
  });
});

describe('outbreaks', () => {
  it('startOutbreak infects patient zero and announces it', () => {
    const g = createFakeGame();
    for (let i = 0; i < 12; i++) g.addCitizen();
    const zero = startOutbreak(g.asGame());
    expect(zero).not.toBeNull();
    expect(zero!.sick).toBeGreaterThan(0);
    expect(g.state.messages.at(-1)?.text).toContain('first to fall ill');
  });

  it('random outbreaks eventually happen with disasters on', () => {
    const g = createFakeGame({ seed: 5 });
    for (let i = 0; i < 15; i++) g.addCitizen();
    run(g, 8 * YEAR_SECONDS, 1, () => {
      // keep everyone healthy so we only observe the outbreak roll
      for (const c of g.state.citizens) c.sick = 0;
      rt(g.asGame()).outbreakActive = false;
    });
    expect(g.state.messages.some((m) => m.text.includes('Sickness has broken out'))).toBe(true);
  });

  it('no outbreaks in the first year', () => {
    const g = createFakeGame({ seed: 5 });
    for (let i = 0; i < 15; i++) g.addCitizen();
    run(g, YEAR_SECONDS - MONTH_SECONDS, 1);
    expect(g.state.citizens.every((c) => c.sick === 0)).toBe(true);
  });
});
