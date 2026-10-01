import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import { respondToNomads, summonNomads, updateNomads } from '../src/sim/nomads';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function run(g: FakeGame, seconds: number, dt = 0.5): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    advanceTime(g, dt);
    updateNomads(g.asGame(), dt);
  }
}

describe('nomads', () => {
  it('do not come without a Town Hall', () => {
    const g = createFakeGame();
    g.addCitizen();
    g.state.nextNomads = 0;
    run(g, YEAR_SECONDS);
    expect(g.state.nomads).toBeNull();
    expect(g.state.nextNomads).toBeGreaterThan(0);
  });

  it('arrive at an active Town Hall and leave after a month without an answer', () => {
    const g = createFakeGame();
    g.addCitizen();
    const hall = g.addBuilding('townHall', 20, 20);
    g.state.nextNomads = 5;
    run(g, 6);
    const group = g.state.nomads;
    expect(group).not.toBeNull();
    expect(group!.count).toBeGreaterThanOrEqual(3);
    expect(group!.count).toBeLessThanOrEqual(12);
    expect(g.emitted.some((e) => e.type === 'nomadsArrived')).toBe(true);
    expect(g.state.messages.at(-1)?.target).toEqual({ kind: 'building', id: hall.id });
    run(g, MONTH_SECONDS + 1);
    expect(g.state.nomads).toBeNull();
    expect(g.state.nextNomads).toBeGreaterThanOrEqual(YEAR_SECONDS - 1);
    expect(g.state.messages.at(-1)?.text).toMatch(/moved on/);
  });

  it('accepting spawns homeless adults near the Town Hall', () => {
    const g = createFakeGame();
    g.addCitizen();
    const hall = g.addBuilding('townHall', 20, 20);
    expect(summonNomads(g.asGame(), 6)).toBe(true);
    respondToNomads(g.asGame(), true);
    expect(g.state.nomads).toBeNull();
    expect(g.state.citizens).toHaveLength(7);
    const arrivals = g.emitted.find((e) => e.type === 'citizenArrived')?.payload as { ids: number[] };
    expect(arrivals.ids).toHaveLength(6);
    for (const id of arrivals.ids) {
      const c = g.getCitizen(id)!;
      expect(c.age).toBeGreaterThanOrEqual(10);
      expect(c.homeId).toBe(-1);
      expect(Math.hypot(c.x - (hall.doorX + 0.5), c.z - (hall.doorZ + 0.5))).toBeLessThan(8);
      // Not inside the town hall footprint.
      const inside = c.x >= hall.x && c.x < hall.x + hall.w && c.z >= hall.z && c.z < hall.z + hall.h;
      expect(inside).toBe(false);
    }
  });

  it('declining sends them away', () => {
    const g = createFakeGame();
    g.addCitizen();
    g.addBuilding('townHall', 20, 20);
    summonNomads(g.asGame(), 4);
    respondToNomads(g.asGame(), false);
    expect(g.state.nomads).toBeNull();
    expect(g.state.citizens).toHaveLength(1);
  });

  it('carry no disease when disasters are off', () => {
    const g = createFakeGame({ disasters: false });
    g.addCitizen();
    g.addBuilding('townHall', 20, 20);
    summonNomads(g.asGame(), 12);
    expect(g.state.nomads!.diseaseRisk).toBe(0);
    respondToNomads(g.asGame(), true);
    expect(g.state.citizens.every((c) => c.sick === 0)).toBe(true);
  });
});
