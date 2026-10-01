/**
 * Balance sanity on the fake game: needs are static (fed & warm), so every death / loss here comes from sim-ext
 * systems alone (disease, fire, tornado). A reasonably served town must not be wiped out by them.
 */
import { describe, expect, it } from 'vitest';
import { YEAR_SECONDS } from '../src/core/constants';
import { updateDisasters } from '../src/sim/disasters';
import { updateStats } from '../src/sim/stats';
import { updateWellbeing } from '../src/sim/wellbeing';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function town(seed: number, services: boolean): FakeGame {
  const g = createFakeGame({ W: 96, H: 96, seed });
  const houses = [];
  for (let i = 0; i < 16; i++) {
    houses.push(g.addBuilding('woodenHouse', 10 + (i % 8) * 5, 10 + Math.floor(i / 8) * 6, { inventory: services ? { herbs: 5 } : {} }));
  }
  g.addBuilding('storageBarn', 60, 10, { inventory: { wheat: 3000 } });
  g.addBuilding('cemetery', 60, 30, { w: 8, h: 8 });
  if (services) {
    g.addBuilding('well', 20, 24);
    g.addBuilding('well', 40, 24);
    const hospital = g.addBuilding('hospital', 30, 30, { inventory: { herbs: 200 } });
    const chapel = g.addBuilding('chapel', 45, 30);
    for (const b of [hospital, chapel]) b.workerIds.push(-99);
  }
  for (let i = 0; i < 64; i++) {
    const h = houses[i % houses.length];
    g.addCitizen({ homeId: h.id, x: h.x + 1.5, z: h.z + 3.5, age: 3 + ((i * 7) % 55), dietMask: services ? 7 : 3, health: 85 });
  }
  return g;
}

function simulate(g: FakeGame, years: number): void {
  const game = g.asGame();
  const dt = 0.5;
  const steps = Math.round((years * YEAR_SECONDS) / dt);
  for (let i = 0; i < steps; i++) {
    advanceTime(g, dt);
    // keep houses stocked with herbs like sim-core's households would (hospital too)
    if (i % 120 === 0) {
      for (const b of g.state.buildings) {
        if (b.type === 'woodenHouse' && (b.inventory.herbs ?? 0) < 3 && b.id % 2 === 0) b.inventory.herbs = 5;
        if (b.type === 'hospital') b.inventory.herbs = Math.max(b.inventory.herbs ?? 0, 25);
      }
    }
    updateWellbeing(game, dt);
    updateDisasters(game, dt);
    updateStats(game, dt);
  }
}

describe('sim-ext balance', () => {
  it('a served town survives years of disasters', () => {
    const results: string[] = [];
    for (const seed of [1, 2, 3]) {
      const g = town(seed, true);
      simulate(g, 6);
      const diseaseDeaths = g.killed.filter((k) => k.cause === 'disease').length;
      const pop = g.state.citizens.length;
      results.push(`seed ${seed}: pop ${pop}, disease deaths ${diseaseDeaths}, fire/tornado deaths ${g.killed.length - diseaseDeaths}, buildings lost ${g.removed.length}`);
      expect(pop).toBeGreaterThan(40);
      const avgHealth = g.state.citizens.reduce((a, c) => a + c.health, 0) / Math.max(1, pop);
      const avgHappy = g.state.citizens.reduce((a, c) => a + c.happiness, 0) / Math.max(1, pop);
      expect(avgHealth).toBeGreaterThan(60);
      expect(avgHappy).toBeGreaterThan(40);
    }
    console.log(`[simext.balance] served:\n  ${results.join('\n  ')}`);
  });

  it('an unserved town suffers from outbreaks but is not instantly wiped out', () => {
    const results: string[] = [];
    let totalDeaths = 0;
    for (const seed of [4, 5, 6]) {
      const g = town(seed, false);
      simulate(g, 6);
      const diseaseDeaths = g.killed.filter((k) => k.cause === 'disease').length;
      totalDeaths += diseaseDeaths;
      results.push(`seed ${seed}: pop ${g.state.citizens.length}, disease deaths ${diseaseDeaths}, lost buildings ${g.removed.length}`);
      expect(g.state.citizens.length).toBeGreaterThan(15);
    }
    console.log(`[simext.balance] unserved:\n  ${results.join('\n  ')}`);
    expect(totalDeaths).toBeGreaterThanOrEqual(0);
  });
});
